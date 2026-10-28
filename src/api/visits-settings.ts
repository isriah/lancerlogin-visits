// Guest Visits settings (Admin only), the test email that completes the email setup step, the workspace status and the
// setup checklist's predicates.
import type { D1Database } from "@lancerlogin/module-sdk/api";
import type { VisitsSettings, VisitsSetupStatus, VisitsStatus } from "../shared/visits-api.ts";
import { parseEmail } from "../shared/visits-booking.ts";
import { dailyEmailCap, emailAddressHash, emailLimitDay, releaseEmailSql, reserveEmailSql } from "../shared/visits-limits.ts";
import { escapeHtml, maximumHostNameLength, maximumIntroTextLength } from "../shared/visits-text.ts";
import { defaultSettingsSql } from "../shared/visits-storage.ts";
import { isLocalTime, multiLine, singleLine } from "../shared/visits-time.ts";
import { outreachAccess } from "./visits-outreach.ts";
import { attentionCountSql } from "./visits-queries.ts";
import { installationId, iso, objectBody, ok, onlyFields, revisionOf, stale, VisitsError, type RouteResult, type SettingsRow, type VisitsDeps } from "./visits-runtime.ts";

const settingsColumns = "host_name,intro_text,reply_to,test_email_sent_at,discord_enabled,discord_channel_id,weekly_summary_enabled,weekly_summary_weekday,weekly_summary_time,weekly_summary_since_ms,revision";

/** The settings row, created with its defaults if first enablement somehow left none. */
export async function readSettings(db: D1Database, now: number): Promise<SettingsRow> {
  const read = () => db.prepare(`SELECT ${settingsColumns} FROM visits_settings WHERE installation_id=?`).bind(installationId).first<SettingsRow>();
  const row = await read();
  if (row) return row;
  await db.prepare(defaultSettingsSql).bind(installationId, now, iso(now)).run();
  const created = await read();
  if (!created) throw new VisitsError(409, "Guest Visits settings are unavailable. Reload and try again.");
  return created;
}

export function visitsSettings(row: SettingsRow): VisitsSettings {
  return {
    revision: row.revision, hostName: row.host_name, introText: row.intro_text, replyTo: row.reply_to, testEmailSentMs: row.test_email_sent_at ? Date.parse(row.test_email_sent_at) : null,
    discordEnabled: row.discord_enabled === 1, discordChannelId: row.discord_channel_id ?? "", weeklySummaryEnabled: row.weekly_summary_enabled === 1,
    weeklySummaryWeekday: row.weekly_summary_weekday, weeklySummaryTime: row.weekly_summary_time,
  };
}

const settingsFields = ["revision", "hostName", "introText", "replyTo", "discordEnabled", "discordChannelId", "weeklySummaryEnabled", "weeklySummaryWeekday", "weeklySummaryTime"];

function flag(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new VisitsError(400, "Choose on or off", field);
  return value;
}

