// Guest teams: every team that has booked, with its visit count and, while Outreach is installed, whether it is linked
// to an Outreach supported team. Staff rename a team or merge a duplicate into another team of the same program.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { adminVisitsRoutes, type StaffTeam } from "../shared/visits-api.ts";
import { maximumTeamNameLength, programLabels } from "../shared/visits-booking.ts";
import { singleLine } from "../shared/visits-time.ts";
import { aborted, failureOf, staffRequest } from "./visits-http.ts";
import { mergeTargets, sortTeams, teamText } from "./visits-labels.ts";
import { visitCountText } from "./visits-local.ts";
import { Field, fieldAria, LoadState, Notice, preventImplicitSubmission, useFieldIds, useFocusRequest, VisitsDialog, type NoticeValue } from "./visits-ui";

type Dialog = { readonly kind: "rename" | "merge"; readonly team: StaffTeam };

export function TeamsSection({ outreachAvailable, onChanged }: { outreachAvailable: boolean; onChanged: () => Promise<void> }) {
  const [teams, setTeams] = useState<StaffTeam[]>();
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [showMerged, setShowMerged] = useState(false);
  const [notice, setNotice] = useState<NoticeValue>();
  const [dialog, setDialog] = useState<Dialog>();
  const ids = useFieldIds();

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void staffRequest<StaffTeam[]>(adminVisitsRoutes.teams, { signal: controller.signal }).then((next) => setTeams(sortTeams(next)))
      .catch((caught) => { if (!aborted(caught)) setError(failureOf(caught).message); });
    return () => controller.abort();
  }, [version]);

  const merged = teams?.filter((team) => team.archived).length ?? 0;
  const shown = useMemo(() => teams?.filter((team) => showMerged || !team.archived) ?? [], [teams, showMerged]);
  async function changed(text: string) { setDialog(undefined); setNotice({ tone: "success", text }); setVersion((current) => current + 1); await onChanged(); }

  return <section className="ui-card visits-stack" aria-labelledby="visits-teams-title">
    <div className="panel-heading visits-panel-heading">
      <div><h2 id="visits-teams-title">Guest teams</h2><p>Teams are saved when they book. A known team number fills in its name on the guest page.</p></div>
      {merged > 0 && <label className="checkbox-field"><input id={ids("merged")} className="ui-checkbox" type="checkbox" checked={showMerged} onChange={(event) => setShowMerged(event.target.checked)} />Show merged teams ({merged})</label>}
    </div>
    <Notice notice={notice} />
    <LoadState loading={!teams && !error} error={teams ? "" : error} label="guest teams" onRetry={() => setVersion((current) => current + 1)} />
    {teams && shown.length === 0 && <p className="empty-state">No guest teams yet. Teams appear here after their first booking.</p>}
    {shown.length > 0 && <div className="responsive-table"><table className="ui-table visits-table">
      <thead><tr><th scope="col">Team</th><th scope="col">Program</th><th scope="col">Visits</th>{outreachAvailable && <th scope="col">Outreach</th>}<th scope="col">Actions</th></tr></thead>
      <tbody>{shown.map((team) => <tr key={team.id}>
        <th scope="row">{teamText(team)}{team.archived && <span className="ui-status visits-badge" data-tone="neutral">Merged</span>}</th>
        <td>{programLabels[team.program]}</td>
        <td>{visitCountText(team.visitCount)}</td>
        {outreachAvailable && <td>{team.program === "Other" ? "Not supported" : team.outreachTeamId ? "Linked" : "Not linked yet"}</td>}
        <td>{!team.archived && <div className="module-actions visits-row-actions">
          <button className="ui-button" type="button" aria-haspopup="dialog" onClick={() => setDialog({ kind: "rename", team })}>Rename<span className="visually-hidden"> {teamText(team)}</span></button>
          <button className="ui-button" type="button" aria-haspopup="dialog" disabled={mergeTargets(teams ?? [], team).length === 0} onClick={() => setDialog({ kind: "merge", team })}>Merge<span className="visually-hidden"> {teamText(team)}</span></button>
        </div>}</td>
      </tr>)}</tbody>
    </table></div>}
    {dialog?.kind === "rename" && <RenameDialog team={dialog.team} onClose={() => setDialog(undefined)} onSaved={(name) => changed(`Renamed to ${name}.`)} />}
    {dialog?.kind === "merge" && <MergeDialog team={dialog.team} targets={mergeTargets(teams ?? [], dialog.team)} onClose={() => setDialog(undefined)} onMerged={(into) => changed(`${teamText(dialog.team)} merged into ${teamText(into)}.`)} />}
  </section>;
}

