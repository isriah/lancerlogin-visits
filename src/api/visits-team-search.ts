// Team lookup by number (`GET /public/visits/team-search`) through Core's shared FIRST connection, `services.first`
// (module SDK 1.2.0), and its status for Settings > Guest Visits (`GET /admin/visits/settings/first-api`). Core holds the
// FRC and FTC credentials, caches FIRST's answers and applies the request limits; Guest Visits sends it only the team
// number and adds this installation's saved guest teams.
//
// Before team lookup moved to Core, Guest Visits kept its own FRC and FTC credentials in visits_first_credentials. Each
// Worker isolate offers those to Core once, on its first team search, settings read or job pass, with
// `importLegacyCredential`, and deletes each one Core took or already had. A credential Core cannot read stays, so a later
// isolate can try again once the integration key is fixed, until Core has a working credential of its own for that program.
import type { D1Database } from "@lancerlogin/module-sdk/api";
import type { FirstApiProgram, FirstLookupStatus, PublicTeamSearch, TeamMatch } from "../shared/visits-api.ts";
import { parseTeamNumber, type VisitProgram } from "../shared/visits-booking.ts";
import { firstApiPrograms, firstMatchesOf, isFirstApiProgram, mergeTeamMatches } from "../shared/visits-team-search.ts";
import { installationId, rows, VisitsError, type VisitsDeps } from "./visits-runtime.ts";

type CredentialRow = { program: FirstApiProgram; username: string; ciphertext: string; iv: string; checked_at: string };

const legacyCredentials = (db: D1Database) =>
  rows<CredentialRow>(db.prepare("SELECT program,username,ciphertext,iv,checked_at FROM visits_first_credentials WHERE installation_id=? ORDER BY program").bind(installationId));

/** Forget one saved credential, only if it is still the one that was offered. */
const forget = (db: D1Database, row: CredentialRow) =>
  db.prepare("DELETE FROM visits_first_credentials WHERE installation_id=? AND program=? AND ciphertext=? AND iv=?").bind(installationId, row.program, row.ciphertext, row.iv).run();

/**
 * Offer Guest Visits' saved FIRST credentials to Core, once per isolate. Core takes a credential only for a program it has
 * none for ("imported"); an Admin's own Core credential wins ("kept-existing"). Either way the Guest Visits copy is no
 * longer needed and is deleted. "unreadable" (Core cannot decrypt it with its integration key) and a refused import keep
 * the row. Failures never reach the caller: a lookup then simply runs on whatever Core already has.
 */
export async function moveLegacyFirstCredentials(db: D1Database, deps: VisitsDeps): Promise<void> {
  const state = deps.firstImport;
  if (state.settled) return;
  state.running ??= (async () => {
    for (const row of await legacyCredentials(db)) {
      if (!isFirstApiProgram(row.program)) continue;
      let outcome: string | undefined;
      try {
        outcome = await deps.first.importLegacyCredential({ program: row.program, username: row.username, ciphertext: row.ciphertext, iv: row.iv, checkedAt: row.checked_at });
      } catch { outcome = undefined; }
      if (outcome === "imported" || outcome === "kept-existing") await forget(db, row);
    }
    state.settled = true;
  })().catch(() => undefined).finally(() => { state.running = undefined; });
  await state.running;
}

type FirstAnswer = { readonly matches: readonly TeamMatch[]; readonly complete: boolean };

/** FIRST's FRC and FTC teams with this number from Core. Incomplete, with no matches, when Core cannot be asked. */
async function lookUpFirst(db: D1Database, deps: VisitsDeps, number: string): Promise<FirstAnswer> {
  await moveLegacyFirstCredentials(db, deps);
  try {
    const answer = await deps.first.searchTeams({ number, programs: firstApiPrograms });
    return { matches: firstMatchesOf(answer.results, number), complete: answer.complete === true };
  } catch { return { matches: [], complete: false }; }
}

/** `GET /public/visits/team-search?number=`: FIRST's FRC and FTC teams with that number and this installation's saved teams. */
export async function searchTeams(db: D1Database, deps: VisitsDeps, url: URL): Promise<PublicTeamSearch> {
  const parsed = parseTeamNumber(url.searchParams.get("number") ?? "", "FRC", "number");
  if (!parsed.ok) throw new VisitsError(400, "Enter a team number of 1 to 6 digits", "number");
  const number = parsed.value;
  const [saved, first] = await Promise.all([
    rows<{ number: string; name: string; program: VisitProgram }>(db.prepare("SELECT number,name,program FROM visits_teams WHERE installation_id=? AND number=? AND archived=0").bind(installationId, number)),
    lookUpFirst(db, deps, number),
  ]);
  return {
    matches: mergeTeamMatches(first.matches, saved.map((team): TeamMatch => ({ ...team, location: "", source: "saved" }))),
    complete: first.complete,
  };
}

const off = { available: false, checkedAt: null } as const;

/**
 * `GET /admin/visits/settings/first-api`: whether Core can look up FRC and FTC teams, and which saved Guest Visits
 * credentials could not be moved to Core. A credential that could not be moved is deleted once Core has a working one of
 * its own for that program, since it is then never needed.
 */
export async function firstLookupStatus(db: D1Database, deps: VisitsDeps): Promise<FirstLookupStatus> {
  await moveLegacyFirstCredentials(db, deps);
  const status = await deps.first.status().catch(() => undefined);
  const programs = { FRC: status?.FRC ? { available: status.FRC.available === true, checkedAt: status.FRC.checkedAt ?? null } : off, FTC: status?.FTC ? { available: status.FTC.available === true, checkedAt: status.FTC.checkedAt ?? null } : off };
  const notMoved: FirstApiProgram[] = [];
  for (const row of await legacyCredentials(db)) {
    if (!isFirstApiProgram(row.program)) continue;
    if (programs[row.program].available) await forget(db, row);
    else notMoved.push(row.program);
  }
  return { programs, notMoved };
}
