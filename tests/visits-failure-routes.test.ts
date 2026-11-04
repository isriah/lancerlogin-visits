// Failed sends end to end: what a refused Discord post stores and the status reports, the permission check after a
// refusal, Dismiss and Retry, settings changes resolving failed posts, the stale summary rule, and which failed emails
// count.
import test from "node:test";
import assert from "node:assert/strict";
import { book, coreDiscordPermissionMessage, discordGuildId, visitsHarness, withShopSeries, type Harness } from "./helpers/visits-harness.ts";
import { dismissedNote, resolvedBySettingsNote } from "../src/shared/visits-failures.ts";
import { bannerText, discordFailureBanner } from "../src/dashboard/visits-labels.ts";

const channel = "123456789012345678";
const botId = "900000000000000002";
const view = 1n << 10n;
const send = 1n << 11n;

async function enableDiscord(harness: Harness, extra: Record<string, unknown> = {}) {
  const current = await harness.call("GET", "/admin/visits/settings");
  const saved = await harness.call("PUT", "/admin/visits/settings", { body: { revision: current.body.revision, discordEnabled: true, discordChannelId: channel, ...extra } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
}

/** Discord's answers for the permission check: a text channel where @everyone may not send, and the bot has no role that may. */
function channelDenyingSend(harness: Harness, deny = send) {
  harness.discord.answers.set(`/channels/${channel}`, { id: channel, name: "guest-visits", type: 0, guild_id: discordGuildId, permission_overwrites: [{ id: discordGuildId, type: 0, allow: "0", deny: String(deny) }] });
  harness.discord.answers.set("/users/@me", { id: botId });
  harness.discord.answers.set(`/guilds/${discordGuildId}/members/${botId}`, { roles: ["900000000000000003"] });
  harness.discord.answers.set(`/guilds/${discordGuildId}/roles`, [{ id: discordGuildId, permissions: String(view | send) }, { id: "900000000000000003", permissions: "0" }]);
}

const discordRows = (harness: Harness) => harness.db.rows<Record<string, unknown>>("SELECT id, kind, status, attempts, last_error FROM visits_notifications WHERE channel='discord' ORDER BY created_at, rowid").map((row) => ({ ...row }));
const status = async (harness: Harness) => (await harness.call("GET", "/admin/visits/status")).body;

test("a refused booking post fails at once, names the permission the bot lacks and the channel, and the banner says so", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  await enableDiscord(harness);
  channelDenyingSend(harness);
  harness.discord.failures.push({ permission: true });
  await book(harness);
  const [row] = discordRows(harness);
  assert.equal(row!.status, "failed");
  // Discord refuses until someone changes the bot's permissions, so it is not retried eight times.
  assert.equal(row!.attempts, 1);
  assert.deepEqual(JSON.parse(String(row!.last_error)), { discord: "missing-permissions", permissions: ["send-messages"], channel: "guest-visits" });
  const body = await status(harness);
  assert.equal(body.failedNotifications, 1);
  assert.equal(body.failures.emails, 0);
  assert.equal(body.failures.discordCount, 1);
  assert.equal(body.failures.discordChannelId, channel);
  const [failure] = body.failures.discord;
  assert.deepEqual({ ...failure, failedMs: undefined }, {
    id: row!.id, kind: "booked", summaryDate: null, visit: { team: { number: "99934", name: "Testheads", program: "FRC" }, date: "2026-11-02" },
    reason: { code: "missing-permissions", permissions: ["send-messages"], channelName: "guest-visits" }, failedMs: undefined, retryable: true,
  });
  assert.equal(failure.failedMs, harness.clock.now);
  assert.equal(bannerText(discordFailureBanner(failure, { channelId: channel, admin: true })),
    "The Discord post about a new visit by FRC 99934 Testheads on Monday, November 2 wasn't posted to Discord: the bot is missing Send Messages in #guest-visits. Give it that permission in Discord, then retry.");
  // Needs attention is for visits; a Discord post is not listed there.
  assert.equal(body.attentionCount, 0);
});

test("when Discord does not answer the permission check, the failure says only that a permission is missing", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  await enableDiscord(harness);
  harness.discord.failures.push({ permission: true });
  await book(harness);
  assert.deepEqual((await status(harness)).failures.discord[0].reason, { code: "missing-permissions", permissions: [], channelName: null });
  // A channel the bot cannot read at all is missing View Channel.
  harness.discord.answers.set(`/channels/${channel}`, { permission: true });
  harness.discord.failures.push({ permission: true });
  await book(harness, { teamNumber: "99902", teamName: "Two", contactEmail: "two@example.org" });
  assert.deepEqual((await status(harness)).failures.discord[0].reason, { code: "missing-permissions", permissions: ["view-channel"], channelName: null });
  // Roles Discord did not return leave the permissions unknown, with the channel's name.
  channelDenyingSend(harness);
  harness.discord.answers.set(`/guilds/${discordGuildId}/roles`, { message: "not a list" });
  harness.discord.failures.push({ permission: true });
  await book(harness, { teamNumber: "99903", teamName: "Three", contactEmail: "three@example.org" });
  assert.deepEqual((await status(harness)).failures.discord[0].reason, { code: "missing-permissions", permissions: [], channelName: "guest-visits" });
  // A failure that predates the codes, like the live weekly summary that failed after eight attempts, reads the same way.
  harness.db.sqlite.prepare("UPDATE visits_notifications SET last_error=? WHERE channel='discord'").run(coreDiscordPermissionMessage);
  const reasons = (await status(harness)).failures.discord.map((failure: { reason: unknown }) => failure.reason);
  assert.deepEqual(reasons, Array(3).fill({ code: "missing-permissions", permissions: [], channelName: null }));
});

