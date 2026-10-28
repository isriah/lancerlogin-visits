// Fast checks of the declarations Core validates when it composes the plugin, so mistakes show up before Verify runs.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import manifest from "../src/manifest.ts";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const pkg = JSON.parse(read("package.json"));
const release = JSON.parse(read(".github/plugin-release.json"));

test("package.json, the manifest and plugin-release.json agree", () => {
  assert.equal(manifest.id, pkg.lancerlogin.moduleId);
  assert.equal(manifest.contractVersion, pkg.lancerlogin.contract);
  assert.equal(manifest.tablePrefix, pkg.lancerlogin.tablePrefix);
  assert.equal(pkg.name, `lancerlogin-module-${manifest.id}`);
  assert.match(release.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(release.core.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(Object.keys(pkg.peerDependencies).sort(), ["@lancerlogin/module-sdk", "react"]);
});

test("routes, navigation and settings live under the module's own namespace", () => {
  for (const route of manifest.apiRoutes) assert.match(route.path, new RegExp(`^/(admin|public|module-setup)/${manifest.id}(/|$)`));
  for (const item of [...manifest.navigation, ...manifest.settings]) assert.ok(item.path === `/${manifest.id}` || item.path === `/settings/${manifest.id}`, item.path);
});

test("every table is prefixed, declared and classified for backup and cleanup", () => {
  const sql = readdirSync(new URL("migrations/", root)).filter((name) => name.endsWith(".sql")).map((name) => read(`migrations/${name}`)).join("\n");
  const created = [...sql.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1]);
  assert.deepEqual(created, [...manifest.persistence.tables]);
  for (const table of created) {
    assert.ok(table.startsWith(manifest.tablePrefix), table);
    assert.ok(manifest.backup.tables.includes(table as never), `${table} is backed up`);
    assert.ok(manifest.lifecycle.cleanupTargets.includes(table as never), `${table} is cleaned up`);
  }
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
