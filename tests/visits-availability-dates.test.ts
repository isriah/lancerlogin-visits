import test from "node:test";
import assert from "node:assert/strict";
import { addAvailabilityDate, availabilityDraftOn, switchRepeats } from "../src/dashboard/visits-availability-dates.ts";
import { availabilityDraft, availabilityRequest, type AvailabilityDraft } from "../src/dashboard/visits-forms.ts";

const today = "2026-10-29";

test("Add availability starts on the calendar's selected day, past days included, and on today in the table", () => {
  assert.equal(addAvailabilityDate(today, "calendar", "2026-11-12"), "2026-11-12");
  assert.equal(addAvailabilityDate(today, "calendar", "2026-10-01"), "2026-10-01");
  assert.equal(addAvailabilityDate(today, "calendar", today), today);
  assert.equal(addAvailabilityDate(today, "table", "2026-11-12"), today);
  assert.equal(addAvailabilityDate(today, "calendar", undefined), today);
  assert.equal(addAvailabilityDate(today, "calendar", "2026-02-30"), today);
  assert.equal(addAvailabilityDate(today, "calendar", "not a date"), today);
});

test("a draft on a picked day fills the one date and the first date, with the usual range after it", () => {
  const draft = availabilityDraftOn(today, "2026-11-12");
  assert.deepEqual(draft, { ...availabilityDraft(today), date: "2026-11-12", firstDate: "2026-11-12", lastDate: "2027-01-06" });
  assert.deepEqual(availabilityDraftOn(today, undefined), availabilityDraft(today));
  assert.deepEqual(availabilityDraftOn(today, ""), availabilityDraft(today));
  // A past day is offered as it is; the form's own checks decide whether it can be saved.
  const past = availabilityDraftOn(today, "2026-10-01");
  assert.equal(past.firstDate, "2026-10-01");
  assert.equal(past.date, "2026-10-01");
});

test("Every week to One date keeps the first date typed, the times and the title", () => {
  const typed: AvailabilityDraft = { ...availabilityDraft(today), weekdays: [2, 4], firstDate: "2026-12-01", lastDate: "2027-02-01", startTime: "17:30", endTime: "19:00", title: "Open shop" };
  const once = switchRepeats(typed, false);
  assert.deepEqual(once, { ...typed, repeating: false, date: "2026-12-01" });
  const request = availabilityRequest(once);
  assert.ok(request.ok && request.kind === "window");
  assert.deepEqual(request.value, { date: "2026-12-01", startTime: "17:30", endTime: "19:00", title: "Open shop" });
});

test("One date to Every week makes the date the first date and keeps a last date still after it", () => {
  const typed: AvailabilityDraft = { ...availabilityDraft(today), repeating: false, date: "2026-11-20", startTime: "16:00", endTime: "18:00", title: "Scrimmage" };
  const weekly = switchRepeats(typed, true);
  assert.equal(weekly.repeating, true);
  assert.equal(weekly.firstDate, "2026-11-20");
  assert.equal(weekly.lastDate, typed.lastDate, "the default last date of today's draft is still after the 20th");
  assert.deepEqual({ startTime: weekly.startTime, endTime: weekly.endTime, title: weekly.title, date: weekly.date }, { startTime: "16:00", endTime: "18:00", title: "Scrimmage", date: "2026-11-20" });
});

test("a last date that is no longer after the new first date becomes that date plus the usual range", () => {
  const late: AvailabilityDraft = { ...availabilityDraft(today), repeating: false, date: "2027-03-01", lastDate: "2026-12-23" };
  assert.deepEqual([switchRepeats(late, true).firstDate, switchRepeats(late, true).lastDate], ["2027-03-01", "2027-04-25"]);
  const same: AvailabilityDraft = { ...late, date: "2026-12-23" };
  assert.equal(switchRepeats(same, true).lastDate, "2027-02-16", "a last date on the first date is not after it");
  const empty: AvailabilityDraft = { ...late, lastDate: "" };
  assert.equal(switchRepeats(empty, true).lastDate, "2027-04-25");
});

test("switching back and forth keeps the date entered and never returns to today", () => {
  let draft = availabilityDraftOn(today, "2026-11-12");
  draft = switchRepeats(draft, false);
  draft = { ...draft, date: "2026-12-04" };
  draft = switchRepeats(draft, true);
  assert.equal(draft.firstDate, "2026-12-04");
  draft = switchRepeats(draft, false);
  assert.equal(draft.date, "2026-12-04");
  draft = switchRepeats(switchRepeats(draft, true), false);
  assert.equal(draft.date, "2026-12-04");
  assert.notEqual(draft.firstDate, today);
});

test("choosing the Repeats option already chosen changes nothing, and a cleared date keeps the other date", () => {
  const draft = availabilityDraftOn(today, "2026-11-12");
  assert.equal(switchRepeats(draft, true), draft);
  const cleared = switchRepeats({ ...draft, firstDate: "" }, false);
  assert.equal(cleared.date, "2026-11-12");
  const clearedOnce = switchRepeats({ ...draft, repeating: false, date: "" }, true);
  assert.equal(clearedOnce.firstDate, "2026-11-12");
  assert.equal(clearedOnce.lastDate, draft.lastDate);
});
