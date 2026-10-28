import test from "node:test";
import assert from "node:assert/strict";
import { at, civil, newYork } from "./helpers/civil-time.ts";
import {
  defaultSummaryTime, defaultSummaryWeekday, emptyWeekText, formatWeeklySummary, parseSummaryPayload, reportTimes, selectSummaryVisits, summaryDisposition,
  weeklySummaryDecision, type SummaryVisit,
} from "../src/shared/visits-summary.ts";
import type { TeamIdentity } from "../src/shared/visits-booking.ts";

const iso = (ms: number) => new Date(ms).toISOString();
const monday = { weekday: defaultSummaryWeekday, time: defaultSummaryTime };
const decide = (now: number, options: { sinceMs?: number; existingStatus?: string | null; enabled?: boolean; schedule?: { weekday: number; time: string } } = {}) => weeklySummaryDecision({
  civil, timeZone: newYork, enabled: options.enabled ?? true, schedule: options.schedule ?? monday, sinceMs: options.sinceMs ?? 0, now, existingStatus: options.existingStatus,
});

test("report times are the latest weekly time at or before now and the one after", () => {
  assert.deepEqual(monday, { weekday: 1, time: "12:00" });
  const times = reportTimes(civil, newYork, monday, at("2026-10-28T16:00:00Z"));
  assert.deepEqual(times.current, { date: "2026-10-26", ms: at("2026-10-26T16:00:00Z") });
  // Monday noon stays noon after the clocks fall back on 2026-11-01: 16:00Z in EDT, 17:00Z in EST.
  assert.deepEqual(times.next, { date: "2026-11-02", ms: at("2026-11-02T17:00:00Z") });
  assert.equal(reportTimes(civil, newYork, monday, at("2026-11-02T17:00:00Z")).current.date, "2026-11-02", "exactly at the report time");
  assert.equal(reportTimes(civil, newYork, monday, at("2026-11-02T16:59:59Z")).current.date, "2026-10-26", "just before it");
  assert.equal(reportTimes(civil, newYork, monday, at("2026-11-02T04:00:00Z")).current.date, "2026-10-26", "Sunday night, UTC Monday");
  assert.throws(() => reportTimes(civil, newYork, { weekday: 7, time: "12:00" }, 0), RangeError);
});

test("report times on daylight saving days follow the policy", () => {
  // Sunday 01:30 on 2026-11-01 happens twice; the report uses the first.
  assert.equal(iso(reportTimes(civil, newYork, { weekday: 0, time: "01:30" }, at("2026-11-01T12:00:00Z")).current.ms), "2026-11-01T05:30:00.000Z");
  // Sunday 02:30 on 2026-03-08 does not exist; the report posts when the clock jumps to 03:00.
  const spring = reportTimes(civil, newYork, { weekday: 0, time: "02:30" }, at("2026-03-08T12:00:00Z"));
  assert.equal(iso(spring.current.ms), "2026-03-08T07:00:00.000Z");
  assert.equal(iso(spring.next.ms), "2026-03-15T06:30:00.000Z");
});

test("a summary is due once its report time passes, posts once and posts late after a missed pass", () => {
  assert.deepEqual(decide(at("2026-11-02T16:59:00Z"), { existingStatus: "delivered" }), { action: "done", reportDate: "2026-10-26", status: "delivered", next: { date: "2026-11-02", ms: at("2026-11-02T17:00:00Z") } });
  const due = decide(at("2026-11-02T17:00:00Z"));
  assert.deepEqual(due, { action: "queue", reportDate: "2026-11-02", payload: { reportMs: at("2026-11-02T17:00:00Z"), nextReportMs: at("2026-11-09T17:00:00Z"), nextReportDate: "2026-11-09" } });
  // The job missed noon and runs at 14:00: still this week's summary, queued late.
  assert.equal(decide(at("2026-11-02T19:00:00Z")).action, "queue");
  // Once queued (or sent, or skipped) for this report date, later passes do nothing.
  for (const status of ["pending", "sending", "delivered", "failed", "skipped"]) assert.equal(decide(at("2026-11-02T19:05:00Z"), { existingStatus: status }).action, "done", status);
  assert.deepEqual(decide(at("2026-11-02T19:00:00Z"), { enabled: false }), { action: "off" });
});

test("a summary not sent before the following report time is skipped", () => {
  const payload = { reportMs: at("2026-11-02T17:00:00Z"), nextReportMs: at("2026-11-09T17:00:00Z") };
  assert.equal(summaryDisposition(payload, at("2026-11-02T17:05:00Z")), "send");
  assert.equal(summaryDisposition(payload, at("2026-11-09T16:59:59Z")), "send");
  assert.equal(summaryDisposition(payload, at("2026-11-09T17:00:00Z")), "skip");
  // A job that was down for two weeks queues only the latest week; earlier weeks are never queued.
  const late = decide(at("2026-11-17T12:00:00Z"));
  assert.ok(late.action === "queue" && late.reportDate === "2026-11-16");
  assert.deepEqual(parseSummaryPayload(JSON.stringify({ ...payload, nextReportDate: "2026-11-09" })), { ...payload, nextReportDate: "2026-11-09" });
  for (const json of ["", "{}", "nope", JSON.stringify({ reportMs: 2, nextReportMs: 1, nextReportDate: "x" })]) assert.equal(parseSummaryPayload(json), null, json);
});

