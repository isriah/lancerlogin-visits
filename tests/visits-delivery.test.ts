// Email and Discord delivery through the queue: the per-address cap, Discord queueing, the visits.notifications job's
// sends, retries and lease recovery, the weekly summary and the purge of operational rows.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { book, dashboardOrigin, FakeEmail, visitsHarness, withShopSeries, type Harness } from "./helpers/visits-harness.ts";
import { emailCappedMessage } from "../src/api/visits-queries.ts";
import { emptyWeekText } from "../src/shared/visits-summary.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const channel = "123456789012345678";
const notifications = (harness: Harness) => harness.db.rows<Record<string, unknown>>("SELECT channel, kind, status, attempts, next_attempt_ms, last_error, summary_date FROM visits_notifications ORDER BY created_at, rowid").map((row) => ({ ...row }));

async function enableDiscord(harness: Harness, extra: Record<string, unknown> = {}) {
  const current = await harness.call("GET", "/admin/visits/settings");
  const saved = await harness.call("PUT", "/admin/visits/settings", { body: { revision: current.body.revision, discordEnabled: true, discordChannelId: channel, ...extra } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return saved.body;
}

test("each address gets at most ten Guest Visits emails a day; the eleventh waits for the next day and Needs attention lists it", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  for (let index = 0; index < 11; index += 1) await book(harness, { contactEmail: index === 5 ? "PAT@example.org" : "pat@example.org", headcount: index + 1 });
  assert.equal(harness.email.sent.length, 10);
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_bookings"), 11);
  const waiting = notifications(harness).at(-1)!;
  // Midnight starts October 29 in New York (EDT).
  assert.deepEqual(waiting, { channel: "email", kind: "booked", status: "pending", attempts: 0, next_attempt_ms: Date.parse("2026-10-29T04:00:00Z"), last_error: emailCappedMessage, summary_date: null });
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_manage_tokens"), 10);
  assert.deepEqual(harness.db.rows("SELECT local_day, sent FROM visits_email_limits").map((row) => ({ ...row })), [{ local_day: "2026-10-28", sent: 10 }]);
  const attention = await harness.call("GET", "/admin/visits/bookings?scope=attention");
  assert.deepEqual(attention.body.map((booking: { headcount: number; email: string }) => [booking.headcount, booking.email]), [[11, "capped"]]);
  assert.equal((await harness.call("GET", "/admin/visits/status")).body.attentionCount, 1);
  // Not before the next local day.
  await harness.job();
  assert.equal(harness.email.sent.length, 10);
  harness.clock.now = Date.parse("2026-10-29T04:01:00Z");
  const pass = await harness.job();
  assert.equal(pass.delivered, 1);
  assert.equal(harness.email.sent.length, 11);
  assert.equal((await harness.call("GET", "/admin/visits/bookings?scope=attention")).body.length, 0);
  // The daily counts of earlier days are forgotten once they no longer matter.
  harness.clock.now = Date.parse("2026-10-31T12:00:00Z");
  await harness.job();
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_email_limits"), 0);
});

test("Discord messages are queued only while Guest Visits messages are on and Discord is ready, and never mention anyone", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  await book(harness);
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_notifications WHERE channel='discord'"), 0);
  await enableDiscord(harness);
  harness.discord.readyValue = false;
  await book(harness, { teamNumber: "2", teamName: "Two", contactEmail: "two@example.org" });
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_notifications WHERE channel='discord'"), 0);
  harness.discord.readyValue = true;
  await book(harness, { teamNumber: "3", teamName: "@everyone **bold**", contactEmail: "three@example.org" });
  assert.equal(harness.discord.posts.length, 1);
  const [post] = harness.discord.posts;
  assert.equal(post!.path, `/channels/${channel}/messages`);
  assert.deepEqual(post!.body.allowed_mentions, { parse: [] });
  assert.equal(post!.body.enforce_nonce, true);
  assert.match(post!.body.nonce, /^[0-9a-f]{25}$/);
  assert.match(post!.body.content, /^New guest visit: FRC 3 @​everyone \\\*\\\*bold\\\*\\\* - Monday, November 2, 6:30 PM to 8:00 PM - 12 people$/);
  assert.doesNotMatch(post!.body.content, /three@example\.org|555|Two mentors/);
  // A guest change and cancellation each post once.
  const token = FakeEmail.token(harness.email.sent.at(-1)!);
  const booking = harness.db.rows<{ id: string }>("SELECT b.id FROM visits_bookings b JOIN visits_teams t ON t.id=b.team_id WHERE t.number='3'")[0]!;
  await harness.call("POST", "/public/visits/manage/update", { body: { token, edit: { revision: 0, headcount: 4 } }, role: null });
  await harness.call("POST", "/public/visits/manage/cancel", { body: { token, revision: 1 }, role: null });
  assert.deepEqual(harness.discord.posts.map((item) => item.body.content.split(":")[0]), ["New guest visit", "Guest visit changed (headcount)", "Guest visit canceled"]);
  assert.ok(booking.id);
  // A retry with the same nonce never posts twice.
  harness.db.sqlite.prepare("UPDATE visits_notifications SET status='pending', next_attempt_ms=0 WHERE channel='discord'").run();
  await harness.job();
  assert.equal(harness.discord.posts.length, 3);
  // Turning messages off skips what is still queued.
  harness.discord.failures.push({ status: 500 });
  await book(harness, { teamNumber: "4", teamName: "Four", contactEmail: "four@example.org" });
  const settings = (await harness.call("GET", "/admin/visits/settings")).body;
  await harness.call("PUT", "/admin/visits/settings", { body: { revision: settings.revision, discordEnabled: false } });
  harness.clock.now += 600_000;
  await harness.job();
  assert.equal(harness.discord.posts.length, 3);
  assert.equal(notifications(harness).filter((row) => row.channel === "discord").at(-1)!.status, "skipped");
});

