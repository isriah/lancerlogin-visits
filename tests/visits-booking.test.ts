import test from "node:test";
import assert from "node:assert/strict";
import { at, civil, newYork } from "./helpers/civil-time.ts";
import {
  applyGuestCancel, applyGuestEdit, bookingFingerprintText, bookingRevisionRow, checkGuestVisit, diffBooking, findFittingWindow, handledAttention,
  maximumHeadcount, nextAttention, noAttention, outreachActivityKeptAttention, outreachProgram, parseBookingInput, parseBookingSnapshot, parseEmail,
  parseGuestEdit, parseHeadcount, parsePhone, parseTeamNumber, programLabels, publicVisit, publicWindows, resolveVisitTimes, submissionOutcome,
  teamLabel, visitPrograms, windowAttentionReason, type BookableWindow, type StoredBooking, type TeamIdentity,
} from "../src/shared/visits-booking.ts";

const hour = 3_600_000;
const day = 86_400_000;
const monday: BookableWindow & { title: string; cancelReason: string } = { id: "mon", startMs: at("2026-11-02T23:00:00Z"), endMs: at("2026-11-03T02:00:00Z"), status: "open", title: "Open shop", cancelReason: "" };
const wednesday: BookableWindow & { title: string; cancelReason: string } = { id: "wed", startMs: at("2026-11-04T23:00:00Z"), endMs: at("2026-11-05T02:00:00Z"), status: "open", title: "Open shop", cancelReason: "" };
const thanksgiving: BookableWindow & { title: string; cancelReason: string } = { id: "thu", startMs: at("2026-11-25T23:00:00Z"), endMs: at("2026-11-26T02:00:00Z"), status: "canceled", title: "Open shop", cancelReason: "Thanksgiving" };
const windows = [monday, wednesday, thanksgiving];
const now = at("2026-10-28T16:00:00Z");

const body = {
  teamNumber: " 1234 ", teamName: " Gear   Heads ", program: "FRC", contactName: "Pat Coach", contactEmail: " pat.coach@example.org ", contactPhone: "(555) 010-0199",
  date: "2026-11-02", arrival: "18:30", departure: "20:00", headcount: 12, note: " Bringing our robot.\r\nNeed a cart. ", submissionKey: "key-0123456789abcdef",
};

function failure(result: { ok: boolean }) {
  assert.equal(result.ok, false, JSON.stringify(result));
  return result as { ok: false; field: string; error: string };
}

const booking: StoredBooking = {
  id: "booking-1", revision: 3, windowId: "mon", teamId: "team-1", contactName: "Pat Coach", contactEmail: "pat.coach@example.org", contactPhone: "",
  arrivalMs: at("2026-11-02T23:30:00Z"), departureMs: at("2026-11-03T01:00:00Z"), headcount: 12, note: "", status: "booked",
};

test("programs follow Outreach, with Other never linked to Outreach", () => {
  assert.deepEqual([...visitPrograms], ["FRC", "FTC", "Challenge", "Explore", "Other"]);
  assert.equal(programLabels.Challenge, "FIRST LEGO League Challenge");
  assert.equal(programLabels.Explore, "FIRST LEGO League Explore");
  assert.deepEqual(visitPrograms.map(outreachProgram), ["FRC", "FTC", "Challenge", "Explore", null]);
  assert.equal(teamLabel({ program: "Challenge", number: "12345", name: "Brick Builders" }), "FLL Challenge 12345 Brick Builders");
  assert.equal(teamLabel({ program: "Other", number: "99X", name: "Rockets" }), "Team 99X Rockets");
});

test("a guest booking is validated and normalized", () => {
  const result = parseBookingInput(body);
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.value, {
    team: { number: "1234", name: "Gear Heads", program: "FRC" }, contact: { name: "Pat Coach", email: "pat.coach@example.org", phone: "(555) 010-0199" },
    date: "2026-11-02", arrival: "18:30", departure: "20:00", headcount: 12, note: "Bringing our robot.\nNeed a cart.", submissionKey: "key-0123456789abcdef",
  });
  const minimal = parseBookingInput({ ...body, contactPhone: undefined, note: undefined });
  assert.ok(minimal.ok && minimal.value.contact.phone === "" && minimal.value.note === "");
});

