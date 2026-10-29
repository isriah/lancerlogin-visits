// Team lookup by number (`GET /public/visits/team-search`) and the Admin's FIRST API credentials
// (`/admin/visits/settings/first-api`). A search asks FIRST's FRC and FTC team lists for each program with a saved
// credential, from a seven-day cache where it can, and adds this installation's saved guest teams. Requests go through
// `deps.fetch` with a short timeout, carry only the team number and the credential, and guest lookups count toward a
// per-minute limit. Tokens are stored only as Core's ciphertext and never appear in responses, errors or logs.
import type { D1Database } from "@lancerlogin/module-sdk/api";
import type { FirstApiProgram, FirstApiStatus, PublicTeamSearch, TeamMatch } from "../shared/visits-api.ts";
import { parseTeamNumber, type VisitProgram } from "../shared/visits-booking.ts";
import {
  basicAuthorization, currentSeasonOf, firstApiPrograms, firstRequestLimit, firstRequestWindowMs, firstRootUrl, firstSeasonCacheMs, firstSeasonUrl,
  firstTeamCacheMs, firstTeamOf, firstTeamsUrl, firstTimeoutMs, isFirstApiProgram, mergeTeamMatches, parseFirstCredential, type FirstTeam,
} from "../shared/visits-team-search.ts";
import { installationId, iso, objectBody, ok, onlyFields, refuse, rows, VisitsError, type RouteResult, type VisitsDeps } from "./visits-runtime.ts";

type CredentialRow = { program: FirstApiProgram; username: string; ciphertext: string; iv: string; checked_at: string };
/** FIRST's status and JSON body (null unless 200), or null when FIRST could not be reached in time or was not asked. */
type Reply = { readonly status: number; readonly body: unknown } | null;
type Get = (url: string) => Promise<Reply>;

/** One GET to FIRST with the credential, given up after `firstTimeoutMs`. */
async function firstGet(deps: VisitsDeps, url: string, authorization: string): Promise<Reply> {
  try {
    const response = await deps.fetch(url, { headers: { accept: "application/json", authorization }, signal: AbortSignal.timeout(firstTimeoutMs) });
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); return { status: response.status, body: null }; }
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch { return null; }
}

/** Count one request to FIRST against the rolling per-minute limit. False when the limit is reached. */
async function reserveRequest(db: D1Database, now: number): Promise<boolean> {
  const since = now - firstRequestWindowMs;
  const [, reserved] = await db.batch([
    db.prepare("DELETE FROM visits_first_requests WHERE installation_id=? AND requested_ms<=?").bind(installationId, since),
    db.prepare("INSERT INTO visits_first_requests(installation_id,id,requested_ms) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM visits_first_requests WHERE installation_id=? AND requested_ms>?)<?")
      .bind(installationId, crypto.randomUUID(), now, installationId, since, firstRequestLimit),
  ]);
  return reserved?.meta?.changes === 1;
}

/** The program's current season: cached for a day, else from the API root. A stale season serves when the root cannot. */
async function currentSeason(db: D1Database, program: FirstApiProgram, now: number, get: Get): Promise<number | null> {
  const cached = await db.prepare("SELECT season,checked_ms FROM visits_first_seasons WHERE installation_id=? AND program=?").bind(installationId, program).first<{ season: number; checked_ms: number }>();
  if (cached && cached.checked_ms > now - firstSeasonCacheMs) return cached.season;
  const reply = await get(firstRootUrl(program));
  const season = reply?.status === 200 ? currentSeasonOf(reply.body) : null;
  if (season === null) return cached?.season ?? null;
  await db.prepare("INSERT INTO visits_first_seasons(installation_id,program,season,checked_ms) VALUES(?,?,?,?) ON CONFLICT(installation_id,program) DO UPDATE SET season=excluded.season,checked_ms=excluded.checked_ms")
    .bind(installationId, program, season, now).run();
  return season;
}

