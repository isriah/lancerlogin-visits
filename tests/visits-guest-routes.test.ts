// The guest page and manage page through the Worker routes: booking, idempotent submission, refusals, what the public
// page shows, the origin check and manage-link tokens.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { book, bookingRequest, dashboardOrigin, FakeEmail, visitsHarness, withShopSeries, type Harness } from "./helpers/visits-harness.ts";
import { manageTokenRefusedMessage } from "../src/shared/visits-tokens.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const manage = (harness: Harness, path: string, body: unknown, origin: string | null = dashboardOrigin) => harness.call("POST", `/public/visits/${path}`, { body, role: null, origin });

test("a guest books a visit: one batch saves it, and the confirmation email goes out at once with a manage link", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  const request = bookingRequest({ teamNumber: "0321", teamName: "  Lancers ", note: "Bring safety glasses" });
  const response = await harness.call("POST", "/public/visits/bookings", { body: request, role: null });
  assert.equal(response.status, 201);
  assert.deepEqual(response.body, {
    booked: true, emailTo: "pat@example.org",
    visit: { date: "2026-11-02", arrival: "18:30", departure: "20:00", arrivalMs: Date.parse("2026-11-02T23:30:00Z"), departureMs: Date.parse("2026-11-03T01:00:00Z"), windowTitle: "Open shop" },
  });
  // The booking page never receives the manage link.
  assert.doesNotMatch(JSON.stringify(response.body), /manage|token/i);
  const booking = harness.db.rows<Record<string, unknown>>("SELECT b.*, t.number, t.name FROM visits_bookings b JOIN visits_teams t ON t.id=b.team_id")[0]!;
  assert.equal(booking.number, "321");
  assert.equal(booking.name, "Lancers");
  assert.equal(booking.status, "booked");
  assert.equal(booking.revision, 0);
  assert.deepEqual(harness.db.rows("SELECT revision, action, actor_kind FROM visits_booking_revisions").map((row) => ({ ...row })), [{ revision: 0, action: "created", actor_kind: "guest" }]);
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_public_submission_keys WHERE key_hash=?", sha256(request.submissionKey)), 1);
  // The email went out during the request, with a link minted at send time; only its hash is stored.
  assert.equal(harness.email.sent.length, 1);
  const [email] = harness.email.sent;
  assert.equal(email!.to, "pat@example.org");
  assert.equal(email!.subject, "Your visit to our team on Monday, November 2");
  assert.match(email!.idempotencyKey, /^notification-[0-9a-f-]{36}$/);
  const token = FakeEmail.token(email!);
  assert.ok(email!.html!.includes(`${dashboardOrigin}/visit/manage#${token}`));
  assert.deepEqual(harness.db.rows("SELECT token_hash, expires_ms FROM visits_manage_tokens").map((row) => ({ ...row })), [{ token_hash: sha256(token), expires_ms: Date.parse("2026-11-03T01:00:00Z") }]);
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_manage_tokens WHERE token_hash=?", token), 0);
  assert.deepEqual(harness.db.rows("SELECT channel, kind, status, attempts, external_id FROM visits_notifications").map((row) => ({ ...row })), [{ channel: "email", kind: "booked", status: "delivered", attempts: 1, external_id: "email-1" }]);
  // Guest text is escaped in the HTML.
  const second = await book(harness, { teamNumber: "99", teamName: "<b>Bots</b>", contactEmail: "lee@example.org" });
  assert.ok(second.id);
  assert.ok(harness.email.sent[1]!.html!.includes("&lt;b&gt;Bots&lt;/b&gt;"));
});

test("a replayed submission key returns the first booking; a key reused for other details is refused", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  const request = bookingRequest();
  const first = await harness.call("POST", "/public/visits/bookings", { body: request, role: null });
  const again = await harness.call("POST", "/public/visits/bookings", { body: request, role: null });
  assert.equal(first.status, 201);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, first.body);
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_bookings"), 1);
  assert.equal(harness.email.sent.length, 1);
  const reused = await harness.call("POST", "/public/visits/bookings", { body: { ...request, headcount: 20 }, role: null });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.field, "submissionKey");
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_bookings"), 1);
});

