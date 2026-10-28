import test from "node:test";
import assert from "node:assert/strict";
import { at, newYork } from "./helpers/civil-time.ts";
import {
  attentionNotes, bookingBadges, canMarkHandled, canRecordInOutreach, describeChange, emailStateBadges, historyActionText, historyActorText, historyNewestFirst,
  mergeTargets, outreachBadge, outreachRecordSummary, outreachResultText, programChoices, sortBookings, sortTeams, teamText,
} from "../src/dashboard/visits-labels.ts";
import type { BookingHistoryEntry, StaffBooking, StaffTeam } from "../src/shared/visits-api.ts";

const base: Pick<StaffBooking, "status" | "removed" | "attention" | "email" | "outreach"> & { team: Pick<StaffBooking["team"], "program"> } = {
  status: "booked", removed: false, attention: { state: "none", reason: null }, email: "sent", outreach: null, team: { program: "FRC" },
};

test("teams and programs read the way guests write them", () => {
  assert.equal(teamText({ number: "321", name: "Lancers", program: "FRC" }), "FRC 321 Lancers");
  assert.equal(teamText({ number: "12345", name: "Bricks", program: "Challenge" }), "FLL Challenge 12345 Bricks");
  assert.equal(teamText({ number: "99X", name: "Scouts", program: "Other" }), "Team 99X Scouts");
  assert.deepEqual(programChoices.map((choice) => choice.label), ["FRC", "FTC", "FIRST LEGO League Challenge", "FIRST LEGO League Explore", "Other"]);
});

test("visit badges show removal or cancellation, attention, email and the visit's Outreach state", () => {
  assert.deepEqual(bookingBadges(base, false), [{ label: "Email sent", tone: "success" }]);
  assert.deepEqual(bookingBadges({ ...base, status: "canceled", attention: { state: "needed", reason: "outreach-activity-kept" }, email: "capped", outreach: { state: "recorded", activityId: "a1" } }, true).map((badge) => badge.label), [
    "Canceled", "Needs attention", "Email waiting: daily limit", "Recorded in Outreach",
  ]);
  assert.deepEqual(bookingBadges({ ...base, status: "canceled", removed: true }, true).map((badge) => badge.label), ["Removed", "Email sent"]);
  // A known Outreach state always shows; "not yet" shows only while Outreach can be used, for visits it could record.
  assert.deepEqual(bookingBadges({ ...base, outreach: { state: "failed", activityId: null } }, false).map((badge) => badge.label), ["Email sent", "Outreach record failed"]);
  assert.deepEqual(bookingBadges(base, true).map((badge) => badge.label), ["Email sent", "Not in Outreach yet"]);
  assert.deepEqual(bookingBadges({ ...base, team: { program: "Other" } }, true).map((badge) => badge.label), ["Email sent"]);
  assert.deepEqual(bookingBadges({ ...base, status: "canceled" }, true).map((badge) => badge.label), ["Canceled", "Email sent"]);
  assert.equal(bookingBadges({ ...base, attention: { state: "handled", reason: "window-canceled" } }, false)[0]!.label, "Handled");
  assert.equal(emailStateBadges.failed.tone, "error");
  assert.equal(outreachBadge(null), null);
  assert.equal(outreachBadge({ state: "pending", activityId: null })!.label, "Outreach record waiting");
});

