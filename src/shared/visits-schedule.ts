// Availability rules: repeating series, one-off windows, overlap and which windows a series edit replaces.
// Windows are stored as instants and entered in the installation time zone (see the daylight saving policy in
// visits-time.ts). A window lies within one local date and ends after it starts.
import {
  addDays, daysBetween, isLocalDate, isLocalTime, localMoment, localRange, minutesOfDay, ok, problem, rangesOverlap, singleLine, weekdayOf,
  type CivilTime, type Result, type TimeRange,
} from "./visits-time.ts";

/** A series covers at most this many dates, first and last included. */
export const maximumSeriesDates = 366;
export const maximumWindowTitleLength = 80;
export const maximumCancelReasonLength = 200;
export const windowStatuses = ["open", "canceled", "removed"] as const;
export type WindowStatus = (typeof windowStatuses)[number];

/** A validated repeating series. Weekdays are 0 (Sunday) to 6, sorted and distinct. */
export type SeriesDefinition = {
  readonly weekdays: readonly number[];
  readonly startTime: string;
  readonly endTime: string;
  readonly firstDate: string;
  readonly lastDate: string;
  readonly title: string;
};

/** A validated one-off window, or the new times of one edited window, in local terms. */
export type WindowDefinition = { readonly date: string; readonly startTime: string; readonly endTime: string; readonly title: string };

/** A window resolved to instants. `date` is its local date. */
export type DatedWindow = TimeRange & { readonly date: string; readonly title: string };

