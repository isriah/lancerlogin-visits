// The staff workspace, Admin settings and setup through the Worker routes: availability and Needs attention, staff changes
// to visits, guest teams, roles and origins, setup steps and the report projection.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { book, dashboardOrigin, FakeEmail, shopSeries, visitsHarness, withShopSeries, type Harness } from "./helpers/visits-harness.ts";
import { civil, newYork } from "./helpers/civil-time.ts";
import { visitReportLabel, visitReportRecords, visitReportValues } from "../src/api/visits-reports.ts";
import { setupStepSql, visitsSetupStepValid } from "../src/api/visits-settings.ts";
import { visitReportDataset, visitReportFields } from "../src/shared/visits-report-fields.ts";
import manifest from "../src/manifest.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const windowOn = async (harness: Harness, date: string) => (await harness.call("GET", `/admin/visits/overview?from=${date}&to=${date}`)).body.windows[0];
const detail = async (harness: Harness, id: string) => (await harness.call("GET", `/admin/visits/bookings/${id}`)).body;

test("canceling a window puts its visits in Needs attention, restoring clears it, and handled stays handled", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  const booked = await book(harness);
  const monday = await windowOn(harness, "2026-11-02");
  assert.equal(monday.bookedCount, 1);
  const canceled = await harness.call("POST", `/admin/visits/windows/${monday.id}/cancel`, { body: { reason: "Thanksgiving break", revision: 0 } });
  assert.equal(canceled.status, 200);
  assert.equal(canceled.body.status, "canceled");
  assert.equal(canceled.body.cancelReason, "Thanksgiving break");
  assert.deepEqual((await detail(harness, booked.id)).attention, { state: "needed", reason: "window-canceled" });
  assert.deepEqual((await harness.call("GET", "/admin/visits/bookings?scope=attention")).body.map((item: { id: string }) => item.id), [booked.id]);
  // The guest page lists the canceled window with its reason and without its visits.
  const calendar = (await harness.call("GET", "/public/visits/calendar", { role: null })).body;
  assert.deepEqual({ status: calendar.windows[0].status, reason: calendar.windows[0].cancelReason, visits: calendar.windows[0].visits }, { status: "canceled", reason: "Thanksgiving break", visits: [] });
  // A stale revision and a second cancel are refused.
  assert.equal((await harness.call("POST", `/admin/visits/windows/${monday.id}/cancel`, { body: { reason: "Again", revision: 0 } })).status, 409);
  assert.equal((await harness.call("POST", `/admin/visits/bookings/${booked.id}/handled`)).body.attention.state, "handled");
  assert.equal((await harness.call("GET", "/admin/visits/bookings?scope=attention")).body.length, 0);
  const restored = await harness.call("POST", `/admin/visits/windows/${monday.id}/restore`, { body: { revision: 1 } });
  assert.equal(restored.body.status, "open");
  assert.deepEqual((await detail(harness, booked.id)).attention, { state: "none", reason: null });
  // Staff changes to availability send guests nothing.
  assert.equal(harness.email.sent.length, 1);
});

test("editing or removing a window updates the attention of the visits in it", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  const booked = await book(harness);
  const monday = await windowOn(harness, "2026-11-02");
  const shorter = await harness.call("PUT", `/admin/visits/windows/${monday.id}`, { body: { date: "2026-11-02", startTime: "19:00", endTime: "21:00", title: "Late shop", revision: 0 } });
  assert.equal(shorter.status, 200);
  assert.equal(shorter.body.edited, true);
  assert.equal(shorter.body.startTime, "19:00");
  assert.deepEqual((await detail(harness, booked.id)).attention, { state: "needed", reason: "window-changed" });
  await harness.call("PUT", `/admin/visits/windows/${monday.id}`, { body: { date: "2026-11-02", startTime: "18:00", endTime: "21:00", title: "Late shop", revision: 1 } });
  assert.deepEqual((await detail(harness, booked.id)).attention, { state: "none", reason: null });
  // Overlaps are refused.
  const overlap = await harness.call("POST", "/admin/visits/windows", { body: { date: "2026-11-02", startTime: "20:00", endTime: "22:00" } });
  assert.equal(overlap.status, 409);
  assert.equal(overlap.body.error, "These times overlap another window on Monday, November 2");
  // Removing a window with visits keeps it for their history; a window without visits is deleted.
  assert.equal((await harness.call("DELETE", `/admin/visits/windows/${monday.id}?revision=1`)).status, 409);
  const removed = await harness.call("DELETE", `/admin/visits/windows/${monday.id}?revision=2`);
  assert.deepEqual(removed.body, { removed: true, id: monday.id });
  assert.equal(harness.db.rows<{ status: string }>("SELECT status FROM visits_windows WHERE id=?", monday.id)[0]!.status, "removed");
  assert.deepEqual((await detail(harness, booked.id)).attention, { state: "needed", reason: "window-removed" });
  const wednesday = await windowOn(harness, "2026-11-04");
  await harness.call("DELETE", `/admin/visits/windows/${wednesday.id}?revision=0`);
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_windows WHERE id=?", wednesday.id), 0);
  // Removed windows leave the overview and free their time.
  assert.equal(await windowOn(harness, "2026-11-02"), undefined);
  assert.equal((await harness.call("POST", "/admin/visits/windows", { body: { date: "2026-11-02", startTime: "10:00", endTime: "20:00", title: "Saturday" } })).status, 201);
});