test("Needs attention explains every reason and offers Mark handled only for attention reasons", () => {
  assert.deepEqual(attentionNotes(base), []);
  const notes = attentionNotes({ attention: { state: "needed", reason: "window-canceled" }, email: "failed", outreach: { state: "failed", activityId: null, error: "Outreach is disabled" } });
  assert.equal(notes.length, 3);
  assert.match(notes[0]!, /window was canceled/);
  assert.match(notes[1]!, /email to the team failed/);
  assert.match(notes[2]!, /Outreach failed: Outreach is disabled\. Use Record in Outreach to try again/);
  assert.match(attentionNotes({ ...base, email: "capped" })[0]!, /daily limit/);
  assert.equal(attentionNotes({ ...base, attention: { state: "handled", reason: "window-removed" } }).length, 0, "a handled reason is not repeated");
  assert.equal(canMarkHandled({ attention: { state: "needed", reason: "window-changed" } }), true);
  assert.equal(canMarkHandled({ attention: { state: "handled", reason: "window-changed" } }), false);
  assert.equal(canMarkHandled({ attention: { state: "none", reason: null } }), false);
});

test("history reads in words, newest first, with every older entry restorable", () => {
  assert.equal(historyActionText("created"), "Booked");
  assert.equal(historyActionText("restored"), "Restored");
  assert.equal(historyActionText("merged"), "Merged");
  assert.equal(historyActorText({ kind: "guest" }, "created"), "The team, on the guest page");
  assert.equal(historyActorText({ kind: "guest" }, "updated"), "The team, through the emailed link");
  assert.equal(historyActorText({ kind: "guest" }), "The team, through the emailed link");
  assert.equal(historyActorText({ kind: "staff", name: "Alex" }), "Staff: Alex");
  assert.equal(historyActorText({ kind: "staff", name: null }), "Staff");
  const context = { timeZone: newYork, teamName: (id: string) => ({ t1: "FRC 321 Lancers", t2: "FRC 254 Cheesy Poofs" })[id] };
  assert.equal(describeChange({ field: "headcount", from: 4, to: 6 }, context), "People: 4 people to 6 people");
  assert.equal(describeChange({ field: "arrivalMs", from: at("2026-11-02T23:00:00Z"), to: at("2026-11-02T23:30:00Z") }, context), "Arrival: Monday, November 2, 6:00 PM to Monday, November 2, 6:30 PM");
  assert.equal(describeChange({ field: "teamId", from: "t1", to: "t2" }, context), "Team: FRC 321 Lancers to FRC 254 Cheesy Poofs");
  assert.equal(describeChange({ field: "teamId", from: "t1", to: "t9" }, context), "Team: FRC 321 Lancers to another team");
  assert.equal(describeChange({ field: "windowId", from: "w1", to: "w2" }, context), "Moved to another window");
  assert.equal(describeChange({ field: "status", from: "booked", to: "canceled" }, context), "Status: booked to canceled");
  assert.equal(describeChange({ field: "contactPhone", from: "", to: "555-123-4567" }, context), "Phone: (empty) to 555-123-4567");
  const entry = (id: string, atMs: number): BookingHistoryEntry => ({ id, atMs, actor: { kind: "guest" }, action: "updated", changes: [] });
  assert.deepEqual(historyNewestFirst([entry("a", 1), entry("c", 3), entry("b", 2)]).map((item) => [item.entry.id, item.restorable]), [["c", false], ["b", true], ["a", true]]);
});

test("guest teams sort by program then number, and merge only into active teams of the same program", () => {
  const team = (id: string, program: StaffTeam["program"], number: string, archived = false): StaffTeam => ({ id, program, number, name: `Team ${id}`, archived, revision: 1, visitCount: 0, outreachTeamId: null });
  const teams = [team("a", "FTC", "20"), team("b", "FRC", "1000"), team("c", "FRC", "321"), team("d", "Other", "A1"), team("e", "FRC", "321", true), team("f", "FRC", "99")];
  assert.deepEqual(sortTeams(teams).map((item) => item.id), ["f", "c", "e", "b", "a", "d"]);
  assert.deepEqual(mergeTargets(teams, teams[2]!).map((item) => item.id), ["f", "b"]);
  assert.deepEqual(mergeTargets(teams, teams[0]!), []);
});

