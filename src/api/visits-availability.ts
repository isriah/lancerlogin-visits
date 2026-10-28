// Staff availability: repeating series, one-off windows, editing, canceling, restoring and removing windows, and the
// staff overview. Windows never overlap (the library checks a save before it is written and a trigger refuses any overlap
// that slips past), and every window change brings the Needs attention state of the visits in it up to date.
import type { D1Database, D1Statement } from "@lancerlogin/module-sdk/api";
import type { StaffOverview, StaffSeries, StaffWindow } from "../shared/visits-api.ts";
import {
  expandSeries, findSeriesPlanConflicts, findWindowConflicts, parseCancelReason, parseSeriesInput, parseWindowInput, planSeriesWindows, resolveWindow,
  weekdayMask, weekdaysFromMask, type DatedWindow, type SeriesDefinition, type StoredWindow, type WindowConflict,
} from "../shared/visits-schedule.ts";
import { addDays, dayMs, daysBetween, formatShortDate, isLocalDate, localInstant, localMoment, type CivilTime } from "../shared/visits-time.ts";
import { staffBookingsBetween } from "./visits-queries.ts";
import {
  guardFailed, guardStatement, installationId, iso, objectBody, ok, onlyFields, refuse, revisionOf, rows, stale, staffWindow, storedWindow,
  VisitsError, windowAttentionStatements, windowColumns, type RouteResult, type VisitsDeps, type WindowRow,
} from "./visits-runtime.ts";

/** The staff overview covers at most this many days. */
export const maximumOverviewDays = 120;
/** A window lasts at most one local day (25 hours when clocks fall back). */
const longestWindowMs = 90_000_000;

type CountedWindowRow = WindowRow & { booked_count: number; team_count: number };
const countedWindowSelect = `SELECT ${windowColumns.split(",").map((column) => `w.${column}`).join(",")},
  (SELECT COUNT(*) FROM visits_bookings b WHERE b.installation_id=w.installation_id AND b.window_id=w.id AND b.status='booked') AS booked_count,
  (SELECT COUNT(DISTINCT b.team_id) FROM visits_bookings b WHERE b.installation_id=w.installation_id AND b.window_id=w.id AND b.status='booked') AS team_count
  FROM visits_windows w`;

/** Windows (not removed) that start in a range of instants. */
async function windowsStartingBetween(db: D1Database, fromMs: number, toMs: number): Promise<WindowRow[]> {
  return rows<WindowRow>(db.prepare(`SELECT ${windowColumns} FROM visits_windows WHERE installation_id=? AND status!='removed' AND start_ms>=? AND start_ms<? ORDER BY start_ms`).bind(installationId, fromMs, toMs));
}

/** Every window that could overlap a window on these local dates. */
async function windowsAround(db: D1Database, deps: VisitsDeps, timeZone: string, firstDate: string, lastDate: string): Promise<WindowRow[]> {
  const fromMs = localInstant(deps.civil, timeZone, firstDate, "00:00", "start") - longestWindowMs;
  const toMs = localInstant(deps.civil, timeZone, addDays(lastDate, 1), "00:00", "start") + dayMs;
  return windowsStartingBetween(db, fromMs, toMs);
}

async function countedWindow(db: D1Database, id: string): Promise<CountedWindowRow | null> {
  return db.prepare(`${countedWindowSelect} WHERE w.installation_id=? AND w.id=? AND w.status!='removed'`).bind(installationId, id).first<CountedWindowRow>();
}

async function requireWindow(db: D1Database, id: string): Promise<CountedWindowRow> {
  const window = await countedWindow(db, id);
  if (!window) throw new VisitsError(404, "This window was not found. It may have been removed.");
  return window;
}

async function staffWindowById(db: D1Database, deps: VisitsDeps, timeZone: string, id: string): Promise<StaffWindow> {
  return staffWindow(deps.civil, timeZone, await requireWindow(db, id));
}

function conflictError(civil: CivilTime, timeZone: string, proposed: readonly { readonly startMs: number }[], conflicts: readonly WindowConflict[]): VisitsError {
  const first = conflicts[0]!;
  const date = formatShortDate(localMoment(civil, timeZone, proposed[first.proposed]!.startMs).date);
  return new VisitsError(409, first.otherProposed === undefined ? `These times overlap another window on ${date}` : `These times overlap each other on ${date}`, "startTime");
}

