import test from "node:test";
import assert from "node:assert/strict";
import { parseBookingInput, parseGuestEdit } from "../src/shared/visits-booking.ts";
import {
  availabilityDraft, availabilityRequest, bookingFieldOrder, bookingFieldSources, bookingRequest, cancelReason, checkBookingField, checkStaffVisitField,
  checkVisitField, emptyBookingDraft, guestPageLink, liveBlur, liveChange, liveCheckState, liveShow, lookupFill, lookupNumber, newSubmissionKey, readFailure,
  settingsUpdate, staffVisitDraft, staffVisitEdit, submissionAttempt, teamLookupQuery, validateBookingDraft, validateStaffVisitDraft, validateVisitDraft,
  visitDraft, visitEdit, visitFieldOrder, type BookingDraft, type LiveCheckState,
} from "../src/dashboard/visits-forms.ts";
import type { StaffBooking, VisitsSettings } from "../src/shared/visits-api.ts";

const filled: BookingDraft = {
  program: "FRC", teamNumber: "0321", teamName: "  Lancers ", contactName: "Sam  Coach", contactEmail: " coach@example.org ", contactPhone: "",
  windowId: "w1", arrival: "18:00", departure: "20:00", headcount: "6", note: "",
};

test("API failures keep the message and field, and mark retryable failures", () => {
  assert.deepEqual(readFailure(400, { error: "Enter an email address for the confirmation", field: "contactEmail" }), { message: "Enter an email address for the confirmation", field: "contactEmail", status: 400, transient: false });
  assert.deepEqual(readFailure(409, { error: "This visit changed since you opened it.", field: "revision" }).field, "revision");
  assert.deepEqual(readFailure(400, { error: "Bad", details: ["First.", "Second."] }).message, "First. Second.");
  assert.equal(readFailure(null, undefined).transient, true);
  assert.match(readFailure(null, undefined).message, /could not be reached/);
  assert.equal(readFailure(503, "not json").transient, true);
  assert.equal(readFailure(429, {}).transient, true);
  assert.equal(readFailure(404, {}).message, "The request was refused.");
  assert.equal(readFailure(404, { error: 12, field: 3 }).field, "");
});

test("a complete booking form has no problems and becomes a request the Worker accepts", () => {
  assert.deepEqual(validateBookingDraft(filled, "2026-11-02"), {});
  const request = bookingRequest(filled, "2026-11-02");
  assert.deepEqual(request, { teamNumber: "321", teamName: "Lancers", program: "FRC", contactName: "Sam Coach", contactEmail: "coach@example.org", date: "2026-11-02", arrival: "18:00", departure: "20:00", headcount: 6 });
  const parsed = parseBookingInput({ ...request, submissionKey: "0123456789abcdef-key" });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  const withOptional = bookingRequest({ ...filled, contactPhone: " 555-123-4567 ", note: " Bringing our robot " }, "2026-11-02");
  assert.equal(withOptional.contactPhone, "555-123-4567");
  assert.equal(withOptional.note, "Bringing our robot");
});

test("every booking problem is reported against its request field", () => {
  const errors = validateBookingDraft(emptyBookingDraft, undefined);
  assert.deepEqual(Object.keys(errors).sort(), ["arrival", "contactEmail", "contactName", "date", "departure", "headcount", "program", "teamName", "teamNumber"]);
  assert.equal(errors.contactEmail, "Enter an email address for the confirmation");
  assert.equal(errors.teamNumber, "Enter the team number");
  const wrong = validateBookingDraft({ ...filled, teamNumber: "32a", contactEmail: "coach", contactPhone: "12", departure: "17:00", headcount: "0" }, "2026-11-02");
  assert.equal(wrong.teamNumber, "FRC team numbers are digits only");
  assert.equal(wrong.contactEmail, "Enter one email address, like name@example.org");
  assert.equal(wrong.contactPhone, "Enter a phone number with its area code, or leave it empty");
  assert.equal(wrong.departure, "The departure must be after the arrival");
  assert.equal(wrong.headcount, "Visits are for 1 to 100 people");
  assert.deepEqual(validateBookingDraft({ ...filled, program: "Other", teamNumber: "99x" }, "2026-11-02"), {});
});