test("the job retries a failed email with backoff, and a lost response never sends twice", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  harness.email.failures.push({ status: 503 });
  const booked = await book(harness);
  assert.equal(booked.booked, true);
  let [row] = notifications(harness);
  assert.equal(row!.status, "pending");
  assert.equal(row!.attempts, 1);
  assert.equal(row!.next_attempt_ms, harness.clock.now + 300_000);
  // A 5xx may have been sent, so its link stays valid and its cap reservation stays counted.
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_manage_tokens"), 1);
  assert.equal(harness.db.rows<{ sent: number }>("SELECT sent FROM visits_email_limits")[0]!.sent, 1);
  await harness.job();
  assert.equal(harness.email.sent.length, 0);
  harness.clock.now += 300_000;
  // This time Resend sends the email but the answer is lost.
  harness.email.failures.push({ afterAccept: true });
  await harness.job();
  [row] = notifications(harness);
  assert.equal(row!.status, "pending");
  assert.equal(row!.attempts, 2);
  assert.equal(row!.next_attempt_ms, harness.clock.now + 600_000);
  harness.clock.now += 600_000;
  await harness.job();
  // The retry's new link would change the email, so Resend refuses the key: the email that went out stands.
  assert.equal(harness.email.sent.length, 1);
  assert.equal(harness.email.attempts.length, 3);
  [row] = notifications(harness);
  assert.equal(row!.status, "delivered");
  const token = FakeEmail.token(harness.email.sent[0]!);
  assert.equal((await harness.call("POST", "/public/visits/manage", { body: { token }, role: null })).status, 200);
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_manage_tokens"), 2);
  assert.equal(harness.db.rows<{ sent: number }>("SELECT sent FROM visits_email_limits")[0]!.sent, 2);
});

