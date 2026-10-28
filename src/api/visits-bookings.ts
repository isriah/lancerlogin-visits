// Visits: the guest page and booking, the manage page reached from the emailed link, staff changes to visits, guest
// teams and Record in Outreach. Every change writes the booking, a change-history row and its notifications (including
// its Outreach record, when an Admin's grant allows it) in one batch, guarded by the booking's revision, and then tries
// to send its email and Discord messages at once. Only the job and Record in Outreach call Outreach.
import type { D1Database, D1Statement } from "@lancerlogin/module-sdk/api";
import type { ManageView, OutreachRecordResult, PublicBookingResult, PublicCalendar, PublicTeamLookup, StaffBookingDetail, StaffTeam } from "../shared/visits-api.ts";
import {
  applyGuestCancel, applyGuestEdit, bookingFingerprintText, bookingRevisionRow, checkGuestVisit, diffBooking, findFittingWindow, guestHorizonDays,
  handledAttention, maximumTeamNameLength, nextAttention, noAttention, outreachProgram, parseBookingInput, parseBookingSnapshot, parseEmail, parseGuestEdit,
  parseProgram, parseTeamNumber, publicWindows, resolveVisitTimes, submissionOutcome, windowAttentionReason,
  type Attention, type BookableWindow, type BookingDetails, type FieldChange, type RevisionAction, type RevisionActor, type TeamIdentity, type VisitProgram,
} from "../shared/visits-booking.ts";
import { normalizeEmailAddress } from "../shared/visits-limits.ts";
import { maximumOutreachRecordBatch } from "../shared/visits-outreach.ts";
import { checkManageToken, hashManageToken, isManageToken, manageTokenRefusedMessage, sha256Hex } from "../shared/visits-tokens.ts";
import { dayMs, singleLine } from "../shared/visits-time.ts";
import { deliverNow, queueNotificationStatement, recordOutreachNow } from "./visits-delivery.ts";
import { outreachAccess, outreachChange, queueOutreachStatement } from "./visits-outreach.ts";
import { staffBookingDetail } from "./visits-queries.ts";
import { readSettings } from "./visits-settings.ts";
import {
  attentionOf, bookingColumns, bookingDetailsOf, guardFailed, guardStatement, installationId, iso, localTimes, objectBody, ok, onlyFields,
  refuse, revisionOf, rows, stale, storedWindow, teamIdentity, VisitsError, windowColumns,
  type BookingRow, type RouteResult, type TeamRow, type VisitsDeps, type WindowRow,
} from "./visits-runtime.ts";

const longestWindowMs = 90_000_000;

async function bookingRow(db: D1Database, id: string): Promise<BookingRow | null> {
  return db.prepare(`SELECT ${bookingColumns} FROM visits_bookings b WHERE b.installation_id=? AND b.id=?`).bind(installationId, id).first<BookingRow>();
}

async function requireBooking(db: D1Database, id: string): Promise<BookingRow> {
  const booking = await bookingRow(db, id);
  if (!booking) throw new VisitsError(404, "This visit was not found.");
  return booking;
}

/** The windows (not removed) that contain a visit's times. Windows never overlap, so there is at most one. */
async function windowsContaining(db: D1Database, visit: { readonly arrivalMs: number; readonly departureMs: number }): Promise<BookableWindow[]> {
  const result = await rows<WindowRow>(db.prepare(`SELECT ${windowColumns} FROM visits_windows WHERE installation_id=? AND status!='removed' AND start_ms<=? AND start_ms>? AND end_ms>=?`)
    .bind(installationId, visit.arrivalMs, visit.arrivalMs - longestWindowMs, visit.departureMs));
  return result.map(storedWindow);
}

async function windowById(db: D1Database, id: string): Promise<BookableWindow | null> {
  const row = await db.prepare(`SELECT ${windowColumns} FROM visits_windows WHERE installation_id=? AND id=?`).bind(installationId, id).first<WindowRow>();
  return row ? storedWindow(row) : null;
}

/** The booking after a change, as JSON built from the row itself, for history rows written in SQL. */
const snapshotSql = (teamId = "team_id") => `json_object('windowId',window_id,'teamId',${teamId},'contactName',contact_name,'contactEmail',contact_email,'contactPhone',contact_phone,'arrivalMs',arrival_ms,'departureMs',departure_ms,'headcount',headcount,'note',note,'status',status)`;

/** Whether Discord messages are on and the Discord connection is ready. */
async function discordOn(db: D1Database, deps: VisitsDeps, now: number): Promise<boolean> {
  const settings = await readSettings(db, now);
  if (settings.discord_enabled !== 1 || !settings.discord_channel_id) return false;
  return deps.discord.ready().catch(() => false);
}

type MessageKind = "booked" | "changed" | "canceled";

