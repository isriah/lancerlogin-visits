// Guest booking rules: validating a booking and manage-page edits, fitting a visit into one open window, what the public
// page may show, change history and when a visit needs staff attention. Any number of visits may overlap.
import {
  dayMs, isLocalDate, isLocalTime, localRange, minutesOfDay, multiLine, ok, problem, rangeContains, singleLine,
  type CivilTime, type Problem, type Result, type TimeRange,
} from "./visits-time.ts";
import type { WindowStatus } from "./visits-schedule.ts";

/** Program values match Outreach's supported-team programs, plus Other. */
export const visitPrograms = ["FRC", "FTC", "Challenge", "Explore", "Other"] as const;
export type VisitProgram = (typeof visitPrograms)[number];
/** Outreach's programs. A team with program Other is never linked to an Outreach supported team. */
export type OutreachProgram = Exclude<VisitProgram, "Other">;
export const programLabels: Readonly<Record<VisitProgram, string>> = {
  FRC: "FRC", FTC: "FTC", Challenge: "FIRST LEGO League Challenge", Explore: "FIRST LEGO League Explore", Other: "Other",
};
/** Short form before a team number: "FRC 321", "FLL Challenge 12345", "Team 99X". */
export const programShortLabels: Readonly<Record<VisitProgram, string>> = {
  FRC: "FRC", FTC: "FTC", Challenge: "FLL Challenge", Explore: "FLL Explore", Other: "Team",
};

/** The Outreach program for a team, or null for Other, which Outreach does not support. */
export function outreachProgram(program: VisitProgram): OutreachProgram | null {
  return program === "Other" ? null : program;
}

export const maximumTeamNameLength = 100;
export const maximumContactNameLength = 100;
export const maximumEmailLength = 254;
export const maximumPhoneLength = 40;
export const maximumNoteLength = 1000;
export const minimumHeadcount = 1;
export const maximumHeadcount = 100;
/** Guests see and book windows that start within this many days. */
export const guestHorizonDays = 56;

export type TeamIdentity = { readonly number: string; readonly name: string; readonly program: VisitProgram };
export type ContactDetails = { readonly name: string; readonly email: string; readonly phone: string };

/** A validated guest booking request. Times are local, on `date`, in the installation time zone. */
export type GuestBookingInput = {
  readonly team: TeamIdentity;
  readonly contact: ContactDetails;
  readonly date: string;
  readonly arrival: string;
  readonly departure: string;
  /** Null when the guest did not give one. Whether one is required is a setting the Worker checks. */
  readonly headcount: number | null;
  readonly note: string;
  /** Client-generated idempotency key: the same key never books twice. */
  readonly submissionKey: string;
};

/** The booking fields guests and staff can see change. Instants are epoch milliseconds. */
export type BookingDetails = {
  readonly windowId: string;
  readonly teamId: string;
  readonly contactName: string;
  readonly contactEmail: string;
  readonly contactPhone: string;
  readonly arrivalMs: number;
  readonly departureMs: number;
  /** How many people are coming, or null when the guest did not say. */
  readonly headcount: number | null;
  readonly note: string;
  readonly status: BookingStatus;
};
export type BookingStatus = "booked" | "canceled";
export type StoredBooking = BookingDetails & { readonly id: string; readonly revision: number };

/** A window as the booking rules need it. */
export type BookableWindow = TimeRange & { readonly id: string; readonly status: WindowStatus; readonly title?: string; readonly cancelReason?: string };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function text(value: unknown, field: string, label: string, maximum: number, required: boolean): Result<string> {
  if (value === undefined || value === null) return required ? problem(field, `Enter the ${label}`) : ok("");
  if (typeof value !== "string") return problem(field, `Enter the ${label} as text`);
  const result = singleLine(value);
  if (required && !result) return problem(field, `Enter the ${label}`);
  if (result.length > maximum) return problem(field, `The ${label} is at most ${maximum} characters`);
  return ok(result);
}

/** Validate a program value. */
export function parseProgram(value: unknown, field = "program"): Result<VisitProgram> {
  return visitPrograms.includes(value as VisitProgram) ? ok(value as VisitProgram) : problem(field, "Choose FRC, FTC, FIRST LEGO League Challenge, FIRST LEGO League Explore or Other");
}

/**
 * Validate and normalize a team number for its program. FRC, FTC, Challenge and Explore numbers are 1 to 6 digits without
 * leading zeros ("0321" becomes "321"). Other teams use up to 10 letters, digits and hyphens, in capitals ("99x" becomes "99X").
 */
