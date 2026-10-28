// Form state for the Guest Visits pages: drafts held as text, checked with the same src/shared rules the Worker applies,
// and turned into contract requests that carry only what changed. Also reads the API's `{ error, field }` failures and
// keeps one submission key per booking attempt. Plain functions, so `npm test` covers them without React.
import {
  maximumContactNameLength, maximumTeamNameLength, parseEmail, parseHeadcount, parseNote, parsePhone, parseProgram, parseTeamNumber,
  type TeamIdentity, type VisitProgram,
} from "../shared/visits-booking.ts";
import { parseCancelReason, parseSeriesInput, parseWindowInput } from "../shared/visits-schedule.ts";
import { addDays, isLocalTime, minutesOfDay, singleLine } from "../shared/visits-time.ts";
import type {
  ManageEditRequest, ManageView, PublicBookingRequest, SeriesRequest, StaffBooking, StaffBookingEdit, VisitsSettings, VisitsSettingsUpdate, WindowRequest,
} from "../shared/visits-api.ts";

/** Messages by request field name. */
export type FieldErrors = Readonly<Record<string, string>>;

/** A failed request: the API's message and field, its status (null when no response arrived) and whether a retry may help. */
export type VisitsFailure = { readonly message: string; readonly field: string; readonly status: number | null; readonly transient: boolean };

export const unreachableMessage = "Guest Visits could not be reached. Check your connection and try again.";

/** Read a failed response body. Core's `details` win over `error`, as `dashboardApi` reads them. */
export function readFailure(status: number | null, body: unknown): VisitsFailure {
  const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const details = Array.isArray(record.details) && record.details.every((item) => typeof item === "string") ? (record.details as string[]).join(" ") : "";
  const error = typeof record.error === "string" && record.error.trim() ? record.error.trim() : "";
  const transient = status === null || status === 429 || status >= 500;
  const message = details || error || (status === null ? unreachableMessage : transient ? "Guest Visits is unavailable right now. Try again in a moment." : "The request was refused.");
  return { message, field: typeof record.field === "string" ? record.field : "", status, transient };
}

const collect = (entries: readonly (readonly [string, { ok: true } | { ok: false; error: string }])[]): FieldErrors =>
  Object.fromEntries(entries.filter(([, result]) => !result.ok).map(([field, result]) => [field, (result as { error: string }).error]));

const requiredText = (value: string, label: string, maximum: number) => {
  const text = singleLine(value);
  if (!text) return { ok: false as const, error: `Enter the ${label}` };
  return text.length > maximum ? { ok: false as const, error: `The ${label} is at most ${maximum} characters` } : { ok: true as const };
};

const timesInOrder = (arrival: string, departure: string) => {
  if (!isLocalTime(departure)) return { ok: false as const, error: "Choose the departure time" };
  return isLocalTime(arrival) && minutesOfDay(departure) <= minutesOfDay(arrival) ? { ok: false as const, error: "The departure must be after the arrival" } : { ok: true as const };
};

// Guest booking.

/** The booking form as typed. `windowId` picks the open window; the request sends that window's date. */
export type BookingDraft = {
  readonly program: VisitProgram | "";
  readonly teamNumber: string;
  readonly teamName: string;
  readonly contactName: string;
  readonly contactEmail: string;
  readonly contactPhone: string;
  readonly windowId: string;
  readonly arrival: string;
  readonly departure: string;
  readonly headcount: string;
  readonly note: string;
};

export const emptyBookingDraft: BookingDraft = {
  program: "", teamNumber: "", teamName: "", contactName: "", contactEmail: "", contactPhone: "", windowId: "", arrival: "", departure: "", headcount: "", note: "",
};

/** Request fields in form order, for focusing the first problem. The window select answers for `date`. */
export const bookingFieldOrder = ["program", "teamNumber", "teamName", "contactName", "contactEmail", "contactPhone", "date", "arrival", "departure", "headcount", "note"] as const;

/** Every problem in the booking form, by request field, using the Worker's own rules. */
export function validateBookingDraft(draft: BookingDraft, windowDate: string | undefined): FieldErrors {
  const program = parseProgram(draft.program);
  return collect([
    ["program", program],
    ["teamNumber", program.ok ? parseTeamNumber(draft.teamNumber, program.value) : draft.teamNumber.trim() ? { ok: true } : { ok: false, error: "Enter the team number" }],
    ["teamName", requiredText(draft.teamName, "team name", maximumTeamNameLength)],
    ["contactName", requiredText(draft.contactName, "contact name", maximumContactNameLength)],
    ["contactEmail", parseEmail(draft.contactEmail)],
    ["contactPhone", parsePhone(draft.contactPhone)],
    ["date", windowDate ? { ok: true } : { ok: false, error: "Choose when to visit" }],
    ["arrival", isLocalTime(draft.arrival) ? { ok: true } : { ok: false, error: "Choose the arrival time" }],
    ["departure", timesInOrder(draft.arrival, draft.departure)],
    ["headcount", parseHeadcount(draft.headcount)],
    ["note", parseNote(draft.note)],
  ]);
}

