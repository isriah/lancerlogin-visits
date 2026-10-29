// What every Guest Visits Worker handler shares: the dependencies Core supplies (civil time, time zone, clock, email,
// Discord, Outreach, credential encryption and fetch), the request context shape, errors with the field they are about,
// request parsing, SQL guards and the conversions between rows and the HTTP contract. Handlers take `(context, deps)` so
// tests run them without Core: this file imports only type declarations from the module SDK, which are erased at run
// time.
import type { D1Database, D1Statement } from "@lancerlogin/module-sdk/api";
import type { LocalVisitTimes, StaffWindow } from "../shared/visits-api.ts";
import type { Attention, AttentionReason, BookableWindow, BookingDetails, TeamIdentity, VisitProgram } from "../shared/visits-booking.ts";
import type { StoredWindow, WindowStatus } from "../shared/visits-schedule.ts";
import { installationId } from "../shared/visits-storage.ts";
import { localMoment, type CivilTime, type Problem } from "../shared/visits-time.ts";

export { installationId };

/** One email through Core's Resend connection. Structurally the SDK's `services.email`. */
export type VisitsEmailService = {
  ready(): Promise<boolean>;
  send(message: { readonly to: string; readonly subject: string; readonly html?: string; readonly text?: string; readonly replyTo?: string; readonly idempotencyKey: string }): Promise<{ readonly id: string | null }>;
  providerStatus(error: unknown): number | undefined;
};
/** Core's Discord bot connection. Structurally the SDK's `services.discord`. */
export type VisitsDiscordService = {
  ready(): Promise<boolean>;
  client(): Promise<{ request<T = Record<string, unknown>>(path: string, init: RequestInit): Promise<{ readonly body: T }> }>;
  providerStatus(error: unknown): number | undefined;
};

/** A client for Outreach's team support interface. Structurally the SDK's `ModuleInterfaceClient`. */
export type VisitsOutreachClient = { call(operation: string, input?: unknown): Promise<unknown> };
/** Core's cross-module calls to Outreach, from `services.modules`. */
export type VisitsOutreachAccess = {
  /**
   * A client while Outreach is enabled and set up and something authorizes Guest Visits' calls: an Admin's grant, or in a
   * workspace request the signed-in staff member's own Outreach access. Undefined otherwise.
   */
  client(): Promise<VisitsOutreachClient | undefined>;
  /** True where no one is signed in (guest requests and the job), so a client can only come from an Admin's grant. */
  readonly grantOnly: boolean;
  /** HTTP status of a refused call (the provider's or Core's), or undefined for any other error. */
  providerStatus(error: unknown): number | undefined;
};

/** Core's credential encryption, for FIRST API tokens. Structurally the SDK's `services.credentials`. */
export type VisitsCredentials = {
  /** False where Core has no key to encrypt with. */
  readonly available: boolean;
  encrypt(value: Record<string, string>): Promise<{ readonly ciphertext: string; readonly iv: string }>;
  decrypt(ciphertext: string, iv: string): Promise<Record<string, string>>;
};
/** The Worker's fetch, passed in so handlers never reach the network on their own. Only FIRST's team APIs are called. */
export type VisitsFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Everything a handler needs from Core besides the request, so tests can pass stand-ins and a controlled clock. */
export type VisitsDeps = {
  readonly civil: CivilTime;
  /** The installation's IANA time zone. */
  timeZone(): Promise<string>;
  now(): number;
  readonly email: VisitsEmailService;
  readonly discord: VisitsDiscordService;
  readonly outreach: VisitsOutreachAccess;
  readonly credentials: VisitsCredentials;
  readonly fetch: VisitsFetch;
  /** Where the dashboard is served, for manage links and the public origin check. */
  readonly dashboardOrigin: string | undefined;
};

export type VisitsRole = "admin" | "operator";
/** The parts of Core's module route context the handlers use. */
export type VisitsRouteContext = {
  readonly request: Request;
  readonly url: URL;
  readonly db: D1Database;
  requireRole(roles: readonly VisitsRole[]): Promise<{ readonly userId: string; readonly role: VisitsRole }>;
  body<T = unknown>(maxBytes?: number): Promise<T | undefined>;
  respond(body: unknown, status?: number): Response;
  requireDashboardOrigin(message: string): void;
};

export type RouteResult = { readonly status: number; readonly body: unknown };
export const ok = (body: unknown, status = 200): RouteResult => ({ status, body });

