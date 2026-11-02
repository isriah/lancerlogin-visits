// Team lookup by number through Core's shared FIRST connection: reading Core's answers, merging with saved guest teams,
// falling back when a program cannot answer, and the Team lookup settings status, through the Worker routes with a synthetic stand-in for `services.first`. Synthetic data only; no
// request leaves the process.
import test from "node:test";
import assert from "node:assert/strict";
import { visitsHarness, type Harness } from "./helpers/visits-harness.ts";
import type { TeamMatch } from "../src/shared/visits-api.ts";
import { firstMatchesOf, mergeTeamMatches } from "../src/shared/visits-team-search.ts";

const match = (program: TeamMatch["program"], number: string, name: string, location = "", source: TeamMatch["source"] = "first"): TeamMatch => ({ number, name, program, location, source });
const search = (harness: Harness, number: string) => harness.call("GET", `/public/visits/team-search?${new URLSearchParams({ number })}`, { role: null });
const lookupStatus = (harness: Harness) => harness.call("GET", "/admin/visits/settings/first-api");

function saveTeam(harness: Harness, id: string, program: string, number: string, name: string, archived = 0) {
  harness.db.sqlite.prepare("INSERT INTO visits_teams(installation_id,id,number,name,program,archived,created_at,updated_at) VALUES('primary',?,?,?,?,?,'x','x')").run(id, number, name, program, archived);
}


test("Core's answers become FRC, FTC, FLL Challenge and FLL Explore matches; other programs and nameless teams are ignored", () => {
  const team = (name: unknown, location: unknown = "Testville, PA") => ({ program: "FRC", number: "9001", name, location, season: 2026, source: "events-api" });
  assert.deepEqual(firstMatchesOf([
    { program: "FRC", status: "found", team: team("Test Team Alpha") },
    { program: "FTC", status: "not-found" },
    { program: "Challenge", status: "found", team: team("Test Lego Team", "Sampleton, OH") },
    { program: "Explore", status: "unavailable" },
    { program: "Other", status: "found", team: team("Test Club") },
    { program: "FLL", status: "found", team: team("Test Wrong Code") },
  ], "9001"), [match("FRC", "9001", "Test Team Alpha", "Testville, PA"), match("Challenge", "9001", "Test Lego Team", "Sampleton, OH")]);
  assert.deepEqual(firstMatchesOf([{ program: "Explore", status: "found", team: team("Test Explore Team", "") }], "45"), [match("Explore", "45", "Test Explore Team")]);
  assert.deepEqual(firstMatchesOf([{ program: "FTC", status: "found", team: team("  ") }, { program: "FRC", status: "found", team: team("Test Team Beta", null) }] as never, "9001"), [match("FRC", "9001", "Test Team Beta")]);
});

test("matches are one per program, FIRST's over a saved team's, in the order FRC, FTC, then the rest", () => {
  const merged = mergeTeamMatches(
    [match("FTC", "9001", "Test Team Beta"), match("FRC", "9001", "Test Team Alpha")],
    [match("Other", "9001", "Test Club", "", "saved"), match("FRC", "9001", "Old test name", "", "saved"), match("Challenge", "9001", "Test Lego Team", "", "saved")],
  );
  assert.deepEqual(merged.map((item) => [item.program, item.name, item.source]), [["FRC", "Test Team Alpha", "first"], ["FTC", "Test Team Beta", "first"], ["Challenge", "Test Lego Team", "saved"], ["Other", "Test Club", "saved"]]);
});

test("without a credential in Core a search answers FLL and saved teams, incomplete, and asks Core for every program but Other", async () => {
  const harness = visitsHarness();
  saveTeam(harness, "team-1", "FRC", "9001", "Saved Test Team");
  saveTeam(harness, "team-2", "Challenge", "9001", "Test Lego Team");
  saveTeam(harness, "team-3", "FTC", "9001", "Merged away", 1);
  const found = await search(harness, "09001");
  assert.equal(found.status, 200);
  assert.deepEqual(found.body, { matches: [match("FRC", "9001", "Saved Test Team", "", "saved"), match("Challenge", "9001", "Test Lego Team", "", "saved")], complete: false });
  assert.deepEqual(harness.first.searches, [{ number: "9001", programs: ["FRC", "FTC", "Challenge", "Explore"] }]);
  for (const number of ["", "abc", "12a", "1234567", "0"]) {
    const refused = await search(harness, number);
    assert.equal(refused.status, 400, number);
    assert.deepEqual(refused.body, { error: "Enter a team number of 1 to 6 digits", field: "number" });
  }
  assert.equal(harness.first.searches.length, 1, "a number that is not a team number never reaches Core");
});

