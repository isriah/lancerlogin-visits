// Worker contribution. Handlers receive Core's module context and the module-scoped database; plugins never see the
// Worker environment or Core credentials. A handler returns undefined for a request it does not handle, and these route
// families handle none yet: the guest page, manage page and staff workspace arrive with Core's email service,
// installation time zone and public sub-pages. Storage handling is complete and comes from src/shared/visits-storage.ts.
import { defineApiModule } from "@lancerlogin/module-sdk/api";
import {
  defaultSettingsSql, neutralizeVisitsBackup, pausedVisitsOperations, visitsBackupColumns, visitsCleanupBlockerSql, visitsCleanupSteps,
} from "./shared/visits-storage.ts";

const api = defineApiModule({
  moduleId: "visits",
  routes: {
    async "/admin/visits"() { return undefined; },
    async "/public/visits"() { return undefined; },
    async "/module-setup/visits"() { return undefined; },
  },
  // Manage responses will include contact details, so public responses are never cached or indexed.
  privateResponseRoutes: ["/public/visits"],
  // The manifest declares no setup steps yet, so there is nothing to validate.
  setup: { predicates: {}, stepValid: async () => true },
  cleanup: { steps: visitsCleanupSteps, blocker: { sql: visitsCleanupBlockerSql, bindings: (installationId) => [installationId] } },
  // Discord off and the weekly summary on Monday 12:00, created once; settings kept through an earlier deletion stay.
  freshEnable: (db, { installationId, now }) => [db.prepare(defaultSettingsSql).bind(installationId, Date.parse(now), now)],
  backup: { version: 1, tables: visitsBackupColumns, neutralize: neutralizeVisitsBackup, pausedOperations: pausedVisitsOperations },
});

export default api;
