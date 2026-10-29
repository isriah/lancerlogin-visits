import test from "node:test";
import assert from "node:assert/strict";
import { at, newYork } from "./helpers/civil-time.ts";
import {
  arrivalChoices, compactTime, defaultDeparture, departureChoices, formatCompactDate, formatDateRange, formatInstant, formatTimeRange, formatVisitWhen, groupByDate,
  groupRangesByDate, guestCellLines, guestDays, guestDayText, guestLastView, guestTeamLabel, guestWeekDates, localReading, localSpan, monthGridRange, peopleText, headcountText,
  teamCountText, timeSteps, todayIn, visitCountText, weekdayListText, type GuestDay,
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
  assert.equal(formatDateRange("2026-10-18", "2026-11-21"), "Oct 18 to Nov 21, 2026");
  assert.equal(formatDateRange("2026-12-27", "2027-01-30"), "Dec 27, 2026 to Jan 30, 2027", "both years when they differ");
  assert.equal(weekdayListText([3, 1]), "Mondays and Wednesdays");
  assert.equal(weekdayListText([5, 1, 3, 1]), "Mondays, Wednesdays and Fridays");
  assert.equal(weekdayListText([6]), "Saturdays");
  assert.equal(weekdayListText([]), "");
  assert.equal(peopleText(1), "1 person");
  assert.equal(peopleText(12), "12 people");
  assert.equal(peopleText(null), "headcount not given");
  assert.equal(headcountText(null), "Not given");
  assert.equal(headcountText(3), "3 people");
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

test("the suggested departure is the window's end, so a new visit covers the whole open time", () => {
  const window = { startTime: "18:00", endTime: "21:00" };
  assert.equal(defaultDeparture(window, "18:00"), "21:00");
  assert.equal(defaultDeparture(window, "20:30"), "21:00");
  assert.equal(defaultDeparture({ startTime: "18:10", endTime: "21:05" }, "18:10"), "21:05", "an end off the quarter hour is still the end");
  // With the first arrival choice (the window's start, or the earliest still open once it began) the visit spans the window.
  assert.deepEqual([arrivalChoices(window)[0], defaultDeparture(window, arrivalChoices(window)[0]!)], ["18:00", "21:00"]);
  const started = arrivalChoices(window, "19:20")[0]!;
  assert.deepEqual([started, defaultDeparture(window, started)], ["19:30", "21:00"]);
  assert.equal(defaultDeparture(window, ""), "21:00");
  assert.equal(defaultDeparture(window, "21:00"), "");
});

test("a guest calendar view is five Sunday-first weeks from last week, and the arrows move five weeks", () => {
  const thisView = guestWeekDates("2026-10-29", 0);
  assert.equal(thisView.length, 35);
  assert.deepEqual([thisView[0], thisView.at(-1)], ["2026-10-18", "2026-11-21"], "a Thursday's view starts the Sunday of the week before");
  assert.ok(thisView.includes("2026-10-29") && thisView.indexOf("2026-10-25") === 7, "this week is the second row");
  assert.deepEqual(guestWeekDates("2026-10-25", 0)[0], "2026-10-18", "on a Sunday, last week still leads");
  assert.deepEqual(guestWeekDates("2026-10-31", 0)[0], "2026-10-18", "on a Saturday too");
  const next = guestWeekDates("2026-10-29", 1);
  assert.deepEqual([next[0], next.at(-1)], ["2026-11-22", "2026-12-26"], "the next view picks up where this one ends");
  assert.deepEqual([guestWeekDates("2026-12-30", 0)[0], guestWeekDates("2026-12-30", 0).at(-1)], ["2026-12-20", "2027-01-23"], "views run across the new year");
  assert.throws(() => guestWeekDates("2026-10-32", 0), /Not a local date/);
});

const guestWindow = (id: string, date: string, startTime: string, endTime: string, status: "open" | "canceled" = "open", teamCount = 0, title = "", teams: readonly string[] = []) =>
  ({ id, title, status, teamCount, visits: teams.map((team) => ({ program: "FRC" as const, teamNumber: team.split(" ")[0]!, teamName: team.split(" ").slice(1).join(" ") })), local: { date, startTime, endTime } });

test("guest calendar days are open, canceled or closed by what a guest can still book", () => {
  const days = guestDays([
    guestWindow("a", "2026-10-29", "16:00", "20:00", "open", 1, "Build night", ["321 RoboLancers"]),
    guestWindow("b", "2026-10-29", "10:00", "12:00", "open", 2, "", ["1218 SCH Robotics", "321 RoboLancers"]),
    guestWindow("c", "2026-10-31", "16:00", "20:00", "canceled", 0, "Drive practice"),
    guestWindow("d", "2026-10-28", "09:00", "11:00", "open", 3),
    guestWindow("e", "2026-11-05", "16:00", "20:00", "open"),
    guestWindow("f", "2026-11-05", "08:00", "09:00", "canceled"),
  ].sort((left, right) => (left.local.date + left.local.startTime).localeCompare(right.local.date + right.local.startTime)), new Set(["a", "b", "e"]));
  assert.deepEqual(days.get("2026-10-29"), {
    date: "2026-10-29", state: "open", openWindows: 2, teams: 3, startTime: "10:00", endTime: "20:00",
    titles: ["Build night"], teamLabels: ["1218 SCH Robotics", "321 RoboLancers"],
  }, "a team coming to two windows is named once, in the order teams come");
  assert.deepEqual(days.get("2026-10-31"), { date: "2026-10-31", state: "canceled", openWindows: 0, teams: 0, startTime: "16:00", endTime: "20:00", titles: ["Drive practice"], teamLabels: [] });
  assert.equal(days.get("2026-10-28")!.state, "closed", "a window that can no longer be booked closes its day");
  assert.equal(days.get("2026-11-05")!.state, "open", "an open window outweighs a canceled one");
  assert.equal(days.get("2026-11-05")!.startTime, "16:00", "the cell shows the open window's hours");
  assert.equal(guestDayText(days.get("2026-10-29")), "2 open times, 3 teams coming");
  assert.equal(guestDayText(days.get("2026-11-05")), "1 open time");
  assert.equal(guestDayText(days.get("2026-10-31")), "Canceled");
  assert.equal(guestDayText(days.get("2026-10-28")), "No open times left");
  assert.equal(guestDayText(undefined), "No open times");
  assert.equal(guestTeamLabel({ teamNumber: "321", teamName: "RoboLancers" }), "321 RoboLancers");
});

test("a canceled window lends its day no teams", () => {
  const days = guestDays([guestWindow("a", "2026-11-05", "16:00", "20:00", "canceled", 1, "", ["321 RoboLancers"]), guestWindow("b", "2026-11-05", "08:00", "09:00", "open")], new Set(["b"]));
  assert.deepEqual(days.get("2026-11-05")!.teamLabels, []);
  assert.deepEqual(days.get("2026-11-05")!.titles, [], "blank titles are left out");
});

const openDay = (fields: Partial<GuestDay> = {}): GuestDay => ({
  date: "2026-11-05", state: "open", openWindows: 1, teams: 3, startTime: "18:00", endTime: "20:30", titles: ["Build night"],
  teamLabels: ["321 RoboLancers", "1218 SCH Robotics", "11 MORT"], ...fields,
});
const cellText = (day: GuestDay | undefined, room: number) => guestCellLines(day, room).map((line) => line.text);

test("a guest calendar cell lists hours, titles and teams, ending in +N more when the teams do not fit", () => {
  assert.deepEqual(cellText(openDay(), 6), ["6 PM to 8:30 PM", "Build night", "321 RoboLancers", "1218 SCH Robotics", "11 MORT"]);
  assert.deepEqual(cellText(openDay(), 5), ["6 PM to 8:30 PM", "Build night", "321 RoboLancers", "1218 SCH Robotics", "11 MORT"], "exactly enough room");
  assert.deepEqual(cellText(openDay(), 4), ["6 PM to 8:30 PM", "Build night", "321 RoboLancers", "+2 more"]);
  assert.deepEqual(guestCellLines(openDay(), 4).map((line) => line.kind), ["time", "title", "team", "more"]);
  assert.deepEqual(cellText(openDay(), 3), ["6 PM to 8:30 PM", "Build night", "3 teams"], "with no room for a name, the count");
  assert.deepEqual(cellText(openDay(), 2), ["6 PM to 8:30 PM", "3 teams"], "the teams keep a line before the title does");
  assert.deepEqual(cellText(openDay({ teamLabels: ["321 RoboLancers"] }), 2), ["6 PM to 8:30 PM", "321 RoboLancers"]);
  assert.deepEqual(cellText(openDay(), 1), ["6 PM to 8:30 PM"]);
  assert.deepEqual(cellText(openDay(), 0), [], "phones hide the lines, which measures as no room");
  assert.deepEqual(cellText(openDay({ openWindows: 2, titles: ["Build night", "Drive practice"], teamLabels: [] }), 4), ["2 times", "Build night", "Drive practice"]);
  assert.deepEqual(cellText(openDay({ teamLabels: [] }), 2), ["6 PM to 8:30 PM", "Build night"], "without teams the title takes the line");
  assert.deepEqual(cellText(openDay({ state: "canceled" }), 3), ["Canceled"]);
  assert.deepEqual(cellText(openDay({ state: "closed" }), 3), []);
  assert.deepEqual(cellText(undefined, 3), []);
});

test("guests page from the view with this week to the one holding the booking horizon", () => {
  assert.equal(guestLastView("2026-10-29", 56, new Map()), 1, "eight weeks ahead ends in the second view");
  assert.equal(guestLastView("2026-10-25", 56, new Map()), 1);
  assert.equal(guestLastView("2026-10-29", 1, new Map()), 0, "a one-day horizon stays on this view");
  assert.equal(guestLastView("2026-10-29", 0, new Map()), 0);
  assert.equal(guestLastView("2026-10-29", 24, new Map()), 0, "a horizon ending on the view's last Saturday stays");
  assert.equal(guestLastView("2026-10-29", 25, new Map()), 1, "one day more opens the next view");
  const late = guestDays([guestWindow("a", "2027-01-04", "16:00", "20:00")], new Set(["a"]));
  assert.equal(guestLastView("2026-10-29", 7, late), 2, "a posted window past the horizon can still be reached");
});