test("a found team fills the name and location; not found in any program is a complete answer", async () => {
  const harness = visitsHarness();
  harness.first.configure("FRC");
  harness.first.configure("FTC");
  harness.first.team("FRC", "9001", "Test Team Alpha", "Testville, PA");
  harness.first.team("FTC", "9001", "Test Team Beta", "Sampleton, Ontario");
  harness.first.team("Challenge", "9001", "Test Lego Team");
  saveTeam(harness, "team-1", "FRC", "9001", "Old test name");
  saveTeam(harness, "team-2", "Other", "9001", "Test Club");
  assert.deepEqual((await search(harness, "9001")).body, {
    matches: [match("FRC", "9001", "Test Team Alpha", "Testville, PA"), match("FTC", "9001", "Test Team Beta", "Sampleton, Ontario"), match("Challenge", "9001", "Test Lego Team"), match("Other", "9001", "Test Club", "", "saved")],
    complete: true,
  });
  assert.deepEqual((await search(harness, "9002")).body, { matches: [], complete: true }, "no team in any program: the guest is asked for the program and name");
  assert.ok(harness.first.searches.every((asked) => JSON.stringify(asked.programs) === JSON.stringify(["FRC", "FTC", "Challenge", "Explore"])));
});

test("FLL Challenge and FLL Explore teams are found without any credential, and a number in both is a choice", async () => {
  const harness = visitsHarness();
  harness.first.team("Challenge", "12345", "Test Team A", "Testville, PA");
  harness.first.team("Explore", "12345", "Test Team B");
  harness.first.team("Explore", "678", "Test Team C", "Sampleton, OH");
  assert.deepEqual((await search(harness, "12345")).body, {
    matches: [match("Challenge", "12345", "Test Team A", "Testville, PA"), match("Explore", "12345", "Test Team B")],
    complete: false,
  }, "FRC and FTC have no credential, so the answer is incomplete, but FLL still answers");
  harness.first.configure("FRC");
  harness.first.configure("FTC");
  assert.deepEqual((await search(harness, "678")).body, { matches: [match("Explore", "678", "Test Team C", "Sampleton, OH")], complete: true });
  harness.first.failures.set("Challenge", "provider-error");
  assert.deepEqual((await search(harness, "12345")).body, { matches: [match("Explore", "12345", "Test Team B")], complete: false }, "FIRST's team search failing for one program leaves the search incomplete");
});

test("a program Core cannot answer leaves the search incomplete, and a Core failure answers saved teams only", async () => {
  const harness = visitsHarness();
  harness.first.configure("FRC");
  harness.first.configure("FTC");
  harness.first.team("FRC", "9001", "Test Team Alpha");
  saveTeam(harness, "team-1", "FTC", "9001", "Saved Test Team");
  for (const reason of ["rate-limited", "timeout", "provider-error"] as const) {
    harness.first.failures.set("FTC", reason);
    assert.deepEqual((await search(harness, "9001")).body, { matches: [match("FRC", "9001", "Test Team Alpha"), match("FTC", "9001", "Saved Test Team", "", "saved")], complete: false }, reason);
  }
  harness.first.broken = new Error("Core could not read the FIRST cache");
  assert.deepEqual((await search(harness, "9001")).body, { matches: [match("FTC", "9001", "Saved Test Team", "", "saved")], complete: false });
});

test("the Team lookup settings status is Admin only, and credentials are no longer saved or removed in Guest Visits", async () => {
  const harness = visitsHarness();
  harness.first.configure("FRC");
  assert.deepEqual((await lookupStatus(harness)).body, { programs: { FRC: { available: true, checkedAt: "2026-10-01T12:00:00.000Z" }, FTC: { available: false, checkedAt: null }, Challenge: { available: true, checkedAt: null }, Explore: { available: true, checkedAt: null } } });
  harness.first.broken = new Error("Core is unavailable");
  const off = { available: false, checkedAt: null };
  assert.deepEqual((await lookupStatus(harness)).body, { programs: { FRC: off, FTC: off, Challenge: off, Explore: off } }, "a Core that cannot answer reads as off");
  harness.first.broken = null;
  assert.equal((await harness.call("GET", "/admin/visits/settings/first-api", { role: "operator" })).status, 403);
  assert.equal((await harness.call("PUT", "/admin/visits/settings/first-api", { body: { program: "FRC", username: "synthetic-admin", token: "synthetic-token" } })).status, 405);
  assert.equal((await harness.call("DELETE", "/admin/visits/settings/first-api?program=FRC")).status, 405);
  assert.equal(harness.first.credentials.get("FRC")?.username, "synthetic-admin");
});
