import test from "node:test";
import assert from "node:assert/strict";
import { addNote, installationId, listNotes, maximumNoteLength, maximumNotes, newNote, parseNoteInput, type NotesDatabase } from "../src/notes.ts";

test("note input is trimmed, collapsed and bounded", () => {
  assert.deepEqual(parseNoteInput({ text: "  Bring   the banner  " }), { text: "Bring the banner" });
  assert.deepEqual(parseNoteInput({ text: "x".repeat(maximumNoteLength) }), { text: "x".repeat(maximumNoteLength) });
  for (const value of [undefined, null, [], "text", {}, { text: 4 }, { text: "   " }]) assert.ok("error" in parseNoteInput(value), JSON.stringify(value));
  assert.match((parseNoteInput({ text: "x".repeat(maximumNoteLength + 1) }) as { error: string }).error, /at most 200 characters/);
});

test("a new note records its text, ID and creation time", () => {
  assert.deepEqual(newNote({ text: "Hello" }, new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), "note-1"), { id: "note-1", text: "Hello", createdAt: "2026-01-02T03:04:05.000Z" });
  assert.match(newNote({ text: "Hello" }).id, /^[0-9a-f-]{36}$/);
});

// A small in-memory stand-in for D1 that records statements and returns canned rows.
function fakeDatabase(rows: Record<string, unknown>[], count = rows.length) {
  const statements: { sql: string; values: unknown[] }[] = [];
  const db: NotesDatabase = {
    prepare(sql) {
      return {
        bind(...values) {
          statements.push({ sql, values });
          return {
            async all<T>() { return { results: rows as T[] }; },
            async first<T>() { return { count } as T; },
            async run() { return {}; },
          };
        },
      };
    },
  };
  return { db, statements };
}

test("queries read and write only this module's table for the installation", async () => {
  const { db, statements } = fakeDatabase([{ id: "a", text: "First", created_at: "2026-01-01T00:00:00.000Z" }]);
  assert.deepEqual(await listNotes(db), [{ id: "a", text: "First", createdAt: "2026-01-01T00:00:00.000Z" }]);
  assert.equal(await addNote(db, newNote({ text: "Second" }, new Date(0), "b")), true);
  for (const { sql, values } of statements) {
    const tables = [...sql.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+(\w+)/gi)].map((match) => match[1]);
    assert.ok(tables.length > 0, sql);
    assert.deepEqual(new Set(tables), new Set(["example_module_notes"]), sql);
    assert.ok(values.includes(installationId), sql);
  }
});

test("adding stops at the maximum number of notes", async () => {
  const { db, statements } = fakeDatabase([], maximumNotes);
  assert.equal(await addNote(db, newNote({ text: "One too many" })), false);
  assert.equal(statements.some(({ sql }) => sql.startsWith("INSERT")), false);
});