function RenameDialog({ team, onSaved, onClose }: { team: StaffTeam; onSaved: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(team.name);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ids = useFieldIds();
  const focus = useFocusRequest();
  async function submit(event: FormEvent) {
    event.preventDefault();
    const clean = singleLine(name);
    if (!clean) { setError("Enter the team name"); focus(ids("name")); return; }
    if (clean.length > maximumTeamNameLength) { setError(`The team name is at most ${maximumTeamNameLength} characters`); focus(ids("name")); return; }
    if (clean === team.name) { onClose(); return; }
    setBusy(true); setError("");
    try { await staffRequest(adminVisitsRoutes.team(team.id), { method: "PUT", body: { name: clean, revision: team.revision } }); await onSaved(clean); }
    catch (caught) { setError(failureOf(caught).message); focus(ids("name")); }
    finally { setBusy(false); }
  }
  return <VisitsDialog title="Rename guest team" description={teamText(team)} busy={busy} onClose={onClose}>
    <form className="ui-form visits-form" noValidate onSubmit={(event) => void submit(event)} onKeyDown={preventImplicitSubmission}>
      <Field id={ids("name")} label="Team name" error={error} help="The guest page and future bookings use the new name.">
        <input {...fieldAria(ids("name"), error, true)} className="ui-control" maxLength={maximumTeamNameLength} disabled={busy} value={name} onChange={(event) => { setName(event.target.value); setError(""); }} data-modal-initial-focus />
      </Field>
      <div className="dialog-actions">
        <button className="ui-button" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="ui-button ui-button--primary" type="submit" disabled={busy}>{busy ? "Saving..." : "Save name"}</button>
      </div>
    </form>
  </VisitsDialog>;
}

function MergeDialog({ team, targets, onMerged, onClose }: { team: StaffTeam; targets: readonly StaffTeam[]; onMerged: (into: StaffTeam) => Promise<void>; onClose: () => void }) {
  const [intoId, setIntoId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ids = useFieldIds();
  const focus = useFocusRequest();
  const into = targets.find((item) => item.id === intoId);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!into) { setError("Choose the team to keep"); focus(ids("into")); return; }
    setBusy(true); setError("");
    try { await staffRequest(adminVisitsRoutes.teamMerge(team.id), { method: "POST", body: { intoId: into.id } }); await onMerged(into); }
    catch (caught) { setError(failureOf(caught).message); focus(ids("into")); }
    finally { setBusy(false); }
  }
  return <VisitsDialog title="Merge duplicate team" description={teamText(team)} busy={busy} onClose={onClose}>
    <form className="ui-form visits-form" noValidate onSubmit={(event) => void submit(event)} onKeyDown={preventImplicitSubmission}>
      <Field id={ids("into")} label="Keep this team" error={error} help={`Only ${programLabels[team.program]} teams can be merged with this one.`}>
        <select {...fieldAria(ids("into"), error, true)} className="ui-control ui-native-select" disabled={busy} value={intoId} onChange={(event) => { setIntoId(event.target.value); setError(""); }} data-modal-initial-focus>
          <option value="">Choose a team</option>
          {targets.map((target) => <option key={target.id} value={target.id}>{teamText(target)} ({visitCountText(target.visitCount)})</option>)}
        </select>
      </Field>
      <p>{into ? `${visitCountText(team.visitCount)} move from ${teamText(team)} to ${teamText(into)}, and ${teamText(team)} is archived as merged.` : `${teamText(team)}'s ${visitCountText(team.visitCount)} move to the team you keep, and this team is archived as merged.`} This cannot be undone here.</p>
      <div className="dialog-actions">
        <button className="ui-button" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="ui-button ui-button--danger" type="submit" disabled={busy || !into}>{busy ? "Merging..." : "Merge teams"}</button>
      </div>
    </form>
  </VisitsDialog>;
}
