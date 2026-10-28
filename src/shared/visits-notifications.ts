// Queued email, Discord and Outreach work in visits_notifications. A booking change queues its notifications in the same
// batch as the change; the request then tries to send right away and the visits.notifications job retries. A row being
// sent holds a lease (status 'sending' with a token and an expiry), so two senders never send the same row.

export const notificationChannels = ["email", "discord", "outreach"] as const;
export type NotificationChannel = (typeof notificationChannels)[number];
export const notificationKinds = ["booked", "changed", "canceled", "resend", "weekly-summary", "outreach-record"] as const;
export type NotificationKind = (typeof notificationKinds)[number];
/**
 * pending: waiting for its next attempt. sending: leased by a sender. delivered: done. failed: gave up after the last
 * attempt or a permanent error; Needs attention lists it. paused: stopped by a restore until staff review it. skipped: a
 * weekly summary that was not sent before the following report time.
 */
export const notificationStatuses = ["pending", "sending", "delivered", "failed", "paused", "skipped"] as const;
export type NotificationStatus = (typeof notificationStatuses)[number];

/** Kinds each channel carries. */
export const channelKinds: Readonly<Record<NotificationChannel, readonly NotificationKind[]>> = {
  email: ["booked", "changed", "canceled", "resend"],
  discord: ["booked", "changed", "canceled", "weekly-summary"],
  outreach: ["outreach-record"],
};

/** How long a sender may hold a row before another pass may take it back. */
export const notificationLeaseMs = 120_000;
/** Attempts before a row fails and waits for staff. */
export const maximumNotificationAttempts = 8;
const firstRetryMs = 300_000;
const longestRetryMs = 6 * 3_600_000;

/** Wait before the next attempt after `attempts` attempts: 5 minutes, doubling, at most 6 hours. */
export function retryDelayMs(attempts: number): number {
  return Math.min(longestRetryMs, firstRetryMs * 2 ** Math.max(0, attempts - 1));
}

/** The row's next state after a failed attempt. Permanent errors (a refused request) fail at once. */
export function afterFailedAttempt(input: { readonly attempts: number; readonly now: number; readonly permanent?: boolean }): { readonly status: "pending"; readonly nextAttemptMs: number } | { readonly status: "failed" } {
  if (input.permanent || input.attempts >= maximumNotificationAttempts) return { status: "failed" };
  return { status: "pending", nextAttemptMs: input.now + retryDelayMs(input.attempts) };
}

/**
 * A Discord nonce for a notification: at most 25 characters, the same for every attempt, so `enforce_nonce` turns a
 * retried post into a no-op. Uses the last 25 letters and digits of the notification ID (a UUID has 32).
 */
export function discordNonce(notificationId: string): string {
  const characters = notificationId.replace(/[^A-Za-z0-9]/g, "");
  if (!characters) throw new RangeError("Notification IDs need letters or digits");
  return characters.slice(-25);
}

/** The idempotency key for an email notification; Core prefixes it with the module ID. */
export function emailIdempotencyKey(notificationId: string): string {
  return `notification-${notificationId}`;
}

/** Rows due now, oldest first. Binds installation ID, now and a limit. Uses visits_notifications_due. */
export const dueNotificationsSql = "SELECT id,channel,kind,booking_id,summary_date,payload_json,attempts FROM visits_notifications WHERE installation_id=? AND status='pending' AND next_attempt_ms<=? ORDER BY next_attempt_ms,id LIMIT ?";

/**
 * Take the lease on one due row. Binds lease token, lease expiry, updated_at, installation ID, notification ID and now.
 * Exactly one sender changes the row; the others see no change and move on.
 */
export const claimNotificationSql = "UPDATE visits_notifications SET status='sending',lease_token=?,lease_expires_ms=?,attempts=attempts+1,next_attempt_ms=NULL,updated_at=? WHERE installation_id=? AND id=? AND status='pending' AND next_attempt_ms<=?";

/**
 * Finish a leased row. Binds status ('delivered', 'pending', 'failed' or 'skipped'), next attempt (or NULL), external
 * ID (or NULL), last error (or NULL), updated_at, installation ID, notification ID and the lease token. A sender whose
 * lease expired and was taken back changes nothing.
 */
export const finishNotificationSql = "UPDATE visits_notifications SET status=?,next_attempt_ms=?,external_id=coalesce(?,external_id),last_error=?,lease_token=NULL,lease_expires_ms=NULL,updated_at=? WHERE installation_id=? AND id=? AND status='sending' AND lease_token=?";

/**
 * Return rows whose sender stopped without finishing to the queue, due at once. Binds updated_at, installation ID and
 * now. The provider may have received the earlier attempt, so every send is idempotent (email idempotency key, Discord
 * nonce, Outreach ensure operations).
 */
export const recoverExpiredLeasesSql = "UPDATE visits_notifications SET status='pending',next_attempt_ms=lease_expires_ms,lease_token=NULL,lease_expires_ms=NULL,updated_at=? WHERE installation_id=? AND status='sending' AND lease_expires_ms<=?";
