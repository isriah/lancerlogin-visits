// The Outreach link. Once an Admin grants Guest Visits access to Outreach, a booking, or a change of its date or team,
// queues an Outreach record in visits_notifications in the same batch as the change. The visits.notifications job (or
// Record in Outreach) does the work: it links the guest team to an Outreach supported team (the stored link, else the
// first active team with that number and program, else a new one) and then finds or creates the Team Support activity
// for the visit's local date. Every Outreach operation is idempotent, so a retry after an unclear failure changes
// nothing. The returned IDs are plain references, stored afterwards and only while the visit still has that date and
// team. Guest Visits never reads Outreach's tables.
import type { D1Database, D1Statement } from "@lancerlogin/module-sdk/api";
import { outreachActivityKeptAttention, outreachProgram, type Attention, type BookingDetails, type OutreachProgram, type VisitProgram } from "../shared/visits-booking.ts";
import { ensuredActivity, ensuredTeam, firstActiveTeam } from "../shared/visits-outreach.ts";
import { addDays, localInstant, localMoment } from "../shared/visits-time.ts";
import { attentionOf, installationId, iso, type BookingRow, type VisitsDeps, type VisitsOutreachClient } from "./visits-runtime.ts";

/**
 * Whether an Admin's grant lets Guest Visits record in Outreach on its own, which decides whether changes queue Outreach
 * records, and the client for this request. Where no one is signed in (guest requests and the job) a client can only
 * come from a grant, so the answer is current and the stored copy in visits_settings follows it; `checked` also stamps
 * the time, as the job does on every pass. In a workspace request a client may come from the staff member's own
 * Outreach access instead, so the stored copy answers there, except that no client at all means there is no grant.
 */
export async function outreachAccess(db: D1Database, deps: VisitsDeps, now: number, options: { readonly checked?: boolean } = {}): Promise<{ readonly client: VisitsOutreachClient | undefined; readonly granted: boolean }> {
  const [client, row] = await Promise.all([
    deps.outreach.client(),
    db.prepare("SELECT outreach_granted FROM visits_settings WHERE installation_id=?").bind(installationId).first<{ outreach_granted: number }>(),
  ]);
  const stored = row?.outreach_granted === 1;
  const granted = Boolean(client) && (deps.outreach.grantOnly || stored);
  if (granted !== stored || (options.checked && deps.outreach.grantOnly)) {
    await db.prepare("UPDATE visits_settings SET outreach_granted=?,outreach_checked_ms=? WHERE installation_id=?").bind(granted ? 1 : 0, now, installationId).run();
  }
  return { client, granted };
}

/**
 * A statement queueing the visit's Outreach record, due now. A record already waiting stays the only one; `dueNow` makes
 * it due at once instead of after its retry delay.
 */
export function queueOutreachStatement(db: D1Database, bookingId: string, now: number, options: { readonly dueNow?: boolean } = {}): D1Statement {
  const conflict = options.dueNow ? "DO UPDATE SET next_attempt_ms=min(next_attempt_ms,excluded.next_attempt_ms),updated_at=excluded.updated_at" : "DO NOTHING";
  return db.prepare(`INSERT INTO visits_notifications(installation_id,id,channel,kind,booking_id,payload_json,status,attempts,next_attempt_ms,created_at,updated_at)
    VALUES(?,?,'outreach','outreach-record',?,'{}','pending',0,?,?,?) ON CONFLICT(installation_id,booking_id) WHERE channel='outreach' AND status='pending' ${conflict}`)
    .bind(installationId, crypto.randomUUID(), bookingId, now, iso(now), iso(now));
}

/** What a change to a visit means for Outreach: queue a record, forget the stored activity, and the attention after it. */
export type OutreachChange = { readonly queue: boolean; readonly clearActivity: boolean; readonly attention: Attention };

/**
 * A visit recorded in Outreach that is canceled keeps its activity, and one that moves to another local date or team
 * keeps the earlier activity in Outreach but no longer refers to it. Both need attention, since members may have logged
 * hours to that activity. A visit that becomes booked, or moves to another date or team, is recorded (again) when an
 * Admin's grant allows it, unless its team's program is Other. A removed visit is hidden, so it gets no attention.
 */
export async function outreachChange(db: D1Database, deps: VisitsDeps, input: {
  readonly current: BookingRow;
  readonly next: BookingDetails;
  readonly removed: boolean;
  readonly attention: Attention;
  readonly now: number;
}): Promise<OutreachChange> {
  const { current, next } = input;
  const currentActive = current.status === "booked" && current.removed === 0;
  const nextActive = next.status === "booked" && !input.removed;
  const recorded = current.outreach_activity_id !== null;
  let moved = current.team_id !== next.teamId;
  if (!moved && current.arrival_ms !== next.arrivalMs) {
    const timeZone = await deps.timeZone();
    moved = localMoment(deps.civil, timeZone, current.arrival_ms).date !== localMoment(deps.civil, timeZone, next.arrivalMs).date;
  }
  let attention = input.attention;
  let clearActivity = false;
  if (recorded && currentActive && !nextActive && !input.removed) attention = outreachActivityKeptAttention(attention);
  if (recorded && nextActive && moved) {
    clearActivity = true;
    attention = outreachActivityKeptAttention(attention);
  }
  let queue = nextActive && (moved || (!currentActive && !recorded));
  if (queue) {
    const team = await db.prepare("SELECT program FROM visits_teams WHERE installation_id=? AND id=?").bind(installationId, next.teamId).first<{ program: VisitProgram }>();
    queue = Boolean(team && outreachProgram(team.program)) && (await outreachAccess(db, deps, input.now)).granted;
  }
  return { queue, clearActivity, attention };
}

