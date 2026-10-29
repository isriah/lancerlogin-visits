// Team lookup by number: reading FIRST's answers, the location line, merging with saved guest teams, the season fallback,
// the caches, the per-minute limit, and the Admin's FIRST API credentials, through the Worker routes with a synthetic
// FIRST and a stand-in for Core's credential encryption. Synthetic data only; no request leaves the process.
import test from "node:test";
import assert from "node:assert/strict";
import { visitsHarness, type Harness } from "./helpers/visits-harness.ts";
import type { FirstApiProgram, TeamMatch } from "../src/shared/visits-api.ts";
import type { VisitsCredentials } from "../src/api/visits-runtime.ts";
import {
  basicAuthorization, currentSeasonOf, firstRequestLimit, firstRootUrl, firstSeasonUrl, firstTeamOf, firstTeamsUrl, mergeTeamMatches, parseFirstCredential, teamLocation,
} from "../src/shared/visits-team-search.ts";

const dayMs = 86_400_000;
type FirstTeamRecord = { teamNumber: number; nameShort?: string; nameFull?: string; city?: string; stateProv?: string; country?: string };
/** A status, a timeout, or "ok" to answer one request normally before a later failure. */
type Failure = number | "timeout" | "ok";

/**
 * FIRST's FRC and FTC Events APIs as the handlers see them: an unauthenticated root with `currentSeason`, a season summary
 * and a team list that need an accepted Basic credential. A team number FRC does not know is a 404, FTC answers an empty
 * list. Failures queue per program and apply to that program's next requests in order.
 */
class FakeFirst {
  seasons: Record<FirstApiProgram, number> = { FRC: 2026, FTC: 2025 };
  readonly teams = new Map<string, FirstTeamRecord[]>();
  readonly accepted = new Set([basicAuthorization("lancers", "frc-token-0001"), basicAuthorization("lancers-ftc", "ftc-token-0001")]);
  readonly requests: { url: string; authorization: string }[] = [];
  readonly failures: Record<FirstApiProgram, Failure[]> = { FRC: [], FTC: [] };
  add(program: FirstApiProgram, season: number, ...teams: FirstTeamRecord[]) { this.teams.set(`${program} ${season}`, [...(this.teams.get(`${program} ${season}`) ?? []), ...teams]); }
  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const authorization = new Headers(init.headers).get("authorization") ?? "";
    this.requests.push({ url, authorization });
    assert.ok(init.signal instanceof AbortSignal, "every request has a timeout");
    const address = new URL(url);
    const program: FirstApiProgram = address.hostname === "frc-api.firstinspires.org" ? "FRC" : "FTC";
    const failure = this.failures[program].shift();
    if (failure === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (typeof failure === "number") return Response.json({ message: "Service unavailable" }, { status: failure });
    const [, , season, resource] = address.pathname.split("/");
    if (!season) return Response.json({ name: `${program} Events API`, currentSeason: this.seasons[program], maxSeason: this.seasons[program] });
    if (!this.accepted.has(authorization)) return Response.json({ message: "Unauthorized" }, { status: 401 });
    if (!resource) return Response.json({ eventCount: 12, gameName: "Synthetic" });
    const number = Number(address.searchParams.get("teamNumber"));
    const teams = (this.teams.get(`${program} ${season}`) ?? []).filter((team) => team.teamNumber === number);
    if (!teams.length && program === "FRC") return Response.json({ message: "No teams found" }, { status: 404 });
    return Response.json({ teams, teamCountTotal: teams.length, teamCountPage: teams.length, pageCurrent: 1, pageTotal: 1 });
  };
}

