// The weekly Discord summary. It posts at a weekday and local time in the installation time zone (default Monday 12:00)
// and lists every booked visit that has not ended by the report time and starts before the next report. Each job pass
// queues at most one summary, keyed by its report date, so a week posts once even across retries; a missed time posts
// on the next pass, and a summary still unsent when the following report time arrives is skipped.
import { teamLabel, type TeamIdentity } from "./visits-booking.ts";
import { discordContentLimit, escapeDiscord, peopleCount } from "./visits-text.ts";
import { addDays, formatShortDate, formatTime, isLocalTime, localInstant, localMoment, type CivilTime } from "./visits-time.ts";

export const defaultSummaryWeekday = 1;
export const defaultSummaryTime = "12:00";
export const emptyWeekText = "No guest visits scheduled this week";

/** When the summary posts: weekday 0 (Sunday) to 6, and a local HH:MM time. */
export type SummarySchedule = { readonly weekday: number; readonly time: string };
/** One report: its local date and the instant it is due. */
export type ReportTime = { readonly date: string; readonly ms: number };

function checkSchedule(schedule: SummarySchedule) {
  if (!Number.isInteger(schedule.weekday) || schedule.weekday < 0 || schedule.weekday > 6 || !isLocalTime(schedule.time)) throw new RangeError("Invalid weekly summary schedule");
}

/** The report time of a local date. A skipped time moves to the moment the clock jumps to; a repeated time takes its first occurrence. */
export function reportInstant(civil: CivilTime, timeZone: string, date: string, time: string): number {
  return localInstant(civil, timeZone, date, time, "start");
}

/** The latest report time at or before `now`, and the one after it. */
export function reportTimes(civil: CivilTime, timeZone: string, schedule: SummarySchedule, now: number): { readonly current: ReportTime; readonly next: ReportTime } {
  checkSchedule(schedule);
  const today = localMoment(civil, timeZone, now);
  let date = addDays(today.date, -((today.weekday - schedule.weekday + 7) % 7));
  let ms = reportInstant(civil, timeZone, date, schedule.time);
  if (ms > now) { date = addDays(date, -7); ms = reportInstant(civil, timeZone, date, schedule.time); }
  const nextDate = addDays(date, 7);
  return { current: { date, ms }, next: { date: nextDate, ms: reportInstant(civil, timeZone, nextDate, schedule.time) } };
}

/** The payload a queued summary keeps, so delivery knows its range and when it goes stale. */
export type SummaryPayload = { readonly reportMs: number; readonly nextReportMs: number; readonly nextReportDate: string };

/** What a job pass should do about the weekly summary. */
export type SummaryDecision =
  /** Discord messages or the summary are off. */
  | { readonly action: "off" }
  /** No report time has passed since the summary was turned on or rescheduled. */
  | { readonly action: "wait"; readonly next: ReportTime }
  /** Queue the summary for this report date. */
  | { readonly action: "queue"; readonly reportDate: string; readonly payload: SummaryPayload }
  /** This report date is already queued, sent or skipped; nothing to do. */
  | { readonly action: "done"; readonly reportDate: string; readonly status: string; readonly next: ReportTime };

/**
 * Decide whether to queue this week's summary. `sinceMs` is when the summary was last turned on or rescheduled: report
 * times before it are never due, so changing the day or time does not post a past week. `existingStatus` is the status of
 * the notification already queued for the current report date, if any.
 */
export function weeklySummaryDecision(input: {
  readonly civil: CivilTime;
  readonly timeZone: string;
  readonly enabled: boolean;
  readonly schedule: SummarySchedule;
  readonly sinceMs: number;
  readonly now: number;
  readonly existingStatus: string | null | undefined;
}): SummaryDecision {
  if (!input.enabled) return { action: "off" };
  const { current, next } = reportTimes(input.civil, input.timeZone, input.schedule, input.now);
  if (current.ms < input.sinceMs) return { action: "wait", next };
  if (input.existingStatus) return { action: "done", reportDate: current.date, status: input.existingStatus, next };
  return { action: "queue", reportDate: current.date, payload: { reportMs: current.ms, nextReportMs: next.ms, nextReportDate: next.date } };
}

/** At delivery: send a queued summary, or skip it once the following report time has arrived. */
export function summaryDisposition(payload: Pick<SummaryPayload, "nextReportMs">, now: number): "send" | "skip" {
  return now < payload.nextReportMs ? "send" : "skip";
}

/** Read a queued summary's payload back. */
export function parseSummaryPayload(json: string): SummaryPayload | null {
  try {
    const value = JSON.parse(json) as Partial<SummaryPayload>;
    return Number.isSafeInteger(value.reportMs) && Number.isSafeInteger(value.nextReportMs) && typeof value.nextReportDate === "string" && value.nextReportMs! > value.reportMs!
      ? { reportMs: value.reportMs!, nextReportMs: value.nextReportMs!, nextReportDate: value.nextReportDate } : null;
  } catch { return null; }
}

export type SummaryVisit = { readonly status: string; readonly arrivalMs: number; readonly departureMs: number; readonly headcount: number | null; readonly team: TeamIdentity };

/** Booked visits that have not ended by the report time and start before the next report, by arrival. */
export function selectSummaryVisits<Visit extends SummaryVisit>(visits: readonly Visit[], reportMs: number, nextReportMs: number): Visit[] {
  return visits.filter((visit) => visit.status === "booked" && visit.departureMs > reportMs && visit.arrivalMs < nextReportMs)
    .sort((left, right) => left.arrivalMs - right.arrivalMs || left.departureMs - right.departureMs || teamLabel(left.team).localeCompare(teamLabel(right.team)));
}

/**
 * The summary message: a heading, then the visits grouped by local day with team number, name, program, arrival,
 * departure and headcount. Contacts and notes stay out. An empty week says so. A week too long for one Discord message
 * ends with how many visits were left out.
 */
export function formatWeeklySummary(civil: CivilTime, timeZone: string, input: { readonly reportDate: string; readonly nextReportDate: string; readonly visits: readonly SummaryVisit[] }): string {
  const heading = `**Guest visits from ${formatShortDate(input.reportDate)} to ${formatShortDate(input.nextReportDate)}**`;
  if (!input.visits.length) return `${heading}\n${emptyWeekText}`;
  const lines: string[] = [];
  let day = "";
  for (const visit of input.visits) {
    const arrival = localMoment(civil, timeZone, visit.arrivalMs);
    const departure = localMoment(civil, timeZone, visit.departureMs);
    if (arrival.date !== day) { day = arrival.date; lines.push("", `**${formatShortDate(day)}**`); }
    lines.push(`- ${escapeDiscord(teamLabel(visit.team))}: ${formatTime(arrival.time)} to ${formatTime(departure.time)}, ${peopleCount(visit.headcount)}`);
  }
  const total = input.visits.length;
  let message = [heading, ...lines].join("\n");
  if (message.length <= discordContentLimit) return message;
  // Drop whole visit lines from the end until the remainder and its note fit.
  const kept = [heading, ...lines];
  let shown = total;
  while (kept.length > 1) {
    const removed = kept.pop()!;
    if (removed.startsWith("- ")) shown--;
    while (kept.length > 1 && !kept[kept.length - 1]!.startsWith("- ")) kept.pop();
    message = `${kept.join("\n")}\n\n...and ${total - shown} more ${total - shown === 1 ? "visit" : "visits"} in Guest Visits`;
    if (message.length <= discordContentLimit) return message;
  }
  return `${heading}\n${total} guest visits this week. See Guest Visits for the list.`;
}
