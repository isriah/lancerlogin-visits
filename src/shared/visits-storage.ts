// Storage declarations for the tables in migrations/: which tables are portable, their backup columns, retained-data
// cleanup and restore handling. The manifest and Worker contribution declare exactly these, and the SQL tests check them
// against the migrations.

/** LancerLogin installations store their rows under one installation ID. */
export const installationId = "primary";
export const moduleId = "visits";

/**
 * The backup format version. 2 (migration 0003): visits_settings has headcount_required, and a visit's headcount may be
 * null. `normalizeVisitsBackup` reads version 1.
 */
export const visitsBackupVersion = 2;

/** Portable tables in parent-first restore order with every column, as backups export them, in the tables' column order. */
export const visitsBackupColumns = {
  visits_settings: ["installation_id", "host_name", "intro_text", "reply_to", "test_email_sent_at", "discord_enabled", "discord_channel_id", "weekly_summary_enabled", "weekly_summary_weekday", "weekly_summary_time", "weekly_summary_since_ms", "outreach_granted", "outreach_checked_ms", "revision", "updated_at", "headcount_required"],
  visits_availability_series: ["installation_id", "id", "weekday_mask", "start_time", "end_time", "first_date", "last_date", "title", "revision", "created_at", "updated_at"],
  visits_windows: ["installation_id", "id", "series_id", "start_ms", "end_ms", "title", "status", "cancel_reason", "edited", "revision", "created_at", "updated_at"],
  visits_teams: ["installation_id", "id", "number", "name", "program", "outreach_team_id", "archived", "revision", "created_at", "updated_at"],
  visits_bookings: ["installation_id", "id", "window_id", "team_id", "contact_name", "contact_email", "contact_phone", "arrival_ms", "departure_ms", "note", "status", "removed", "attention", "attention_reason", "outreach_activity_id", "revision", "created_at", "updated_at", "headcount"],
  visits_booking_revisions: ["installation_id", "booking_id", "revision", "action", "actor_kind", "staff_user_id", "change_json", "snapshot_json", "created_at"],
  visits_notifications: ["installation_id", "id", "channel", "kind", "booking_id", "summary_date", "payload_json", "status", "attempts", "next_attempt_ms", "lease_token", "lease_expires_ms", "external_id", "last_error", "created_at", "updated_at"],
} as const satisfies Record<string, readonly string[]>;
export type VisitsPortableTable = keyof typeof visitsBackupColumns;
export const visitsPortableTables = Object.keys(visitsBackupColumns) as VisitsPortableTable[];

/**
 * Operational state a restore drops: every manage link (staff resend confirmations afterwards), guest submission keys,
 * the daily email counts, the FIRST API credentials (an Admin saves them again) and FIRST lookup caches and limits.
 */
export const visitsNonPortableTables = [
  "visits_manage_tokens", "visits_public_submission_keys", "visits_email_limits",
  "visits_first_credentials", "visits_first_seasons", "visits_first_teams", "visits_first_requests",
] as const;

/** Every table, in the order the migrations create them. */
export const visitsTables = [
  "visits_settings", "visits_availability_series", "visits_windows", "visits_teams", "visits_bookings", "visits_booking_revisions",
  "visits_manage_tokens", "visits_public_submission_keys", "visits_email_limits", "visits_notifications",
  "visits_first_credentials", "visits_first_seasons", "visits_first_teams", "visits_first_requests",
] as const;

/**
 * Columns a restore must neutralize: delivery state and leases, so pending work never revives on its own, and the copy of
 * the Outreach grant, since Core never restores grants.
 */
export const visitsTransientAuthority = [
  { table: "visits_notifications", columns: ["status", "next_attempt_ms", "lease_token", "lease_expires_ms"] },
  { table: "visits_settings", columns: ["outreach_granted", "outreach_checked_ms"] },
] as const;

/** The SDK's cleanup step shape. */
export type VisitsCleanupStep =
  | { readonly kind: "delete"; readonly table: string; readonly where?: string; readonly bindings?: readonly unknown[] }
  | { readonly kind: "assignments" };

