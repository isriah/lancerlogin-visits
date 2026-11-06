// Queued email, Discord and Outreach work in visits_notifications. A booking change queues its notifications in the same
// batch as the change; the request then tries to send its email and Discord messages at once, and the
// visits.notifications job sends whatever is still due, records visits in Outreach, retries failures, posts the weekly
// summary and forgets expired operational rows. A row being sent holds a lease, and every provider call is idempotent
// (the email idempotency key and the Discord nonce are fixed per notification, and Outreach's operations find or create).
// On a Core whose scheduler runs jobs in steps (module SDK 1.6.0), the job does one small step per slice instead of a
// full pass; see processVisitsNotificationStep.
import type { D1Database, D1Statement } from "@lancerlogin/module-sdk/api";
import type { FieldChange, VisitProgram } from "../shared/visits-booking.ts";
import { dailyEmailCap, emailAddressHash, emailLimitDay, nextEmailDayStartMs, purgeEmailLimitsSql, releaseEmailSql, reserveEmailSql } from "../shared/visits-limits.ts";
import {
  afterFailedAttempt, claimNotificationSql, discordNonce, emailIdempotencyKey, finishNotificationSql, notificationLeaseMs, recoverExpiredLeasesSql,
  type NotificationChannel, type NotificationKind,
} from "../shared/visits-notifications.ts";
import { classifyDiscordError, discordThreadTypes, encodeDiscordFailure, missingDiscordPermissions, type DiscordPermission } from "../shared/visits-failures.ts";
import { formatWeeklySummary, parseSummaryPayload, reportTimes, selectSummaryVisits, summaryDisposition, weeklySummaryDecision, type SummaryDecision, type SummaryVisit } from "../shared/visits-summary.ts";
import {
  cancellationEmail, confirmationEmail, discordBookedMessage, discordCanceledMessage, discordChangedMessage, discordMessageBody, hostNameText, updateEmail,
  visitMessageDetails, type EmailContent,
} from "../shared/visits-text.ts";
import { generateManageToken, hashManageToken, manageLink } from "../shared/visits-tokens.ts";
import { addDays, dayMs, localMoment } from "../shared/visits-time.ts";
import { linkOutreachTeamStep, outreachAccess, queueOutreachStatement, recordInOutreach } from "./visits-outreach.ts";
import { emailCappedMessage } from "./visits-queries.ts";
import { readSettings, settingsStatement } from "./visits-settings.ts";
import { installationId, iso, rows, teamIdentity as identityOf, type BookingRow, type SettingsRow, type VisitsDeps, type VisitsOutreachClient } from "./visits-runtime.ts";

/**
 * Notifications one job pass sends at most. Every Core job shares one 5-minute cron invocation, which on the Workers Free
 * plan allows 50 external requests and 50 D1 queries in all. A notification costs one provider request (up to 3 attempts
 * on a short Discord rate limit) and 3 to 6 D1 queries, more when it records a visit in Outreach, so a pass of 5 stays
 * near 25 queries. Rows left over stay pending, and the next pass sends them.
 */
export const notificationsPerPass = 5;
/** How long a guest submission key keeps a repeated submission from booking twice. */
export const submissionKeyRetentionMs = 7 * dayMs;
/** Revoked manage links are forgotten after this long (expired ones as soon as the visit ends). */
export const revokedTokenRetentionMs = 30 * dayMs;

/** What a booking notification carries: the dashboard origin for its manage link, and what changed. */
export type BookingNotificationPayload = { readonly origin?: string; readonly changes?: readonly FieldChange[] };

/** A statement queueing one notification, due now. */
export function queueNotificationStatement(db: D1Database, input: {
  readonly id: string;
  readonly channel: Exclude<NotificationChannel, "outreach">;
  readonly kind: Exclude<NotificationKind, "weekly-summary" | "outreach-record">;
  readonly bookingId: string;
  readonly payload: BookingNotificationPayload;
  readonly now: number;
}): D1Statement {
  return db.prepare("INSERT INTO visits_notifications(installation_id,id,channel,kind,booking_id,payload_json,status,attempts,next_attempt_ms,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',0,?,?,?)")
    .bind(installationId, input.id, input.channel, input.kind, input.bookingId, JSON.stringify(input.payload), input.now, iso(input.now), iso(input.now));
}

type NotificationRow = { id: string; channel: NotificationChannel; kind: string; booking_id: string | null; summary_date: string | null; payload_json: string; attempts: number };
type Outcome =
  | { readonly status: "delivered"; readonly externalId?: string | null; readonly note?: string }
  | { readonly status: "skipped"; readonly note: string }
  | { readonly status: "capped"; readonly nextAttemptMs: number }
  | { readonly status: "retry"; readonly error: string; readonly permanent?: boolean };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300) || "The provider did not say why";

async function claim(db: D1Database, id: string, now: number): Promise<string | null> {
  const lease = crypto.randomUUID();
  const result = await db.prepare(claimNotificationSql).bind(lease, now + notificationLeaseMs, iso(now), installationId, id, now).run();
  return result.meta?.changes === 1 ? lease : null;
}

/** Another Outreach record of the same booking that waits; at most one may, so a retried row then gives way to it. */
const waitingOutreachSibling = "EXISTS(SELECT 1 FROM visits_notifications o WHERE o.installation_id=visits_notifications.installation_id AND o.booking_id=visits_notifications.booking_id AND o.channel='outreach' AND o.status='pending' AND o.id!=visits_notifications.id)";
const supersededOutreachNote = "A newer Outreach record of this visit replaced this one";