test("a series edit changes only its future, unedited, open windows, in removal, update and insert order", async () => {
  const harness = visitsHarness();
  const series = await withShopSeries(harness);
  assert.equal(series.windowCount, 14);
  const booked = await book(harness, { date: "2026-11-04", arrival: "18:00", departure: "19:00" });
  const thanksgiving = await windowOn(harness, "2026-11-25");
  await harness.call("POST", `/admin/visits/windows/${thanksgiving.id}/cancel`, { body: { reason: "Thanksgiving", revision: 0 } });
  const edited = await windowOn(harness, "2026-11-09");
  await harness.call("PUT", `/admin/visits/windows/${edited.id}`, { body: { date: "2026-11-09", startTime: "17:00", endTime: "20:00", title: "Edited", revision: 0 } });
  // A one-off window on a Friday blocks moving the series onto Fridays at the same time.
  await harness.call("POST", "/admin/visits/windows", { body: { date: "2026-11-06", startTime: "18:30", endTime: "19:30" } });
  const blocked = await harness.call("PUT", `/admin/visits/series/${series.id}`, { body: { ...shopSeries, weekdays: [1, 5], revision: 0 } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, "These times overlap another window on Friday, November 6");
  // Wednesdays start at 19:00 now; Mondays stay, Thanksgiving stays canceled and the edited window stays edited.
  const saved = await harness.call("PUT", `/admin/visits/series/${series.id}`, { body: { ...shopSeries, startTime: "19:00", title: "Evening shop", revision: 0 } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, 1);
  const windows = (await harness.call("GET", "/admin/visits/overview?from=2026-11-01&to=2026-12-31")).body.windows;
  const byDate = new Map(windows.map((window: { date: string }) => [window.date, window]));
  assert.deepEqual([byDate.get("2026-11-04")].map((window: any) => [window.startTime, window.title, window.status]), [["19:00", "Evening shop", "open"]]);
  assert.deepEqual([byDate.get("2026-11-25")].map((window: any) => [window.startTime, window.status, window.cancelReason]), [["18:00", "canceled", "Thanksgiving"]]);
  assert.deepEqual([byDate.get("2026-11-09")].map((window: any) => [window.startTime, window.title]), [["17:00", "Edited"]]);
  // The visit no longer fits its window.
  assert.deepEqual((await detail(harness, booked.id)).attention, { state: "needed", reason: "window-changed" });
  // Dropping Wednesdays removes them: the one with a visit is kept, removed; the others are deleted.
  const mondays = await harness.call("PUT", `/admin/visits/series/${series.id}`, { body: { ...shopSeries, weekdays: [1], revision: 1 } });
  assert.equal(mondays.status, 200);
  assert.equal(mondays.body.windowCount, 7 + 1);
  assert.deepEqual((await detail(harness, booked.id)).attention, { state: "needed", reason: "window-removed" });
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_windows WHERE status='removed'"), 1);
  // Deleting the series keeps the windows it may not change as one-off windows.
  assert.equal((await harness.call("DELETE", `/admin/visits/series/${series.id}?revision=1`)).status, 409);
  assert.deepEqual((await harness.call("DELETE", `/admin/visits/series/${series.id}?revision=2`)).body, { removed: true, id: series.id });
  assert.deepEqual((await harness.call("GET", "/admin/visits/series")).body, []);
  const left = (await harness.call("GET", "/admin/visits/overview?from=2026-11-01&to=2026-12-31")).body.windows.map((window: { date: string; seriesId: string | null }) => [window.date, window.seriesId]);
  assert.deepEqual(left, [["2026-11-06", null], ["2026-11-09", null], ["2026-11-25", null]]);
});

test("staff edit visits; correcting the email address revokes every earlier link and sends a fresh one to the new address", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  const booked = await book(harness);
  const oldToken = FakeEmail.token(harness.email.sent[0]!);
  const edited = await harness.call("PUT", `/admin/visits/bookings/${booked.id}`, { body: { revision: 0, contactEmail: "coach@example.org", headcount: 20 } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.contactEmail, "coach@example.org");
  assert.equal(edited.body.revision, 1);
  assert.equal(edited.body.email, "sent");
  assert.deepEqual(edited.body.history.map((entry: { action: string; actor: unknown }) => [entry.action, entry.actor]), [["updated", { kind: "staff", name: null }], ["created", { kind: "guest" }]]);
  assert.deepEqual(edited.body.history[0].changes.map((change: { field: string }) => change.field), ["contactEmail", "headcount"]);
  const refused = await harness.call("POST", "/public/visits/manage", { body: { token: oldToken }, role: null });
  assert.equal(refused.status, 403);
  assert.equal(harness.email.sent[1]!.to, "coach@example.org");
  const freshToken = FakeEmail.token(harness.email.sent[1]!);
  assert.equal((await harness.call("POST", "/public/visits/manage", { body: { token: freshToken }, role: null })).status, 200);
  assert.ok(harness.db.rows<{ revoked_ms: number | null }>("SELECT revoked_ms FROM visits_manage_tokens WHERE token_hash=?", sha256(oldToken))[0]!.revoked_ms);
  // Staff may move a visit only into an open window; a stale edit is refused.
  assert.equal((await harness.call("PUT", `/admin/visits/bookings/${booked.id}`, { body: { revision: 1, date: "2026-11-03", arrival: "18:00", departure: "19:00" } })).status, 400);
  assert.equal((await harness.call("PUT", `/admin/visits/bookings/${booked.id}`, { body: { revision: 0, headcount: 2 } })).status, 409);
  // A team change must name an active team.
  assert.equal((await harness.call("PUT", `/admin/visits/bookings/${booked.id}`, { body: { revision: 1, teamId: "missing" } })).status, 400);
});

test("staff cancel, remove and restore visits from their history; removed visits leave every list", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  const booked = await book(harness);
  await harness.call("PUT", `/admin/visits/bookings/${booked.id}`, { body: { revision: 0, headcount: 30 } });
  const canceled = await harness.call("POST", `/admin/visits/bookings/${booked.id}/cancel`, { body: { revision: 1 } });
  assert.equal(canceled.body.status, "canceled");
  assert.match(harness.email.sent.at(-1)!.subject, /^Canceled:/);
  assert.equal((await harness.call("PUT", `/admin/visits/bookings/${booked.id}`, { body: { revision: 2, headcount: 3 } })).status, 409);
  // Restore the first version: booked, 12 people. The team gets a confirmation.
  const restored = await harness.call("POST", `/admin/visits/bookings/${booked.id}/restore`, { body: { revisionId: "0", revision: 2 } });
  assert.equal(restored.status, 200);
  assert.deepEqual([restored.body.status, restored.body.headcount, restored.body.revision], ["booked", 12, 3]);
  assert.match(harness.email.sent.at(-1)!.subject, /^Your visit to/);
  // Remove: canceled silently and hidden from every list, history kept.
  const sentBefore = harness.email.sent.length;
  assert.deepEqual((await harness.call("DELETE", `/admin/visits/bookings/${booked.id}?revision=3`)).body, { removed: true, id: booked.id });
  assert.equal(harness.email.sent.length, sentBefore);
  for (const scope of ["upcoming", "past", "attention"]) assert.equal((await harness.call("GET", `/admin/visits/bookings?scope=${scope}`)).body.length, 0, scope);
  // Only the Removed list shows it, marked removed, so staff can open its history and restore it.
  const removedList = (await harness.call("GET", "/admin/visits/bookings?scope=removed")).body;
  assert.deepEqual(removedList.map((item: { id: string; removed: boolean; status: string }) => [item.id, item.removed, item.status]), [[booked.id, true, "canceled"]]);
  assert.equal((await harness.call("GET", "/admin/visits/bookings?scope=deleted")).status, 400);
  assert.equal((await harness.call("GET", "/admin/visits/overview")).body.bookings.length, 0);
  const calendar = (await harness.call("GET", "/public/visits/calendar", { role: null })).body;
  assert.equal(calendar.windows[0].teamCount, 0);
  // Its links stop working while it is removed.
  const token = FakeEmail.token(harness.email.sent[0]!);
  assert.equal((await harness.call("POST", "/public/visits/manage", { body: { token }, role: null })).status, 403);
  const removedDetail = await detail(harness, booked.id);
  assert.equal(removedDetail.status, "canceled");
  assert.deepEqual(removedDetail.history.map((entry: { action: string }) => entry.action), ["removed", "restored", "canceled", "updated", "created"]);
  // Restoring brings it back everywhere.
  await harness.call("POST", `/admin/visits/bookings/${booked.id}/restore`, { body: { revisionId: 3, revision: 4 } });
  assert.deepEqual((await harness.call("GET", "/admin/visits/bookings?scope=upcoming")).body.map((item: { removed: boolean }) => item.removed), [false]);
  assert.equal((await harness.call("GET", "/admin/visits/bookings?scope=removed")).body.length, 0);
  assert.equal((await harness.call("POST", "/public/visits/manage", { body: { token }, role: null })).status, 200);
  assert.equal((await harness.call("POST", `/admin/visits/bookings/${booked.id}/restore`, { body: { revisionId: 99, revision: 5 } })).status, 404);
});

test("guest teams: rename, and merge a duplicate whose visits move with history", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  const first = await book(harness);
  await book(harness, { teamNumber: "1243", teamName: "Gear heads", contactEmail: "typo@example.org" });
  await book(harness, { teamNumber: "8", teamName: "FTC Eight", program: "FTC", contactEmail: "eight@example.org" });
  const teams = (await harness.call("GET", "/admin/visits/teams")).body;
  const keep = teams.find((team: { number: string }) => team.number === "1234");
  const duplicate = teams.find((team: { number: string }) => team.number === "1243");
  const ftc = teams.find((team: { number: string }) => team.program === "FTC");
  assert.equal((await harness.call("PUT", `/admin/visits/teams/${keep.id}`, { body: { name: " The Gearheads ", revision: 0 } })).body.name, "The Gearheads");
  assert.equal((await harness.call("PUT", `/admin/visits/teams/${keep.id}`, { body: { name: "Stale", revision: 0 } })).status, 409);
  assert.equal((await harness.call("POST", `/admin/visits/teams/${duplicate.id}/merge`, { body: { intoId: ftc.id } })).status, 400);
  const merged = await harness.call("POST", `/admin/visits/teams/${duplicate.id}/merge`, { body: { intoId: keep.id } });
  assert.equal(merged.status, 200);
  assert.equal(merged.body.visitCount, 2);
  const after = (await harness.call("GET", "/admin/visits/teams")).body;
  assert.equal(after.find((team: { id: string }) => team.id === duplicate.id).archived, true);
  const moved = harness.db.rows<{ id: string; revision: number }>("SELECT id, revision FROM visits_bookings WHERE team_id=? AND id!=?", keep.id, first.id)[0]!;
  assert.equal(moved.revision, 1);
  assert.deepEqual((await detail(harness, moved.id)).history[0].changes, [{ field: "teamId", from: duplicate.id, to: keep.id }]);
  // The archived team's number is free again.
  await book(harness, { teamNumber: "1243", teamName: "Real 1243", contactEmail: "real@example.org" });
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_teams WHERE number='1243'"), 2);
  assert.equal((await harness.call("POST", `/admin/visits/teams/${duplicate.id}/merge`, { body: { intoId: keep.id } })).status, 409);
});