export function parseTeamNumber(value: unknown, program: VisitProgram, field = "teamNumber"): Result<string> {
  if (typeof value !== "string" && typeof value !== "number") return problem(field, "Enter the team number");
  const raw = String(value).trim().replace(/^#/, "").trim();
  if (!raw) return problem(field, "Enter the team number");
  if (program === "Other") {
    const code = raw.toUpperCase();
    return /^[A-Z0-9](?:[A-Z0-9-]{0,9})$/.test(code) ? ok(code) : problem(field, "Team numbers are up to 10 letters, digits and hyphens");
  }
  if (!/^\d+$/.test(raw)) return problem(field, `${programLabels[program]} team numbers are digits only`);
  const number = raw.replace(/^0+/, "");
  if (!number) return problem(field, "Enter the team number");
  return number.length <= 6 ? ok(number) : problem(field, "Team numbers are at most 6 digits");
}

/** Validate the team's program, number and name. */
export function parseTeam(value: Record<string, unknown>): Result<TeamIdentity> {
  const program = parseProgram(value.program);
  if (!program.ok) return program;
  const number = parseTeamNumber(value.teamNumber, program.value);
  if (!number.ok) return number;
  const name = text(value.teamName, "teamName", "team name", maximumTeamNameLength, true);
  if (!name.ok) return name;
  return ok({ number: number.value, name: name.value, program: program.value });
}

const emailPattern = /^[^\s@<>()[\]\\,;:"]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/** Validate an email address: trimmed, one address, no display name. */
export function parseEmail(value: unknown, field = "contactEmail"): Result<string> {
  if (typeof value !== "string" || !value.trim()) return problem(field, "Enter an email address for the confirmation");
  const email = value.trim();
  if (email.length > maximumEmailLength || !emailPattern.test(email)) return problem(field, "Enter one email address, like name@example.org");
  return ok(email);
}

/** Validate an optional phone number: digits with spaces, parentheses, dots, hyphens and a leading +. No letters, so no extension. */
export function parsePhone(value: unknown, field = "contactPhone"): Result<string> {
  if (value === undefined || value === null) return ok("");
  if (typeof value !== "string") return problem(field, "Enter the phone number as text");
  const phone = singleLine(value);
  if (!phone) return ok("");
  if (/\p{L}/u.test(phone)) return problem(field, "Enter the phone number without letters or an extension");
  if (!/^\+?[0-9 ().-]+$/.test(phone)) return problem(field, "Use only digits, spaces, dots, hyphens, parentheses and a leading +");
  const digits = phone.replace(/\D/g, "").length;
  if (phone.length > maximumPhoneLength || digits < 7 || digits > 21) return problem(field, "Enter a phone number with its area code, or leave it empty");
  return ok(phone);
}

/** Validate a headcount: a whole number of people within the bounds. */
export function parseHeadcount(value: unknown, field = "headcount"): Result<number> {
  const count = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof count !== "number" || !Number.isInteger(count)) return problem(field, "Enter how many people are coming");
  if (count < minimumHeadcount || count > maximumHeadcount) return problem(field, `Visits are for ${minimumHeadcount} to ${maximumHeadcount} people`);
  return ok(count);
}

/** Validate an optional headcount: nothing (undefined, null or an empty string) is null, anything else must be valid. */
export function parseOptionalHeadcount(value: unknown, field = "headcount"): Result<number | null> {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return ok(null);
  return parseHeadcount(value, field);
}

/** The refusal when an Admin requires a headcount and none was given. */
export const headcountRequiredProblem: Problem = problem("headcount", "Enter how many people are coming");

/** Validate an optional note to staff. Line breaks are kept. */
export function parseNote(value: unknown, field = "note"): Result<string> {
  if (value === undefined || value === null) return ok("");
  if (typeof value !== "string") return problem(field, "Enter team needs as text");
  const note = multiLine(value);
  if (note.length > maximumNoteLength) return problem(field, `Team needs are at most ${maximumNoteLength} characters`);
  return ok(note);
}

function parseVisitTimes(value: Record<string, unknown>): Result<{ date: string; arrival: string; departure: string }> {
  if (!isLocalDate(value.date)) return problem("date", "Choose the visit date");
  if (!isLocalTime(value.arrival)) return problem("arrival", "Enter the arrival time as HH:MM");
  if (!isLocalTime(value.departure)) return problem("departure", "Enter the departure time as HH:MM");
  if (minutesOfDay(value.departure) <= minutesOfDay(value.arrival)) return problem("departure", "The departure must be after the arrival");
  return ok({ date: value.date, arrival: value.arrival, departure: value.departure });
}

const bookingFields = ["teamNumber", "teamName", "program", "contactName", "contactEmail", "contactPhone", "date", "arrival", "departure", "headcount", "note", "submissionKey"];

/** Validate a guest booking request body. Unknown fields are refused. */
export function parseBookingInput(value: unknown): Result<GuestBookingInput> {
  if (!isRecord(value)) return problem("", "Send the booking as a JSON object");
  const unexpected = Object.keys(value).find((key) => !bookingFields.includes(key));
  if (unexpected) return problem(unexpected, `Unexpected field ${unexpected}`);
  if (typeof value.submissionKey !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value.submissionKey)) return problem("submissionKey", "Reload the page and try again");
  const team = parseTeam(value);
  if (!team.ok) return team;
  const contactName = text(value.contactName, "contactName", "contact name", maximumContactNameLength, true);
  if (!contactName.ok) return contactName;
  const email = parseEmail(value.contactEmail);
  if (!email.ok) return email;
  const phone = parsePhone(value.contactPhone);
  if (!phone.ok) return phone;
  const times = parseVisitTimes(value);
  if (!times.ok) return times;
  const headcount = parseOptionalHeadcount(value.headcount);
  if (!headcount.ok) return headcount;
  const note = parseNote(value.note);
  if (!note.ok) return note;
  return ok({
    team: team.value, contact: { name: contactName.value, email: email.value, phone: phone.value },
    ...times.value, headcount: headcount.value, note: note.value, submissionKey: value.submissionKey,
  });
}