test("a booking without an email address or with bad fields is refused with the field to fix", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ contactEmail: undefined }, "contactEmail"], [{ contactEmail: "" }, "contactEmail"], [{ contactEmail: "pat at example" }, "contactEmail"],
    [{ contactEmail: "Pat <pat@example.org>" }, "contactEmail"], [{ contactEmail: "a@b.org, c@d.org" }, "contactEmail"],
    [{ program: "FLL" }, "program"], [{ program: "frc" }, "program"], [{ teamNumber: "" }, "teamNumber"], [{ teamNumber: "12a" }, "teamNumber"],
    [{ teamNumber: "1234567" }, "teamNumber"], [{ teamName: "  " }, "teamName"], [{ teamName: "x".repeat(101) }, "teamName"], [{ contactName: "" }, "contactName"],
    [{ contactPhone: "call me" }, "contactPhone"], [{ contactPhone: "12345" }, "contactPhone"], [{ date: "2026-11-31" }, "date"], [{ arrival: "6:30 PM" }, "arrival"],
    [{ departure: "18:30" }, "departure"], [{ departure: "18:00" }, "departure"], [{ headcount: 0 }, "headcount"], [{ headcount: maximumHeadcount + 1 }, "headcount"],
    [{ headcount: 2.5 }, "headcount"], [{ note: "x".repeat(1001) }, "note"], [{ submissionKey: "short" }, "submissionKey"], [{ submissionKey: undefined }, "submissionKey"],
    [{ windowId: "mon" }, "windowId"],
  ];
  for (const [change, field] of cases) assert.equal(failure(parseBookingInput({ ...body, ...change })).field, field, JSON.stringify(change));
  assert.equal(failure(parseBookingInput("teamNumber=1234")).field, "");
  assert.equal(failure(parseBookingInput({ ...body, note: "x".repeat(1001) })).error, "Team needs are at most 1000 characters");
  assert.equal(failure(parseBookingInput({ ...body, note: 12 })).error, "Enter team needs as text");
});

test("team numbers are normalized per program", () => {
  assert.deepEqual(parseTeamNumber("0321", "FRC"), { ok: true, value: "321" });
  assert.deepEqual(parseTeamNumber(16072, "FTC"), { ok: true, value: "16072" });
  assert.deepEqual(parseTeamNumber("#45", "Explore"), { ok: true, value: "45" });
  assert.deepEqual(parseTeamNumber(" 99x-b ", "Other"), { ok: true, value: "99X-B" });
  for (const [value, program] of [["000", "FRC"], ["-1", "FTC"], ["ABCDEFGHIJK", "Other"], ["a b", "Other"], [null, "FRC"]] as const) assert.equal(parseTeamNumber(value, program).ok, false, String(value));
});

test("contact fields accept common forms", () => {
  for (const email of ["pat@example.org", "first.last+visits@mail.example.co.uk", "o'neil@example.com"]) assert.ok(parseEmail(email).ok, email);
  for (const phone of ["555-010-0199", "+1 (555) 010-0199", "555.010.0199 ext. 12", "555 010 0199 x9"]) assert.ok(parsePhone(phone).ok, phone);
  assert.deepEqual(parsePhone("   "), { ok: true, value: "" });
  assert.deepEqual(parseHeadcount("8"), { ok: true, value: 8 });
});

test("visit times resolve in the installation time zone, including daylight saving days", () => {
  assert.deepEqual(resolveVisitTimes(civil, newYork, "2026-11-02", "18:30", "20:00"), { ok: true, value: { arrivalMs: at("2026-11-02T23:30:00Z"), departureMs: at("2026-11-03T01:00:00Z") } });
  assert.deepEqual(resolveVisitTimes(civil, newYork, "2026-11-01", "01:15", "01:45"), { ok: true, value: { arrivalMs: at("2026-11-01T05:15:00Z"), departureMs: at("2026-11-01T06:45:00Z") } });
  assert.equal(failure(resolveVisitTimes(civil, newYork, "2026-03-08", "02:10", "02:50")).field, "arrival");
});

