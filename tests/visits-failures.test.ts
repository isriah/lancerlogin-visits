// Why a Discord post failed: classifying Core's errors, the reason stored in last_error, the bot's permissions in a
// channel, when Retry may post again, and the banner's words for each case.
import test from "node:test";
import assert from "node:assert/strict";
import type { DiscordFailure } from "../src/shared/visits-api.ts";
import {
  canRetryDiscordPost, classifyDiscordError, decodeDiscordFailure, encodeDiscordFailure, missingDiscordPermissions, summaryRetryWindowMs,
} from "../src/shared/visits-failures.ts";
import { bannerText, bookingFailureBanners, discordFailureBanner, moreDiscordFailuresText } from "../src/dashboard/visits-labels.ts";
import { coreDiscordPermissionMessage } from "./helpers/visits-harness.ts";

const guildId = "900000000000000001";
const botId = "900000000000000002";
const view = String(1n << 10n);
const send = String(1n << 11n);
const viewAndSend = String((1n << 10n) | (1n << 11n));

test("Core's Discord errors are classified by status, Discord's code or Core's message", () => {
  // Core reports every 403 as its own error, without the status.
  assert.equal(classifyDiscordError({ status: undefined, message: coreDiscordPermissionMessage }), "missing-permissions");
  assert.equal(classifyDiscordError({ status: 403, message: "" }), "missing-permissions");
  assert.equal(classifyDiscordError({ status: undefined, code: 50_013, message: "" }), "missing-permissions");
  assert.equal(classifyDiscordError({ status: undefined, code: 50_001, message: "" }), "missing-permissions");
  assert.equal(classifyDiscordError({ status: 404, code: 10_003, message: "Discord rejected the request (404): Unknown Channel" }), "unknown-channel");
  assert.equal(classifyDiscordError({ status: undefined, message: "Discord rejected the request (404): Unknown Channel" }), "unknown-channel");
  assert.equal(classifyDiscordError({ status: 400, code: 50_035, message: "Discord rejected the request (400): Invalid Form Body" }), "other");
  assert.equal(classifyDiscordError({ status: 500, message: "Discord rejected the request (500)" }), "other");
  // A status wins over words in the message.
  assert.equal(classifyDiscordError({ status: 500, message: "Missing Access somewhere upstream" }), "other");
  assert.equal(classifyDiscordError({ status: undefined, message: "The connection closed before Discord answered" }), "other");
});

test("the reason round-trips through last_error, and rows from before the codes are read from their message", () => {
  const permission = { code: "missing-permissions", permissions: ["view-channel", "send-messages"], channelName: "guest-visits" } as const;
  assert.deepEqual(decodeDiscordFailure(encodeDiscordFailure(permission)), permission);
  assert.deepEqual(decodeDiscordFailure(encodeDiscordFailure({ code: "missing-permissions", permissions: [], channelName: null })), { code: "missing-permissions", permissions: [], channelName: null });
  assert.deepEqual(decodeDiscordFailure(encodeDiscordFailure({ code: "unknown-channel" })), { code: "unknown-channel" });
  assert.equal(encodeDiscordFailure({ code: "other", message: "Discord rejected the request (400): Invalid Form Body" }), "Discord rejected the request (400): Invalid Form Body");
  assert.deepEqual(decodeDiscordFailure("Discord rejected the request (400): Invalid Form Body"), { code: "other", message: "Discord rejected the request (400): Invalid Form Body" });
  // The live row's text, stored before Guest Visits kept a code.
  assert.deepEqual(decodeDiscordFailure(coreDiscordPermissionMessage), { code: "missing-permissions", permissions: [], channelName: null });
  assert.deepEqual(decodeDiscordFailure(null), { code: "other", message: "Discord did not say why" });
  // Unknown permissions and malformed JSON are not trusted.
  assert.deepEqual(decodeDiscordFailure('{"discord":"missing-permissions","permissions":["administrator","send-messages"],"channel":5}'), { code: "missing-permissions", permissions: ["send-messages"], channelName: null });
  assert.deepEqual(decodeDiscordFailure("{not json"), { code: "other", message: "{not json" });
  assert.ok(encodeDiscordFailure({ ...permission, channelName: "x".repeat(400) }).length <= 500);
});