/** Canonical text of a booking request without its submission key. Hash it to detect a key reused for another booking. */
export function bookingFingerprintText(input: GuestBookingInput): string {
  return JSON.stringify([input.team.program, input.team.number, input.team.name, input.contact.name, input.contact.email.toLowerCase(), input.contact.phone, input.date, input.arrival, input.departure, input.headcount, input.note]);
}

/** What a submission key means: a new booking, a repeat of one already saved, or a key reused for different details. */
export type SubmissionOutcome = { readonly kind: "new" } | { readonly kind: "replay"; readonly bookingId: string } | { readonly kind: "conflict" };

export function submissionOutcome(existing: { readonly fingerprint: string; readonly bookingId: string } | null | undefined, fingerprint: string): SubmissionOutcome {
  if (!existing) return { kind: "new" };
  return existing.fingerprint === fingerprint ? { kind: "replay", bookingId: existing.bookingId } : { kind: "conflict" };
}

/** Instants for a visit's local date, arrival and departure. Refused when both fall in one skipped daylight saving hour. */
export function resolveVisitTimes(civil: CivilTime, timeZone: string, date: string, arrival: string, departure: string): Result<{ readonly arrivalMs: number; readonly departureMs: number }> {
  const range = localRange(civil, timeZone, date, arrival, departure);
  if (range.endMs <= range.startMs) return problem("arrival", "These times do not exist on that date because the clocks change");
  return ok({ arrivalMs: range.startMs, departureMs: range.endMs });
}

/** Whether a visit lies inside an open window. */
export function visitFits(window: BookableWindow, visit: { readonly arrivalMs: number; readonly departureMs: number }): boolean {
  return window.status === "open" && rangeContains(window, { startMs: visit.arrivalMs, endMs: visit.departureMs });
}

/** The one open window that contains the visit. Windows never overlap, so there is at most one. */
export function findFittingWindow(windows: readonly BookableWindow[], visit: { readonly arrivalMs: number; readonly departureMs: number }): Result<BookableWindow> {
  const fitting = windows.find((window) => visitFits(window, visit));
  if (fitting) return ok(fitting);
  const canceled = windows.find((window) => window.status === "canceled" && rangeContains(window, { startMs: visit.arrivalMs, endMs: visit.departureMs }));
  if (canceled) return problem("date", canceled.cancelReason ? `That time is canceled: ${canceled.cancelReason}` : "That time is canceled");
  return problem("arrival", "Choose an arrival and departure inside one open time");
}

/**
 * Where a guest may book or move a visit: it has not started, it fits one open window, and that window starts within the
 * guest horizon (the windows the guest page shows).
 */