test("an unknown channel fails at once and points to settings; other refusals keep Discord's words", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  await enableDiscord(harness);
  harness.discord.failures.push({ status: 404, code: 10_003, message: "Unknown Channel" });
  await book(harness);
  let body = await status(harness);
  assert.deepEqual(body.failures.discord[0].reason, { code: "unknown-channel" });
  assert.equal(body.failures.discord[0].retryable, false);
  // Retrying cannot help until the channel changes.
  const retried = await harness.call("POST", `/admin/visits/notifications/${body.failures.discord[0].id}/retry`);
  assert.equal(retried.status, 409);
  assert.match(retried.body.error, /Settings > Guest Visits > Discord/);
  // Other refusals keep Discord's words and fail at once, as 4xx refusals always did.
  harness.discord.failures.push({ status: 400, code: 50_035, message: "Invalid Form Body" });
  await book(harness, { teamNumber: "99902", teamName: "Two", contactEmail: "two@example.org" });
  body = await status(harness);
  assert.deepEqual(body.failures.discord[0].reason, { code: "other", message: "Discord rejected the request (400): Invalid Form Body" });
  assert.equal(body.failures.discord[0].retryable, true);
  // A 5xx still retries with backoff and is not listed.
  harness.discord.failures.push({ status: 503 });
  await book(harness, { teamNumber: "99903", teamName: "Three", contactEmail: "three@example.org" });
  assert.deepEqual(discordRows(harness).map((row) => [row.status, row.attempts]), [["failed", 1], ["failed", 1], ["pending", 1]]);
  assert.equal((await status(harness)).failures.discordCount, 2);
});

test("Admins dismiss a failed Discord post, which never posts; Operators see it but cannot", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  await enableDiscord(harness);
  harness.discord.failures.push({ permission: true });
  await book(harness);
  const [failure] = (await status(harness)).failures.discord;
  const asOperator = await harness.call("GET", "/admin/visits/status", { role: "operator" });
  assert.equal(asOperator.body.failures.discord.length, 1);
  assert.equal((await harness.call("POST", `/admin/visits/notifications/${failure.id}/dismiss`, { role: "operator" })).status, 403);
  assert.equal((await harness.call("POST", `/admin/visits/notifications/${failure.id}/retry`, { role: "operator" })).status, 403);
  assert.equal((await harness.call("POST", `/admin/visits/notifications/${failure.id}/dismiss`, { origin: "https://elsewhere.example.org" })).status, 403);
  const dismissed = await harness.call("POST", `/admin/visits/notifications/${failure.id}/dismiss`);
  assert.equal(dismissed.status, 200);
  assert.equal(dismissed.body.failedNotifications, 0);
  assert.deepEqual(dismissed.body.failures.discord, []);
  assert.deepEqual(discordRows(harness).map((row) => [row.status, row.last_error]), [["skipped", dismissedNote]]);
  // Nothing sends it later, and it cannot be dismissed or retried twice.
  harness.clock.now += 600_000;
  await harness.job();
  assert.equal(harness.discord.posts.length, 0);
  assert.equal((await harness.call("POST", `/admin/visits/notifications/${failure.id}/dismiss`)).status, 404);
  assert.equal((await harness.call("POST", `/admin/visits/notifications/${failure.id}/retry`)).status, 404);
  // Only failed Discord posts: a failed email keeps its Needs attention flow.
  harness.email.failures.push({ status: 422 });
  await book(harness, { teamNumber: "99902", teamName: "Two", contactEmail: "two@example.org" });
  const email = harness.db.rows<{ id: string }>("SELECT id FROM visits_notifications WHERE channel='email' AND status='failed'")[0]!;
  assert.equal((await harness.call("POST", `/admin/visits/notifications/${email.id}/dismiss`)).status, 404);
});