async function credentialRows(db: D1Database): Promise<Map<FirstApiProgram, CredentialRow>> {
  const list = await rows<CredentialRow>(db.prepare("SELECT program,username,ciphertext,iv,checked_at FROM visits_first_credentials WHERE installation_id=?").bind(installationId));
  return new Map(list.map((row) => [row.program, row]));
}

/** The Basic auth header for a saved credential, or undefined when Core cannot decrypt it. */
async function authorizationOf(deps: VisitsDeps, credential: CredentialRow): Promise<string | undefined> {
  if (!deps.credentials.available) return undefined;
  try {
    const { token } = await deps.credentials.decrypt(credential.ciphertext, credential.iv);
    return token ? basicAuthorization(credential.username, token) : undefined;
  } catch { return undefined; }
}

const firstMatch = (program: FirstApiProgram, number: string, team: FirstTeam | null): TeamMatch | null =>
  team && { number, name: team.name, program, location: team.location, source: "first" };

/** Keep FIRST's answer, "no team" too, while the credential is still saved; drop answers older than the cache time. */
async function cacheAnswer(db: D1Database, program: FirstApiProgram, number: string, team: FirstTeam | null, now: number) {
  await db.batch([
    db.prepare("DELETE FROM visits_first_teams WHERE installation_id=? AND checked_ms<=?").bind(installationId, now - firstTeamCacheMs),
    db.prepare(`INSERT INTO visits_first_teams(installation_id,program,number,name,location,checked_ms) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM visits_first_credentials WHERE installation_id=? AND program=?)
      ON CONFLICT(installation_id,program,number) DO UPDATE SET name=excluded.name,location=excluded.location,checked_ms=excluded.checked_ms`)
      .bind(installationId, program, number, team?.name ?? null, team?.location ?? "", now, installationId, program),
  ]);
}

type ProgramAnswer = { readonly match: TeamMatch | null; readonly complete: boolean };
const unanswered: ProgramAnswer = { match: null, complete: false };

/**
 * FIRST's team with this number in one program: from the cache, else this season's team list and, when it has none, the
 * previous season's. Unanswered without a credential, over the limit, or when FIRST fails or times out; nothing is cached
 * then.
 */
async function lookUpFirst(db: D1Database, deps: VisitsDeps, program: FirstApiProgram, number: string, credential: CredentialRow | undefined, now: number): Promise<ProgramAnswer> {
  if (!credential) return unanswered;
  const cached = await db.prepare("SELECT name,location FROM visits_first_teams WHERE installation_id=? AND program=? AND number=? AND checked_ms>?")
    .bind(installationId, program, number, now - firstTeamCacheMs).first<{ name: string | null; location: string }>();
  if (cached) return { match: firstMatch(program, number, cached.name === null ? null : { name: cached.name, location: cached.location }), complete: true };
  const authorization = await authorizationOf(deps, credential);
  if (!authorization) return unanswered;
  const get: Get = async (url) => await reserveRequest(db, deps.now()) ? firstGet(deps, url, authorization) : null;
  const season = await currentSeason(db, program, now, get);
  if (season === null) return unanswered;
  let team: FirstTeam | null = null;
  for (const year of [season, season - 1]) {
    const reply = await get(firstTeamsUrl(program, year, number));
    const found = reply?.status === 404 ? null : reply?.status === 200 ? firstTeamOf(reply.body, number) : undefined;
    if (found === undefined) return unanswered;
    team = found;
    if (team) break;
  }
  await cacheAnswer(db, program, number, team, now);
  return { match: firstMatch(program, number, team), complete: true };
}