/** Core's credential service: reversible, but the token never appears in the ciphertext as written. */
class FakeCredentials implements VisitsCredentials {
  available = true;
  failDecrypt = false;
  async encrypt(value: Record<string, string>) { return { ciphertext: Buffer.from(JSON.stringify(value)).toString("base64").split("").reverse().join(""), iv: "synthetic-iv-0001" }; }
  async decrypt(ciphertext: string, iv: string) {
    if (this.failDecrypt || iv !== "synthetic-iv-0001") throw new Error("The ciphertext could not be decrypted");
    return JSON.parse(Buffer.from(ciphertext.split("").reverse().join(""), "base64").toString()) as Record<string, string>;
  }
}

const frcCredential = { program: "FRC", username: "lancers", token: "frc-token-0001" };
const ftcCredential = { program: "FTC", username: "lancers-ftc", token: "ftc-token-0001" };

/** A harness with FIRST and credential encryption, and optionally both credentials saved. */
async function lookupHarness(configure: readonly Record<string, string>[] = []) {
  const harness = visitsHarness();
  const first = new FakeFirst();
  const credentials = new FakeCredentials();
  harness.first.fetch = first.fetch;
  harness.first.credentials = credentials;
  for (const credential of configure) {
    const saved = await harness.call("PUT", "/admin/visits/settings/first-api", { body: credential });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  }
  first.requests.length = 0;
  return { harness, first, credentials };
}

const search = (harness: Harness, number: string) => harness.call("GET", `/public/visits/team-search?number=${encodeURIComponent(number)}`, { role: null, origin: null });
const saveTeam = (harness: Harness, id: string, program: string, number: string, name: string, archived = 0) =>
  harness.db.sqlite.prepare("INSERT INTO visits_teams(installation_id,id,number,name,program,archived,created_at,updated_at) VALUES('primary',?,?,?,?,?,'x','x')").run(id, number, name, program, archived);
const match = (program: TeamMatch["program"], number: string, name: string, location = "", source: TeamMatch["source"] = "first"): TeamMatch => ({ number, name, program, location, source });

test("FIRST's answers are read: short name or full name, location, missing teams and malformed lists", () => {
  const lancers = { teamNumber: 321, nameShort: " Lancers ", nameFull: "Lansdale Lancer Robotics", city: "Lansdale", stateProv: "Pennsylvania", country: "USA" };
  assert.deepEqual(firstTeamOf({ teams: [lancers] }, "321"), { name: "Lancers", location: "Lansdale, Pennsylvania" });
  assert.deepEqual(firstTeamOf({ teams: [{ ...lancers, nameShort: "" }] }, "321"), { name: "Lansdale Lancer Robotics", location: "Lansdale, Pennsylvania" });
  assert.equal(firstTeamOf({ teams: [] }, "321"), null);
  assert.equal(firstTeamOf({ teams: [lancers] }, "322"), null, "another number is no match");
  assert.equal(firstTeamOf({ teams: [{ teamNumber: 321, nameShort: " ", nameFull: null }] }, "321"), null, "a nameless entry is no team");
  assert.equal(firstTeamOf({ message: "Bad request" }, "321"), undefined);
  assert.equal(firstTeamOf(null, "321"), undefined);
  assert.equal(teamLocation({ city: "Toronto", stateProv: "Ontario", country: "Canada" }), "Toronto, Ontario");
  assert.equal(teamLocation({ city: "Tel Aviv", stateProv: "Tel Aviv District", country: "Israel" }), "Tel Aviv, Israel");
  assert.equal(teamLocation({ stateProv: "Michigan", country: "USA" }), "Michigan");
  assert.equal(teamLocation({ city: null, stateProv: "", country: undefined }), "");
  assert.equal(currentSeasonOf({ currentSeason: 2026, maxSeason: 2027 }), 2026);
  assert.equal(currentSeasonOf({ currentSeason: "2026" }), null);
  assert.equal(currentSeasonOf([]), null);
});