test("roles and origins: staff routes for Admins and Operators, settings for Admins, and every change from the dashboard", async () => {
  const harness = visitsHarness();
  const operator = { role: "operator" as const };
  assert.equal((await harness.call("POST", "/admin/visits/series", { body: shopSeries, ...operator })).status, 201);
  assert.equal((await harness.call("GET", "/admin/visits/status", operator)).status, 200);
  assert.equal((await harness.call("GET", "/admin/visits/status", { role: null })).status, 401);
  assert.equal((await harness.call("GET", "/admin/visits/settings", operator)).status, 403);
  assert.equal((await harness.call("PUT", "/admin/visits/settings", { body: { revision: 0, introText: "Hi" }, ...operator })).status, 403);
  assert.equal((await harness.call("POST", "/admin/visits/settings/test-email", { body: { to: "a@example.org" }, ...operator })).status, 403);
  assert.equal((await harness.call("GET", "/module-setup/visits/status", operator)).status, 403);
  assert.equal((await harness.call("POST", "/admin/visits/windows", { body: { date: "2026-11-07", startTime: "10:00", endTime: "12:00" }, origin: "https://evil.example" })).status, 403);
  assert.equal((await harness.call("PUT", "/admin/visits/settings", { body: { revision: 0, introText: "Hi" }, origin: null })).status, 403);
  assert.equal((await harness.call("GET", "/admin/visits/nothing-here")).status, 404);
  assert.equal((await harness.call("PATCH", "/admin/visits/series")).status, 405);
  assert.equal((await harness.call("POST", "/admin/visits/outreach", { body: { bookingIds: ["booking-1"] } })).status, 409, "without Outreach");
  assert.deepEqual((await harness.call("GET", "/admin/visits/status")).body.outreach, { available: false, granted: false });
});

