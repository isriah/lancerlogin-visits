// Team lookup by number (`GET /public/visits/team-search`) through Core's shared FIRST connection, `services.first`
// (module SDK 1.2.0), and its status for Settings > Guest Visits (`GET /admin/visits/settings/first-api`). Core asks
// FIRST's Events APIs for FRC and FTC teams with the credentials it holds, and FIRST's public team search for FLL
// Challenge and FLL Explore teams; it caches FIRST's answers and applies the request limits. Guest Visits sends it only
// the team number and adds this installation's saved guest teams.
import type { D1Database } from "@lancerlogin/module-sdk/api";
import type { FirstApiProgram, FirstLookupStatus, PublicTeamSearch, TeamMatch } from "../shared/visits-api.ts";
import { parseTeamNumber, type VisitProgram } from "../shared/visits-booking.ts";
import { firstApiPrograms, firstMatchesOf, mergeTeamMatches } from "../shared/visits-team-search.ts";
import { installationId, rows, VisitsError, type VisitsDeps } from "./visits-runtime.ts";

type FirstAnswer = { readonly matches: readonly TeamMatch[]; readonly complete: boolean };

/** FIRST's FRC, FTC, FLL Challenge and FLL Explore teams with this number from Core. Incomplete, with no matches, when Core cannot be asked. */
async function lookUpFirst(deps: VisitsDeps, number: string): Promise<FirstAnswer> {
  try {
    const answer = await deps.first.searchTeams({ number, programs: firstApiPrograms });
    return { matches: firstMatchesOf(answer.results, number), complete: answer.complete === true };
  } catch { return { matches: [], complete: false }; }
}

/** `GET /public/visits/team-search?number=`: FIRST's teams with that number in every program but Other, and this installation's saved teams. */
export async function searchTeams(db: D1Database, deps: VisitsDeps, url: URL): Promise<PublicTeamSearch> {
  const parsed = parseTeamNumber(url.searchParams.get("number") ?? "", "FRC", "number");
  if (!parsed.ok) throw new VisitsError(400, "Enter a team number of 1 to 6 digits", "number");
  const number = parsed.value;
  const [saved, first] = await Promise.all([
    rows<{ number: string; name: string; program: VisitProgram }>(db.prepare("SELECT number,name,program FROM visits_teams WHERE installation_id=? AND number=? AND archived=0").bind(installationId, number)),
    lookUpFirst(deps, number),
  ]);
  return {
    matches: mergeTeamMatches(first.matches, saved.map((team): TeamMatch => ({ ...team, location: "", source: "saved" }))),
    complete: first.complete,
  };
}

const off = { available: false, checkedAt: null } as const;

/** `GET /admin/visits/settings/first-api`: which programs Core can look teams up in now. */
export async function firstLookupStatus(deps: VisitsDeps): Promise<FirstLookupStatus> {
  const status = await deps.first.status().catch(() => undefined);
  const of = (program: FirstApiProgram) => {
    const answer = status?.[program];
    return answer ? { available: answer.available === true, checkedAt: answer.checkedAt ?? null } : off;
  };
  return { programs: { FRC: of("FRC"), FTC: of("FTC"), Challenge: of("Challenge"), Explore: of("Explore") } };
}
