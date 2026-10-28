// The three route families and their authorization. Public routes need no sign-in, but every POST must come from the
// dashboard origin (so a page elsewhere cannot book or change visits, and an email scanner that opens a link changes
// nothing). Workspace routes are for Admins and Operators assigned Guest Visits; settings and setup routes are Admin only.
// Every dashboard state change requires the dashboard origin. Paths and shapes come from src/shared/visits-api.ts.
import { publicVisitsRoutes, setupVisitsRoutes } from "../shared/visits-api.ts";
import { cancelWindow, createSeries, createWindow, listSeries, removeSeries, removeWindow, restoreWindow, staffOverview, updateSeries, updateWindow } from "./visits-availability.ts";
import {
  bookVisit, listTeams, lookupTeam, manageCancel, manageShow, manageUpdate, mergeTeam, publicCalendar, recordOutreach, staffCancel, staffEdit, staffHandled, staffRemove,
  staffRestore, staffResend, updateTeam,
} from "./visits-bookings.ts";
import { listStaffBookings, staffBookingDetail, type BookingScope } from "./visits-queries.ts";
import { readSettings, sendTestEmail, setupStatus, updateSettings, visitsSettings, visitsStatus } from "./visits-settings.ts";
import { ok, pathId, readBody, respondTo, revisionOf, VisitsError, type RouteResult, type VisitsDeps, type VisitsRole, type VisitsRouteContext } from "./visits-runtime.ts";

type Input = { readonly userId: string; readonly body: unknown; readonly url: URL; readonly origin: string | undefined };
type Action = (input: Input) => Promise<RouteResult>;
type Route = { readonly roles: readonly VisitsRole[]; readonly methods: Readonly<Partial<Record<string, Action>>> };

const staff: readonly VisitsRole[] = ["admin", "operator"];
const admin: readonly VisitsRole[] = ["admin"];

/** The origin manage links point at: the dashboard. */
function linkOrigin(context: VisitsRouteContext, deps: VisitsDeps): string | undefined {
  return deps.dashboardOrigin ?? context.request.headers.get("origin") ?? undefined;
}

function methodNotAllowed(route: Route): VisitsError {
  return new VisitsError(405, `Use ${Object.keys(route.methods).join(" or ")} for this Guest Visits route`);
}

async function run(context: VisitsRouteContext, deps: VisitsDeps, route: Route | undefined, origin: (input: { method: string }) => void): Promise<Response | undefined> {
  if (!route) return undefined;
  return respondTo(context, async () => {
    const principal = route.roles.length ? await context.requireRole(route.roles) : null;
    const action = route.methods[context.request.method];
    if (!action) throw methodNotAllowed(route);
    origin({ method: context.request.method });
    const body = await readBody(context);
    return action({ userId: principal?.userId ?? "", body, url: context.url, origin: linkOrigin(context, deps) });
  });
}

// Public routes.

function publicRoute(db: VisitsRouteContext["db"], deps: VisitsDeps, path: string): Route | undefined {
  const none: readonly VisitsRole[] = [];
  switch (path) {
    case publicVisitsRoutes.calendar: return { roles: none, methods: { GET: async () => ok(await publicCalendar(db, deps)) } };
    case publicVisitsRoutes.team: return { roles: none, methods: { GET: async ({ url }) => ok(await lookupTeam(db, url)) } };
    case publicVisitsRoutes.bookings: return { roles: none, methods: { POST: ({ body, origin }) => bookVisit(db, deps, body, origin) } };
    case publicVisitsRoutes.manage: return { roles: none, methods: { POST: ({ body }) => manageShow(db, deps, body) } };
    case publicVisitsRoutes.manageUpdate: return { roles: none, methods: { POST: ({ body, origin }) => manageUpdate(db, deps, body, origin) } };
    case publicVisitsRoutes.manageCancel: return { roles: none, methods: { POST: ({ body, origin }) => manageCancel(db, deps, body, origin) } };
    default: return undefined;
  }
}

/**
 * `/public/visits/*`. A POST must carry the dashboard origin, the way Outreach's public form checks it, and its input
 * travels only in the body. Manage-link tokens arrive in the body too, so opening a link never changes anything.
 */
export function visitsPublicRoute(context: VisitsRouteContext, deps: VisitsDeps): Promise<Response | undefined> {
  return run(context, deps, publicRoute(context.db, deps, context.url.pathname), ({ method }) => {
    if (method === "GET") return;
    const allowed = deps.dashboardOrigin ?? context.url.origin;
    if (context.request.headers.get("origin") !== allowed) throw new VisitsError(403, "Use the guest visit page to book or change a visit");
    if (context.url.search) throw new VisitsError(400, "Send the request in its body only");
  });
}

// Workspace routes.

const bookingScopes: readonly BookingScope[] = ["upcoming", "past", "attention"];