test("bookings outside an open window, without an email or with bad input are refused with the field to fix", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  const cases: [Record<string, unknown>, number, string][] = [
    [{ arrival: "17:30" }, 400, "arrival"],
    [{ date: "2026-11-03" }, 400, "arrival"],
    [{ contactEmail: "" }, 400, "contactEmail"],
    [{ contactEmail: "not an email" }, 400, "contactEmail"],
    [{ headcount: 0 }, 400, "headcount"],
    [{ program: "VEX" }, 400, "program"],
    [{ departure: "18:00" }, 400, "departure"],
    [{ date: "2026-10-26" }, 400, "arrival"],
    [{ date: "2026-12-30" }, 400, "arrival"],
    [{ extra: "field" }, 400, "extra"],
  ];
  for (const [overrides, status, field] of cases) {
    const response = await harness.call("POST", "/public/visits/bookings", { body: bookingRequest(overrides), role: null });
    assert.equal(response.status, status, JSON.stringify(overrides));
    assert.equal(response.body.field, field, JSON.stringify(overrides));
  }
  // A window beyond the eight-week horizon of the guest page.
  await harness.call("POST", "/admin/visits/windows", { body: { date: "2027-01-09", startTime: "10:00", endTime: "14:00" } });
  const far = await harness.call("POST", "/public/visits/bookings", { body: bookingRequest({ date: "2027-01-09", arrival: "10:00", departure: "11:00" }), role: null });
  assert.equal(far.status, 400);
  assert.match(far.body.error, /8 weeks ahead/);
  // A canceled window says why.
  const overview = await harness.call("GET", "/admin/visits/overview");
  const monday = overview.body.windows.find((window: { date: string }) => window.date === "2026-11-02");
  await harness.call("POST", `/admin/visits/windows/${monday.id}/cancel`, { body: { reason: "Thanksgiving break", revision: 0 } });
  const canceled = await harness.call("POST", "/public/visits/bookings", { body: bookingRequest(), role: null });
  assert.equal(canceled.status, 400);
  assert.equal(canceled.body.error, "That time is canceled: Thanksgiving break");
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_bookings"), 0);
  assert.equal(harness.email.sent.length, 0);
});

test("teams book overlapping times and each sees the other; the public page shows no contact details or notes", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  await book(harness);
  await book(harness, { teamNumber: "5678", teamName: "Robo Owls", program: "FTC", contactName: "Sam Lead", contactEmail: "sam@example.org", contactPhone: "555-010-9999", note: "Secret note", arrival: "19:00", departure: "21:00", headcount: 5 });
  const calendar = await harness.call("GET", "/public/visits/calendar", { role: null, origin: null });
  assert.equal(calendar.status, 200);
  assert.equal(calendar.body.timeZone, "America/New_York");
  assert.equal(calendar.body.horizonDays, 56);
  const monday = calendar.body.windows[0];
  assert.equal(monday.teamCount, 2);
  assert.deepEqual(monday.visits.map((visit: { teamName: string }) => visit.teamName), ["Gearheads", "Robo Owls"]);
  assert.deepEqual(Object.keys(monday.visits[0]).sort(), ["arrivalMs", "departureMs", "headcount", "program", "teamName", "teamNumber"]);
  const text = JSON.stringify(calendar.body);
  for (const secret of ["pat@example.org", "sam@example.org", "555-010", "Secret note", "Two mentors", "Pat Coach", "Sam Lead"]) assert.ok(!text.includes(secret), secret);
  // A known team fills in its saved name.
  assert.deepEqual((await harness.call("GET", "/public/visits/team?program=FTC&number=05678", { role: null })).body, { team: { number: "5678", name: "Robo Owls", program: "FTC" } });
  assert.deepEqual((await harness.call("GET", "/public/visits/team?program=FRC&number=9", { role: null })).body, { team: null });
  assert.equal((await harness.call("GET", "/public/visits/team?program=FRC&number=abc", { role: null })).status, 400);
  // A known team keeps its saved name, so the page never lets a guest rename a team.
  await book(harness, { teamName: "Renamed", contactEmail: "other@example.org", date: "2026-11-04" });
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_teams"), 2);
  assert.equal(harness.db.rows<{ name: string }>("SELECT name FROM visits_teams WHERE number='1234'")[0]!.name, "Gearheads");
});