test("each booking field checks alone by the rules submit uses", () => {
  const check = (field: string, changes: Partial<BookingDraft> = {}) => checkBookingField(field, { ...filled, ...changes });
  const wrong: BookingDraft = { ...filled, teamNumber: "32a", contactEmail: "coach", contactPhone: "555 x1", departure: "17:00", headcount: "101", contactName: " " };
  for (const [draft, date] of [[filled, "2026-11-02"], [emptyBookingDraft, undefined], [wrong, "2026-11-02"], [{ ...wrong, program: "Other" }, undefined]] as const) {
    const errors = validateBookingDraft(draft, date);
    for (const field of bookingFieldOrder) assert.equal(checkBookingField(field, draft, date), errors[field], `${field} agrees with submit`);
  }
  assert.equal(check("windowId"), undefined, "a field without a rule passes");
  assert.equal(check("program", { program: "" }), "Choose the program");
  assert.equal(check("teamName", { teamName: "  " }), "Enter the team name");
  assert.equal(check("contactName", { contactName: "" }), "Enter the contact name");
  assert.equal(check("contactEmail", { contactEmail: " " }), "Enter an email address for the confirmation");
  for (const email of ["coach", "coach@example", "a@example.org, b@example.org", "Coach <coach@example.org>"]) assert.equal(check("contactEmail", { contactEmail: email }), "Enter one email address, like name@example.org", email);
  assert.equal(check("contactEmail", { contactEmail: " coach@example.org " }), undefined);
});

test("live booking checks: phone symbols, team numbers by program and headcount bounds", () => {
  const check = (field: string, changes: Partial<BookingDraft>) => checkBookingField(field, { ...filled, ...changes });
  for (const phone of ["", "555-010-0199", "+1 (555) 010-0199", "555.010.0199", " 555 010 0199 "]) assert.equal(check("contactPhone", { contactPhone: phone }), undefined, phone);
  for (const phone of ["555-010-0199 x123", "555-010-0199 ext. 123", "555-010-0199 extension 4", "555-HELP-NOW"]) assert.equal(check("contactPhone", { contactPhone: phone }), "Enter the phone number without letters or an extension", phone);
  assert.equal(check("contactPhone", { contactPhone: "555-010-0199 #12" }), "Use only digits, spaces, dots, hyphens, parentheses and a leading +");
  assert.equal(check("contactPhone", { contactPhone: "010-99" }), "Enter a phone number with its area code, or leave it empty");
  assert.equal(check("teamNumber", { teamNumber: "254" }), undefined);
  assert.equal(check("teamNumber", { teamNumber: "123456" }), undefined);
  assert.equal(check("teamNumber", { teamNumber: "1234567" }), "Team numbers are at most 6 digits");
  assert.equal(check("teamNumber", { teamNumber: "ROBO-7" }), "FRC team numbers are digits only");
  assert.equal(check("teamNumber", { program: "Challenge", teamNumber: "12a" }), "FIRST LEGO League Challenge team numbers are digits only");
  assert.equal(check("teamNumber", { program: "Other", teamNumber: "ROBO-7" }), undefined, "Other teams keep letters");
  assert.equal(check("teamNumber", { program: "Other", teamNumber: "ROBO 7" }), "Team numbers are up to 10 letters, digits and hyphens");
  assert.equal(check("teamNumber", { program: "", teamNumber: "ROBO-7" }), undefined, "only required until a program is chosen");
  assert.equal(check("teamNumber", { program: "", teamNumber: " " }), "Enter the team number");
  for (const count of ["1", "100", " 12 "]) assert.equal(check("headcount", { headcount: count }), undefined, count);
  for (const count of ["0", "101"]) assert.equal(check("headcount", { headcount: count }), "Visits are for 1 to 100 people", count);
  for (const count of ["", "1.5", "-3", "ten"]) assert.equal(check("headcount", { headcount: count }), "Enter how many people are coming", count);
});

