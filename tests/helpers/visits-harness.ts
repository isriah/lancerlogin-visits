// Runs the Guest Visits Worker handlers the way Core does, without Core: an in-memory database with the plugin's
// migration, Core's request context reduced to what the handlers use, a controlled clock, synthetic email and Discord
// services that behave like Resend's idempotency keys and Discord's enforced nonces, and a synthetic Outreach behind
// Core's cross-module calls, with an Admin's grant and staff members' own Outreach access. Synthetic data only.
import { createTestDatabase, type TestDatabase } from "./d1.ts";
import { civil, newYork } from "./civil-time.ts";
import { processVisitsNotifications } from "../../src/api/visits-delivery.ts";
import { visitsAdminRoute, visitsPublicRoute, visitsSetupRoute } from "../../src/api/visits-routes.ts";
import type { VisitsDeps, VisitsOutreachClient, VisitsRole } from "../../src/api/visits-runtime.ts";
import { defaultSettingsSql } from "../../src/shared/visits-storage.ts";

export const dashboardOrigin = "https://visits.example.org";
export const apiOrigin = "https://api.example.org";

/** Core's HttpError as the handlers see it: a status and a message. */
export class CoreError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

type EmailMessage = { to: string; subject: string; html?: string; text?: string; replyTo?: string; idempotencyKey: string };

/** Resend as the email service sees it. A key Resend already accepted with other content is refused with 409. */
export class FakeEmail {
  readyValue = true;
  readonly sent: EmailMessage[] = [];
  readonly attempts: EmailMessage[] = [];
  /** The next sends fail: with a Resend status, or a network error. `afterAccept` loses the response of an email Resend sent. */
  readonly failures: { status?: number; message?: string; afterAccept?: boolean }[] = [];
  readonly accepted = new Map<string, { id: string; body: string }>();
  async ready() { return this.readyValue; }
  async send(message: EmailMessage) {
    this.attempts.push(message);
    const failure = this.failures.shift();
    if (failure?.afterAccept) {
      this.accepted.set(message.idempotencyKey, { id: `email-${this.accepted.size + 1}`, body: JSON.stringify([message.to, message.subject, message.html, message.text, message.replyTo]) });
      this.sent.push(message);
      throw new Error("The connection closed before Resend answered");
    }
    if (failure) throw Object.assign(new Error(failure.message ?? `Resend rejected the email (${failure.status ?? "network"})`), { emailStatus: failure.status });
    const body = JSON.stringify([message.to, message.subject, message.html, message.text, message.replyTo]);
    const earlier = this.accepted.get(message.idempotencyKey);
    if (earlier) {
      if (earlier.body !== body) throw Object.assign(new Error("Resend rejected the email (409): invalid_idempotent_request"), { emailStatus: 409 });
      return { id: earlier.id };
    }
    const id = `email-${this.accepted.size + 1}`;
    this.accepted.set(message.idempotencyKey, { id, body });
    this.sent.push(message);
    return { id };
  }
  providerStatus(error: unknown) { return (error as { emailStatus?: number }).emailStatus; }
  /** The manage-link token in an email. */
  static token(message: EmailMessage): string {
    const match = /\/visit\/manage#([A-Za-z0-9_-]{43})/.exec(message.text ?? "");
    if (!match) throw new Error("The email has no manage link");
    return match[1]!;
  }
}

type DiscordPost = { path: string; body: { content: string; nonce: string; enforce_nonce: boolean; allowed_mentions: { parse: string[] }; flags: number } };

/** Discord as the bot client sees it. A repeated nonce returns the earlier message instead of posting again. */
export class FakeDiscord {
  readyValue = true;
  readonly posts: DiscordPost[] = [];
  readonly failures: { status?: number }[] = [];
  readonly byNonce = new Map<string, string>();
  async ready() { return this.readyValue; }
  async client() {
    return {
      request: async <T>(path: string, init: RequestInit): Promise<{ body: T }> => {
        const failure = this.failures.shift();
        if (failure) throw Object.assign(new Error(`Discord rejected the request (${failure.status ?? "network"})`), { discordStatus: failure.status });
        const body = JSON.parse(String(init.body)) as DiscordPost["body"];
        const earlier = this.byNonce.get(body.nonce);
        if (earlier && body.enforce_nonce) return { body: { id: earlier } as T };
        const id = `message-${this.posts.length + 1}`;
        this.byNonce.set(body.nonce, id);
        this.posts.push({ path, body });
        return { body: { id } as T };
      },
    };
  }
  providerStatus(error: unknown) { return (error as { discordStatus?: number }).discordStatus; }
}