test("requests carry only the team number and Basic auth, and credentials are checked before they reach FIRST", () => {
  assert.equal(firstRootUrl("FRC"), "https://frc-api.firstinspires.org/v3.0/");
  assert.equal(firstSeasonUrl("FTC", 2025), "https://ftc-api.firstinspires.org/v2.0/2025");
  assert.equal(firstTeamsUrl("FRC", 2026, "321"), "https://frc-api.firstinspires.org/v3.0/2026/teams?teamNumber=321");
  assert.equal(firstTeamsUrl("FTC", 2025, "16236"), "https://ftc-api.firstinspires.org/v2.0/2025/teams?teamNumber=16236");
  assert.equal(basicAuthorization("lancers", "frc-token-0001"), `Basic ${Buffer.from("lancers:frc-token-0001").toString("base64")}`);
  assert.deepEqual(parseFirstCredential({ program: "FRC", username: " lancers ", token: " frc-token-0001\n" }), { ok: true, value: frcCredential });
  const field = (value: Record<string, unknown>) => { const result = parseFirstCredential(value); return result.ok ? "" : result.field; };
  assert.equal(field({ ...frcCredential, program: "Challenge" }), "program");
  assert.equal(field({ ...frcCredential, username: "" }), "username");
  assert.equal(field({ ...frcCredential, username: "team:321" }), "username");
  assert.equal(field({ ...frcCredential, username: "é".repeat(4) }), "username");
  assert.equal(field({ ...frcCredential, token: "two words" }), "token");
  assert.equal(field({ ...frcCredential, token: "x".repeat(201) }), "token");
});

test("matches are one per program, FIRST's over a saved team's, in the order FRC, FTC, then the rest", () => {
  const merged = mergeTeamMatches(
    [match("FTC", "321", "Lancer Tech"), match("FRC", "321", "Lancers")],
    [match("Other", "321", "Club 321", "", "saved"), match("FRC", "321", "Old name", "", "saved"), match("Challenge", "321", "Lego Lancers", "", "saved")],
  );
  assert.deepEqual(merged.map((item) => [item.program, item.name, item.source]), [["FRC", "Lancers", "first"], ["FTC", "Lancer Tech", "first"], ["Challenge", "Lego Lancers", "saved"], ["Other", "Club 321", "saved"]]);
});

test("without credentials a search answers saved teams only, incomplete, and never asks FIRST", async () => {
  const { harness, first } = await lookupHarness();
  saveTeam(harness, "team-1", "FRC", "321", "Saved Lancers");
  saveTeam(harness, "team-2", "Challenge", "321", "Lego Lancers");
  saveTeam(harness, "team-3", "FTC", "321", "Merged away", 1);
  const found = await search(harness, "0321");
  assert.equal(found.status, 200);
  assert.deepEqual(found.body, { matches: [match("FRC", "321", "Saved Lancers", "", "saved"), match("Challenge", "321", "Lego Lancers", "", "saved")], complete: false });
  assert.deepEqual(first.requests, []);
  for (const number of ["", "abc", "12a", "1234567", "0"]) {
    const refused = await search(harness, number);
    assert.equal(refused.status, 400, number);
    assert.deepEqual(refused.body, { error: "Enter a team number of 1 to 6 digits", field: "number" });
  }
  assert.deepEqual(first.requests, []);
});

