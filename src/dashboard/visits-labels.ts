// Plain-language labels for the staff workspace: email and Outreach states, why a visit needs attention, change history
// and guest team lists. Plain functions over src/shared, so `npm test` covers them without React.
import type { AttentionReason, FieldChange, TeamIdentity } from "../shared/visits-booking.ts";
import { programLabels, programShortLabels, visitPrograms, type VisitProgram } from "../shared/visits-booking.ts";
import type { BookingHistoryEntry, EmailState, StaffBooking, StaffTeam } from "../shared/visits-api.ts";
import { formatInstant, peopleText } from "./visits-local.ts";

/** Tones match Core's `ui-status` data-tone values. */
export type Tone = "neutral" | "success" | "warning" | "error";
export type Badge = { readonly label: string; readonly tone: Tone };

/** "FRC 321 Lancers". */
export function teamText(team: TeamIdentity): string {
  return `${programShortLabels[team.program]} ${team.number} ${team.name}`;
}

/** Program choices for a select, in the contract's order. */
export const programChoices: readonly { readonly value: VisitProgram; readonly label: string }[] = visitPrograms.map((value) => ({ value, label: programLabels[value] }));

export const emailStateBadges: Readonly<Record<EmailState, Badge>> = {
  none: { label: "No email", tone: "neutral" },
  pending: { label: "Email waiting to send", tone: "neutral" },
  sent: { label: "Email sent", tone: "success" },
  failed: { label: "Email failed", tone: "error" },
  capped: { label: "Email waiting: daily limit", tone: "warning" },
};

export const attentionReasonText: Readonly<Record<AttentionReason, string>> = {
  "window-canceled": "Its window was canceled. Contact the team to move or cancel the visit.",
  "window-removed": "Its window was removed. Contact the team to move or cancel the visit.",
  "window-changed": "Its window changed and the visit no longer fits. Contact the team to change the times.",
  "outreach-activity-kept": "It was recorded in Outreach before it was canceled or moved. The earlier Outreach activity stays, since members may have logged hours to it.",
};

/** The Outreach state of a visit, when Outreach is involved. */
export function outreachBadge(outreach: StaffBooking["outreach"]): Badge | null {
  if (!outreach) return null;
  if (outreach.state === "recorded") return { label: "Recorded in Outreach", tone: "success" };
  if (outreach.state === "failed") return { label: "Outreach record failed", tone: "error" };
  return { label: "Outreach record waiting", tone: "neutral" };
}

/** Status badges for a visit card, most important first. */
export function bookingBadges(booking: Pick<StaffBooking, "status" | "attention" | "email" | "outreach">, outreachAvailable: boolean): Badge[] {
  const badges: Badge[] = [];
  if (booking.status === "canceled") badges.push({ label: "Canceled", tone: "neutral" });
  if (booking.attention.state === "needed") badges.push({ label: "Needs attention", tone: "warning" });
  if (booking.attention.state === "handled") badges.push({ label: "Handled", tone: "neutral" });
  badges.push(emailStateBadges[booking.email]);
  const outreach = outreachAvailable ? outreachBadge(booking.outreach) : null;
  if (outreach) badges.push(outreach);
  return badges;
}

/** Why a visit is in Needs attention: its attention reason, a failed or held confirmation, a failed Outreach record. */
export function attentionNotes(booking: Pick<StaffBooking, "attention" | "email" | "outreach">): string[] {
  const notes: string[] = [];
  if (booking.attention.state === "needed" && booking.attention.reason) notes.push(attentionReasonText[booking.attention.reason]);
  if (booking.email === "failed") notes.push("The latest email to the team failed. Check the address, then resend the confirmation.");
  if (booking.email === "capped") notes.push("The latest email waits because this address reached its daily limit of Guest Visits emails. It sends tomorrow.");
  if (booking.outreach?.state === "failed") notes.push(`Recording in Outreach failed${booking.outreach.error ? `: ${booking.outreach.error}` : ""}. It retries; Record in Outreach queues it again.`);
  return notes;
}

/** Whether Mark handled applies: only a visit whose attention reason still needs handling. */
export function canMarkHandled(booking: Pick<StaffBooking, "attention">): boolean {
  return booking.attention.state === "needed" && booking.attention.reason !== null;
}

