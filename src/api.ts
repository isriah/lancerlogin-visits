// Worker contribution. Handlers receive Core's module context and the module-scoped database; plugins never see the
// Worker environment or Core credentials. A handler returns undefined for a request it does not handle.
import { defineApiModule } from "@lancerlogin/module-sdk/api";
import { addNote, listNotes, newNote, parseNoteInput, type NotesDatabase } from "./notes.ts";

const api = defineApiModule({
  moduleId: "example-module",
  routes: {
    // GET lists the notes; POST adds one. Administrators and Operators with the module's capability may use both.
    async "/admin/example-module"(context) {
      if (context.url.pathname !== "/admin/example-module/notes") return undefined;
      await context.requireRole(["admin", "operator"]);
      const db = context.db as unknown as NotesDatabase;
      if (context.request.method === "GET") return context.respond({ notes: await listNotes(db) });
      if (context.request.method !== "POST") return undefined;
      context.requireDashboardOrigin("Example Module changes require the dashboard origin");
      const input = parseNoteInput(await context.json(2048));
      if ("error" in input) return context.respond({ error: input.error }, 400);
      const note = newNote(input);
      if (!await addNote(db, note)) return context.respond({ error: "Delete older notes before adding more" }, 409);
      return context.respond({ note }, 201);
    },
  },
  // The manifest declares no setup steps, so there is nothing to validate.
  setup: { predicates: {}, stepValid: async () => true },
  // Run when an Administrator deletes the module's retained data: remove the notes, then Operator capability grants.
  cleanup: { steps: [{ kind: "delete", table: "example_module_notes" }, { kind: "assignments" }] },
  // Portable backups include every note column. The column list must match the migration.
  backup: { version: 1, tables: { example_module_notes: ["installation_id", "id", "text", "created_at"] } },
});

export default api;
