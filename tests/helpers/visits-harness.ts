// Runs the Guest Visits Worker handlers the way Core does, without Core: an in-memory database with the plugin's
// migration, Core's request context reduced to what the handlers use, a controlled clock, and synthetic email and Discord
// services that behave like Resend's idempotency keys and Discord's enforced nonces. Synthetic data only.
import { createTestDatabase, type TestDatabase } from "./d1.ts";
import { civil, newYork } from "./civil-time.ts";
import { processVisitsNotifications } from "../../src/api/visits-delivery.ts";
import { visitsAdminRoute, visitsPublicRoute, visitsSetupRoute } from "../../src/api/visits-routes.ts";
import type { VisitsDeps, VisitsRole } from "../../src/api/visits-runtime.ts";
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
  const deps: VisitsDeps = { civil, timeZone: async () => newYork, now: () => clock.now, email, discord, dashboardOrigin };

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
      const response = await family(context, deps);
      if (!response) return { status: 404, body: { error: "Not found" } };
      return { status: response.status, body: await response.json() };
    } catch (error) {
      if (error instanceof CoreError) return { status: error.status, body: { error: error.message } };
      throw error;
    }
  }

  const count = (sql: string, ...values: unknown[]) => Number((db.rows<{ n: number }>(sql, ...values)[0] as { n: number }).n);
  /** One pass of the visits.notifications job. */
  const job = () => processVisitsNotifications(db as never, deps);
  return { db, clock, email, discord, deps, call, count, job };
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
