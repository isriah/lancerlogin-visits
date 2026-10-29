// How the guest booking form asks for the team. The guest types a team number; the Worker looks it up in FIRST's team
// lists and the saved guest teams. One match is confirmed as found, several are offered as a choice, and no match, a
// failed lookup or "Not your team?" asks for the program and team name by hand. Plain functions, tested without React.
import type { PublicTeamSearch, TeamMatch } from "../shared/visits-api.ts";
import type { VisitProgram } from "../shared/visits-booking.ts";

export type TeamSearch =
  | { readonly status: "idle" }
  | { readonly status: "searching"; readonly number: string }
  | { readonly status: "found"; readonly number: string; readonly result: PublicTeamSearch }
  | { readonly status: "failed"; readonly number: string };

export type TeamEntryMode = "none" | "searching" | "confirm" | "pick" | "manual";

/** A number worth looking up: 1 to 6 digits once trimmed, as FIRST numbers its FRC and FTC teams; otherwise null. */
export function searchableNumber(value: string): string | null {
  const trimmed = value.trim().replace(/^0+(?=\d)/, "");
  return /^\d{1,6}$/.test(trimmed) ? trimmed : null;
}

/** What the form shows for the team, given the latest lookup and whether the guest chose to type the team instead. */
export function teamEntryMode(search: TeamSearch, manual: boolean, typed: string): TeamEntryMode {
  if (manual) return "manual";
  if (!typed.trim()) return "none";
  if (!searchableNumber(typed)) return "manual";
  if (search.status === "idle" || search.status === "searching") return "searching";
  if (search.status === "failed") return "manual";
  const count = search.result.matches.length;
  return count === 1 ? "confirm" : count > 1 ? "pick" : "manual";
}

/** Why the form asks for the team by hand, or "" when it does not need saying. */
export function manualReason(search: TeamSearch, chosenManual: boolean, typed: string): string {
  if (chosenManual || !searchableNumber(typed)) return "";
  if (search.status === "failed" || (search.status === "found" && !search.result.matches.length && !search.result.complete)) return "Team lookup is not available right now. Choose your program and enter your team name.";
  if (search.status === "found" && !search.result.matches.length) return `No team ${search.number} was found in FIRST's FRC or FTC team lists. Choose your program and enter your team name.`;
  return "";
}

/**
 * The program and name the form holds after a lookup. One match fills both; with several, a program the guest already
 * chose that is among them keeps its match; otherwise values the lookup filled are cleared and values the guest typed stay.
 */
export function teamAfterSearch(matches: readonly TeamMatch[], current: { readonly program: VisitProgram | ""; readonly teamName: string }, filledByLookup: boolean): { readonly program: VisitProgram | ""; readonly teamName: string } {
  if (matches.length === 1) return { program: matches[0]!.program, teamName: matches[0]!.name };
  const kept = matches.find((match) => match.program === current.program);
  if (kept) return { program: kept.program, teamName: kept.name };
  return filledByLookup ? { program: "", teamName: "" } : current;
}
