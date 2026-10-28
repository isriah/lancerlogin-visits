// Queued email and Discord work in visits_notifications. A booking change queues its notifications in the same batch as
// the change; the request then tries to send them at once, and the visits.notifications job sends whatever is still due,
// retries failures, posts the weekly summary and forgets expired operational rows. A row being sent holds a lease, and
// every provider call is idempotent (the email idempotency key and the Discord nonce are fixed per notification).
import type { D1Database, D1Statement } from "@lancerlogin/module-sdk/api";
import type { FieldChange, VisitProgram } from "../shared/visits-booking.ts";
import { dailyEmailCap, emailAddressHash, emailLimitDay, nextEmailDayStartMs, purgeEmailLimitsSql, releaseEmailSql, reserveEmailSql } from "../shared/visits-limits.ts";
import {
  afterFailedAttempt, claimNotificationSql, discordNonce, emailIdempotencyKey, finishNotificationSql, notificationLeaseMs, recoverExpiredLeasesSql,
  type NotificationChannel, type NotificationKind,
} from "../shared/visits-notifications.ts";
import { formatWeeklySummary, parseSummaryPayload, reportTimes, selectSummaryVisits, summaryDisposition, weeklySummaryDecision, type SummaryDecision, type SummaryVisit } from "../shared/visits-summary.ts";
import {
  cancellationEmail, confirmationEmail, discordBookedMessage, discordCanceledMessage, discordChangedMessage, discordMessageBody, updateEmail, visitMessageDetails,
  type EmailContent,
} from "../shared/visits-text.ts";
import { generateManageToken, hashManageToken, manageLink } from "../shared/visits-tokens.ts";
import { addDays, dayMs, localMoment } from "../shared/visits-time.ts";
import { emailCappedMessage } from "./visits-queries.ts";
import { readSettings } from "./visits-settings.ts";
import { installationId, iso, rows, teamIdentity as identityOf, type BookingRow, type VisitsDeps } from "./visits-runtime.ts";

/** Who guests visit, in email text: "Your visit to our team is booked." Core keeps the organization's name. */
export const guestHostName = "our team";
/** Notifications one job pass sends at most. */
export const notificationsPerPass = 20;
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