/** A refusal the client can show: `{ error, field? }` with a 4xx status. */
export class VisitsError extends Error {
  readonly status: number;
  readonly field: string | undefined;
  constructor(status: number, message: string, field?: string) {
    super(message);
    this.status = status;
    this.field = field || undefined;
  }
}

/** Throw a validation problem as a 400, or another status. */
export function refuse(problem: Problem, status = 400): never {
  throw new VisitsError(status, problem.error, problem.field);
}

/** Run a handler and turn a VisitsError into its JSON response. Core reports anything else. */
export async function respondTo(context: Pick<VisitsRouteContext, "respond">, run: () => Promise<RouteResult | undefined>): Promise<Response | undefined> {
  try {
    const result = await run();
    return result && context.respond(result.body, result.status);
  } catch (error) {
    if (error instanceof VisitsError) return context.respond(error.field ? { error: error.message, field: error.field } : { error: error.message }, error.status);
    throw error;
  }
}

/** The JSON body of a POST or PUT, or undefined when none was sent (for actions that take no input). */
export async function readBody(context: Pick<VisitsRouteContext, "request" | "body">, maxBytes = 65_536): Promise<unknown> {
  if (context.request.method === "GET" || context.request.method === "HEAD" || context.request.method === "DELETE") return undefined;
  const length = context.request.headers.get("content-length");
  if (!context.request.headers.get("content-type") && (length === null || length === "0")) return undefined;
  return context.body(maxBytes);
}

export const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** A JSON object body, or an empty object when none was sent. */
export function objectBody(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new VisitsError(400, "Send a JSON object");
  return value;
}

/** Refuse fields the route does not take. */
export function onlyFields(value: Record<string, unknown>, allowed: readonly string[]) {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new VisitsError(400, `Unexpected field ${unexpected}`, unexpected);
}

/** A revision sent back with an edit, from a body field or a query parameter. */
export function revisionOf(value: unknown): number {
  const parsed = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) throw new VisitsError(400, "Reload the page and try again", "revision");
  return parsed as number;
}

/** An ID taken from the path: 1 to 64 characters. */
export function pathId(value: string): string {
  let id: string;
  try { id = decodeURIComponent(value); } catch { throw new VisitsError(404, "Not found"); }
  if (!id || id.length > 64) throw new VisitsError(404, "Not found");
  return id;
}

export const stale = (what = "This visit") => new VisitsError(409, `${what} changed since you opened it. Reload to see the latest details.`, "revision");

/**
 * A statement that aborts its batch unless the condition holds, so a multi-statement change applies only to the state it
 * was planned against. The invalid JSON path is evaluated only when the condition is false; `guardFailed` recognizes it.
 */
export function guardStatement(db: D1Database, marker: string, condition: string, ...bindings: unknown[]): D1Statement {
  if (!/^visits_[a-z_]+$/.test(marker)) throw new RangeError("Guard markers are visits_ names");
  return db.prepare(`SELECT CASE WHEN (${condition}) THEN 1 ELSE json_extract('{}','${marker}') END AS visits_guard`).bind(...bindings);
}

export function guardFailed(error: unknown, marker: string): boolean {
  return error instanceof Error && error.message.includes(marker);
}

export const iso = (ms: number) => new Date(ms).toISOString();

/** Rows of a query. */
export async function rows<T>(statement: D1Statement): Promise<T[]> {
  return ((await statement.all<T>()).results ?? []) as T[];
}

// Row shapes and their conversions.

export type SettingsRow = {
  host_name: string; intro_text: string; reply_to: string; test_email_sent_at: string | null; discord_enabled: number; discord_channel_id: string | null;
  weekly_summary_enabled: number; weekly_summary_weekday: number; weekly_summary_time: string; weekly_summary_since_ms: number; headcount_required: number; revision: number;
};

export type WindowRow = {
  id: string; series_id: string | null; start_ms: number; end_ms: number; title: string; status: WindowStatus; cancel_reason: string;
  edited: number; revision: number;
};
export const windowColumns = "id,series_id,start_ms,end_ms,title,status,cancel_reason,edited,revision";

export function storedWindow(row: WindowRow): StoredWindow & BookableWindow & { readonly title: string; readonly cancelReason: string } {
  return { id: row.id, seriesId: row.series_id, startMs: row.start_ms, endMs: row.end_ms, title: row.title, status: row.status, edited: row.edited === 1, cancelReason: row.cancel_reason };
}