/** Queue a booking's email and, when Discord messages are on, its Discord message. */
async function notificationStatements(db: D1Database, deps: VisitsDeps, input: { bookingId: string; email: MessageKind | "resend" | null; discord: MessageKind | null; origin: string | undefined; changes?: readonly FieldChange[]; now: number }) {
  const statements: D1Statement[] = [];
  const ids: string[] = [];
  const payload = { ...(input.origin ? { origin: input.origin } : {}), ...(input.changes?.length ? { changes: input.changes } : {}) };
  if (input.email) {
    const id = crypto.randomUUID();
    ids.push(id);
    statements.push(queueNotificationStatement(db, { id, channel: "email", kind: input.email, bookingId: input.bookingId, payload, now: input.now }));
  }
  if (input.discord && await discordOn(db, deps, input.now)) {
    const id = crypto.randomUUID();
    ids.push(id);
    statements.push(queueNotificationStatement(db, { id, channel: "discord", kind: input.discord, bookingId: input.bookingId, payload: input.changes?.length ? { changes: input.changes } : {}, now: input.now }));
  }
  return { statements, ids };
}

// The guest page.

const publicVisitsFor = `SELECT b.window_id AS windowId,b.team_id AS teamId,b.arrival_ms AS arrivalMs,b.departure_ms AS departureMs,b.headcount,b.status,t.number,t.name,t.program
  FROM visits_bookings b JOIN visits_teams t ON t.installation_id=b.installation_id AND t.id=b.team_id
  WHERE b.installation_id=? AND b.status='booked' AND b.window_id IN (SELECT value FROM json_each(?))`;

/** Windows guests may see from now to the horizon, with the teams coming. Never contact details or notes. */
async function guestWindows(db: D1Database, now: number) {
  const windows = (await rows<WindowRow>(db.prepare(`SELECT ${windowColumns} FROM visits_windows WHERE installation_id=? AND status!='removed' AND end_ms>? AND start_ms<? ORDER BY start_ms`)
    .bind(installationId, now, now + guestHorizonDays * dayMs))).map(storedWindow);
  const visits = await rows<{ windowId: string; teamId: string; arrivalMs: number; departureMs: number; headcount: number; status: "booked"; number: string; name: string; program: TeamIdentity["program"] }>(
    db.prepare(publicVisitsFor).bind(installationId, JSON.stringify(windows.map((window) => window.id))));
  const teams = new Map(visits.map((visit) => [visit.teamId, teamIdentity(visit)]));
  return publicWindows({ windows, bookings: visits, teams, now });
}

export async function publicCalendar(db: D1Database, deps: VisitsDeps): Promise<PublicCalendar> {
  const now = deps.now();
  const [timeZone, settings, windows] = await Promise.all([deps.timeZone(), readSettings(db, now), guestWindows(db, now)]);
  return { timeZone, hostName: settings.host_name, introText: settings.intro_text, horizonDays: guestHorizonDays, windows };
}

/** The saved team for a program and number, so the form can fill in its name. */
export async function lookupTeam(db: D1Database, url: URL): Promise<PublicTeamLookup> {
  const program = parseProgram(url.searchParams.get("program"));
  if (!program.ok) refuse(program);
  const number = parseTeamNumber(url.searchParams.get("number") ?? "", program.value, "number");
  if (!number.ok) refuse(number);
  const team = await db.prepare("SELECT number,name,program FROM visits_teams WHERE installation_id=? AND program=? AND number=? AND archived=0").bind(installationId, program.value, number.value).first<TeamIdentity>();
  return { team: team ? teamIdentity(team) : null };
}

async function bookingResult(db: D1Database, deps: VisitsDeps, bookingId: string): Promise<PublicBookingResult> {
  const row = await db.prepare("SELECT b.contact_email,b.arrival_ms,b.departure_ms,w.title FROM visits_bookings b JOIN visits_windows w ON w.installation_id=b.installation_id AND w.id=b.window_id WHERE b.installation_id=? AND b.id=?")
    .bind(installationId, bookingId).first<{ contact_email: string; arrival_ms: number; departure_ms: number; title: string }>();
  if (!row) throw new VisitsError(409, "This booking could not be confirmed. Reload the page and check the list of visits.");
  return { booked: true, emailTo: row.contact_email, visit: { ...localTimes(deps.civil, await deps.timeZone(), row.arrival_ms, row.departure_ms), windowTitle: row.title } };
}

async function submissionKey(db: D1Database, keyHash: string) {
  return db.prepare("SELECT fingerprint,booking_id AS bookingId FROM visits_public_submission_keys WHERE installation_id=? AND key_hash=?").bind(installationId, keyHash).first<{ fingerprint: string; bookingId: string }>();
}

const keyReused = () => new VisitsError(409, "This form was already sent with other details. Reload the page and book again.", "submissionKey");

/**
 * Book a visit from the guest page. The same submission key never books twice: a repeat returns the first result. The team
 * is found by program and number (a known team keeps its saved name) or created, and the booking, its history row, the
 * submission key and its notifications are written in one batch, which applies only while the window is still open.
 */