test("visit and staff edit fields check alone by the rules submit uses", () => {
  const draft = staffVisitDraft(booking);
  const wrong = { ...draft, date: "", arrival: "", departure: "17:00", headcount: "0", contactName: " ", contactPhone: "555 010 0199 ext 9", contactEmail: "nope", teamId: "" };
  for (const value of [draft, wrong, { ...wrong, arrival: "18:00" }]) {
    const visit = validateVisitDraft(value), staff = validateStaffVisitDraft(value);
    for (const field of [...visitFieldOrder, "contactEmail", "teamId"]) {
      assert.equal(checkVisitField(field, value), visit[field], `visit ${field}`);
      assert.equal(checkStaffVisitField(field, value), staff[field], `staff ${field}`);
    }
  }
  assert.equal(checkVisitField("contactEmail", wrong), undefined, "guests do not change the email address");
  assert.equal(checkStaffVisitField("contactEmail", wrong), "Enter one email address, like name@example.org");
  assert.equal(checkStaffVisitField("contactPhone", wrong), "Enter the phone number without letters or an extension");
  assert.equal(checkStaffVisitField("headcount", { ...draft, headcount: "100" }), undefined);
  assert.equal(checkStaffVisitField("headcount", { ...draft, headcount: "101" }), "Visits are for 1 to 100 people");
});

test("live checks show a problem when a field is left, then follow it as it changes", () => {
  const start = liveCheckState(visitDraft(booking));
  let state = liveChange(start, { ...start.draft, contactName: "", arrival: "21:00" }, checkVisitField);
  assert.deepEqual(state.errors, {}, "typing shows nothing, nor does a change to a field never left");
  state = liveBlur(state, "contactName", checkVisitField);
  assert.deepEqual(state.errors, { contactName: "Enter the contact name" });
  state = liveChange(state, { ...state.draft, contactName: "S" }, checkVisitField);
  assert.deepEqual(state.errors, {}, "the message goes at the first valid value");
  state = liveChange(state, { ...state.draft, contactName: "" }, checkVisitField);
  assert.deepEqual(state.errors, {}, "emptying it again waits for the next blur");
  state = liveBlur(liveChange(state, { ...state.draft, headcount: "0" }, checkVisitField), "headcount", checkVisitField);
  state = liveChange(state, { ...state.draft, headcount: "" }, checkVisitField);
  assert.equal(state.errors.headcount, "Enter how many people are coming", "a field showing a problem is checked as it changes");
  state = liveChange(state, { ...state.draft, headcount: "100" }, checkVisitField);
  assert.equal(state.errors.headcount, undefined);
  assert.equal(liveBlur(state, "headcount", checkVisitField), state, "leaving a checked field that passes changes nothing");
  state = liveShow(state, validateVisitDraft({ ...state.draft, contactPhone: "555 0199 x2" }));
  assert.deepEqual(Object.keys(state.errors), ["departure", "contactName", "contactPhone"], "submit shows every problem");
});

test("live checks follow fields that depend on another, and keep a Worker refusal until its field changes", () => {
  const check = (field: string, draft: BookingDraft) => checkBookingField(field, draft, draft.windowId ? "2026-11-02" : undefined);
  const change = (state: LiveCheckState<BookingDraft>, changes: Partial<BookingDraft>) => liveChange(state, { ...state.draft, ...changes }, check, bookingFieldSources);
  let state = liveBlur(liveCheckState<BookingDraft>({ ...filled, program: "", teamNumber: "ROBO-7" }), "teamNumber", check);
  assert.deepEqual(state.errors, {}, "no program chosen yet");
  state = change(state, { program: "FRC" });
  assert.equal(state.errors.teamNumber, "FRC team numbers are digits only", "choosing a program checks the number left before");
  state = change(state, { program: "Other" });
  assert.equal(state.errors.teamNumber, undefined);
  state = change(liveBlur(state, "departure", check), { arrival: "20:30" });
  assert.equal(state.errors.departure, "The departure must be after the arrival", "moving the arrival checks the departure left before");
  state = change(state, { arrival: "18:00" });
  assert.equal(state.errors.departure, undefined);
  state = liveShow(state, { contactEmail: "This address cannot receive email", date: "That time is full" });
  state = change(liveBlur(state, "contactEmail", check), { note: "Robot" });
  assert.deepEqual(state.errors, { contactEmail: "This address cannot receive email", date: "That time is full" }, "leaving the field or changing another keeps a refusal");
  state = change(state, { windowId: "w2" });
  assert.deepEqual(state.errors, { contactEmail: "This address cannot receive email" }, "another time slot answers for date");
  state = change(state, { contactEmail: "coach@example.net" });
  assert.deepEqual(state.errors, {});
});

