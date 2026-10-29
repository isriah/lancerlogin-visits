import test from "node:test";
import assert from "node:assert/strict";
import { at, newYork } from "./helpers/civil-time.ts";
import {
  arrivalChoices, compactTime, defaultDeparture, departureChoices, formatCompactDate, formatInstant, formatTimeRange, formatVisitWhen, groupByDate, groupRangesByDate,
  formatMonth, guestDays, guestDayText, guestMonths, localReading, localSpan, monthCells, monthGridRange, monthsBetween, peopleText, teamCountText, timeSteps, todayIn,
  visitCountText, weekdayListText,
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

test("guest calendar months format, span and lay out in Sunday-first weeks", () => {
  assert.equal(formatMonth("2026-10"), "October 2026");
  assert.deepEqual(monthsBetween("2026-11", "2027-01"), ["2026-11", "2026-12", "2027-01"]);
  assert.deepEqual(monthsBetween("2026-11", "2026-10"), ["2026-11"], "an earlier last month still gives the first");
  assert.throws(() => monthsBetween("2026-13", "2027-01"), RangeError);
  const october = monthCells("2026-10");
  assert.equal(october.length % 7, 0);
  assert.deepEqual(october.slice(0, 5), [null, null, null, null, "2026-10-01"], "October 2026 starts on a Thursday");
  assert.equal(october.filter(Boolean).length, 31);
  assert.equal(october.at(-1), "2026-10-31", "Saturday the 31st ends the last week with no blank cells");
  assert.equal(monthCells("2026-12").at(-1), null, "December 2026 ends on a Thursday, so blanks fill its last week");
  assert.equal(monthCells("2026-02").filter(Boolean).length, 28);
  assert.deepEqual(monthCells("2026-11").slice(0, 1), ["2026-11-01"], "a month starting on Sunday has no leading blanks");
});

const guestWindow = (id: string, date: string, startTime: string, endTime: string, status: "open" | "canceled" = "open", teamCount = 0) =>
  ({ id, status, teamCount, local: { date, startTime, endTime } });

test("guest calendar days are open, canceled or closed by what a guest can still book", () => {
  const days = guestDays([
    guestWindow("a", "2026-10-29", "16:00", "20:00", "open", 1),
    guestWindow("b", "2026-10-29", "10:00", "12:00", "open", 2),
    guestWindow("c", "2026-10-31", "16:00", "20:00", "canceled"),
    guestWindow("d", "2026-10-28", "09:00", "11:00", "open", 3),
    guestWindow("e", "2026-11-05", "16:00", "20:00", "open"),
    guestWindow("f", "2026-11-05", "08:00", "09:00", "canceled"),
  ], new Set(["a", "b", "e"]));
  assert.deepEqual(days.get("2026-10-29"), { date: "2026-10-29", state: "open", openWindows: 2, teams: 3, startTime: "10:00", endTime: "20:00" });
  assert.deepEqual(days.get("2026-10-31"), { date: "2026-10-31", state: "canceled", openWindows: 0, teams: 0, startTime: "16:00", endTime: "20:00" });
  assert.equal(days.get("2026-10-28")!.state, "closed", "a window that can no longer be booked closes its day");
  assert.equal(days.get("2026-11-05")!.state, "open", "an open window outweighs a canceled one");
  assert.equal(days.get("2026-11-05")!.startTime, "16:00", "the cell shows the open window's hours");
  assert.equal(guestDayText(days.get("2026-10-29")), "2 open times, 3 teams coming");
  assert.equal(guestDayText(days.get("2026-11-05")), "1 open time");
  assert.equal(guestDayText(days.get("2026-10-31")), "Canceled");
  assert.equal(guestDayText(days.get("2026-10-28")), "No open times left");
  assert.equal(guestDayText(undefined), "No open times");
});

test("guests browse from this month to the horizon and start at the first open day", () => {
  const days = guestDays([guestWindow("a", "2026-12-03", "16:00", "20:00"), guestWindow("b", "2026-10-29", "16:00", "20:00", "canceled")], new Set(["a"]));
  assert.deepEqual(guestMonths("2026-10-28", 56, days), { months: ["2026-10", "2026-11", "2026-12"], initial: "2026-12" });
  assert.deepEqual(guestMonths("2026-10-28", 1, new Map()), { months: ["2026-10"], initial: "2026-10" }, "with nothing posted only this month shows");
  const late = guestDays([guestWindow("a", "2027-01-04", "16:00", "20:00")], new Set(["a"]));
  assert.deepEqual(guestMonths("2026-10-28", 7, late).months.at(-1), "2027-01", "a posted window past the horizon still gets its month");
});