/** Validate a settings change against the current settings. Only the fields sent change. */
export function parseSettingsUpdate(value: unknown, current: VisitsSettings): Omit<VisitsSettings, "testEmailSentMs"> {
  const input = objectBody(value);
  onlyFields(input, settingsFields);
  const next: { -readonly [Key in keyof VisitsSettings]: VisitsSettings[Key] } = { ...current, revision: revisionOf(input.revision) };
  if ("hostName" in input) {
    if (typeof input.hostName !== "string") throw new VisitsError(400, "Enter your team's name as text", "hostName");
    next.hostName = singleLine(input.hostName);
    if (next.hostName.length > maximumHostNameLength) throw new VisitsError(400, `Your team's name is at most ${maximumHostNameLength} characters`, "hostName");
  }
  if ("introText" in input) {
    if (typeof input.introText !== "string") throw new VisitsError(400, "Enter the introduction as text", "introText");
    next.introText = multiLine(input.introText);
    if (next.introText.length > maximumIntroTextLength) throw new VisitsError(400, `The introduction is at most ${maximumIntroTextLength} characters`, "introText");
  }
  if ("replyTo" in input) {
    if (typeof input.replyTo !== "string") throw new VisitsError(400, "Enter the reply-to address as text", "replyTo");
    if (!input.replyTo.trim()) next.replyTo = "";
    else {
      const address = parseEmail(input.replyTo, "replyTo");
      if (!address.ok) throw new VisitsError(400, address.error, address.field);
      next.replyTo = address.value;
    }
  }
  if ("discordEnabled" in input) next.discordEnabled = flag(input.discordEnabled, "discordEnabled");
  if ("discordChannelId" in input) {
    if (typeof input.discordChannelId !== "string" || (input.discordChannelId.trim() && !/^\d{17,20}$/.test(input.discordChannelId.trim()))) throw new VisitsError(400, "Discord channel IDs are 17 to 20 digits", "discordChannelId");
    next.discordChannelId = input.discordChannelId.trim();
  }
  if ("weeklySummaryEnabled" in input) next.weeklySummaryEnabled = flag(input.weeklySummaryEnabled, "weeklySummaryEnabled");
  if ("weeklySummaryWeekday" in input) {
    if (!Number.isInteger(input.weeklySummaryWeekday) || (input.weeklySummaryWeekday as number) < 0 || (input.weeklySummaryWeekday as number) > 6) throw new VisitsError(400, "Choose the weekday for the summary", "weeklySummaryWeekday");
    next.weeklySummaryWeekday = input.weeklySummaryWeekday as number;
  }
  if ("weeklySummaryTime" in input) {
    if (!isLocalTime(input.weeklySummaryTime)) throw new VisitsError(400, "Enter the summary time as HH:MM", "weeklySummaryTime");
    next.weeklySummaryTime = input.weeklySummaryTime;
  }
  if (next.discordEnabled && !next.discordChannelId) throw new VisitsError(400, "Enter the Discord channel ID for Guest Visits messages", "discordChannelId");
  const { testEmailSentMs: _sent, ...result } = next;
  return result;
}

/**
 * Save settings. Turning the summary or Discord messages on, or moving the summary to another day or time, starts the
 * schedule now, so no past week's summary posts.
 */
export async function updateSettings(db: D1Database, deps: VisitsDeps, value: unknown): Promise<RouteResult> {
  const now = deps.now();
  const current = visitsSettings(await readSettings(db, now));
  const next = parseSettingsUpdate(value, current);
  const restart = (next.weeklySummaryEnabled && !current.weeklySummaryEnabled) || (next.discordEnabled && !current.discordEnabled)
    || next.weeklySummaryWeekday !== current.weeklySummaryWeekday || next.weeklySummaryTime !== current.weeklySummaryTime;
  const result = await db.prepare(`UPDATE visits_settings SET host_name=?,intro_text=?,reply_to=?,discord_enabled=?,discord_channel_id=?,weekly_summary_enabled=?,weekly_summary_weekday=?,weekly_summary_time=?,
    weekly_summary_since_ms=CASE WHEN ? THEN ? ELSE weekly_summary_since_ms END,revision=revision+1,updated_at=? WHERE installation_id=? AND revision=?`)
    .bind(next.hostName, next.introText, next.replyTo, next.discordEnabled ? 1 : 0, next.discordChannelId || null, next.weeklySummaryEnabled ? 1 : 0, next.weeklySummaryWeekday, next.weeklySummaryTime,
      restart ? 1 : 0, now, iso(now), installationId, next.revision).run();
  if (result.meta?.changes !== 1) throw stale("Guest Visits settings");
  return ok(visitsSettings(await readSettings(db, now)));
}

export const testEmailSubject = "Guest Visits test email";

/**
 * Send a test email through Core's Resend connection and record that it worked, which completes the email setup step.
 * It counts toward the recipient's daily cap like every Guest Visits email.
 */