test("a retry of the same booking keeps its submission key; a changed booking gets a new one", () => {
  let count = 0;
  const generate = () => `key-${++count}-0123456789abcdef`;
  const request = bookingRequest(filled, "2026-11-02");
  const first = submissionAttempt(null, request, generate);
  assert.equal(first.key, "key-1-0123456789abcdef");
  assert.equal(submissionAttempt(first, bookingRequest({ ...filled }, "2026-11-02"), generate), first, "an unchanged retry reuses the key");
  const changed = submissionAttempt(first, bookingRequest({ ...filled, headcount: "7" }, "2026-11-02"), generate);
  assert.equal(changed.key, "key-2-0123456789abcdef");
  assert.match(newSubmissionKey(), /^[A-Za-z0-9_-]{16,128}$/);
  assert.match(newSubmissionKey({ getRandomValues: <T extends ArrayBufferView | null>(array: T) => array }), /^[0-9a-f]{32}$/, "falls back to random bytes without randomUUID");
});

test("the team lookup runs only for a valid number and fills only an empty or looked-up name", () => {
  assert.equal(lookupNumber("", "321"), null);
  assert.equal(lookupNumber("FRC", "32a"), null);
  assert.equal(lookupNumber("FRC", "0321"), "321");
  assert.equal(lookupNumber("Other", "99x"), "99X");
  assert.equal(teamLookupQuery("Challenge", "12345"), "program=Challenge&number=12345");
  const found = { number: "321", name: "Lancers", program: "FRC" as const };
  assert.equal(lookupFill(found, "", null), "Lancers");
  assert.equal(lookupFill(found, "Old lookup", "Old lookup"), "Lancers");
  assert.equal(lookupFill(found, "Typed by hand", null), null, "a typed name stays");
  assert.equal(lookupFill(null, "Old lookup", "Old lookup"), "", "a looked-up name clears when the number no longer matches");
  assert.equal(lookupFill(null, "Typed by hand", "Old lookup"), null);
});

const booking: StaffBooking = {
  id: "b1", revision: 4, status: "booked", team: { id: "t1", number: "321", name: "Lancers", program: "FRC" }, windowId: "w1", windowTitle: "Open shop",
  date: "2026-11-02", arrival: "18:00", departure: "20:00", arrivalMs: 0, departureMs: 7_200_000, headcount: 6, note: "Robot", contactName: "Sam Coach",
  contactEmail: "coach@example.org", contactPhone: "", attention: { state: "none", reason: null }, email: "sent", outreach: null, createdMs: 0, updatedMs: 0,
};

test("a visit edit sends only what changed, with date and times together", () => {
  const draft = visitDraft(booking);
  assert.deepEqual(validateVisitDraft(draft), {});
  assert.equal(visitEdit(booking, draft), null, "nothing changed");
  assert.deepEqual(visitEdit(booking, { ...draft, headcount: "8" }), { revision: 4, headcount: 8 });
  assert.deepEqual(visitEdit(booking, { ...draft, departure: "20:30" }), { revision: 4, date: "2026-11-02", arrival: "18:00", departure: "20:30" });
  assert.deepEqual(visitEdit(booking, { ...draft, note: "  Robot  ", contactName: " Sam   Coach ", contactPhone: " " }), null, "spacing alone is no change");
  assert.deepEqual(visitEdit(booking, { ...draft, note: "", contactPhone: "555-123-4567" }), { revision: 4, note: "", contactPhone: "555-123-4567" });
  const parsed = parseGuestEdit(visitEdit(booking, { ...draft, date: "2026-11-04", headcount: "3" }));
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.deepEqual(validateVisitDraft({ ...draft, departure: "18:00", headcount: "x", contactName: " " }), { departure: "The departure must be after the arrival", headcount: "Enter how many people are coming", contactName: "Enter the contact name" });
});

