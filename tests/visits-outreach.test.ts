// The Outreach link through the Worker routes and the visits.notifications job, against a synthetic Outreach behind
// Core's cross-module calls: grant awareness and the status flags, queueing on bookings and date changes, the job's team
// link and Team Support activity, repeats, failures and retries, moves and cancellations after recording, Record in
// Outreach with and without authority, revoking, and restore handling. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { book, FakeEmail, visitsHarness, withShopSeries, type Harness } from "./helpers/visits-harness.ts";
import { civil, newYork } from "./helpers/civil-time.ts";
import { outreachAccessMessage } from "../src/api/visits-bookings.ts";
import { visitReportRecords } from "../src/api/visits-reports.ts";
import { outreachState, outreachUse } from "../src/shared/visits-outreach.ts";
import { neutralizeVisitsBackup } from "../src/shared/visits-storage.ts";
import manifest from "../src/manifest.ts";

const records = (harness: Harness) => harness.db.rows<Record<string, unknown>>("SELECT booking_id, status, attempts, next_attempt_ms, external_id, last_error FROM visits_notifications WHERE channel='outreach' ORDER BY created_at, rowid").map((row) => ({ ...row }));
const detail = async (harness: Harness, id: string) => (await harness.call("GET", `/admin/visits/bookings/${id}`)).body;
const status = async (harness: Harness, role: "admin" | "operator" = "admin") => (await harness.call("GET", "/admin/visits/status", { role })).body.outreach;
const stored = (harness: Harness) => harness.db.rows<{ outreach_granted: number; outreach_checked_ms: number | null }>("SELECT outreach_granted, outreach_checked_ms FROM visits_settings")[0]!;
const operations = (harness: Harness) => harness.outreach.calls.map((call) => call.operation);

/** Outreach installed and set up, with or without an Admin's grant to Guest Visits. */
async function withOutreach(options: { granted: boolean }) {
  const harness = visitsHarness();
  harness.outreach.ready = true;
  harness.outreach.granted = options.granted;
  await withShopSeries(harness);
  return harness;
}

test("the manifest asks for Outreach's team support interface, optionally", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(manifest.uses)), [{
    interface: "hour-tracking.team-support", version: 1, operations: ["find-teams", "ensure-team", "ensure-team-support-activity"], required: false,
    reason: "Record guest visits as Outreach team support",
  }]);
  assert.equal(manifest.uses[0], outreachUse);
});

test("without Outreach, or without a grant, nothing is queued and visits have no Outreach state", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  const first = await book(harness);
  assert.deepEqual(await status(harness), { available: false, granted: false });
  assert.equal((await harness.job()).outreachGranted, false);
  assert.equal((await detail(harness, first.id)).outreach, null);
  // Outreach installed, no grant: Admins may use their own Outreach access, Operators need theirs assigned.
  harness.outreach.ready = true;
  assert.deepEqual(await status(harness), { available: true, granted: false });
  assert.deepEqual(await status(harness, "operator"), { available: false, granted: false });
  harness.outreach.operatorAccess = true;
  assert.deepEqual(await status(harness, "operator"), { available: true, granted: false });
  const second = await book(harness, { teamNumber: "2", teamName: "Two", contactEmail: "two@example.org" });
  assert.equal((await harness.call("PUT", `/admin/visits/bookings/${second.id}`, { body: { revision: 0, date: "2026-11-04", arrival: "18:00", departure: "19:00" } })).status, 200);
  assert.equal((await harness.job()).outreachGranted, false);
  assert.deepEqual(records(harness), []);
  assert.deepEqual(harness.outreach.calls, []);
  assert.deepEqual(stored(harness), { outreach_granted: 0, outreach_checked_ms: harness.clock.now });
});

