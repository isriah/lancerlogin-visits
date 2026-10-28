// Dashboard contribution. It imports only the module SDK and React; the composed dashboard provides one shared copy of
// each. The workspace route matches the manifest's navigation path and the settings page its settings path.
import { useEffect, useState, type FormEvent } from "react";
import { dashboardApi as api, defineDashboardModule, type DashboardPageContext } from "@lancerlogin/module-sdk/dashboard";
import { maximumNoteLength, type Note } from "./notes.ts";

function ExampleModuleWorkspace() {
  const [notes, setNotes] = useState<readonly Note[]>([]);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    api<{ notes: Note[] }>("/admin/example-module/notes")
      .then((result) => { if (current) setNotes(result.notes); })
      .catch((error: unknown) => { if (current) setStatus(error instanceof Error ? error.message : "Notes could not be loaded"); });
    return () => { current = false; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setStatus(undefined);
    try {
      const result = await api<{ note: Note }>("/admin/example-module/notes", { method: "POST", body: JSON.stringify({ text }) });
      setNotes((existing) => [result.note, ...existing]);
      setText("");
      setStatus("Note added.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The note could not be added");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ui-card" aria-labelledby="example-module-title">
      <h1 id="example-module-title">Example Module</h1>
      <form onSubmit={submit}>
        <label htmlFor="example-module-note">New note</label>
        <input id="example-module-note" value={text} maxLength={maximumNoteLength} onChange={(event) => setText(event.target.value)} required />
        <button type="submit" disabled={busy || !text.trim()}>Add note</button>
      </form>
      {status ? <p role="status">{status}</p> : null}
      {notes.length ? <ul>{notes.map((note) => <li key={note.id}>{note.text}</li>)}</ul> : <p>No notes yet.</p>}
    </section>
  );
}

function ExampleModuleSettings({ role }: DashboardPageContext) {
  return (
    <section className="ui-card" aria-labelledby="example-module-settings-title">
      <h1 id="example-module-settings-title">Example Module</h1>
      <p>Example Module keeps a shared list of notes. Notes are included in portable backups.</p>
      <p>{role === "admin" ? "Grant Operators the Manage Example Module notes capability to let them add notes." : "Ask an Administrator to change who can add notes."}</p>
    </section>
  );
}

const dashboard = defineDashboardModule({
  moduleId: "example-module",
  routes: [{ path: "/example-module", render: () => <ExampleModuleWorkspace /> }],
  settingsPages: [{ path: "/settings/example-module", operator: true, render: (context) => <ExampleModuleSettings {...context} /> }],
});

export default dashboard;