test("public posts need the dashboard origin and their input in the body", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  for (const origin of [null, "https://evil.example", "https://api.example.org"]) {
    const response = await harness.call("POST", "/public/visits/bookings", { body: bookingRequest(), role: null, origin });
    assert.equal(response.status, 403, String(origin));
  }
  assert.equal((await harness.call("POST", "/public/visits/bookings?teamNumber=1", { body: bookingRequest(), role: null })).status, 400);
  assert.equal((await harness.call("GET", "/public/visits/bookings", { role: null })).status, 405);
  assert.equal((await harness.call("GET", "/public/visits/unknown", { role: null })).status, 404);
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_bookings"), 0);
});

test("the emailed link shows its own booking; opening it changes nothing, and GET never manages a visit", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  const first = await book(harness);
  await book(harness, { teamNumber: "77", teamName: "Other team", contactEmail: "other@example.org" });
  const token = FakeEmail.token(harness.email.sent[0]!);
  const shown = await manage(harness, "manage", { token });
  assert.equal(shown.status, 200);
  assert.equal(shown.body.booking.id, first.id);
  assert.equal(shown.body.booking.contactEmail, "pat@example.org");
  assert.equal(shown.body.booking.team.name, "Gearheads");
  assert.ok(shown.body.windows.every((window: { status: string }) => window.status === "open"));
  for (let index = 0; index < 3; index += 1) await manage(harness, "manage", { token });
  assert.equal(harness.db.rows<{ revision: number }>("SELECT revision FROM visits_bookings WHERE id=?", first.id)[0]!.revision, 0);
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_notifications"), 2);
  // A scanner that follows a link sends GET; nothing answers it.
  assert.equal((await harness.call("GET", `/public/visits/manage?token=${token}`, { role: null })).status, 405);
  assert.equal((await harness.call("GET", "/public/visits/manage/cancel", { role: null })).status, 405);
  // Without the dashboard origin nothing happens either.
  assert.equal((await manage(harness, "manage/cancel", { token, revision: 0 }, null)).status, 403);
  assert.equal(harness.db.rows<{ status: string }>("SELECT status FROM visits_bookings WHERE id=?", first.id)[0]!.status, "booked");
  // Unknown, malformed and missing tokens get one message.
  for (const body of [{ token: "A".repeat(43) }, { token: "short" }, {}]) {
    const refused = await manage(harness, "manage", body);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, manageTokenRefusedMessage);
  }
});

test("a link works only for its own booking, until the visit ends, unless revoked", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  const first = await book(harness);
  const second = await book(harness, { teamNumber: "77", teamName: "Other team", contactEmail: "other@example.org" });
  const [firstToken, secondToken] = harness.email.sent.map((message) => FakeEmail.token(message));
  // Canceling with the first booking's link changes only the first booking.
  const canceled = await manage(harness, "manage/cancel", { token: firstToken, revision: 0 });
  assert.equal(canceled.status, 200);
  assert.equal(canceled.body.booking.id, first.id);
  assert.equal(canceled.body.booking.status, "canceled");
  assert.deepEqual(harness.db.rows("SELECT id, status FROM visits_bookings ORDER BY status").map((row) => ({ ...row })), [{ id: second.id, status: "booked" }, { id: first.id, status: "canceled" }]);
  // A token stored for one booking never admits another (the rule the routes apply to every token).
  harness.db.sqlite.prepare("UPDATE visits_manage_tokens SET booking_id=? WHERE token_hash=?").run(first.id, sha256(secondToken!));
  assert.equal((await manage(harness, "manage", { token: secondToken })).body.booking.id, first.id);
  harness.db.sqlite.prepare("UPDATE visits_manage_tokens SET booking_id=? WHERE token_hash=?").run(second.id, sha256(secondToken!));
  // Revoked.
  harness.db.sqlite.prepare("UPDATE visits_manage_tokens SET revoked_ms=? WHERE token_hash=?").run(harness.clock.now, sha256(secondToken!));
  assert.equal((await manage(harness, "manage", { token: secondToken })).status, 403);
  harness.db.sqlite.prepare("UPDATE visits_manage_tokens SET revoked_ms=NULL WHERE token_hash=?").run(sha256(secondToken!));
  assert.equal((await manage(harness, "manage", { token: secondToken })).status, 200);
  // Expired once the visit ends.
  harness.clock.now = Date.parse("2026-11-03T01:00:00Z");
  assert.equal((await manage(harness, "manage", { token: secondToken })).status, 403);
  harness.clock.now = Date.parse("2026-11-03T00:59:00Z");
  assert.equal((await manage(harness, "manage", { token: secondToken })).status, 200);
});