test("with a grant, a booking queues one record and the job links the supported team and its Team Support activity", async () => {
  const harness = await withOutreach({ granted: true });
  harness.outreach.teams.push(
    { id: "outreach-archived", number: "1234", name: "Old Gearheads", program: "FRC", archived: true },
    { id: "outreach-active", number: "1234", name: "Gearheads", program: "FRC", archived: false },
  );
  const booked = await book(harness);
  // The guest request has no signed-in user, so its client meant a grant; it never calls Outreach itself.
  assert.deepEqual(stored(harness).outreach_granted, 1);
  assert.deepEqual(harness.outreach.calls, []);
  assert.deepEqual(records(harness), [{ booking_id: booked.id, status: "pending", attempts: 0, next_attempt_ms: harness.clock.now, external_id: null, last_error: null }]);
  assert.deepEqual((await detail(harness, booked.id)).outreach, { state: "pending", activityId: null });
  assert.deepEqual(await status(harness), { available: true, granted: true });
  const pass = await harness.job();
  assert.equal(pass.outreachGranted, true);
  assert.equal(pass.delivered, 1, "the confirmation email went at booking; the pass did the Outreach record");
  assert.deepEqual(operations(harness), ["find-teams", "ensure-team-support-activity"]);
  assert.deepEqual(harness.outreach.calls.map((call) => [call.input, call.via]), [
    [{ number: "1234", program: "FRC" }, "grant"],
    [{ teamId: "outreach-active", serviceDate: "2026-11-02" }, "grant"],
  ]);
  assert.deepEqual(harness.outreach.activities, [{ id: "outreach-activity-1", teamId: "outreach-active", serviceDate: "2026-11-02" }]);
  assert.deepEqual(harness.db.rows("SELECT number, outreach_team_id FROM visits_teams").map((row) => ({ ...row })), [{ number: "1234", outreach_team_id: "outreach-active" }]);
  assert.deepEqual((await detail(harness, booked.id)).outreach, { state: "recorded", activityId: "outreach-activity-1" });
  assert.deepEqual(records(harness), [{ booking_id: booked.id, status: "delivered", attempts: 1, next_attempt_ms: null, external_id: "outreach-activity-1", last_error: null }]);
  const [report] = await visitReportRecords(harness.db as never, civil, newYork, { to: "2026-12-31" });
  assert.equal(report!.recordedInOutreach, true);
  // Repeating changes nothing.
  await harness.job();
  assert.equal(harness.outreach.calls.length, 2);
  // A team Outreach does not know is created; teams with program Other are never recorded.
  const created = await book(harness, { teamNumber: "4321", teamName: "Robo Owls", program: "FTC", contactEmail: "owls@example.org", date: "2026-11-04" });
  const other = await book(harness, { teamNumber: "SCOUTS", teamName: "Scout troop", program: "Other", contactEmail: "scouts@example.org" });
  await harness.job();
  assert.deepEqual(operations(harness).slice(2), ["find-teams", "ensure-team", "ensure-team-support-activity"]);
  assert.deepEqual(harness.outreach.teams.at(-1), { id: "outreach-team-1", number: "4321", name: "Robo Owls", program: "FTC", archived: false });
  assert.deepEqual((await detail(harness, created.id)).outreach, { state: "recorded", activityId: "outreach-activity-2" });
  assert.equal((await detail(harness, other.id)).outreach, null);
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_notifications WHERE channel='outreach' AND booking_id=?", other.id), 0);
  // A second visit of a linked team uses the stored link.
  await book(harness, { contactEmail: "pat2@example.org", date: "2026-11-09" });
  await harness.job();
  assert.deepEqual(operations(harness).slice(5), ["ensure-team-support-activity"]);
});

