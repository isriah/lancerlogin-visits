// Reads the workspace shares: staff booking rows with their team, window, email and Outreach state, and what Needs
// attention lists.
import type { D1Database } from "@lancerlogin/module-sdk/api";
import type { BookingHistoryEntry, EmailState, StaffBooking, StaffBookingDetail } from "../shared/visits-api.ts";
import type { FieldChange, VisitProgram } from "../shared/visits-booking.ts";
import { outreachState } from "../shared/visits-outreach.ts";
import type { CivilTime } from "../shared/visits-time.ts";
import { attentionOf, bookingColumns, installationId, localTimes, rows, VisitsError, type BookingRow } from "./visits-runtime.ts";

/** `last_error` of an email that waits because its address reached the daily cap. Needs attention lists these. */
export const emailCappedMessage = "Waiting: this address reached its daily Guest Visits email limit";

/** Status and error of each booking's latest email. */
const emailStateColumns = ["status", "last_error"].map((column) => `(SELECT n.${column} FROM visits_notifications n WHERE n.installation_id=b.installation_id AND n.booking_id=b.id AND n.channel='email' ORDER BY n.created_at DESC,n.rowid DESC LIMIT 1) AS email_${column === "status" ? "status" : "error"}`).join(",");

/** Status, error and handled mark of each booking's latest Outreach record. */
const outreachStateColumns = [["status", "n.status"], ["error", "n.last_error"], ["handled", "json_extract(n.payload_json,'$.handled')"]]
  .map(([name, value]) => `(SELECT ${value} FROM visits_notifications n WHERE n.installation_id=b.installation_id AND n.booking_id=b.id AND n.channel='outreach' ORDER BY n.created_at DESC,n.rowid DESC LIMIT 1) AS outreach_${name}`).join(",");

/**
 * What Needs attention lists: visits whose window was canceled, removed or changed, or that were recorded in Outreach
 * before they were canceled or moved (until staff handle them), visits whose latest email failed, waits under the daily
 * cap or was paused by a restore, and visits whose latest Outreach record failed or was paused by a restore.
 */
const attentionPredicate = `(attention='needed' OR email_status IN ('failed','paused') OR (email_status='pending' AND email_error='${emailCappedMessage}') OR outreach_status IN ('failed','paused'))`;

export const attentionCountSql = `SELECT COUNT(*) AS count FROM (SELECT b.attention,${emailStateColumns},${outreachStateColumns} FROM visits_bookings b WHERE b.installation_id=? AND b.removed=0) WHERE ${attentionPredicate}`;

export type StaffBookingRow = BookingRow & {
  team_number: string; team_name: string; team_program: VisitProgram; window_title: string; email_status: string | null; email_error: string | null;
  outreach_status: string | null; outreach_error: string | null; outreach_handled: number | null;
};

const staffBookingSelect = `SELECT ${bookingColumns},t.number AS team_number,t.name AS team_name,t.program AS team_program,w.title AS window_title,${emailStateColumns},${outreachStateColumns}
  FROM visits_bookings b JOIN visits_teams t ON t.installation_id=b.installation_id AND t.id=b.team_id
  JOIN visits_windows w ON w.installation_id=b.installation_id AND w.id=b.window_id`;

export function emailState(status: string | null, error: string | null): EmailState {
  if (!status) return "none";
  if (status === "delivered") return "sent";
  // A failed email staff marked handled is skipped: it still failed, but no longer needs attention.
  if (status === "failed" || status === "skipped") return "failed";
  if (status === "pending" && error === emailCappedMessage) return "capped";
  // A restore paused it; nothing sends it until staff resend the confirmation.
  if (status === "paused") return "paused";
  return "pending";
}