test("Admins change settings with the current revision; Discord needs a channel; the guest page shows the intro", async () => {
  const harness = visitsHarness();
  const initial = (await harness.call("GET", "/admin/visits/settings")).body;
  assert.deepEqual(initial, { revision: 0, hostName: "", introText: "", replyTo: "", testEmailSentMs: null, discordEnabled: false, discordChannelId: "", weeklySummaryEnabled: true, weeklySummaryWeekday: 1, weeklySummaryTime: "12:00" });
  assert.equal((await harness.call("PUT", "/admin/visits/settings", { body: { revision: 0, discordEnabled: true } })).body.field, "discordChannelId");
  assert.equal((await harness.call("PUT", "/admin/visits/settings", { body: { revision: 0, replyTo: "nope" } })).body.field, "replyTo");
  assert.equal((await harness.call("PUT", "/admin/visits/settings", { body: { revision: 0, weeklySummaryTime: "25:00" } })).body.field, "weeklySummaryTime");
  assert.equal((await harness.call("PUT", "/admin/visits/settings", { body: { revision: 0, color: "red" } })).body.field, "color");
  assert.equal((await harness.call("PUT", "/admin/visits/settings", { body: { revision: 0, hostName: "x".repeat(81) } })).body.field, "hostName");
  assert.equal((await harness.call("PUT", "/admin/visits/settings", { body: { revision: 0, hostName: 321 } })).body.field, "hostName");
  const saved = await harness.call("PUT", "/admin/visits/settings", { body: { revision: 0, introText: "Welcome,\r\nguests!", replyTo: " coach@example.org ", discordEnabled: true, discordChannelId: "123456789012345678" } });
  assert.equal(saved.status, 200);
  assert.deepEqual({ ...saved.body }, { ...initial, revision: 1, introText: "Welcome,\nguests!", replyTo: "coach@example.org", discordEnabled: true, discordChannelId: "123456789012345678" });
  assert.equal((await harness.call("PUT", "/admin/visits/settings", { body: { revision: 0, introText: "Lost" } })).status, 409);
  assert.equal((await harness.call("GET", "/public/visits/calendar", { role: null })).body.introText, "Welcome,\nguests!");
  // The reply-to address goes on guest emails.
  await withShopSeries(harness);
  await book(harness);
  assert.equal(harness.email.sent[0]!.replyTo, "coach@example.org");
});

