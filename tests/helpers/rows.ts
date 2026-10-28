// Synthetic rows for the SQL tests. Each helper fills every required column with a valid default and takes overrides.
import type { TestDatabase } from "./d1.ts";

type Values = Record<string, unknown>;
const stamp = "2026-10-01T12:00:00.000Z";
/** Monday 2026-11-02 18:00 to 21:00 in America/New_York (EST). */
export const windowStart = Date.UTC(2026, 10, 2, 23, 0);
export const windowEnd = Date.UTC(2026, 10, 3, 2, 0);
export const hash = (seed: string) => seed.repeat(64).slice(0, 64);

export function insertStatement(db: TestDatabase, table: string, values: Values) {
  const columns = Object.keys(values);
  return db.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).bind(...columns.map((column) => values[column]));
}

export async function insert(db: TestDatabase, table: string, values: Values) {
  return insertStatement(db, table, values).run();
}

export const settingsRow = (values: Values = {}): Values => ({ installation_id: "primary", weekly_summary_since_ms: 0, updated_at: stamp, ...values });
export const seriesRow = (values: Values = {}): Values => ({ installation_id: "primary", id: "series-1", weekday_mask: 0b0001010, start_time: "18:00", end_time: "21:00", first_date: "2026-11-02", last_date: "2026-12-18", title: "Open shop", created_at: stamp, updated_at: stamp, ...values });
export const windowRow = (values: Values = {}): Values => ({ installation_id: "primary", id: "window-1", start_ms: windowStart, end_ms: windowEnd, title: "Open shop", created_at: stamp, updated_at: stamp, ...values });
export const teamRow = (values: Values = {}): Values => ({ installation_id: "primary", id: "team-1", number: "1234", name: "Gearheads", program: "FRC", created_at: stamp, updated_at: stamp, ...values });
export const bookingRow = (values: Values = {}): Values => ({
  installation_id: "primary", id: "booking-1", window_id: "window-1", team_id: "team-1", contact_name: "Pat Coach", contact_email: "pat@example.org",
  arrival_ms: windowStart, departure_ms: windowStart + 3_600_000, headcount: 12, created_at: stamp, updated_at: stamp, ...values,
});
export const revisionRow = (values: Values = {}): Values => ({ installation_id: "primary", booking_id: "booking-1", revision: 0, action: "created", actor_kind: "guest", change_json: "[]", snapshot_json: "{}", created_at: stamp, ...values });
export const tokenRow = (values: Values = {}): Values => ({ installation_id: "primary", token_hash: hash("a"), booking_id: "booking-1", issued_ms: windowStart - 86_400_000, expires_ms: windowStart + 3_600_000, ...values });
export const submissionKeyRow = (values: Values = {}): Values => ({ installation_id: "primary", key_hash: hash("b"), fingerprint: hash("c"), booking_id: "booking-1", created_ms: windowStart - 86_400_000, ...values });
export const notificationRow = (values: Values = {}): Values => ({ installation_id: "primary", id: "notification-1", channel: "email", kind: "booked", booking_id: "booking-1", next_attempt_ms: 0, created_at: stamp, updated_at: stamp, ...values });

/** A window, team and booking. */
export async function seedBooking(db: TestDatabase) {
  await insert(db, "visits_windows", windowRow());
  await insert(db, "visits_teams", teamRow());
  await insert(db, "visits_bookings", bookingRow());
}