test("a visit must fit inside one open window", () => {
  const inside = { arrivalMs: monday.startMs + hour, departureMs: monday.endMs };
  assert.deepEqual(findFittingWindow(windows, inside), { ok: true, value: monday });
  assert.deepEqual(findFittingWindow(windows, { arrivalMs: monday.startMs, departureMs: monday.endMs }), { ok: true, value: monday }, "the whole window");
  assert.equal(failure(findFittingWindow(windows, { arrivalMs: monday.startMs - 60_000, departureMs: monday.endMs })).field, "arrival", "starts before the window");
  assert.equal(failure(findFittingWindow(windows, { arrivalMs: monday.startMs, departureMs: wednesday.endMs })).field, "arrival", "spans two windows");
  assert.equal(failure(findFittingWindow(windows, { arrivalMs: thanksgiving.startMs, departureMs: thanksgiving.startMs + hour })).error, "That time is canceled: Thanksgiving");
  assert.equal(failure(findFittingWindow([{ ...monday, status: "removed" }], inside)).field, "arrival");
});

test("guests book only future visits in windows within eight weeks", () => {
  const visit = { arrivalMs: monday.startMs + hour, departureMs: monday.endMs };
  assert.ok(checkGuestVisit(windows, visit, now).ok);
  assert.equal(failure(checkGuestVisit(windows, visit, visit.arrivalMs)).field, "arrival", "already started");
  const far = { ...monday, id: "far", startMs: now + 57 * day, endMs: now + 57 * day + 3 * hour };
  assert.equal(failure(checkGuestVisit([far], { arrivalMs: far.startMs, departureMs: far.endMs }, now)).error, "Visits can be booked up to 8 weeks ahead");
});

test("the public page shows team, program, times and headcount only", () => {
  const teams = new Map<string, TeamIdentity>([["t1", { number: "1234", name: "Gear Heads", program: "FRC" }], ["t2", { number: "16072", name: "Quantum", program: "FTC" }]]);
  const bookings = [
    { windowId: "mon", teamId: "t2", arrivalMs: monday.startMs + hour, departureMs: monday.endMs, headcount: 6, status: "booked" as const, contactEmail: "secret@example.org", note: "private" },
    { windowId: "mon", teamId: "t1", arrivalMs: monday.startMs, departureMs: monday.startMs + 2 * hour, headcount: 12, status: "booked" as const },
    { windowId: "mon", teamId: "t1", arrivalMs: monday.startMs, departureMs: monday.endMs, headcount: 3, status: "canceled" as const },
    { windowId: "thu", teamId: "t1", arrivalMs: thanksgiving.startMs, departureMs: thanksgiving.endMs, headcount: 4, status: "booked" as const },
  ];
  const past = { ...monday, id: "past", startMs: now - 4 * hour, endMs: now - hour };
  const removed = { ...wednesday, status: "removed" as const };
  const page = publicWindows({ windows: [thanksgiving, removed, monday, past], bookings, teams, now });
  assert.deepEqual(page.map((window) => [window.id, window.status, window.teamCount, window.cancelReason]), [["mon", "open", 2, ""], ["thu", "canceled", 0, "Thanksgiving"]]);
  assert.deepEqual(page[0]!.visits, [
    { teamNumber: "1234", teamName: "Gear Heads", program: "FRC", arrivalMs: monday.startMs, departureMs: monday.startMs + 2 * hour, headcount: 12 },
    { teamNumber: "16072", teamName: "Quantum", program: "FTC", arrivalMs: monday.startMs + hour, departureMs: monday.endMs, headcount: 6 },
  ]);
  assert.doesNotMatch(JSON.stringify(page), /secret|private|Pat/);
  assert.deepEqual(Object.keys(publicVisit({ ...bookings[0]!, contactName: "Pat" } as never, teams.get("t1")!)).sort(), ["arrivalMs", "departureMs", "headcount", "program", "teamName", "teamNumber"]);
});