test("setup: the test email and the first availability complete the steps", async () => {
  const harness = visitsHarness();
  const valid = async (step: string) => visitsSetupStepValid(harness.db as never, step);
  const predicate = (step: keyof typeof setupStepSql) => harness.db.rows<{ ok: number }>(`SELECT ${setupStepSql[step]} AS ok`, "primary")[0]!.ok;
  assert.deepEqual([await valid("email"), await valid("availability"), predicate("email"), predicate("availability")], [false, false, 0, 0]);
  assert.deepEqual((await harness.call("GET", "/module-setup/visits/status")).body, { emailReady: true, testEmailSentMs: null, windowCount: 0, timeZone: newYork });
  harness.email.readyValue = false;
  assert.equal((await harness.call("POST", "/module-setup/visits/test-email", { body: { to: "admin@example.org" } })).status, 409);
  harness.email.readyValue = true;
  harness.email.failures.push({ status: 403 });
  const refused = await harness.call("POST", "/module-setup/visits/test-email", { body: { to: "admin@example.org" } });
  assert.equal(refused.status, 502);
  assert.match(refused.body.error, /Resend refused the test email \(403\)/);
  assert.equal(await valid("email"), false);
  const sent = await harness.call("POST", "/module-setup/visits/test-email", { body: { to: "admin@example.org" } });
  assert.deepEqual(sent.body, { sent: true, testEmailSentMs: harness.clock.now });
  assert.equal(harness.email.sent[0]!.subject, "Guest Visits test email");
  assert.deepEqual([await valid("email"), predicate("email")], [true, 1]);
  assert.equal((await harness.call("POST", "/module-setup/visits/windows", { body: { date: "2026-11-07", startTime: "10:00", endTime: "14:00", title: "Saturday" } })).status, 201);
  assert.deepEqual([await valid("availability"), predicate("availability")], [true, 1]);
  assert.equal((await harness.call("POST", "/module-setup/visits/series", { body: shopSeries })).status, 201);
  assert.equal((await harness.call("GET", "/module-setup/visits/status")).body.windowCount, 15);
  assert.equal(await valid("unknown"), false);
  assert.equal((await harness.call("POST", "/module-setup/visits/series", { body: shopSeries, origin: dashboardOrigin.replace("visits", "evil") })).status, 403);
  // The manifest declares exactly these steps, the job and the report.
  assert.deepEqual(manifest.setup.steps.map((step) => [step.id, step.label, step.required]), [["email", "Email confirmations", true], ["availability", "First availability window", true]]);
  assert.deepEqual(manifest.jobs, [{ id: "visits.notifications", interval: 300_000, label: "Guest visit notifications" }]);
});

