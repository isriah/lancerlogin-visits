// Form state for the Guest Visits pages: drafts held as text, checked with the same src/shared rules the Worker applies,
// and turned into contract requests that carry only what changed. Also reads the API's `{ error, field }` failures and
// keeps one submission key per booking attempt. Each form's rules also check one field at a time, for the live checks
// (useLiveChecks in visits-live-checks.ts, whose state changes are here). Plain functions, so `npm test` covers them
// without React.
import {
  headcountRequiredProblem, maximumContactNameLength, maximumTeamNameLength, parseEmail, parseHeadcount, parseNote, parsePhone, parseProgram, parseTeamNumber,
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

type Check = { readonly ok: true } | { readonly ok: false; readonly error: string };
/** A form's rules by request field. Validating runs them all; a live check runs one. */
type Rules<Args extends readonly unknown[]> = Readonly<Record<string, (...args: Args) => Check>>;
const passed: Check = { ok: true };
const failed = (error: string): Check => ({ ok: false, error });

const collect = (entries: readonly (readonly [string, Check])[]): FieldErrors =>
  Object.fromEntries(entries.filter(([, result]) => !result.ok).map(([field, result]) => [field, (result as { error: string }).error]));
const validateWith = <Args extends readonly unknown[]>(rules: Rules<Args>, ...args: Args): FieldErrors => collect(Object.entries(rules).map(([field, rule]) => [field, rule(...args)] as const));
/** One field's problem, or undefined, also for a field the rules do not know. */
const checkWith = <Args extends readonly unknown[]>(rules: Rules<Args>, field: string, ...args: Args): string | undefined => {
  const result = Object.hasOwn(rules, field) ? rules[field](...args) : passed;
  return result.ok ? undefined : result.error;
};

const requiredText = (value: string, label: string, maximum: number): Check => {
  const text = singleLine(value);
  if (!text) return failed(`Enter the ${label}`);
  return text.length > maximum ? failed(`The ${label} is at most ${maximum} characters`) : passed;
};

const arrivalTime = (arrival: string): Check => isLocalTime(arrival) ? passed : failed("Choose the arrival time");

/** A headcount as typed: empty is fine unless an Admin requires one; anything typed must be 1 to 100 people. */
const headcountCheck = (value: string, required = false): Check => value.trim() ? parseHeadcount(value) : required ? failed(headcountRequiredProblem.error) : passed;

/** A typed headcount for a request: the number, or null when the field is empty. */
const headcountValue = (value: string): number | null => value.trim() ? Number(value.trim()) : null;

const timesInOrder = (arrival: string, departure: string): Check => {
  if (!isLocalTime(departure)) return failed("Choose the departure time");
  return isLocalTime(arrival) && minutesOfDay(departure) <= minutesOfDay(arrival) ? failed("The departure must be after the arrival") : passed;
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

/** Request fields in form order, for focusing the first problem. The guest page asks for the time first; its time slot radio answers for `date`. */
export const bookingFieldOrder = ["date", "arrival", "departure", "program", "teamNumber", "teamName", "contactName", "contactEmail", "contactPhone", "headcount", "note"] as const;

/**
 * The booking rules: the Worker's own, with a short message for a program left unchosen. The headcount is optional unless
 * the guest page says an Admin requires it.
 */
const bookingRules: Rules<[BookingDraft, string | undefined, boolean?]> = {
  program: (draft) => draft.program ? parseProgram(draft.program) : failed("Choose the program"),
  // Until a program is chosen the number is only required: Other allows letters, the rest digits only.
  teamNumber: (draft) => {
    const program = parseProgram(draft.program);
    return program.ok ? parseTeamNumber(draft.teamNumber, program.value) : draft.teamNumber.trim() ? passed : failed("Enter the team number");
  },
  teamName: (draft) => requiredText(draft.teamName, "team name", maximumTeamNameLength),
  contactName: (draft) => requiredText(draft.contactName, "contact name", maximumContactNameLength),
  contactEmail: (draft) => parseEmail(draft.contactEmail),
  contactPhone: (draft) => parsePhone(draft.contactPhone),
  date: (_draft, windowDate) => windowDate ? passed : failed("Choose when to visit"),
  arrival: (draft) => arrivalTime(draft.arrival),
  departure: (draft) => timesInOrder(draft.arrival, draft.departure),
  headcount: (draft, _windowDate, headcountRequired) => headcountCheck(draft.headcount, headcountRequired),
  note: (draft) => parseNote(draft.note),
};

/** Every problem in the booking form, by request field, using the Worker's own rules. */
export function validateBookingDraft(draft: BookingDraft, windowDate: string | undefined, headcountRequired = false): FieldErrors {
  return validateWith(bookingRules, draft, windowDate, headcountRequired);
}

/** One booking field's problem by the same rules, or undefined: `checkBookingField("contactEmail", draft)`. */
export function checkBookingField(field: string, draft: BookingDraft, windowDate?: string, headcountRequired = false): string | undefined {
  return checkWith(bookingRules, field, draft, windowDate, headcountRequired);
}

/** The booking form's `date` problem belongs to its time slot choice, `windowId`. For `useLiveChecks`. */
export const bookingFieldSources: FieldSources = { date: "windowId" };

/** The booking request without its submission key. Optional fields are left out when empty. */
export function bookingRequest(draft: BookingDraft, windowDate: string): Omit<PublicBookingRequest, "submissionKey"> {
  const program = parseProgram(draft.program);
  const number = program.ok ? parseTeamNumber(draft.teamNumber, program.value) : null;
  const phone = singleLine(draft.contactPhone);
  const note = draft.note.trim();
  const headcount = headcountValue(draft.headcount);
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
    ...(headcount === null ? {} : { headcount }),
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
    date: booking.date, arrival: booking.arrival, departure: booking.departure, headcount: booking.headcount === null ? "" : String(booking.headcount), note: booking.note,
    contactName: booking.contactName, contactPhone: booking.contactPhone,
  };
}

export const visitFieldOrder = ["date", "arrival", "departure", "headcount", "contactName", "contactPhone", "note"] as const;

/** Visit changes. A guest cannot clear the headcount while an Admin requires one; staff always can. */
const visitRules: Rules<[VisitDraft, boolean?]> = {
  date: (draft) => /^\d{4}-\d{2}-\d{2}$/.test(draft.date) ? passed : failed("Choose the visit date"),
  arrival: (draft) => arrivalTime(draft.arrival),
  departure: (draft) => timesInOrder(draft.arrival, draft.departure),
  headcount: (draft, headcountRequired) => headcountCheck(draft.headcount, headcountRequired),
  contactName: (draft) => requiredText(draft.contactName, "contact name", maximumContactNameLength),
  contactPhone: (draft) => parsePhone(draft.contactPhone),
  note: (draft) => parseNote(draft.note),
};

/** Every problem in a visit change, by request field. */
export function validateVisitDraft(draft: VisitDraft, headcountRequired = false): FieldErrors {
  return validateWith(visitRules, draft, headcountRequired);
}

/** One visit field's problem by the same rules, or undefined. */
export function checkVisitField(field: string, draft: VisitDraft, headcountRequired = false): string | undefined {
  return checkWith(visitRules, field, draft, headcountRequired);
}

type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };

