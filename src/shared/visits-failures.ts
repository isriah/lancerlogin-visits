// Why a Discord post failed, so the workspace can say what failed, why and where to fix it. A failed post's last_error
// holds its reason: a missing permission and an unknown channel are stored as a small JSON object with a `discord` code,
// anything else as the provider's message. A channel that is not set never fails: Discord messages cannot be on without
// one (settings and the table refuse it), and posts queued while they were on are skipped once they are off. Rows that failed before these codes existed are read from
// their message. Also the bot's permissions in a channel, worked out the way Discord does, and when Retry may post a
// failed message again. Import-free.

/** Discord permissions a Guest Visits post needs. Posts are plain text with link previews suppressed, so Embed Links is not needed. */
export const discordPermissions = ["view-channel", "send-messages", "send-messages-in-threads"] as const;
export type DiscordPermission = (typeof discordPermissions)[number];
export const discordPermissionLabels: Readonly<Record<DiscordPermission, string>> = {
  "view-channel": "View Channel", "send-messages": "Send Messages", "send-messages-in-threads": "Send Messages in Threads",
};
const permissionBits: Readonly<Record<DiscordPermission, bigint>> = { "view-channel": 1n << 10n, "send-messages": 1n << 11n, "send-messages-in-threads": 1n << 38n };
const administratorBit = 1n << 3n;
/** Discord's thread channel types: their permission overwrites are the parent channel's. */
export const discordThreadTypes: readonly number[] = [10, 11, 12];

/**
 * missing-permissions: Discord refused the post (403: Missing Access or Missing Permissions). `permissions` names what the
 * bot lacks in the channel when Guest Visits could work it out, and is empty when it could not. `channelName` is the
 * channel's name when Discord told the bot, or null. unknown-channel: Discord has no channel with the saved ID (deleted,
 * or the ID is wrong). other: anything else, in the provider's words.
 */
export type DiscordFailureReason =
  | { readonly code: "missing-permissions"; readonly permissions: readonly DiscordPermission[]; readonly channelName: string | null }
  | { readonly code: "unknown-channel" }
  | { readonly code: "other"; readonly message: string };

/** Core's message for a refused Discord request; Core does not pass on the 403 status. */
const permissionMessage = /missing a required permission|missing permissions|missing access|\(403\)/i;
const unknownChannelMessage = /unknown channel|\(404\)/i;

/**
 * Which kind of failure a Discord error is, from its HTTP status, Discord's JSON error code when known (50001 Missing
 * Access, 50013 Missing Permissions, 10003 Unknown Channel) and its message.
 */
export function classifyDiscordError(input: { readonly status: number | undefined; readonly code?: number | undefined; readonly message: string }): "missing-permissions" | "unknown-channel" | "other" {
  if (input.status === 403 || input.code === 50_001 || input.code === 50_013) return "missing-permissions";
  if (input.status === 404 || input.code === 10_003) return "unknown-channel";
  if (input.status === undefined && permissionMessage.test(input.message)) return "missing-permissions";
  if (input.status === undefined && unknownChannelMessage.test(input.message)) return "unknown-channel";
  return "other";
}

/** The last_error stored for a failure, at most 500 characters. */
export function encodeDiscordFailure(reason: DiscordFailureReason): string {
  if (reason.code === "other") return reason.message.slice(0, 500);
  if (reason.code !== "missing-permissions") return JSON.stringify({ discord: reason.code });
  return JSON.stringify({ discord: reason.code, permissions: reason.permissions, channel: reason.channelName === null ? null : reason.channelName.slice(0, 100) });
}

