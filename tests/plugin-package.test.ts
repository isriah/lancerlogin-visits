// Fast checks of the declarations Core validates when it composes the plugin, so mistakes show up before Verify runs.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import manifest from "../src/manifest.ts";
import {
  visitsBackupColumns, visitsCleanupSteps, visitsCleanupTargets, visitsNonPortableTables, visitsPortableTables, visitsTables, visitsTransientAuthority,
} from "../src/shared/visits-storage.ts";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const pkg = JSON.parse(read("package.json"));
const release = JSON.parse(read(".github/plugin-release.json"));

test("package.json, the manifest and plugin-release.json agree", () => {
  assert.equal(manifest.id, pkg.lancerlogin.moduleId);
  assert.equal(manifest.id, "visits");
  assert.equal(manifest.contractVersion, pkg.lancerlogin.contract);
  assert.equal(manifest.tablePrefix, pkg.lancerlogin.tablePrefix);
  assert.equal(pkg.name, `lancerlogin-module-${manifest.id}`);
  assert.match(release.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.equal(release.repository, "isriah/lancerlogin-visits");
  assert.equal(release.title, "LancerLogin Guest Visits plugin");
  assert.match(release.core.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(Object.keys(pkg.peerDependencies).sort(), ["@lancerlogin/module-sdk", "react"]);
});

test("routes, navigation and settings live under the module's own namespace", () => {
  for (const route of manifest.apiRoutes) assert.match(route.path, new RegExp(`^/(admin|public|module-setup)/${manifest.id}(/|$)`));
  for (const item of [...manifest.navigation, ...manifest.settings]) assert.ok(item.path === `/${manifest.id}` || item.path === `/settings/${manifest.id}`, item.path);
  assert.deepEqual(manifest.apiRoutes.map((route) => [route.path, route.access]), [["/admin/visits", "workspace"], ["/public/visits", "service"], ["/module-setup/visits", "setup"]]);
  assert.deepEqual(manifest.capabilities, [{ id: "visits.manage", label: "Manage Guest Visits", operator: true }]);
});

test("every table is prefixed, declared and classified for backup and cleanup", () => {
  const sql = readdirSync(new URL("migrations/", root)).filter((name) => name.endsWith(".sql")).map((name) => read(`migrations/${name}`)).join("\n");
  const created = [...sql.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1]);
  assert.deepEqual(created, [...manifest.persistence.tables]);
  assert.deepEqual(created, [...visitsTables]);
  for (const table of created) {
    assert.ok(table!.startsWith(manifest.tablePrefix), table);
    const portable = (manifest.backup.tables as readonly string[]).includes(table!);
    const nonPortable = (manifest.backup.nonPortableTables as readonly string[]).includes(table!);
    assert.ok(portable !== nonPortable, `${table} is either backed up or non-portable`);
    assert.ok((manifest.lifecycle.cleanupTargets as readonly string[]).includes(table!), `${table} is cleaned up`);
  }
  assert.deepEqual([...manifest.backup.tables], visitsPortableTables);
  assert.deepEqual([...manifest.backup.nonPortableTables], [...visitsNonPortableTables]);
  assert.deepEqual([...manifest.lifecycle.cleanupTargets], [...visitsCleanupTargets]);
  assert.deepEqual(JSON.parse(JSON.stringify(manifest.persistence.transientAuthority)), JSON.parse(JSON.stringify(visitsTransientAuthority)));
  assert.deepEqual(Object.keys(visitsBackupColumns), visitsPortableTables);
});

test("cleanup steps cover every table and the module's setup progress and assignments, in target order", () => {
  const targets = visitsCleanupSteps.map((step) => step.kind === "assignments" ? `platform_module_assignments:${manifest.id}` : step.table === "platform_module_setup_progress" ? `${step.table}:${manifest.id}` : step.table);
  assert.deepEqual(targets, [...visitsCleanupTargets]);
  const setupStep = visitsCleanupSteps.find((step) => step.kind === "delete" && step.table === "platform_module_setup_progress");
  assert.deepEqual(setupStep, { kind: "delete", table: "platform_module_setup_progress", where: "module_id=?", bindings: ["visits"] });
});

test("migrations are numbered from 0001 and match their reviewed hashes", () => {
  const files = readdirSync(new URL("migrations/", root)).filter((name) => name.endsWith(".sql")).sort();
  const reviewed = JSON.parse(read("migrations/reviewed.json")) as { name: string; sha256: string }[];
  assert.deepEqual(reviewed.map((entry) => entry.name), files);
  files.forEach((name, index) => {
    assert.match(name, new RegExp(`^${String(index + 1).padStart(4, "0")}_[a-z0-9_]+\\.sql$`));
    const hash = createHash("sha256").update(read(`migrations/${name}`).replaceAll("\r\n", "\n")).digest("hex");
    assert.equal(reviewed[index]!.sha256, hash, `${name} changed after review; released migrations are never edited`);
  });
});

test("src/shared modules import only each other, so npm test runs without Core", () => {
  const directory = new URL("src/shared/", root);
  const files = readdirSync(directory).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length > 0);
  for (const name of files) {
    const source = readFileSync(new URL(name, directory), "utf8");
    const specifiers = [...source.matchAll(/^\s*(?:import|export)\b[^"']*?\bfrom\s+["']([^"']+)["']/gm), ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g), ...source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)].map((match) => match[1]!);
    for (const specifier of specifiers) assert.match(specifier, /^\.\/visits-[a-z]+\.ts$/, `${name} imports ${specifier}`);
    assert.doesNotMatch(source, /\brequire\s*\(/, `${name} uses require`);
  }
});

test("authored text uses no em or en dashes", () => {
  const scan = (directory: string): string[] => readdirSync(new URL(directory, root), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}${entry.name}`;
    if (entry.isDirectory()) return scan(`${path}/`);
    return /\.(ts|tsx|sql|md|json)$/.test(entry.name) ? [path] : [];
  });
  for (const path of ["README.md", ...scan("src/"), ...scan("tests/"), ...scan("migrations/")]) {
    assert.doesNotMatch(read(path), /[\u2013\u2014]/, path);
  }
});