test("Retry posts a failed Discord message with fresh attempts once Discord allows it, and lists it again if it fails again", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  await enableDiscord(harness);
  for (let index = 0; index < 8; index += 1) harness.discord.failures.push({ status: 503 });
  await book(harness);
  for (let pass = 0; pass < 8; pass += 1) { harness.clock.now += 6 * 3_600_000; await harness.job(); }
  assert.deepEqual(discordRows(harness).map((row) => [row.status, row.attempts]), [["failed", 8]]);
  const [failure] = (await status(harness)).failures.discord;
  assert.equal(failure.retryable, true);
  // The bot still cannot post: listed again, after one fresh attempt.
  harness.discord.failures.push({ permission: true });
  let retried = await harness.call("POST", `/admin/visits/notifications/${failure.id}/retry`);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.failures.discord[0].reason.code, "missing-permissions");
  assert.deepEqual(discordRows(harness).map((row) => [row.status, row.attempts]), [["failed", 1]]);
  // An Admin fixes the permission in Discord; Retry posts it.
  retried = await harness.call("POST", `/admin/visits/notifications/${failure.id}/retry`);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.failedNotifications, 0);
  assert.equal(harness.discord.posts.length, 1);
  assert.deepEqual(discordRows(harness).map((row) => [row.status, row.attempts, row.last_error]), [["delivered", 1, null]]);
  // A visit that has ended is not posted.
  harness.discord.failures.push({ permission: true });
  await book(harness, { teamNumber: "99902", teamName: "Two", contactEmail: "two@example.org" });
  harness.clock.now = Date.parse("2026-11-03T02:00:00Z");
  const [ended] = (await status(harness)).failures.discord;
  assert.equal(ended.retryable, false);
  assert.equal((await harness.call("POST", `/admin/visits/notifications/${ended.id}/retry`)).status, 409);
});

test("changing the Discord channel or turning Discord off resolves failed posts; other settings do not", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  await enableDiscord(harness);
  harness.discord.failures.push({ permission: true });
  await book(harness);
  const settings = async () => (await harness.call("GET", "/admin/visits/settings")).body;
  await harness.call("PUT", "/admin/visits/settings", { body: { revision: (await settings()).revision, hostName: "FRC 99999 Test Hosts" } });
  assert.equal((await status(harness)).failures.discordCount, 1);
  // The same channel ID saved again is no change.
  await harness.call("PUT", "/admin/visits/settings", { body: { revision: (await settings()).revision, discordChannelId: channel } });
  assert.equal((await status(harness)).failures.discordCount, 1);
  await harness.call("PUT", "/admin/visits/settings", { body: { revision: (await settings()).revision, discordChannelId: "223456789012345678" } });
  assert.equal((await status(harness)).failures.discordCount, 0);
  assert.deepEqual(discordRows(harness).map((row) => [row.status, row.last_error]), [["skipped", resolvedBySettingsNote]]);
  // A resolved post never posts late in the new channel.
  harness.clock.now += 600_000;
  await harness.job();
  assert.equal(harness.discord.posts.length, 0);
  harness.discord.failures.push({ permission: true });
  await book(harness, { teamNumber: "99902", teamName: "Two", contactEmail: "two@example.org" });
  assert.equal((await status(harness)).failures.discordCount, 1);
  await harness.call("PUT", "/admin/visits/settings", { body: { revision: (await settings()).revision, discordEnabled: false } });
  assert.equal((await status(harness)).failures.discordCount, 0);
});