/** A window as stored. `edited` marks a window changed on its own, which series edits leave alone. */
export type StoredWindow = TimeRange & {
  readonly id: string;
  readonly seriesId: string | null;
  readonly title: string;
  readonly status: WindowStatus;
  readonly edited: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function unexpectedField(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(value).find((key) => !allowed.includes(key));
}

/** Validate an optional title: trimmed to one line, empty when absent. */
export function parseWindowTitle(value: unknown, field = "title"): Result<string> {
  if (value === undefined || value === null) return ok("");
  if (typeof value !== "string") return problem(field, "Enter the title as text");
  const title = singleLine(value);
  if (title.length > maximumWindowTitleLength) return problem(field, `Titles are at most ${maximumWindowTitleLength} characters`);
  return ok(title);
}

function parseTimes(value: Record<string, unknown>): Result<{ startTime: string; endTime: string }> {
  if (!isLocalTime(value.startTime)) return problem("startTime", "Enter the start time as HH:MM");
  if (!isLocalTime(value.endTime)) return problem("endTime", "Enter the end time as HH:MM");
  if (minutesOfDay(value.endTime) <= minutesOfDay(value.startTime)) return problem("endTime", "The end time must be after the start time on the same day");
  return ok({ startTime: value.startTime, endTime: value.endTime });
}

/** Bit n set for weekday n. */
export function weekdayMask(weekdays: readonly number[]): number {
  return weekdays.reduce((mask, weekday) => mask | (1 << weekday), 0);
}

/** Weekdays (0 is Sunday) whose bit is set, in order. */
export function weekdaysFromMask(mask: number): number[] {
  return [0, 1, 2, 3, 4, 5, 6].filter((weekday) => (mask & (1 << weekday)) !== 0);
}

/** Validate a request body for a repeating series: weekdays, startTime, endTime, firstDate, lastDate and optional title. */
export function parseSeriesInput(value: unknown): Result<SeriesDefinition> {
  if (!isRecord(value)) return problem("", "Send the series as a JSON object");
  const unexpected = unexpectedField(value, ["weekdays", "startTime", "endTime", "firstDate", "lastDate", "title"]);
  if (unexpected) return problem(unexpected, `Unexpected field ${unexpected}`);
  const { weekdays } = value;
  if (!Array.isArray(weekdays) || !weekdays.length) return problem("weekdays", "Choose at least one weekday");
  if (weekdays.some((weekday) => !Number.isInteger(weekday) || weekday < 0 || weekday > 6)) return problem("weekdays", "Weekdays are numbers from 0 (Sunday) to 6 (Saturday)");
  const times = parseTimes(value);
  if (!times.ok) return times;
  if (!isLocalDate(value.firstDate)) return problem("firstDate", "Enter the first date as YYYY-MM-DD");
  if (!isLocalDate(value.lastDate)) return problem("lastDate", "Enter the last date as YYYY-MM-DD");
  const span = daysBetween(value.firstDate, value.lastDate);
  if (span < 0) return problem("lastDate", "The last date must be on or after the first date");
  if (span + 1 > maximumSeriesDates) return problem("lastDate", `A repeating window covers at most ${maximumSeriesDates} days`);
  const title = parseWindowTitle(value.title);
  if (!title.ok) return title;
  const series: SeriesDefinition = {
    weekdays: [...new Set(weekdays as number[])].sort((left, right) => left - right),
    ...times.value, firstDate: value.firstDate, lastDate: value.lastDate, title: title.value,
  };
  if (!seriesDates(series).length) return problem("weekdays", "None of the chosen weekdays falls between the first and last date");
  return ok(series);
}

/** The local dates a series covers, in order. */
export function seriesDates(series: Pick<SeriesDefinition, "weekdays" | "firstDate" | "lastDate">): string[] {
  const dates: string[] = [];
  const span = daysBetween(series.firstDate, series.lastDate);
  for (let offset = 0; offset <= span; offset++) {
    const date = addDays(series.firstDate, offset);
    if (series.weekdays.includes(weekdayOf(date))) dates.push(date);
  }
  return dates;
}

/**
 * The dated windows a series names, in order. A date whose whole window falls in a skipped daylight saving hour has no
 * instants left and is listed in `skippedDates` instead.
 */
export function expandSeries(civil: CivilTime, timeZone: string, series: SeriesDefinition): { readonly windows: DatedWindow[]; readonly skippedDates: string[] } {
  const windows: DatedWindow[] = [];
  const skippedDates: string[] = [];
  for (const date of seriesDates(series)) {
    const range = localRange(civil, timeZone, date, series.startTime, series.endTime);
    if (range.endMs > range.startMs) windows.push({ date, ...range, title: series.title });
    else skippedDates.push(date);
  }
  return { windows, skippedDates };
}

/** Validate a request body for a one-off window, or new times for one window: date, startTime, endTime, optional title. */
export function parseWindowInput(value: unknown): Result<WindowDefinition> {
  if (!isRecord(value)) return problem("", "Send the window as a JSON object");
  const unexpected = unexpectedField(value, ["date", "startTime", "endTime", "title"]);
  if (unexpected) return problem(unexpected, `Unexpected field ${unexpected}`);
  if (!isLocalDate(value.date)) return problem("date", "Enter the date as YYYY-MM-DD");
  const times = parseTimes(value);
  if (!times.ok) return times;
  const title = parseWindowTitle(value.title);
  if (!title.ok) return title;
  return ok({ date: value.date, ...times.value, title: title.value });
}

/** Resolve a window definition to instants. Refused when the whole window falls in a skipped daylight saving hour. */
export function resolveWindow(civil: CivilTime, timeZone: string, window: WindowDefinition): Result<DatedWindow> {
  const range = localRange(civil, timeZone, window.date, window.startTime, window.endTime);
  if (range.endMs <= range.startMs) return problem("startTime", "These times do not exist on that date because the clocks change");
  return ok({ date: window.date, ...range, title: window.title });
}

/** Validate a cancellation reason, which guests see beside the canceled window. */
export function parseCancelReason(value: unknown): Result<string> {
  if (typeof value !== "string") return problem("reason", "Enter the reason guests will see, for example Thanksgiving");
  const reason = singleLine(value);
  if (!reason) return problem("reason", "Enter the reason guests will see, for example Thanksgiving");
  if (reason.length > maximumCancelReasonLength) return problem("reason", `Reasons are at most ${maximumCancelReasonLength} characters`);
  return ok(reason);
}

/** A window to be saved: a new one, or new times for the stored window `id`. */
export type ProposedWindow = TimeRange & { readonly id?: string };
/** A proposed window (by index) that overlaps a stored window or another proposed window. */
export type WindowConflict = { readonly proposed: number; readonly existingId?: string; readonly otherProposed?: number };

/**
 * Overlaps between proposed windows and the stored ones they would sit beside, and among the proposed windows. Removed
 * windows never conflict; canceled windows do, since they stay listed and can be restored. A stored window is left out
 * when a proposed window replaces it (same `id`) or when it is in `ignoreIds` (for example windows the same save removes).
 */
export function findWindowConflicts(proposed: readonly ProposedWindow[], existing: readonly StoredWindow[], ignoreIds: Iterable<string> = []): WindowConflict[] {
  const ignored = new Set(ignoreIds);
  for (const window of proposed) if (window.id) ignored.add(window.id);
  const others = existing.filter((window) => window.status !== "removed" && !ignored.has(window.id));
  const conflicts: WindowConflict[] = [];
  proposed.forEach((window, index) => {
    for (const other of others) if (rangesOverlap(window, other)) conflicts.push({ proposed: index, existingId: other.id });
    for (let later = index + 1; later < proposed.length; later++) if (rangesOverlap(window, proposed[later]!)) conflicts.push({ proposed: index, otherProposed: later });
  });
  return conflicts;
}

/** What saving a series does to its windows. */
export type SeriesWindowPlan = {
  /** New windows, for dates the series covers that have no window yet. */
  readonly insert: readonly DatedWindow[];
  /** Replaceable windows that take the series' new times or title. */
  readonly update: readonly (DatedWindow & { readonly id: string })[];
  /** Replaceable windows the series no longer covers. Delete those without visits and mark the others removed. */
  readonly remove: readonly string[];
  /** Replaceable windows that already match. */
  readonly unchanged: readonly string[];
  /** Windows of the series left exactly as they are: started, edited on their own or canceled. */
  readonly kept: readonly string[];
};

/** Whether a series save may change this window: an open window of the series, not edited on its own, not yet started. */
export function isReplaceable(window: StoredWindow, seriesId: string, now: number): boolean {
  return window.seriesId === seriesId && !window.edited && window.status === "open" && window.startMs > now;
}

/**
 * Plan a series save (creation, edit or deletion with an empty expansion). Only windows that have not started are
 * created or replaced. A date that already has a window of the series which the save may not change (started, edited on
 * its own or canceled) keeps that window and gets no new one, so a canceled Thanksgiving window stays canceled.
 * Replaceable windows are matched to the new expansion by local date, keeping their IDs and so their visits.
 * Check the result with `findSeriesPlanConflicts` before saving.
 */
export function planSeriesWindows(input: {
  readonly civil: CivilTime;
  readonly timeZone: string;
  readonly seriesId: string;
  readonly existing: readonly StoredWindow[];
  readonly expansion: readonly DatedWindow[];
  readonly now: number;
}): SeriesWindowPlan {
  const own = input.existing.filter((window) => window.seriesId === input.seriesId && window.status !== "removed");
  const replaceableByDate = new Map<string, StoredWindow[]>();
  const coveredDates = new Set<string>();
  const kept: string[] = [];
  for (const window of own) {
    const date = localMoment(input.civil, input.timeZone, window.startMs).date;
    if (isReplaceable(window, input.seriesId, input.now)) replaceableByDate.set(date, [...(replaceableByDate.get(date) ?? []), window]);
    else { coveredDates.add(date); kept.push(window.id); }
  }
  const insert: DatedWindow[] = [];
  const update: (DatedWindow & { id: string })[] = [];
  const unchanged: string[] = [];
  const matched = new Set<string>();
  for (const window of input.expansion) {
    if (window.startMs <= input.now) continue;
    const current = replaceableByDate.get(window.date)?.find((candidate) => !matched.has(candidate.id));
    if (current) {
      matched.add(current.id);
      if (current.startMs === window.startMs && current.endMs === window.endMs && current.title === window.title) unchanged.push(current.id);
      else update.push({ ...window, id: current.id });
    } else if (!coveredDates.has(window.date)) insert.push(window);
  }
  const remove = [...replaceableByDate.values()].flat().filter((window) => !matched.has(window.id)).map((window) => window.id);
  return { insert, update, remove, unchanged, kept };
}

/** Overlaps the plan would create with every other stored window, or among its own windows. */
export function findSeriesPlanConflicts(plan: SeriesWindowPlan, existing: readonly StoredWindow[]): WindowConflict[] {
  return findWindowConflicts([...plan.update, ...plan.insert], existing, plan.remove);
}