async function finish(db: D1Database, row: NotificationRow, lease: string, outcome: Outcome, now: number): Promise<"delivered" | "skipped" | "pending" | "failed"> {
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

type MessageBooking = BookingRow & { number: string; name: string; program: VisitProgram; window_title: string };

async function messageBooking(db: D1Database, bookingId: string | null): Promise<MessageBooking | null> {
  if (!bookingId) return null;
  return db.prepare(`SELECT b.*,t.number,t.name,t.program,w.title AS window_title FROM visits_bookings b
    JOIN visits_teams t ON t.installation_id=b.installation_id AND t.id=b.team_id JOIN visits_windows w ON w.installation_id=b.installation_id AND w.id=b.window_id
    WHERE b.installation_id=? AND b.id=?`).bind(installationId, bookingId).first<MessageBooking>();
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

async function details(deps: VisitsDeps, booking: MessageBooking) {
  return visitMessageDetails(deps.civil, await deps.timeZone(), {
    hostName: guestHostName, team: identityOf(booking),
    booking: { contactName: booking.contact_name, contactPhone: booking.contact_phone, arrivalMs: booking.arrival_ms, departureMs: booking.departure_ms, headcount: booking.headcount, note: booking.note },
    windowTitle: booking.window_title,
  });
}

/**
 * Send one booking email. The manage link is minted now, so nothing secret waits in the queue: its SHA-256 is stored before
 * the send (a link in a sent email always works) and removed again when Resend certainly did not send it. The recipient's
 * daily cap is reserved first and released only when Resend refused the request.
 */
async function deliverEmail(db: D1Database, deps: VisitsDeps, row: NotificationRow, now: number): Promise<Outcome> {
  const booking = await messageBooking(db, row.booking_id);
  const gone = superseded(row.kind, booking);
  if (gone || !booking) return { status: "skipped", note: gone ?? "This visit no longer exists" };
  if (booking.departure_ms <= now) return { status: "skipped", note: "The visit ended before this email could be sent" };
  const payload = parsePayload(row.payload_json);
  if (!payload.origin) return { status: "retry", error: "The dashboard address is unknown, so no manage link can be sent", permanent: true };
  const timeZone = await deps.timeZone();
  const settings = await readSettings(db, now);
  const addressHash = await emailAddressHash(booking.contact_email);
  const day = emailLimitDay(deps.civil, timeZone, now);
  if (!await db.prepare(reserveEmailSql).bind(installationId, addressHash, day, dailyEmailCap).first()) return { status: "capped", nextAttemptMs: nextEmailDayStartMs(deps.civil, timeZone, now) };
  const release = () => db.prepare(releaseEmailSql).bind(installationId, addressHash, day).run();
  const token = generateManageToken();
  const tokenHash = await hashManageToken(token);
  let link: string;
  try { link = manageLink(payload.origin, token); } catch (error) { await release(); return { status: "retry", error: errorText(error), permanent: true }; }
  await db.prepare("INSERT INTO visits_manage_tokens(installation_id,token_hash,booking_id,issued_ms,expires_ms) VALUES(?,?,?,?,?)").bind(installationId, tokenHash, booking.id, now, booking.departure_ms).run();
  const forget = () => db.prepare("DELETE FROM visits_manage_tokens WHERE installation_id=? AND token_hash=?").bind(installationId, tokenHash).run();
  const message = await details(deps, booking);
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
  const result = await rows<{ status: string; arrival_ms: number; departure_ms: number; headcount: number; number: string; name: string; program: VisitProgram }>(
    db.prepare(`SELECT b.status,b.arrival_ms,b.departure_ms,b.headcount,t.number,t.name,t.program FROM visits_bookings b JOIN visits_teams t ON t.installation_id=b.installation_id AND t.id=b.team_id
      WHERE b.installation_id=? AND b.status='booked' AND b.arrival_ms>? AND b.arrival_ms<? AND b.departure_ms>?`).bind(installationId, reportMs - 90_000_000, nextReportMs, reportMs));
  return selectSummaryVisits(result.map((visit) => ({ status: visit.status, arrivalMs: visit.arrival_ms, departureMs: visit.departure_ms, headcount: visit.headcount, team: identityOf(visit) })), reportMs, nextReportMs);
}

/** Post one Discord message: a booking change or the weekly summary. Nothing is mentioned and a retry cannot post twice. */
async function deliverDiscord(db: D1Database, deps: VisitsDeps, row: NotificationRow, now: number): Promise<Outcome> {
  const settings = await readSettings(db, now);
  if (settings.discord_enabled !== 1 || !settings.discord_channel_id) return { status: "skipped", note: "Guest Visits Discord messages are off" };
  let content: string;
  if (row.kind === "weekly-summary") {
    const payload = parseSummaryPayload(row.payload_json);
    if (!payload || !row.summary_date) return { status: "retry", error: "This summary cannot be read", permanent: true };
    if (summaryDisposition(payload, now) === "skip") return { status: "skipped", note: "The next summary was due before this one could be sent" };
    content = formatWeeklySummary(deps.civil, await deps.timeZone(), { reportDate: row.summary_date, nextReportDate: payload.nextReportDate, visits: await summaryVisits(db, payload.reportMs, payload.nextReportMs) });
  } else {
    const booking = await messageBooking(db, row.booking_id);
    const gone = superseded(row.kind, booking);
    if (gone || !booking) return { status: "skipped", note: gone ?? "This visit no longer exists" };
    const message = await details(deps, booking);
    content = row.kind === "changed" ? discordChangedMessage(message, parsePayload(row.payload_json).changes ?? [])
      : row.kind === "canceled" ? discordCanceledMessage(message) : discordBookedMessage(message);
  }
  try {
    const client = await deps.discord.client();
    const response = await client.request<{ id?: unknown }>(`/channels/${encodeURIComponent(settings.discord_channel_id)}/messages`, { method: "POST", body: JSON.stringify(discordMessageBody(content, discordNonce(row.id))) });
    return { status: "delivered", externalId: typeof response.body?.id === "string" ? response.body.id : null };
  } catch (error) {
    const status = deps.discord.providerStatus(error);
    return { status: "retry", error: errorText(error), permanent: status !== undefined && status >= 400 && status < 500 && status !== 429 };
  }
}

async function deliver(db: D1Database, deps: VisitsDeps, row: NotificationRow, now: number) {
  const lease = await claim(db, row.id, now);
  if (!lease) return null;
  let outcome: Outcome;
  try {
    outcome = row.channel === "email" ? await deliverEmail(db, deps, row, now)
      : row.channel === "discord" ? await deliverDiscord(db, deps, row, now)
        : { status: "retry", error: "Recording in Outreach is not available in this version", permanent: true };
  } catch (error) {
    outcome = { status: "retry", error: errorText(error) };
  }
  return finish(db, row, lease, outcome, now);
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

/** Queue this week's summary when its report time has passed, once per report date. */
export async function scheduleWeeklySummary(db: D1Database, deps: VisitsDeps, discordReady: boolean, now: number): Promise<SummaryDecision> {
  const settings = await readSettings(db, now);
  if (!discordReady || settings.discord_enabled !== 1 || !settings.discord_channel_id || settings.weekly_summary_enabled !== 1) return { action: "off" };
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

export type NotificationPass = { readonly recovered: number; readonly delivered: number; readonly pending: number; readonly failed: number; readonly skipped: number; readonly summary: SummaryDecision["action"] };

/**
 * The visits.notifications job: take back rows whose sender stopped, queue the weekly summary when due, send due email and
 * Discord notifications (leaving a provider's rows queued while it is not ready), then forget old daily email counts,
 * expired or long-revoked manage links and old guest submission keys. Core runs it only while Guest Visits is enabled and
 * set up, and every statement rechecks that.
 */
export async function processVisitsNotifications(db: D1Database, deps: VisitsDeps, limit = notificationsPerPass): Promise<NotificationPass> {
  const now = deps.now();
  const recovered = (await db.prepare(recoverExpiredLeasesSql).bind(iso(now), installationId, now).run()).meta?.changes ?? 0;
  const channels = await readyChannels(deps);
  const summary = await scheduleWeeklySummary(db, deps, channels.includes("discord"), now);
  const counts = { delivered: 0, pending: 0, failed: 0, skipped: 0 };
  if (channels.length) {
    const due = await rows<NotificationRow>(db.prepare(`SELECT ${notificationColumns} FROM visits_notifications WHERE installation_id=? AND status='pending' AND next_attempt_ms<=? AND channel IN (SELECT value FROM json_each(?)) ORDER BY next_attempt_ms,id LIMIT ?`)
      .bind(installationId, now, JSON.stringify(channels), limit));
    for (const row of due) {
      const result = await deliver(db, deps, row, now);
      if (result) counts[result] += 1;
    }
  }
  const timeZone = await deps.timeZone();
  const today = localMoment(deps.civil, timeZone, now).date;
  await db.batch([
    db.prepare(purgeEmailLimitsSql).bind(installationId, addDays(today, -1)),
    db.prepare("DELETE FROM visits_manage_tokens WHERE installation_id=? AND (expires_ms<=? OR revoked_ms<=?)").bind(installationId, now, now - revokedTokenRetentionMs),
    db.prepare("DELETE FROM visits_public_submission_keys WHERE installation_id=? AND created_ms<?").bind(installationId, now - submissionKeyRetentionMs),
  ]);
  return { recovered, ...counts, summary: summary.action };
}