/** A failed Discord post's reason, from its last_error. */
export function decodeDiscordFailure(lastError: string | null): DiscordFailureReason {
  const text = lastError ?? "";
  if (text.startsWith("{")) {
    try {
      const value = JSON.parse(text) as { discord?: unknown; permissions?: unknown; channel?: unknown };
      if (value.discord === "unknown-channel") return { code: value.discord };
      if (value.discord === "missing-permissions") {
        const permissions = Array.isArray(value.permissions) ? discordPermissions.filter((permission) => (value.permissions as unknown[]).includes(permission)) : [];
        return { code: "missing-permissions", permissions, channelName: typeof value.channel === "string" && value.channel ? value.channel : null };
      }
    } catch {
      // Not one of Guest Visits' codes: read it as a message.
    }
  }
  const kind = classifyDiscordError({ status: undefined, message: text });
  if (kind === "missing-permissions") return { code: kind, permissions: [], channelName: null };
  if (kind === "unknown-channel") return { code: kind };
  return { code: "other", message: text || "Discord did not say why" };
}

type Overwrite = { readonly id?: unknown; readonly type?: unknown; readonly allow?: unknown; readonly deny?: unknown };
const bits = (value: unknown): bigint => {
  try { return typeof value === "string" || typeof value === "number" ? BigInt(value) : 0n; } catch { return 0n; }
};

/**
 * What the bot lacks to post in a channel, by Discord's rules: the server's @everyone role and the bot's roles, then the
 * channel's overwrites for @everyone, for the bot's roles and for the bot itself. A thread uses its parent's overwrites
 * and needs Send Messages in Threads instead of Send Messages. Administrator has every permission.
 */
export function missingDiscordPermissions(input: {
  readonly guildId: string;
  readonly botId: string;
  readonly botRoleIds: readonly string[];
  readonly roles: readonly { readonly id: string; readonly permissions?: unknown }[];
  readonly channelType: number;
  readonly overwrites: readonly Overwrite[];
}): DiscordPermission[] {
  const roleIds = new Set(input.botRoleIds);
  let permissions = bits(input.roles.find((role) => role.id === input.guildId)?.permissions);
  for (const role of input.roles) if (roleIds.has(role.id)) permissions |= bits(role.permissions);
  if (permissions & administratorBit) return [];
  const apply = (allow: bigint, deny: bigint) => { permissions = (permissions & ~deny) | allow; };
  const everyone = input.overwrites.find((overwrite) => overwrite.id === input.guildId);
  if (everyone) apply(bits(everyone.allow), bits(everyone.deny));
  let allow = 0n;
  let deny = 0n;
  for (const overwrite of input.overwrites) {
    if (Number(overwrite.type) !== 0 || typeof overwrite.id !== "string" || !roleIds.has(overwrite.id)) continue;
    allow |= bits(overwrite.allow);
    deny |= bits(overwrite.deny);
  }
  apply(allow, deny);
  const member = input.overwrites.find((overwrite) => Number(overwrite.type) === 1 && overwrite.id === input.botId);
  if (member) apply(bits(member.allow), bits(member.deny));
  const needed: DiscordPermission[] = ["view-channel", discordThreadTypes.includes(input.channelType) ? "send-messages-in-threads" : "send-messages"];
  return needed.filter((permission) => !(permissions & permissionBits[permission]));
}

/** How long after its report time a failed weekly summary may still be posted by Retry. Later it is out of date. */
export const summaryRetryWindowMs = 86_400_000;

/**
 * Whether Retry may post a failed message again: a booking post while its visit has not ended, a weekly summary within a
 * day of its report time and before the next one. Otherwise staff can only dismiss it.
 */
export function canRetryDiscordPost(input: { readonly kind: string; readonly now: number; readonly departureMs?: number | null; readonly summary?: { readonly reportMs: number; readonly nextReportMs: number } | null }): boolean {
  if (input.kind === "weekly-summary") return Boolean(input.summary) && input.now < Math.min(input.summary!.reportMs + summaryRetryWindowMs, input.summary!.nextReportMs);
  return typeof input.departureMs === "number" && input.now < input.departureMs;
}

/** The note on failed Discord posts a settings change resolved, and on dismissed ones. */
export const resolvedBySettingsNote = "Resolved: Guest Visits Discord settings changed after this post failed";
export const dismissedNote = "Dismissed by an Admin";