test("a visit needs attention when its window is canceled, removed or changed so it no longer fits", () => {
  const visit = { status: "booked" as const, arrivalMs: monday.startMs + hour, departureMs: monday.endMs };
  assert.equal(windowAttentionReason(visit, monday), null);
  assert.equal(windowAttentionReason(visit, { ...monday, status: "canceled" }), "window-canceled");
  assert.equal(windowAttentionReason(visit, { ...monday, status: "removed" }), "window-removed");
  assert.equal(windowAttentionReason(visit, undefined), "window-removed");
  assert.equal(windowAttentionReason(visit, { ...monday, endMs: monday.endMs - hour }), "window-changed");
  assert.equal(windowAttentionReason({ ...visit, status: "canceled" }, undefined), null, "canceled visits need no window");
});

test("attention reopens for a new reason, keeps a handled same reason and clears when the window is back", () => {
  const needed = nextAttention(noAttention, "window-canceled");
  assert.deepEqual(needed, { state: "needed", reason: "window-canceled" });
  const handled = handledAttention(needed);
  assert.deepEqual(handled, { state: "handled", reason: "window-canceled" });
  assert.deepEqual(nextAttention(handled, "window-canceled"), handled);
  assert.deepEqual(nextAttention(handled, "window-changed"), { state: "needed", reason: "window-changed" });
  assert.deepEqual(nextAttention(handled, null), noAttention, "restoring the window clears it");
  const outreach = outreachActivityKeptAttention(noAttention);
  assert.deepEqual(outreach, { state: "needed", reason: "outreach-activity-kept" });
  assert.deepEqual(nextAttention(outreach, null), outreach, "an Outreach note stays until handled");
  assert.deepEqual(outreachActivityKeptAttention(needed), needed, "a window problem comes first");
  assert.deepEqual(outreachActivityKeptAttention(handled), outreach);
  assert.deepEqual(handledAttention(noAttention), noAttention);
});

test("manage-page edits change only the guest's own details", () => {
  assert.deepEqual(parseGuestEdit({ revision: 3, headcount: "14", note: " Two robots ", contactPhone: "" }), { ok: true, value: { revision: 3, headcount: 14, note: "Two robots", contactPhone: "" } });
  assert.deepEqual(parseGuestEdit({ revision: 3, date: "2026-11-04", arrival: "18:00", departure: "19:00" }), { ok: true, value: { revision: 3, times: { date: "2026-11-04", arrival: "18:00", departure: "19:00" } } });
  for (const field of ["teamNumber", "teamName", "program", "contactEmail"]) {
    assert.equal(failure(parseGuestEdit({ revision: 3, [field]: "x" })).error, "Ask the team you are visiting to change the team or email address", field);
  }
  assert.equal(failure(parseGuestEdit({ revision: 3, date: "2026-11-04" })).field, "date");
  assert.equal(failure(parseGuestEdit({ headcount: 3 })).field, "revision");
  assert.equal(failure(parseGuestEdit({ revision: -1 })).field, "revision");
  assert.equal(failure(parseGuestEdit({ revision: 3, contactName: "" })).field, "contactName");
  assert.equal(failure(parseGuestEdit({ revision: 3, colour: "red" })).field, "colour");
});

