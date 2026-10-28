import test from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "./helpers/d1.ts";
import { insert, notificationRow, seedBooking } from "./helpers/rows.ts";
import {
  afterFailedAttempt, channelKinds, claimNotificationSql, discordNonce, dueNotificationsSql, emailIdempotencyKey, finishNotificationSql, maximumNotificationAttempts,
  notificationLeaseMs, recoverExpiredLeasesSql, retryDelayMs,
} from "../src/shared/visits-notifications.ts";
import { discordMessageBody } from "../src/shared/visits-text.ts";

const minute = 60_000;
const stamp = "2026-11-02T12:00:00.000Z";

test("retries back off from five minutes to six hours, then fail for staff", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(retryDelayMs).map((ms) => ms / minute), [5, 10, 20, 40, 80, 160, 320]);
  assert.equal(retryDelayMs(20), 6 * 60 * minute);
  assert.deepEqual(afterFailedAttempt({ attempts: 1, now: 0 }), { status: "pending", nextAttemptMs: 5 * minute });
  assert.deepEqual(afterFailedAttempt({ attempts: maximumNotificationAttempts, now: 0 }), { status: "failed" });
  assert.deepEqual(afterFailedAttempt({ attempts: 1, now: 0, permanent: true }), { status: "failed" });
  assert.deepEqual(channelKinds.outreach, ["outreach-record"]);
});

test("each notification has a stable Discord nonce and email idempotency key", () => {
  const id = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
  assert.equal(discordNonce(id), "e5b7d4e8f9a0b1c2d3e4f5a6b", "the last 25 letters and digits");
  assert.equal(discordNonce(id).length, 25);
  assert.equal(discordNonce("short-id"), "shortid");
  assert.doesNotThrow(() => discordMessageBody("Hello", discordNonce(id)));
  assert.throws(() => discordNonce("---"), RangeError);
  assert.equal(emailIdempotencyKey(id), `notification-${id}`);
});

test("one sender leases a due notification; a stale sender cannot finish it after recovery", async () => {
  const db = createTestDatabase();
  await seedBooking(db);
  const now = Date.UTC(2026, 10, 2, 12);
  await insert(db, "visits_notifications", notificationRow({ id: "due", next_attempt_ms: now - minute }));
  await insert(db, "visits_notifications", notificationRow({ id: "later", next_attempt_ms: now + minute }));
  await insert(db, "visits_notifications", notificationRow({ id: "done", status: "delivered", next_attempt_ms: null }));
  const due = (await db.prepare(dueNotificationsSql).bind("primary", now, 10).all<{ id: string; attempts: number }>()).results;
  assert.deepEqual(due.map((row) => row.id), ["due"]);

  const claim = (token: string, at: number) => db.prepare(claimNotificationSql).bind(token, at + notificationLeaseMs, stamp, "primary", "due", at).run();
  assert.equal((await claim("lease-token-first", now)).meta.changes, 1);
  assert.equal((await claim("lease-token-second", now)).meta.changes, 0, "a second sender gets nothing");
  assert.deepEqual(await db.prepare("SELECT status,attempts,next_attempt_ms,lease_token FROM visits_notifications WHERE id='due'").first(), { status: "sending", attempts: 1, next_attempt_ms: null, lease_token: "lease-token-first" });

  // The first sender stalls past its lease; a later pass returns the row to the queue and a new sender claims it.
  const recovered = await db.prepare(recoverExpiredLeasesSql).bind(stamp, "primary", now + notificationLeaseMs).run();
  assert.equal(recovered.meta.changes, 1);
  assert.equal((await claim("lease-token-third", now + notificationLeaseMs)).meta.changes, 1);
  const finish = (token: string, status: string, next: number | null, error: string | null) => db.prepare(finishNotificationSql).bind(status, next, "message-1", error, stamp, "primary", "due", token).run();
  assert.equal((await finish("lease-token-first", "delivered", null, null)).meta.changes, 0, "the stalled sender changes nothing");
  assert.equal((await finish("lease-token-third", "pending", now + 10 * minute, "Provider unavailable")).meta.changes, 1);
  assert.deepEqual(await db.prepare("SELECT status,attempts,next_attempt_ms,external_id,last_error,lease_token,lease_expires_ms FROM visits_notifications WHERE id='due'").first(), {
    status: "pending", attempts: 2, next_attempt_ms: now + 10 * minute, external_id: "message-1", last_error: "Provider unavailable", lease_token: null, lease_expires_ms: null,
  });
  // A pending row needs its next attempt time.
  await claim("lease-token-fourth", now + 10 * minute);
  await assert.rejects(finish("lease-token-fourth", "pending", null, "x"), /CHECK constraint failed/);
  assert.equal((await finish("lease-token-fourth", "delivered", null, null)).meta.changes, 1);
});
