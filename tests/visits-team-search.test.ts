// Team lookup by number through Core's shared FIRST connection: reading Core's answers, merging with saved guest teams,
// falling back when a program cannot answer, moving FIRST credentials saved in Guest Visits to Core, and the Team lookup
// settings status, through the Worker routes with a synthetic stand-in for `services.first`. Synthetic data only; no
// request leaves the process.
import test from "node:test";
import assert from "node:assert/strict";
import { FakeFirstConnection, visitsHarness, type Harness } from "./helpers/visits-harness.ts";
import type { TeamMatch } from "../src/shared/visits-api.ts";
import { firstMatchesOf, mergeTeamMatches } from "../src/shared/visits-team-search.ts";

const match = (program: TeamMatch["program"], number: string, name: string, location = "", source: TeamMatch["source"] = "first"): TeamMatch => ({ number, name, program, location, source });
const search = (harness: Harness, number: string) => harness.call("GET", `/public/visits/team-search?${new URLSearchParams({ number })}`, { role: null });
const lookupStatus = (harness: Harness) => harness.call("GET", "/admin/visits/settings/first-api");

function saveTeam(harness: Harness, id: string, program: string, number: string, name: string, archived = 0) {
  harness.db.sqlite.prepare("INSERT INTO visits_teams(installation_id,id,number,name,program,archived,created_at,updated_at) VALUES('primary',?,?,?,?,?,'x','x')").run(id, number, name, program, archived);
}

/** A FIRST credential saved in Guest Visits before team lookup moved to Core: synthetic ciphertext, never a token. */
function saveLegacyCredential(harness: Harness, program: "FRC" | "FTC", username = `synthetic-${program.toLowerCase()}-user`) {
  harness.db.sqlite.prepare("INSERT INTO visits_first_credentials(installation_id,program,username,ciphertext,iv,checked_at) VALUES('primary',?,?,?,?,?)")
    .run(program, username, `synthetic-ciphertext-${program.toLowerCase()}`, `synthetic-iv-${program.toLowerCase()}`, "2026-09-15T18:30:00.000Z");
}
const legacyPrograms = (harness: Harness) => harness.db.rows<{ program: string }>("SELECT program FROM visits_first_credentials ORDER BY program").map((row) => row.program);

test("Core's answers become FRC and FTC matches; other programs and nameless teams are ignored", () => {
  const team = (name: unknown, location: unknown = "Testville, PA") => ({ program: "FRC", number: "9001", name, location, season: 2026, source: "events-api" });
  assert.deepEqual(firstMatchesOf([
    { program: "FRC", status: "found", team: team("Test Team Alpha") },
    { program: "FTC", status: "not-found" },
    { program: "Challenge", status: "found", team: team("Test Lego Team") },
    { program: "Explore", status: "unavailable" },
  ], "9001"), [match("FRC", "9001", "Test Team Alpha", "Testville, PA")]);
  assert.deepEqual(firstMatchesOf([{ program: "FTC", status: "found", team: team("  ") }, { program: "FRC", status: "found", team: team("Test Team Beta", null) }] as never, "9001"), [match("FRC", "9001", "Test Team Beta")]);
});

test("matches are one per program, FIRST's over a saved team's, in the order FRC, FTC, then the rest", () => {
  const merged = mergeTeamMatches(
    [match("FTC", "9001", "Test Team Beta"), match("FRC", "9001", "Test Team Alpha")],
    [match("Other", "9001", "Test Club", "", "saved"), match("FRC", "9001", "Old test name", "", "saved"), match("Challenge", "9001", "Test Lego Team", "", "saved")],
  );
  assert.deepEqual(merged.map((item) => [item.program, item.name, item.source]), [["FRC", "Test Team Alpha", "first"], ["FTC", "Test Team Beta", "first"], ["Challenge", "Test Lego Team", "saved"], ["Other", "Test Club", "saved"]]);
});

test("without a credential in Core a search answers saved teams only, incomplete, and asks Core for FRC and FTC only", async () => {
  const harness = visitsHarness();
  saveTeam(harness, "team-1", "FRC", "9001", "Saved Test Team");
  saveTeam(harness, "team-2", "Challenge", "9001", "Test Lego Team");
  saveTeam(harness, "team-3", "FTC", "9001", "Merged away", 1);
  const found = await search(harness, "09001");
  assert.equal(found.status, 200);
  assert.deepEqual(found.body, { matches: [match("FRC", "9001", "Saved Test Team", "", "saved"), match("Challenge", "9001", "Test Lego Team", "", "saved")], complete: false });
  assert.deepEqual(harness.first.searches, [{ number: "9001", programs: ["FRC", "FTC"] }]);
  for (const number of ["", "abc", "12a", "1234567", "0"]) {
    const refused = await search(harness, number);
    assert.equal(refused.status, 400, number);
    assert.deepEqual(refused.body, { error: "Enter a team number of 1 to 6 digits", field: "number" });
  }
  assert.equal(harness.first.searches.length, 1, "a number that is not a team number never reaches Core");
});