type OutreachTeam = { id: string; number: string; name: string; program: string; archived: boolean };
type OutreachActivity = { id: string; teamId: string; serviceDate: string };
type OutreachCall = { operation: string; input: any; via: "grant" | "user" };
const refusal = (status: number, message: string) => Object.assign(new Error(message), { status });

/**
 * Outreach's `hour-tracking.team-support` interface as `services.modules` hands it to Guest Visits. `interface()` gives a
 * client while Outreach is ready and either the Admin's grant exists or, in a workspace request, the signed-in user has
 * Outreach access (Admins always; Operators only with `operatorAccess`). Every call rechecks its authority, grant first,
 * the way Core does. The operations behave like Outreach's: find-or-create, one Team Support activity per team and date,
 * refusals as errors with an HTTP status.
 */
export class FakeOutreach {
  ready = true;
  granted = false;
  operatorAccess = false;
  teams: OutreachTeam[] = [];
  activities: OutreachActivity[] = [];
  readonly calls: OutreachCall[] = [];
  /** The next calls fail: with a status (Core's HttpError) or, without one, an error that is not an HTTP refusal. */
  readonly failures: { status?: number; message?: string; operation?: string }[] = [];
  /** Runs before an operation answers, to change state mid-call. */
  beforeAnswer: ((operation: string) => void | Promise<void>) | null = null;
  /** Teams created so far, for their IDs. */
  created = 0;

  access(grantOnly: boolean, role: VisitsRole | null) {
    const user = !grantOnly && (role === "admin" || (role === "operator" && this.operatorAccess));
    return {
      grantOnly,
      client: async (): Promise<VisitsOutreachClient | undefined> => {
        if (!this.ready || (!this.granted && !user)) return undefined;
        return { call: (operation: string, input?: unknown) => this.call(operation, input, user) };
      },
      providerStatus: (error: unknown) => (error as { status?: number }).status,
    };
  }

  async call(operation: string, input: any, user: boolean): Promise<unknown> {
    if (!this.ready) throw refusal(409, "Outreach is unavailable");
    if (!this.granted && !user) throw refusal(403, "Guest Visits has no access to this Outreach operation");
    this.calls.push({ operation, input, via: this.granted ? "grant" : "user" });
    const failure = this.failures.findIndex((item) => !item.operation || item.operation === operation);
    if (failure >= 0) {
      const [item] = this.failures.splice(failure, 1);
      const error = new Error(item!.message ?? `Outreach failed (${item!.status ?? "network"})`);
      throw item!.status === undefined ? error : Object.assign(error, { status: item!.status });
    }
    await this.beforeAnswer?.(operation);
    const matches = (number: string, program: string) => this.teams.filter((team) => team.number === number && team.program === program).sort((left, right) => Number(left.archived) - Number(right.archived));
    if (operation === "find-teams") return { teams: matches(input.number, input.program).map((team) => ({ ...team })) };
    if (operation === "ensure-team") {
      const found = matches(input.number, input.program);
      const active = found.find((team) => !team.archived);
      if (active) return { team: { ...active }, created: false };
      if (found.length) throw refusal(409, `Supported team ${input.number} (${input.program}) is archived in Outreach. Restore it there first.`);
      const team = { id: `outreach-team-${this.created += 1}`, number: input.number, name: input.name, program: input.program, archived: false };
      this.teams.push(team);
      return { team: { ...team }, created: true };
    }
    if (operation === "ensure-team-support-activity") {
      const team = this.teams.find((item) => item.id === input.teamId);
      if (!team) throw refusal(404, "Supported team not found");
      const existing = this.activities.find((item) => item.teamId === input.teamId && item.serviceDate === input.serviceDate);
      if (existing) return { activityId: existing.id, created: false };
      if (team.archived) throw refusal(409, "That supported team is archived in Outreach. Restore it there first.");
      const activity = { id: `outreach-activity-${this.activities.length + 1}`, teamId: input.teamId, serviceDate: input.serviceDate };
      this.activities.push(activity);
      return { activityId: activity.id, created: true };
    }
    throw refusal(403, "Guest Visits did not declare that operation");
  }
}

export type Call = { readonly status: number; readonly body: any };
type CallOptions = { readonly body?: unknown; readonly origin?: string | null; readonly role?: VisitsRole | null; readonly userId?: string };

export type Harness = ReturnType<typeof visitsHarness>;