export function checkGuestVisit(windows: readonly BookableWindow[], visit: { readonly arrivalMs: number; readonly departureMs: number }, now: number): Result<BookableWindow> {
  if (visit.arrivalMs <= now) return problem("arrival", "Choose a visit that has not started yet");
  const window = findFittingWindow(windows, visit);
  if (!window.ok) return window;
  if (window.value.startMs >= now + guestHorizonDays * dayMs) return problem("date", `Visits can be booked up to ${guestHorizonDays / 7} weeks ahead`);
  return window;
}

/** What anyone with the page URL sees of a visit: never contact details or the note. */
export type PublicVisit = {
  readonly teamNumber: string;
  readonly teamName: string;
  readonly program: VisitProgram;
  readonly arrivalMs: number;
  readonly departureMs: number;
  readonly headcount: number | null;
};

export function publicVisit(booking: Pick<BookingDetails, "arrivalMs" | "departureMs" | "headcount">, team: TeamIdentity): PublicVisit {
  return { teamNumber: team.number, teamName: team.name, program: team.program, arrivalMs: booking.arrivalMs, departureMs: booking.departureMs, headcount: booking.headcount };
}

export type PublicWindow = TimeRange & {
  readonly id: string;
  readonly title: string;
  readonly status: "open" | "canceled";
  readonly cancelReason: string;
  /** Distinct teams coming. */
  readonly teamCount: number;
  readonly visits: readonly PublicVisit[];
};

/**
 * The guest page: windows that have not ended and start within the guest horizon, in order, each with its booked visits
 * by arrival. Removed windows are left out. A canceled window stays listed with its reason and shows no visits; staff
 * contact those teams from Needs attention.
 */
export function publicWindows(input: {
  readonly windows: readonly (BookableWindow & { readonly title: string; readonly cancelReason: string })[];
  readonly bookings: readonly (Pick<BookingDetails, "windowId" | "teamId" | "arrivalMs" | "departureMs" | "headcount" | "status">)[];
  readonly teams: ReadonlyMap<string, TeamIdentity>;
  readonly now: number;
}): PublicWindow[] {
  const horizon = input.now + guestHorizonDays * dayMs;
  return input.windows
    .filter((window) => window.status !== "removed" && window.endMs > input.now && window.startMs < horizon)
    .sort((left, right) => left.startMs - right.startMs)
    .map((window) => {
      const booked = window.status === "open"
        ? input.bookings.filter((booking) => booking.windowId === window.id && booking.status === "booked" && input.teams.has(booking.teamId))
          .sort((left, right) => left.arrivalMs - right.arrivalMs || left.departureMs - right.departureMs)
        : [];
      return {
        id: window.id, startMs: window.startMs, endMs: window.endMs, title: window.title, status: window.status as "open" | "canceled",
        cancelReason: window.status === "canceled" ? window.cancelReason : "",
        teamCount: new Set(booked.map((booking) => booking.teamId)).size,
        visits: booked.map((booking) => publicVisit(booking, input.teams.get(booking.teamId)!)),
      };
    });
}

/** Why a visit needs staff attention. */
export const attentionReasons = ["window-canceled", "window-removed", "window-changed", "outreach-activity-kept"] as const;
export type AttentionReason = (typeof attentionReasons)[number];
export type WindowAttentionReason = Exclude<AttentionReason, "outreach-activity-kept">;
export type AttentionState = "none" | "needed" | "handled";
export type Attention = { readonly state: AttentionState; readonly reason: AttentionReason | null };
export const noAttention: Attention = { state: "none", reason: null };

/** Why a booked visit no longer stands in its window, if it does not: canceled, removed (or missing), or changed so it no longer fits. */
export function windowAttentionReason(booking: Pick<BookingDetails, "status" | "arrivalMs" | "departureMs">, window: BookableWindow | null | undefined): WindowAttentionReason | null {
  if (booking.status !== "booked") return null;
  if (!window || window.status === "removed") return "window-removed";
  if (window.status === "canceled") return "window-canceled";
  return visitFits(window, booking) ? null : "window-changed";
}

/**
 * Attention after a window change. A new or different window reason needs attention again, even if staff handled an
 * earlier one; the same reason keeps its state. When the window problem is gone (for example the window was restored)
 * a window reason clears, while an Outreach reason stays until staff handle it.
 */
export function nextAttention(current: Attention, windowReason: WindowAttentionReason | null): Attention {
  if (windowReason) return current.reason === windowReason ? current : { state: "needed", reason: windowReason };
  return current.reason && current.reason !== "outreach-activity-kept" ? noAttention : current;
}