test("the bot's missing permissions follow Discord's order: roles, then @everyone, role and member overwrites", () => {
  const roles = [{ id: guildId, permissions: viewAndSend }, { id: "role-bot", permissions: "0" }, { id: "role-other", permissions: "0" }];
  const base = { guildId, botId, botRoleIds: ["role-bot"], roles, channelType: 0 };
  assert.deepEqual(missingDiscordPermissions({ ...base, overwrites: [] }), []);
  // @everyone denied Send Messages in the channel.
  assert.deepEqual(missingDiscordPermissions({ ...base, overwrites: [{ id: guildId, type: 0, allow: "0", deny: send }] }), ["send-messages"]);
  // The bot's role allows it back; another role's allow does not count.
  assert.deepEqual(missingDiscordPermissions({ ...base, overwrites: [{ id: guildId, type: 0, allow: "0", deny: send }, { id: "role-bot", type: 0, allow: send, deny: "0" }] }), []);
  assert.deepEqual(missingDiscordPermissions({ ...base, overwrites: [{ id: guildId, type: 0, allow: "0", deny: send }, { id: "role-other", type: 0, allow: send, deny: "0" }] }), ["send-messages"]);
  // A private channel: @everyone cannot view it, and a member overwrite for the bot beats its roles.
  assert.deepEqual(missingDiscordPermissions({ ...base, overwrites: [{ id: guildId, type: 0, allow: "0", deny: view }] }), ["view-channel"]);
  assert.deepEqual(missingDiscordPermissions({ ...base, overwrites: [{ id: guildId, type: 0, allow: "0", deny: viewAndSend }, { id: botId, type: 1, allow: viewAndSend, deny: "0" }] }), []);
  assert.deepEqual(missingDiscordPermissions({ ...base, overwrites: [{ id: botId, type: 1, allow: "0", deny: viewAndSend }] }), ["view-channel", "send-messages"]);
  // No permissions from roles at all; Administrator has every permission whatever the overwrites say.
  assert.deepEqual(missingDiscordPermissions({ ...base, roles: [{ id: guildId, permissions: "0" }], overwrites: [] }), ["view-channel", "send-messages"]);
  assert.deepEqual(missingDiscordPermissions({ ...base, roles: [{ id: guildId, permissions: "0" }, { id: "role-bot", permissions: "8" }], overwrites: [{ id: botId, type: 1, allow: "0", deny: viewAndSend }] }), []);
  // A thread needs Send Messages in Threads.
  assert.deepEqual(missingDiscordPermissions({ ...base, channelType: 11, overwrites: [] }), ["send-messages-in-threads"]);
});

test("Retry may post a booking post until its visit ends, and a weekly summary within a day of its report time", () => {
  const reportMs = Date.parse("2026-11-01T17:00:00Z");
  const summary = { reportMs, nextReportMs: reportMs + 7 * 86_400_000 };
  assert.equal(canRetryDiscordPost({ kind: "weekly-summary", now: reportMs + 60_000, summary }), true);
  assert.equal(canRetryDiscordPost({ kind: "weekly-summary", now: reportMs + summaryRetryWindowMs - 1, summary }), true);
  assert.equal(canRetryDiscordPost({ kind: "weekly-summary", now: reportMs + summaryRetryWindowMs, summary }), false);
  // A summary rescheduled to a day later never retries past its next report.
  assert.equal(canRetryDiscordPost({ kind: "weekly-summary", now: reportMs + 3_600_000, summary: { reportMs, nextReportMs: reportMs + 3_600_000 } }), false);
  assert.equal(canRetryDiscordPost({ kind: "weekly-summary", now: reportMs, summary: null }), false);
  assert.equal(canRetryDiscordPost({ kind: "booked", now: 1_000, departureMs: 2_000 }), true);
  assert.equal(canRetryDiscordPost({ kind: "canceled", now: 2_000, departureMs: 2_000 }), false);
  assert.equal(canRetryDiscordPost({ kind: "changed", now: 1_000, departureMs: null }), false);
});

const failure = (overrides: Partial<DiscordFailure>): DiscordFailure => ({
  id: "notification-1", kind: "weekly-summary", summaryDate: "2026-11-01", visit: null, failedMs: 0, retryable: true,
  reason: { code: "missing-permissions", permissions: [], channelName: null }, ...overrides,
});
const admin = { channelId: "123456789012345678", admin: true };
const operator = { channelId: "123456789012345678", admin: false };
const text = (value: DiscordFailure, context = admin) => bannerText(discordFailureBanner(value, context));