test("a staff edit also corrects the email address and team, sent only when changed", () => {
  const draft = staffVisitDraft(booking);
  assert.equal(staffVisitEdit(booking, draft), null);
  assert.deepEqual(staffVisitEdit(booking, { ...draft, contactEmail: " new@example.org " }), { revision: 4, contactEmail: "new@example.org" });
  assert.deepEqual(staffVisitEdit(booking, { ...draft, teamId: "t2", headcount: "5" }), { revision: 4, headcount: 5, teamId: "t2" });
  assert.deepEqual(validateStaffVisitDraft({ ...draft, contactEmail: "nope", teamId: "" }), { contactEmail: "Enter one email address, like name@example.org", teamId: "Choose the guest team" });
});

test("availability drafts become series or window requests checked by the Worker's rules", () => {
  const draft = availabilityDraft("2026-11-02");
  assert.equal(draft.lastDate, "2026-12-27");
  assert.deepEqual(availabilityRequest(draft), { ok: false, field: "weekdays", error: "Choose at least one weekday" });
  assert.deepEqual(availabilityRequest({ ...draft, weekdays: [3, 1], lastDate: "2026-12-18", title: " Open  shop " }), {
    ok: true, kind: "series", value: { weekdays: [1, 3], startTime: "18:00", endTime: "21:00", firstDate: "2026-11-02", lastDate: "2026-12-18", title: "Open shop" },
  });
  assert.deepEqual(availabilityRequest({ ...draft, repeating: false, date: "2026-11-07", startTime: "09:00", endTime: "12:00" }), { ok: true, kind: "window", value: { date: "2026-11-07", startTime: "09:00", endTime: "12:00" } });
  assert.deepEqual(availabilityRequest({ ...draft, repeating: false, endTime: "17:00" }), { ok: false, field: "endTime", error: "The end time must be after the start time on the same day" });
  assert.deepEqual(availabilityRequest({ ...draft, weekdays: [1], lastDate: "2026-10-01" }), { ok: false, field: "lastDate", error: "The last date must be on or after the first date" });
  assert.deepEqual(cancelReason("  Thanksgiving  break "), { ok: true, reason: "Thanksgiving break" });
  assert.equal(cancelReason(" ").ok, false);
});

test("settings updates carry only changed fields with the revision", () => {
  const saved: VisitsSettings = { revision: 2, hostName: "FRC 321 Lancers", introText: "Welcome", replyTo: "", testEmailSentMs: null, discordEnabled: false, discordChannelId: "", weeklySummaryEnabled: true, weeklySummaryWeekday: 1, weeklySummaryTime: "12:00" };
  assert.equal(settingsUpdate(saved, saved, ["introText", "replyTo"]), null);
  assert.deepEqual(settingsUpdate(saved, { ...saved, introText: "Hello", discordEnabled: true }, ["introText", "replyTo"]), { revision: 2, introText: "Hello" });
  assert.deepEqual(settingsUpdate(saved, { ...saved, hostName: "", introText: "Welcome" }, ["hostName", "introText"]), { revision: 2, hostName: "" });
  assert.deepEqual(settingsUpdate(saved, { ...saved, discordEnabled: true, discordChannelId: "123456789012345678", weeklySummaryWeekday: 5 }, ["discordEnabled", "discordChannelId", "weeklySummaryEnabled", "weeklySummaryWeekday", "weeklySummaryTime"]), {
    revision: 2, discordEnabled: true, discordChannelId: "123456789012345678", weeklySummaryWeekday: 5,
  });
  assert.equal(guestPageLink("https://lancers.example.org/"), "https://lancers.example.org/visit");
  assert.equal(guestPageLink("http://localhost:5191"), "http://localhost:5191/visit");
});