/**
 * The manage-page edit for a draft: only what changed, with the date, arrival and departure always together, as the
 * Worker requires. Null when nothing changed.
 */
export function visitEdit(booking: Pick<ManageView["booking"], "revision" | "date" | "arrival" | "departure" | "headcount" | "note" | "contactName" | "contactPhone">, draft: VisitDraft): ManageEditRequest | null {
  const edit: Mutable<ManageEditRequest> = { revision: booking.revision };
  if (draft.date !== booking.date || draft.arrival !== booking.arrival || draft.departure !== booking.departure) Object.assign(edit, { date: draft.date, arrival: draft.arrival, departure: draft.departure });
  const headcount = headcountValue(draft.headcount);
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

const staffVisitRules: Rules<[StaffVisitDraft]> = {
  ...visitRules,
  contactEmail: (draft) => parseEmail(draft.contactEmail),
  teamId: (draft) => draft.teamId ? passed : failed("Choose the guest team"),
};

export function validateStaffVisitDraft(draft: StaffVisitDraft): FieldErrors {
  return validateWith(staffVisitRules, draft);
}

export function checkStaffVisitField(field: string, draft: StaffVisitDraft): string | undefined {
  return checkWith(staffVisitRules, field, draft);
}

/** The staff edit for a draft, or null when nothing changed. The email address is sent only when it changed, since a change revokes earlier links. */
export function staffVisitEdit(booking: StaffBooking, draft: StaffVisitDraft): StaffBookingEdit | null {
  const base = visitEdit(booking, draft) ?? { revision: booking.revision };
  const edit: Mutable<StaffBookingEdit> = { ...base };
  if (draft.contactEmail.trim() !== booking.contactEmail) edit.contactEmail = draft.contactEmail.trim();
  if (draft.teamId !== booking.team.id) edit.teamId = draft.teamId;
  return Object.keys(edit).length > 1 ? edit : null;
}

// Live checks: a field is checked when the person leaves it, and a field showing a problem is checked again as its value
// changes. useLiveChecks (visits-live-checks.ts) keeps this state; these are its changes.

/** A field's problem in a draft, or undefined: `checkVisitField`, or `checkBookingField` with the chosen window's date. */
export type FieldCheck<Draft> = (field: string, draft: Draft) => string | undefined;

/** Fields whose value is held under another draft key, such as the booking form's `date` under `windowId`. */
export type FieldSources = Readonly<Record<string, string>>;

/** The draft last seen, the errors shown and the fields checked so far (left once, or shown an error). */
export type LiveCheckState<Draft> = { readonly draft: Draft; readonly errors: FieldErrors; readonly checked: ReadonlySet<string> };

export function liveCheckState<Draft>(draft: Draft): LiveCheckState<Draft> {
  return { draft, errors: {}, checked: new Set() };
}

const withChecked = (checked: ReadonlySet<string>, fields: readonly string[]): ReadonlySet<string> =>
  fields.every((field) => checked.has(field)) ? checked : new Set([...checked, ...fields]);

/** Show these errors in place of the others, as a submit or a refused request does. Their fields count as checked. */
export function liveShow<Draft>(state: LiveCheckState<Draft>, errors: FieldErrors): LiveCheckState<Draft> {
  return { ...state, errors, checked: withChecked(state.checked, Object.keys(errors)) };
}

/** A field was left: show its problem. A field that passes keeps an error it shows, so a Worker refusal stays until the value changes. */
export function liveBlur<Draft>(state: LiveCheckState<Draft>, field: string, check: FieldCheck<Draft>): LiveCheckState<Draft> {
  const error = check(field, state.draft);
  const checked = withChecked(state.checked, [field]);
  if (error && error !== state.errors[field]) return { ...state, checked, errors: { ...state.errors, [field]: error } };
  return checked === state.checked ? state : { ...state, checked };
}

/**
 * The draft changed. A field whose own value changed is checked again only while it shows an error, so typing never adds
 * one and a corrected value loses it at once. A checked field whose value stayed is checked again when its result changed
 * with another field, as the departure does when the arrival moves, or the team number when the program does.
 */
export function liveChange<Draft extends object>(state: LiveCheckState<Draft>, next: Draft, check: FieldCheck<Draft>, sources: FieldSources = {}): LiveCheckState<Draft> {
  const valueOf = (draft: Draft, field: string) => (draft as Record<string, unknown>)[sources[field] ?? field];
  let errors: Record<string, string> | undefined;
  for (const field of state.checked) {
    const typed = !Object.is(valueOf(state.draft, field), valueOf(next, field));
    if (typed ? !state.errors[field] : check(field, state.draft) === check(field, next)) continue;
    const error = check(field, next);
    if (error === state.errors[field]) continue;
    errors ??= { ...state.errors };
    if (error) errors[field] = error; else delete errors[field];
  }
  return { ...state, draft: next, errors: errors ?? state.errors };
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