test("a visit moved to another date is recorded again there; the earlier activity stays and needs attention, as does a canceled one", async () => {
  const harness = await withOutreach({ granted: true });
  const booked = await book(harness);
  await harness.job();
  assert.equal((await detail(harness, booked.id)).outreach.activityId, "outreach-activity-1");
  // Another time on the same date changes nothing in Outreach.
  assert.equal((await harness.call("PUT", `/admin/visits/bookings/${booked.id}`, { body: { revision: 0, date: "2026-11-02", arrival: "18:45", departure: "20:00" } })).status, 200);
  assert.equal(records(harness).length, 1);
  assert.deepEqual((await detail(harness, booked.id)).attention, { state: "none", reason: null });
  // The guest moves it through the emailed link.
  const token = FakeEmail.token(harness.email.sent[0]!);
  const moved = await harness.call("POST", "/public/visits/manage/update", { body: { token, edit: { revision: 1, date: "2026-11-04", arrival: "18:00", departure: "19:00" } }, role: null });
  assert.equal(moved.status, 200);
  let shown = await detail(harness, booked.id);
  assert.deepEqual(shown.outreach, { state: "pending", activityId: null });
  assert.deepEqual(shown.attention, { state: "needed", reason: "outreach-activity-kept" });
  assert.deepEqual((await harness.call("GET", "/admin/visits/bookings?scope=attention")).body.map((item: { id: string }) => item.id), [booked.id]);
  await harness.job();
  assert.deepEqual(harness.outreach.activities.map((activity) => activity.serviceDate), ["2026-11-02", "2026-11-04"]);
  shown = await detail(harness, booked.id);
  assert.deepEqual(shown.outreach, { state: "recorded", activityId: "outreach-activity-2" });
  // Staff handle the note; canceling now keeps the new activity and needs attention again.
  await harness.call("POST", `/admin/visits/bookings/${booked.id}/handled`);
  assert.deepEqual((await detail(harness, booked.id)).attention, { state: "handled", reason: "outreach-activity-kept" });
  const canceled = await harness.call("POST", `/admin/visits/bookings/${booked.id}/cancel`, { body: { revision: 2 } });
  assert.equal(canceled.status, 200);
  assert.deepEqual(canceled.body.attention, { state: "needed", reason: "outreach-activity-kept" });
  assert.deepEqual(canceled.body.outreach, { state: "recorded", activityId: "outreach-activity-2" });
  const before = harness.outreach.calls.length;
  await harness.job();
  assert.equal(harness.outreach.calls.length, before, "canceled visits are not recorded");
  assert.equal(records(harness).length, 2);
  // Restored on the same date, the kept activity still stands; no new record is needed.
  const history = await detail(harness, booked.id);
  const restored = await harness.call("POST", `/admin/visits/bookings/${booked.id}/restore`, { body: { revisionId: "2", revision: history.revision } });
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.body.outreach, { state: "recorded", activityId: "outreach-activity-2" });
  assert.equal(records(harness).length, 2);
});

test("a visit canceled before the job records it is skipped, and a removed visit gets no attention", async () => {
  const harness = await withOutreach({ granted: true });
  const first = await book(harness);
  await harness.call("POST", `/admin/visits/bookings/${first.id}/cancel`, { body: { revision: 0 } });
  const second = await book(harness, { teamNumber: "2", teamName: "Two", contactEmail: "two@example.org" });
  await harness.job();
  assert.deepEqual(records(harness).map((row) => [row.booking_id, row.status, row.last_error]), [
    [first.id, "skipped", "Canceled visits are not recorded in Outreach"],
    [second.id, "delivered", null],
  ]);
  assert.equal((await detail(harness, first.id)).outreach, null);
  assert.deepEqual((await detail(harness, first.id)).attention, { state: "none", reason: null });
  assert.equal((await harness.call("DELETE", `/admin/visits/bookings/${second.id}?revision=0`)).status, 200);
  assert.deepEqual((await detail(harness, second.id)).attention, { state: "none", reason: null });
  assert.equal((await detail(harness, second.id)).outreach.state, "recorded");
});

