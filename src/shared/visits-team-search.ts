// Team lookup by number: FIRST's FRC and FTC team lists, asked through Core's shared FIRST connection, and this
// installation's saved guest teams. Pure rules shared by the Worker, the dashboard and the tests: the programs Guest
// Visits looks up, reading Core's answers into matches, and merging and ordering matches. Only the team number ever goes
// to FIRST, and Core holds the credentials.
import type { FirstApiProgram, TeamMatch } from "./visits-api.ts";
import { visitPrograms, type VisitProgram } from "./visits-booking.ts";

/** The programs Guest Visits asks Core's FIRST connection about. FIRST LEGO League teams are entered by hand. */
export const firstApiPrograms = ["FRC", "FTC"] as const satisfies readonly FirstApiProgram[];
export const isFirstApiProgram = (value: unknown): value is FirstApiProgram => firstApiPrograms.includes(value as FirstApiProgram);

/** One program's answer from `services.first.searchTeams`, the parts Guest Visits reads. Structurally the SDK's `FirstSearchResult`. */
export type FirstSearchAnswer =
  | { readonly program: string; readonly status: "found"; readonly team: { readonly name: string; readonly location: string } }
  | { readonly program: string; readonly status: "not-found" | "unavailable" };

/** FIRST's FRC and FTC teams in Core's answers, as matches for this number. Other programs and malformed answers are ignored. */
export function firstMatchesOf(results: readonly FirstSearchAnswer[], number: string): TeamMatch[] {
  return results.flatMap((result): TeamMatch[] => {
    if (result.status !== "found" || !isFirstApiProgram(result.program)) return [];
    const team = result.team as { readonly name?: unknown; readonly location?: unknown } | undefined;
    const name = typeof team?.name === "string" ? team.name.trim() : "";
    const location = typeof team?.location === "string" ? team.location : "";
    return name ? [{ number, name, program: result.program, location, source: "first" }] : [];
  });
}

const programOrder = (program: VisitProgram) => visitPrograms.indexOf(program);

/** One match per program, FIRST's over a saved team's, in program order: FRC, FTC, then the rest. */
export function mergeTeamMatches(first: readonly TeamMatch[], saved: readonly TeamMatch[]): TeamMatch[] {
  const byProgram = new Map<VisitProgram, TeamMatch>();
  for (const match of saved) if (!byProgram.has(match.program)) byProgram.set(match.program, match);
  for (const match of first) byProgram.set(match.program, match);
  return [...byProgram.values()].sort((left, right) => programOrder(left.program) - programOrder(right.program));
}