test("a refused email fails at once and needs attention until staff handle it; Resend not ready leaves email queued", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  harness.email.failures.push({ status: 422 });
  const booked = await book(harness);
  const [row] = notifications(harness);
  assert.equal(row!.status, "failed");
  assert.match(String(row!.last_error), /422/);
  // Refused, so certainly not sent: no link and no count remain.
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_manage_tokens"), 0);
  assert.equal(harness.db.rows<{ sent: number }>("SELECT sent FROM visits_email_limits")[0]!.sent, 0);
  const status = (await harness.call("GET", "/admin/visits/status")).body;
  assert.equal(status.failedNotifications, 1);
  assert.equal(status.attentionCount, 1);
  const listed = (await harness.call("GET", "/admin/visits/bookings?scope=attention")).body;
  assert.deepEqual(listed.map((booking: { id: string; email: string }) => [booking.id, booking.email]), [[booked.id, "failed"]]);
  const handled = await harness.call("POST", `/admin/visits/bookings/${booked.id}/handled`);
  assert.equal(handled.status, 200);
  assert.equal(handled.body.email, "failed");
  assert.equal((await harness.call("GET", "/admin/visits/bookings?scope=attention")).body.length, 0);
  // Staff resend the confirmation once the address is fixed.
  const resent = await harness.call("POST", `/admin/visits/bookings/${booked.id}/resend`);
  assert.equal(resent.body.email, "sent");
  assert.equal(harness.email.sent.length, 1);
  // Without a verified Resend connection bookings still save, and email waits.
  harness.email.readyValue = false;
  await book(harness, { teamNumber: "2", teamName: "Two", contactEmail: "two@example.org" });
  assert.equal(notifications(harness).at(-1)!.status, "pending");
  assert.equal(notifications(harness).at(-1)!.attempts, 0);
  assert.equal((await harness.call("GET", "/admin/visits/status")).body.email.ready, false);
  await harness.job();
  assert.equal(notifications(harness).at(-1)!.attempts, 0);
  harness.email.readyValue = true;
  await harness.job();
  assert.equal(notifications(harness).at(-1)!.status, "delivered");
});

test("the job takes back rows whose sender stopped, but never a row another sender holds", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  harness.email.readyValue = false;
  await book(harness);
  await book(harness, { teamNumber: "2", teamName: "Two", contactEmail: "two@example.org" });
  const [first, second] = harness.db.rows<{ id: string }>("SELECT id FROM visits_notifications ORDER BY created_at, rowid");
  const now = harness.clock.now;
  harness.db.sqlite.prepare("UPDATE visits_notifications SET status='sending', lease_token='lease-token-expired', lease_expires_ms=?, next_attempt_ms=NULL, attempts=1 WHERE id=?").run(now - 1, first!.id);
  harness.db.sqlite.prepare("UPDATE visits_notifications SET status='sending', lease_token='lease-token-current', lease_expires_ms=?, next_attempt_ms=NULL, attempts=1 WHERE id=?").run(now + 60_000, second!.id);
  harness.email.readyValue = true;
  const pass = await harness.job();
  assert.equal(pass.recovered, 1);
  assert.equal(pass.delivered, 1);
  assert.deepEqual(harness.db.rows("SELECT status, attempts FROM visits_notifications ORDER BY created_at, rowid").map((row) => ({ ...row })), [{ status: "delivered", attempts: 2 }, { status: "sending", attempts: 1 }]);
  assert.equal(harness.email.sent.length, 1);
});