type Finished = "delivered" | "skipped" | "pending" | "failed";

async function finish(db: D1Database, row: NotificationRow, lease: string, outcome: Outcome, now: number): Promise<Finished> {
  if (outcome.status === "retry" && row.channel === "outreach") {
    const next = afterFailedAttempt({ attempts: row.attempts + 1, now, permanent: outcome.permanent });
    if (next.status === "failed") {
      await db.prepare(finishNotificationSql).bind("failed", null, null, outcome.error.slice(0, 500), iso(now), installationId, row.id, lease).run();
      return "failed";
    }
    const retried = await db.prepare(`UPDATE visits_notifications SET status=CASE WHEN ${waitingOutreachSibling} THEN 'skipped' ELSE 'pending' END,
      next_attempt_ms=CASE WHEN ${waitingOutreachSibling} THEN NULL ELSE ? END,last_error=CASE WHEN ${waitingOutreachSibling} THEN ? ELSE ? END,lease_token=NULL,lease_expires_ms=NULL,updated_at=?
      WHERE installation_id=? AND id=? AND status='sending' AND lease_token=? RETURNING status`)
      .bind(next.nextAttemptMs, supersededOutreachNote, outcome.error.slice(0, 500), iso(now), installationId, row.id, lease).first<{ status: Finished }>();
    return retried?.status ?? "pending";
  }
  if (outcome.status === "capped") {
    // Waiting under the cap is not a failed attempt.
    await db.prepare("UPDATE visits_notifications SET status='pending',attempts=max(attempts-1,0),next_attempt_ms=?,last_error=?,lease_token=NULL,lease_expires_ms=NULL,updated_at=? WHERE installation_id=? AND id=? AND status='sending' AND lease_token=?")
      .bind(outcome.nextAttemptMs, emailCappedMessage, iso(now), installationId, row.id, lease).run();
    return "pending";
  }
  if (outcome.status === "retry") {
    const next = afterFailedAttempt({ attempts: row.attempts + 1, now, permanent: outcome.permanent });
    await db.prepare(finishNotificationSql).bind(next.status, next.status === "pending" ? next.nextAttemptMs : null, null, outcome.error.slice(0, 500), iso(now), installationId, row.id, lease).run();
    return next.status;
  }
  await db.prepare(finishNotificationSql).bind(outcome.status, null, outcome.status === "delivered" ? outcome.externalId ?? null : null, outcome.note ?? null, iso(now), installationId, row.id, lease).run();
  return outcome.status;
}

type MessageBooking = BookingRow & { number: string; name: string; program: VisitProgram; outreach_team_id: string | null; window_title: string };

/** A notification's booking with its team and window. Binds installation ID; callers add the booking condition. */
const messageBookingSql = `SELECT b.*,t.number,t.name,t.program,t.outreach_team_id,w.title AS window_title FROM visits_bookings b
    JOIN visits_teams t ON t.installation_id=b.installation_id AND t.id=b.team_id JOIN visits_windows w ON w.installation_id=b.installation_id AND w.id=b.window_id
    WHERE b.installation_id=?`;
const messageBookingStatement = (db: D1Database, bookingId: string) => db.prepare(`${messageBookingSql} AND b.id=?`).bind(installationId, bookingId);

type Loaded = { readonly settings: SettingsRow; readonly booking: MessageBooking | null };

/**
 * The settings and a notification's booking, read in one D1 batch: on the Workers Free plan each D1 call costs a
 * scheduler slice about 0.45 ms of its 10 ms CPU, so a notification reads them together.
 */
async function settingsAndBooking(db: D1Database, bookingId: string | null, now: number): Promise<Loaded> {
  if (!bookingId) return { settings: await readSettings(db, now), booking: null };
  const [settings, booking] = await db.batch([settingsStatement(db), messageBookingStatement(db, bookingId)]);
  return {
    settings: (settings?.results?.[0] as SettingsRow | undefined) ?? await readSettings(db, now),
    booking: (booking?.results?.[0] as MessageBooking | undefined) ?? null,
  };
}

