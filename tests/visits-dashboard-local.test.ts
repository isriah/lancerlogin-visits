import test from "node:test";
import assert from "node:assert/strict";
import { at, newYork } from "./helpers/civil-time.ts";
import {
  arrivalChoices, compactTime, defaultDeparture, departureChoices, formatCompactDate, formatInstant, formatTimeRange, formatVisitWhen, groupByDate, groupRangesByDate,
  localReading, localSpan, monthGridRange, peopleText, teamCountText, timeSteps, todayIn, visitCountText, weekdayListText,
} from "../src/dashboard/visits-local.ts";

test("instants read as local dates and times in the installation time zone", () => {
  assert.deepEqual(localReading(at("2026-11-02T23:00:00Z"), newYork), { date: "2026-11-02", time: "18:00" });
  assert.deepEqual(localReading(at("2026-11-03T04:30:00Z"), newYork), { date: "2026-11-02", time: "23:30" });
  assert.deepEqual(localReading(at("2026-11-03T05:00:00Z"), newYork), { date: "2026-11-03", time: "00:00" });
  assert.deepEqual(localReading(at("2026-07-01T16:00:00Z"), "UTC"), { date: "2026-07-01", time: "16:00" });
  assert.equal(todayIn(newYork, at("2026-11-03T03:00:00Z")), "2026-11-02", "evening in New York is still the earlier date");
});

test("both readings of a repeated hour keep their local time", () => {
  assert.deepEqual(localReading(at("2026-11-01T05:30:00Z"), newYork), { date: "2026-11-01", time: "01:30" });
  assert.deepEqual(localReading(at("2026-11-01T06:30:00Z"), newYork), { date: "2026-11-01", time: "01:30" });
});

test("a window reads as its local date with start and end times", () => {
  assert.deepEqual(localSpan({ startMs: at("2026-11-02T23:00:00Z"), endMs: at("2026-11-03T02:00:00Z") }, newYork), { date: "2026-11-02", startTime: "18:00", endTime: "21:00" });
  assert.deepEqual(localSpan({ startMs: at("2026-11-03T03:00:00Z"), endMs: at("2026-11-03T05:00:00Z") }, newYork), { date: "2026-11-02", startTime: "22:00", endTime: "23:59" }, "a window ending at midnight stays on its date");
});

test("times and dates format for people", () => {
  assert.equal(formatTimeRange("18:00", "21:30"), "6:00 PM to 9:30 PM");
  assert.equal(compactTime("18:00"), "6 PM");
  assert.equal(compactTime("18:30"), "6:30 PM");
  assert.equal(compactTime("00:00"), "12 AM");
  assert.equal(formatVisitWhen("2026-11-02", "18:00", "20:00"), "Monday, November 2, 6:00 PM to 8:00 PM");
  assert.equal(formatInstant(at("2026-11-02T23:15:00Z"), newYork), "Monday, November 2, 6:15 PM");
  assert.equal(formatCompactDate("2026-12-18"), "Dec 18, 2026");
  assert.equal(weekdayListText([3, 1]), "Mondays and Wednesdays");
  assert.equal(weekdayListText([5, 1, 3, 1]), "Mondays, Wednesdays and Fridays");
  assert.equal(weekdayListText([6]), "Saturdays");
  assert.equal(weekdayListText([]), "");
  assert.equal(peopleText(1), "1 person");
  assert.equal(peopleText(12), "12 people");
  assert.equal(teamCountText(0), "No teams yet");
  assert.equal(teamCountText(1), "1 team coming");
  assert.equal(teamCountText(3), "3 teams coming");
  assert.equal(visitCountText(1), "1 visit");
  assert.equal(visitCountText(0), "0 visits");
});

test("items group by date in date order and keep their order within a date", () => {
  const items = [{ id: "b", date: "2026-11-04" }, { id: "a", date: "2026-11-02" }, { id: "c", date: "2026-11-04" }];
  assert.deepEqual(groupByDate(items, (item) => item.date).map((group) => [group.date, group.items.map((item) => item.id)]), [["2026-11-02", ["a"]], ["2026-11-04", ["b", "c"]]]);
  assert.deepEqual(groupByDate([], () => ""), []);
});