/** Run a window batch, turning a lost race into a clear refusal. */
async function applyWindowBatch(db: D1Database, statements: D1Statement[], what: string): Promise<void> {
  try {
    await db.batch(statements);
  } catch (error) {
    if (guardFailed(error, "visits_stale_window") || guardFailed(error, "visits_window_revision")) throw stale(what);
    if (guardFailed(error, "visits_window_overlap")) throw new VisitsError(409, "These times overlap another window", "startTime");
    throw error;
  }
}

const insertWindowsSql = `INSERT INTO visits_windows(installation_id,id,series_id,start_ms,end_ms,title,status,cancel_reason,edited,revision,created_at,updated_at)
  SELECT ?,json_extract(value,'$.id'),?,json_extract(value,'$.startMs'),json_extract(value,'$.endMs'),json_extract(value,'$.title'),'open','',0,0,?,? FROM json_each(?)`;
const updateWindowsSql = `UPDATE visits_windows SET start_ms=j.start_ms,end_ms=j.end_ms,title=j.title,revision=revision+1,updated_at=?
  FROM (SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.startMs') AS start_ms,json_extract(value,'$.endMs') AS end_ms,json_extract(value,'$.title') AS title FROM json_each(?)) AS j
  WHERE visits_windows.installation_id=? AND visits_windows.id=j.id`;

/** Remove windows: delete those no visit refers to and mark the others removed, so their visits keep their history. */
function removeWindowsStatements(db: D1Database, ids: readonly string[], now: number): D1Statement[] {
  if (!ids.length) return [];
  const json = JSON.stringify(ids);
  return [
    db.prepare("DELETE FROM visits_windows WHERE installation_id=? AND id IN (SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM visits_bookings b WHERE b.installation_id=visits_windows.installation_id AND b.window_id=visits_windows.id)").bind(installationId, json),
    db.prepare("UPDATE visits_windows SET status='removed',cancel_reason='',revision=revision+1,updated_at=? WHERE installation_id=? AND id IN (SELECT value FROM json_each(?)) AND status!='removed'").bind(iso(now), installationId, json),
  ];
}

function insertWindowsStatement(db: D1Database, seriesId: string | null, windows: readonly DatedWindow[], now: number): D1Statement[] {
  if (!windows.length) return [];
  const json = JSON.stringify(windows.map((window) => ({ id: crypto.randomUUID(), startMs: window.startMs, endMs: window.endMs, title: window.title })));
  return [db.prepare(insertWindowsSql).bind(installationId, seriesId, iso(now), iso(now), json)];
}

// One-off windows.

function parseWindowBody(value: unknown, withRevision: boolean) {
  const input = objectBody(value);
  const { revision, ...fields } = input;
  if (!withRevision && revision !== undefined) throw new VisitsError(400, "Unexpected field revision", "revision");
  const window = parseWindowInput(fields);
  if (!window.ok) refuse(window);
  return { window: window.value, revision: withRevision ? revisionOf(revision) : 0 };
}