test("the weekly summary posts once per report date at the local time, across daylight saving, late after a missed pass", async () => {
  const harness = visitsHarness(Date.parse("2026-10-20T12:00:00Z"));
  await harness.call("POST", "/admin/visits/windows", { body: { date: "2026-10-27", startTime: "18:00", endTime: "21:00" } });
  await withShopSeries(harness);
  await enableDiscord(harness);
  await book(harness, { date: "2026-10-27", arrival: "18:00", departure: "19:00" });
  await book(harness, { teamNumber: "2", teamName: "Second", contactEmail: "two@example.org", date: "2026-11-04", arrival: "19:00", departure: "20:30", headcount: 1 });
  harness.discord.posts.length = 0;
  // Monday October 26, 12:00 EDT is 16:00 UTC.
  harness.clock.now = Date.parse("2026-10-26T15:59:00Z");
  assert.equal((await harness.job()).summary, "wait");
  harness.clock.now = Date.parse("2026-10-26T16:00:00Z");
  assert.equal((await harness.job()).summary, "queue");
  harness.clock.now += 300_000;
  assert.equal((await harness.job()).summary, "done");
  assert.equal(harness.discord.posts.length, 1);
  assert.equal(harness.discord.posts[0]!.body.content, "**Guest visits from Monday, October 26 to Monday, November 2**\n\n**Tuesday, October 27**\n- FRC 1234 Gearheads: 6:00 PM to 7:00 PM, 12 people");
  // After clocks fall back, Monday 12:00 EST is 17:00 UTC. A missed pass posts late, once.
  harness.clock.now = Date.parse("2026-11-02T16:30:00Z");
  assert.equal((await harness.job()).summary, "done");
  harness.clock.now = Date.parse("2026-11-03T09:00:00Z");
  await harness.job();
  await harness.job();
  assert.equal(harness.discord.posts.length, 2);
  assert.equal(harness.discord.posts[1]!.body.content, "**Guest visits from Monday, November 2 to Monday, November 9**\n\n**Wednesday, November 4**\n- FRC 2 Second: 7:00 PM to 8:30 PM, 1 person");
  assert.deepEqual(harness.db.rows("SELECT summary_date, status FROM visits_notifications WHERE kind='weekly-summary' ORDER BY summary_date").map((row) => ({ ...row })), [
    { summary_date: "2026-10-26", status: "delivered" }, { summary_date: "2026-11-02", status: "delivered" },
  ]);
  // An empty week still posts.
  harness.clock.now = Date.parse("2026-11-09T17:00:00Z");
  await harness.job();
  assert.equal(harness.discord.posts[2]!.body.content, `**Guest visits from Monday, November 9 to Monday, November 16**\n${emptyWeekText}`);
});

test("moving the summary starts from the next new report time, and a summary unsent by the next report is skipped", async () => {
  const harness = visitsHarness(Date.parse("2026-11-02T18:00:00Z"));
  await enableDiscord(harness);
  harness.clock.now = Date.parse("2026-11-02T18:30:00Z");
  // Monday's 12:00 report was before Discord messages were turned on: nothing posts for it.
  assert.equal((await harness.job()).summary, "wait");
  const settings = (await harness.call("GET", "/admin/visits/settings")).body;
  await harness.call("PUT", "/admin/visits/settings", { body: { revision: settings.revision, weeklySummaryWeekday: 3, weeklySummaryTime: "09:00" } });
  harness.clock.now = Date.parse("2026-11-04T13:59:00Z");
  assert.equal((await harness.job()).summary, "wait");
  // Discord fails, and the job does not run again until the following report time has passed.
  harness.discord.failures.push({ status: 500 });
  harness.clock.now = Date.parse("2026-11-04T14:00:00Z");
  assert.equal((await harness.job()).summary, "queue");
  assert.equal(harness.discord.posts.length, 0);
  harness.clock.now = Date.parse("2026-11-11T14:00:00Z");
  await harness.job();
  const rows = harness.db.rows("SELECT summary_date, status FROM visits_notifications WHERE kind='weekly-summary' ORDER BY summary_date").map((row) => ({ ...row }));
  assert.deepEqual(rows, [{ summary_date: "2026-11-04", status: "skipped" }, { summary_date: "2026-11-11", status: "delivered" }]);
  assert.equal(harness.discord.posts.length, 1);
});

test("the job forgets expired links and old submission keys, and keeps working ones", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  const booked = await book(harness, { date: "2026-12-14" });
  const token = FakeEmail.token(harness.email.sent[0]!);
  harness.db.sqlite.prepare("INSERT INTO visits_manage_tokens(installation_id, token_hash, booking_id, issued_ms, expires_ms, revoked_ms) VALUES ('primary', ?, ?, 0, ?, ?)").run(sha256("revoked"), booked.id, Date.parse("2026-12-15T01:00:00Z"), harness.clock.now - 31 * 86_400_000);
  harness.clock.now += 8 * 86_400_000;
  await harness.job();
  assert.deepEqual(harness.db.rows<{ token_hash: string }>("SELECT token_hash FROM visits_manage_tokens").map((row) => row.token_hash), [sha256(token)]);
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_public_submission_keys"), 0);
  harness.clock.now = Date.parse("2026-12-15T01:00:00Z");
  await harness.job();
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_manage_tokens"), 0);
  assert.ok(dashboardOrigin);
});
