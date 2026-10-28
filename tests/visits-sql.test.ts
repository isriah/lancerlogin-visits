// The migration applied to Node's built-in SQLite through a D1-shaped adapter: constraints, uniqueness, cascades,
// triggers, cleanup order, backup columns and the indexes the Worker's queries rely on.
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase, migrationFiles, type TestDatabase } from "./helpers/d1.ts";
import {
  bookingRow, hash, insert, insertStatement, notificationRow, revisionRow, seedBooking, seriesRow, settingsRow, submissionKeyRow, teamRow, tokenRow,
  windowEnd, windowRow, windowStart,
} from "./helpers/rows.ts";
import {
  defaultSettingsSql, neutralizeVisitsBackup, pausedVisitsOperations, visitsBackupColumns, visitsCleanupBlockerSql, visitsCleanupSteps, visitsTables,
} from "../src/shared/visits-storage.ts";

const check = /CHECK constraint failed/;
const unique = /UNIQUE constraint failed/;
const foreignKey = /FOREIGN KEY constraint failed/;
const hour = 3_600_000;

function columns(db: TestDatabase, table: string): string[] {
  return db.rows<{ name: string }>(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).map((row) => row.name);
}

function plan(db: TestDatabase, sql: string, ...values: unknown[]): string {
  return db.rows<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...values).map((row) => row.detail).join("\n");
}

test("the migration contains only plugin-owned schema and allowed references", () => {
  const sql = migrationFiles().map((file) => file.sql).join("\n").replace(/--.*$/gm, "");
  assert.doesNotMatch(sql, /\b(PRAGMA|ATTACH|DETACH|VACUUM|VIEW|TEMP|TEMPORARY|VIRTUAL)\b/i);
  assert.doesNotMatch(sql, /\?/, "no bound parameters");
  for (const match of sql.matchAll(/CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER) (\w+)/g)) assert.match(match[1]!, /^visits_[a-z0-9_]+$/);
  for (const match of sql.matchAll(/REFERENCES (\w+)\(([^)]*)\)([^,\n]*)/g)) {
    const [, table, , clause] = match;
    if (table!.startsWith("visits_")) continue;
    assert.ok(["installations", "users"].includes(table!), `references ${table}`);
    assert.match(clause!, table === "installations" ? /ON DELETE CASCADE/ : /ON DELETE SET NULL/);
  }
});

test("every table is scoped to its installation and removed with it", async () => {
  const db = createTestDatabase();
  for (const table of visitsTables) {
    assert.equal(columns(db, table)[0], "installation_id", table);
    const keys = db.rows<{ table: string; from: string; on_delete: string }>(`SELECT "table", "from", on_delete FROM pragma_foreign_key_list('${table}')`);
    assert.ok(keys.some((key) => key.table === "installations" && key.from === "installation_id" && key.on_delete === "CASCADE"), table);
    assert.equal(db.rows<{ notnull: number }>(`SELECT "notnull" FROM pragma_table_info('${table}') WHERE name='installation_id'`)[0]!.notnull, 1, table);
  }
  await insert(db, "visits_settings", settingsRow());
  await insert(db, "visits_availability_series", seriesRow());
  await seedBooking(db);
  await insert(db, "visits_booking_revisions", revisionRow());
  await insert(db, "visits_manage_tokens", tokenRow());
  await insert(db, "visits_public_submission_keys", submissionKeyRow());
  await insert(db, "visits_email_limits", { installation_id: "primary", address_hash: hash("d"), local_day: "2026-11-02", sent: 1 });
  await insert(db, "visits_notifications", notificationRow());
  db.exec("DELETE FROM installations WHERE id='primary'");
  for (const table of visitsTables) assert.equal(db.rows(`SELECT 1 FROM ${table}`).length, 0, table);
});

test("backup columns are exactly each portable table's columns", () => {
  const db = createTestDatabase();
  for (const [table, exported] of Object.entries(visitsBackupColumns)) assert.deepEqual(exported, columns(db, table), table);
});