test("upcoming visits list soonest first and past and removed visits most recent first", () => {
  const visit = (id: string, arrivalMs: number) => ({ id, arrivalMs, departureMs: arrivalMs + 1 });
  const visits = [visit("b", 2), visit("a", 1), visit("c", 3)];
  assert.deepEqual(sortBookings(visits, "upcoming").map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(sortBookings(visits, "past").map((item) => item.id), ["c", "b", "a"]);
  assert.deepEqual(sortBookings(visits, "removed").map((item) => item.id), ["c", "b", "a"]);
});

test("Record in Outreach shows whenever Outreach can be used, for booked visits it has not recorded", () => {
  const userAccess = { available: true, granted: false };
  const granted = { available: true, granted: true };
  assert.equal(canRecordInOutreach(base, { available: false, granted: false }), false);
  assert.equal(canRecordInOutreach(base, userAccess), true, "staff may use their own Outreach access without a grant");
  assert.equal(canRecordInOutreach(base, granted), true);
  assert.equal(canRecordInOutreach({ ...base, outreach: { state: "recorded", activityId: "a1" } }, userAccess), false);
  assert.equal(canRecordInOutreach({ ...base, outreach: { state: "failed", activityId: null, error: "Refused" } }, granted), true);
  // A waiting record is the job's while a grant lets it run; without one, staff record it themselves.
  assert.equal(canRecordInOutreach({ ...base, outreach: { state: "pending", activityId: null } }, granted), false);
  assert.equal(canRecordInOutreach({ ...base, outreach: { state: "pending", activityId: null } }, userAccess), true);
  assert.equal(canRecordInOutreach({ ...base, status: "canceled" }, granted), false);
  assert.equal(canRecordInOutreach({ ...base, status: "canceled", removed: true }, granted), false);
  assert.equal(canRecordInOutreach({ ...base, team: { program: "Other" } }, granted), false);
});

test("Record in Outreach results read per visit and sum up with the visits that need a look", () => {
  assert.equal(outreachResultText({ state: "recorded" }), "Recorded in Outreach as Team Support.");
  assert.equal(outreachResultText({ state: "pending" }), "Waiting: Guest Visits records it on its next notification pass.");
  assert.equal(outreachResultText({ state: "failed", error: "Supported team is archived" }), "Outreach did not record it: Supported team is archived");
  assert.equal(outreachResultText({ state: "skipped", error: "Canceled visits are not recorded in Outreach" }), "Not recorded: Canceled visits are not recorded in Outreach");
  const names: Record<string, string> = { b1: "FRC 1234 Gearheads", b2: "FTC 8 Eights", b3: "Team X1 Scouts", b4: "FRC 99 Nines" };
  const nameOf = (id: string) => names[id];
  assert.deepEqual(outreachRecordSummary([{ bookingId: "b1", state: "recorded", activityId: "a1" }], nameOf), { tone: "success", text: "FRC 1234 Gearheads is recorded in Outreach as Team Support." });
  assert.deepEqual(outreachRecordSummary([
    { bookingId: "b1", state: "recorded", activityId: "a1" }, { bookingId: "b2", state: "recorded", activityId: "a2" }, { bookingId: "b4", state: "pending", activityId: null },
    { bookingId: "b3", state: "skipped", activityId: null, error: "Outreach does not support teams with program Other" },
  ], nameOf), { tone: "warning", text: "Recorded 2 visits in Outreach as Team Support. 1 visit waits for the next notification pass. Not recorded: Team X1 Scouts (Outreach does not support teams with program Other)." });
  assert.deepEqual(outreachRecordSummary([{ bookingId: "b2", state: "failed", activityId: null, error: "Refused (409)" }, { bookingId: "gone", state: "skipped", activityId: null }], nameOf), {
    tone: "error", text: "Outreach did not record 1 visit: FTC 8 Eights (Refused (409)). Not recorded: A visit.",
  });
  assert.deepEqual(outreachRecordSummary([], nameOf), { tone: "neutral", text: "Nothing was recorded." });
});