function parsePayload(json: string): BookingNotificationPayload {
  try {
    const value = JSON.parse(json) as BookingNotificationPayload;
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}

/** Whether a booking notification still describes the booking: a later change supersedes it, and removed visits get none. */
function superseded(kind: string, booking: MessageBooking | null): string | null {
  if (!booking) return "This visit no longer exists";
  if (booking.removed === 1) return "This visit was removed";
  if (kind === "canceled" ? booking.status !== "canceled" : booking.status !== "booked") return "A later change replaced this message";
  return null;
}

/** Message details for a booking. Guests visit the host team named in settings, or "our team" when none is set. */
async function details(deps: VisitsDeps, booking: MessageBooking, hostName: string) {
  return visitMessageDetails(deps.civil, await deps.timeZone(), {
    hostName: hostNameText(hostName), team: identityOf(booking),
    booking: { contactName: booking.contact_name, contactPhone: booking.contact_phone, arrivalMs: booking.arrival_ms, departureMs: booking.departure_ms, headcount: booking.headcount, note: booking.note },
    windowTitle: booking.window_title,
  });
}

/**
 * Send one booking email. The manage link is minted now, so nothing secret waits in the queue: its SHA-256 is stored before
 * the send (a link in a sent email always works) and removed again when Resend certainly did not send it. The recipient's
 * daily cap is reserved first and released only when Resend refused the request.
 */
async function deliverEmail(db: D1Database, deps: VisitsDeps, row: NotificationRow, now: number, loaded?: Loaded): Promise<Outcome> {
  const { settings, booking } = loaded ?? await settingsAndBooking(db, row.booking_id, now);
  const gone = superseded(row.kind, booking);
  if (gone || !booking) return { status: "skipped", note: gone ?? "This visit no longer exists" };
  if (booking.departure_ms <= now) return { status: "skipped", note: "The visit ended before this email could be sent" };
  const payload = parsePayload(row.payload_json);
  if (!payload.origin) return { status: "retry", error: "The dashboard address is unknown, so no manage link can be sent", permanent: true };
  const token = generateManageToken();
  let link: string;
  try { link = manageLink(payload.origin, token); } catch (error) { return { status: "retry", error: errorText(error), permanent: true }; }
  const timeZone = await deps.timeZone();
  const addressHash = await emailAddressHash(booking.contact_email);
  const day = emailLimitDay(deps.civil, timeZone, now);
  const tokenHash = await hashManageToken(token);
  const release = () => db.prepare(releaseEmailSql).bind(installationId, addressHash, day).run();
  const forget = () => db.prepare("DELETE FROM visits_manage_tokens WHERE installation_id=? AND token_hash=?").bind(installationId, tokenHash).run();
  // The reservation and the link's hash in one batch; a recipient at the cap gets the hash removed again (rare).
  const [reserved] = await db.batch([
    db.prepare(reserveEmailSql).bind(installationId, addressHash, day, dailyEmailCap),
    db.prepare("INSERT INTO visits_manage_tokens(installation_id,token_hash,booking_id,issued_ms,expires_ms) VALUES(?,?,?,?,?)").bind(installationId, tokenHash, booking.id, now, booking.departure_ms),
  ]);
  if (!reserved?.results?.length) {
    await forget();
    return { status: "capped", nextAttemptMs: nextEmailDayStartMs(deps.civil, timeZone, now) };
  }
  const message = await details(deps, booking, settings.host_name);
  const content: EmailContent = row.kind === "changed" ? updateEmail(message, link, payload.changes ?? [])
    : row.kind === "canceled" ? cancellationEmail(message, link) : confirmationEmail(message, link);
  try {
    const sent = await deps.email.send({
      to: booking.contact_email, subject: content.subject, html: content.html, text: content.text,
      ...(settings.reply_to ? { replyTo: settings.reply_to } : {}), idempotencyKey: emailIdempotencyKey(row.id),
    });
    return { status: "delivered", externalId: sent.id };
  } catch (error) {
    const status = deps.email.providerStatus(error);
    if (status === undefined || status >= 500) return { status: "retry", error: errorText(error) };
    // Resend refused this request, so this email and its link were not sent.
    await release();
    await forget();
    // A conflict on the idempotency key means Resend already accepted this notification on an earlier attempt, whose
    // link is stored and works.
    if (status === 409) return { status: "delivered", note: "Resend had already accepted this email" };
    return { status: "retry", error: errorText(error), permanent: status !== 429 };
  }
}

async function summaryVisits(db: D1Database, reportMs: number, nextReportMs: number): Promise<SummaryVisit[]> {
  const result = await rows<{ status: string; arrival_ms: number; departure_ms: number; headcount: number | null; number: string; name: string; program: VisitProgram }>(
    db.prepare(`SELECT b.status,b.arrival_ms,b.departure_ms,b.headcount,t.number,t.name,t.program FROM visits_bookings b JOIN visits_teams t ON t.installation_id=b.installation_id AND t.id=b.team_id
      WHERE b.installation_id=? AND b.status='booked' AND b.arrival_ms>? AND b.arrival_ms<? AND b.departure_ms>?`).bind(installationId, reportMs - 90_000_000, nextReportMs, reportMs));
  return selectSummaryVisits(result.map((visit) => ({ status: visit.status, arrivalMs: visit.arrival_ms, departureMs: visit.departure_ms, headcount: visit.headcount, team: identityOf(visit) })), reportMs, nextReportMs);
}

/** Post one Discord message: a booking change or the weekly summary. Nothing is mentioned and a retry cannot post twice. */
async function deliverDiscord(db: D1Database, deps: VisitsDeps, row: NotificationRow, now: number, loaded?: Loaded): Promise<Outcome> {
  const { settings, booking } = loaded ?? await settingsAndBooking(db, row.kind === "weekly-summary" ? null : row.booking_id, now);
  if (settings.discord_enabled !== 1 || !settings.discord_channel_id) return { status: "skipped", note: "Guest Visits Discord messages are off" };
  let content: string;
  if (row.kind === "weekly-summary") {
    const payload = parseSummaryPayload(row.payload_json);
    if (!payload || !row.summary_date) return { status: "retry", error: "This summary cannot be read", permanent: true };
    if (summaryDisposition(payload, now) === "skip") return { status: "skipped", note: "The next summary was due before this one could be sent" };
    content = formatWeeklySummary(deps.civil, await deps.timeZone(), { reportDate: row.summary_date, nextReportDate: payload.nextReportDate, visits: await summaryVisits(db, payload.reportMs, payload.nextReportMs) });
  } else {
    const gone = superseded(row.kind, booking);
    if (gone || !booking) return { status: "skipped", note: gone ?? "This visit no longer exists" };
    const message = await details(deps, booking, settings.host_name);
    content = row.kind === "changed" ? discordChangedMessage(message, parsePayload(row.payload_json).changes ?? [])
      : row.kind === "canceled" ? discordCanceledMessage(message) : discordBookedMessage(message);
  }
  const client = await deps.discord.client();
  try {
    const response = await client.request<{ id?: unknown }>(`/channels/${encodeURIComponent(settings.discord_channel_id)}/messages`, { method: "POST", body: JSON.stringify(discordMessageBody(content, discordNonce(row.id))) });
    return { status: "delivered", externalId: typeof response.body?.id === "string" ? response.body.id : null };
  } catch (error) {
    const status = deps.discord.providerStatus(error);
    const kind = classifyDiscordError({ status, code: discordCodeOf(error), message: errorText(error) });
    // Discord refuses these until someone changes the bot's permissions or the channel, so they fail at once.
    if (kind === "missing-permissions") return { status: "retry", error: encodeDiscordFailure({ code: kind, ...await diagnoseChannel(client, settings.discord_channel_id) }), permanent: true };
    if (kind === "unknown-channel") return { status: "retry", error: encodeDiscordFailure({ code: kind }), permanent: true };
    return { status: "retry", error: errorText(error), permanent: status !== undefined && status >= 400 && status < 500 && status !== 429 };
  }
}

/** Discord's JSON error code, which Core's Discord errors carry as `discordCode` although the SDK does not promise it. */
function discordCodeOf(error: unknown): number | undefined {
  const code = error instanceof Error ? (error as Error & { readonly discordCode?: unknown }).discordCode : undefined;
  return typeof code === "number" ? code : undefined;
}

type DiscordClient = Awaited<ReturnType<VisitsDeps["discord"]["client"]>>;
type DiscordChannel = { name?: unknown; type?: unknown; guild_id?: unknown; parent_id?: unknown; permission_overwrites?: unknown };

/**
 * After Discord refused a post: which permissions the bot lacks in the channel, and its name, read from Discord with the
 * same bot. A channel the bot cannot read is missing View Channel. Anything Discord does not answer leaves the
 * permissions unknown (empty), so the workspace only says which ones to check.
 */
async function diagnoseChannel(client: DiscordClient, channelId: string): Promise<{ readonly permissions: DiscordPermission[]; readonly channelName: string | null }> {
  const get = <T,>(path: string) => client.request<T>(path, { method: "GET" }).then((response) => response.body);
  let channel: DiscordChannel;
  try { channel = await get<DiscordChannel>(`/channels/${encodeURIComponent(channelId)}`); } catch (error) {
    return { permissions: classifyDiscordError({ status: undefined, code: discordCodeOf(error), message: errorText(error) }) === "missing-permissions" ? ["view-channel"] : [], channelName: null };
  }
  const channelName = typeof channel.name === "string" && channel.name ? channel.name : null;
  try {
    const guildId = String(channel.guild_id ?? client.guildId ?? "");
    const channelType = Number(channel.type);
    const parent = discordThreadTypes.includes(channelType) && typeof channel.parent_id === "string" ? await get<DiscordChannel>(`/channels/${encodeURIComponent(channel.parent_id)}`) : channel;
    const bot = await get<{ id?: unknown }>("/users/@me");
    if (!guildId || typeof bot.id !== "string") return { permissions: [], channelName };
    const [member, roles] = await Promise.all([
      get<{ roles?: unknown }>(`/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(bot.id)}`),
      get<unknown>(`/guilds/${encodeURIComponent(guildId)}/roles`),
    ]);
    if (!Array.isArray(roles)) return { permissions: [], channelName };
    const permissions = missingDiscordPermissions({
      guildId, botId: bot.id, botRoleIds: Array.isArray(member.roles) ? member.roles.filter((id): id is string => typeof id === "string") : [],
      roles: roles.filter((role): role is { id: string; permissions?: unknown } => Boolean(role) && typeof (role as { id?: unknown }).id === "string"),
      channelType, overwrites: Array.isArray(parent.permission_overwrites) ? parent.permission_overwrites : [],
    });
    return { permissions, channelName };
  } catch {
    return { permissions: [], channelName };
  }
}

type DeliverOptions = {
  /** The Outreach client, for Outreach records. */
  readonly outreach?: VisitsOutreachClient;
  /** Nothing retries this row later (Record in Outreach without a grant), so a failure is final. */
  readonly final?: boolean;
  /** The settings and booking, already read with the claim. */
  readonly loaded?: Loaded;
};

async function deliver(db: D1Database, deps: VisitsDeps, row: NotificationRow, now: number, options: DeliverOptions = {}): Promise<{ readonly status: Finished; readonly outcome: Outcome } | null> {
  const lease = await claim(db, row.id, now);
  if (!lease) return null;
  return deliverClaimed(db, deps, row, lease, now, options);
}

/** Send, record or skip a row this sender holds the lease on, and finish it. */
async function deliverClaimed(db: D1Database, deps: VisitsDeps, row: NotificationRow, lease: string, now: number, options: DeliverOptions = {}): Promise<{ readonly status: Finished; readonly outcome: Outcome }> {
  let outcome: Outcome;
  try {
    outcome = row.channel === "email" ? await deliverEmail(db, deps, row, now, options.loaded)
      : row.channel === "discord" ? await deliverDiscord(db, deps, row, now, options.loaded)
        : options.outreach ? await recordInOutreach(db, deps, options.outreach, row.booking_id, now, options.loaded?.booking ?? undefined)
          : { status: "retry", error: "Outreach is unavailable" };
  } catch (error) {
    outcome = { status: "retry", error: errorText(error) };
  }
  if (options.final && outcome.status === "retry") outcome = { ...outcome, permanent: true };
  return { status: await finish(db, row, lease, outcome, now), outcome };
}

const notificationColumns = "id,channel,kind,booking_id,summary_date,payload_json,attempts";

async function readyChannels(deps: VisitsDeps): Promise<NotificationChannel[]> {
  const [email, discord] = await Promise.all([deps.email.ready().catch(() => false), deps.discord.ready().catch(() => false)]);
  return [...(email ? ["email" as const] : []), ...(discord ? ["discord" as const] : [])];
}

/**
 * Try to send notifications a request just queued. Best effort: anything not sent, including everything for a provider
 * that is not ready, stays queued for the job.
 */
export async function deliverNow(db: D1Database, deps: VisitsDeps, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  try {
    const now = deps.now();
    const channels = await readyChannels(deps);
    if (!channels.length) return;
    const due = await rows<NotificationRow>(db.prepare(`SELECT ${notificationColumns} FROM visits_notifications WHERE installation_id=? AND id IN (SELECT value FROM json_each(?)) AND status='pending' AND next_attempt_ms<=? AND channel IN (SELECT value FROM json_each(?))`)
      .bind(installationId, JSON.stringify(ids), now, JSON.stringify(channels)));
    for (const row of due) await deliver(db, deps, row, now);
  } catch {
    // The visits.notifications job sends or retries whatever is still queued.
  }
}

/**
 * Queue this week's summary when its report time has passed, once per report date. `discordReady` may be a check, which
 * then runs only when the settings have the summary on.
 */
export async function scheduleWeeklySummary(db: D1Database, deps: VisitsDeps, discordReady: boolean | (() => Promise<boolean>), now: number): Promise<SummaryDecision> {
  const settings = await readSettings(db, now);
  if (settings.discord_enabled !== 1 || !settings.discord_channel_id || settings.weekly_summary_enabled !== 1) return { action: "off" };
  if (!(typeof discordReady === "function" ? await discordReady() : discordReady)) return { action: "off" };
  const timeZone = await deps.timeZone();
  const schedule = { weekday: settings.weekly_summary_weekday, time: settings.weekly_summary_time };
  const { current } = reportTimes(deps.civil, timeZone, schedule, now);
  const existing = await db.prepare("SELECT status FROM visits_notifications WHERE installation_id=? AND kind='weekly-summary' AND summary_date=?").bind(installationId, current.date).first<{ status: string }>();
  const decision = weeklySummaryDecision({ civil: deps.civil, timeZone, enabled: true, schedule, sinceMs: settings.weekly_summary_since_ms, now, existingStatus: existing?.status });
  if (decision.action === "queue") {
    await db.prepare(`INSERT INTO visits_notifications(installation_id,id,channel,kind,summary_date,payload_json,status,attempts,next_attempt_ms,created_at,updated_at)
      VALUES(?,?,'discord','weekly-summary',?,?,'pending',0,?,?,?) ON CONFLICT(installation_id,summary_date) WHERE kind='weekly-summary' DO NOTHING`)
      .bind(installationId, crypto.randomUUID(), decision.reportDate, JSON.stringify(decision.payload), now, iso(now), iso(now)).run();
  }
  return decision;
}

export type NotificationPass = {
  readonly recovered: number; readonly delivered: number; readonly pending: number; readonly failed: number; readonly skipped: number;
  readonly summary: SummaryDecision["action"];
  /** Whether an Admin's grant let this pass record visits in Outreach. */
  readonly outreachGranted: boolean;
};

/**
 * Before leases are taken back: an Outreach record whose sender stopped gives way to another record of the same visit
 * that waits, or to a later stopped one, since at most one may wait per visit. Binds updated_at, installation ID and now
 * twice.
 */
const supersedeStoppedOutreachSql = `UPDATE visits_notifications SET status='skipped',lease_token=NULL,lease_expires_ms=NULL,next_attempt_ms=NULL,last_error='${supersededOutreachNote}',updated_at=?
  WHERE installation_id=? AND channel='outreach' AND status='sending' AND lease_expires_ms<=? AND EXISTS(SELECT 1 FROM visits_notifications o WHERE o.installation_id=visits_notifications.installation_id
    AND o.booking_id=visits_notifications.booking_id AND o.channel='outreach' AND o.id!=visits_notifications.id AND (o.status='pending' OR (o.status='sending' AND o.lease_expires_ms<=? AND o.rowid>visits_notifications.rowid)))`;

/**
 * The visits.notifications job: take back rows whose sender stopped, queue the weekly summary when due, send due email and
 * Discord notifications and record due visits in Outreach (leaving a provider's rows queued while it is not ready, or
 * while no Admin's grant lets Guest Visits use Outreach), then forget old daily email counts, expired or long-revoked
 * manage links and old guest submission keys. Each pass also notes whether the grant exists, so requests know whether to
 * queue Outreach records. Core runs it only while Guest Visits is enabled and set up, and every statement rechecks that.
 */
export async function processVisitsNotifications(db: D1Database, deps: VisitsDeps, limit = notificationsPerPass): Promise<NotificationPass> {
  const now = deps.now();
  const recovered = await recoverStopped(db, now);
  const channels = await readyChannels(deps);
  const summary = await scheduleWeeklySummary(db, deps, channels.includes("discord"), now);
  const outreach = await outreachAccess(db, deps, now, { checked: true });
  if (outreach.client && outreach.granted) channels.push("outreach");
  const counts = { delivered: 0, pending: 0, failed: 0, skipped: 0 };
  if (channels.length) {
    const due = await rows<NotificationRow>(db.prepare(`SELECT ${notificationColumns} FROM visits_notifications WHERE installation_id=? AND status='pending' AND next_attempt_ms<=? AND channel IN (SELECT value FROM json_each(?)) ORDER BY next_attempt_ms,id LIMIT ?`)
      .bind(installationId, now, JSON.stringify(channels), limit));
    for (const row of due) {
      const result = await deliver(db, deps, row, now, { outreach: outreach.client });
      if (result) counts[result.status] += 1;
    }
  }
  await purgeExpired(db, deps, now);
  return { recovered, ...counts, summary: summary.action, outreachGranted: outreach.granted };
}

/** Take back rows whose sender stopped (one D1 batch). Returns how many went back to the queue. */
async function recoverStopped(db: D1Database, now: number): Promise<number> {
  const [, recover] = await db.batch([
    db.prepare(supersedeStoppedOutreachSql).bind(iso(now), installationId, now, now),
    db.prepare(recoverExpiredLeasesSql).bind(iso(now), installationId, now),
  ]);
  return recover?.meta?.changes ?? 0;
}

/** Forget old daily email counts, expired or long-revoked manage links and old guest submission keys (one D1 batch). */
async function purgeExpired(db: D1Database, deps: VisitsDeps, now: number): Promise<void> {
  const timeZone = await deps.timeZone();
  const today = localMoment(deps.civil, timeZone, now).date;
  await db.batch([
    db.prepare(purgeEmailLimitsSql).bind(installationId, addDays(today, -1)),
    db.prepare("DELETE FROM visits_manage_tokens WHERE installation_id=? AND (expires_ms<=? OR revoked_ms<=?)").bind(installationId, now, now - revokedTokenRetentionMs),
    db.prepare("DELETE FROM visits_public_submission_keys WHERE installation_id=? AND created_ms<?").bind(installationId, now - submissionKeyRetentionMs),
  ]);
}

/**
 * The scheduler slice the job runs in: module SDK 1.6.0's `ModuleJobScheduler`, declared here so the plugin still builds
 * and runs against Cores with an older SDK, which pass none.
 */
export type VisitsJobScheduler = { readonly steps: boolean; readonly cursor?: string };

/**
 * Notifications one round of steps sends at most, one per slice, before it purges and waits for the next round (five
 * minutes later). Rows left over stay pending. It keeps a queue that refills as fast as it drains from holding the
 * scheduler's continuation slices.
 */
export const notificationsPerRound = 20;

type StepChannel = NotificationChannel;
const channelLetters: Readonly<Record<StepChannel, string>> = { email: "e", discord: "d", outreach: "o" };
const letterChannels: Readonly<Record<string, StepChannel>> = { e: "email", d: "discord", o: "outreach" };

/**
 * Where a round of steps continues, as the scheduler's cursor (at most 64 characters):
 * - none, or anything unreadable: `recover`, the first step;
 * - `deliver`: find which channels have due rows and which of those are ready (no provider request);
 * - `send:<sent>:<channels>:<g|->`: send the next due row on those channels (`e`, `d`, `o`), `sent` so far this round,
 *   `g` once this round has refreshed the Outreach grant;
 * - `purge:<g|->`: forget expired rows, and refresh the Outreach grant unless this round already did.
 */
export type NotificationCursor =
  | { readonly step: "recover" }
  | { readonly step: "deliver" }
  | { readonly step: "send"; readonly sent: number; readonly channels: readonly StepChannel[]; readonly grantChecked: boolean }
  | { readonly step: "purge"; readonly grantChecked: boolean };

export function formatNotificationCursor(cursor: NotificationCursor): string {
  if (cursor.step === "send") return `send:${cursor.sent}:${cursor.channels.map((channel) => channelLetters[channel]).join("")}:${cursor.grantChecked ? "g" : "-"}`;
  if (cursor.step === "purge") return `purge:${cursor.grantChecked ? "g" : "-"}`;
  return cursor.step;
}

export function parseNotificationCursor(cursor: string | undefined): NotificationCursor {
  if (cursor === "deliver") return { step: "deliver" };
  const purge = /^purge:([g-])$/.exec(cursor ?? "");
  if (purge) return { step: "purge", grantChecked: purge[1] === "g" };
  const send = /^send:(\d{1,3}):([edo]{1,3}):([g-])$/.exec(cursor ?? "");
  if (send) {
    const channels = [...new Set([...send[2]!].map((letter) => letterChannels[letter]!))];
    const sent = Number(send[1]);
    const grantChecked = send[3] === "g";
    return sent < notificationsPerRound ? { step: "send", sent, channels, grantChecked } : { step: "purge", grantChecked };
  }
  return { step: "recover" };
}

/** What one step of the job did, and where the next continues. Counts are this slice's own. */
export type NotificationStep = {
  readonly step: NotificationCursor["step"];
  /** Core runs the job again within about a second, with `cursor`. */
  readonly more: boolean;
  readonly cursor?: string;
  readonly recovered: number; readonly delivered: number; readonly pending: number; readonly failed: number; readonly skipped: number;
  readonly summary?: SummaryDecision["action"];
  /** Set by the step that looked the grant up. */
  readonly outreachGranted?: boolean;
};

const emptyCounts = { recovered: 0, delivered: 0, pending: 0, failed: 0, skipped: 0 };
const continueAt = (cursor: NotificationCursor) => ({ more: true, cursor: formatNotificationCursor(cursor) });

/** Pending rows due now, by channel: one indexed read, so a round with nothing due checks no provider. */
async function dueChannels(db: D1Database, now: number): Promise<Set<StepChannel>> {
  const due = await rows<{ channel: StepChannel }>(db.prepare("SELECT DISTINCT channel FROM visits_notifications WHERE installation_id=? AND status='pending' AND next_attempt_ms<=?").bind(installationId, now));
  return new Set(due.map((row) => row.channel));
}

/**
 * Take the lease on the oldest due row on these channels and read it, in one statement. `attempts` is returned as it was
 * before this claim, as `finish` expects. Binds lease token, lease expiry, updated_at, installation ID twice, now and the
 * channels as JSON.
 */
const claimNextNotificationSql = `UPDATE visits_notifications SET status='sending',lease_token=?,lease_expires_ms=?,attempts=attempts+1,next_attempt_ms=NULL,updated_at=?
  WHERE installation_id=? AND status='pending' AND id=(SELECT id FROM visits_notifications WHERE installation_id=? AND status='pending' AND next_attempt_ms<=? AND channel IN (SELECT value FROM json_each(?)) ORDER BY next_attempt_ms,id LIMIT 1)
  RETURNING id,channel,kind,booking_id,summary_date,payload_json,attempts-1 AS attempts`;

/**
 * Claim the next row and read the settings and the row's booking (none for the weekly summary) in one D1 batch, which
 * runs its statements in order: the booking is found through the lease just taken.
 */
async function claimNext(db: D1Database, channels: readonly StepChannel[], now: number): Promise<{ readonly row: NotificationRow; readonly lease: string; readonly loaded: Loaded } | null> {
  const lease = crypto.randomUUID();
  const [claimed, settings, booking] = await db.batch([
    db.prepare(claimNextNotificationSql).bind(lease, now + notificationLeaseMs, iso(now), installationId, installationId, now, JSON.stringify(channels)),
    settingsStatement(db),
    db.prepare(`${messageBookingSql} AND b.id=(SELECT n.booking_id FROM visits_notifications n WHERE n.installation_id=? AND n.lease_token=? AND n.kind!='weekly-summary')`).bind(installationId, installationId, lease),
  ]);
  const row = claimed?.results?.[0] as NotificationRow | undefined;
  if (!row) return null;
  return { row, lease, loaded: { settings: (settings?.results?.[0] as SettingsRow | undefined) ?? await readSettings(db, now), booking: (booking?.results?.[0] as MessageBooking | undefined) ?? null } };
}

/** Whether an Outreach record's last step found no supported team, so the next creates it (ensure-team). */
function ensureTeamNext(row: NotificationRow): boolean {
  try { return (JSON.parse(row.payload_json) as { ensureTeam?: unknown } | null)?.ensureTeam === true; } catch { return false; }
}

/**
 * After a send slice did one step of linking an Outreach record's team: the row waits again, due at once and without
 * counting the attempt, for the next slice to continue. `ensureTeam` notes that Outreach has no such team yet; linking
 * clears it. A newer record of the same visit waiting meanwhile replaces this one, as in finish.
 */
async function requeueLinking(db: D1Database, row: NotificationRow, lease: string, now: number, ensureTeam: boolean): Promise<Finished> {
  const requeued = await db.prepare(`UPDATE visits_notifications SET status=CASE WHEN ${waitingOutreachSibling} THEN 'skipped' ELSE 'pending' END,
    attempts=max(attempts-1,0),next_attempt_ms=CASE WHEN ${waitingOutreachSibling} THEN NULL ELSE ? END,last_error=CASE WHEN ${waitingOutreachSibling} THEN ? ELSE last_error END,
    payload_json=CASE WHEN ? THEN json_set(payload_json,'$.ensureTeam',json('true')) ELSE json_remove(payload_json,'$.ensureTeam') END,
    lease_token=NULL,lease_expires_ms=NULL,updated_at=? WHERE installation_id=? AND id=? AND status='sending' AND lease_token=? RETURNING status`)
    .bind(now, supersededOutreachNote, ensureTeam ? 1 : 0, iso(now), installationId, row.id, lease).first<{ status: Finished }>();
  return requeued?.status ?? "pending";
}

/** The last step: purge, and refresh the stored Outreach grant (writing only a change) unless this round already did. */
async function purgeStep(db: D1Database, deps: VisitsDeps, now: number, grantChecked: boolean): Promise<NotificationStep> {
  await purgeExpired(db, deps, now);
  const outreachGranted = grantChecked ? undefined : (await outreachAccess(db, deps, now)).granted;
  return { step: "purge", more: false, ...emptyCounts, ...(outreachGranted === undefined ? {} : { outreachGranted }) };
}

/**
 * One step of the visits.notifications job, for a Core whose scheduler runs it in slices (module SDK 1.6.0). Each slice
 * must fit the Workers Free plan's 10 ms CPU alongside Core's own reads, and on Cloudflare that CPU is mostly per call
 * (about 0.45 ms per D1 query and 1.5 ms per provider request), so a round is split:
 * 1. `recover`: take back rows whose sender stopped, and queue the weekly summary when due.
 * 2. `deliver`: find the channels with due rows and check only those providers (and Outreach's grant only when an
 *    Outreach record is due). Nothing due, or nothing ready, goes straight on to the purge in the same slice.
 * 3. `send`, once per notification: claim and send one row, so a slice makes at most one provider request or Outreach
 *    operation. An Outreach record whose team has no link yet first takes a slice to find the team in Outreach, and one
 *    more to create it when Outreach has none. After `notificationsPerRound` slices, or when no row is left, it purges.
 * 4. `purge`: forget expired rows and refresh the stored Outreach grant, writing only a change.
 */
export async function processVisitsNotificationStep(db: D1Database, deps: VisitsDeps, cursorText: string | undefined): Promise<NotificationStep> {
  const now = deps.now();
  const cursor = parseNotificationCursor(cursorText);
  if (cursor.step === "recover") {
    const recovered = await recoverStopped(db, now);
    const summary = await scheduleWeeklySummary(db, deps, () => deps.discord.ready().catch(() => false), now);
    return { step: "recover", ...continueAt({ step: "deliver" }), ...emptyCounts, recovered, summary: summary.action };
  }
  if (cursor.step === "deliver") {
    const due = await dueChannels(db, now);
    const [email, discord] = await Promise.all([
      due.has("email") ? deps.email.ready().catch(() => false) : false,
      due.has("discord") ? deps.discord.ready().catch(() => false) : false,
    ]);
    const outreach = due.has("outreach") ? await outreachAccess(db, deps, now) : undefined;
    const channels: StepChannel[] = [...(email ? ["email" as const] : []), ...(discord ? ["discord" as const] : []), ...(outreach?.client && outreach.granted ? ["outreach" as const] : [])];
    const grantChecked = outreach !== undefined;
    if (!channels.length) return { ...await purgeStep(db, deps, now, grantChecked), step: "deliver", ...(outreach ? { outreachGranted: outreach.granted } : {}) };
    return { step: "deliver", ...continueAt({ step: "send", sent: 0, channels, grantChecked }), ...emptyCounts, ...(outreach ? { outreachGranted: outreach.granted } : {}) };
  }
  if (cursor.step === "send") {
    const claimed = await claimNext(db, cursor.channels, now);
    if (!claimed) return { ...await purgeStep(db, deps, now, cursor.grantChecked), step: "send" };
    const counts = { ...emptyCounts };
    const { row, lease } = claimed;
    const outreachClient = row.channel === "outreach" ? await deps.outreach.client() : undefined;
    // A visit whose team has no Outreach link yet is linked first, one Outreach operation per slice, then recorded.
    const linking = outreachClient ? await linkOutreachTeamStep(db, deps, outreachClient, row.booking_id, now, { ensureTeam: ensureTeamNext(row), loaded: claimed.loaded.booking ?? undefined }) : null;
    const status = linking === "linked" || linking === "not-found" ? await requeueLinking(db, row, lease, now, linking === "not-found")
      : linking ? await finish(db, row, lease, linking, now)
        : (await deliverClaimed(db, deps, row, lease, now, { outreach: outreachClient, loaded: claimed.loaded })).status;
    counts[status] += 1;
    const sent = cursor.sent + 1;
    return { step: "send", ...continueAt(sent < notificationsPerRound ? { ...cursor, sent } : { step: "purge", grantChecked: cursor.grantChecked }), ...counts };
  }
  return purgeStep(db, deps, now, cursor.grantChecked);
}

/**
 * The visits.notifications job as Core calls it. With scheduler steps (module SDK 1.6.0 on the Durable Object
 * scheduler) it does one step per slice; otherwise (the cron fallback, or a Core before SDK 1.6.0) one full pass of up
 * to `notificationsPerPass` notifications, as before.
 */
export async function runVisitsNotificationsJob(db: D1Database, deps: VisitsDeps, scheduler: VisitsJobScheduler | undefined): Promise<NotificationPass | NotificationStep> {
  return scheduler?.steps === true ? processVisitsNotificationStep(db, deps, scheduler.cursor) : processVisitsNotifications(db, deps);
}

/** One visit's result of Record in Outreach, before the route adds the booking ID. */
export type OutreachRecordState = { readonly state: "recorded" | "pending" | "failed" | "skipped"; readonly activityId: string | null; readonly error?: string };

/**
 * Record one visit in Outreach now, for Record in Outreach: queue its record (or make the waiting one due) and do it with
 * the request's client. `final` marks a record nothing will retry, because no Admin's grant lets the job use Outreach.
 * A record the job is doing at this moment is reported as pending.
 */
export async function recordOutreachNow(db: D1Database, deps: VisitsDeps, client: VisitsOutreachClient, bookingId: string, options: { readonly final: boolean }): Promise<OutreachRecordState> {
  const now = deps.now();
  await queueOutreachStatement(db, bookingId, now, { dueNow: true }).run();
  const row = await db.prepare(`SELECT ${notificationColumns} FROM visits_notifications WHERE installation_id=? AND channel='outreach' AND booking_id=? AND status='pending'`).bind(installationId, bookingId).first<NotificationRow>();
  const result = row ? await deliver(db, deps, row, now, { outreach: client, final: options.final }) : null;
  if (!result) return { state: "pending", activityId: null };
  const { outcome } = result;
  if (result.status === "delivered") return { state: "recorded", activityId: outcome.status === "delivered" ? outcome.externalId ?? null : null };
  if (result.status === "skipped") return { state: "skipped", activityId: null, error: outcome.status === "skipped" ? outcome.note : supersededOutreachNote };
  return { state: result.status, activityId: null, ...(outcome.status === "retry" ? { error: outcome.error } : {}) };
}