/** How one Outreach record ended, in the notification outcome's terms. */
export type OutreachOutcome =
  | { readonly status: "delivered"; readonly externalId: string }
  | { readonly status: "skipped"; readonly note: string }
  | { readonly status: "retry"; readonly error: string; readonly permanent?: boolean };

type OutreachBooking = Pick<BookingRow, "id" | "status" | "removed" | "arrival_ms" | "team_id" | "attention" | "attention_reason"> & {
  number: string; name: string; program: VisitProgram; outreach_team_id: string | null;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300) || "Outreach did not say why";
const unreadable = (operation: string) => new Error(`Outreach answered ${operation} in a form Guest Visits cannot read`);

/** The supported team for a guest team: the first active one with its number and program, else a new one. Stores the link. */
async function linkTeam(db: D1Database, client: VisitsOutreachClient, booking: OutreachBooking, program: OutreachProgram, now: number): Promise<string> {
  let teamId = firstActiveTeam(await client.call("find-teams", { number: booking.number, program }));
  if (teamId === undefined) throw unreadable("find-teams");
  if (teamId === null) {
    teamId = ensuredTeam(await client.call("ensure-team", { number: booking.number, name: booking.name, program }));
    if (!teamId) throw unreadable("ensure-team");
  }
  await db.prepare("UPDATE visits_teams SET outreach_team_id=?,updated_at=? WHERE installation_id=? AND id=? AND program!='Other'").bind(teamId, iso(now), installationId, booking.team_id).run();
  return teamId;
}

async function ensureActivity(client: VisitsOutreachClient, teamId: string, serviceDate: string) {
  const activity = ensuredActivity(await client.call("ensure-team-support-activity", { teamId, serviceDate }));
  if (!activity) throw unreadable("ensure-team-support-activity");
  return activity;
}

/**
 * Record one visit in Outreach as Team Support on its local date. Canceled, removed and program Other visits are not
 * recorded. A stored team link that Outreach no longer has (404) or refuses (409, for example an archived team) is looked
 * up again once. Outreach's refusals (4xx other than 408 and 429) are permanent; anything else is retried. The activity
 * is stored only while the visit is still booked on that date with that team; when it changed meanwhile, a newer record
 * follows the change, and an activity this attempt created gets the visit Outreach attention.
 */
export async function recordInOutreach(db: D1Database, deps: VisitsDeps, client: VisitsOutreachClient, bookingId: string | null, now: number): Promise<OutreachOutcome> {
  const booking = bookingId ? await db.prepare(`SELECT b.id,b.status,b.removed,b.arrival_ms,b.team_id,b.attention,b.attention_reason,t.number,t.name,t.program,t.outreach_team_id
    FROM visits_bookings b JOIN visits_teams t ON t.installation_id=b.installation_id AND t.id=b.team_id WHERE b.installation_id=? AND b.id=?`).bind(installationId, bookingId).first<OutreachBooking>() : null;
  if (!booking) return { status: "skipped", note: "This visit no longer exists" };
  if (booking.removed === 1) return { status: "skipped", note: "This visit was removed" };
  if (booking.status !== "booked") return { status: "skipped", note: "Canceled visits are not recorded in Outreach" };
  const program = outreachProgram(booking.program);
  if (!program) return { status: "skipped", note: "Outreach does not support teams with program Other" };
  const timeZone = await deps.timeZone();
  const date = localMoment(deps.civil, timeZone, booking.arrival_ms).date;
  let activity: { readonly activityId: string; readonly created: boolean };
  try {
    const linked = booking.outreach_team_id;
    const teamId = linked ?? await linkTeam(db, client, booking, program, now);
    try {
      activity = await ensureActivity(client, teamId, date);
    } catch (error) {
      const status = deps.outreach.providerStatus(error);
      if (!linked || (status !== 404 && status !== 409)) throw error;
      const relinked = await linkTeam(db, client, booking, program, now);
      if (relinked === linked) throw error;
      activity = await ensureActivity(client, relinked, date);
    }
  } catch (error) {
    const status = deps.outreach.providerStatus(error);
    return { status: "retry", error: errorText(error), permanent: status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429 };
  }
  const dayStart = localInstant(deps.civil, timeZone, date, "00:00", "start");
  const nextDayStart = localInstant(deps.civil, timeZone, addDays(date, 1), "00:00", "start");
  const stored = await db.prepare("UPDATE visits_bookings SET outreach_activity_id=?,updated_at=? WHERE installation_id=? AND id=? AND status='booked' AND removed=0 AND team_id=? AND arrival_ms>=? AND arrival_ms<?")
    .bind(activity.activityId, iso(now), installationId, booking.id, booking.team_id, dayStart, nextDayStart).run();
  if (stored.meta?.changes === 1) return { status: "delivered", externalId: activity.activityId };
  if (activity.created) {
    const current = attentionOf(booking);
    const kept = outreachActivityKeptAttention(current);
    await db.prepare("UPDATE visits_bookings SET attention=?,attention_reason=?,updated_at=? WHERE installation_id=? AND id=? AND attention=? AND attention_reason IS ?")
      .bind(kept.state, kept.reason, iso(now), installationId, booking.id, current.state, current.reason).run();
  }
  return { status: "skipped", note: `The visit changed while it was recorded on ${date}; a newer record follows the change` };
}
