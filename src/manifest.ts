// Guest Visits module definition. Core validates it before composing the plugin: the ID, contract and table prefix must
// match package.json, every table must start with the prefix, every API route lives under /admin, /public or
// /module-setup followed by the module ID, and every table is either backed up or declared non-portable.
// It imports only the plugin's own import-free shared files, so the plugin's unit tests can read it without a Core checkout;
// tests/plugin-package.test.ts checks that its storage declarations equal src/shared/visits-storage.ts and the migration.
import { outreachUse } from "./shared/visits-outreach.ts";
import { visitReportDataset } from "./shared/visits-report-fields.ts";

const manifest = {
  id: "visits",
  label: "Guest Visits",
  description: "Guest team visit availability, booking, confirmations and weekly summaries.",
  contractVersion: 1,
  available: true,
  dependencies: [],
  // Optional: once an Admin grants access in Settings > Modules, booked visits are recorded as Outreach Team support.
  uses: [outreachUse],
  // Operators may use the workspace once an Administrator assigns Guest Visits to them.
  capabilities: [{ id: "visits.manage", label: "Manage Guest Visits", operator: true }],
  navigation: [{ label: "Guest Visits", path: "/visits" }],
  settings: [{ label: "Guest Visits", path: "/settings/visits" }],
  // Both steps need persisted proof: a successful test email recorded in visits_settings, and an availability window.
  setup: {
    version: 1,
    steps: [
      { id: "email", label: "Email confirmations", required: true },
      { id: "availability", label: "First availability window", required: true },
    ],
  },
  // Sends queued confirmation and update emails and Discord messages, retries failures and posts the weekly summary.
  jobs: [{ id: "visits.notifications", interval: 300_000, label: "Guest visit notifications" }],
  discordCommands: [],
  reportDatasets: [visitReportDataset],
  apiRoutes: [
    { path: "/admin/visits", match: "prefix", access: "workspace" },
    { path: "/public/visits", match: "prefix", access: "service" },
    { path: "/module-setup/visits", match: "prefix", access: "setup" },
  ],
  tablePrefix: "visits_",
  persistence: {
    tables: [
      "visits_settings", "visits_availability_series", "visits_windows", "visits_teams", "visits_bookings", "visits_booking_revisions",
      "visits_manage_tokens", "visits_public_submission_keys", "visits_email_limits", "visits_notifications",
      "visits_first_credentials", "visits_first_seasons", "visits_first_teams", "visits_first_requests",
    ],
    sharedFields: [],
    transientAuthority: [
      { table: "visits_notifications", columns: ["status", "next_attempt_ms", "lease_token", "lease_expires_ms"] },
      { table: "visits_settings", columns: ["outreach_granted", "outreach_checked_ms"] },
    ],
  },
  backup: {
    // 2: the Require headcount setting and optional headcounts (migration 0003). Version 1 backups are converted on restore.
    version: 2,
    tables: ["visits_settings", "visits_availability_series", "visits_windows", "visits_teams", "visits_bookings", "visits_booking_revisions", "visits_notifications"],
    // A restore drops every manage link, guest submission key and daily email count. Staff resend confirmations afterwards.
    // FIRST API credentials and lookup caches are never in a backup either; an Admin saves the credentials again.
    nonPortableTables: [
      "visits_manage_tokens", "visits_public_submission_keys", "visits_email_limits",
      "visits_first_credentials", "visits_first_seasons", "visits_first_teams", "visits_first_requests",
    ],
  },
  lifecycle: {
    cleanupTargets: [
      "visits_notifications", "visits_manage_tokens", "visits_public_submission_keys", "visits_email_limits", "visits_booking_revisions",
      "visits_bookings", "visits_teams", "visits_windows", "visits_availability_series", "visits_settings",
      "platform_module_setup_progress:visits", "platform_module_assignments:visits",
      "visits_first_credentials", "visits_first_seasons", "visits_first_teams", "visits_first_requests",
    ],
  },
  deletedData: [
    "Guest visit availability: repeating and one-off windows",
    "Guest teams, visits, contact details, team needs and change history",
    "Guest Visits settings, queued emails, Discord messages and Outreach work, manage links and email counts",
    "Guest Visits setup and assignment records",
    "FIRST API usernames and tokens for team lookup, and cached FIRST team answers",
  ],
} as const;

export default manifest;