test("settings default to Discord off and a Monday 12:00 summary, created once", async () => {
  const db = createTestDatabase();
  const now = "2026-10-28T15:00:00.000Z";
  await db.batch([db.prepare(defaultSettingsSql).bind("primary", Date.parse(now), now)]);
  await db.prepare("UPDATE visits_settings SET intro_text='Welcome' WHERE installation_id='primary'").run();
  await db.batch([db.prepare(defaultSettingsSql).bind("primary", Date.parse(now) + 1, now)]);
  assert.deepEqual(await db.prepare("SELECT intro_text,discord_enabled,weekly_summary_enabled,weekly_summary_weekday,weekly_summary_time,weekly_summary_since_ms,revision FROM visits_settings").first(), {
    intro_text: "Welcome", discord_enabled: 0, weekly_summary_enabled: 1, weekly_summary_weekday: 1, weekly_summary_time: "12:00", weekly_summary_since_ms: Date.parse(now), revision: 0,
  });
  const update = (set: string) => db.prepare(`UPDATE visits_settings SET ${set} WHERE installation_id='primary'`).run();
  for (const set of ["weekly_summary_weekday=7", "weekly_summary_weekday=1.5", "weekly_summary_time='24:00'", "weekly_summary_time='9:00'", "discord_enabled=1", "discord_channel_id='123'", "discord_channel_id='12345678901234567x'", "reply_to='not-an-address'", "revision=-1"]) {
    await assert.rejects(update(set), check, set);
  }
  await update("discord_enabled=1, discord_channel_id='123456789012345678', weekly_summary_weekday=0, weekly_summary_time='23:59', reply_to='coach@example.org'");
});

test("series check weekdays, times and a date range of at most 366 days", async () => {
  const db = createTestDatabase();
  await insert(db, "visits_availability_series", seriesRow());
  const bad = [
    { weekday_mask: 0 }, { weekday_mask: 128 }, { start_time: "21:00", end_time: "18:00" }, { start_time: "18:00", end_time: "18:00" }, { end_time: "25:00" },
    { first_date: "2026-02-30" }, { first_date: "2026-11-2" }, { first_date: "2026-12-19" }, { first_date: "2026-01-01", last_date: "2027-01-02" }, { title: "x".repeat(81) },
  ];
  for (const [index, values] of bad.entries()) await assert.rejects(insert(db, "visits_availability_series", seriesRow({ id: `bad-${index}`, ...values })), check, JSON.stringify(values));
  await insert(db, "visits_availability_series", seriesRow({ id: "year", first_date: "2026-01-01", last_date: "2027-01-01" }));
});

test("windows never overlap; touching, removed and other installations' windows are fine", async () => {
  const db = createTestDatabase();
  db.exec("INSERT INTO installations(id) VALUES ('other')");
  await insert(db, "visits_windows", windowRow());
  await assert.rejects(insert(db, "visits_windows", windowRow({ id: "inside", start_ms: windowStart + hour, end_ms: windowEnd - hour })), /visits_window_overlap/);
  await assert.rejects(insert(db, "visits_windows", windowRow({ id: "around", start_ms: windowStart - hour, end_ms: windowEnd + hour })), /visits_window_overlap/);
  await assert.rejects(insert(db, "visits_windows", windowRow({ id: "late", start_ms: windowEnd - hour, end_ms: windowEnd + hour })), /visits_window_overlap/);
  await insert(db, "visits_windows", windowRow({ id: "after", start_ms: windowEnd, end_ms: windowEnd + hour }));
  await insert(db, "visits_windows", windowRow({ id: "before", start_ms: windowStart - 2 * hour, end_ms: windowStart }));
  await insert(db, "visits_windows", windowRow({ id: "removed", start_ms: windowStart, end_ms: windowEnd, status: "removed" }));
  await insert(db, "visits_windows", windowRow({ installation_id: "other", id: "window-1" }));
  // A canceled window still blocks, so it can be restored.
  await db.prepare("UPDATE visits_windows SET status='canceled',cancel_reason='Thanksgiving',revision=revision+1 WHERE installation_id='primary' AND id='window-1'").run();
  await assert.rejects(insert(db, "visits_windows", windowRow({ id: "replacement" })), /visits_window_overlap/);
  // Moving or restoring into an occupied time is refused too.
  await assert.rejects(db.prepare("UPDATE visits_windows SET start_ms=?,revision=revision+1 WHERE installation_id='primary' AND id='after'").bind(windowEnd - hour).run(), /visits_window_overlap/);
  await assert.rejects(db.prepare("UPDATE visits_windows SET status='open',revision=revision+1 WHERE installation_id='primary' AND id='removed'").run(), /visits_window_overlap/);
  // A 25-hour local day (clocks falling back) is the longest window.
  await insert(db, "visits_windows", windowRow({ id: "long-day", start_ms: Date.UTC(2026, 10, 1, 4), end_ms: Date.UTC(2026, 10, 2, 5) }));
  await assert.rejects(insert(db, "visits_windows", windowRow({ id: "too-long", start_ms: Date.UTC(2026, 11, 1), end_ms: Date.UTC(2026, 11, 2, 1, 1) })), check);
});