test("a failed weekly summary can be retried for a day after its report time, then only dismissed", async () => {
  const harness = visitsHarness(Date.parse("2026-10-20T12:00:00Z"));
  await enableDiscord(harness);
  // Monday October 26, 12:00 EDT.
  const reportMs = Date.parse("2026-10-26T16:00:00Z");
  harness.clock.now = reportMs;
  harness.discord.failures.push({ permission: true });
  assert.equal((await harness.job()).summary, "queue");
  let [failure] = (await status(harness)).failures.discord;
  assert.equal(failure.kind, "weekly-summary");
  assert.equal(failure.summaryDate, "2026-10-26");
  assert.equal(failure.visit, null);
  assert.equal(failure.retryable, true);
  assert.equal(bannerText(discordFailureBanner(failure, { channelId: channel, admin: true })),
    `The weekly summary for Monday, October 26 wasn't posted to Discord: Discord says the bot is missing a permission in channel ${channel}. Check that it has View Channel and Send Messages there, then retry.`);
  // The job never retries it on its own.
  harness.clock.now = reportMs + 3_600_000;
  await harness.job();
  assert.equal(harness.discord.posts.length, 0);
  // Within the day, Retry posts it.
  harness.clock.now = reportMs + 23 * 3_600_000;
  const retried = await harness.call("POST", `/admin/visits/notifications/${failure.id}/retry`);
  assert.equal(retried.status, 200);
  assert.equal(harness.discord.posts.length, 1);
  assert.match(harness.discord.posts[0]!.body.content, /Guest visits from Monday, October 26/);
  // The next week's summary fails too, and a day later it is out of date.
  const nextReportMs = Date.parse("2026-11-02T17:00:00Z");
  harness.clock.now = nextReportMs;
  harness.discord.failures.push({ permission: true });
  await harness.job();
  harness.clock.now = nextReportMs + 25 * 3_600_000;
  [failure] = (await status(harness)).failures.discord;
  assert.equal(failure.summaryDate, "2026-11-02");
  assert.equal(failure.retryable, false);
  assert.match(bannerText(discordFailureBanner(failure, { channelId: channel, admin: true })), /It's out of date now, so dismiss it\.$/);
  const refused = await harness.call("POST", `/admin/visits/notifications/${failure.id}/retry`);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /out of date/);
  assert.equal((await harness.call("POST", `/admin/visits/notifications/${failure.id}/dismiss`)).status, 200);
  // Dismissed, the date counts as done: the summary is not queued again.
  await harness.job();
  assert.equal(harness.discord.posts.length, 1);
  assert.deepEqual(harness.db.rows("SELECT summary_date, status FROM visits_notifications WHERE kind='weekly-summary' ORDER BY summary_date").map((row) => ({ ...row })), [
    { summary_date: "2026-10-26", status: "delivered" }, { summary_date: "2026-11-02", status: "skipped" },
  ]);
});

test("only failures still waiting on staff count: handled emails, removed visits and replaced sends do not", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  harness.email.failures.push({ status: 422 }, { status: 422 }, { status: 422 });
  const first = await book(harness);
  const second = await book(harness, { teamNumber: "99902", teamName: "Two", contactEmail: "two@example.org" });
  const third = await book(harness, { teamNumber: "99903", teamName: "Three", contactEmail: "three@example.org" });
  let body = await status(harness);
  assert.deepEqual([body.failedNotifications, body.failures.emails, body.failures.outreach, body.failures.discordCount], [3, 3, 0, 0]);
  // Handled, resent, removed.
  assert.equal((await harness.call("POST", `/admin/visits/bookings/${first.id}/handled`)).status, 200);
  assert.equal((await harness.call("POST", `/admin/visits/bookings/${second.id}/resend`)).status, 200);
  const detail = (await harness.call("GET", `/admin/visits/bookings/${third.id}`)).body;
  assert.equal((await harness.call("DELETE", `/admin/visits/bookings/${third.id}?revision=${detail.revision}`)).status, 200);
  body = await status(harness);
  assert.deepEqual([body.failedNotifications, body.failures.emails], [0, 0]);
  // The rows themselves stay failed or skipped as history.
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_notifications WHERE channel='email' AND status='failed'"), 2);
});

test("the status lists the five newest failed Discord posts and counts them all", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  await enableDiscord(harness);
  for (let index = 0; index < 7; index += 1) {
    harness.discord.failures.push({ permission: true });
    await book(harness, { teamNumber: `9991${index}`, teamName: `Team ${index}`, contactEmail: `team${index}@example.org` });
    harness.clock.now += 1_000;
  }
  const body = await status(harness);
  assert.equal(body.failures.discordCount, 7);
  assert.deepEqual(body.failures.discord.map((failure: { visit: { team: { number: string } } }) => failure.visit.team.number), ["99916", "99915", "99914", "99913", "99912"]);
});
