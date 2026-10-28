// Local dates and times for the Guest Visits pages. Staff data arrives as local dates (YYYY-MM-DD) and times (HH:MM) in
// the installation time zone; the guest page and history arrive as instants, which these helpers read in that time zone
// with the browser's Intl. Everything here is plain functions over src/shared, so `npm test` covers it without React.
import { addDays, formatShortDate, formatTime, isLocalDate, isLocalTime, minutesOfDay, weekdayNames, weekdayOf } from "../shared/visits-time.ts";

/** A local reading of an instant: calendar date and HH:MM time. */
export type LocalReading = { readonly date: string; readonly time: string };
/** A window or visit in local terms. */
export type LocalSpan = { readonly date: string; readonly startTime: string; readonly endTime: string };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let result = formatters.get(timeZone);
  if (!result) {
    result = new Intl.DateTimeFormat("en-US", {
      timeZone, calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    formatters.set(timeZone, result);
  }
  return result;
}

/** The local date and time an instant shows in the time zone. */
export function localReading(epochMs: number, timeZone: string): LocalReading {
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(epochMs)) parts[part.type] = part.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}` };
}

/** Today's local date in the time zone. */
export function todayIn(timeZone: string, now: number = Date.now()): string {
  return localReading(now, timeZone).date;
}

/**
 * A window's local date and times. Windows lie within one local date; an end that reads as the next day (a window ending
 * at midnight) is shown as 23:59 so arrival and departure choices stay on the window's date.
 */
export function localSpan(range: { readonly startMs: number; readonly endMs: number }, timeZone: string): LocalSpan {
  const start = localReading(range.startMs, timeZone);
  const end = localReading(range.endMs, timeZone);
  return { date: start.date, startTime: start.time, endTime: end.date === start.date ? end.time : "23:59" };
}

/** "6:00 PM to 9:00 PM". */
export function formatTimeRange(startTime: string, endTime: string): string {
  return `${formatTime(startTime)} to ${formatTime(endTime)}`;
}

/** "6 PM" for 18:00 and "6:30 PM" for 18:30, for calendar cells. */
export function compactTime(time: string): string {
  const full = formatTime(time);
  return full.replace(":00 ", " ");
}

/** "Monday, November 2, 6:00 PM to 8:00 PM". */
export function formatVisitWhen(date: string, arrival: string, departure: string): string {
  return `${formatShortDate(date)}, ${formatTimeRange(arrival, departure)}`;
}

/** "Monday, November 2, 6:15 PM": an instant in the time zone, for history entries. */
export function formatInstant(epochMs: number, timeZone: string): string {
  const reading = localReading(epochMs, timeZone);
  return `${formatShortDate(reading.date)}, ${formatTime(reading.time)}`;
}

const shortMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "Nov 2, 2026". */
export function formatCompactDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${shortMonths[month! - 1]} ${day}, ${year}`;
}

/** "Mondays and Wednesdays", "Mondays, Wednesdays and Fridays". Weekdays are 0 (Sunday) to 6. */
export function weekdayListText(weekdays: readonly number[]): string {
  const names = [...new Set(weekdays)].sort((left, right) => left - right).map((weekday) => `${weekdayNames[weekday]}s`);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Items grouped by local date in date order, keeping each item's order within its date. */
export function groupByDate<Item>(items: readonly Item[], dateOf: (item: Item) => string): { readonly date: string; readonly items: Item[] }[] {
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const date = dateOf(item);
    const group = groups.get(date);
    if (group) group.push(item); else groups.set(date, [item]);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, grouped]) => ({ date, items: grouped }));
}

/** Instant ranges with their local span, grouped by local date: the guest page's days. */
export function groupRangesByDate<Range extends { readonly startMs: number; readonly endMs: number }>(ranges: readonly Range[], timeZone: string): { readonly date: string; readonly items: (Range & { readonly local: LocalSpan })[] }[] {
  const located = [...ranges].sort((left, right) => left.startMs - right.startMs).map((range) => ({ ...range, local: localSpan(range, timeZone) }));
  return groupByDate(located, (range) => range.local.date);
}

/**
 * The local dates a month calendar shows: from the Sunday on or before the first of the month `offset` months from
 * `today`, to the Saturday on or after its last day. At most six weeks, inside the overview's 120-day limit.
 */
export function monthGridRange(today: string, offset: number): { readonly from: string; readonly to: string; readonly month: string } {
  if (!isLocalDate(today)) throw new RangeError(`Not a local date: ${today}`);
  const [year, month] = today.split("-").map(Number);
  const index = year! * 12 + (month! - 1) + offset;
  const first = `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}-01`;
  const nextIndex = index + 1;
  const nextFirst = `${String(Math.floor(nextIndex / 12)).padStart(4, "0")}-${String((nextIndex % 12) + 1).padStart(2, "0")}-01`;
  const last = addDays(nextFirst, -1);
  return { from: addDays(first, -weekdayOf(first)), to: addDays(last, 6 - weekdayOf(last)), month: first.slice(0, 7) };
}

const asTime = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * Times from `startTime` to `endTime`, both included: the start, every whole `step` minutes after it, and the end. A window
 * from 18:10 to 19:00 gives 18:10, 18:15, 18:30, 18:45 and 19:00.
 */
export function timeSteps(startTime: string, endTime: string, step = 15): string[] {
  if (!isLocalTime(startTime) || !isLocalTime(endTime)) return [];
  const start = minutesOfDay(startTime);
  const end = minutesOfDay(endTime);
  if (end < start) return [];
  const times = [start];
  for (let minutes = (Math.floor(start / step) + 1) * step; minutes < end; minutes += step) times.push(minutes);
  if (end > start) times.push(end);
  return times.map(asTime);
}

/**
 * Arrival choices inside a window: every step from its start up to, but not including, its end. `earliest` (the current
 * local time on the window's date) drops arrivals that have already passed.
 */
export function arrivalChoices(span: Pick<LocalSpan, "startTime" | "endTime">, earliest?: string): string[] {
  const steps = timeSteps(span.startTime, span.endTime).slice(0, -1);
  return earliest && isLocalTime(earliest) ? steps.filter((time) => minutesOfDay(time) > minutesOfDay(earliest)) : steps;
}

/** Departure choices inside a window: every step after the arrival, up to and including its end. */
export function departureChoices(span: Pick<LocalSpan, "startTime" | "endTime">, arrival: string): string[] {
  const steps = timeSteps(span.startTime, span.endTime).slice(1);
  return isLocalTime(arrival) ? steps.filter((time) => minutesOfDay(time) > minutesOfDay(arrival)) : steps;
}

/** The departure to suggest for an arrival: an hour later when the window allows, else the window's end. */
export function defaultDeparture(span: Pick<LocalSpan, "startTime" | "endTime">, arrival: string): string {
  const choices = departureChoices(span, arrival);
  if (!isLocalTime(arrival)) return choices[choices.length - 1] ?? "";
  const target = minutesOfDay(arrival) + 60;
  return choices.find((time) => minutesOfDay(time) >= target) ?? choices[choices.length - 1] ?? "";
}

/** "1 person", "5 people". */
export function peopleText(count: number): string {
  return `${count} ${count === 1 ? "person" : "people"}`;
}

/** "No teams yet", "1 team coming", "3 teams coming". */
export function teamCountText(count: number): string {
  return count === 0 ? "No teams yet" : `${count} ${count === 1 ? "team" : "teams"} coming`;
}

/** "1 visit", "3 visits". */
export function visitCountText(count: number): string {
  return `${count} ${count === 1 ? "visit" : "visits"}`;
}
