// The Outreach link: which of Outreach's interfaces Guest Visits calls, what a visit's Outreach state is, and how the
// provider's answers are read. Outreach's `hour-tracking.team-support` interface finds or creates supported teams and
// Team Support activities; Guest Visits keeps the returned IDs as plain references and never reads Outreach's tables.
// Import-free apart from siblings.
import type { VisitProgram } from "./visits-booking.ts";

export const outreachInterfaceId = "hour-tracking.team-support";
export const outreachInterfaceVersion = 1;
export const outreachOperations = ["find-teams", "ensure-team", "ensure-team-support-activity"] as const;
export type OutreachOperation = (typeof outreachOperations)[number];

/** The manifest's `uses` entry. Optional: without Outreach, or without a grant, Guest Visits works without it. */
export const outreachUse = {
  interface: outreachInterfaceId,
  version: outreachInterfaceVersion,
  operations: outreachOperations,
  required: false,
  reason: "Record guest visits as Outreach team support",
} as const;

/** Visits one Record in Outreach request records at once. */
export const maximumOutreachRecordBatch = 50;

/** Outreach IDs Guest Visits stores: the migration allows 1 to 100 characters. */
export function isOutreachId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 100;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The first active team of a `find-teams` answer, or null when there is none. Undefined when the answer cannot be read. */
export function firstActiveTeam(answer: unknown): string | null | undefined {
  if (!record(answer) || !Array.isArray(answer.teams)) return undefined;
  for (const team of answer.teams) {
    if (!record(team) || !isOutreachId(team.id) || typeof team.archived !== "boolean") return undefined;
    if (!team.archived) return team.id;
  }
  return null;
}

/** The team ID of an `ensure-team` answer, or undefined when it cannot be read. */
export function ensuredTeam(answer: unknown): string | undefined {
  return record(answer) && record(answer.team) && isOutreachId(answer.team.id) ? answer.team.id : undefined;
}

/** The activity of an `ensure-team-support-activity` answer, or undefined when it cannot be read. */
export function ensuredActivity(answer: unknown): { readonly activityId: string; readonly created: boolean } | undefined {
  return record(answer) && isOutreachId(answer.activityId) && typeof answer.created === "boolean" ? { activityId: answer.activityId, created: answer.created } : undefined;
}

/** A visit's Outreach state as staff see it. */
export type OutreachState = { readonly state: "pending" | "recorded" | "failed"; readonly activityId: string | null; readonly error?: string };

/** What a paused Outreach record says: a restore paused it, and nothing records it until staff ask again. */
export const outreachPausedMessage = "A backup restore paused this record. Use Record in Outreach to record the visit again.";

/**
 * A visit's Outreach state from its stored activity and its latest Outreach record. Null for teams with program Other and
 * for visits Outreach was never involved with. A record waiting or being sent is pending; a failed one is failed, also
 * after staff marked it handled; a paused one needs Record in Outreach again. Otherwise a stored activity means
 * recorded.
 */
export function outreachState(input: {
  readonly program: VisitProgram;
  readonly activityId: string | null;
  readonly status: string | null;
  readonly error: string | null;
  readonly handled: boolean;
}): OutreachState | null {
  if (input.program === "Other") return null;
  const { activityId, error } = input;
  if (input.status === "pending" || input.status === "sending") return { state: "pending", activityId, ...(error ? { error } : {}) };
  if (input.status === "failed" || (input.status === "skipped" && input.handled)) return { state: "failed", activityId, error: error ?? "Outreach did not record this visit" };
  if (input.status === "paused") return { state: "failed", activityId, error: outreachPausedMessage };
  return activityId ? { state: "recorded", activityId } : null;
}