/**
 * Retained-data cleanup, child-first. Core stores progress by position: never reorder these steps, only append.
 */
export const visitsCleanupSteps: readonly VisitsCleanupStep[] = [
  { kind: "delete", table: "visits_notifications" },
  { kind: "delete", table: "visits_manage_tokens" },
  { kind: "delete", table: "visits_public_submission_keys" },
  { kind: "delete", table: "visits_email_limits" },
  { kind: "delete", table: "visits_booking_revisions" },
  { kind: "delete", table: "visits_bookings" },
  { kind: "delete", table: "visits_teams" },
  { kind: "delete", table: "visits_windows" },
  { kind: "delete", table: "visits_availability_series" },
  { kind: "delete", table: "visits_settings" },
  { kind: "delete", table: "platform_module_setup_progress", where: "module_id=?", bindings: [moduleId] },
  { kind: "assignments" },
  // Appended for team lookup (migration 0002), after the original steps.
  { kind: "delete", table: "visits_first_credentials" },
  { kind: "delete", table: "visits_first_seasons" },
  { kind: "delete", table: "visits_first_teams" },
  { kind: "delete", table: "visits_first_requests" },
];

/** The manifest's cleanup targets for the steps above. */
export const visitsCleanupTargets = [
  "visits_notifications", "visits_manage_tokens", "visits_public_submission_keys", "visits_email_limits", "visits_booking_revisions",
  "visits_bookings", "visits_teams", "visits_windows", "visits_availability_series", "visits_settings",
  `platform_module_setup_progress:${moduleId}`, `platform_module_assignments:${moduleId}`,
  "visits_first_credentials", "visits_first_seasons", "visits_first_teams", "visits_first_requests",
] as const;

/** Cleanup waits while a notification is mid-send under a live lease. Binds the installation ID once. */
export const visitsCleanupBlockerSql = "EXISTS(SELECT 1 FROM visits_notifications WHERE installation_id=? AND status='sending' AND lease_expires_ms>(julianday('now')-2440587.5)*86400000)";

/**
 * The default settings row created on first enablement: Discord off, weekly summary Monday 12:00, no Outreach grant seen
 * yet (the column defaults). Binds installation ID, now as epoch milliseconds and now as ISO text. Existing settings are
 * kept.
 */
export const defaultSettingsSql = "INSERT OR IGNORE INTO visits_settings(installation_id,weekly_summary_since_ms,updated_at) VALUES(?,?,?)";

type Row = Readonly<Record<string, unknown>>;
type Tables = Readonly<Record<string, readonly Row[]>>;

const pausable = (row: Row) => row.status === "pending" || row.status === "sending";

/**
 * Restore handling: queued and in-flight notifications come back paused with no lease, so nothing is sent until staff
 * review it, and settings forget the Outreach grant until the job sees a new one. Other rows are unchanged.
 */
export function neutralizeVisitsBackup(tables: Tables): Tables {
  const notifications = tables.visits_notifications ?? [];
  return {
    ...tables,
    visits_settings: (tables.visits_settings ?? []).map((row) => ({ ...row, outreach_granted: 0, outreach_checked_ms: null })),
    visits_notifications: notifications.map((row) => pausable(row) ? { ...row, status: "paused", next_attempt_ms: null, lease_token: null, lease_expires_ms: null } : row),
  };
}

/**
 * Convert an older backup to the current version. Version 1 predates the Require headcount setting, which it restores as
 * off; its visits all have a headcount, which stays. Other rows are unchanged.
 */
export function normalizeVisitsBackup(tables: Tables, fromVersion: number): Tables {
  if (fromVersion !== 1) throw new RangeError(`Guest Visits cannot read backup version ${fromVersion}`);
  return { ...tables, visits_settings: (tables.visits_settings ?? []).map((row) => ({ ...row, headcount_required: 0 })) };
}

/** How many notifications `neutralizeVisitsBackup` pauses. */
export function pausedVisitsOperations(tables: Tables): number {
  return (tables.visits_notifications ?? []).filter(pausable).length;
}