test("a guest changes and cancels a visit with the link; stale and closed edits are refused", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  const booked = await book(harness);
  const token = FakeEmail.token(harness.email.sent[0]!);
  const changed = await manage(harness, "manage/update", { token, edit: { revision: 0, headcount: 15, note: "  Bringing   a robot ", contactPhone: "" } });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.booking.revision, 1);
  assert.equal(changed.body.booking.headcount, 15);
  assert.equal(changed.body.booking.note, "Bringing a robot");
  assert.equal(changed.body.booking.contactPhone, "");
  // The update email has the new details and a fresh link; both links work.
  assert.equal(harness.email.sent.length, 2);
  assert.match(harness.email.sent[1]!.subject, /^Updated: your visit/);
  assert.match(harness.email.sent[1]!.text!, /changed \(phone, headcount, note\)/);
  const fresh = FakeEmail.token(harness.email.sent[1]!);
  assert.notEqual(fresh, token);
  assert.equal((await manage(harness, "manage", { token })).status, 200);
  // A stale revision is refused.
  const stale = await manage(harness, "manage/update", { token: fresh, edit: { revision: 0, headcount: 3 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.field, "revision");
  // Team and email address are fixed for guests.
  assert.equal((await manage(harness, "manage/update", { token, edit: { revision: 1, contactEmail: "x@example.org" } })).status, 400);
  // Moving the visit to Wednesday re-checks the window and moves every link's expiry with it.
  const moved = await manage(harness, "manage/update", { token, edit: { revision: 1, date: "2026-11-04", arrival: "18:00", departure: "19:00" } });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.booking.date, "2026-11-04");
  assert.deepEqual([...new Set(harness.db.rows<{ expires_ms: number }>("SELECT expires_ms FROM visits_manage_tokens").map((row) => row.expires_ms))], [Date.parse("2026-11-05T00:00:00Z")]);
  assert.equal((await manage(harness, "manage/update", { token, edit: { revision: 2, date: "2026-11-05", arrival: "18:00", departure: "19:00" } })).status, 400);
  // Unchanged edits write nothing.
  await manage(harness, "manage/update", { token, edit: { revision: 2, headcount: 15 } });
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_booking_revisions"), 3);
  // Cancel, then nothing more can change.
  const canceled = await manage(harness, "manage/cancel", { token, revision: 2 });
  assert.equal(canceled.body.booking.status, "canceled");
  assert.match(harness.email.sent.at(-1)!.subject, /^Canceled: your visit/);
  assert.equal((await manage(harness, "manage/cancel", { token, revision: 3 })).status, 409);
  assert.equal((await manage(harness, "manage/update", { token, edit: { revision: 3, headcount: 2 } })).status, 409);
  assert.deepEqual(harness.db.rows("SELECT revision, action, actor_kind FROM visits_booking_revisions ORDER BY revision").map((row) => ({ ...row })), [
    { revision: 0, action: "created", actor_kind: "guest" }, { revision: 1, action: "updated", actor_kind: "guest" },
    { revision: 2, action: "updated", actor_kind: "guest" }, { revision: 3, action: "canceled", actor_kind: "guest" },
  ]);
  assert.equal(booked.visit.windowTitle, "Open shop");
  // The canceled visit leaves the public page.
  const calendar = await harness.call("GET", "/public/visits/calendar", { role: null });
  assert.ok(calendar.body.windows.every((window: { teamCount: number }) => window.teamCount === 0));
});