test("Outreach refusals fail at once with Outreach's message; other failures retry with backoff; a lost team link is found again", async () => {
  const harness = await withOutreach({ granted: true });
  harness.outreach.teams.push({ id: "outreach-retired", number: "1234", name: "Gearheads", program: "FRC", archived: true });
  const refused = await book(harness);
  const flaky = await book(harness, { teamNumber: "77", teamName: "Lucky", contactEmail: "lucky@example.org" });
  harness.outreach.failures.push({ status: 500, operation: "ensure-team-support-activity", message: "Outreach could not complete the request (reference r-1)" });
  await harness.job();
  const failed = await detail(harness, refused.id);
  assert.deepEqual(failed.outreach, { state: "failed", activityId: null, error: "Supported team 1234 (FRC) is archived in Outreach. Restore it there first." });
  assert.deepEqual(records(harness).map((row) => [row.status, row.attempts, row.next_attempt_ms]), [["failed", 1, null], ["pending", 1, harness.clock.now + 300_000]]);
  assert.deepEqual((await detail(harness, flaky.id)).outreach, { state: "pending", activityId: null, error: "Outreach could not complete the request (reference r-1)" });
  assert.deepEqual((await harness.call("GET", "/admin/visits/bookings?scope=attention")).body.map((item: { id: string }) => item.id), [refused.id]);
  assert.equal((await harness.call("GET", "/admin/visits/status")).body.attentionCount, 1);
  // Not before its retry time; then it is recorded with the team linked on the first attempt.
  const calls = harness.outreach.calls.length;
  await harness.job();
  assert.equal(harness.outreach.calls.length, calls);
  harness.clock.now += 300_000;
  await harness.job();
  assert.deepEqual(operations(harness).slice(calls), ["ensure-team-support-activity"]);
  assert.equal((await detail(harness, flaky.id)).outreach.state, "recorded");
  // A network error without a status retries too.
  const network = await book(harness, { teamNumber: "88", teamName: "Eights", contactEmail: "eights@example.org" });
  harness.outreach.failures.push({ message: "The connection closed" });
  await harness.job();
  assert.deepEqual((await detail(harness, network.id)).outreach, { state: "pending", activityId: null, error: "The connection closed" });
  harness.clock.now += 300_000;
  await harness.job();
  assert.equal((await detail(harness, network.id)).outreach.state, "recorded");
  // Outreach no longer has the linked team: the next visit links the team again and is recorded.
  const linkOf = () => harness.db.rows<{ outreach_team_id: string }>("SELECT outreach_team_id FROM visits_teams WHERE number='88'")[0]!.outreach_team_id;
  const gone = linkOf();
  harness.outreach.teams = harness.outreach.teams.filter((team) => team.id !== gone);
  const next = await book(harness, { teamNumber: "88", teamName: "Eights", contactEmail: "eights@example.org", date: "2026-11-09" });
  const before = harness.outreach.calls.length;
  await harness.job();
  assert.deepEqual(operations(harness).slice(before), ["ensure-team-support-activity", "find-teams", "ensure-team", "ensure-team-support-activity"]);
  assert.notEqual(linkOf(), gone);
  assert.equal(linkOf(), harness.outreach.teams.at(-1)!.id);
  assert.equal((await detail(harness, next.id)).outreach.state, "recorded");
  // Staff mark the refused one handled: it leaves Needs attention but still shows as not recorded.
  await harness.call("POST", `/admin/visits/bookings/${refused.id}/handled`);
  assert.equal((await harness.call("GET", "/admin/visits/status")).body.attentionCount, 0);
  assert.equal((await detail(harness, refused.id)).outreach.state, "failed");
});

test("retries give up after the last attempt and wait for Record in Outreach", async () => {
  const harness = await withOutreach({ granted: true });
  const booked = await book(harness);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    harness.outreach.failures.push({ status: 503 });
    await harness.job();
    harness.clock.now += 6 * 3_600_000;
  }
  assert.deepEqual(records(harness).map((row) => [row.status, row.attempts]), [["failed", 8]]);
  const recorded = await harness.call("POST", "/admin/visits/outreach", { body: { bookingIds: [booked.id] } });
  assert.deepEqual(recorded.body, { results: [{ bookingId: booked.id, state: "recorded", activityId: "outreach-activity-1" }] });
  assert.deepEqual((await detail(harness, booked.id)).outreach, { state: "recorded", activityId: "outreach-activity-1" });
});