test("guest page windows group by their local date, in start order", () => {
  const windows = [
    { id: "late", startMs: at("2026-11-04T23:00:00Z"), endMs: at("2026-11-05T02:00:00Z") },
    { id: "morning", startMs: at("2026-11-07T14:00:00Z"), endMs: at("2026-11-07T17:00:00Z") },
    { id: "evening", startMs: at("2026-11-07T23:00:00Z"), endMs: at("2026-11-08T01:00:00Z") },
  ];
  const days = groupRangesByDate([windows[2]!, windows[0]!, windows[1]!], newYork);
  assert.deepEqual(days.map((day) => [day.date, day.items.map((item) => `${item.id} ${item.local.startTime}-${item.local.endTime}`)]), [
    ["2026-11-04", ["late 18:00-21:00"]],
    ["2026-11-07", ["morning 09:00-12:00", "evening 18:00-20:00"]],
  ]);
});

test("the month grid runs from the Sunday before the first to the Saturday after the last day", () => {
  assert.deepEqual(monthGridRange("2026-11-15", 0), { from: "2026-11-01", to: "2026-12-05", month: "2026-11" });
  assert.deepEqual(monthGridRange("2026-11-15", 1), { from: "2026-11-29", to: "2027-01-02", month: "2026-12" });
  assert.deepEqual(monthGridRange("2026-11-15", -11), { from: "2025-11-30", to: "2026-01-03", month: "2025-12" });
  assert.deepEqual(monthGridRange("2027-01-31", -1), { from: "2026-11-29", to: "2027-01-02", month: "2026-12" });
  assert.deepEqual(monthGridRange("2026-02-10", 0), { from: "2026-02-01", to: "2026-02-28", month: "2026-02" });
  assert.throws(() => monthGridRange("2026-2-10", 0), /Not a local date/);
});

test("time steps cover a window on quarter hours, with its own start and end", () => {
  assert.deepEqual(timeSteps("18:00", "19:00"), ["18:00", "18:15", "18:30", "18:45", "19:00"]);
  assert.deepEqual(timeSteps("18:10", "19:00"), ["18:10", "18:15", "18:30", "18:45", "19:00"]);
  assert.deepEqual(timeSteps("18:00", "18:20"), ["18:00", "18:15", "18:20"]);
  assert.deepEqual(timeSteps("18:00", "18:00"), ["18:00"]);
  assert.deepEqual(timeSteps("19:00", "18:00"), []);
  assert.deepEqual(timeSteps("6pm", "9pm"), []);
  assert.deepEqual(timeSteps("09:00", "10:00", 30), ["09:00", "09:30", "10:00"]);
});

test("arrival and departure choices stay inside the window and in order", () => {
  const window = { startTime: "18:00", endTime: "19:00" };
  assert.deepEqual(arrivalChoices(window), ["18:00", "18:15", "18:30", "18:45"]);
  assert.deepEqual(arrivalChoices(window, "18:20"), ["18:30", "18:45"], "arrivals already past are dropped");
  assert.deepEqual(arrivalChoices(window, "18:30"), ["18:45"]);
  assert.deepEqual(departureChoices(window, "18:30"), ["18:45", "19:00"]);
  assert.deepEqual(departureChoices(window, ""), ["18:15", "18:30", "18:45", "19:00"]);
  assert.deepEqual(departureChoices(window, "19:00"), []);
});

test("the suggested departure is an hour after arrival when the window allows, else its end", () => {
  const window = { startTime: "18:00", endTime: "21:00" };
  assert.equal(defaultDeparture(window, "18:00"), "19:00");
  assert.equal(defaultDeparture(window, "20:30"), "21:00");
  assert.equal(defaultDeparture({ startTime: "18:10", endTime: "21:00" }, "18:10"), "19:15", "the first quarter hour at least an hour later");
  assert.equal(defaultDeparture(window, ""), "21:00");
  assert.equal(defaultDeparture(window, "21:00"), "");
});