export type BookingRow = {
  id: string; window_id: string; team_id: string; contact_name: string; contact_email: string; contact_phone: string; arrival_ms: number;
  departure_ms: number; headcount: number | null; note: string; status: "booked" | "canceled"; removed: number; attention: Attention["state"];
  attention_reason: AttentionReason | null; outreach_activity_id: string | null; revision: number; created_at: string; updated_at: string;
};
export const bookingColumns = "b.id,b.window_id,b.team_id,b.contact_name,b.contact_email,b.contact_phone,b.arrival_ms,b.departure_ms,b.headcount,b.note,b.status,b.removed,b.attention,b.attention_reason,b.outreach_activity_id,b.revision,b.created_at,b.updated_at";

export function bookingDetailsOf(row: BookingRow): BookingDetails {
  return {
    windowId: row.window_id, teamId: row.team_id, contactName: row.contact_name, contactEmail: row.contact_email, contactPhone: row.contact_phone,
    arrivalMs: row.arrival_ms, departureMs: row.departure_ms, headcount: row.headcount, note: row.note, status: row.status,
  };
}
export const attentionOf = (row: Pick<BookingRow, "attention" | "attention_reason">): Attention => ({ state: row.attention, reason: row.attention_reason });

export type TeamRow = { id: string; number: string; name: string; program: VisitProgram; outreach_team_id: string | null; archived: number; revision: number };
export const teamIdentity = (row: { number: string; name: string; program: VisitProgram }): TeamIdentity => ({ number: row.number, name: row.name, program: row.program });

/** Local date and times of a visit or window in the installation time zone. */
export function localTimes(civil: CivilTime, timeZone: string, startMs: number, endMs: number): LocalVisitTimes {
  const start = localMoment(civil, timeZone, startMs);
  const end = localMoment(civil, timeZone, endMs);
  return { date: start.date, arrival: start.time, departure: end.time, arrivalMs: startMs, departureMs: endMs };
}

export function staffWindow(civil: CivilTime, timeZone: string, row: WindowRow & { booked_count?: number; team_count?: number }): StaffWindow {
  const times = localTimes(civil, timeZone, row.start_ms, row.end_ms);
  return {
    id: row.id, seriesId: row.series_id, revision: row.revision, date: times.date, startTime: times.arrival, endTime: times.departure,
    startMs: row.start_ms, endMs: row.end_ms, title: row.title, status: row.status, cancelReason: row.cancel_reason, edited: row.edited === 1,
    bookedCount: Number(row.booked_count ?? 0), teamCount: Number(row.team_count ?? 0),
  };
}

/**
 * Statements that bring the Needs attention state of booked visits in these windows up to date after the windows changed:
 * the same rule as `nextAttention(current, windowAttentionReason(...))`. A new or different window reason needs attention
 * again, the same reason keeps its state, and a visit that fits an open window again loses its window reason. Binds the
 * window IDs as a JSON array.
 */
export function windowAttentionStatements(db: D1Database, windowIds: readonly string[], now: number): D1Statement[] {
  if (!windowIds.length) return [];
  const ids = JSON.stringify([...new Set(windowIds)]);
  const at = iso(now);
  const scope = "installation_id=? AND status='booked' AND window_id IN (SELECT value FROM json_each(?))";
  const window = (condition: string) => `EXISTS(SELECT 1 FROM visits_windows w WHERE w.installation_id=visits_bookings.installation_id AND w.id=visits_bookings.window_id AND ${condition})`;
  const fits = "w.start_ms<=visits_bookings.arrival_ms AND visits_bookings.departure_ms<=w.end_ms";
  const needs = (reason: string, condition: string) => db.prepare(`UPDATE visits_bookings SET attention='needed',attention_reason='${reason}',updated_at=? WHERE ${scope} AND attention_reason IS NOT '${reason}' AND ${window(condition)}`).bind(at, installationId, ids);
  return [
    needs("window-removed", "w.status='removed'"),
    needs("window-canceled", "w.status='canceled'"),
    needs("window-changed", `w.status='open' AND NOT (${fits})`),
    db.prepare(`UPDATE visits_bookings SET attention='none',attention_reason=NULL,updated_at=? WHERE ${scope} AND attention_reason IN ('window-canceled','window-removed','window-changed') AND ${window(`w.status='open' AND ${fits}`)}`).bind(at, installationId, ids),
  ];
}
