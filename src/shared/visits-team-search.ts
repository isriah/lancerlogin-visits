// Team lookup by number: FIRST's FRC Events API v3 and FTC Events API v2, read with an Admin's username and token, and
// this installation's saved guest teams. Pure rules shared by the Worker and the tests: request URLs, Basic auth, reading
// FIRST's answers, the location line, merging and ordering matches, credential input, and the cache and limit numbers.
// Only the team number ever goes to FIRST.
import type { FirstApiProgram, TeamMatch } from "./visits-api.ts";
import { visitPrograms, type VisitProgram } from "./visits-booking.ts";
import { dayMs, minuteMs, ok, problem, singleLine, type Result } from "./visits-time.ts";

export const firstApiPrograms = ["FRC", "FTC"] as const satisfies readonly FirstApiProgram[];
export const isFirstApiProgram = (value: unknown): value is FirstApiProgram => firstApiPrograms.includes(value as FirstApiProgram);

const firstApiBase: Readonly<Record<FirstApiProgram, string>> = {
  FRC: "https://frc-api.firstinspires.org/v3.0",
  FTC: "https://ftc-api.firstinspires.org/v2.0",
};

/** The API root, which reports `currentSeason`. */
export const firstRootUrl = (program: FirstApiProgram) => `${firstApiBase[program]}/`;
/** A season summary: the one authenticated call that checks a credential. */
export const firstSeasonUrl = (program: FirstApiProgram, season: number) => `${firstApiBase[program]}/${season}`;
/** One team by number in a season's team list. */
export const firstTeamsUrl = (program: FirstApiProgram, season: number, number: string) => `${firstApiBase[program]}/${season}/teams?teamNumber=${encodeURIComponent(number)}`;

/** HTTP Basic auth for a FIRST credential. Usernames and tokens are printable ASCII (see `parseFirstCredential`). */
export const basicAuthorization = (username: string, token: string) => `Basic ${btoa(`${username}:${token}`)}`;

/** Answers from FIRST are kept a week, "no team" too; the current season a day. */
export const firstTeamCacheMs = 7 * dayMs;
export const firstSeasonCacheMs = dayMs;
/** At most this many requests to FIRST per rolling minute per installation, so guests cannot use up the tokens. */
export const firstRequestLimit = 30;
export const firstRequestWindowMs = minuteMs;
/** Each request to FIRST gives up after this long. */
export const firstTimeoutMs = 4_000;

const maximumLocationLength = 200;
const maximumFirstNameLength = 100;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const textOf = (value: unknown) => typeof value === "string" ? singleLine(value) : "";

/** `currentSeason` from an API root answer, or null when it is missing or not a plausible year. */
export function currentSeasonOf(body: unknown): number | null {
  const season = isRecord(body) ? body.currentSeason : undefined;
  return Number.isInteger(season) && (season as number) >= 2000 && (season as number) <= 2999 ? season as number : null;
}

/** "City, StateProv" in the USA and Canada, "City, Country" elsewhere, the known parts only, or empty. */
export function teamLocation(team: { readonly city?: unknown; readonly stateProv?: unknown; readonly country?: unknown }): string {
  const country = textOf(team.country);
  const region = /^(USA|United States|Canada)$/i.test(country) ? textOf(team.stateProv) : country;
  return [textOf(team.city), region].filter(Boolean).join(", ").slice(0, maximumLocationLength);
}

export type FirstTeam = { readonly name: string; readonly location: string };

/**
 * The team with this number in a `{ teams: [...] }` answer: its short name (or full name) and location. Null when the
 * list has no such team, undefined when the answer is not a team list. A team FIRST lists without a name counts as none.
 */
export function firstTeamOf(body: unknown, number: string): FirstTeam | null | undefined {
  if (!isRecord(body) || !Array.isArray(body.teams)) return undefined;
  const team = body.teams.find((item) => isRecord(item) && String(item.teamNumber) === number) as Record<string, unknown> | undefined;
  const name = team ? (textOf(team.nameShort) || textOf(team.nameFull)).slice(0, maximumFirstNameLength).trim() : "";
  return name ? { name, location: teamLocation(team!) } : null;
}

const programOrder = (program: VisitProgram) => visitPrograms.indexOf(program);

/** One match per program, FIRST's over a saved team's, in program order: FRC, FTC, then the rest. */
export function mergeTeamMatches(first: readonly TeamMatch[], saved: readonly TeamMatch[]): TeamMatch[] {
  const byProgram = new Map<VisitProgram, TeamMatch>();
  for (const match of saved) if (!byProgram.has(match.program)) byProgram.set(match.program, match);
  for (const match of first) byProgram.set(match.program, match);
  return [...byProgram.values()].sort((left, right) => programOrder(left.program) - programOrder(right.program));
}

export type FirstCredentialInput = { readonly program: FirstApiProgram; readonly username: string; readonly token: string };

/**
 * A FIRST credential to check and save. Both parts are printable ASCII, as Basic auth needs; the username has no colon
 * and the token no spaces.
 */
export function parseFirstCredential(value: Record<string, unknown>): Result<FirstCredentialInput> {
  if (!isFirstApiProgram(value.program)) return problem("program", "Choose FRC or FTC");
  const username = typeof value.username === "string" ? value.username.trim() : "";
  if (!username) return problem("username", "Enter the FIRST API username");
  if (username.length > 100 || !/^[\x20-\x39\x3b-\x7e]+$/.test(username)) return problem("username", "Enter the username exactly as FIRST sent it: at most 100 letters, digits and symbols, without a colon");
  const token = typeof value.token === "string" ? value.token.trim() : "";
  if (!token) return problem("token", "Enter the FIRST API token");
  if (token.length > 200 || !/^[\x21-\x7e]+$/.test(token)) return problem("token", "Enter the token exactly as FIRST sent it, without spaces");
  return ok({ program: value.program, username, token });
}