export async function bookVisit(db: D1Database, deps: VisitsDeps, value: unknown, origin: string | undefined): Promise<RouteResult> {
  const parsed = parseBookingInput(value);
  if (!parsed.ok) refuse(parsed);
  const input = parsed.value;
  const [keyHash, fingerprint] = await Promise.all([sha256Hex(input.submissionKey), sha256Hex(bookingFingerprintText(input))]);
  const outcome = submissionOutcome(await submissionKey(db, keyHash), fingerprint);
  if (outcome.kind === "replay") return ok(await bookingResult(db, deps, outcome.bookingId));
  if (outcome.kind === "conflict") throw keyReused();
  const now = deps.now();
  const timeZone = await deps.timeZone();
  const times = resolveVisitTimes(deps.civil, timeZone, input.date, input.arrival, input.departure);
  if (!times.ok) refuse(times);
  const window = checkGuestVisit(await windowsContaining(db, times.value), times.value, now);
  if (!window.ok) refuse(window);
  const bookingId = crypto.randomUUID();
  const at = iso(now);
  const notifications = await notificationStatements(db, deps, { bookingId, email: "booked", discord: "booked", origin, now });
  // A guest request has no signed-in user, so Outreach is reachable only through an Admin's grant.
  const outreach = outreachProgram(input.team.program) !== null && (await outreachAccess(db, deps, now)).granted;
  const team = "(SELECT id FROM visits_teams WHERE installation_id=? AND program=? AND number=? AND archived=0)";
  try {
    await db.batch([
      guardStatement(db, "visits_window_changed", "EXISTS(SELECT 1 FROM visits_windows WHERE installation_id=? AND id=? AND status='open' AND start_ms<=? AND end_ms>=?)", installationId, window.value.id, times.value.arrivalMs, times.value.departureMs),
      db.prepare("INSERT INTO visits_teams(installation_id,id,number,name,program,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(installation_id,program,number) WHERE archived=0 DO NOTHING")
        .bind(installationId, crypto.randomUUID(), input.team.number, input.team.name, input.team.program, at, at),
      db.prepare(`INSERT INTO visits_bookings(installation_id,id,window_id,team_id,contact_name,contact_email,contact_phone,arrival_ms,departure_ms,headcount,note,created_at,updated_at)
        VALUES(?,?,?,${team},?,?,?,?,?,?,?,?,?)`).bind(installationId, bookingId, window.value.id, installationId, input.team.program, input.team.number,
        input.contact.name, input.contact.email, input.contact.phone, times.value.arrivalMs, times.value.departureMs, input.headcount, input.note, at, at),
      db.prepare(`INSERT INTO visits_booking_revisions(installation_id,booking_id,revision,action,actor_kind,change_json,snapshot_json,created_at)
        SELECT installation_id,id,0,'created','guest','[]',${snapshotSql()},? FROM visits_bookings WHERE installation_id=? AND id=?`).bind(at, installationId, bookingId),
      db.prepare("INSERT INTO visits_public_submission_keys(installation_id,key_hash,fingerprint,booking_id,created_ms) VALUES(?,?,?,?,?)").bind(installationId, keyHash, fingerprint, bookingId, now),
      ...notifications.statements,
      ...(outreach ? [queueOutreachStatement(db, bookingId, now)] : []),
    ]);
  } catch (error) {
    if (guardFailed(error, "visits_window_changed")) throw new VisitsError(409, "That time is no longer open. Choose another time.", "arrival");
    // Another request with the same key won the race.
    const raced = submissionOutcome(await submissionKey(db, keyHash), fingerprint);
    if (raced.kind === "replay") return ok(await bookingResult(db, deps, raced.bookingId));
    if (raced.kind === "conflict") throw keyReused();
    throw error;
  }
  await deliverNow(db, deps, notifications.ids);
  return ok(await bookingResult(db, deps, bookingId), 201);
}

// Changing a booking.

type BookingChange = {
  readonly current: BookingRow;
  readonly next: BookingDetails;
  readonly removed?: boolean;
  readonly action: RevisionAction;
  readonly actor: RevisionActor;
  readonly changes: readonly FieldChange[];
  readonly attention: Attention;
  readonly email: MessageKind | null;
  readonly discord: MessageKind | null;
  readonly origin: string | undefined;
  /** The window the change moves the visit into, which must still be open and contain it when the batch applies. */
  readonly checkWindow?: boolean;
};

/**
 * Write a booking change, its history row and notifications in one batch guarded by the revision, then try to send. The
 * change's Outreach consequences (a new record, forgetting a stored activity, attention) apply in the same batch.
 */
