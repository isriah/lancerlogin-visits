// Calendar and clock rules shared by every Guest Visits module. Files in src/shared import only each other, never the
// module SDK or node: built-ins, so `npm test` runs without a Core checkout. Time-zone conversion therefore arrives as
// an argument: the Worker and dashboard pass the module SDK's civil-time helpers, and unit tests pass an Intl stand-in.
//
// Daylight saving policy, used for every local date and time Guest Visits turns into an instant:
// - A skipped local time (clocks spring forward) becomes the moment the clock jumps to. In America/New_York on 2026-03-08,
//   02:30 does not exist and becomes 03:00 EDT.
// - A repeated local time (clocks fall back) takes its earlier occurrence for starts, arrivals and report times, and its
//   later occurrence for ends and departures. In America/New_York on 2026-11-01, a window from 01:00 to 01:30 runs from
//   01:00 EDT to 01:30 EST, so it covers every reading of the clock it names.
// Both rules keep local order: times that are in order on the clock stay in order as instants, so a visit that fits a
// window by its local times also fits by its instants. A start and end can only meet when both fall in the same skipped
// hour, and the callers reject that as an empty range.

/** Structurally identical to the module SDK's civil-time types. */
export type CivilTimeOccurrence = "earlier" | "later";
export type CivilTimeInput = { readonly date: string; readonly time: string; readonly timeZone: string };
export type CivilTimeCandidate = { readonly epochMilliseconds: number; readonly offsetSeconds: number };
export type CivilTimeFields = { readonly date: string; readonly time: string; readonly offsetSeconds: number };

/**
 * The civil-time helpers Guest Visits needs. The SDK's `resolveCivilTime` and `instantToCivil` satisfy it, so the Worker
 * can pass `{ resolveCivilTime, instantToCivil }` imported from `@lancerlogin/module-sdk`.
 */
export type CivilTime = {
  /** Every instant that shows this local date and time, earliest first: none in a gap, two in a repeated hour. */
  readonly resolveCivilTime: (input: CivilTimeInput) => readonly CivilTimeCandidate[];
  /** The local date (YYYY-MM-DD), time (HH:mm:ss.SSS) and UTC offset an instant shows in the time zone. */
  readonly instantToCivil: (epochMilliseconds: number, timeZone: string) => CivilTimeFields;
};

/** A validation outcome. `field` names the request field the message is about, for the form to highlight. */
export type Problem = { readonly ok: false; readonly field: string; readonly error: string };
export type Result<T> = { readonly ok: true; readonly value: T } | Problem;
export const ok = <T>(value: T): { readonly ok: true; readonly value: T } => ({ ok: true, value });
export const problem = (field: string, error: string): Problem => ({ ok: false, field, error });

export const minuteMs = 60_000;
export const hourMs = 3_600_000;
export const dayMs = 86_400_000;
/** Earliest and latest years Guest Visits accepts for local dates. */
export const minimumYear = 2000;
export const maximumYear = 2999;

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

