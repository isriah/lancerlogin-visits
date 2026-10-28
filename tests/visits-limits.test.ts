import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { at, civil, newYork } from "./helpers/civil-time.ts";
import { createTestDatabase } from "./helpers/d1.ts";
import {
  dailyEmailCap, emailAddressHash, emailCapDecision, emailLimitDay, nextEmailDayStartMs, normalizeEmailAddress, purgeEmailLimitsSql, releaseEmailSql, reserveEmailSql,
} from "../src/shared/visits-limits.ts";

const iso = (ms: number) => new Date(ms).toISOString();

test("the cap counts each address case-insensitively by its hash", async () => {
  assert.equal(dailyEmailCap, 10);
  assert.equal(normalizeEmailAddress("  Pat.Coach@Example.ORG "), "pat.coach@example.org");
  const hash = await emailAddressHash("  Pat.Coach@Example.ORG ");
  assert.equal(hash, createHash("sha256").update("pat.coach@example.org").digest("hex"));
  assert.equal(hash, await emailAddressHash("pat.coach@example.org"));
  assert.notEqual(hash, await emailAddressHash("pat.coach@example.com"));
});

test("days are local to the installation, and a capped email waits for the next local midnight", () => {
  assert.equal(emailLimitDay(civil, newYork, at("2026-11-03T03:00:00Z")), "2026-11-02", "10 PM Monday in New York");
  assert.equal(iso(nextEmailDayStartMs(civil, newYork, at("2026-11-03T03:00:00Z"))), "2026-11-03T05:00:00.000Z");
  assert.equal(iso(nextEmailDayStartMs(civil, newYork, at("2026-10-31T20:00:00Z"))), "2026-11-01T04:00:00.000Z", "midnight before the clocks fall back is still EDT");
  // Where clocks spring forward at midnight, the day starts when the clock jumps to 01:00.
  assert.equal(iso(nextEmailDayStartMs(civil, "America/Havana", at("2026-03-07T12:00:00Z"))), "2026-03-08T05:00:00.000Z");
});

test("the eleventh email to one address in a day waits", () => {
  assert.deepEqual(emailCapDecision(0), { allowed: true, remaining: 10 });
  assert.deepEqual(emailCapDecision(9), { allowed: true, remaining: 1 });
  assert.deepEqual(emailCapDecision(10), { allowed: false, remaining: 0 });
  assert.deepEqual(emailCapDecision(12), { allowed: false, remaining: 0 });
  assert.deepEqual(emailCapDecision(2, 3), { allowed: true, remaining: 1 });
});

test("reserving an email slot is atomic per address and day and stops at the cap", async () => {
  const db = createTestDatabase();
  const address = await emailAddressHash("pat@example.org");
  const reserve = async (day = "2026-11-02", hash = address) => (await db.prepare(reserveEmailSql).bind("primary", hash, day, dailyEmailCap).all<{ sent: number }>()).results;
  const counts: number[] = [];
  for (let index = 0; index < dailyEmailCap; index++) counts.push((await reserve())[0]!.sent);
  assert.deepEqual(counts, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(await reserve(), [], "the eleventh waits");
  assert.deepEqual(await reserve("2026-11-03"), [{ sent: 1 }], "a new local day");
  assert.deepEqual(await reserve("2026-11-02", await emailAddressHash("sam@example.org")), [{ sent: 1 }], "another address");
  // A send the provider refused gives its slot back.
  assert.equal((await db.prepare(releaseEmailSql).bind("primary", address, "2026-11-02").run()).meta.changes, 1);
  assert.deepEqual(await reserve(), [{ sent: 10 }]);
  assert.equal((await db.prepare(purgeEmailLimitsSql).bind("primary", "2026-11-03").run()).meta.changes, 2);
  assert.deepEqual(db.rows("SELECT local_day, sent FROM visits_email_limits"), [{ local_day: "2026-11-03", sent: 1 }]);
});