test("Record in Outreach catches up visits booked before the grant, with the grant or the staff member's own Outreach access", async () => {
  const harness = await withOutreach({ granted: false });
  const older = await book(harness);
  const other = await book(harness, { teamNumber: "SCOUTS", teamName: "Scout troop", program: "Other", contactEmail: "scouts@example.org" });
  const canceled = await book(harness, { teamNumber: "2", teamName: "Two", contactEmail: "two@example.org" });
  await harness.call("POST", `/admin/visits/bookings/${canceled.id}/cancel`, { body: { revision: 0 } });
  assert.deepEqual(records(harness), []);
  // An Operator without Outreach access, and no grant: refused with what to do.
  const refused = await harness.call("POST", "/admin/visits/outreach", { body: { bookingIds: [older.id] }, role: "operator" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, outreachAccessMessage);
  assert.match(outreachAccessMessage, /Settings > Modules > Module access/);
  assert.equal((await harness.call("POST", "/admin/visits/outreach", { body: { bookingIds: [] } })).status, 400);
  assert.equal((await harness.call("POST", "/admin/visits/outreach", { body: { bookingIds: [older.id], extra: 1 } })).status, 400);
  // With the Operator's own Outreach access, visits are recorded right away.
  harness.outreach.operatorAccess = true;
  const body = { bookingIds: [older.id, other.id, canceled.id, "missing", older.id] };
  const recorded = await harness.call("POST", "/admin/visits/outreach", { body, role: "operator" });
  assert.equal(recorded.status, 200);
  assert.deepEqual(recorded.body.results, [
    { bookingId: older.id, state: "recorded", activityId: "outreach-activity-1" },
    { bookingId: other.id, state: "skipped", activityId: null, error: "Outreach does not support teams with program Other" },
    { bookingId: canceled.id, state: "skipped", activityId: null, error: "Canceled visits are not recorded in Outreach" },
    { bookingId: "missing", state: "skipped", activityId: null, error: "This visit was not found" },
  ]);
  assert.deepEqual(harness.outreach.calls.map((call) => call.via), ["user", "user", "user"]);
  // Repeating changes nothing in Outreach.
  const again = await harness.call("POST", "/admin/visits/outreach", { body: { bookingIds: [older.id] }, role: "operator" });
  assert.deepEqual(again.body.results, [{ bookingId: older.id, state: "recorded", activityId: "outreach-activity-1" }]);
  assert.equal(harness.outreach.teams.length, 1);
  assert.equal(harness.outreach.activities.length, 1);
  // Without a grant nothing retries later, so a provider failure is final and Needs attention lists it.
  const later = await book(harness, { teamNumber: "3", teamName: "Three", contactEmail: "three@example.org" });
  harness.outreach.failures.push({ status: 500, message: "Outreach could not complete the request" });
  const failed = await harness.call("POST", "/admin/visits/outreach", { body: { bookingIds: [later.id] } });
  assert.deepEqual(failed.body.results, [{ bookingId: later.id, state: "failed", activityId: null, error: "Outreach could not complete the request" }]);
  assert.deepEqual((await harness.call("GET", "/admin/visits/bookings?scope=attention")).body.map((item: { id: string }) => [item.id, item.outreach.state]), [[later.id, "failed"]]);
  const retried = await harness.call("POST", "/admin/visits/outreach", { body: { bookingIds: [later.id] } });
  assert.equal(retried.body.results[0].state, "recorded");
  assert.deepEqual((await harness.call("GET", "/admin/visits/bookings?scope=attention")).body, []);
  assert.equal((await harness.job()).outreachGranted, false);
});

test("Record in Outreach records at most 50 visits at a time; with a grant the rest wait for the job", async () => {
  const harness = await withOutreach({ granted: true });
  harness.outreach.granted = false;
  const ids: string[] = [];
  for (let index = 0; index < 52; index += 1) ids.push((await book(harness, { teamNumber: String(1000 + index), teamName: `Team ${index}`, contactEmail: `team${index}@example.org`, date: index % 2 ? "2026-11-04" : "2026-11-02" })).id);
  const withoutGrant = await harness.call("POST", "/admin/visits/outreach", { body: { bookingIds: ids } });
  assert.deepEqual(withoutGrant.body.results.map((result: { state: string }) => result.state), [...Array(50).fill("recorded"), "skipped", "skipped"]);
  assert.match(withoutGrant.body.results[51].error, /at most 50 visits at a time/);
  harness.outreach.granted = true;
  await harness.job();
  const rest = await harness.call("POST", "/admin/visits/outreach", { body: { bookingIds: [...ids.slice(50), ...ids.slice(0, 50)] } });
  assert.deepEqual(rest.body.results.slice(0, 2).map((result: { state: string }) => result.state), ["recorded", "recorded"]);
  assert.deepEqual(rest.body.results.slice(50).map((result: { state: string }) => result.state), ["pending", "pending"]);
  await harness.job();
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_bookings WHERE outreach_activity_id IS NOT NULL"), 52);
  assert.equal(harness.outreach.activities.length, 52);
});

test("revoking the grant: nothing new is queued, waiting records stay until access returns, and Visits keeps working", async () => {
  const harness = await withOutreach({ granted: true });
  const waiting = await book(harness);
  harness.outreach.granted = false;
  const pass = await harness.job();
  assert.equal(pass.outreachGranted, false);
  assert.deepEqual(stored(harness), { outreach_granted: 0, outreach_checked_ms: harness.clock.now });
  assert.deepEqual(records(harness).map((row) => row.status), ["pending"]);
  assert.deepEqual(harness.outreach.calls, []);
  const later = await book(harness, { teamNumber: "2", teamName: "Two", contactEmail: "two@example.org" });
  await harness.call("PUT", `/admin/visits/bookings/${waiting.id}`, { body: { revision: 0, date: "2026-11-04", arrival: "18:00", departure: "19:00" } });
  assert.equal(records(harness).length, 1, "nothing new is queued");
  assert.deepEqual(await status(harness), { available: true, granted: false });
  assert.deepEqual(await status(harness, "operator"), { available: false, granted: false });
  // Granted again, the waiting record is done on its visit's current date; the later booking needs Record in Outreach.
  harness.outreach.granted = true;
  await harness.job();
  assert.deepEqual(harness.outreach.activities.map((activity) => activity.serviceDate), ["2026-11-04"]);
  assert.equal((await detail(harness, later.id)).outreach, null);
  // Outreach disabled: bookings and the job carry on, and nothing is queued.
  harness.outreach.ready = false;
  const third = await book(harness, { teamNumber: "3", teamName: "Three", contactEmail: "three@example.org" });
  const after = await harness.job();
  assert.equal(after.outreachGranted, false);
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_notifications WHERE channel='outreach' AND booking_id=?", third.id), 0);
  assert.deepEqual(await status(harness), { available: false, granted: false });
  assert.equal(harness.email.sent.length, 4);
});

test("a workspace request without any Outreach client forgets a stale grant; one with the staff member's own access keeps the stored answer", async () => {
  const harness = await withOutreach({ granted: false });
  harness.db.exec("UPDATE visits_settings SET outreach_granted=1");
  // An Admin's own access gives a client, which says nothing about the grant.
  assert.deepEqual(await status(harness), { available: true, granted: true });
  // No client at all means there is no grant.
  assert.deepEqual(await status(harness, "operator"), { available: false, granted: false });
  assert.equal(stored(harness).outreach_granted, 0);
});

test("a visit moved while it is being recorded is recorded on its new date, and the activity created meanwhile needs attention", async () => {
  const harness = await withOutreach({ granted: true });
  const booked = await book(harness);
  let moved = false;
  harness.outreach.beforeAnswer = async (operation) => {
    if (operation !== "ensure-team-support-activity" || moved) return;
    moved = true;
    const response = await harness.call("PUT", `/admin/visits/bookings/${booked.id}`, { body: { revision: 0, date: "2026-11-04", arrival: "18:00", departure: "19:00" } });
    assert.equal(response.status, 200);
  };
  await harness.job();
  assert.deepEqual(records(harness).map((row) => [row.status, row.last_error]), [
    ["skipped", "The visit changed while it was recorded on 2026-11-02; a newer record follows the change"],
    ["pending", null],
  ]);
  let shown = await detail(harness, booked.id);
  assert.deepEqual(shown.outreach, { state: "pending", activityId: null });
  assert.deepEqual(shown.attention, { state: "needed", reason: "outreach-activity-kept" });
  await harness.job();
  shown = await detail(harness, booked.id);
  assert.deepEqual(shown.outreach, { state: "recorded", activityId: "outreach-activity-2" });
  assert.deepEqual(harness.outreach.activities.map((activity) => activity.serviceDate), ["2026-11-02", "2026-11-04"]);
});

test("an Outreach record whose sender stopped gives way to a newer waiting record of the same visit", async () => {
  const harness = await withOutreach({ granted: true });
  const booked = await book(harness);
  // The first record was taken by a sender that stopped; a later change queued another.
  harness.db.exec(`UPDATE visits_notifications SET status='sending',next_attempt_ms=NULL,lease_token='lease-token-0001',lease_expires_ms=${harness.clock.now - 1} WHERE channel='outreach'`);
  harness.db.prepare("INSERT INTO visits_notifications(installation_id,id,channel,kind,booking_id,status,next_attempt_ms,created_at,updated_at) VALUES('primary','newer','outreach','outreach-record',?,'pending',?,?,?)")
    .bind(booked.id, harness.clock.now, new Date(harness.clock.now + 1).toISOString(), new Date(harness.clock.now + 1).toISOString()).run();
  const pass = await harness.job();
  assert.equal(pass.recovered, 0);
  assert.deepEqual(records(harness).map((row) => row.status), ["skipped", "delivered"]);
  // A retried record also gives way when another one waits.
  const second = await book(harness, { teamNumber: "2", teamName: "Two", contactEmail: "two@example.org" });
  let queued = false;
  harness.outreach.beforeAnswer = async () => {
    if (queued) return;
    queued = true;
    // While the first record is being sent, the visit moves (queueing another record) and Outreach then fails.
    await harness.call("PUT", `/admin/visits/bookings/${second.id}`, { body: { revision: 0, date: "2026-11-04", arrival: "18:00", departure: "19:00" } });
    harness.outreach.failures.push({ status: 500 });
  };
  await harness.job();
  const rows = records(harness).filter((row) => row.booking_id === second.id);
  assert.deepEqual(rows.map((row) => [row.status, row.last_error]), [["skipped", "A newer Outreach record of this visit replaced this one"], ["pending", null]]);
});

test("merging a team recorded under another Outreach team records its visits again for the kept team", async () => {
  const harness = await withOutreach({ granted: true });
  const typo = await book(harness, { teamNumber: "1243" });
  const keep = await book(harness, { contactEmail: "keep@example.org", date: "2026-11-04" });
  await harness.job();
  const teams = (await harness.call("GET", "/admin/visits/teams")).body as { id: string; number: string; outreachTeamId: string }[];
  const from = teams.find((team) => team.number === "1243")!;
  const into = teams.find((team) => team.number === "1234")!;
  assert.notEqual(from.outreachTeamId, into.outreachTeamId);
  assert.equal((await harness.call("POST", `/admin/visits/teams/${from.id}/merge`, { body: { intoId: into.id } })).status, 200);
  let shown = await detail(harness, typo.id);
  assert.deepEqual([shown.team.number, shown.outreach, shown.attention], ["1234", { state: "pending", activityId: null }, { state: "needed", reason: "outreach-activity-kept" }]);
  await harness.job();
  shown = await detail(harness, typo.id);
  assert.equal(shown.outreach.state, "recorded");
  assert.equal(harness.outreach.activities.find((activity) => activity.id === shown.outreach.activityId)!.teamId, into.outreachTeamId);
  assert.equal((await detail(harness, keep.id)).outreach.state, "recorded");
});

test("a visit's Outreach state, and a restore forgetting the grant", () => {
  const base = { program: "FRC" as const, activityId: null, status: null, error: null, handled: false };
  assert.equal(outreachState({ ...base, program: "Other", activityId: "a-1" }), null);
  assert.equal(outreachState(base), null);
  assert.deepEqual(outreachState({ ...base, activityId: "a-1" }), { state: "recorded", activityId: "a-1" });
  assert.deepEqual(outreachState({ ...base, status: "sending" }), { state: "pending", activityId: null });
  assert.deepEqual(outreachState({ ...base, status: "skipped", error: "Refused", handled: true }), { state: "failed", activityId: null, error: "Refused" });
  assert.deepEqual(outreachState({ ...base, status: "skipped", error: "Canceled visits are not recorded in Outreach" }), null);
  assert.equal(outreachState({ ...base, status: "paused" })!.state, "failed");
  const restored = neutralizeVisitsBackup({ visits_settings: [{ installation_id: "primary", outreach_granted: 1, outreach_checked_ms: 5, intro_text: "Hi" }], visits_notifications: [] });
  assert.deepEqual(restored.visits_settings, [{ installation_id: "primary", outreach_granted: 0, outreach_checked_ms: null, intro_text: "Hi" }]);
});