export async function sendTestEmail(db: D1Database, deps: VisitsDeps, value: unknown): Promise<RouteResult> {
  const input = objectBody(value);
  onlyFields(input, ["to"]);
  const to = parseEmail(input.to, "to");
  if (!to.ok) throw new VisitsError(400, to.error, to.field);
  if (!await deps.email.ready()) throw new VisitsError(409, "Connect and verify Resend in Settings > Integrations, then send the test email again.");
  const now = deps.now();
  const settings = await readSettings(db, now);
  const timeZone = await deps.timeZone();
  const addressHash = await emailAddressHash(to.value);
  const day = emailLimitDay(deps.civil, timeZone, now);
  const reserved = await db.prepare(reserveEmailSql).bind(installationId, addressHash, day, dailyEmailCap).first();
  if (!reserved) throw new VisitsError(429, `This address already received ${dailyEmailCap} Guest Visits emails today. Use another address or try again tomorrow.`, "to");
  const text = "This is a test email from Guest Visits. Confirmation emails to guest teams will be sent the same way.";
  try {
    await deps.email.send({
      to: to.value, subject: testEmailSubject, text, html: `<!doctype html>\n<html><body><p>${escapeHtml(text)}</p></body></html>`,
      ...(settings.reply_to ? { replyTo: settings.reply_to } : {}), idempotencyKey: `test-${crypto.randomUUID()}`,
    });
  } catch (error) {
    const status = deps.email.providerStatus(error);
    if (status !== undefined && status >= 400 && status < 500) await db.prepare(releaseEmailSql).bind(installationId, addressHash, day).run();
    throw new VisitsError(502, status === undefined ? "The test email could not be sent. Try again." : `Resend refused the test email (${status}). Check the Resend connection in Settings > Integrations.`);
  }
  await db.prepare("UPDATE visits_settings SET test_email_sent_at=?,updated_at=? WHERE installation_id=?").bind(iso(now), iso(now), installationId).run();
  return ok({ sent: true, testEmailSentMs: now });
}

/**
 * The workspace status: which providers are ready, whether Outreach can be used now (through an Admin's grant or the
 * staff member's own Outreach access) and whether a grant lets Guest Visits record on its own, and how much needs
 * attention.
 */
export async function visitsStatus(db: D1Database, deps: VisitsDeps): Promise<VisitsStatus> {
  const now = deps.now();
  const [settings, timeZone, emailReady, discordReady, attention, failed] = await Promise.all([
    readSettings(db, now), deps.timeZone(), deps.email.ready(), deps.discord.ready(),
    db.prepare(attentionCountSql).bind(installationId).first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM visits_notifications WHERE installation_id=? AND status='failed'").bind(installationId).first<{ count: number }>(),
  ]);
  const outreach = await outreachAccess(db, deps, now);
  return {
    timeZone, guestPagePath: "/visit", email: { ready: emailReady }, discord: { ready: discordReady, enabled: settings.discord_enabled === 1 },
    outreach: { available: Boolean(outreach.client) || outreach.granted, granted: outreach.granted },
    attentionCount: Number(attention?.count ?? 0), failedNotifications: Number(failed?.count ?? 0),
  };
}

export async function setupStatus(db: D1Database, deps: VisitsDeps): Promise<VisitsSetupStatus> {
  const now = deps.now();
  const [settings, timeZone, emailReady, windows] = await Promise.all([
    readSettings(db, now), deps.timeZone(), deps.email.ready(),
    db.prepare("SELECT COUNT(*) AS count FROM visits_windows WHERE installation_id=? AND status!='removed'").bind(installationId).first<{ count: number }>(),
  ]);
  return { emailReady, testEmailSentMs: visitsSettings(settings).testEmailSentMs, windowCount: Number(windows?.count ?? 0), timeZone };
}

/** Setup steps: a successful test email is recorded, and at least one availability window exists. */
export const setupStepSql = {
  email: "EXISTS(SELECT 1 FROM visits_settings WHERE installation_id=? AND test_email_sent_at IS NOT NULL)",
  availability: "EXISTS(SELECT 1 FROM visits_windows WHERE installation_id=? AND status!='removed')",
} as const;

export const visitsSetupPredicates = {
  email: (installation: string) => ({ sql: setupStepSql.email, bindings: [installation] }),
  availability: (installation: string) => ({ sql: setupStepSql.availability, bindings: [installation] }),
};

export async function visitsSetupStepValid(db: D1Database, stepId: string): Promise<boolean> {
  if (stepId !== "email" && stepId !== "availability") return false;
  const row = await db.prepare(`SELECT ${setupStepSql[stepId]} AS valid`).bind(installationId).first<{ valid: number }>();
  return Number(row?.valid) === 1;
}