/** `GET /public/visits/team-search?number=`: FIRST's FRC and FTC teams with that number and this installation's saved teams. */
export async function searchTeams(db: D1Database, deps: VisitsDeps, url: URL): Promise<PublicTeamSearch> {
  const parsed = parseTeamNumber(url.searchParams.get("number") ?? "", "FRC", "number");
  if (!parsed.ok) throw new VisitsError(400, "Enter a team number of 1 to 6 digits", "number");
  const number = parsed.value;
  const now = deps.now();
  const [saved, credentials] = await Promise.all([
    rows<{ number: string; name: string; program: VisitProgram }>(db.prepare("SELECT number,name,program FROM visits_teams WHERE installation_id=? AND number=? AND archived=0").bind(installationId, number)),
    credentialRows(db),
  ]);
  const answers = await Promise.all(firstApiPrograms.map((program) => lookUpFirst(db, deps, program, number, credentials.get(program), now)));
  return {
    matches: mergeTeamMatches(answers.flatMap((answer) => answer.match ? [answer.match] : []), saved.map((team): TeamMatch => ({ ...team, location: "", source: "saved" }))),
    complete: answers.every((answer) => answer.complete),
  };
}

/** `GET /admin/visits/settings/first-api`: which programs have a credential, never the token. */
export async function firstApiStatus(db: D1Database): Promise<FirstApiStatus> {
  const saved = await credentialRows(db);
  const status = (program: FirstApiProgram) => ({ configured: saved.has(program), username: saved.get(program)?.username ?? "", checkedAt: saved.get(program)?.checked_at ?? null });
  return { FRC: status("FRC"), FTC: status("FTC") };
}

const refused = (program: FirstApiProgram) => new VisitsError(400, `FIRST did not accept this ${program} username and token. Check both and save again.`, "token");

/**
 * `PUT /admin/visits/settings/first-api`: check the credential with FIRST, then save it encrypted. The check reads the
 * current season (cached for a day) and then, with the credential, that season's summary, which needs a valid username
 * and token. Admin checks never count toward the guest lookup limit.
 */
export async function saveFirstCredential(db: D1Database, deps: VisitsDeps, value: unknown): Promise<RouteResult> {
  const input = objectBody(value);
  onlyFields(input, ["program", "username", "token"]);
  const parsed = parseFirstCredential(input);
  if (!parsed.ok) refuse(parsed);
  const { program, username, token } = parsed.value;
  if (!deps.credentials.available) throw new VisitsError(409, "LancerLogin cannot encrypt saved credentials on this installation, so the token was not saved. Ask whoever deploys LancerLogin to set up credential encryption.");
  const now = deps.now();
  const get: Get = async (url) => {
    const reply = await firstGet(deps, url, basicAuthorization(username, token));
    if (reply?.status === 401 || reply?.status === 403) throw refused(program);
    return reply;
  };
  const season = await currentSeason(db, program, now, get);
  const reply = season === null ? null : await get(firstSeasonUrl(program, season));
  if (reply?.status !== 200) throw new VisitsError(502, `FIRST's ${program} API could not be reached or did not answer. Try again in a few minutes.`);
  const encrypted = await deps.credentials.encrypt({ token });
  await db.prepare("INSERT INTO visits_first_credentials(installation_id,program,username,ciphertext,iv,checked_at) VALUES(?,?,?,?,?,?) ON CONFLICT(installation_id,program) DO UPDATE SET username=excluded.username,ciphertext=excluded.ciphertext,iv=excluded.iv,checked_at=excluded.checked_at")
    .bind(installationId, program, username, encrypted.ciphertext, encrypted.iv, iso(now)).run();
  return ok(await firstApiStatus(db));
}

/** `DELETE /admin/visits/settings/first-api?program=`: forget the credential and FIRST's cached answers for that program. */
export async function removeFirstCredential(db: D1Database, url: URL): Promise<RouteResult> {
  const program = url.searchParams.get("program");
  if (!isFirstApiProgram(program)) throw new VisitsError(400, "Choose FRC or FTC", "program");
  await db.batch(["visits_first_credentials", "visits_first_teams", "visits_first_seasons"].map((table) => db.prepare(`DELETE FROM ${table} WHERE installation_id=? AND program=?`).bind(installationId, program)));
  return ok(await firstApiStatus(db));
}