function dateParts(date: string): [number, number, number] {
  const match = datePattern.exec(date);
  if (!match) throw new RangeError(`Not a YYYY-MM-DD date: ${date}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether the value is a real calendar date written YYYY-MM-DD, within the supported years. */
export function isLocalDate(value: unknown): value is string {
  if (typeof value !== "string" || !datePattern.test(value)) return false;
  const [year, month, day] = dateParts(value);
  if (year < minimumYear || year > maximumYear) return false;
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

/** Whether the value is a 24-hour local time written HH:MM. */
export function isLocalTime(value: unknown): value is string {
  return typeof value === "string" && timePattern.test(value);
}

/** Minutes since midnight of an HH:MM time. */
export function minutesOfDay(time: string): number {
  const match = timePattern.exec(time);
  if (!match) throw new RangeError(`Not an HH:MM time: ${time}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Days since 1970-01-01 of a calendar date. */
export function epochDay(date: string): number {
  const [year, month, day] = dateParts(date);
  return Date.UTC(year, month - 1, day) / dayMs;
}

/** The calendar date a whole number of days later (or earlier, for a negative count). */
export function addDays(date: string, days: number): string {
  if (!Number.isSafeInteger(days)) throw new RangeError("Day count must be an integer");
  return new Date((epochDay(date) + days) * dayMs).toISOString().slice(0, 10);
}

/** Whole days from one calendar date to another. */
export function daysBetween(from: string, to: string): number {
  return epochDay(to) - epochDay(from);
}

/** Day of the week of a calendar date: 0 is Sunday, 6 is Saturday. */
export function weekdayOf(date: string): number {
  return new Date(epochDay(date) * dayMs).getUTCDay();
}

/** Which end of a range a local time is, for the daylight saving policy above. */
export type LocalEdge = "start" | "end";

/**
 * The instant a local date and time names in the time zone, following the daylight saving policy above. The date and
 * time must already be valid (see `isLocalDate` and `isLocalTime`).
 */
export function localInstant(civil: CivilTime, timeZone: string, date: string, time: string, edge: LocalEdge): number {
  const candidates = civil.resolveCivilTime({ date, time, timeZone });
  if (candidates.length) return candidates[edge === "end" ? candidates.length - 1 : 0]!.epochMilliseconds;
  // A skipped time. Read as an instant in UTC, the local reading lies between the instants it would name under the
  // offsets in force a day before and a day after (the same window the SDK resolves within). Find the first instant
  // after the jump by bisection over whole minutes.
  const [year, month, day] = dateParts(date);
  const nominal = Date.UTC(year, month - 1, day) + minutesOfDay(time) * minuteMs;
  const before = civil.instantToCivil(nominal - dayMs, timeZone).offsetSeconds * 1000;
  const after = civil.instantToCivil(nominal + dayMs, timeZone).offsetSeconds * 1000;
  let earlier = Math.floor((nominal - after) / minuteMs);
  let later = Math.ceil((nominal - before) / minuteMs);
  if (later <= earlier) throw new RangeError(`Cannot resolve ${date} ${time} in ${timeZone}`);
  while (later - earlier > 1) {
    const middle = Math.floor((earlier + later) / 2);
    if (civil.instantToCivil(middle * minuteMs, timeZone).offsetSeconds * 1000 === before) earlier = middle;
    else later = middle;
  }
  return later * minuteMs;
}

/** A local reading of an instant: calendar date, HH:MM time and weekday (0 is Sunday). */
export type LocalMoment = { readonly date: string; readonly time: string; readonly weekday: number };

export function localMoment(civil: CivilTime, timeZone: string, epochMs: number): LocalMoment {
  const fields = civil.instantToCivil(epochMs, timeZone);
  return { date: fields.date, time: fields.time.slice(0, 5), weekday: weekdayOf(fields.date) };
}

/** A span of time as instants, end exclusive. */
export type TimeRange = { readonly startMs: number; readonly endMs: number };

/** Whether two ranges share any instant. Ranges that only touch (one ends as the other starts) do not overlap. */
export function rangesOverlap(left: TimeRange, right: TimeRange): boolean {
  return left.startMs < right.endMs && right.startMs < left.endMs;
}

/** Whether the outer range contains the inner one. */
export function rangeContains(outer: TimeRange, inner: TimeRange): boolean {
  return outer.startMs <= inner.startMs && inner.endMs <= outer.endMs;
}

/** Instants for a local date with start and end times, following the daylight saving policy. */
export function localRange(civil: CivilTime, timeZone: string, date: string, startTime: string, endTime: string): TimeRange {
  return { startMs: localInstant(civil, timeZone, date, startTime, "start"), endMs: localInstant(civil, timeZone, date, endTime, "end") };
}

export const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/** "Monday, November 2, 2026". */
export function formatDate(date: string): string {
  return `${formatShortDate(date)}, ${dateParts(date)[0]}`;
}

/** "Monday, November 2". */
export function formatShortDate(date: string): string {
  const [, month, day] = dateParts(date);
  return `${weekdayNames[weekdayOf(date)]}, ${monthNames[month - 1]} ${day}`;
}

/** "6:00 PM" for 18:00, "12:00 AM" for 00:00, "12:30 PM" for 12:30. */
export function formatTime(time: string): string {
  const minutes = minutesOfDay(time);
  const hour = Math.floor(minutes / 60);
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(minutes % 60).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

/** Trim, turn every run of whitespace (including line breaks) into one space, and drop control characters. */
export function singleLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g, " ").trim();
}

/** Trim, keep line breaks as \n (at most two in a row), and drop other control characters. */
export function multiLine(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
