// Requests to the Guest Visits Worker routes. Staff requests behave like the SDK's `dashboardApi` (same origin base,
// session cookie, JSON body), and also keep the `field` of an `{ error, field }` failure, which `dashboardApi` drops, so
// forms can mark the field the Worker refused. Guest requests send no cookie and are never cached.
import { dashboardApiBaseUrl } from "@lancerlogin/module-sdk/dashboard";
import { readFailure, type VisitsFailure } from "./visits-forms.ts";

export class VisitsRequestError extends Error {
  readonly failure: VisitsFailure;
  constructor(failure: VisitsFailure) { super(failure.message); this.name = "VisitsRequestError"; this.failure = failure; }
}

/** The failure behind any error a request raised. */
export function failureOf(error: unknown): VisitsFailure {
  if (error instanceof VisitsRequestError) return error.failure;
  return readFailure(null, undefined);
}

type Options = { readonly method?: "GET" | "POST" | "PUT" | "DELETE"; readonly body?: unknown; readonly signal?: AbortSignal };

async function request<T>(path: string, options: Options, guest: boolean): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${dashboardApiBaseUrl}${path}`, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      credentials: guest ? "omit" : "include",
      ...(guest ? { cache: "no-store" as const } : {}),
      headers: options.body === undefined ? {} : { "content-type": "application/json" },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new VisitsRequestError(readFailure(null, undefined));
  }
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new VisitsRequestError(readFailure(response.status, body));
  return body as T;
}

/** A signed-in staff request to `/admin/visits` or `/module-setup/visits`. */
export function staffRequest<T>(path: string, options: Options = {}): Promise<T> {
  return request<T>(path, options, false);
}

/** A guest request to `/public/visits`: no cookie, never cached. */
export function guestRequest<T>(path: string, options: Options = {}): Promise<T> {
  return request<T>(path, options, true);
}

/** Whether an error came from aborting the request, which callers ignore. */
export function aborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
