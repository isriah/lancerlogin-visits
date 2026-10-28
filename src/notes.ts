// Note rules and queries shared by the API contribution and the unit tests. Every statement touches only this module's
// own tables (the example_module_ prefix). It imports nothing, so tests run without a Core checkout.

/** LancerLogin installations store their rows under one installation ID. */
export const installationId = "primary";
export const maximumNoteLength = 200;
export const maximumNotes = 500;

export type Note = { readonly id: string; readonly text: string; readonly createdAt: string };
export type NoteInput = { readonly text: string };

/** Minimal database interface: the subset of D1 these queries use. Core passes its D1 binding. */
export type NotesDatabase = {
  prepare(sql: string): { bind(...values: unknown[]): { all<T>(): Promise<{ results?: T[] }>; first<T>(): Promise<T | null>; run(): Promise<unknown> } };
};

/** Validate a request body for a new note, returning the trimmed input or a message for the person. */
export function parseNoteInput(value: unknown): NoteInput | { readonly error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Send a JSON object with the note text" };
  const text = (value as { text?: unknown }).text;
  if (typeof text !== "string" || !text.trim()) return { error: "Enter the note text" };
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length > maximumNoteLength) return { error: `Notes are at most ${maximumNoteLength} characters` };
  return { text: trimmed };
}

/** A new note record with a random ID. */
export function newNote(input: NoteInput, now = new Date(), id: string = crypto.randomUUID()): Note {
  return { id, text: input.text, createdAt: now.toISOString() };
}

export async function listNotes(db: NotesDatabase): Promise<Note[]> {
  const result = await db.prepare("SELECT id, text, created_at FROM example_module_notes WHERE installation_id = ? ORDER BY created_at DESC, id LIMIT ?").bind(installationId, maximumNotes).all<{ id: string; text: string; created_at: string }>();
  return (result.results ?? []).map((row) => ({ id: String(row.id), text: String(row.text), createdAt: String(row.created_at) }));
}

/** Insert a note unless the installation already keeps the maximum number of notes. Returns whether it was stored. */
export async function addNote(db: NotesDatabase, note: Note): Promise<boolean> {
  const count = await db.prepare("SELECT COUNT(*) AS count FROM example_module_notes WHERE installation_id = ?").bind(installationId).first<{ count: number }>();
  if (Number(count?.count ?? 0) >= maximumNotes) return false;
  await db.prepare("INSERT INTO example_module_notes (installation_id, id, text, created_at) VALUES (?, ?, ?, ?)").bind(installationId, note.id, note.text, note.createdAt).run();
  return true;
}
