// Worker contribution. Handlers receive Core's module context and the module-scoped database; plugins never see the Worker
// environment or Core credentials. This file only connects Core to the handlers in src/api: the civil-time helpers, the
// installation time zone, the clock and Core's email and Discord services become the handlers' `deps`, so the handlers
// themselves run in tests without Core. Storage handling comes from src/shared/visits-storage.ts.
import { instantToCivil, resolveCivilTime } from "@lancerlogin/module-sdk";
import {
  defineApiModule, filterAndSortReportRows, installationTimeZone, reportRow,
  type CoreModuleServices, type D1Database, type NormalizedReportDefinition, type ReportProjectionContext,
} from "@lancerlogin/module-sdk/api";
import { processVisitsNotifications } from "./api/visits-delivery.ts";
import { visitReportLabel, visitReportRecords, visitReportValues } from "./api/visits-reports.ts";
import { visitsAdminRoute, visitsPublicRoute, visitsSetupRoute } from "./api/visits-routes.ts";
import { installationId, type VisitsDeps, type VisitsRouteContext } from "./api/visits-runtime.ts";
import { visitsSetupPredicates, visitsSetupStepValid } from "./api/visits-settings.ts";
import { visitReportDatasetId } from "./shared/visits-report-fields.ts";
import type { CivilTime } from "./shared/visits-time.ts";
import {
  defaultSettingsSql, neutralizeVisitsBackup, pausedVisitsOperations, visitsBackupColumns, visitsCleanupBlockerSql, visitsCleanupSteps,
} from "./shared/visits-storage.ts";

const civil: CivilTime = { resolveCivilTime, instantToCivil };

function deps(db: D1Database, services: CoreModuleServices, dashboardOrigin: string | undefined): VisitsDeps {
  let timeZone: Promise<string> | undefined;
  return {
    civil, now: () => Date.now(), email: services.email, discord: services.discord, dashboardOrigin,
    timeZone: () => timeZone ??= installationTimeZone(db, installationId),
  };
}

type Context = VisitsRouteContext & { readonly services: CoreModuleServices; readonly dashboardOrigin: string | undefined };
const routeDeps = (context: Context) => deps(context.db, context.services, context.dashboardOrigin);

async function projectVisitBookings(db: D1Database, definition: NormalizedReportDefinition, context: ReportProjectionContext) {
  const records = await visitReportRecords(db, civil, await installationTimeZone(db, installationId), { from: context.from, to: context.to });
  return filterAndSortReportRows(definition, records.map((record) => reportRow(definition, record.id, visitReportLabel(record), visitReportValues(record), "/visits")));
}

const api = defineApiModule({
  moduleId: "visits",
  routes: {
    "/admin/visits": (context) => visitsAdminRoute(context, routeDeps(context)),
    "/public/visits": (context) => visitsPublicRoute(context, routeDeps(context)),
    "/module-setup/visits": (context) => visitsSetupRoute(context, routeDeps(context)),
  },
  // Manage responses include contact details, so public responses are never cached or indexed.
  privateResponseRoutes: ["/public/visits"],
  setup: { predicates: visitsSetupPredicates, stepValid: visitsSetupStepValid },
  // Manage links in queued emails point at the dashboard origin recorded when the email was queued.
  jobs: { "visits.notifications": ({ db, services }) => processVisitsNotifications(db, deps(db, services, undefined)) },
  reports: { [visitReportDatasetId]: projectVisitBookings },
  cleanup: { steps: visitsCleanupSteps, blocker: { sql: visitsCleanupBlockerSql, bindings: (installation) => [installation] } },
  // Discord off and the weekly summary on Monday 12:00, created once; settings kept through an earlier deletion stay.
  freshEnable: (db, { installationId: installation, now }) => [db.prepare(defaultSettingsSql).bind(installation, Date.parse(now), now)],
  backup: { version: 1, tables: visitsBackupColumns, neutralize: neutralizeVisitsBackup, pausedOperations: pausedVisitsOperations },
});

export default api;