/**
 * Attention when a visit already recorded in Outreach is canceled or moved to another date: the earlier Outreach activity
 * stays, since members may have logged hours to it. A window problem takes priority and is kept.
 */
export function outreachActivityKeptAttention(current: Attention): Attention {
  return current.reason && current.reason !== "outreach-activity-kept" && current.state === "needed" ? current : { state: "needed", reason: "outreach-activity-kept" };
}

/** Staff marked the visit handled after contacting the team. */
export function handledAttention(current: Attention): Attention {
  return current.reason ? { state: "handled", reason: current.reason } : noAttention;
}

/** A validated manage-page edit. Only the fields present change; date, arrival and departure always come together. */
export type GuestEdit = {
  readonly revision: number;
  readonly times?: { readonly date: string; readonly arrival: string; readonly departure: string };
  /** Null clears it. */
  readonly headcount?: number | null;
  readonly note?: string;
  readonly contactName?: string;
  readonly contactPhone?: string;
};

const guestEditFields = ["revision", "date", "arrival", "departure", "headcount", "note", "contactName", "contactPhone"];
const staffOnlyFields = ["teamNumber", "teamName", "program", "contactEmail", "email", "teamId", "windowId", "status"];

/** Validate a revision a client sends back with an edit. */
export function parseRevision(value: unknown): Result<number> {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? ok(value as number) : problem("revision", "Reload the page and try again");
}

/** Validate a manage-page edit body. Team and email address changes go through staff. */
export function parseGuestEdit(value: unknown): Result<GuestEdit> {
  if (!isRecord(value)) return problem("", "Send the change as a JSON object");
  const staffOnly = Object.keys(value).find((key) => staffOnlyFields.includes(key));
  if (staffOnly) return problem(staffOnly, "Ask the team you are visiting to change the team or email address");
  const unexpected = Object.keys(value).find((key) => !guestEditFields.includes(key));
  if (unexpected) return problem(unexpected, `Unexpected field ${unexpected}`);
  const revision = parseRevision(value.revision);
  if (!revision.ok) return revision;
  const edit: { -readonly [Key in keyof GuestEdit]: GuestEdit[Key] } = { revision: revision.value };
  const timeFields = ["date", "arrival", "departure"].filter((key) => key in value);
  if (timeFields.length) {
    if (timeFields.length !== 3) return problem("date", "Send the date, arrival and departure together");
    const times = parseVisitTimes(value);
    if (!times.ok) return times;
    edit.times = times.value;
  }
  if ("headcount" in value) { const headcount = parseOptionalHeadcount(value.headcount); if (!headcount.ok) return headcount; edit.headcount = headcount.value; }
  if ("note" in value) { const note = parseNote(value.note); if (!note.ok) return note; edit.note = note.value; }
  if ("contactName" in value) { const name = text(value.contactName, "contactName", "contact name", maximumContactNameLength, true); if (!name.ok) return name; edit.contactName = name.value; }
  if ("contactPhone" in value) { const phone = parsePhone(value.contactPhone); if (!phone.ok) return phone; edit.contactPhone = phone.value; }
  return ok(edit);
}

export type FieldChange = { readonly field: keyof BookingDetails; readonly from: string | number | null; readonly to: string | number | null };

const detailFields: readonly (keyof BookingDetails)[] = ["windowId", "teamId", "contactName", "contactEmail", "contactPhone", "arrivalMs", "departureMs", "headcount", "note", "status"];

/** The fields that differ between two versions of a booking, in a fixed order. */
export function diffBooking(before: BookingDetails, after: BookingDetails): FieldChange[] {
  return detailFields.filter((field) => before[field] !== after[field]).map((field) => ({ field, from: before[field], to: after[field] }));
}

/** Copy only the booking detail fields, dropping IDs, revision and bookkeeping. */
export function bookingDetails(booking: BookingDetails): BookingDetails {
  return Object.fromEntries(detailFields.map((field) => [field, booking[field]])) as BookingDetails;
}

function staleOrClosed(booking: StoredBooking, revision: number): Result<null> {
  if (booking.status === "canceled") return problem("status", "This visit was canceled");
  if (revision !== booking.revision) return problem("revision", "This visit changed since you opened it. Reload to see the latest details.");
  return ok(null);
}

/**
 * Apply a manage-page edit. A visit is re-checked against the windows only when its date or times change, so a guest can
 * still update the headcount of a visit whose window staff canceled. Returns the new details and what changed (empty
 * when nothing did).
 */