test("the visits.bookings report lists visits by local date within the report period", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  const first = await book(harness);
  const second = await book(harness, { teamNumber: "7", teamName: "Lucky", program: "Challenge", contactEmail: "lucky@example.org", date: "2026-11-04", arrival: "18:00", departure: "20:30", headcount: 1 });
  await harness.call("POST", `/admin/visits/bookings/${second.id}/cancel`, { body: { revision: 0 } });
  const third = await book(harness, { teamNumber: "9", teamName: "Gone", contactEmail: "gone@example.org", date: "2026-11-09" });
  await harness.call("DELETE", `/admin/visits/bookings/${third.id}?revision=0`);
  const records = await visitReportRecords(harness.db as never, civil, newYork, { to: "2026-12-31" });
  assert.deepEqual(records.map((record) => [record.id, record.date, record.status]), [[first.id, "2026-11-02", "booked"], [second.id, "2026-11-04", "canceled"]]);
  assert.deepEqual((await visitReportRecords(harness.db as never, civil, newYork, { from: "2026-11-03", to: "2026-11-30" })).map((record) => record.id), [second.id]);
  assert.deepEqual((await visitReportRecords(harness.db as never, civil, newYork, { to: "2026-11-01" })), []);
  const values = visitReportValues(records[1]!);
  assert.deepEqual(Object.keys(values).sort(), visitReportDataset.fields.map((field) => field.id).sort());
  assert.deepEqual(values[visitReportFields.duration], { text: "150", sortValue: 150 });
  assert.deepEqual(values[visitReportFields.program], { text: "FIRST LEGO League Challenge", sortValue: "first lego league challenge" });
  assert.deepEqual([values[visitReportFields.arrival]!.text, values[visitReportFields.departure]!.text, values[visitReportFields.status]!.text, values[visitReportFields.outreach]!.text], ["18:00", "20:30", "Canceled", "No"]);
  assert.equal(visitReportLabel(records[1]!), "FLL Challenge 7 Lucky on 2026-11-04");
  assert.deepEqual(manifest.reportDatasets.map((dataset) => [dataset.id, dataset.capability, dataset.rowIdentity, dataset.filters]), [["visits.bookings", "visits.manage", "visits.booking.id", ["period"]]]);
});