/** The booking request without its submission key. Optional fields are left out when empty. */
export function bookingRequest(draft: BookingDraft, windowDate: string): Omit<PublicBookingRequest, "submissionKey"> {
  const program = parseProgram(draft.program);
  const number = program.ok ? parseTeamNumber(draft.teamNumber, program.value) : null;
  const phone = singleLine(draft.contactPhone);
  const note = draft.note.trim();
  return {
    teamNumber: number?.ok ? number.value : draft.teamNumber.trim(),
    teamName: singleLine(draft.teamName),
    program: draft.program as VisitProgram,
    contactName: singleLine(draft.contactName),
    contactEmail: draft.contactEmail.trim(),
    ...(phone ? { contactPhone: phone } : {}),
    date: windowDate,
    arrival: draft.arrival,
    departure: draft.departure,
    headcount: Number(draft.headcount.trim()),
    ...(note ? { note } : {}),
  };
}

/** One booking attempt: its idempotency key and the request it was made for. */
export type SubmissionAttempt = { readonly key: string; readonly fingerprint: string };

/**
 * The key for submitting this request: the previous attempt's key when the request is unchanged (a retry, which the Worker
 * answers with the first result), otherwise a new key, since the Worker refuses a key reused for other details.
 */
export function submissionAttempt(previous: SubmissionAttempt | null, request: Omit<PublicBookingRequest, "submissionKey">, generate: () => string): SubmissionAttempt {
  const fingerprint = JSON.stringify(request);
  return previous?.fingerprint === fingerprint ? previous : { key: generate(), fingerprint };
}

