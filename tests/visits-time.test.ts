import test from "node:test";
import assert from "node:assert/strict";
import { at, civil, newYork } from "./helpers/civil-time.ts";
import {
  addDays, daysBetween, formatDate, formatShortDate, formatTime, isLocalDate, isLocalTime, localInstant, localMoment, localRange, minutesOfDay,
  multiLine, rangeContains, rangesOverlap, singleLine, weekdayOf,
} from "../src/shared/visits-time.ts";

const iso = (ms: number) => new Date(ms).toISOString();

test("the Intl stand-in resolves local times like the SDK: none in a gap, two in a repeated hour", () => {
  assert.deepEqual(civil.resolveCivilTime({ date: "2026-07-01", time: "12:00", timeZone: newYork }), [{ epochMilliseconds: at("2026-07-01T16:00:00Z"), offsetSeconds: -14400 }]);
  assert.deepEqual(civil.resolveCivilTime({ date: "2026-03-08", time: "02:30", timeZone: newYork }), []);
  assert.deepEqual(civil.resolveCivilTime({ date: "2026-11-01", time: "01:30", timeZone: newYork }).map((candidate) => iso(candidate.epochMilliseconds)), ["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]);
  assert.deepEqual(civil.instantToCivil(at("2026-11-01T06:30:00Z"), newYork), { date: "2026-11-01", time: "01:30:00.000", offsetSeconds: -18000 });
  assert.deepEqual(civil.instantToCivil(at("2026-11-02T23:00:00Z"), "UTC"), { date: "2026-11-02", time: "23:00:00.000", offsetSeconds: 0 });
});

test("calendar dates and times are validated and counted without a time zone", () => {
  for (const date of ["2026-11-02", "2028-02-29", "2000-01-01", "2999-12-31"]) assert.ok(isLocalDate(date), date);
  for (const date of ["2026-02-29", "2026-13-01", "2026-11-2", "26-11-02", "1999-12-31", "3000-01-01", "", 20261102, null]) assert.ok(!isLocalDate(date), String(date));
  for (const time of ["00:00", "09:05", "23:59"]) assert.ok(isLocalTime(time), time);
  for (const time of ["24:00", "9:05", "12:60", "12:00:00", "noon", 1200]) assert.ok(!isLocalTime(time), String(time));
  assert.equal(minutesOfDay("18:30"), 1110);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(daysBetween("2026-11-02", "2026-12-18"), 46);
  assert.equal(weekdayOf("2026-11-02"), 1);
  assert.equal(weekdayOf("2026-11-01"), 0);
  assert.equal(weekdayOf("2026-11-07"), 6);
});

test("skipped local times move to the moment the clock jumps to", () => {
  // 2026-03-08 America/New_York: 02:00 EST jumps to 03:00 EDT (07:00Z).
  assert.equal(iso(localInstant(civil, newYork, "2026-03-08", "02:00", "start")), "2026-03-08T07:00:00.000Z");
  assert.equal(iso(localInstant(civil, newYork, "2026-03-08", "02:30", "start")), "2026-03-08T07:00:00.000Z");
  assert.equal(iso(localInstant(civil, newYork, "2026-03-08", "02:59", "end")), "2026-03-08T07:00:00.000Z");
  assert.equal(iso(localInstant(civil, newYork, "2026-03-08", "01:59", "start")), "2026-03-08T06:59:00.000Z");
  assert.equal(iso(localInstant(civil, newYork, "2026-03-08", "03:00", "start")), "2026-03-08T07:00:00.000Z");
  // Lord Howe Island skips half an hour.
  assert.equal(iso(localInstant(civil, "Australia/Lord_Howe", "2026-10-04", "02:15", "start")), "2026-10-03T15:30:00.000Z");
});

test("repeated local times take the earlier occurrence for starts and the later for ends", () => {
  // 2026-11-01 America/New_York: 01:00 to 01:59 happens in EDT, then again in EST.
  assert.equal(iso(localInstant(civil, newYork, "2026-11-01", "01:30", "start")), "2026-11-01T05:30:00.000Z");
  assert.equal(iso(localInstant(civil, newYork, "2026-11-01", "01:30", "end")), "2026-11-01T06:30:00.000Z");
  const range = localRange(civil, newYork, "2026-11-01", "01:00", "01:30");
  assert.equal(range.endMs - range.startMs, 90 * 60_000, "covers both readings of 01:00 to 01:30");
  const day = localRange(civil, newYork, "2026-11-01", "00:00", "23:59");
  assert.equal(day.endMs - day.startMs, 25 * 3_600_000 - 60_000);
});

test("local order is kept as instant order across both transitions", () => {
  for (const date of ["2026-03-08", "2026-11-01"]) {
    let previousStart = -Infinity;
    let previousEnd = -Infinity;
    for (let minutes = 0; minutes < 24 * 60; minutes += 5) {
      const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
      const start = localInstant(civil, newYork, date, time, "start");
      const end = localInstant(civil, newYork, date, time, "end");
      assert.ok(start >= previousStart && end >= previousEnd && end >= start, `${date} ${time}`);
      assert.equal(start % 60_000, 0);
      previousStart = start; previousEnd = end;
    }
  }
});

test("instants read back as local date, time and weekday", () => {
  assert.deepEqual(localMoment(civil, newYork, at("2026-11-03T01:30:00Z")), { date: "2026-11-02", time: "20:30", weekday: 1 });
  assert.deepEqual(localMoment(civil, "Pacific/Auckland", at("2026-11-02T12:00:00Z")), { date: "2026-11-03", time: "01:00", weekday: 2 });
});

test("ranges overlap only when they share time", () => {
  const range = { startMs: 10, endMs: 20 };
  assert.ok(rangesOverlap(range, { startMs: 15, endMs: 25 }));
  assert.ok(rangesOverlap(range, { startMs: 0, endMs: 30 }));
  assert.ok(!rangesOverlap(range, { startMs: 20, endMs: 30 }));
  assert.ok(!rangesOverlap(range, { startMs: 0, endMs: 10 }));
  assert.ok(rangeContains(range, { startMs: 10, endMs: 20 }));
  assert.ok(!rangeContains(range, { startMs: 9, endMs: 20 }));
});

test("dates and times read plainly", () => {
  assert.equal(formatDate("2026-11-02"), "Monday, November 2, 2026");
  assert.equal(formatShortDate("2026-12-25"), "Friday, December 25");
  assert.deepEqual(["00:00", "00:30", "09:05", "12:00", "12:30", "18:00", "23:59"].map(formatTime), ["12:00 AM", "12:30 AM", "9:05 AM", "12:00 PM", "12:30 PM", "6:00 PM", "11:59 PM"]);
});

test("text is cleaned to one line or to tidy lines", () => {
  const separator = String.fromCharCode(0x2028);
  assert.equal(singleLine(`  Team\t\n Rocket${separator}Power\u0007 `), "Team Rocket Power");
  assert.equal(multiLine(" First  line \r\n\r\n\r\n\r\nSecond\tline\u0000 "), "First line\n\nSecond line");
});
