// Admin actions on failed Discord posts, which nothing retries on its own: dismiss one (it is never sent), or retry one
// with fresh attempts once its cause is fixed in Discord. Failed emails and Outreach records keep their Needs attention
// flow (Handled, Resend, Record in Outreach) instead.
import type { D1Database } from "@lancerlogin/module-sdk/api";
import { decodeDiscordFailure, dismissedNote } from "../shared/visits-failures.ts";
import { deliverNow } from "./visits-delivery.ts";
import { retryableFailure, type DiscordFailureRow } from "./visits-queries.ts";
import { visitsStatus } from "./visits-settings.ts";
import { installationId, iso, ok, VisitsError, type RouteResult, type VisitsDeps } from "./visits-runtime.ts";

const notFound = () => new VisitsError(404, "This failed Discord message was already dismissed, retried or resolved. Reload to see the latest.");

/** Stop listing a failed Discord post. It stays skipped, so it never posts. */
export async function dismissNotification(db: D1Database, deps: VisitsDeps, id: string): Promise<RouteResult> {
  const now = deps.now();
  const result = await db.prepare("UPDATE visits_notifications SET status='skipped',last_error=?,updated_at=? WHERE installation_id=? AND id=? AND channel='discord' AND status='failed'")
    .bind(dismissedNote, iso(now), installationId, id).run();
  if (result.meta?.changes !== 1) throw notFound();
  return ok(await visitsStatus(db, deps));
}

/**
 * Queue a failed Discord post again with no attempts used, and try it at once. Refused for a visit that has ended, a
 * weekly summary more than a day old, and an unknown channel (choose another channel in settings instead). The
 * delivery rules still apply: a canceled visit's post or a summary past the next report time is skipped.
 */
export async function retryNotification(db: D1Database, deps: VisitsDeps, id: string): Promise<RouteResult> {
  const now = deps.now();
  const row = await db.prepare(`SELECT n.kind,n.payload_json,n.last_error,b.departure_ms FROM visits_notifications n LEFT JOIN visits_bookings b ON b.installation_id=n.installation_id AND b.id=n.booking_id
    WHERE n.installation_id=? AND n.id=? AND n.channel='discord' AND n.status='failed'`).bind(installationId, id).first<Pick<DiscordFailureRow, "kind" | "payload_json" | "last_error" | "departure_ms">>();
  if (!row) throw notFound();
  const reason = decodeDiscordFailure(row.last_error);
  if (!retryableFailure(row, reason, now)) {
    throw new VisitsError(409, reason.code === "unknown-channel"
      ? "Choose a Discord channel in Settings > Guest Visits > Discord. Saving it resolves this message."
      : "This message is out of date, so it can't be sent now. Dismiss it instead.");
  }
  const queued = await db.prepare("UPDATE visits_notifications SET status='pending',attempts=0,next_attempt_ms=?,last_error=NULL,updated_at=? WHERE installation_id=? AND id=? AND channel='discord' AND status='failed'")
    .bind(now, iso(now), installationId, id).run();
  if (queued.meta?.changes !== 1) throw notFound();
  await deliverNow(db, deps, [id]);
  return ok(await visitsStatus(db, deps));
}