/** A fresh installation with Guest Visits enabled (default settings), at `now`. */
export function visitsHarness(start = Date.parse("2026-10-28T15:00:00.000Z")) {
  const db: TestDatabase = createTestDatabase();
  db.sqlite.exec("INSERT INTO users(id, installation_id) VALUES ('operator-1', 'primary')");
  db.sqlite.prepare(defaultSettingsSql).run("primary", start, new Date(start).toISOString());
  const clock = { now: start };
  const email = new FakeEmail();
  const discord = new FakeDiscord();
  // Outreach is not installed until a test says so.
  const outreach = new FakeOutreach();
  outreach.ready = false;
  /** Guest requests and the job have no signed-in user; workspace and setup requests have the caller's role. */
  const depsFor = (grantOnly: boolean, role: VisitsRole | null): VisitsDeps => ({
    civil, timeZone: async () => newYork, now: () => clock.now, email, discord, outreach: outreach.access(grantOnly, role), dashboardOrigin,
  });
  const deps = depsFor(true, null);

  async function call(method: string, path: string, options: CallOptions = {}): Promise<Call> {
    const url = new URL(path, apiOrigin);
    const headers = new Headers();
    const origin = options.origin === undefined ? dashboardOrigin : options.origin;
    if (origin) headers.set("origin", origin);
    if (options.body !== undefined) headers.set("content-type", "application/json");
    const request = new Request(url, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    const role = options.role === undefined ? "admin" : options.role;
    const context = {
      request, url, db: db as never,
      async requireRole(roles: readonly VisitsRole[]) {
        if (!role) throw new CoreError(401, "Sign in");
        if (!roles.includes(role)) throw new CoreError(403, "This account cannot do that");
        return { userId: options.userId ?? (role === "admin" ? "user-1" : "operator-1"), role };
      },
      async body<T>() { return (request.method === "GET" ? undefined : JSON.parse(await request.text())) as T; },
      respond: (body: unknown, status = 200) => Response.json(body, { status }),
      requireDashboardOrigin(message: string) { if (request.headers.get("origin") !== dashboardOrigin) throw new CoreError(403, message); },
    };
    const family = url.pathname.startsWith("/public/visits") ? visitsPublicRoute : url.pathname.startsWith("/admin/visits") ? visitsAdminRoute : visitsSetupRoute;
    try {
      const response = await family(context, family === visitsPublicRoute ? depsFor(true, null) : depsFor(false, role));
      if (!response) return { status: 404, body: { error: "Not found" } };
      return { status: response.status, body: await response.json() };
    } catch (error) {
      if (error instanceof CoreError) return { status: error.status, body: { error: error.message } };
      throw error;
    }
  }

  const count = (sql: string, ...values: unknown[]) => Number((db.rows<{ n: number }>(sql, ...values)[0] as { n: number }).n);
  /** One pass of the visits.notifications job. */
  const job = () => processVisitsNotifications(db as never, depsFor(true, null));
  return { db, clock, email, discord, outreach, deps, depsFor, call, count, job };
}

/** Monday and Wednesday 18:00 to 21:00 from November 2 to December 18, 2026 (America/New_York). */
export const shopSeries = { weekdays: [1, 3], startTime: "18:00", endTime: "21:00", firstDate: "2026-11-02", lastDate: "2026-12-18", title: "Open shop" };

let keys = 0;
/** A valid guest booking for Monday, November 2, 18:30 to 20:00. */
export function bookingRequest(overrides: Record<string, unknown> = {}) {
  keys += 1;
  return {
    teamNumber: "1234", teamName: "Gearheads", program: "FRC", contactName: "Pat Coach", contactEmail: "pat@example.org", contactPhone: "555-010-1234",
    date: "2026-11-02", arrival: "18:30", departure: "20:00", headcount: 12, note: "Two mentors drive", submissionKey: `submission-key-${String(keys).padStart(6, "0")}`,
    ...overrides,
  };
}

/** Create the shop series and return it. */
export async function withShopSeries(harness: Harness) {
  const created = await harness.call("POST", "/admin/visits/series", { body: shopSeries });
  if (created.status !== 201) throw new Error(`Series not created: ${JSON.stringify(created.body)}`);
  return created.body;
}

/** Book a visit and return the response body and the booking ID. */
export async function book(harness: Harness, overrides: Record<string, unknown> = {}) {
  const response = await harness.call("POST", "/public/visits/bookings", { body: bookingRequest(overrides), role: null });
  if (response.status !== 201) throw new Error(`Booking refused: ${JSON.stringify(response.body)}`);
  const row = harness.db.rows<{ id: string }>("SELECT id FROM visits_bookings ORDER BY created_at DESC, rowid DESC LIMIT 1")[0]!;
  return { ...response.body, id: row.id };
}