test("an Admin saves a credential only after FIRST accepts it, and the token is stored only encrypted", async () => {
  const { harness, first, credentials } = await lookupHarness();
  const status = () => harness.call("GET", "/admin/visits/settings/first-api");
  const unconfigured = { configured: false, username: "", checkedAt: null };
  assert.deepEqual((await status()).body, { FRC: unconfigured, FTC: unconfigured });

  const saved = await harness.call("PUT", "/admin/visits/settings/first-api", { body: { ...frcCredential, username: " lancers " } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { FRC: { configured: true, username: "lancers", checkedAt: "2026-10-28T15:00:00.000Z" }, FTC: unconfigured });
  assert.deepEqual((await status()).body, saved.body);
  // The season from the root, then one authenticated call that needs a valid credential.
  assert.deepEqual(first.requests.map((request) => request.url), [firstRootUrl("FRC"), firstSeasonUrl("FRC", 2026)]);
  assert.ok(first.requests.every((request) => request.authorization === basicAuthorization("lancers", "frc-token-0001")));
  const stored = harness.db.rows<Record<string, unknown>>("SELECT * FROM visits_first_credentials");
  assert.equal(stored.length, 1);
  assert.doesNotMatch(JSON.stringify(stored), /frc-token-0001/);
  assert.deepEqual(await credentials.decrypt(String(stored[0]!.ciphertext), String(stored[0]!.iv)), { token: "frc-token-0001" });
  assert.doesNotMatch(JSON.stringify(saved.body), /token-0001/);

  // FIRST refuses a wrong token: a plain message on the token field, and nothing is saved.
  const rejected = await harness.call("PUT", "/admin/visits/settings/first-api", { body: { ...ftcCredential, token: "wrong-token-0002" } });
  assert.equal(rejected.status, 400);
  assert.deepEqual(rejected.body, { error: "FIRST did not accept this FTC username and token. Check both and save again.", field: "token" });
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_first_credentials WHERE program='FTC'"), 0);
  // FIRST unreachable or failing: 502, nothing saved, and no token in the message. The season is cached by now, so these
  // hit the season summary.
  first.failures.FTC.push("timeout");
  const timedOut = await harness.call("PUT", "/admin/visits/settings/first-api", { body: ftcCredential });
  assert.equal(timedOut.status, 502);
  assert.doesNotMatch(JSON.stringify(timedOut.body), /token-0001|lancers/);
  first.failures.FTC.push(503);
  assert.equal((await harness.call("PUT", "/admin/visits/settings/first-api", { body: ftcCredential })).status, 502);
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_first_credentials WHERE program='FTC'"), 0);
  // Core cannot encrypt: 409 before FIRST is asked.
  credentials.available = false;
  first.requests.length = 0;
  const unavailable = await harness.call("PUT", "/admin/visits/settings/first-api", { body: ftcCredential });
  assert.equal(unavailable.status, 409);
  assert.deepEqual(first.requests, []);
  credentials.available = true;

  // Admin only, from the dashboard, with known fields.
  assert.equal((await harness.call("GET", "/admin/visits/settings/first-api", { role: "operator" })).status, 403);
  assert.equal((await harness.call("PUT", "/admin/visits/settings/first-api", { body: ftcCredential, role: "operator" })).status, 403);
  assert.equal((await harness.call("PUT", "/admin/visits/settings/first-api", { body: ftcCredential, origin: "https://elsewhere.example.org" })).status, 403);
  assert.equal((await harness.call("DELETE", "/admin/visits/settings/first-api?program=FRC", { origin: null })).status, 403);
  assert.equal((await harness.call("PUT", "/admin/visits/settings/first-api", { body: { ...ftcCredential, extra: true } })).body.field, "extra");
  assert.equal((await harness.call("POST", "/admin/visits/settings/first-api", { body: ftcCredential })).status, 405);
  assert.equal((await harness.call("DELETE", "/admin/visits/settings/first-api?program=Explore")).body.field, "program");
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_first_credentials"), 1);
});

test("a search asks FIRST for each configured program, falls back to the previous season, and merges saved teams", async () => {
  const { harness, first } = await lookupHarness([frcCredential, ftcCredential]);
  first.add("FRC", 2026, { teamNumber: 321, nameShort: "Lancers", nameFull: "Lansdale Lancer Robotics", city: "Lansdale", stateProv: "Pennsylvania", country: "USA" });
  first.add("FTC", 2024, { teamNumber: 321, nameShort: "", nameFull: "Lancer Tech", city: "Hamilton", stateProv: "Ontario", country: "Canada" });
  saveTeam(harness, "team-1", "FRC", "321", "Old name");
  saveTeam(harness, "team-2", "Explore", "321", "Little Lancers");
  const found = await search(harness, "321");
  assert.equal(found.status, 200);
  assert.deepEqual(found.body, {
    matches: [match("FRC", "321", "Lancers", "Lansdale, Pennsylvania"), match("FTC", "321", "Lancer Tech", "Hamilton, Ontario"), match("Explore", "321", "Little Lancers", "", "saved")],
    complete: true,
  });
  // Seasons came from the cache the credential checks filled; FTC's current season had no team 321, so 2024 was asked.
  assert.deepEqual(first.requests.map((request) => request.url).sort(), [firstTeamsUrl("FRC", 2026, "321"), firstTeamsUrl("FTC", 2024, "321"), firstTeamsUrl("FTC", 2025, "321")].sort());
  for (const request of first.requests) {
    assert.equal(new URL(request.url).search, "?teamNumber=321", "only the team number goes to FIRST");
    assert.equal(request.authorization, request.url.includes("frc-api") ? basicAuthorization("lancers", "frc-token-0001") : basicAuthorization("lancers-ftc", "ftc-token-0001"));
  }
  // A program FIRST does not know the number in leaves its saved team.
  saveTeam(harness, "team-3", "FTC", "999", "Saved Nines");
  assert.deepEqual((await search(harness, "999")).body, { matches: [match("FTC", "999", "Saved Nines", "", "saved")], complete: true });
});

test("answers, no team included, are cached for a week and seasons for a day", async () => {
  const { harness, first } = await lookupHarness([frcCredential, ftcCredential]);
  first.add("FRC", 2026, { teamNumber: 321, nameShort: "Lancers", city: "Lansdale", stateProv: "Pennsylvania", country: "USA" });
  first.add("FTC", 2025, { teamNumber: 321, nameShort: "Lancer Tech", city: "Lansdale", stateProv: "Pennsylvania", country: "USA" });
  const answer = (await search(harness, "321")).body;
  assert.equal(answer.complete, true);
  assert.equal(first.requests.length, 2);
  assert.deepEqual((await search(harness, "321")).body, answer);
  assert.deepEqual((await search(harness, "9999")).body, { matches: [], complete: true });
  assert.equal(first.requests.length, 6, "no team: both seasons in both programs");
  assert.deepEqual((await search(harness, "9999")).body, { matches: [], complete: true });
  assert.equal(first.requests.length, 6, "repeats come from the cache, no team included");
  // A day later the season is asked again for a new number; cached answers still serve.
  harness.clock.now += dayMs + 60_000;
  first.requests.length = 0;
  assert.deepEqual((await search(harness, "321")).body, answer);
  assert.deepEqual(first.requests, []);
  first.seasons = { FRC: 2027, FTC: 2026 };
  first.add("FRC", 2027, { teamNumber: 254, nameShort: "Cheesy Poofs", city: "San Jose", stateProv: "California", country: "USA" });
  await search(harness, "254");
  assert.deepEqual(first.requests.map((request) => request.url).sort(), [
    firstRootUrl("FRC"), firstTeamsUrl("FRC", 2027, "254"), firstRootUrl("FTC"), firstTeamsUrl("FTC", 2026, "254"), firstTeamsUrl("FTC", 2025, "254"),
  ].sort());
  // After a week the answer is asked again, and the expired rows are gone.
  harness.clock.now += 7 * dayMs;
  first.requests.length = 0;
  first.add("FRC", 2027, { teamNumber: 321, nameShort: "Lancers 2027", city: "Lansdale", stateProv: "Pennsylvania", country: "USA" });
  assert.equal((await search(harness, "321")).body.matches[0].name, "Lancers 2027");
  assert.ok(first.requests.some((request) => request.url === firstTeamsUrl("FRC", 2027, "321")));
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_first_teams WHERE number='9999'"), 0);
});

test("failures, timeouts, refused tokens and unreadable credentials leave a search incomplete and uncached", async () => {
  const { harness, first, credentials } = await lookupHarness([frcCredential, ftcCredential]);
  first.add("FRC", 2026, { teamNumber: 321, nameShort: "Lancers" });
  first.add("FTC", 2025, { teamNumber: 321, nameShort: "Lancer Tech" });
  first.failures.FRC.push("timeout");
  assert.deepEqual((await search(harness, "321")).body, { matches: [match("FTC", "321", "Lancer Tech")], complete: false });
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_first_teams WHERE program='FRC'"), 0);
  first.failures.FRC.push(500);
  assert.equal((await search(harness, "321")).body.complete, false);
  // The previous season failing after an empty current season is no answer either.
  first.failures.FTC.push("ok", 503);
  assert.deepEqual((await search(harness, "4242")).body, { matches: [], complete: false });
  assert.deepEqual((await search(harness, "321")).body, { matches: [match("FRC", "321", "Lancers"), match("FTC", "321", "Lancer Tech")], complete: true });
  // A token FIRST no longer accepts.
  first.accepted.delete(basicAuthorization("lancers", "frc-token-0001"));
  assert.deepEqual((await search(harness, "777")).body, { matches: [], complete: false });
  first.accepted.add(basicAuthorization("lancers", "frc-token-0001"));
  // Core cannot decrypt, or cannot encrypt at all: FIRST is not asked.
  first.requests.length = 0;
  credentials.failDecrypt = true;
  assert.equal((await search(harness, "778")).body.complete, false);
  credentials.failDecrypt = false;
  credentials.available = false;
  assert.equal((await search(harness, "779")).body.complete, false);
  assert.deepEqual(first.requests, []);
});

test("the per-minute limit stops uncached lookups; cached answers still come back", async () => {
  const { harness, first } = await lookupHarness([frcCredential, ftcCredential]);
  for (let number = 1; number <= 20; number += 1) {
    first.add("FRC", 2026, { teamNumber: number, nameShort: `FRC ${number}` });
    first.add("FTC", 2025, { teamNumber: number, nameShort: `FTC ${number}` });
  }
  // Seasons are cached by the credential checks, which do not count; each search is then one request per program.
  for (let number = 1; number <= firstRequestLimit / 2; number += 1) assert.equal((await search(harness, String(number))).body.complete, true, String(number));
  assert.equal(first.requests.length, firstRequestLimit);
  saveTeam(harness, "team-1", "Challenge", "16", "Lego Sixteen");
  assert.deepEqual((await search(harness, "16")).body, { matches: [match("Challenge", "16", "Lego Sixteen", "", "saved")], complete: false });
  assert.equal(first.requests.length, firstRequestLimit, "FIRST is not asked over the limit");
  assert.deepEqual((await search(harness, "1")).body, { matches: [match("FRC", "1", "FRC 1"), match("FTC", "1", "FTC 1")], complete: true });
  // A minute later the limit has room again, and the old request records are gone.
  harness.clock.now += 60_001;
  assert.equal((await search(harness, "16")).body.complete, true);
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_first_requests"), 2);
});

test("removing a credential forgets it and its cached answers; the program is then searched no more", async () => {
  const { harness, first } = await lookupHarness([frcCredential, ftcCredential]);
  first.add("FRC", 2026, { teamNumber: 321, nameShort: "Lancers" });
  await search(harness, "321");
  const removed = await harness.call("DELETE", "/admin/visits/settings/first-api?program=FRC");
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.FRC, { configured: false, username: "", checkedAt: null });
  assert.equal(removed.body.FTC.configured, true);
  for (const table of ["visits_first_credentials", "visits_first_teams", "visits_first_seasons"]) assert.equal(harness.count(`SELECT COUNT(*) AS n FROM ${table} WHERE program='FRC'`), 0, table);
  first.requests.length = 0;
  assert.deepEqual((await search(harness, "321")).body, { matches: [], complete: false });
  assert.ok(first.requests.every((request) => request.url.startsWith("https://ftc-api.firstinspires.org/")));
});