test("a found team fills the name and location; not found in both programs is a complete answer", async () => {
  const harness = visitsHarness();
  harness.first.configure("FRC");
  harness.first.configure("FTC");
  harness.first.team("FRC", "9001", "Test Team Alpha", "Testville, PA");
  harness.first.team("FTC", "9001", "Test Team Beta", "Sampleton, Ontario");
  harness.first.team("Challenge", "9001", "Test Lego Team");
  saveTeam(harness, "team-1", "FRC", "9001", "Old test name");
  saveTeam(harness, "team-2", "Other", "9001", "Test Club");
  assert.deepEqual((await search(harness, "9001")).body, {
    matches: [match("FRC", "9001", "Test Team Alpha", "Testville, PA"), match("FTC", "9001", "Test Team Beta", "Sampleton, Ontario"), match("Other", "9001", "Test Club", "", "saved")],
    complete: true,
  });
  assert.deepEqual((await search(harness, "9002")).body, { matches: [], complete: true }, "no team in FRC or FTC: the guest is asked for the program and name");
  assert.ok(harness.first.searches.every((asked) => JSON.stringify(asked.programs) === JSON.stringify(["FRC", "FTC"])));
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

test("credentials saved in Guest Visits move to Core on the first search, once per isolate, and Core's own credential wins", async () => {
  const harness = visitsHarness();
  harness.first.configure("FTC", "synthetic-core-admin", "2026-10-20T09:00:00.000Z");
  harness.first.team("FRC", "9001", "Test Team Alpha");
  saveLegacyCredential(harness, "FRC");
  saveLegacyCredential(harness, "FTC");
  // Two guests searching at once share one offer.
  const [first, second] = await Promise.all([search(harness, "9001"), search(harness, "9002")]);
  assert.deepEqual(first.body, { matches: [match("FRC", "9001", "Test Team Alpha")], complete: true }, "the moved FRC credential answers the very first search");
  assert.deepEqual(second.body, { matches: [], complete: true });
  assert.deepEqual(harness.first.imports, [
    { program: "FRC", username: "synthetic-frc-user", ciphertext: "synthetic-ciphertext-frc", iv: "synthetic-iv-frc", checkedAt: "2026-09-15T18:30:00.000Z" },
    { program: "FTC", username: "synthetic-ftc-user", ciphertext: "synthetic-ciphertext-ftc", iv: "synthetic-iv-ftc", checkedAt: "2026-09-15T18:30:00.000Z" },
  ]);
  assert.deepEqual(harness.first.credentials.get("FRC"), { username: "synthetic-frc-user", checkedAt: "2026-09-15T18:30:00.000Z" }, "imported");
  assert.deepEqual(harness.first.credentials.get("FTC"), { username: "synthetic-core-admin", checkedAt: "2026-10-20T09:00:00.000Z" }, "kept-existing: the Admin's Core credential stays");
  assert.deepEqual(legacyPrograms(harness), [], "both copies are deleted once Core has the program");
  await search(harness, "9001");
  assert.equal(harness.first.imports.length, 2, "the isolate offers them only once");
});

test("a credential Core cannot read stays, is reported in Team lookup settings, and goes once Core has its own", async () => {
  const harness = visitsHarness();
  saveLegacyCredential(harness, "FRC");
  saveLegacyCredential(harness, "FTC");
  harness.first.unreadable.add("synthetic-ciphertext-frc");
  const status = await lookupStatus(harness);
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, { programs: { FRC: { available: false, checkedAt: null }, FTC: { available: true, checkedAt: "2026-09-15T18:30:00.000Z" } }, notMoved: ["FRC"] });
  assert.deepEqual(legacyPrograms(harness), ["FRC"]);
  // A new isolate tries again, for example after the integration key is fixed.
  harness.firstImport.settled = false;
  await search(harness, "9001");
  assert.equal(harness.first.imports.filter((item) => item.program === "FRC").length, 2);
  assert.deepEqual(legacyPrograms(harness), ["FRC"]);
  // Once an Admin saves FRC in Settings > Integrations, the unreadable copy is never needed again.
  harness.first.configure("FRC");
  assert.deepEqual((await lookupStatus(harness)).body.notMoved, []);
  assert.deepEqual(legacyPrograms(harness), []);
});

test("a failed offer keeps the credentials and lookups carry on with what Core has", async () => {
  const harness = visitsHarness();
  saveLegacyCredential(harness, "FRC");
  const first = harness.first as FakeFirstConnection;
  first.importLegacyCredential = async () => { throw new Error("Only Guest Visits can import a FIRST credential"); };
  assert.deepEqual((await search(harness, "9001")).body, { matches: [], complete: false });
  assert.deepEqual(legacyPrograms(harness), ["FRC"]);
  first.broken = new Error("Core is unavailable");
  assert.deepEqual((await lookupStatus(harness)).body, { programs: { FRC: { available: false, checkedAt: null }, FTC: { available: false, checkedAt: null } }, notMoved: ["FRC"] });
});

test("the Team lookup settings status is Admin only, and credentials are no longer saved or removed in Guest Visits", async () => {
  const harness = visitsHarness();
  harness.first.configure("FRC");
  assert.deepEqual((await lookupStatus(harness)).body, { programs: { FRC: { available: true, checkedAt: "2026-10-01T12:00:00.000Z" }, FTC: { available: false, checkedAt: null } }, notMoved: [] });
  assert.equal((await harness.call("GET", "/admin/visits/settings/first-api", { role: "operator" })).status, 403);
  assert.equal((await harness.call("PUT", "/admin/visits/settings/first-api", { body: { program: "FRC", username: "synthetic-admin", token: "synthetic-token" } })).status, 405);
  assert.equal((await harness.call("DELETE", "/admin/visits/settings/first-api?program=FRC")).status, 405);
  assert.equal(harness.first.credentials.get("FRC")?.username, "synthetic-admin");
});