test("a guest edit moves a visit only into an open window and records what changed", () => {
  const edit = (value: Record<string, unknown>, at = now) => {
    const parsed = parseGuestEdit({ revision: 3, ...value });
    assert.ok(parsed.ok, JSON.stringify(parsed));
    return applyGuestEdit({ civil, timeZone: newYork, booking, edit: parsed.value, windows, now: at });
  };
  const moved = edit({ date: "2026-11-04", arrival: "18:00", departure: "19:30", headcount: 14 });
  assert.ok(moved.ok);
  assert.deepEqual(moved.value.changes.map((change) => change.field), ["windowId", "arrivalMs", "departureMs", "headcount"]);
  assert.equal(moved.value.next.windowId, "wed");
  assert.equal(failure(edit({ date: "2026-11-04", arrival: "17:00", departure: "19:30" })).field, "arrival", "outside the window");
  assert.equal(failure(edit({ date: "2026-11-25", arrival: "18:00", departure: "19:00" })).error, "That time is canceled: Thanksgiving");
  // The same times change nothing and need no window check, even after the window was canceled.
  const same = applyGuestEdit({ civil, timeZone: newYork, booking, edit: { revision: 3, times: { date: "2026-11-02", arrival: "18:30", departure: "20:00" }, note: "Late" }, windows: [{ ...monday, status: "canceled" }], now });
  assert.ok(same.ok);
  assert.deepEqual(same.value.changes, [{ field: "note", from: "", to: "Late" }]);
  const nothing = applyGuestEdit({ civil, timeZone: newYork, booking, edit: { revision: 3, headcount: 12 }, windows, now });
  assert.ok(nothing.ok && nothing.value.changes.length === 0);
  assert.equal(failure(applyGuestEdit({ civil, timeZone: newYork, booking, edit: { revision: 2, headcount: 5 }, windows, now })).field, "revision", "stale edit");
  assert.equal(failure(applyGuestEdit({ civil, timeZone: newYork, booking: { ...booking, status: "canceled" }, edit: { revision: 3, headcount: 5 }, windows, now })).field, "status");
  assert.equal(failure(edit({ date: "2026-11-02", arrival: "18:00", departure: "19:00" }, at("2026-11-02T23:30:00Z"))).field, "arrival", "cannot move into the past");
});

test("a guest cancel needs the current revision", () => {
  const canceled = applyGuestCancel(booking, 3);
  assert.ok(canceled.ok);
  assert.deepEqual(canceled.value.changes, [{ field: "status", from: "booked", to: "canceled" }]);
  assert.equal(failure(applyGuestCancel(booking, 2)).field, "revision");
  assert.equal(failure(applyGuestCancel({ ...booking, status: "canceled" }, 3)).field, "status");
});

test("revision rows keep the change and a snapshot that restores the earlier version", () => {
  const next = { ...booking, headcount: 14 };
  const row = bookingRevisionRow({ bookingId: "booking-1", revision: 4, action: "updated", actor: { kind: "staff", userId: "user-1" }, changes: diffBooking(booking, next), snapshot: next, at: "2026-10-28T16:00:00.000Z" });
  assert.equal(row.actor_kind, "staff");
  assert.equal(row.staff_user_id, "user-1");
  assert.deepEqual(JSON.parse(row.change_json), [{ field: "headcount", from: 12, to: 14 }]);
  const snapshot = parseBookingSnapshot(row.snapshot_json);
  assert.ok(snapshot.ok);
  assert.equal(snapshot.value.headcount, 14);
  assert.ok(!("id" in snapshot.value) && !("revision" in snapshot.value));
  assert.equal(bookingRevisionRow({ bookingId: "b", revision: 0, action: "created", actor: { kind: "guest" }, changes: [], snapshot: booking, at: "x" }).staff_user_id, null);
  for (const json of ["nope", "[]", JSON.stringify({ ...snapshot.value, headcount: "14" }), JSON.stringify({ ...snapshot.value, status: "lost" }), JSON.stringify({ ...snapshot.value, departureMs: snapshot.value.arrivalMs })]) {
    assert.equal(parseBookingSnapshot(json).ok, false, json);
  }
});

test("a submission key replays its booking and refuses different details", () => {
  const first = parseBookingInput(body);
  const second = parseBookingInput({ ...body, contactEmail: "PAT.COACH@example.org", submissionKey: "another-key-0123456789" });
  const changed = parseBookingInput({ ...body, headcount: 13 });
  assert.ok(first.ok && second.ok && changed.ok);
  assert.equal(bookingFingerprintText(first.value), bookingFingerprintText(second.value), "the key itself and email case are not part of the fingerprint");
  assert.notEqual(bookingFingerprintText(first.value), bookingFingerprintText(changed.value));
  assert.deepEqual(submissionOutcome(null, "f1"), { kind: "new" });
  assert.deepEqual(submissionOutcome({ fingerprint: "f1", bookingId: "booking-1" }, "f1"), { kind: "replay", bookingId: "booking-1" });
  assert.deepEqual(submissionOutcome({ fingerprint: "f1", bookingId: "booking-1" }, "f2"), { kind: "conflict" });
});