export async function createWindow(db: D1Database, deps: VisitsDeps, value: unknown): Promise<RouteResult> {
  const { window } = parseWindowBody(value, false);
  const timeZone = await deps.timeZone();
  const resolved = resolveWindow(deps.civil, timeZone, window);
  if (!resolved.ok) refuse(resolved);
  const existing = (await windowsAround(db, deps, timeZone, window.date, window.date)).map(storedWindow);
  const conflicts = findWindowConflicts([resolved.value], existing);
  if (conflicts.length) throw conflictError(deps.civil, timeZone, [resolved.value], conflicts);
  const now = deps.now();
  const id = crypto.randomUUID();
  await applyWindowBatch(db, [db.prepare("INSERT INTO visits_windows(installation_id,id,start_ms,end_ms,title,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .bind(installationId, id, resolved.value.startMs, resolved.value.endMs, resolved.value.title, iso(now), iso(now))], "This window");
  return ok(await staffWindowById(db, deps, timeZone, id), 201);
}

/** Change one window's date, times or title. A window from a series is marked edited, so series edits leave it alone. */
export async function updateWindow(db: D1Database, deps: VisitsDeps, id: string, value: unknown): Promise<RouteResult> {
  const { window, revision } = parseWindowBody(value, true);
  const timeZone = await deps.timeZone();
  const current = await requireWindow(db, id);
  if (current.revision !== revision) throw stale("This window");
  const resolved = resolveWindow(deps.civil, timeZone, window);
  if (!resolved.ok) refuse(resolved);
  if (resolved.value.startMs === current.start_ms && resolved.value.endMs === current.end_ms && resolved.value.title === current.title) return ok(staffWindow(deps.civil, timeZone, current));
  const existing = (await windowsAround(db, deps, timeZone, window.date, window.date)).map(storedWindow);
  const conflicts = findWindowConflicts([{ ...resolved.value, id }], existing);
  if (conflicts.length) throw conflictError(deps.civil, timeZone, [resolved.value], conflicts);
  const now = deps.now();
  await applyWindowBatch(db, [
    guardStatement(db, "visits_stale_window", "EXISTS(SELECT 1 FROM visits_windows WHERE installation_id=? AND id=? AND revision=? AND status!='removed')", installationId, id, revision),
    db.prepare("UPDATE visits_windows SET start_ms=?,end_ms=?,title=?,edited=CASE WHEN series_id IS NULL THEN 0 ELSE 1 END,revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?")
      .bind(resolved.value.startMs, resolved.value.endMs, resolved.value.title, iso(now), installationId, id, revision),
    ...windowAttentionStatements(db, [id], now),
  ], "This window");
  return ok(await staffWindowById(db, deps, timeZone, id));
}

/** Remove one window. Its visits stay and need attention. */
export async function removeWindow(db: D1Database, deps: VisitsDeps, id: string, revision: number): Promise<RouteResult> {
  const current = await requireWindow(db, id);
  if (current.revision !== revision) throw stale("This window");
  const now = deps.now();
  await applyWindowBatch(db, [
    guardStatement(db, "visits_stale_window", "EXISTS(SELECT 1 FROM visits_windows WHERE installation_id=? AND id=? AND revision=? AND status!='removed')", installationId, id, revision),
    ...removeWindowsStatements(db, [id], now),
    ...windowAttentionStatements(db, [id], now),
  ], "This window");
  return ok({ removed: true, id });
}

/** Cancel one window with the reason guests see. Its visits need attention. */
export async function cancelWindow(db: D1Database, deps: VisitsDeps, id: string, value: unknown): Promise<RouteResult> {
  const input = objectBody(value);
  onlyFields(input, ["reason", "revision"]);
  const revision = revisionOf(input.revision);
  const reason = parseCancelReason(input.reason);
  if (!reason.ok) refuse(reason);
  const current = await requireWindow(db, id);
  if (current.revision !== revision) throw stale("This window");
  if (current.status !== "open") throw new VisitsError(409, "This window is already canceled", "status");
  const now = deps.now();
  await applyWindowBatch(db, [
    guardStatement(db, "visits_stale_window", "EXISTS(SELECT 1 FROM visits_windows WHERE installation_id=? AND id=? AND revision=? AND status='open')", installationId, id, revision),
    db.prepare("UPDATE visits_windows SET status='canceled',cancel_reason=?,revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(reason.value, iso(now), installationId, id, revision),
    ...windowAttentionStatements(db, [id], now),
  ], "This window");
  return ok(await staffWindowById(db, deps, await deps.timeZone(), id));
}

/** Open a canceled window again. Visits that fit it no longer need attention for the window. */
export async function restoreWindow(db: D1Database, deps: VisitsDeps, id: string, value: unknown): Promise<RouteResult> {
  const input = objectBody(value);
  onlyFields(input, ["revision"]);
  const revision = revisionOf(input.revision);
  const current = await requireWindow(db, id);
  if (current.revision !== revision) throw stale("This window");
  if (current.status !== "canceled") throw new VisitsError(409, "This window is not canceled", "status");
  const now = deps.now();
  await applyWindowBatch(db, [
    guardStatement(db, "visits_stale_window", "EXISTS(SELECT 1 FROM visits_windows WHERE installation_id=? AND id=? AND revision=? AND status='canceled')", installationId, id, revision),
    db.prepare("UPDATE visits_windows SET status='open',cancel_reason='',revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(iso(now), installationId, id, revision),
    ...windowAttentionStatements(db, [id], now),
  ], "This window");
  return ok(await staffWindowById(db, deps, await deps.timeZone(), id));
}

// Repeating series.

type SeriesRow = { id: string; weekday_mask: number; start_time: string; end_time: string; first_date: string; last_date: string; title: string; revision: number; window_count: number };
const seriesSelect = `SELECT s.id,s.weekday_mask,s.start_time,s.end_time,s.first_date,s.last_date,s.title,s.revision,
  (SELECT COUNT(*) FROM visits_windows w WHERE w.installation_id=s.installation_id AND w.series_id=s.id AND w.status!='removed') AS window_count FROM visits_availability_series s`;

function staffSeries(row: SeriesRow): StaffSeries {
  return {
    id: row.id, revision: row.revision, weekdays: weekdaysFromMask(row.weekday_mask), startTime: row.start_time, endTime: row.end_time,
    firstDate: row.first_date, lastDate: row.last_date, title: row.title, windowCount: Number(row.window_count),
  };
}

async function requireSeries(db: D1Database, id: string): Promise<SeriesRow> {
  const row = await db.prepare(`${seriesSelect} WHERE s.installation_id=? AND s.id=?`).bind(installationId, id).first<SeriesRow>();
  if (!row) throw new VisitsError(404, "This repeating window was not found. It may have been removed.");
  return row;
}

export async function listSeries(db: D1Database): Promise<StaffSeries[]> {
  return (await rows<SeriesRow>(db.prepare(`${seriesSelect} WHERE s.installation_id=? ORDER BY s.first_date,s.start_time,s.id`).bind(installationId))).map(staffSeries);
}

function parseSeriesBody(value: unknown, withRevision: boolean): { series: SeriesDefinition; revision: number } {
  const input = objectBody(value);
  const { revision, ...fields } = input;
  if (!withRevision && revision !== undefined) throw new VisitsError(400, "Unexpected field revision", "revision");
  const series = parseSeriesInput(fields);
  if (!series.ok) refuse(series);
  return { series: series.value, revision: withRevision ? revisionOf(revision) : 0 };
}

/** The series' own windows and every window near its dates, which a save must not overlap. */
async function seriesNeighbourhood(db: D1Database, deps: VisitsDeps, timeZone: string, seriesId: string, series: SeriesDefinition | null): Promise<StoredWindow[]> {
  const own = await rows<WindowRow>(db.prepare(`SELECT ${windowColumns} FROM visits_windows WHERE installation_id=? AND series_id=? AND status!='removed'`).bind(installationId, seriesId));
  const near = series ? await windowsAround(db, deps, timeZone, series.firstDate, series.lastDate) : [];
  return [...new Map([...own, ...near].map((row) => [row.id, storedWindow(row)])).values()];
}

/** Create a repeating series and its windows for dates that have not started. */
export async function createSeries(db: D1Database, deps: VisitsDeps, value: unknown): Promise<RouteResult> {
  const { series } = parseSeriesBody(value, false);
  const timeZone = await deps.timeZone();
  const now = deps.now();
  const id = crypto.randomUUID();
  const existing = await seriesNeighbourhood(db, deps, timeZone, id, series);
  const plan = planSeriesWindows({ civil: deps.civil, timeZone, seriesId: id, existing, expansion: expandSeries(deps.civil, timeZone, series).windows, now });
  if (!plan.insert.length) throw new VisitsError(400, "None of these dates is still ahead. Choose dates that have not started.", "firstDate");
  const conflicts = findSeriesPlanConflicts(plan, existing);
  if (conflicts.length) throw conflictError(deps.civil, timeZone, [...plan.update, ...plan.insert], conflicts);
  await applyWindowBatch(db, [
    db.prepare("INSERT INTO visits_availability_series(installation_id,id,weekday_mask,start_time,end_time,first_date,last_date,title,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .bind(installationId, id, weekdayMask(series.weekdays), series.startTime, series.endTime, series.firstDate, series.lastDate, series.title, iso(now), iso(now)),
    ...insertWindowsStatement(db, id, plan.insert, now),
  ], "This repeating window");
  return ok(staffSeries(await requireSeries(db, id)), 201);
}

/**
 * Change a series. Its windows that have not started and were not edited or canceled on their own take the new rule:
 * removals first (so their time is free), then updates, then new dates. Visits in changed or removed windows need attention.
 */
export async function updateSeries(db: D1Database, deps: VisitsDeps, id: string, value: unknown): Promise<RouteResult> {
  const { series, revision } = parseSeriesBody(value, true);
  const current = await requireSeries(db, id);
  if (current.revision !== revision) throw stale("This repeating window");
  const timeZone = await deps.timeZone();
  const now = deps.now();
  const existing = await seriesNeighbourhood(db, deps, timeZone, id, series);
  const plan = planSeriesWindows({ civil: deps.civil, timeZone, seriesId: id, existing, expansion: expandSeries(deps.civil, timeZone, series).windows, now });
  const conflicts = findSeriesPlanConflicts(plan, existing);
  if (conflicts.length) throw conflictError(deps.civil, timeZone, [...plan.update, ...plan.insert], conflicts);
  await applyWindowBatch(db, [
    guardStatement(db, "visits_stale_window", "EXISTS(SELECT 1 FROM visits_availability_series WHERE installation_id=? AND id=? AND revision=?)", installationId, id, revision),
    db.prepare("UPDATE visits_availability_series SET weekday_mask=?,start_time=?,end_time=?,first_date=?,last_date=?,title=?,revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?")
      .bind(weekdayMask(series.weekdays), series.startTime, series.endTime, series.firstDate, series.lastDate, series.title, iso(now), installationId, id, revision),
    ...removeWindowsStatements(db, plan.remove, now),
    ...(plan.update.length ? [db.prepare(updateWindowsSql).bind(iso(now), JSON.stringify(plan.update.map((window) => ({ id: window.id, startMs: window.startMs, endMs: window.endMs, title: window.title }))), installationId)] : []),
    ...insertWindowsStatement(db, id, plan.insert, now),
    ...windowAttentionStatements(db, [...plan.remove, ...plan.update.map((window) => window.id)], now),
  ], "This repeating window");
  return ok(staffSeries(await requireSeries(db, id)));
}

/**
 * Remove a series and its windows that have not started and were not edited or canceled on their own. Windows it keeps
 * (started, edited or canceled) stay as one-off windows.
 */
export async function removeSeries(db: D1Database, deps: VisitsDeps, id: string, revision: number): Promise<RouteResult> {
  const current = await requireSeries(db, id);
  if (current.revision !== revision) throw stale("This repeating window");
  const timeZone = await deps.timeZone();
  const now = deps.now();
  const existing = await seriesNeighbourhood(db, deps, timeZone, id, null);
  const plan = planSeriesWindows({ civil: deps.civil, timeZone, seriesId: id, existing, expansion: [], now });
  await applyWindowBatch(db, [
    guardStatement(db, "visits_stale_window", "EXISTS(SELECT 1 FROM visits_availability_series WHERE installation_id=? AND id=? AND revision=?)", installationId, id, revision),
    ...removeWindowsStatements(db, plan.remove, now),
    db.prepare("UPDATE visits_windows SET series_id=NULL,updated_at=? WHERE installation_id=? AND series_id=?").bind(iso(now), installationId, id),
    db.prepare("DELETE FROM visits_availability_series WHERE installation_id=? AND id=? AND revision=?").bind(installationId, id, revision),
    ...windowAttentionStatements(db, plan.remove, now),
  ], "This repeating window");
  return ok({ removed: true, id });
}

// Overview.

/** Windows and visits between two local dates (at most 120 days; by default the eight weeks from today). */
export async function staffOverview(db: D1Database, deps: VisitsDeps, url: URL): Promise<StaffOverview> {
  const timeZone = await deps.timeZone();
  const today = localMoment(deps.civil, timeZone, deps.now()).date;
  const from = url.searchParams.get("from") ?? today;
  if (!isLocalDate(from)) throw new VisitsError(400, "Enter the first date as YYYY-MM-DD", "from");
  const to = url.searchParams.get("to") ?? addDays(from, 55);
  if (!isLocalDate(to)) throw new VisitsError(400, "Enter the last date as YYYY-MM-DD", "to");
  const span = daysBetween(from, to);
  if (span < 0) throw new VisitsError(400, "The last date must be on or after the first date", "to");
  if (span + 1 > maximumOverviewDays) throw new VisitsError(400, `Show at most ${maximumOverviewDays} days at a time`, "to");
  const fromMs = localInstant(deps.civil, timeZone, from, "00:00", "start");
  const toMs = localInstant(deps.civil, timeZone, addDays(to, 1), "00:00", "start");
  const windows = await rows<CountedWindowRow>(db.prepare(`${countedWindowSelect} WHERE w.installation_id=? AND w.status!='removed' AND w.start_ms>=? AND w.start_ms<? ORDER BY w.start_ms`).bind(installationId, fromMs, toMs));
  return {
    timeZone,
    windows: windows.map((row) => staffWindow(deps.civil, timeZone, row)),
    bookings: await staffBookingsBetween(db, deps.civil, timeZone, fromMs, toMs),
  };
}
