// Local dates and times for the Guest Visits pages. Staff data arrives as local dates (YYYY-MM-DD) and times (HH:MM) in
// the installation time zone; the guest page and history arrive as instants, which these helpers read in that time zone
// with the browser's Intl. Everything here is plain functions over src/shared, so `npm test` covers it without React.
import type { PublicVisit } from "../shared/visits-booking.ts";
import { addDays, daysBetween, formatShortDate, formatTime, isLocalDate, isLocalTime, minutesOfDay, weekdayNames, weekdayOf } from "../shared/visits-time.ts";

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

export const shortMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "Nov 2, 2026". */
export function formatCompactDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${shortMonths[month! - 1]} ${day}, ${year}`;
}

/** "Oct 18 to Nov 21, 2026", with both years when they differ: "Dec 27, 2026 to Jan 30, 2027". */
export function formatDateRange(from: string, to: string): string {
  const start = formatCompactDate(from);
  return `${from.slice(0, 4) === to.slice(0, 4) ? start.slice(0, -6) : start} to ${formatCompactDate(to)}`;
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

/** Weeks the guest calendar shows at once: last week, this week and the three after it, like Core's rolling calendars. */
export const guestViewWeeks = 5;

/**
 * The dates of guest calendar view `view`, Sunday first. View 0 starts on the Sunday of last week; each view after it
 * starts five weeks later, the step the arrows on Core's rolling calendars took.
 */
export function guestWeekDates(today: string, view: number): string[] {
  if (!isLocalDate(today)) throw new RangeError(`Not a local date: ${today}`);
  const first = addDays(today, view * 7 * guestViewWeeks - weekdayOf(today) - 7);
  return Array.from({ length: 7 * guestViewWeeks }, (_, index) => addDays(first, index));
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

/**
 * The departure to suggest for an arrival: the window's end (its last departure choice), so a visit starts out covering
 * the whole open time from the arrival on. Guests can still choose an earlier departure. Empty when none is left.
 */
export function defaultDeparture(span: Pick<LocalSpan, "startTime" | "endTime">, arrival: string): string {
  const choices = departureChoices(span, arrival);
  return choices[choices.length - 1] ?? "";
}

/** "1 person", "5 people", or "headcount not given" in a sentence when the guest did not give one. */
export function peopleText(count: number | null): string {
  return count === null ? "headcount not given" : `${count} ${count === 1 ? "person" : "people"}`;
}

/** A headcount on its own, beside a "People" label: "12 people", or "Not given". */
export function headcountText(count: number | null): string {
  return count === null ? "Not given" : peopleText(count);
}

/** "No teams yet", "1 team coming", "3 teams coming". */
export function teamCountText(count: number): string {
  return count === 0 ? "No teams yet" : `${count} ${count === 1 ? "team" : "teams"} coming`;
}

/**
 * A day on the guest calendar. `open` days have a window a guest can still book; `canceled` days have only canceled
 * windows, which guests may open to read the reason; `closed` days have windows that can no longer be booked, such as
 * today's after they started. The times and titles are those of the windows the state describes; the team labels are
 * the distinct teams coming that day, in window and arrival order.
 */
export type GuestDay = {
  readonly date: string;
  readonly state: "open" | "canceled" | "closed";
  readonly openWindows: number;
  readonly teams: number;
  readonly startTime: string;
  readonly endTime: string;
  readonly titles: readonly string[];
  readonly teamLabels: readonly string[];
};

/** A window as the guest calendar reads it: the guest page's windows with their local span. */
export type GuestCalendarWindow = {
  readonly id: string; readonly title: string; readonly status: "open" | "canceled"; readonly teamCount: number;
  readonly visits: readonly Pick<PublicVisit, "program" | "teamNumber" | "teamName">[]; readonly local: LocalSpan;
};

/** "321 RoboLancers": a team as a guest calendar cell names it. */
export function guestTeamLabel(visit: Pick<PublicVisit, "teamNumber" | "teamName">): string {
  return `${visit.teamNumber} ${visit.teamName}`;
}

/** Guest calendar days by local date, from the guest page's windows and the IDs of the ones that can be booked. */
export function guestDays(windows: readonly GuestCalendarWindow[], bookable: ReadonlySet<string>): Map<string, GuestDay> {
  const days = new Map<string, GuestDay>();
  for (const { date, items } of groupByDate(windows, (window) => window.local.date)) {
    const open = items.filter((window) => bookable.has(window.id));
    const state = open.length ? "open" : items.every((window) => window.status === "canceled") ? "canceled" : "closed";
    const shown = open.length ? open : items;
    // Keyed by team, so a team coming to two windows is listed once, where it first comes.
    const coming = new Map(items.filter((window) => window.status === "open").flatMap((window) => window.visits)
      .map((visit) => [`${visit.program} ${visit.teamNumber}`, guestTeamLabel(visit)] as const));
    days.set(date, {
      date, state, openWindows: open.length,
      teams: items.reduce((total, window) => total + (window.status === "open" ? window.teamCount : 0), 0),
      startTime: shown.map((window) => window.local.startTime).sort()[0]!,
      endTime: shown.map((window) => window.local.endTime).sort().at(-1)!,
      titles: [...new Set(shown.map((window) => window.title.trim()).filter(Boolean))],
      teamLabels: [...coming.values()],
    });
  }
  return days;
}

/** What a guest calendar day holds, for its accessible name: "2 open times, 1 team coming", "Canceled", "No open times". */
export function guestDayText(day: GuestDay | undefined): string {
  if (!day) return "No open times";
  if (day.state === "canceled") return "Canceled";
  if (day.state === "closed") return "No open times left";
  const times = `${day.openWindows} open ${day.openWindows === 1 ? "time" : "times"}`;
  return day.teams ? `${times}, ${teamCountText(day.teams)}` : times;
}

/** A line of a guest calendar cell. */
export type GuestCellLine = { readonly kind: "time" | "title" | "team" | "more" | "canceled"; readonly text: string };

/**
 * What a guest calendar cell shows in `room` lines. An open day shows its hours ("2 times" for several slots), its slot
 * titles, then the teams coming; a line is kept for the teams, and teams that do not fit end in "+N more" ("3 teams"
 * when none fit). A canceled day shows "Canceled", other days nothing. The button's accessible name says it all anyway.
 */
export function guestCellLines(day: GuestDay | undefined, room: number): GuestCellLine[] {
  if (!day || day.state === "closed" || room < 1) return [];
  if (day.state === "canceled") return [{ kind: "canceled", text: "Canceled" }];
  const teams = day.teamLabels;
  const titles = day.titles.slice(0, Math.max(0, room - 1 - (teams.length ? 1 : 0)));
  const left = room - 1 - titles.length;
  const shown = teams.length > left ? teams.slice(0, Math.max(0, left - 1)) : teams;
  const hidden = teams.length - shown.length;
  return [
    { kind: "time", text: day.openWindows > 1 ? `${day.openWindows} times` : `${compactTime(day.startTime)} to ${compactTime(day.endTime)}` },
    ...titles.map((text) => ({ kind: "title", text }) as const),
    ...shown.map((text) => ({ kind: "team", text }) as const),
    ...(hidden && left > 0 ? [{ kind: "more", text: shown.length ? `+${hidden} more` : `${teams.length} teams` } as const] : []),
  ];
}

/**
 * The last view a guest may move to: the one holding the horizon's last day or the last posted window, whichever is
 * later. View 0, with last week and this week, is the first, so guests never page back before last week.
 */
export function guestLastView(today: string, horizonDays: number, days: ReadonlyMap<string, GuestDay>): number {
  const last = [addDays(today, Math.max(0, horizonDays - 1)), ...days.keys()].sort().at(-1)!;
  return Math.max(0, Math.floor(daysBetween(guestWeekDates(today, 0)[0]!, last) / (7 * guestViewWeeks)));
}

/** "1 visit", "3 visits". */
export function visitCountText(count: number): string {
  return `${count} ${count === 1 ? "visit" : "visits"}`;
}