test("a failed Discord post's banner names what failed, why, and where to fix it", () => {
  // Permissions Guest Visits worked out from Discord, in the channel it named.
  assert.equal(text(failure({ reason: { code: "missing-permissions", permissions: ["send-messages"], channelName: "guest-visits" } })),
    "The weekly summary for Sunday, November 1 wasn't posted to Discord: the bot is missing Send Messages in #guest-visits. Give it that permission in Discord, then retry.");
  assert.equal(text(failure({ reason: { code: "missing-permissions", permissions: ["view-channel", "send-messages"], channelName: null } })),
    "The weekly summary for Sunday, November 1 wasn't posted to Discord: the bot is missing View Channel and Send Messages in channel 123456789012345678. Give it those permissions in Discord, then retry.");
  // Permissions it could not work out: say which to check, no more.
  assert.equal(text(failure({})),
    "The weekly summary for Sunday, November 1 wasn't posted to Discord: Discord says the bot is missing a permission in channel 123456789012345678. Check that it has View Channel and Send Messages there, then retry.");
  assert.equal(text(failure({ retryable: false })),
    "The weekly summary for Sunday, November 1 wasn't posted to Discord: Discord says the bot is missing a permission in channel 123456789012345678. Check that it has View Channel and Send Messages there. It's out of date now, so dismiss it.");
  assert.equal(text(failure({}), operator),
    "The weekly summary for Sunday, November 1 wasn't posted to Discord: Discord says the bot is missing a permission in channel 123456789012345678. Check that it has View Channel and Send Messages there. Ask an Admin to fix this.");
  // A booking post names the visit.
  const visit = { team: { number: "99934", name: "Testheads", program: "FRC" as const }, date: "2026-11-02" };
  assert.equal(text(failure({ kind: "booked", summaryDate: null, visit, reason: { code: "unknown-channel" }, retryable: false })),
    "The Discord post about a new visit by FRC 99934 Testheads on Monday, November 2 wasn't posted to Discord: Discord can't find channel 123456789012345678. It may have been deleted, or the ID is wrong. Choose a channel in Settings > Guest Visits > Discord.");
  const canceled = discordFailureBanner(failure({ kind: "canceled", summaryDate: null, visit: null, reason: { code: "unknown-channel" }, retryable: false }), { channelId: "", admin: false });
  assert.equal(bannerText(canceled), "The Discord post about a canceled visit wasn't posted to Discord: Discord can't find the Guest Visits channel. It may have been deleted, or the ID is wrong. An Admin can choose one in Settings > Guest Visits > Discord.");
  assert.deepEqual(canceled.find((part) => typeof part !== "string"), { link: "discord-settings", label: "Settings > Guest Visits > Discord" });
  // Anything else keeps the provider's words.
  assert.equal(text(failure({ kind: "changed", summaryDate: null, visit, reason: { code: "other", message: "Discord rejected the request (400): Invalid Form Body" } })),
    "The Discord post about a changed visit by FRC 99934 Testheads on Monday, November 2 wasn't posted to Discord: Discord rejected the request (400): Invalid Form Body. Retry, or dismiss it.");
});

test("failed booking emails and Outreach records point to Needs attention, and older Discord failures are counted", () => {
  assert.deepEqual(bookingFailureBanners({ emails: 0, outreach: 0 }), []);
  assert.deepEqual(bookingFailureBanners({ emails: 1, outreach: 2 }).map((banner) => [banner.key, bannerText(banner.parts)]), [
    ["failed-emails", "A booking email failed to send. Its visit is in Needs attention."],
    ["failed-outreach", "2 visits couldn't be recorded in Outreach. They're in Needs attention."],
  ]);
  assert.equal(bannerText(bookingFailureBanners({ emails: 3, outreach: 0 })[0]!.parts), "3 booking emails failed to send. Their visits are in Needs attention.");
  assert.equal(moreDiscordFailuresText({ discordCount: 1, discord: [failure({})] }), null);
  assert.equal(moreDiscordFailuresText({ discordCount: 7, discord: [failure({}), failure({ id: "2" })] }), "5 older failed Discord posts aren't shown. Changing the Discord channel in settings resolves them all.");
});
