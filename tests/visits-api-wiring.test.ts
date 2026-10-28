// The Worker contribution as Core loads it: src/api.ts with the module SDK replaced by a stand-in. It checks that every
// declaration has exactly one handler and that the handlers reach the database, services and time zone through Core's
// context.
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createTestDatabase } from "./helpers/d1.ts";
import { dashboardOrigin, FakeDiscord, FakeEmail, shopSeries } from "./helpers/visits-harness.ts";
import manifest from "../src/manifest.ts";
import { visitsBackupColumns, visitsCleanupSteps } from "../src/shared/visits-storage.ts";

const stub = new URL("./helpers/module-sdk-stub.ts", import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => specifier === "@lancerlogin/module-sdk" || specifier === "@lancerlogin/module-sdk/api" ? { url: stub, shortCircuit: true } : next(specifier, context) });
const { default: api } = await import("../src/api.ts");

function database() {
  const db = createTestDatabase();
  db.exec("CREATE TABLE organization_settings (installation_id TEXT PRIMARY KEY, time_zone TEXT NOT NULL); INSERT INTO organization_settings VALUES ('primary', 'America/New_York');");
  return db;
}

type Modules = { interface(id: string, version: number): Promise<unknown> };

function context(db: ReturnType<typeof database>, method: string, path: string, body?: unknown, modules?: Modules) {
  const url = new URL(path, "https://api.example.org");
  const request = new Request(url, { method, headers: { origin: dashboardOrigin, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return {
    request, url, env: {}, db: db as never, services: { email: new FakeEmail(), discord: new FakeDiscord(), googleCalendar: {} as never, credentials: {} as never, ...(modules ? { modules } : {}) },
    requireRole: async () => ({ userId: "user-1", role: "admin" as const }),
    json: async () => JSON.parse(await request.clone().text()), body: async () => method === "GET" ? undefined : JSON.parse(await request.text()),
    respond: (value: unknown, status = 200) => Response.json(value, { status }),
    requireDashboardOrigin: () => undefined, dashboardOrigin,
  };
}

test("the contribution binds exactly the declared routes, setup steps, job, report and storage", () => {
  assert.equal(api.moduleId, manifest.id);
  assert.deepEqual(Object.keys(api.routes!).sort(), manifest.apiRoutes.map((route) => route.path).sort());
  assert.deepEqual(api.privateResponseRoutes, ["/public/visits"]);
  assert.deepEqual(Object.keys(api.setup.predicates), manifest.setup.steps.map((step) => step.id));
  assert.deepEqual(Object.keys(api.jobs!), manifest.jobs.map((job) => job.id));
  assert.deepEqual(Object.keys(api.reports!), manifest.reportDatasets.map((dataset) => dataset.id));
  assert.deepEqual(api.setup.predicates.email!("primary"), { sql: "EXISTS(SELECT 1 FROM visits_settings WHERE installation_id=? AND test_email_sent_at IS NOT NULL)", bindings: ["primary"] });
  assert.equal(api.cleanup.steps, visitsCleanupSteps);
  assert.equal(api.backup!.tables, visitsBackupColumns);
  assert.deepEqual(Object.keys(api.backup!.tables), [...manifest.backup.tables]);
});

test("routes, the job and the report run through Core's context with the installation time zone", async () => {
  const db = database();
  await db.batch(api.freshEnable!(db as never, { installationId: "primary", now: "2026-10-28T15:00:00.000Z" }) as never);
  const created = await api.routes!["/admin/visits"]!(context(db, "POST", "/admin/visits/series", { ...shopSeries, firstDate: "2027-11-01", lastDate: "2027-11-30" }) as never);
  assert.equal(created!.status, 201);
  const calendar = await api.routes!["/public/visits"]!(context(db, "GET", "/public/visits/calendar") as never);
  assert.equal(calendar!.status, 200);
  assert.equal(((await calendar!.json()) as { timeZone: string }).timeZone, "America/New_York");
  assert.equal(await api.routes!["/public/visits"]!(context(db, "GET", "/public/visits/elsewhere") as never), undefined);
  assert.equal((await api.routes!["/module-setup/visits"]!(context(db, "GET", "/module-setup/visits/status") as never))!.status, 200);
  const pass = await api.jobs!["visits.notifications"]!({ db: db as never, env: {}, services: context(db, "GET", "/").services as never }) as { summary: string };
  assert.equal(pass.summary, "off");
  db.exec(`INSERT INTO visits_teams(installation_id,id,number,name,program,created_at,updated_at) VALUES('primary','team-1','321','Lancers','FRC','x','x');
    INSERT INTO visits_bookings(installation_id,id,window_id,team_id,contact_name,contact_email,arrival_ms,departure_ms,headcount,created_at,updated_at)
    SELECT 'primary','booking-1',id,'team-1','Pat','pat@example.org',start_ms,start_ms+3600000,4,'x','x' FROM visits_windows ORDER BY start_ms LIMIT 1;`);
  const definition = { columns: [{ key: "visits.booking.date" }, { key: "visits.booking.team-name" }, { key: "visits.booking.duration" }], sort: { column: { key: "visits.booking.date" }, direction: "desc" } };
  const rows = await api.reports!["visits.bookings"]!(db as never, definition as never, { to: "2027-12-31", today: "2026-10-28" });
  assert.deepEqual(rows.map((row) => [row.id, row.label, row.href, Object.values(row.cells).map((cell) => cell.text)]), [["booking-1", "FRC 321 Lancers on 2027-11-01", "/visits", ["2027-11-01", "Lancers", "60"]]]);
  assert.deepEqual(await api.reports!["visits.bookings"]!(db as never, definition as never, { from: "2027-11-02", to: "2027-12-31", today: "2026-10-28" }), []);
});

test("Outreach is reached through services.modules with the declared interface; without a signed-in user only a grant counts", async () => {
  const db = database();
  await db.batch(api.freshEnable!(db as never, { installationId: "primary", now: "2026-10-28T15:00:00.000Z" }) as never);
  const asked: unknown[][] = [];
  let available: "client" | "none" | "throws" = "client";
  const modules: Modules = {
    async interface(id, version) {
      asked.push([id, version]);
      if (available === "throws") throw new Error("Core could not read module state");
      return available === "client" ? { call: async () => ({ teams: [] }) } : undefined;
    },
  };
  const status = async () => (await (await api.routes!["/admin/visits"]!(context(db, "GET", "/admin/visits/status", undefined, modules) as never))!.json() as { outreach: unknown }).outreach;
  const job = () => api.jobs!["visits.notifications"]!({ db: db as never, env: {}, services: context(db, "GET", "/", undefined, modules).services as never }) as Promise<{ outreachGranted: boolean }>;
  // A workspace request's client may be the signed-in Admin's own Outreach access, so it alone is no grant.
  assert.deepEqual(await status(), { available: true, granted: false });
  assert.equal((await job()).outreachGranted, true);
  assert.deepEqual(await status(), { available: true, granted: true });
  assert.ok(asked.every(([id, version]) => id === "hour-tracking.team-support" && version === 1));
  available = "throws";
  assert.equal((await job()).outreachGranted, false, "a failed lookup is no client");
  available = "none";
  assert.deepEqual(await status(), { available: false, granted: false });
  // Without services.modules (an older Core), Outreach is simply unavailable.
  assert.deepEqual((await (await api.routes!["/admin/visits"]!(context(db, "GET", "/admin/visits/status") as never))!.json() as { outreach: unknown }).outreach, { available: false, granted: false });
});