async function applyBookingChange(db: D1Database, deps: VisitsDeps, change: BookingChange): Promise<void> {
  const { current, next } = change;
  const now = deps.now();
  const at = iso(now);
  const revision = current.revision + 1;
  const emailChanged = normalizeEmailAddress(current.contact_email) !== normalizeEmailAddress(next.contactEmail);
  const notifications = await notificationStatements(db, deps, { bookingId: current.id, email: change.email, discord: change.discord, origin: change.origin, changes: change.changes, now });
  const outreach = await outreachChange(db, deps, { current, next, removed: Boolean(change.removed), attention: change.attention, now });
  const history = bookingRevisionRow({ bookingId: current.id, revision, action: change.action, actor: change.actor, changes: change.changes, snapshot: next, at });
  const statements: D1Statement[] = [
    guardStatement(db, "visits_stale_booking", "EXISTS(SELECT 1 FROM visits_bookings WHERE installation_id=? AND id=? AND revision=?)", installationId, current.id, current.revision),
    ...(change.checkWindow ? [guardStatement(db, "visits_window_changed", "EXISTS(SELECT 1 FROM visits_windows WHERE installation_id=? AND id=? AND status='open' AND start_ms<=? AND end_ms>=?)", installationId, next.windowId, next.arrivalMs, next.departureMs)] : []),
    db.prepare(`UPDATE visits_bookings SET window_id=?,team_id=?,contact_name=?,contact_email=?,contact_phone=?,arrival_ms=?,departure_ms=?,headcount=?,note=?,status=?,removed=?,
      attention=?,attention_reason=?,outreach_activity_id=CASE WHEN ? THEN NULL ELSE outreach_activity_id END,revision=?,updated_at=? WHERE installation_id=? AND id=? AND revision=?`)
      .bind(next.windowId, next.teamId, next.contactName, next.contactEmail, next.contactPhone, next.arrivalMs, next.departureMs, next.headcount, next.note, next.status,
        change.removed ? 1 : 0, outreach.attention.state, outreach.attention.reason, outreach.clearActivity ? 1 : 0, revision, at, installationId, current.id, current.revision),
    db.prepare("INSERT INTO visits_booking_revisions(installation_id,booking_id,revision,action,actor_kind,staff_user_id,change_json,snapshot_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .bind(installationId, history.booking_id, history.revision, history.action, history.actor_kind, history.staff_user_id, history.change_json, history.snapshot_json, history.created_at),
    // Every link works until the visit ends, wherever it moves; correcting the address revokes every earlier link.
    ...(next.departureMs !== current.departure_ms ? [db.prepare("UPDATE visits_manage_tokens SET expires_ms=? WHERE installation_id=? AND booking_id=? AND revoked_ms IS NULL").bind(next.departureMs, installationId, current.id)] : []),
    ...(emailChanged ? [db.prepare("UPDATE visits_manage_tokens SET revoked_ms=? WHERE installation_id=? AND booking_id=? AND revoked_ms IS NULL").bind(now, installationId, current.id)] : []),
    ...notifications.statements,
    ...(outreach.queue ? [queueOutreachStatement(db, current.id, now)] : []),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    if (guardFailed(error, "visits_stale_booking") || guardFailed(error, "visits_booking_revision")) throw stale();
    if (guardFailed(error, "visits_window_changed")) throw new VisitsError(409, "That time is no longer open. Choose another time.", "arrival");
    throw error;
  }
  await deliverNow(db, deps, notifications.ids);
}

/** The attention a visit needs after its times or status changed. */
async function attentionAfter(db: D1Database, current: BookingRow, next: BookingDetails): Promise<Attention> {
  const moved = next.windowId !== current.window_id || next.arrivalMs !== current.arrival_ms || next.departureMs !== current.departure_ms;
  if (!moved && next.status === current.status) return attentionOf(current);
  return nextAttention(attentionOf(current), windowAttentionReason(next, await windowById(db, next.windowId)));
}

// The manage page.

/** The booking an emailed link manages. Every refusal gives the same message. */
async function managedBooking(db: D1Database, deps: VisitsDeps, token: unknown): Promise<BookingRow> {
  const refused = () => new VisitsError(403, manageTokenRefusedMessage, "token");
  if (!isManageToken(token)) throw refused();
  const record = await db.prepare("SELECT booking_id,issued_ms,expires_ms,revoked_ms FROM visits_manage_tokens WHERE installation_id=? AND token_hash=?").bind(installationId, await hashManageToken(token))
    .first<{ booking_id: string; issued_ms: number; expires_ms: number; revoked_ms: number | null }>();
  const booking = record ? await bookingRow(db, record.booking_id) : null;
  if (!record || !booking || booking.removed === 1) throw refused();
  const check = checkManageToken({ bookingId: record.booking_id, issuedMs: record.issued_ms, expiresMs: record.expires_ms, revokedMs: record.revoked_ms }, { id: booking.id, departureMs: booking.departure_ms }, deps.now());
  if (!check.ok) throw refused();
  return booking;
}

async function manageView(db: D1Database, deps: VisitsDeps, bookingId: string): Promise<ManageView> {
  const now = deps.now();
  const row = await db.prepare(`SELECT ${bookingColumns},t.number,t.name,t.program,w.title AS window_title FROM visits_bookings b JOIN visits_teams t ON t.installation_id=b.installation_id AND t.id=b.team_id
    JOIN visits_windows w ON w.installation_id=b.installation_id AND w.id=b.window_id WHERE b.installation_id=? AND b.id=?`).bind(installationId, bookingId)
    .first<BookingRow & { number: string; name: string; program: TeamIdentity["program"]; window_title: string }>();
  if (!row) throw new VisitsError(403, manageTokenRefusedMessage, "token");
  const [timeZone, settings, windows] = await Promise.all([deps.timeZone(), readSettings(db, now), guestWindows(db, now)]);
  return {
    timeZone, hostName: settings.host_name, horizonDays: guestHorizonDays,
    booking: {
      ...localTimes(deps.civil, timeZone, row.arrival_ms, row.departure_ms),
      id: row.id, revision: row.revision, status: row.status, team: teamIdentity(row), windowTitle: row.window_title, headcount: row.headcount, note: row.note,
      contactName: row.contact_name, contactPhone: row.contact_phone, contactEmail: row.contact_email,
    },
    windows: windows.filter((window) => window.status === "open"),
  };
}

/** Show the booking an emailed link manages. Opening it changes nothing. */
export async function manageShow(db: D1Database, deps: VisitsDeps, value: unknown): Promise<RouteResult> {
  const input = objectBody(value);
  onlyFields(input, ["token"]);
  const booking = await managedBooking(db, deps, input.token);
  return ok(await manageView(db, deps, booking.id));
}

/** Change the visit from the manage page: date and times, headcount, note, contact name and phone. */
export async function manageUpdate(db: D1Database, deps: VisitsDeps, value: unknown, origin: string | undefined): Promise<RouteResult> {
  const input = objectBody(value);
  onlyFields(input, ["token", "edit"]);
  const booking = await managedBooking(db, deps, input.token);
  const edit = parseGuestEdit(input.edit);
  if (!edit.ok) refuse(edit);
  const timeZone = await deps.timeZone();
  let windows: BookableWindow[] = [];
  if (edit.value.times) {
    const times = resolveVisitTimes(deps.civil, timeZone, edit.value.times.date, edit.value.times.arrival, edit.value.times.departure);
    if (times.ok) windows = await windowsContaining(db, times.value);
  }
  const changed = applyGuestEdit({ civil: deps.civil, timeZone, booking: { ...bookingDetailsOf(booking), id: booking.id, revision: booking.revision }, edit: edit.value, windows, now: deps.now() });
  if (!changed.ok) refuse(changed, changed.field === "revision" || changed.field === "status" ? 409 : 400);
  if (changed.value.changes.length) {
    const moved = changed.value.next.windowId !== booking.window_id || changed.value.next.arrivalMs !== booking.arrival_ms || changed.value.next.departureMs !== booking.departure_ms;
    await applyBookingChange(db, deps, {
      current: booking, next: changed.value.next, action: "updated", actor: { kind: "guest" }, changes: changed.value.changes,
      attention: await attentionAfter(db, booking, changed.value.next), email: "changed", discord: "changed", origin, checkWindow: moved,
    });
  }
  return ok(await manageView(db, deps, booking.id));
}

/** Cancel the visit from the manage page. */
export async function manageCancel(db: D1Database, deps: VisitsDeps, value: unknown, origin: string | undefined): Promise<RouteResult> {
  const input = objectBody(value);
  onlyFields(input, ["token", "revision"]);
  const booking = await managedBooking(db, deps, input.token);
  const canceled = applyGuestCancel({ ...bookingDetailsOf(booking), id: booking.id, revision: booking.revision }, revisionOf(input.revision));
  if (!canceled.ok) refuse(canceled, 409);
  await applyBookingChange(db, deps, {
    current: booking, next: canceled.value.next, action: "canceled", actor: { kind: "guest" }, changes: canceled.value.changes,
    attention: await attentionAfter(db, booking, canceled.value.next), email: "canceled", discord: "canceled", origin,
  });
  return ok(await manageView(db, deps, booking.id));
}

// Staff changes to visits.

async function detail(db: D1Database, deps: VisitsDeps, id: string): Promise<StaffBookingDetail> {
  return staffBookingDetail(db, deps.civil, await deps.timeZone(), id);
}

async function activeTeam(db: D1Database, id: unknown): Promise<string> {
  if (typeof id !== "string" || !id || id.length > 64) throw new VisitsError(400, "Choose a guest team", "teamId");
  const team = await db.prepare("SELECT id FROM visits_teams WHERE installation_id=? AND id=? AND archived=0").bind(installationId, id).first<{ id: string }>();
  if (!team) throw new VisitsError(400, "Choose a guest team that has not been merged into another", "teamId");
  return team.id;
}

/**
 * Staff edit a visit: everything a guest can change, plus the team and the email address. Times must still fit an open
 * window, but staff may change visits that started or lie beyond the guest page's eight weeks.
 */
export async function staffEdit(db: D1Database, deps: VisitsDeps, id: string, userId: string, value: unknown, origin: string | undefined): Promise<RouteResult> {
  const input = objectBody(value);
  const { contactEmail, teamId, ...guestFields } = input;
  const edit = parseGuestEdit(guestFields);
  if (!edit.ok) refuse(edit);
  const booking = await requireBooking(db, id);
  if (booking.removed === 1 || booking.status === "canceled") throw new VisitsError(409, "Restore this visit before changing it", "status");
  if (booking.revision !== edit.value.revision) throw stale();
  let next: BookingDetails = {
    ...bookingDetailsOf(booking),
    ...(edit.value.headcount === undefined ? {} : { headcount: edit.value.headcount }),
    ...(edit.value.note === undefined ? {} : { note: edit.value.note }),
    ...(edit.value.contactName === undefined ? {} : { contactName: edit.value.contactName }),
    ...(edit.value.contactPhone === undefined ? {} : { contactPhone: edit.value.contactPhone }),
  };
  if (contactEmail !== undefined) {
    const email = parseEmail(contactEmail);
    if (!email.ok) refuse(email);
    next = { ...next, contactEmail: email.value };
  }
  if (teamId !== undefined) next = { ...next, teamId: await activeTeam(db, teamId) };
  let moved = false;
  if (edit.value.times) {
    const timeZone = await deps.timeZone();
    const times = resolveVisitTimes(deps.civil, timeZone, edit.value.times.date, edit.value.times.arrival, edit.value.times.departure);
    if (!times.ok) refuse(times);
    if (times.value.arrivalMs !== booking.arrival_ms || times.value.departureMs !== booking.departure_ms) {
      const window = findFittingWindow(await windowsContaining(db, times.value), times.value);
      if (!window.ok) refuse(window);
      next = { ...next, ...times.value, windowId: window.value.id };
      moved = true;
    }
  }
  const changes = diffBooking(bookingDetailsOf(booking), next);
  if (changes.length) {
    await applyBookingChange(db, deps, {
      current: booking, next, action: "updated", actor: { kind: "staff", userId }, changes, attention: await attentionAfter(db, booking, next),
      email: "changed", discord: "changed", origin, checkWindow: moved,
    });
  }
  return ok(await detail(db, deps, id));
}

/** Staff cancel a visit. The team gets an email. */
export async function staffCancel(db: D1Database, deps: VisitsDeps, id: string, userId: string, value: unknown, origin: string | undefined): Promise<RouteResult> {
  const input = objectBody(value);
  onlyFields(input, ["revision"]);
  const booking = await requireBooking(db, id);
  if (booking.removed === 1) throw new VisitsError(409, "This visit was removed", "status");
  const canceled = applyGuestCancel({ ...bookingDetailsOf(booking), id: booking.id, revision: booking.revision }, revisionOf(input.revision));
  if (!canceled.ok) refuse(canceled, 409);
  await applyBookingChange(db, deps, {
    current: booking, next: canceled.value.next, action: "canceled", actor: { kind: "staff", userId }, changes: canceled.value.changes,
    attention: await attentionAfter(db, booking, canceled.value.next), email: "canceled", discord: "canceled", origin,
  });
  return ok(await detail(db, deps, id));
}

/** Staff remove a visit: canceled without an email, hidden from every list, with its history kept for a restore. */
export async function staffRemove(db: D1Database, deps: VisitsDeps, id: string, userId: string, revision: number): Promise<RouteResult> {
  const booking = await requireBooking(db, id);
  if (booking.removed === 1) throw new VisitsError(409, "This visit was already removed", "status");
  if (booking.revision !== revision) throw stale();
  const next: BookingDetails = { ...bookingDetailsOf(booking), status: "canceled" };
  await applyBookingChange(db, deps, {
    current: booking, next, removed: true, action: "removed", actor: { kind: "staff", userId }, changes: diffBooking(bookingDetailsOf(booking), next),
    attention: noAttention, email: null, discord: null, origin: undefined,
  });
  return ok({ removed: true, id });
}

/**
 * Put a visit back as it was at a history entry, including a removed visit. A version whose team was since merged keeps
 * the current team. The team gets an email for the change.
 */
export async function staffRestore(db: D1Database, deps: VisitsDeps, id: string, userId: string, value: unknown, origin: string | undefined): Promise<RouteResult> {
  const input = objectBody(value);
  onlyFields(input, ["revisionId", "revision"]);
  const revision = revisionOf(input.revision);
  const target = typeof input.revisionId === "string" && /^\d{1,15}$/.test(input.revisionId) ? Number(input.revisionId) : input.revisionId;
  if (!Number.isSafeInteger(target)) throw new VisitsError(400, "Choose a version from the history", "revisionId");
  const booking = await requireBooking(db, id);
  if (booking.revision !== revision) throw stale();
  const entry = await db.prepare("SELECT snapshot_json FROM visits_booking_revisions WHERE installation_id=? AND booking_id=? AND revision=?").bind(installationId, id, target).first<{ snapshot_json: string }>();
  if (!entry) throw new VisitsError(404, "That version was not found", "revisionId");
  const snapshot = parseBookingSnapshot(entry.snapshot_json);
  if (!snapshot.ok) refuse(snapshot, 409);
  let next = snapshot.value;
  const team = await db.prepare("SELECT archived FROM visits_teams WHERE installation_id=? AND id=?").bind(installationId, next.teamId).first<{ archived: number }>();
  if (!team || team.archived === 1) next = { ...next, teamId: booking.team_id };
  if (!await windowById(db, next.windowId)) throw new VisitsError(409, "The window of that version no longer exists. Change the visit instead.", "revisionId");
  const changes = diffBooking(bookingDetailsOf(booking), next);
  if (!changes.length && booking.removed === 0) return ok(await detail(db, deps, id));
  // A visit restored to booked gets a confirmation or an update; one restored to canceled gets a cancellation, unless it
  // was canceled (or removed) already.
  const kind: MessageKind | null = next.status === "booked" ? (booking.status === "canceled" ? "booked" : "changed") : booking.status === "booked" ? "canceled" : null;
  await applyBookingChange(db, deps, {
    current: booking, next, action: "restored", actor: { kind: "staff", userId }, changes, attention: await attentionAfter(db, booking, next),
    email: kind, discord: kind, origin,
  });
  return ok(await detail(db, deps, id));
}

/** Send the confirmation again, with a fresh link, for a team that lost its email. */
export async function staffResend(db: D1Database, deps: VisitsDeps, id: string, origin: string | undefined): Promise<RouteResult> {
  const booking = await requireBooking(db, id);
  if (booking.removed === 1 || booking.status !== "booked") throw new VisitsError(409, "This visit is canceled. Restore it before sending the confirmation again.", "status");
  const now = deps.now();
  if (booking.departure_ms <= now) throw new VisitsError(409, "This visit has ended", "status");
  const notifications = await notificationStatements(db, deps, { bookingId: id, email: "resend", discord: null, origin, now });
  await db.batch(notifications.statements);
  await deliverNow(db, deps, notifications.ids);
  return ok(await detail(db, deps, id));
}

/**
 * Staff contacted the team: the visit's attention is handled, and its failed or restore-paused emails and Outreach records
 * no longer need attention. A handled Outreach record still shows as failed until the visit is recorded.
 */
export async function staffHandled(db: D1Database, deps: VisitsDeps, id: string): Promise<RouteResult> {
  const booking = await requireBooking(db, id);
  const attention = handledAttention(attentionOf(booking));
  const at = iso(deps.now());
  await db.batch([
    db.prepare("UPDATE visits_bookings SET attention=?,attention_reason=?,updated_at=? WHERE installation_id=? AND id=?").bind(attention.state, attention.reason, at, installationId, id),
    db.prepare("UPDATE visits_notifications SET status='skipped',updated_at=? WHERE installation_id=? AND booking_id=? AND channel='email' AND status IN ('failed','paused')").bind(at, installationId, id),
    db.prepare("UPDATE visits_notifications SET status='skipped',payload_json=json_set(payload_json,'$.handled',1),updated_at=? WHERE installation_id=? AND booking_id=? AND channel='outreach' AND status IN ('failed','paused')").bind(at, installationId, id),
  ]);
  return ok(await detail(db, deps, id));
}

// Guest teams.

const teamSelect = `SELECT t.id,t.number,t.name,t.program,t.outreach_team_id,t.archived,t.revision,
  (SELECT COUNT(*) FROM visits_bookings b WHERE b.installation_id=t.installation_id AND b.team_id=t.id AND b.removed=0) AS visit_count FROM visits_teams t`;

function staffTeam(row: TeamRow & { visit_count: number }): StaffTeam {
  return { id: row.id, number: row.number, name: row.name, program: row.program, revision: row.revision, archived: row.archived === 1, visitCount: Number(row.visit_count), outreachTeamId: row.outreach_team_id };
}

async function requireTeam(db: D1Database, id: string) {
  const row = await db.prepare(`${teamSelect} WHERE t.installation_id=? AND t.id=?`).bind(installationId, id).first<TeamRow & { visit_count: number }>();
  if (!row) throw new VisitsError(404, "This guest team was not found.");
  return row;
}

export async function listTeams(db: D1Database): Promise<StaffTeam[]> {
  return (await rows<TeamRow & { visit_count: number }>(db.prepare(`${teamSelect} WHERE t.installation_id=? ORDER BY t.archived,t.program,length(t.number),t.number,t.id`).bind(installationId))).map(staffTeam);
}

/** Rename a guest team. Its number and program stay; a different team is a merge. */
export async function updateTeam(db: D1Database, deps: VisitsDeps, id: string, value: unknown): Promise<RouteResult> {
  const input = objectBody(value);
  onlyFields(input, ["name", "revision"]);
  const revision = revisionOf(input.revision);
  const name = typeof input.name === "string" ? singleLine(input.name) : "";
  if (!name) throw new VisitsError(400, "Enter the team name", "name");
  if (name.length > maximumTeamNameLength) throw new VisitsError(400, `The team name is at most ${maximumTeamNameLength} characters`, "name");
  await requireTeam(db, id);
  const result = await db.prepare("UPDATE visits_teams SET name=?,revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(name, iso(deps.now()), installationId, id, revision).run();
  if (result.meta?.changes !== 1) throw stale("This team");
  return ok(staffTeam(await requireTeam(db, id)));
}

/**
 * Merge a duplicate team into another team of the same program: its visits move (each with a history entry) and it is
 * archived, which frees its number.
 */
export async function mergeTeam(db: D1Database, deps: VisitsDeps, id: string, userId: string, value: unknown): Promise<RouteResult> {
  const input = objectBody(value);
  onlyFields(input, ["intoId"]);
  if (typeof input.intoId !== "string" || !input.intoId) throw new VisitsError(400, "Choose the team to keep", "intoId");
  const intoId = input.intoId;
  if (intoId === id) throw new VisitsError(400, "Choose a different team to keep", "intoId");
  const [from, into] = await Promise.all([requireTeam(db, id), requireTeam(db, intoId).catch(() => null)]);
  if (!into) throw new VisitsError(400, "Choose the team to keep", "intoId");
  if (from.archived === 1) throw new VisitsError(409, "This team was already merged", "id");
  if (into.archived === 1) throw new VisitsError(400, "Choose a team that has not been merged into another", "intoId");
  if (from.program !== into.program) throw new VisitsError(400, "Merge only teams in the same program", "intoId");
  const now = deps.now();
  const at = iso(now);
  const changes = "json_array(json_object('field','teamId','from',team_id,'to',?))";
  // Visits recorded under another Outreach supported team than the kept team's keep that activity in Outreach, need
  // attention and are recorded again for the kept team when an Admin's grant allows it.
  const relink = from.outreach_team_id !== into.outreach_team_id;
  const requeue = relink && outreachProgram(into.program) !== null && (await outreachAccess(db, deps, now)).granted;
  const recorded = "installation_id=? AND team_id=? AND status='booked' AND removed=0 AND outreach_activity_id IS NOT NULL";
  const kept = "attention='needed' AND attention_reason IS NOT NULL AND attention_reason!='outreach-activity-kept'";
  try {
    await db.batch([
      guardStatement(db, "visits_stale_team", "EXISTS(SELECT 1 FROM visits_teams WHERE installation_id=? AND id=? AND archived=0) AND EXISTS(SELECT 1 FROM visits_teams WHERE installation_id=? AND id=? AND archived=0)", installationId, id, installationId, intoId),
      ...(requeue ? [db.prepare(`INSERT INTO visits_notifications(installation_id,id,channel,kind,booking_id,payload_json,status,attempts,next_attempt_ms,created_at,updated_at)
        SELECT installation_id,lower(hex(randomblob(16))),'outreach','outreach-record',id,'{}','pending',0,?,?,? FROM visits_bookings WHERE ${recorded}
        ON CONFLICT(installation_id,booking_id) WHERE channel='outreach' AND status='pending' DO NOTHING`).bind(now, at, at, installationId, id)] : []),
      ...(relink ? [db.prepare(`UPDATE visits_bookings SET outreach_activity_id=NULL,attention=CASE WHEN ${kept} THEN attention ELSE 'needed' END,
        attention_reason=CASE WHEN ${kept} THEN attention_reason ELSE 'outreach-activity-kept' END,updated_at=? WHERE ${recorded}`).bind(at, installationId, id)] : []),
      db.prepare(`INSERT INTO visits_booking_revisions(installation_id,booking_id,revision,action,actor_kind,staff_user_id,change_json,snapshot_json,created_at)
        SELECT installation_id,id,revision+1,'updated','staff',?,${changes},${snapshotSql("?")},? FROM visits_bookings WHERE installation_id=? AND team_id=?`).bind(userId, intoId, intoId, at, installationId, id),
      db.prepare("UPDATE visits_bookings SET team_id=?,revision=revision+1,updated_at=? WHERE installation_id=? AND team_id=?").bind(intoId, at, installationId, id),
      db.prepare("UPDATE visits_teams SET archived=1,revision=revision+1,updated_at=? WHERE installation_id=? AND id=?").bind(at, installationId, id),
    ]);
  } catch (error) {
    if (guardFailed(error, "visits_stale_team")) throw stale("This team");
    throw error;
  }
  return ok(staffTeam(await requireTeam(db, intoId)));
}

// Record in Outreach.

/** The 409 when nothing lets Guest Visits use Outreach for this request. */
export const outreachAccessMessage = "Guest Visits has no access to Outreach. An Admin can grant it in Settings > Modules > Module access, or ask someone who manages Outreach to record these visits.";

/**
 * Record visits in Outreach now, through an Admin's grant or the staff member's own Outreach access: booked visits of
 * Outreach's programs, at most `maximumOutreachRecordBatch` per request. With a grant, visits beyond that are queued for
 * the job; without one they wait for another request. Repeating changes nothing in Outreach.
 */
export async function recordOutreach(db: D1Database, deps: VisitsDeps, value: unknown): Promise<RouteResult> {
  const input = objectBody(value);
  onlyFields(input, ["bookingIds"]);
  const list = input.bookingIds;
  if (!Array.isArray(list) || !list.length || list.length > 500 || list.some((id) => typeof id !== "string" || !id || id.length > 64)) throw new VisitsError(400, "Choose the visits to record", "bookingIds");
  const ids = [...new Set(list as string[])];
  const now = deps.now();
  const access = await outreachAccess(db, deps, now);
  if (!access.client) throw new VisitsError(409, outreachAccessMessage);
  const results: OutreachRecordResult[] = [];
  // Only visits that are attempted count toward the limit; skipped ones cost no Outreach call.
  let attempted = 0;
  for (const bookingId of ids) {
    const booking = await db.prepare("SELECT b.status,b.removed,t.program FROM visits_bookings b JOIN visits_teams t ON t.installation_id=b.installation_id AND t.id=b.team_id WHERE b.installation_id=? AND b.id=?")
      .bind(installationId, bookingId).first<{ status: "booked" | "canceled"; removed: number; program: VisitProgram }>();
    const refusal = !booking ? "This visit was not found" : booking.removed === 1 ? "This visit was removed" : booking.status !== "booked" ? "Canceled visits are not recorded in Outreach"
      : outreachProgram(booking.program) === null ? "Outreach does not support teams with program Other" : null;
    if (refusal) {
      results.push({ bookingId, state: "skipped", activityId: null, error: refusal });
    } else if (attempted < maximumOutreachRecordBatch) {
      attempted += 1;
      results.push({ bookingId, ...await recordOutreachNow(db, deps, access.client, bookingId, { final: !access.granted }) });
    } else if (access.granted) {
      await queueOutreachStatement(db, bookingId, now).run();
      results.push({ bookingId, state: "pending", activityId: null });
    } else {
      results.push({ bookingId, state: "skipped", activityId: null, error: `Record in Outreach records at most ${maximumOutreachRecordBatch} visits at a time. Record the rest again.` });
    }
  }
  return ok({ results });
}
