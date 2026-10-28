// Guest Visits module definition. Core validates it before composing the plugin: the ID, contract and table prefix must
// match package.json, every table must start with the prefix, every API route lives under /admin, /public or
// /module-setup followed by the module ID, and every table is either backed up or declared non-portable.
// It imports nothing, so the plugin's own unit tests can read it without a Core checkout; tests/plugin-package.test.ts
// checks that its storage declarations equal src/shared/visits-storage.ts and the migration.
const manifest = {
  id: "visits",
  label: "Guest Visits",
  description: "Guest team visit availability, booking, confirmations and weekly summaries.",
  contractVersion: 1,
  available: true,
  dependencies: [],
  // Operators may use the workspace once an Administrator assigns Guest Visits to them.
  capabilities: [{ id: "visits.manage", label: "Manage Guest Visits", operator: true }],
  navigation: [{ label: "Guest Visits", path: "/visits" }],
  settings: [{ label: "Guest Visits", path: "/settings/visits" }],
  setup: { version: 1, steps: [] },
  jobs: [],
  discordCommands: [],
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
    ],
    sharedFields: [],
    transientAuthority: [{ table: "visits_notifications", columns: ["status", "next_attempt_ms", "lease_token", "lease_expires_ms"] }],
  },
  backup: {
    version: 1,
    tables: ["visits_settings", "visits_availability_series", "visits_windows", "visits_teams", "visits_bookings", "visits_booking_revisions", "visits_notifications"],
    // A restore drops every manage link, guest submission key and daily email count. Staff resend confirmations afterwards.
    nonPortableTables: ["visits_manage_tokens", "visits_public_submission_keys", "visits_email_limits"],
  },
  lifecycle: {
    cleanupTargets: [
      "visits_notifications", "visits_manage_tokens", "visits_public_submission_keys", "visits_email_limits", "visits_booking_revisions",
      "visits_bookings", "visits_teams", "visits_windows", "visits_availability_series", "visits_settings",
      "platform_module_setup_progress:visits", "platform_module_assignments:visits",
    ],
  },
  deletedData: [
    "Guest visit availability: repeating and one-off windows",
    "Guest teams, visits, contact details, notes and change history",
    "Guest Visits settings, queued emails and Discord messages, manage links and email counts",
    "Guest Visits setup and assignment records",
  ],
} as const;

export default manifest;
