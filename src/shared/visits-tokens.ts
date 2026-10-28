// Manage-link tokens. A token is 32 random bytes in base64url, created when an email is actually sent, and travels only
// in the URL fragment (`/visit/manage#<token>`), which browsers keep out of server logs and Referer headers. Only its
// SHA-256 is stored. Every token sent for a booking works until the visit ends; correcting the booking's email address
// revokes them all. Uses the Web Crypto global, which the Worker, browsers and Node all provide.

export const manageTokenBytes = 32;
/** 32 bytes in unpadded base64url. */
export const manageTokenLength = 43;
export const manageTokenPattern = /^[A-Za-z0-9_-]{43}$/;
/** Path of the manage page below the dashboard origin. */
export const managePagePath = "/visit/manage";

/** Unpadded base64url of bytes. */
export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A new manage-link token. `random` fills the buffer, defaulting to `crypto.getRandomValues`. */
export function generateManageToken(random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)): string {
  return base64Url(random(new Uint8Array(manageTokenBytes)));
}

/** Whether a value has the shape of a manage-link token. Check this before hashing anything a request sent. */
export function isManageToken(value: unknown): value is string {
  return typeof value === "string" && manageTokenPattern.test(value);
}

/** Lowercase hex SHA-256 of UTF-8 text. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The stored form of a token. */
export function hashManageToken(token: string): Promise<string> {
  if (!isManageToken(token)) throw new RangeError("Not a manage-link token");
  return sha256Hex(token);
}

/** `<dashboardOrigin>/visit/manage#<token>`. The origin must be an http or https origin with no path. */
export function manageLink(dashboardOrigin: string, token: string): string {
  if (!isManageToken(token)) throw new RangeError("Not a manage-link token");
  let origin: URL;
  try { origin = new URL(dashboardOrigin); } catch { throw new RangeError("The dashboard origin is not a URL"); }
  if (!["http:", "https:"].includes(origin.protocol) || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) throw new RangeError("The dashboard origin must be an http or https origin");
  return `${origin.origin}${managePagePath}#${token}`;
}

/** A visits_manage_tokens row as the rules need it. */
export type ManageTokenRecord = { readonly bookingId: string; readonly issuedMs: number; readonly expiresMs: number; readonly revokedMs: number | null };

/**
 * The row to store when an email with a new token is sent. `expiresMs` is the visit's end; when a visit moves, update
 * `expires_ms` of its unrevoked tokens to the new end so expired-token cleanup never removes a working link.
 */
export function issueManageToken(input: { readonly bookingId: string; readonly departureMs: number; readonly now: number }): ManageTokenRecord {
  return { bookingId: input.bookingId, issuedMs: input.now, expiresMs: input.departureMs, revokedMs: null };
}

export type ManageTokenRefusal = "unknown" | "other-booking" | "revoked" | "expired";
export type ManageTokenCheck = { readonly ok: true } | { readonly ok: false; readonly reason: ManageTokenRefusal };

/**
 * Whether a stored token admits a request about a booking: it exists, belongs to that booking, is not revoked, and the
 * visit has not ended. The visit's current end decides, so a link keeps working when the guest moves the visit later.
 */
export function checkManageToken(record: ManageTokenRecord | null | undefined, booking: { readonly id: string; readonly departureMs: number }, now: number): ManageTokenCheck {
  if (!record) return { ok: false, reason: "unknown" };
  if (record.bookingId !== booking.id) return { ok: false, reason: "other-booking" };
  if (record.revokedMs !== null) return { ok: false, reason: "revoked" };
  if (now >= booking.departureMs) return { ok: false, reason: "expired" };
  return { ok: true };
}

/** One message for every refusal, so a guessed token learns nothing about which bookings exist. */
export const manageTokenRefusedMessage = "This link no longer works. Ask the team you are visiting to send a new one.";