export function applyGuestEdit(input: {
  readonly civil: CivilTime;
  readonly timeZone: string;
  readonly booking: StoredBooking;
  readonly edit: GuestEdit;
  readonly windows: readonly BookableWindow[];
  readonly now: number;
}): Result<{ readonly next: BookingDetails; readonly changes: FieldChange[] }> {
  const { booking, edit } = input;
  const open = staleOrClosed(booking, edit.revision);
  if (!open.ok) return open;
  let next: BookingDetails = {
    ...bookingDetails(booking),
    ...(edit.headcount === undefined ? {} : { headcount: edit.headcount }),
    ...(edit.note === undefined ? {} : { note: edit.note }),
    ...(edit.contactName === undefined ? {} : { contactName: edit.contactName }),
    ...(edit.contactPhone === undefined ? {} : { contactPhone: edit.contactPhone }),
  };
  if (edit.times) {
    const times = resolveVisitTimes(input.civil, input.timeZone, edit.times.date, edit.times.arrival, edit.times.departure);
    if (!times.ok) return times;
    if (times.value.arrivalMs !== booking.arrivalMs || times.value.departureMs !== booking.departureMs) {
      const window = checkGuestVisit(input.windows, times.value, input.now);
      if (!window.ok) return window;
      next = { ...next, ...times.value, windowId: window.value.id };
    }
  }
  return ok({ next, changes: diffBooking(booking, next) });
}

/** Cancel a visit from the manage page. */
export function applyGuestCancel(booking: StoredBooking, revision: number): Result<{ readonly next: BookingDetails; readonly changes: FieldChange[] }> {
  const open = staleOrClosed(booking, revision);
  if (!open.ok) return open;
  const next: BookingDetails = { ...bookingDetails(booking), status: "canceled" };
  return ok({ next, changes: diffBooking(booking, next) });
}

/** `removed`: staff removed the visit, which cancels it without an email and hides it from every list. */
export const revisionActions = ["created", "updated", "canceled", "restored", "removed"] as const;
export type RevisionAction = (typeof revisionActions)[number];
/** Who made a change: the guest through the emailed link, or a staff member. */
export type RevisionActor = { readonly kind: "guest" } | { readonly kind: "staff"; readonly userId: string };

/** A visits_booking_revisions row: the change, and the booking after it, so staff can restore any earlier version. */
export type BookingRevisionRow = {
  readonly booking_id: string;
  readonly revision: number;
  readonly action: RevisionAction;
  readonly actor_kind: "guest" | "staff";
  readonly staff_user_id: string | null;
  readonly change_json: string;
  readonly snapshot_json: string;
  readonly created_at: string;
};

export function bookingRevisionRow(input: {
  readonly bookingId: string;
  readonly revision: number;
  readonly action: RevisionAction;
  readonly actor: RevisionActor;
  readonly changes: readonly FieldChange[];
  readonly snapshot: BookingDetails;
  readonly at: string;
}): BookingRevisionRow {
  return {
    booking_id: input.bookingId, revision: input.revision, action: input.action, actor_kind: input.actor.kind,
    staff_user_id: input.actor.kind === "staff" ? input.actor.userId : null,
    change_json: JSON.stringify(input.changes), snapshot_json: JSON.stringify(bookingDetails(input.snapshot)), created_at: input.at,
  };
}

/** Read a revision snapshot back, for restoring an earlier version. Refuses anything that is not a complete booking. */
export function parseBookingSnapshot(json: string): Result<BookingDetails> {
  let value: unknown;
  try { value = JSON.parse(json); } catch { return problem("snapshot", "This version cannot be read"); }
  if (!isRecord(value)) return problem("snapshot", "This version cannot be read");
  const strings = ["windowId", "teamId", "contactName", "contactEmail", "contactPhone", "note"] as const;
  const integers = ["arrivalMs", "departureMs"] as const;
  // Versions saved before headcount became optional always have one; later ones may have null.
  if (strings.some((field) => typeof value[field] !== "string") || integers.some((field) => !Number.isSafeInteger(value[field]))
    || (value.headcount !== null && !Number.isSafeInteger(value.headcount))
    || (value.status !== "booked" && value.status !== "canceled") || (value.departureMs as number) <= (value.arrivalMs as number)) {
    return problem("snapshot", "This version cannot be read");
  }
  return ok(bookingDetails(value as unknown as BookingDetails));
}

/** "FRC 321 RoboLancers". */
export function teamLabel(team: TeamIdentity): string {
  return `${programShortLabels[team.program]} ${team.number} ${team.name}`;
}