test("the host team's name from settings heads the guest page and names the host in guest emails", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  // Without a name, guests visit "our team".
  const first = await book(harness);
  assert.equal(harness.email.sent[0]!.subject, "Your visit to our team on Monday, November 2");
  assert.equal((await harness.call("GET", "/public/visits/calendar", { role: null })).body.hostName, "");
  const saved = await harness.call("PUT", "/admin/visits/settings", { body: { revision: 0, hostName: "  FRC 321\r\nLancers " } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.hostName, "FRC 321 Lancers");
  assert.equal((await harness.call("GET", "/public/visits/calendar", { role: null })).body.hostName, "FRC 321 Lancers");
  const token = FakeEmail.token(harness.email.sent[0]!);
  assert.equal((await harness.call("POST", "/public/visits/manage", { body: { token }, role: null })).body.hostName, "FRC 321 Lancers");
  // Every later email names the host in its subject and text, HTML-escaped in its HTML.
  await harness.call("PUT", `/admin/visits/bookings/${first.id}`, { body: { revision: 0, headcount: 14 } });
  const update = harness.email.sent.at(-1)!;
  assert.equal(update.subject, "Updated: your visit to FRC 321 Lancers on Monday, November 2");
  assert.match(update.text!, /Your visit to FRC 321 Lancers was changed \(headcount\)/);
  await harness.call("PUT", "/admin/visits/settings", { body: { revision: 1, hostName: "Lancers <321> & friends" } });
  await harness.call("POST", `/admin/visits/bookings/${first.id}/cancel`, { body: { revision: 1 } });
  const canceled = harness.email.sent.at(-1)!;
  assert.equal(canceled.subject, "Canceled: your visit to Lancers <321> & friends on Monday, November 2");
  assert.match(canceled.html!, /Your visit to Lancers &lt;321&gt; &amp; friends is canceled/);
  // Clearing the name goes back to "our team".
  await harness.call("PUT", "/admin/visits/settings", { body: { revision: 2, hostName: "" } });
  await book(harness, { teamNumber: "8", teamName: "Eights", contactEmail: "eight@example.org" });
  assert.equal(harness.email.sent.at(-1)!.subject, "Your visit to our team on Monday, November 2");
});

test("after a restore, a paused email puts its visit in Needs attention until staff resend it or mark it handled", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  const first = await book(harness);
  const second = await book(harness, { teamNumber: "8", teamName: "Eights", contactEmail: "eight@example.org" });
  // A restore pauses waiting emails (neutralizeVisitsBackup); here both visits' latest emails are paused.
  harness.db.sqlite.exec("UPDATE visits_notifications SET status='paused',next_attempt_ms=NULL WHERE channel='email'");
  const sent = harness.email.sent.length;
  await harness.job();
  assert.equal(harness.email.sent.length, sent, "nothing sends a paused email");
  const attention = (await harness.call("GET", "/admin/visits/bookings?scope=attention")).body;
  assert.deepEqual(attention.map((item: { id: string; email: string }) => [item.id, item.email]).sort(), [[first.id, "paused"], [second.id, "paused"]].sort());
  assert.equal((await harness.call("GET", "/admin/visits/status")).body.attentionCount, 2);
  // Resending sends a fresh link; marking handled stops the paused email from asking again.
  assert.equal((await harness.call("POST", `/admin/visits/bookings/${first.id}/resend`)).body.email, "sent");
  const handled = await harness.call("POST", `/admin/visits/bookings/${second.id}/handled`);
  assert.equal(handled.body.email, "failed");
  assert.deepEqual((await harness.call("GET", "/admin/visits/bookings?scope=attention")).body, []);
  assert.equal(harness.email.sent.length, sent + 1);
});