export function staffBooking(civil: CivilTime, timeZone: string, row: StaffBookingRow): StaffBooking {
  return {
    ...localTimes(civil, timeZone, row.arrival_ms, row.departure_ms),
    id: row.id, revision: row.revision, status: row.status, removed: row.removed === 1,
    team: { id: row.team_id, number: row.team_number, name: row.team_name, program: row.team_program },
    windowId: row.window_id, windowTitle: row.window_title, headcount: row.headcount, note: row.note,
    contactName: row.contact_name, contactEmail: row.contact_email, contactPhone: row.contact_phone,
    attention: attentionOf(row), email: emailState(row.email_status, row.email_error),
    outreach: outreachState({ program: row.team_program, activityId: row.outreach_activity_id, status: row.outreach_status, error: row.outreach_error, handled: Number(row.outreach_handled) === 1 }),
    createdMs: Date.parse(row.created_at), updatedMs: Date.parse(row.updated_at),
  };
}

export const bookingScopes = ["upcoming", "past", "removed", "attention"] as const;
export type BookingScope = (typeof bookingScopes)[number];

/** Staff booking lists. Removed visits are listed only under `removed`, most recent visit first. */
export async function listStaffBookings(db: D1Database, civil: CivilTime, timeZone: string, scope: BookingScope, now: number): Promise<StaffBooking[]> {
  const statement = scope === "upcoming"
    ? db.prepare(`${staffBookingSelect} WHERE b.installation_id=? AND b.removed=0 AND b.departure_ms>? ORDER BY b.arrival_ms,b.departure_ms,b.id LIMIT 500`).bind(installationId, now)
    : scope === "past"
      ? db.prepare(`${staffBookingSelect} WHERE b.installation_id=? AND b.removed=0 AND b.departure_ms<=? ORDER BY b.arrival_ms DESC,b.id LIMIT 500`).bind(installationId, now)
      : scope === "removed"
        ? db.prepare(`${staffBookingSelect} WHERE b.installation_id=? AND b.removed=1 ORDER BY b.arrival_ms DESC,b.id LIMIT 500`).bind(installationId)
        : db.prepare(`SELECT * FROM (${staffBookingSelect} WHERE b.installation_id=? AND b.removed=0) WHERE ${attentionPredicate} ORDER BY arrival_ms,id LIMIT 500`).bind(installationId);
  return (await rows<StaffBookingRow>(statement)).map((row) => staffBooking(civil, timeZone, row));
}

/** Staff bookings whose visits start within a range of instants. */
export async function staffBookingsBetween(db: D1Database, civil: CivilTime, timeZone: string, fromMs: number, toMs: number): Promise<StaffBooking[]> {
  const result = await rows<StaffBookingRow>(db.prepare(`${staffBookingSelect} WHERE b.installation_id=? AND b.removed=0 AND b.arrival_ms>=? AND b.arrival_ms<? ORDER BY b.arrival_ms,b.departure_ms,b.id`).bind(installationId, fromMs, toMs));
  return result.map((row) => staffBooking(civil, timeZone, row));
}

/** One booking as staff see it, with its change history, newest first. A removed visit is found here, canceled, so staff can restore it. */
export async function staffBookingDetail(db: D1Database, civil: CivilTime, timeZone: string, bookingId: string): Promise<StaffBookingDetail> {
  const row = await db.prepare(`${staffBookingSelect} WHERE b.installation_id=? AND b.id=?`).bind(installationId, bookingId).first<StaffBookingRow>();
  if (!row) throw new VisitsError(404, "This visit was not found.");
  const history = await rows<{ revision: number; action: string; actor_kind: "guest" | "staff"; change_json: string; created_at: string }>(
    db.prepare("SELECT revision,action,actor_kind,change_json,created_at FROM visits_booking_revisions WHERE installation_id=? AND booking_id=? ORDER BY revision DESC").bind(installationId, bookingId));
  return {
    ...staffBooking(civil, timeZone, row),
    history: history.map((entry): BookingHistoryEntry => ({
      id: String(entry.revision), atMs: Date.parse(entry.created_at),
      // Staff names stay in Core; Guest Visits keeps only the user ID.
      actor: entry.actor_kind === "guest" ? { kind: "guest" } : { kind: "staff", name: null },
      action: entry.action, changes: JSON.parse(entry.change_json) as FieldChange[],
    })),
  };
}