test("window rows check status, reason, whole minutes and series references", async () => {
  const db = createTestDatabase();
  const at = (days: number) => windowStart + days * 86_400_000;
  const bad = [
    { status: "canceled" }, { cancel_reason: "Snow" }, { status: "closed" }, { start_ms: at(1) + 1, end_ms: at(1) + hour }, { start_ms: at(1), end_ms: at(1) }, { edited: 2 },
  ];
  for (const [index, values] of bad.entries()) await assert.rejects(insert(db, "visits_windows", windowRow({ id: `bad-${index}`, start_ms: at(1), end_ms: at(1) + hour, ...values })), check, JSON.stringify(values));
  await assert.rejects(insert(db, "visits_windows", windowRow({ series_id: "missing" })), foreignKey);
  await insert(db, "visits_availability_series", seriesRow());
  await insert(db, "visits_windows", windowRow({ series_id: "series-1" }));
  await assert.rejects(db.prepare("DELETE FROM visits_availability_series WHERE id='series-1'").run(), foreignKey);
  await db.prepare("UPDATE visits_windows SET series_id=NULL WHERE id='window-1'").run();
  await db.prepare("DELETE FROM visits_availability_series WHERE id='series-1'").run();
});

test("a window change guests can see moves its revision forward by exactly one", async () => {
  const db = createTestDatabase();
  await insert(db, "visits_windows", windowRow());
  const update = (set: string) => db.prepare(`UPDATE visits_windows SET ${set} WHERE installation_id='primary' AND id='window-1'`).run();
  await assert.rejects(update("title='Build night'"), /visits_window_revision/);
  await assert.rejects(update("title='Build night',revision=revision+2"), /visits_window_revision/);
  await update("title='Build night',revision=revision+1");
  await update("edited=1,updated_at='2026-10-02T00:00:00.000Z'");
  await assert.rejects(update("revision=revision-1"), /visits_window_revision/);
  // A stale edit carries an old revision and changes nothing.
  const stale = await db.prepare("UPDATE visits_windows SET title='Old',revision=revision+1 WHERE installation_id='primary' AND id='window-1' AND revision=?").bind(0).run();
  assert.equal(stale.meta.changes, 0);
  assert.deepEqual(await db.prepare("SELECT title,revision,edited FROM visits_windows").first(), { title: "Build night", revision: 1, edited: 1 });
});

