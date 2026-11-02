import test from "node:test";
import assert from "node:assert/strict";
import type { PublicTeamSearch, TeamMatch } from "../src/shared/visits-api.ts";
import { manualReason, searchableNumber, teamAfterSearch, teamEntryMode, type TeamSearch } from "../src/dashboard/visits-team-entry.ts";

const frc: TeamMatch = { program: "FRC", number: "99954", name: "Test Team Beta", location: "Testville, CA", source: "first" };
const ftc: TeamMatch = { program: "FTC", number: "99954", name: "Test Heads", location: "Austin, TX", source: "first" };
const found = (matches: TeamMatch[], complete = true): TeamSearch => ({ status: "found", number: "99954", result: { matches, complete } satisfies PublicTeamSearch });

test("only plain numbers of up to six digits are looked up", () => {
  assert.equal(searchableNumber(" 99954 "), "99954");
  assert.equal(searchableNumber("099954"), "99954", "leading zeros are dropped");
  assert.equal(searchableNumber("0"), "0");
  assert.equal(searchableNumber("1234567"), null);
  assert.equal(searchableNumber("ABC12"), null);
  assert.equal(searchableNumber(""), null);
});

test("the form confirms one match, offers several and asks by hand otherwise", () => {
  assert.equal(teamEntryMode({ status: "idle" }, false, ""), "none");
  assert.equal(teamEntryMode({ status: "searching", number: "99954" }, false, "99954"), "searching");
  assert.equal(teamEntryMode({ status: "idle" }, false, "99954"), "searching", "a typed number waits for its lookup");
  assert.equal(teamEntryMode(found([frc]), false, "99954"), "confirm");
  assert.equal(teamEntryMode(found([frc, ftc]), false, "99954"), "pick");
  assert.equal(teamEntryMode(found([]), false, "99954"), "manual");
  assert.equal(teamEntryMode({ status: "failed", number: "99954" }, false, "99954"), "manual");
  assert.equal(teamEntryMode(found([frc]), true, "99954"), "manual", "Not your team? wins over a match");
  assert.equal(teamEntryMode({ status: "idle" }, false, "ROBO-7"), "manual", "a number FIRST does not use is typed by hand");
});

test("the form says why it asks by hand", () => {
  assert.match(manualReason(found([]), false, "99954"), /No team 99954 was found/);
  assert.match(manualReason(found([], false), false, "99954"), /not available right now/);
  assert.match(manualReason({ status: "failed", number: "99954" }, false, "99954"), /not available right now/);
  assert.equal(manualReason(found([frc]), true, "99954"), "", "a guest who chose to type needs no reason");
  assert.equal(manualReason({ status: "idle" }, false, "ROBO-7"), "");
});

test("a lookup fills, keeps or clears the program and name", () => {
  const empty = { program: "" as const, teamName: "" };
  assert.deepEqual(teamAfterSearch([frc], empty, false), { program: "FRC", teamName: "Test Team Beta" });
  assert.deepEqual(teamAfterSearch([frc, ftc], { program: "FTC", teamName: "old" }, true), { program: "FTC", teamName: "Test Heads" }, "a chosen program among the matches keeps its match");
  assert.deepEqual(teamAfterSearch([frc, ftc], { program: "FLL", teamName: "Bricks" } as never, true), empty, "values an earlier lookup filled are cleared");
  assert.deepEqual(teamAfterSearch([], { program: "Other", teamName: "Typed" }, false), { program: "Other", teamName: "Typed" }, "values the guest typed stay");
});