const actionText: Readonly<Record<string, string>> = { created: "Booked", updated: "Changed", canceled: "Canceled", restored: "Restored", removed: "Removed" };

/** "Booked", "Changed", or the action itself with a capital letter. */
export function historyActionText(action: string): string {
  return actionText[action] ?? (action ? `${action[0]!.toUpperCase()}${action.slice(1)}` : "Changed");
}

/** Who made a change. Guests book on the guest page and change or cancel through the emailed link. */
export function historyActorText(actor: BookingHistoryEntry["actor"], action = ""): string {
  if (actor.kind === "guest") return action === "created" ? "The team, on the guest page" : "The team, through the emailed link";
  return actor.name ? `Staff: ${actor.name}` : "Staff";
}

const fieldText: Readonly<Record<FieldChange["field"], string>> = {
  windowId: "Window", teamId: "Team", contactName: "Contact name", contactEmail: "Email", contactPhone: "Phone", arrivalMs: "Arrival",
  departureMs: "Departure", headcount: "People", note: "Note", status: "Status",
};

const valueText = (value: string | number) => {
  const text = String(value);
  return text === "" ? "(empty)" : text;
};

/**
 * One history change in words: "People: 4 to 6". Arrival and departure instants read in the time zone; teams by name when
 * the list has them; window IDs only say that the window changed.
 */
export function describeChange(change: FieldChange, context: { readonly timeZone: string; readonly teamName?: (id: string) => string | undefined }): string {
  const label = fieldText[change.field] ?? change.field;
  if (change.field === "windowId") return "Moved to another window";
  if (change.field === "arrivalMs" || change.field === "departureMs") {
    const read = (value: string | number) => typeof value === "number" ? formatInstant(value, context.timeZone) : valueText(value);
    return `${label}: ${read(change.from)} to ${read(change.to)}`;
  }
  if (change.field === "teamId") {
    const name = (value: string | number) => context.teamName?.(String(value)) ?? "another team";
    return `${label}: ${name(change.from)} to ${name(change.to)}`;
  }
  if (change.field === "headcount") return `${label}: ${typeof change.from === "number" ? peopleText(change.from) : valueText(change.from)} to ${typeof change.to === "number" ? peopleText(change.to) : valueText(change.to)}`;
  if (change.field === "status") return `${label}: ${change.from === "canceled" ? "canceled" : "booked"} to ${change.to === "canceled" ? "canceled" : "booked"}`;
  return `${label}: ${valueText(change.from)} to ${valueText(change.to)}`;
}

/** History newest first. The newest entry is the visit as it is now, so only older entries can be restored. */
export function historyNewestFirst(history: readonly BookingHistoryEntry[]): { readonly entry: BookingHistoryEntry; readonly restorable: boolean }[] {
  return [...history].sort((left, right) => right.atMs - left.atMs).map((entry, index) => ({ entry, restorable: index > 0 }));
}

/** Guest teams by program (in the contract's order), then number and name. */
export function sortTeams<Team extends TeamIdentity>(teams: readonly Team[]): Team[] {
  const programIndex = (program: VisitProgram) => visitPrograms.indexOf(program);
  const numeric = (number: string) => /^\d+$/.test(number) ? Number(number) : Number.POSITIVE_INFINITY;
  return [...teams].sort((left, right) => programIndex(left.program) - programIndex(right.program) || numeric(left.number) - numeric(right.number)
    || left.number.localeCompare(right.number) || left.name.localeCompare(right.name));
}

/** Teams another team may merge into: the same program, not archived, not itself. */
export function mergeTargets(teams: readonly StaffTeam[], team: Pick<StaffTeam, "id" | "program">): StaffTeam[] {
  return sortTeams(teams.filter((candidate) => candidate.id !== team.id && candidate.program === team.program && !candidate.archived));
}

/** Upcoming visits soonest first; past visits most recent first. */
export function sortBookings<Booking extends Pick<StaffBooking, "arrivalMs" | "departureMs">>(bookings: readonly Booking[], scope: "upcoming" | "past" | "attention"): Booking[] {
  const direction = scope === "past" ? -1 : 1;
  return [...bookings].sort((left, right) => direction * (left.arrivalMs - right.arrivalMs || left.departureMs - right.departureMs));
}