test("teams use Outreach's programs, program-specific numbers and one active team per program and number", async () => {
  const db = createTestDatabase();
  for (const [index, program] of ["FRC", "FTC", "Challenge", "Explore"].entries()) await insert(db, "visits_teams", teamRow({ id: `team-${index}`, program, number: "321" }));
  await insert(db, "visits_teams", teamRow({ id: "other", program: "Other", number: "99X-B" }));
  await assert.rejects(insert(db, "visits_teams", teamRow({ id: "duplicate", program: "FRC", number: "321", name: "Copy" })), unique);
  await insert(db, "visits_teams", teamRow({ id: "archived", program: "FRC", number: "321", name: "Merged copy", archived: 1 }));
  const bad = [
    { program: "FLL" }, { program: "other" }, { number: "0321" }, { number: "12a" }, { number: "1234567" }, { number: "" },
    { program: "Other", number: "99x" }, { program: "Other", number: "ABCDEFGHIJK" }, { name: "" }, { program: "Other", number: "7", outreach_team_id: "o-1" },
  ];
  for (const [index, values] of bad.entries()) await assert.rejects(insert(db, "visits_teams", teamRow({ id: `bad-${index}`, number: String(9000 + index), ...values })), check, JSON.stringify(values));
  await insert(db, "visits_teams", teamRow({ id: "linked", number: "4000", outreach_team_id: "outreach-team-7" }));
});

test("bookings check their fields and reference their window and team", async () => {
  const db = createTestDatabase();
  await insert(db, "visits_windows", windowRow());
  await insert(db, "visits_teams", teamRow());
  await assert.rejects(insert(db, "visits_bookings", bookingRow({ window_id: "missing" })), foreignKey);
  await assert.rejects(insert(db, "visits_bookings", bookingRow({ team_id: "missing" })), foreignKey);
  const bad = [
    { headcount: 0 }, { headcount: 101 }, { headcount: 2.5 }, { contact_email: "nobody" }, { contact_email: "@example.org" }, { contact_name: "" },
    { departure_ms: windowStart }, { arrival_ms: windowStart + 1 }, { status: "pending" }, { attention: "needed" }, { attention_reason: "window-canceled" },
    { attention: "needed", attention_reason: "lost" }, { note: "x".repeat(1001) },
  ];
  for (const [index, values] of bad.entries()) await assert.rejects(insert(db, "visits_bookings", bookingRow({ id: `bad-${index}`, ...values })), check, JSON.stringify(values));
  await insert(db, "visits_bookings", bookingRow({ attention: "needed", attention_reason: "window-canceled" }));
  // Any number of visits may overlap.
  await insert(db, "visits_bookings", bookingRow({ id: "booking-2" }));
});

