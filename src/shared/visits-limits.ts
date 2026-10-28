// Per-recipient daily email cap. Each address gets at most `dailyEmailCap` Guest Visits emails per local day in the
// installation time zone. Bookings over the cap still save; the email waits for the next day and Needs attention reports
// it. Addresses are stored only as SHA-256 of the trimmed lowercase address.
import { sha256Hex } from "./visits-tokens.ts";
import { addDays, localInstant, localMoment, type CivilTime } from "./visits-time.ts";

export const dailyEmailCap = 10;

/** The form of an address the cap counts: trimmed and lowercase. */
export function normalizeEmailAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** The stored key for a recipient address. */
export function emailAddressHash(address: string): Promise<string> {
  return sha256Hex(normalizeEmailAddress(address));
}

/** The local day an email counts against. */
export function emailLimitDay(civil: CivilTime, timeZone: string, now: number): string {
  return localMoment(civil, timeZone, now).date;
}

/** When the next local day starts: the earliest a capped email can go. */
export function nextEmailDayStartMs(civil: CivilTime, timeZone: string, now: number): number {
  return localInstant(civil, timeZone, addDays(emailLimitDay(civil, timeZone, now), 1), "00:00", "start");
}

/** Whether another email may go to an address that has already been sent `sent` emails today. */
export function emailCapDecision(sent: number, cap: number = dailyEmailCap): { readonly allowed: boolean; readonly remaining: number } {
  const remaining = Math.max(0, cap - sent);
  return { allowed: remaining > 0, remaining };
}

/**
 * Reserve one email for an address and day, atomically. Binds installation ID, address hash, local day and the cap.
 * Returns a row with the new `sent` count when the email may go, and no row when the cap is already reached. Reserve
 * before handing the email to the provider, so concurrent sends can never pass the cap.
 */
export const reserveEmailSql = "INSERT INTO visits_email_limits(installation_id,address_hash,local_day,sent) VALUES(?,?,?,1) ON CONFLICT(installation_id,address_hash,local_day) DO UPDATE SET sent=sent+1 WHERE sent<? RETURNING sent";

/**
 * Give a reservation back when the provider certainly did not send the email (it refused the request). Never after an
 * ambiguous failure, since that email may have been delivered. Binds installation ID, address hash and local day.
 */
export const releaseEmailSql = "UPDATE visits_email_limits SET sent=sent-1 WHERE installation_id=? AND address_hash=? AND local_day=? AND sent>0";

/** Forget counts for days before a date. Binds installation ID and the first local day to keep. */
export const purgeEmailLimitsSql = "DELETE FROM visits_email_limits WHERE installation_id=? AND local_day<?";