test("turning the summary on or changing its day and time never posts a past week", () => {
  // Turned on Tuesday 2026-11-03: Monday's report time already passed before it, so the first summary is next Monday.
  const enabledAt = at("2026-11-03T15:00:00Z");
  assert.deepEqual(decide(at("2026-11-03T15:05:00Z"), { sinceMs: enabledAt }), { action: "wait", next: { date: "2026-11-09", ms: at("2026-11-09T17:00:00Z") } });
  assert.equal(decide(at("2026-11-09T17:00:00Z"), { sinceMs: enabledAt }).action, "queue");
  // Moved to Wednesday 09:00 on Tuesday: the first Wednesday summary is the next day.
  const wednesday = { weekday: 3, time: "09:00" };
  assert.equal(decide(at("2026-11-03T15:05:00Z"), { sinceMs: enabledAt, schedule: wednesday }).action, "wait");
  const moved = decide(at("2026-11-04T14:05:00Z"), { sinceMs: enabledAt, schedule: wednesday });
  assert.ok(moved.action === "queue" && moved.reportDate === "2026-11-04" && moved.payload.nextReportDate === "2026-11-11");
  // Moved to a later time on the day this week's summary already posted: same report date, so no second post.
  const later = { weekday: 1, time: "15:00" };
  const changedAt = at("2026-11-02T18:00:00Z");
  assert.deepEqual(decide(at("2026-11-02T20:05:00Z"), { sinceMs: changedAt, schedule: later, existingStatus: "delivered" }).action, "done");
});

const team = (number: string, name: string, program: TeamIdentity["program"] = "FRC"): TeamIdentity => ({ number, name, program });
const reportMs = at("2026-11-02T17:00:00Z");
const nextReportMs = at("2026-11-09T17:00:00Z");

test("the summary lists booked visits not ended by the report time and starting before the next report", () => {
  const visit = (id: string, arrival: string, departure: string, status = "booked"): SummaryVisit & { id: string } => ({ id, status, arrivalMs: at(arrival), departureMs: at(departure), headcount: 5, team: team(id, id) });
  const visits = [
    visit("ended-at-report", "2026-11-02T15:00:00Z", "2026-11-02T17:00:00Z"),
    visit("in-progress", "2026-11-02T16:00:00Z", "2026-11-02T18:00:00Z"),
    visit("canceled", "2026-11-03T23:00:00Z", "2026-11-04T01:00:00Z", "canceled"),
    visit("wednesday", "2026-11-04T23:00:00Z", "2026-11-05T01:00:00Z"),
    visit("monday-evening", "2026-11-02T23:00:00Z", "2026-11-03T01:00:00Z"),
    visit("starts-at-next", "2026-11-09T17:00:00Z", "2026-11-09T18:00:00Z"),
    visit("next-week", "2026-11-10T23:00:00Z", "2026-11-11T01:00:00Z"),
  ];
  assert.deepEqual(selectSummaryVisits(visits, reportMs, nextReportMs).map((entry) => entry.id), ["in-progress", "monday-evening", "wednesday"]);
});

test("the summary groups visits by local day and leaves contacts and notes out", () => {
  const visits = selectSummaryVisits([
    { status: "booked", arrivalMs: at("2026-11-04T23:00:00Z"), departureMs: at("2026-11-05T01:00:00Z"), headcount: 1, team: team("16072", "Quantum", "FTC"), contactEmail: "a@example.org", note: "secret" },
    { status: "booked", arrivalMs: at("2026-11-02T23:30:00Z"), departureMs: at("2026-11-03T01:00:00Z"), headcount: 12, team: team("1234", "Gear Heads") },
    { status: "booked", arrivalMs: at("2026-11-03T00:00:00Z"), departureMs: at("2026-11-03T02:00:00Z"), headcount: 4, team: team("45", "@everyone **Bricks**", "Explore") },
  ], reportMs, nextReportMs);
  const zeroWidthSpace = String.fromCharCode(0x200b);
  assert.equal(formatWeeklySummary(civil, newYork, { reportDate: "2026-11-02", nextReportDate: "2026-11-09", visits }), [
    "**Guest visits from Monday, November 2 to Monday, November 9**",
    "",
    "**Monday, November 2**",
    "- FRC 1234 Gear Heads: 6:30 PM to 8:00 PM, 12 people",
    `- FLL Explore 45 @${zeroWidthSpace}everyone \\*\\*Bricks\\*\\*: 7:00 PM to 9:00 PM, 4 people`,
    "",
    "**Wednesday, November 4**",
    "- FTC 16072 Quantum: 6:00 PM to 8:00 PM, 1 person",
  ].join("\n"));
});

test("an empty week still posts, and a long week fits one Discord message", () => {
  assert.equal(emptyWeekText, "No guest visits scheduled this week");
  assert.equal(formatWeeklySummary(civil, newYork, { reportDate: "2026-11-02", nextReportDate: "2026-11-09", visits: [] }), `**Guest visits from Monday, November 2 to Monday, November 9**\n${emptyWeekText}`);
  const many = Array.from({ length: 60 }, (_, index): SummaryVisit => ({
    status: "booked", arrivalMs: reportMs + 3_600_000 * (index + 1), departureMs: reportMs + 3_600_000 * (index + 2), headcount: 10, team: team(String(1000 + index), "A team with a fairly long name for testing"),
  }));
  const message = formatWeeklySummary(civil, newYork, { reportDate: "2026-11-02", nextReportDate: "2026-11-09", visits: many });
  assert.ok(message.length <= 2000, String(message.length));
  const shown = message.split("\n").filter((line) => line.startsWith("- ")).length;
  assert.ok(shown > 10 && shown < 60, String(shown));
  assert.ok(message.endsWith(`...and ${60 - shown} more visits in Guest Visits`), message.slice(-80));
});