function adminRoute(db: VisitsRouteContext["db"], deps: VisitsDeps, path: string): Route | undefined {
  if (!path.startsWith("/admin/visits/")) return undefined;
  const segments = path.slice("/admin/visits/".length).split("/");
  const [first, second, third, extra] = segments;
  if (extra !== undefined) return undefined;
  const timeZone = () => deps.timeZone();
  if (second === undefined) {
    switch (first) {
      case "overview": return { roles: staff, methods: { GET: async ({ url }) => ok(await staffOverview(db, deps, url)) } };
      case "series": return { roles: staff, methods: { GET: async () => ok(await listSeries(db)), POST: ({ body }) => createSeries(db, deps, body) } };
      case "windows": return { roles: staff, methods: { POST: ({ body }) => createWindow(db, deps, body) } };
      case "bookings": return {
        roles: staff, methods: {
          GET: async ({ url }) => {
            const scope = (url.searchParams.get("scope") ?? "upcoming") as BookingScope;
            if (!bookingScopes.includes(scope)) throw new VisitsError(400, "Choose upcoming, past or attention", "scope");
            return ok(await listStaffBookings(db, deps.civil, await timeZone(), scope, deps.now()));
          },
        },
      };
      case "outreach": return { roles: staff, methods: { POST: ({ body }) => recordOutreach(db, deps, body) } };
      case "teams": return { roles: staff, methods: { GET: async () => ok(await listTeams(db)) } };
      case "status": return { roles: staff, methods: { GET: async () => ok(await visitsStatus(db, deps)) } };
      case "settings": return { roles: admin, methods: { GET: async () => ok(visitsSettings(await readSettings(db, deps.now()))), PUT: ({ body }) => updateSettings(db, deps, body) } };
      default: return undefined;
    }
  }
  if (first === "settings") return second === "test-email" && third === undefined ? { roles: admin, methods: { POST: ({ body }) => sendTestEmail(db, deps, body) } } : undefined;
  const id = pathId(second);
  switch (`${first}/${third ?? ""}`) {
    case "series/": return { roles: staff, methods: { PUT: ({ body }) => updateSeries(db, deps, id, body), DELETE: ({ url }) => removeSeries(db, deps, id, revisionOf(url.searchParams.get("revision"))) } };
    case "windows/": return { roles: staff, methods: { PUT: ({ body }) => updateWindow(db, deps, id, body), DELETE: ({ url }) => removeWindow(db, deps, id, revisionOf(url.searchParams.get("revision"))) } };
    case "windows/cancel": return { roles: staff, methods: { POST: ({ body }) => cancelWindow(db, deps, id, body) } };
    case "windows/restore": return { roles: staff, methods: { POST: ({ body }) => restoreWindow(db, deps, id, body) } };
    case "bookings/": return {
      roles: staff, methods: {
        GET: async () => ok(await staffBookingDetail(db, deps.civil, await timeZone(), id)),
        PUT: ({ userId, body, origin }) => staffEdit(db, deps, id, userId, body, origin),
        DELETE: ({ userId, url }) => staffRemove(db, deps, id, userId, revisionOf(url.searchParams.get("revision"))),
      },
    };
    case "bookings/cancel": return { roles: staff, methods: { POST: ({ userId, body, origin }) => staffCancel(db, deps, id, userId, body, origin) } };
    case "bookings/restore": return { roles: staff, methods: { POST: ({ userId, body, origin }) => staffRestore(db, deps, id, userId, body, origin) } };
    case "bookings/resend": return { roles: staff, methods: { POST: ({ origin }) => staffResend(db, deps, id, origin) } };
    case "bookings/handled": return { roles: staff, methods: { POST: () => staffHandled(db, deps, id) } };
    case "teams/": return { roles: staff, methods: { PUT: ({ body }) => updateTeam(db, deps, id, body) } };
    case "teams/merge": return { roles: staff, methods: { POST: ({ userId, body }) => mergeTeam(db, deps, id, userId, body) } };
    default: return undefined;
  }
}

/** `/admin/visits/*`: the staff workspace and Admin settings. */
export function visitsAdminRoute(context: VisitsRouteContext, deps: VisitsDeps): Promise<Response | undefined> {
  let route: Route | undefined;
  try { route = adminRoute(context.db, deps, context.url.pathname); } catch (error) {
    if (error instanceof VisitsError) return respondTo(context, async () => { throw error; });
    throw error;
  }
  return run(context, deps, route, ({ method }) => { if (method !== "GET") context.requireDashboardOrigin("Guest Visits changes must come from the dashboard"); });
}

// Setup routes.

function setupRoute(db: VisitsRouteContext["db"], deps: VisitsDeps, path: string): Route | undefined {
  switch (path) {
    case setupVisitsRoutes.status: return { roles: admin, methods: { GET: async () => ok(await setupStatus(db, deps)) } };
    case setupVisitsRoutes.testEmail: return { roles: admin, methods: { POST: ({ body }) => sendTestEmail(db, deps, body) } };
    case setupVisitsRoutes.series: return { roles: admin, methods: { POST: ({ body }) => createSeries(db, deps, body) } };
    case setupVisitsRoutes.windows: return { roles: admin, methods: { POST: ({ body }) => createWindow(db, deps, body) } };
    default: return undefined;
  }
}

/** `/module-setup/visits/*`: Admin only, before the workspace is ready. */
export function visitsSetupRoute(context: VisitsRouteContext, deps: VisitsDeps): Promise<Response | undefined> {
  return run(context, deps, setupRoute(context.db, deps, context.url.pathname), ({ method }) => { if (method !== "GET") context.requireDashboardOrigin("Guest Visits setup changes must come from the dashboard"); });
}
