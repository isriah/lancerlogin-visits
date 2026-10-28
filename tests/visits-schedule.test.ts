import test from "node:test";
import assert from "node:assert/strict";
import { at, civil, newYork } from "./helpers/civil-time.ts";
import {
  expandSeries, findSeriesPlanConflicts, findWindowConflicts, isReplaceable, maximumSeriesDates, parseCancelReason, parseSeriesInput, parseWindowInput,
  planSeriesWindows, resolveWindow, seriesDates, weekdayMask, weekdaysFromMask, type DatedWindow, type SeriesDefinition, type StoredWindow,
} from "../src/shared/visits-schedule.ts";

const iso = (ms: number) => new Date(ms).toISOString();
const mondaysAndWednesdays = { weekdays: [3, 1, 3], startTime: "18:00", endTime: "21:00", firstDate: "2026-11-02", lastDate: "2026-12-18", title: "  Open   shop " };

function series(input: Record<string, unknown> = {}): SeriesDefinition {
  const result = parseSeriesInput({ ...mondaysAndWednesdays, ...input });
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

function error(value: unknown, parse: (value: unknown) => { ok: boolean }) {
  const result = parse(value) as { ok: false; field: string; error: string };
  assert.equal(result.ok, false, JSON.stringify(value));
  return result;
}

const stored = (window: DatedWindow, id: string, extra: Partial<StoredWindow> = {}): StoredWindow => ({
  id, seriesId: "series-1", startMs: window.startMs, endMs: window.endMs, title: window.title, status: "open", edited: false, ...extra,
});

test("a repeating series is validated, normalized and limited to 366 days", () => {
  assert.deepEqual(series(), { weekdays: [1, 3], startTime: "18:00", endTime: "21:00", firstDate: "2026-11-02", lastDate: "2026-12-18", title: "Open shop" });
  assert.equal(series({ title: undefined }).title, "");
  assert.equal(series({ firstDate: "2026-01-01", lastDate: "2027-01-01" }).lastDate, "2027-01-01", `${maximumSeriesDates} dates`);
  const cases: [Record<string, unknown>, string][] = [
    [{ weekdays: [] }, "weekdays"], [{ weekdays: [7] }, "weekdays"], [{ weekdays: [1.5] }, "weekdays"], [{ weekdays: "1,3" }, "weekdays"],
    [{ startTime: "6 PM" }, "startTime"], [{ endTime: "18:00" }, "endTime"], [{ endTime: "17:00" }, "endTime"],
    [{ firstDate: "2026-02-30" }, "firstDate"], [{ lastDate: "2026-11-01" }, "lastDate"], [{ firstDate: "2026-01-01", lastDate: "2027-01-02" }, "lastDate"],
    [{ title: "x".repeat(81) }, "title"], [{ title: 5 }, "title"], [{ weekdays: [6], lastDate: "2026-11-06" }, "weekdays"], [{ color: "red" }, "color"],
  ];
  for (const [input, field] of cases) assert.equal(error({ ...mondaysAndWednesdays, ...input }, parseSeriesInput).field, field, JSON.stringify(input));
  assert.equal(error(null, parseSeriesInput).field, "");
  assert.equal(error([], parseSeriesInput).field, "");
});

test("weekday sets round-trip through the stored mask", () => {
  assert.equal(weekdayMask([1, 3]), 0b1010);
  assert.deepEqual(weekdaysFromMask(0b1010), [1, 3]);
  assert.deepEqual(weekdaysFromMask(weekdayMask([0, 1, 2, 3, 4, 5, 6])), [0, 1, 2, 3, 4, 5, 6]);
});

test("a series expands into dated windows in the installation time zone", () => {
  const { windows, skippedDates } = expandSeries(civil, newYork, series());
  assert.deepEqual(skippedDates, []);
  assert.deepEqual(windows.map((window) => window.date), ["2026-11-02", "2026-11-04", "2026-11-09", "2026-11-11", "2026-11-16", "2026-11-18", "2026-11-23", "2026-11-25", "2026-11-30", "2026-12-02", "2026-12-07", "2026-12-09", "2026-12-14", "2026-12-16"]);
  assert.deepEqual(windows[0], { date: "2026-11-02", startMs: at("2026-11-02T23:00:00Z"), endMs: at("2026-11-03T02:00:00Z"), title: "Open shop" });
  // The same local hours before the clocks fall back are an hour earlier in UTC.
  const october = expandSeries(civil, newYork, series({ firstDate: "2026-10-26", lastDate: "2026-10-26" })).windows;
  assert.deepEqual(october.map((window) => [iso(window.startMs), iso(window.endMs)]), [["2026-10-26T22:00:00.000Z", "2026-10-27T01:00:00.000Z"]]);
});

test("series windows across daylight saving changes follow the documented policy", () => {
  // Sundays 00:30 to 02:30 around the fall-back night: 02:30 EST ends a 3-hour window on 2026-11-01.
  const fallBack = expandSeries(civil, newYork, series({ weekdays: [0], startTime: "00:30", endTime: "02:30", firstDate: "2026-10-25", lastDate: "2026-11-08" })).windows;
  assert.deepEqual(fallBack.map((window) => (window.endMs - window.startMs) / 3_600_000), [2, 3, 2]);
  assert.equal(iso(fallBack[1]!.startMs), "2026-11-01T04:30:00.000Z");
  // Sundays 01:30 to 03:30 around the spring-forward night: 01:30 EST to 03:30 EDT is one hour on 2026-03-08.
  const springForward = expandSeries(civil, newYork, series({ weekdays: [0], startTime: "01:30", endTime: "03:30", firstDate: "2026-03-01", lastDate: "2026-03-15" })).windows;
  assert.deepEqual(springForward.map((window) => (window.endMs - window.startMs) / 3_600_000), [2, 1, 2]);
  // A window entirely inside the skipped hour has no time left that day.
  const skipped = expandSeries(civil, newYork, series({ weekdays: [0], startTime: "02:00", endTime: "02:45", firstDate: "2026-03-01", lastDate: "2026-03-15" }));
  assert.deepEqual(skipped.skippedDates, ["2026-03-08"]);
  assert.deepEqual(skipped.windows.map((window) => window.date), ["2026-03-01", "2026-03-15"]);
  // A window that starts in the skipped hour starts when the clock jumps.
  const late = expandSeries(civil, newYork, series({ weekdays: [0], startTime: "02:30", endTime: "04:00", firstDate: "2026-03-08", lastDate: "2026-03-08" })).windows;
  assert.deepEqual(late.map((window) => [iso(window.startMs), iso(window.endMs)]), [["2026-03-08T07:00:00.000Z", "2026-03-08T08:00:00.000Z"]]);
});

test("seriesDates lists only the chosen weekdays", () => {
  assert.deepEqual(seriesDates({ weekdays: [6], firstDate: "2026-11-01", lastDate: "2026-11-30" }), ["2026-11-07", "2026-11-14", "2026-11-21", "2026-11-28"]);
});

test("one-off windows are validated and resolved", () => {
  const input = parseWindowInput({ date: "2026-11-07", startTime: "10:00", endTime: "14:00", title: "Saturday build" });
  assert.ok(input.ok);
  const window = resolveWindow(civil, newYork, input.value);
  assert.deepEqual(window, { ok: true, value: { date: "2026-11-07", startMs: at("2026-11-07T15:00:00Z"), endMs: at("2026-11-07T19:00:00Z"), title: "Saturday build" } });
  for (const [value, field] of [[{ date: "2026-11-07", startTime: "10:00", endTime: "10:00" }, "endTime"], [{ date: "Saturday", startTime: "10:00", endTime: "14:00" }, "date"], [{ date: "2026-11-07", startTime: "10:00", endTime: "14:00", seriesId: "x" }, "seriesId"]] as const) {
    assert.equal(error(value, parseWindowInput).field, field);
  }
  const gap = parseWindowInput({ date: "2026-03-08", startTime: "02:05", endTime: "02:55" });
  assert.ok(gap.ok);
  assert.equal(error(gap.value, (value) => resolveWindow(civil, newYork, value as never)).field, "startTime");
});

test("cancel reasons are required, one line and short", () => {
  assert.deepEqual(parseCancelReason("  Thanksgiving\n break "), { ok: true, value: "Thanksgiving break" });
  for (const value of ["", "   ", undefined, 4, "x".repeat(201)]) assert.equal(error(value, parseCancelReason).field, "reason");
});

test("windows conflict when they share time with a stored or proposed window", () => {
  const existing: StoredWindow[] = [
    { id: "open", seriesId: null, startMs: 100, endMs: 200, title: "", status: "open", edited: false },
    { id: "canceled", seriesId: null, startMs: 300, endMs: 400, title: "", status: "canceled", edited: false },
    { id: "removed", seriesId: null, startMs: 500, endMs: 600, title: "", status: "removed", edited: false },
  ];
  assert.deepEqual(findWindowConflicts([{ startMs: 150, endMs: 250 }], existing), [{ proposed: 0, existingId: "open" }]);
  assert.deepEqual(findWindowConflicts([{ startMs: 350, endMs: 360 }], existing), [{ proposed: 0, existingId: "canceled" }]);
  assert.deepEqual(findWindowConflicts([{ startMs: 500, endMs: 600 }, { startMs: 200, endMs: 300 }], existing), [], "removed windows and touching ends are fine");
  assert.deepEqual(findWindowConflicts([{ id: "open", startMs: 120, endMs: 220 }], existing), [], "a window may move within its own time");
  assert.deepEqual(findWindowConflicts([{ startMs: 150, endMs: 250 }], existing, ["open"]), []);
  assert.deepEqual(findWindowConflicts([{ startMs: 700, endMs: 800 }, { startMs: 750, endMs: 900 }], existing), [{ proposed: 0, otherProposed: 1 }]);
});

test("a new series creates only windows that have not started", () => {
  const { windows } = expandSeries(civil, newYork, series());
  const plan = planSeriesWindows({ civil, timeZone: newYork, seriesId: "series-1", existing: [], expansion: windows, now: at("2026-11-04T23:30:00Z") });
  assert.deepEqual(plan.insert.map((window) => window.date), windows.slice(2).map((window) => window.date), "Nov 2 has passed and Nov 4 has started");
  assert.deepEqual([plan.update, plan.remove, plan.unchanged, plan.kept], [[], [], [], []]);
});

test("a series edit replaces only future windows not edited on their own", () => {
  const original = expandSeries(civil, newYork, series()).windows;
  const ids = original.map((window) => `w-${window.date}`);
  const existing: StoredWindow[] = original.map((window, index) => stored(window, ids[index]!));
  existing[7] = { ...existing[7]!, status: "canceled" }; // Wednesday 2026-11-25, canceled for Thanksgiving
  existing[8] = { ...existing[8]!, edited: true, startMs: existing[8]!.startMs + 3_600_000 }; // Monday 2026-11-30, moved on its own
  existing.push({ id: "one-off", seriesId: null, startMs: at("2026-11-06T22:00:00Z"), endMs: at("2026-11-07T01:00:00Z"), title: "Friday build", status: "open", edited: false });
  existing.push({ id: "other-series", seriesId: "series-2", startMs: at("2026-11-13T22:00:00Z"), endMs: at("2026-11-14T01:00:00Z"), title: "", status: "open", edited: false });
  const now = at("2026-11-05T12:00:00Z");
  assert.ok(!isReplaceable(existing[0]!, "series-1", now) && isReplaceable(existing[2]!, "series-1", now));

  // New times 17:00 to 20:00, Fridays added, and the series ends a week earlier.
  const edited = expandSeries(civil, newYork, series({ weekdays: [1, 3, 5], startTime: "17:00", endTime: "20:00", lastDate: "2026-12-11" })).windows;
  const plan = planSeriesWindows({ civil, timeZone: newYork, seriesId: "series-1", existing, expansion: edited, now });
  assert.deepEqual(plan.kept, ["w-2026-11-02", "w-2026-11-04", "w-2026-11-25", "w-2026-11-30"]);
  assert.deepEqual(plan.update.map((window) => window.id), ["w-2026-11-09", "w-2026-11-11", "w-2026-11-16", "w-2026-11-18", "w-2026-11-23", "w-2026-12-02", "w-2026-12-07", "w-2026-12-09"]);
  assert.equal(iso(plan.update[0]!.startMs), "2026-11-09T22:00:00.000Z");
  assert.deepEqual(plan.remove, ["w-2026-12-14", "w-2026-12-16"]);
  assert.deepEqual(plan.insert.map((window) => window.date), ["2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27", "2026-12-04", "2026-12-11"]);
  assert.deepEqual(plan.unchanged, []);
  // The new Friday windows run into the one-off and the other series' window.
  assert.deepEqual(findSeriesPlanConflicts(plan, existing).map((conflict) => conflict.existingId), ["one-off", "other-series"]);
});

test("saving a series unchanged changes nothing, and a title-only edit updates every replaceable window", () => {
  const windows = expandSeries(civil, newYork, series()).windows;
  const existing = windows.map((window) => stored(window, `w-${window.date}`));
  const now = at("2026-11-01T00:00:00Z");
  const same = planSeriesWindows({ civil, timeZone: newYork, seriesId: "series-1", existing, expansion: windows, now });
  assert.equal(same.unchanged.length, windows.length);
  assert.deepEqual([same.insert, same.update, same.remove], [[], [], []]);
  const renamed = planSeriesWindows({ civil, timeZone: newYork, seriesId: "series-1", existing, expansion: expandSeries(civil, newYork, series({ title: "Build night" })).windows, now });
  assert.equal(renamed.update.length, windows.length);
  assert.ok(renamed.update.every((window) => window.title === "Build night"));
  assert.deepEqual(findSeriesPlanConflicts(renamed, existing), []);
});

test("deleting a series removes its future replaceable windows and keeps the rest", () => {
  const windows = expandSeries(civil, newYork, series()).windows;
  const existing = windows.map((window) => stored(window, `w-${window.date}`));
  existing[3] = { ...existing[3]!, status: "removed" };
  const plan = planSeriesWindows({ civil, timeZone: newYork, seriesId: "series-1", existing, expansion: [], now: at("2026-12-10T00:00:00Z") });
  assert.deepEqual(plan.remove, ["w-2026-12-14", "w-2026-12-16"]);
  assert.equal(plan.kept.length, windows.length - 3, "started windows stay; the removed one is ignored");
});
