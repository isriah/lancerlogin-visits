import test from "node:test";
import assert from "node:assert/strict";
import type { PublicTeamSearch, TeamMatch } from "../src/shared/visits-api.ts";
import { manualReason, searchableNumber, teamAfterSearch, teamEntryMode, type TeamSearch } from "../src/dashboard/visits-team-entry.ts";

const frc: TeamMatch = { program: "FRC", number: "254", name: "The Cheesy Poofs", location: "San Jose, CA", source: "first" };
const ftc: TeamMatch = { program: "FTC", number: "254", name: "Gear Heads", location: "Austin, TX", source: "first" };
const found = (matches: TeamMatch[], complete = true): TeamSearch => ({ status: "found", number: "254", result: { matches, complete } satisfies PublicTeamSearch });

test("only plain numbers of up to six digits are looked up", () => {
  assert.equal(searchableNumber(" 254 "), "254");
  assert.equal(searchableNumber("0254"), "254", "leading zeros are dropped");
  assert.equal(searchableNumber("0"), "0");
  assert.equal(searchableNumber("1234567"), null);
  assert.equal(searchableNumber("ABC12"), null);
  assert.equal(searchableNumber(""), null);
});

test("the form confirms one match, offers several and asks by hand otherwise", () => {
  assert.equal(teamEntryMode({ status: "idle" }, false, ""), "none");
  assert.equal(teamEntryMode({ status: "searching", number: "254" }, false, "254"), "searching");
  assert.equal(teamEntryMode({ status: "idle" }, false, "254"), "searching", "a typed number waits for its lookup");
  assert.equal(teamEntryMode(found([frc]), false, "254"), "confirm");
  assert.equal(teamEntryMode(found([frc, ftc]), false, "254"), "pick");
  assert.equal(teamEntryMode(found([]), false, "254"), "manual");
  assert.equal(teamEntryMode({ status: "failed", number: "254" }, false, "254"), "manual");
  assert.equal(teamEntryMode(found([frc]), true, "254"), "manual", "Not your team? wins over a match");
  assert.equal(teamEntryMode({ status: "idle" }, false, "ROBO-7"), "manual", "a number FIRST does not use is typed by hand");
});

test("the form says why it asks by hand", () => {
  assert.match(manualReason(found([]), false, "254"), /No team 254 was found/);
  assert.match(manualReason(found([], false), false, "254"), /not available right now/);
  assert.match(manualReason({ status: "failed", number: "254" }, false, "254"), /not available right now/);
  assert.equal(manualReason(found([frc]), true, "254"), "", "a guest who chose to type needs no reason");
  assert.equal(manualReason({ status: "idle" }, false, "ROBO-7"), "");
});

test("a lookup fills, keeps or clears the program and name", () => {
  const empty = { program: "" as const, teamName: "" };
  assert.deepEqual(teamAfterSearch([frc], empty, false), { program: "FRC", teamName: "The Cheesy Poofs" });
  assert.deepEqual(teamAfterSearch([frc, ftc], { program: "FTC", teamName: "old" }, true), { program: "FTC", teamName: "Gear Heads" }, "a chosen program among the matches keeps its match");
  assert.deepEqual(teamAfterSearch([frc, ftc], { program: "FLL", teamName: "Bricks" } as never, true), empty, "values an earlier lookup filled are cleared");
  assert.deepEqual(teamAfterSearch([], { program: "Other", teamName: "Typed" }, false), { program: "Other", teamName: "Typed" }, "values the guest typed stay");
});