/** A submission key the Worker accepts (16 to 128 letters, digits, hyphens or underscores). */
export function newSubmissionKey(cryptoSource: Pick<Crypto, "getRandomValues"> & { randomUUID?: () => string } = globalThis.crypto): string {
  if (typeof cryptoSource.randomUUID === "function") return cryptoSource.randomUUID();
  return [...cryptoSource.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A team number the lookup can use, or null while the number is incomplete or invalid for the program. */
export function lookupNumber(program: VisitProgram | "", teamNumber: string): string | null {
  if (!program) return null;
  const number = parseTeamNumber(teamNumber, program);
  return number.ok ? number.value : null;
}

/** The query for the saved-team-name lookup. */
export function teamLookupQuery(program: VisitProgram, number: string): string {
  return new URLSearchParams({ program, number }).toString();
}

// Visit changes (the manage page and staff edits).

/** The editable visit fields as typed. `date` is the local date; `windowId` is set where the form picks a window. */
export type VisitDraft = {
  readonly date: string;
  readonly arrival: string;
  readonly departure: string;
  readonly headcount: string;
  readonly note: string;
  readonly contactName: string;
  readonly contactPhone: string;
};

export function visitDraft(booking: Pick<ManageView["booking"], "date" | "arrival" | "departure" | "headcount" | "note" | "contactName" | "contactPhone">): VisitDraft {
  return {
    date: booking.date, arrival: booking.arrival, departure: booking.departure, headcount: String(booking.headcount), note: booking.note,
    contactName: booking.contactName, contactPhone: booking.contactPhone,
  };
}

export const visitFieldOrder = ["date", "arrival", "departure", "headcount", "contactName", "contactPhone", "note"] as const;

/** Every problem in a visit change, by request field. */
export function validateVisitDraft(draft: VisitDraft): FieldErrors {
  return collect([
    ["date", /^\d{4}-\d{2}-\d{2}$/.test(draft.date) ? { ok: true } : { ok: false, error: "Choose the visit date" }],
    ["arrival", isLocalTime(draft.arrival) ? { ok: true } : { ok: false, error: "Choose the arrival time" }],
    ["departure", timesInOrder(draft.arrival, draft.departure)],
    ["headcount", parseHeadcount(draft.headcount)],
    ["contactName", requiredText(draft.contactName, "contact name", maximumContactNameLength)],
    ["contactPhone", parsePhone(draft.contactPhone)],
    ["note", parseNote(draft.note)],
  ]);
}

type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };

/**
 * The manage-page edit for a draft: only what changed, with the date, arrival and departure always together, as the
 * Worker requires. Null when nothing changed.
 */
export function visitEdit(booking: Pick<ManageView["booking"], "revision" | "date" | "arrival" | "departure" | "headcount" | "note" | "contactName" | "contactPhone">, draft: VisitDraft): ManageEditRequest | null {
  const edit: Mutable<ManageEditRequest> = { revision: booking.revision };
  if (draft.date !== booking.date || draft.arrival !== booking.arrival || draft.departure !== booking.departure) Object.assign(edit, { date: draft.date, arrival: draft.arrival, departure: draft.departure });
  const headcount = Number(draft.headcount.trim());
  if (headcount !== booking.headcount) edit.headcount = headcount;
  if (draft.note.trim() !== booking.note.trim()) edit.note = draft.note.trim();
  if (singleLine(draft.contactName) !== booking.contactName) edit.contactName = singleLine(draft.contactName);
  if (singleLine(draft.contactPhone) !== booking.contactPhone) edit.contactPhone = singleLine(draft.contactPhone);
  return Object.keys(edit).length > 1 ? edit : null;
}

/** A staff edit also corrects the email address and moves the visit to another guest team. */
export type StaffVisitDraft = VisitDraft & { readonly contactEmail: string; readonly teamId: string };

export function staffVisitDraft(booking: StaffBooking): StaffVisitDraft {
  return { ...visitDraft(booking), contactEmail: booking.contactEmail, teamId: booking.team.id };
}

export function validateStaffVisitDraft(draft: StaffVisitDraft): FieldErrors {
  return { ...validateVisitDraft(draft), ...collect([["contactEmail", parseEmail(draft.contactEmail)], ["teamId", draft.teamId ? { ok: true } : { ok: false, error: "Choose the guest team" }]]) };
}

/** The staff edit for a draft, or null when nothing changed. The email address is sent only when it changed, since a change revokes earlier links. */
export function staffVisitEdit(booking: StaffBooking, draft: StaffVisitDraft): StaffBookingEdit | null {
  const base = visitEdit(booking, draft) ?? { revision: booking.revision };
  const edit: Mutable<StaffBookingEdit> = { ...base };
  if (draft.contactEmail.trim() !== booking.contactEmail) edit.contactEmail = draft.contactEmail.trim();
  if (draft.teamId !== booking.team.id) edit.teamId = draft.teamId;
  return Object.keys(edit).length > 1 ? edit : null;
}

// Availability.

/** The availability form as typed. `repeating` chooses between a series and one dated window. */
export type AvailabilityDraft = {
  readonly repeating: boolean;
  readonly weekdays: readonly number[];
  readonly date: string;
  readonly firstDate: string;
  readonly lastDate: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly title: string;
};

/** A new availability draft: weekly from today for eight weeks, 6 to 9 PM. */
export function availabilityDraft(today: string): AvailabilityDraft {
  return { repeating: true, weekdays: [], date: today, firstDate: today, lastDate: addDays(today, 7 * 8 - 1), startTime: "18:00", endTime: "21:00", title: "" };
}

/** The series or window request for a draft, or the first problem with its field, checked by the Worker's own rules. */
export function availabilityRequest(draft: AvailabilityDraft): { readonly ok: true; readonly kind: "series"; readonly value: SeriesRequest } | { readonly ok: true; readonly kind: "window"; readonly value: WindowRequest } | { readonly ok: false; readonly field: string; readonly error: string } {
  const title = singleLine(draft.title);
  if (draft.repeating) {
    const value: SeriesRequest = { weekdays: [...draft.weekdays].sort((left, right) => left - right), startTime: draft.startTime, endTime: draft.endTime, firstDate: draft.firstDate, lastDate: draft.lastDate, ...(title ? { title } : {}) };
    const checked = parseSeriesInput(value);
    return checked.ok ? { ok: true, kind: "series", value } : { ok: false, field: checked.field, error: checked.error };
  }
  const value: WindowRequest = { date: draft.date, startTime: draft.startTime, endTime: draft.endTime, ...(title ? { title } : {}) };
  const checked = parseWindowInput(value);
  return checked.ok ? { ok: true, kind: "window", value } : { ok: false, field: checked.field, error: checked.error };
}

/** A cancellation reason, or the problem with it. */
export function cancelReason(value: string): { readonly ok: true; readonly reason: string } | { readonly ok: false; readonly error: string } {
  const checked = parseCancelReason(value);
  return checked.ok ? { ok: true, reason: checked.value } : { ok: false, error: checked.error };
}

// Settings.

/** A Discord channel ID: a snowflake of 17 to 20 digits. */
export const discordChannelPattern = /^\d{17,20}$/;

/** The guest page link staff share: the dashboard origin and the guest page path. */
export function guestPageLink(origin: string, path = "/visit"): string {
  return `${origin.replace(/\/+$/, "")}${path}`;
}

type SettingsField = keyof Omit<VisitsSettings, "revision" | "testEmailSentMs">;

/** The settings update for the given fields: only those that changed, with the revision. Null when nothing changed. */
export function settingsUpdate(saved: VisitsSettings, draft: Pick<VisitsSettings, SettingsField>, fields: readonly SettingsField[]): VisitsSettingsUpdate | null {
  const update: Record<string, unknown> = { revision: saved.revision };
  for (const field of fields) if (draft[field] !== saved[field]) update[field] = draft[field];
  return Object.keys(update).length > 1 ? update as VisitsSettingsUpdate : null;
}

/** The team a lookup found, when its name should fill the form: the name is empty or was filled by an earlier lookup. */
export function lookupFill(found: TeamIdentity | null, currentName: string, filledName: string | null): string | null {
  if (found) return !currentName.trim() || currentName === filledName ? found.name : null;
  return filledName !== null && currentName === filledName ? "" : null;
}