test("booking edits carry the revision: stale edits change nothing and bookkeeping never bumps it", async () => {
  const db = createTestDatabase();
  await seedBooking(db);
  const edit = (revision: number, headcount: number) => db.prepare("UPDATE visits_bookings SET headcount=?,revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(headcount, "2026-10-02T00:00:00.000Z", "primary", "booking-1", revision).run();
  assert.equal((await edit(0, 14)).meta.changes, 1);
  assert.equal((await edit(0, 20)).meta.changes, 0, "a stale edit is rejected");
  await assert.rejects(db.prepare("UPDATE visits_bookings SET note='Bring snacks' WHERE id='booking-1'").run(), /visits_booking_revision/);
  await assert.rejects(db.prepare("UPDATE visits_bookings SET status='canceled',revision=revision+2 WHERE id='booking-1'").run(), /visits_booking_revision/);
  await db.prepare("UPDATE visits_bookings SET attention='needed',attention_reason='window-changed',outreach_activity_id='activity-9' WHERE id='booking-1'").run();
  assert.deepEqual(await db.prepare("SELECT headcount,revision,attention,outreach_activity_id FROM visits_bookings").first(), { headcount: 14, revision: 1, attention: "needed", outreach_activity_id: "activity-9" });
});

test("a removed visit is canceled, and removing or restoring it moves the revision like any change guests can see", async () => {
  const db = createTestDatabase();
  await seedBooking(db);
  await assert.rejects(db.prepare("UPDATE visits_bookings SET removed=1,revision=revision+1 WHERE id='booking-1'").run(), check);
  await assert.rejects(db.prepare("UPDATE visits_bookings SET removed=1,status='canceled' WHERE id='booking-1'").run(), /visits_booking_revision/);
  await assert.rejects(db.prepare("UPDATE visits_bookings SET removed=2,status='canceled',revision=revision+1 WHERE id='booking-1'").run(), check);
  await db.prepare("UPDATE visits_bookings SET removed=1,status='canceled',revision=revision+1 WHERE id='booking-1'").run();
  await insert(db, "visits_booking_revisions", revisionRow({ revision: 1, action: "removed", actor_kind: "staff", staff_user_id: "user-1" }));
  await assert.rejects(db.prepare("UPDATE visits_bookings SET removed=0,status='booked' WHERE id='booking-1'").run(), /visits_booking_revision/);
  await db.prepare("UPDATE visits_bookings SET removed=0,status='booked',revision=revision+1 WHERE id='booking-1'").run();
  assert.deepEqual(await db.prepare("SELECT status,removed,revision FROM visits_bookings").first(), { status: "booked", removed: 0, revision: 2 });
  await assert.rejects(insert(db, "visits_booking_revisions", revisionRow({ revision: 2, action: "deleted" })), check);
});

test("change history is append-only and keeps working when a staff account is deleted", async () => {
  const db = createTestDatabase();
  await seedBooking(db);
  await insert(db, "visits_booking_revisions", revisionRow());
  await insert(db, "visits_booking_revisions", revisionRow({ revision: 1, action: "updated", actor_kind: "staff", staff_user_id: "user-1" }));
  await assert.rejects(insert(db, "visits_booking_revisions", revisionRow({ revision: 1 })), unique);
  await assert.rejects(insert(db, "visits_booking_revisions", revisionRow({ revision: 2, staff_user_id: "user-1" })), check);
  await assert.rejects(insert(db, "visits_booking_revisions", revisionRow({ revision: 2, change_json: "{not json" })), check);
  await assert.rejects(insert(db, "visits_booking_revisions", revisionRow({ revision: 2, actor_kind: "system" })), check);
  await assert.rejects(insert(db, "visits_booking_revisions", revisionRow({ revision: 2, staff_user_id: "missing", actor_kind: "staff" })), foreignKey);
  await assert.rejects(db.prepare("UPDATE visits_booking_revisions SET change_json='[1]' WHERE revision=0").run(), /visits_booking_revisions_append_only/);
  await assert.rejects(db.prepare("UPDATE visits_booking_revisions SET staff_user_id=NULL, action='canceled' WHERE revision=1").run(), /visits_booking_revisions_append_only/);
  db.exec("DELETE FROM users WHERE id='user-1'");
  assert.deepEqual(db.rows("SELECT revision,actor_kind,staff_user_id FROM visits_booking_revisions ORDER BY revision"), [
    { revision: 0, actor_kind: "guest", staff_user_id: null }, { revision: 1, actor_kind: "staff", staff_user_id: null },
  ]);
});

test("manage tokens store only a unique hash and go with their booking", async () => {
  const db = createTestDatabase();
  await seedBooking(db);
  await insert(db, "visits_manage_tokens", tokenRow());
  await assert.rejects(insert(db, "visits_manage_tokens", tokenRow()), unique);
  for (const tokenHash of ["A".repeat(64), "a".repeat(63), "g".repeat(64)]) await assert.rejects(insert(db, "visits_manage_tokens", tokenRow({ token_hash: tokenHash })), check);
  await assert.rejects(insert(db, "visits_manage_tokens", tokenRow({ token_hash: hash("e"), booking_id: "missing" })), foreignKey);
  await insert(db, "visits_manage_tokens", tokenRow({ token_hash: hash("f") }));
  // Correcting the email address revokes every link for the booking.
  const revoked = await db.prepare("UPDATE visits_manage_tokens SET revoked_ms=? WHERE installation_id=? AND booking_id=? AND revoked_ms IS NULL").bind(windowStart - hour, "primary", "booking-1").run();
  assert.equal(revoked.meta.changes, 2);
  assert.match(plan(db, "SELECT booking_id,expires_ms,revoked_ms FROM visits_manage_tokens WHERE installation_id=? AND token_hash=?", "primary", hash("a")), /USING (INDEX sqlite_autoindex_visits_manage_tokens_1|PRIMARY KEY)/);
  assert.match(plan(db, "UPDATE visits_manage_tokens SET revoked_ms=1 WHERE installation_id=? AND booking_id=?", "primary", "booking-1"), /visits_manage_tokens_booking/);
  db.exec("DELETE FROM visits_bookings");
  assert.equal(db.rows("SELECT 1 FROM visits_manage_tokens").length, 0);
});

test("a guest submission key books once: a replayed batch fails whole and leaves one booking", async () => {
  const db = createTestDatabase();
  await insert(db, "visits_windows", windowRow());
  await insert(db, "visits_teams", teamRow());
  const submit = (bookingId: string) => db.batch([
    insertStatement(db, "visits_bookings", bookingRow({ id: bookingId })),
    insertStatement(db, "visits_booking_revisions", revisionRow({ booking_id: bookingId })),
    insertStatement(db, "visits_public_submission_keys", submissionKeyRow({ booking_id: bookingId })),
    insertStatement(db, "visits_notifications", notificationRow({ id: `${bookingId}-email`, booking_id: bookingId })),
  ]);
  await submit("booking-1");
  await assert.rejects(submit("booking-2"), unique);
  assert.deepEqual(db.rows("SELECT id FROM visits_bookings"), [{ id: "booking-1" }]);
  assert.equal(db.rows("SELECT 1 FROM visits_notifications").length, 1);
  assert.deepEqual(await db.prepare("SELECT booking_id,fingerprint FROM visits_public_submission_keys WHERE installation_id=? AND key_hash=?").bind("primary", hash("b")).first(), { booking_id: "booking-1", fingerprint: hash("c") });
  await insert(db, "visits_public_submission_keys", submissionKeyRow({ key_hash: hash("9") }));
  await assert.rejects(insert(db, "visits_public_submission_keys", submissionKeyRow({ key_hash: "not-a-hash" })), check);
});

test("notifications check channel and kind pairs, leases and one summary per report date", async () => {
  const db = createTestDatabase();
  await seedBooking(db);
  const summary = (values: Record<string, unknown> = {}) => notificationRow({ id: "summary-1", channel: "discord", kind: "weekly-summary", booking_id: null, summary_date: "2026-11-02", payload_json: "{\"reportMs\":1}", ...values });
  await insert(db, "visits_notifications", summary());
  await assert.rejects(insert(db, "visits_notifications", summary({ id: "summary-2" })), unique);
  await insert(db, "visits_notifications", summary({ id: "summary-3", summary_date: "2026-11-09" }));
  const bad = [
    { channel: "sms" }, { kind: "weekly-summary" }, { channel: "discord", kind: "resend" }, { channel: "outreach", kind: "booked" }, { channel: "email", kind: "outreach-record" },
    { booking_id: null }, { summary_date: "2026-11-02" }, { status: "sending" }, { status: "pending", next_attempt_ms: null }, { lease_token: "x".repeat(20) },
    { status: "sending", lease_token: "x".repeat(20) }, { status: "lost" }, { payload_json: "nope" }, { attempts: -1 },
  ];
  for (const [index, values] of bad.entries()) await assert.rejects(insert(db, "visits_notifications", notificationRow({ id: `bad-${index}`, ...values })), check, JSON.stringify(values));
  await assert.rejects(insert(db, "visits_notifications", summary({ id: "bad-summary", summary_date: "2026-11-31" })), check);
  await insert(db, "visits_notifications", notificationRow({ id: "leased", status: "sending", next_attempt_ms: null, lease_token: "lease-token-0001", lease_expires_ms: windowStart }));
  for (const status of ["delivered", "failed", "paused", "skipped"]) await insert(db, "visits_notifications", notificationRow({ id: status, status, next_attempt_ms: null }));
});

test("one waiting Outreach record per booking; queueing again changes nothing", async () => {
  const db = createTestDatabase();
  await seedBooking(db);
  const queue = (id: string) => db.prepare("INSERT INTO visits_notifications(installation_id,id,channel,kind,booking_id,next_attempt_ms,created_at,updated_at) VALUES(?,?,'outreach','outreach-record',?,?,?,?) ON CONFLICT(installation_id,booking_id) WHERE channel='outreach' AND status='pending' DO NOTHING")
    .bind("primary", id, "booking-1", 0, "2026-10-02T00:00:00.000Z", "2026-10-02T00:00:00.000Z").run();
  assert.equal((await queue("outreach-1")).meta.changes, 1);
  assert.equal((await queue("outreach-2")).meta.changes, 0);
  // While the first is being sent, a later change may queue the next record.
  await db.prepare("UPDATE visits_notifications SET status='sending',next_attempt_ms=NULL,lease_token='lease-token-0001',lease_expires_ms=1 WHERE id='outreach-1'").run();
  assert.equal((await queue("outreach-3")).meta.changes, 1);
});

test("the Worker's lookups use the schema's indexes", () => {
  const db = createTestDatabase();
  assert.match(plan(db, "SELECT id FROM visits_windows WHERE installation_id=? AND status!='removed' AND start_ms<? AND end_ms>? ORDER BY start_ms", "primary", 2, 1), /visits_windows_start/);
  assert.match(plan(db, "SELECT id FROM visits_windows WHERE installation_id=? AND series_id=? AND start_ms>?", "primary", "s", 0), /visits_windows_series/);
  assert.match(plan(db, "SELECT id FROM visits_bookings WHERE installation_id=? AND window_id=? AND status='booked'", "primary", "w"), /visits_bookings_window/);
  assert.match(plan(db, "SELECT id FROM visits_bookings WHERE installation_id=? AND arrival_ms>=? AND arrival_ms<? ORDER BY arrival_ms", "primary", 0, 1), /visits_bookings_arrival/);
  assert.match(plan(db, "SELECT id FROM visits_bookings WHERE installation_id=? AND attention='needed' ORDER BY arrival_ms", "primary"), /visits_bookings_attention/);
  assert.match(plan(db, "UPDATE visits_bookings SET team_id='a' WHERE installation_id=? AND team_id=?", "primary", "b"), /visits_bookings_team/);
  assert.match(plan(db, "SELECT id FROM visits_notifications WHERE installation_id=? AND status='pending' AND next_attempt_ms<=? ORDER BY next_attempt_ms", "primary", 0), /visits_notifications_due/);
  assert.match(plan(db, "SELECT id FROM visits_notifications WHERE installation_id=? AND status='sending' AND lease_expires_ms<=?", "primary", 0), /visits_notifications_lease|visits_notifications_due/);
  assert.match(plan(db, "SELECT status FROM visits_notifications WHERE installation_id=? AND kind='weekly-summary' AND summary_date=?", "primary", "2026-11-02"), /visits_notifications_weekly_summary/);
  assert.match(plan(db, "SELECT id FROM visits_notifications WHERE installation_id=? AND booking_id=?", "primary", "b"), /visits_notifications_booking/);
  assert.match(plan(db, "SELECT id FROM visits_teams WHERE installation_id=? AND program=? AND number=? AND archived=0", "primary", "FRC", "321"), /visits_teams_number/);
  assert.match(plan(db, "DELETE FROM visits_public_submission_keys WHERE installation_id=? AND created_ms<?", "primary", 0), /visits_public_submission_keys_created/);
  assert.match(plan(db, "DELETE FROM visits_manage_tokens WHERE installation_id=? AND expires_ms<?", "primary", 0), /visits_manage_tokens_expiry/);
  assert.match(plan(db, "DELETE FROM visits_email_limits WHERE installation_id=? AND local_day<?", "primary", "2026-11-01"), /visits_email_limits_day/);
});

async function populate(db: TestDatabase) {
  await insert(db, "visits_settings", settingsRow());
  await insert(db, "visits_availability_series", seriesRow());
  await insert(db, "visits_windows", windowRow({ series_id: "series-1" }));
  await insert(db, "visits_teams", teamRow());
  await insert(db, "visits_bookings", bookingRow());
  await insert(db, "visits_booking_revisions", revisionRow());
  await insert(db, "visits_manage_tokens", tokenRow());
  await insert(db, "visits_public_submission_keys", submissionKeyRow());
  await insert(db, "visits_email_limits", { installation_id: "primary", address_hash: hash("d"), local_day: "2026-11-02", sent: 3 });
  await insert(db, "visits_notifications", notificationRow());
}

test("cleanup steps run child-first and leave no Guest Visits rows; the blocker holds while a send is leased", async () => {
  const db = createTestDatabase();
  db.exec("CREATE TABLE platform_module_setup_progress (installation_id TEXT NOT NULL, module_id TEXT NOT NULL, step_id TEXT NOT NULL)");
  db.exec("INSERT INTO platform_module_setup_progress VALUES ('primary','visits','email'),('primary','hour-tracking','rules')");
  await populate(db);
  const blocked = async () => Object.values((await db.prepare(`SELECT ${visitsCleanupBlockerSql} AS blocked`).bind("primary").first())!)[0];
  assert.equal(await blocked(), 0);
  await db.prepare("UPDATE visits_notifications SET status='sending',next_attempt_ms=NULL,lease_token='lease-token-0001',lease_expires_ms=? WHERE id='notification-1'").bind(Date.now() + 60_000).run();
  assert.equal(await blocked(), 1);
  await db.prepare("UPDATE visits_notifications SET lease_expires_ms=? WHERE id='notification-1'").bind(Date.now() - 60_000).run();
  assert.equal(await blocked(), 0, "an expired lease no longer blocks");
  // Out of order, a parent row still referenced by a child is refused.
  await assert.rejects(db.prepare("DELETE FROM visits_windows WHERE installation_id=?").bind("primary").run(), foreignKey);
  for (const step of visitsCleanupSteps) {
    if (step.kind !== "delete") continue;
    await db.prepare(`DELETE FROM ${step.table} WHERE installation_id=?${step.where ? ` AND ${step.where}` : ""}`).bind("primary", ...(step.bindings ?? [])).run();
  }
  for (const table of visitsTables) assert.equal(db.rows(`SELECT 1 FROM ${table}`).length, 0, table);
  assert.deepEqual(db.rows("SELECT module_id FROM platform_module_setup_progress"), [{ module_id: "hour-tracking" }]);
});

test("a backup round trip restores portable rows, pauses pending work and drops manage links", async () => {
  const source = createTestDatabase();
  await populate(source);
  await insert(source, "visits_notifications", notificationRow({ id: "leased", channel: "discord", status: "sending", next_attempt_ms: null, lease_token: "lease-token-0001", lease_expires_ms: windowStart }));
  await insert(source, "visits_notifications", notificationRow({ id: "sent", channel: "discord", status: "delivered", next_attempt_ms: null, external_id: "message-1" }));
  const exported = Object.fromEntries(Object.entries(visitsBackupColumns).map(([table, list]) => [table, source.rows(`SELECT ${list.join(",")} FROM ${table}`)]));
  assert.equal(pausedVisitsOperations(exported), 2);
  const restored = neutralizeVisitsBackup(exported);
  const target = createTestDatabase();
  await target.batch(Object.entries(restored).flatMap(([table, rows]) => rows.map((row) => insertStatement(target, table, row))));
  assert.deepEqual(target.rows("SELECT id,status,next_attempt_ms,lease_token,lease_expires_ms FROM visits_notifications ORDER BY id"), [
    { id: "leased", status: "paused", next_attempt_ms: null, lease_token: null, lease_expires_ms: null },
    { id: "notification-1", status: "paused", next_attempt_ms: null, lease_token: null, lease_expires_ms: null },
    { id: "sent", status: "delivered", next_attempt_ms: null, lease_token: null, lease_expires_ms: null },
  ]);
  for (const table of ["visits_manage_tokens", "visits_public_submission_keys", "visits_email_limits"]) assert.equal(target.rows(`SELECT 1 FROM ${table}`).length, 0, table);
  assert.equal(target.rows("SELECT 1 FROM visits_bookings").length, 1);
});
