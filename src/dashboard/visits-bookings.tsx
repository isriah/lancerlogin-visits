// Visits and Needs attention: booked visits with their contact, email, attention and Outreach state. Staff edit, cancel or
// remove a visit, restore an earlier version from its history (removed visits too, from the Removed list), resend the
// confirmation with a fresh link, mark attention handled, and, while Outreach can be used, record visits in Outreach.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  adminVisitsRoutes, type OutreachRecordResponse, type OutreachRecordResult, type StaffBooking, type StaffBookingDetail, type StaffOverview, type StaffTeam,
} from "../shared/visits-api.ts";
import { formatShortDate } from "../shared/visits-time.ts";
import { staffVisitDraft, staffVisitEdit, validateStaffVisitDraft, visitFieldOrder, type FieldErrors, type StaffVisitDraft } from "./visits-forms.ts";
import { aborted, failureOf, staffRequest } from "./visits-http.ts";
import {
  attentionNotes, bookingBadges, canMarkHandled, canRecordInOutreach, describeChange, historyActionText, historyActorText, historyNewestFirst, outreachRecordSummary,
  outreachResultText, sortBookings, sortTeams, teamText, type Tone,
} from "./visits-labels.ts";
import { formatInstant, formatTimeRange, formatVisitWhen, groupByDate, peopleText } from "./visits-local.ts";
import { Badges, ConfirmDialog, Field, fieldAria, firstProblem, LoadState, Notice, preventImplicitSubmission, useFieldIds, useFocusRequest, VisitsDialog, type NoticeValue } from "./visits-ui";

type Outreach = { readonly available: boolean; readonly granted: boolean };
type ListScope = "upcoming" | "past" | "removed";
type Scope = ListScope | "attention";
type Dialog = { readonly kind: "edit" | "history" | "cancel" | "remove"; readonly booking: StaffBooking };

const listScopes: readonly (readonly [ListScope, string])[] = [["upcoming", "Upcoming"], ["past", "Past"], ["removed", "Removed"]];
const titles: Readonly<Record<Scope, string>> = { upcoming: "Upcoming visits", past: "Past visits", removed: "Removed visits", attention: "Needs attention" };
const descriptions: Readonly<Record<Scope, string>> = {
  upcoming: "Contact details and notes are visible to staff only.",
  past: "Contact details and notes are visible to staff only.",
  removed: "Removed visits are hidden from the guest page and the other lists, and their teams were not emailed. Open a visit's history to restore it.",
  attention: "Visits whose window changed, emails that failed or wait, and Outreach records to check. Mark each handled after contacting the team.",
};
const emptyText: Readonly<Record<Scope, string>> = { upcoming: "No upcoming visits.", past: "No past visits yet.", removed: "No removed visits.", attention: "Nothing needs attention." };
const resultTones: Readonly<Record<OutreachRecordResult["state"], Tone>> = { recorded: "success", pending: "neutral", failed: "error", skipped: "warning" };

export function BookingsSection({ mode, timeZone, outreach, onChanged }: { mode: "visits" | "attention"; timeZone: string; outreach: Outreach; onChanged: () => Promise<void> }) {
  const [listScope, setListScope] = useState<ListScope>("upcoming");
  const scope: Scope = mode === "attention" ? "attention" : listScope;
  const [bookings, setBookings] = useState<StaffBooking[]>();
  const [teams, setTeams] = useState<StaffTeam[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState<NoticeValue>();
  const [removed, setRemoved] = useState<StaffBooking>();
  const [dialog, setDialog] = useState<Dialog>();
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  // The last Record in Outreach results, by booking, shown on each visit until the list changes.
  const [results, setResults] = useState<ReadonlyMap<string, OutreachRecordResult>>(new Map());

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void staffRequest<StaffBooking[]>(`${adminVisitsRoutes.bookings}?${new URLSearchParams({ scope })}`, { signal: controller.signal })
      .then((next) => setBookings(sortBookings(next, scope)))
      .catch((caught) => { if (!aborted(caught)) setError(failureOf(caught).message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [scope, version]);
  // Messages and results belong to the list they were made in.
  useEffect(() => { setResults(new Map()); setNotice(undefined); setRemoved(undefined); }, [scope]);
  useEffect(() => {
    const controller = new AbortController();
    void staffRequest<StaffTeam[]>(adminVisitsRoutes.teams, { signal: controller.signal }).then(setTeams).catch(() => { /* Team names fall back to "another team". */ });
    return () => controller.abort();
  }, [version]);

  async function refresh(text: string) { setNotice({ tone: "success", text }); setVersion((current) => current + 1); await onChanged(); }
  async function act(run: () => Promise<unknown>, success: string, after?: () => void) {
    setBusy(true); setDialogError("");
    try { await run(); setDialog(undefined); after?.(); await refresh(success); }
    catch (caught) { const message = failureOf(caught).message; if (dialog) setDialogError(message); else setNotice({ tone: "error", text: message }); }
    finally { setBusy(false); }
  }
  const nameOf = (id: string) => { const booking = bookings?.find((item) => item.id === id); return booking ? teamText(booking.team) : undefined; };
  /** Record visits in Outreach now. Each visit shows how it went, and the status line sums it up. */
  async function record(ids: readonly string[]) {
    setBusy(true); setNotice(undefined);
    try {
      const response = await staffRequest<OutreachRecordResponse>(adminVisitsRoutes.recordOutreach, { method: "POST", body: { bookingIds: ids } });
      const recorded = Array.isArray(response?.results) ? response.results : [];
      setResults(new Map(recorded.map((result) => [result.bookingId, result])));
      setNotice(outreachRecordSummary(recorded, nameOf));
      setVersion((current) => current + 1);
      await onChanged();
    } catch (caught) { setNotice({ tone: "error", text: failureOf(caught).message }); }
    finally { setBusy(false); }
  }
  const actions: BookingActions = {
    edit: (booking) => { setDialogError(""); setDialog({ kind: "edit", booking }); },
    history: (booking) => { setDialogError(""); setDialog({ kind: "history", booking }); },
    cancel: (booking) => { setDialogError(""); setDialog({ kind: "cancel", booking }); },
    remove: (booking) => { setDialogError(""); setDialog({ kind: "remove", booking }); },
    resend: (booking) => void act(() => staffRequest(adminVisitsRoutes.bookingResend(booking.id), { method: "POST" }), `A new confirmation with a fresh link is on its way to ${booking.contactEmail}.`),
    handled: (booking) => void act(() => staffRequest(adminVisitsRoutes.bookingHandled(booking.id), { method: "POST" }), `${teamText(booking.team)} marked handled.`),
    record: (ids) => void record(ids),
  };
  const toRecord = mode === "visits" ? (bookings ?? []).filter((booking) => canRecordInOutreach(booking, outreach)).map((booking) => booking.id) : [];
  const teamName = (id: string) => { const team = teams.find((item) => item.id === id); return team ? teamText(team) : undefined; };

  return <div className="visits-stack">
    <section className="ui-card visits-stack" aria-labelledby={`visits-${mode}-title`}>
      <div className="panel-heading visits-panel-heading">
        <div>
          <h2 id={`visits-${mode}-title`}>{titles[scope]}</h2>
          <p>{descriptions[scope]}</p>
        </div>
        {mode === "visits" && <div className="ui-control-group visits-segmented" role="group" aria-label="Which visits">
          {listScopes.map(([item, label]) => <button key={item} type="button" className="ui-button" aria-pressed={listScope === item} onClick={() => setListScope(item)}>{label}</button>)}
        </div>}
      </div>
      <Notice notice={notice} />
      {removed && <div className="visits-removed-notice"><p>{teamText(removed.team)}, {formatVisitWhen(removed.date, removed.arrival, removed.departure)} is removed. It is listed under Removed, and its history keeps every version.</p>
        <button className="ui-button" type="button" aria-haspopup="dialog" onClick={() => actions.history(removed)}>Open history to restore it</button></div>}
      {toRecord.length > 1 && <div className="visits-outreach-bar">
        <p>{toRecord.length} visits in this list are not recorded in Outreach yet.{outreach.granted ? "" : " Until an Admin grants Guest Visits access to Outreach, visits are recorded only when staff record them here."}</p>
        <button className="ui-button" type="button" disabled={busy} onClick={() => actions.record(toRecord)}>Record all {toRecord.length} in Outreach</button>
      </div>}
      <LoadState loading={loading && !bookings} error={bookings ? "" : error} label="visits" onRetry={() => setVersion((current) => current + 1)} />
      {bookings && error && <p className="ui-status settings-notice" data-tone="error" role="alert">{error}</p>}
      {bookings && bookings.length === 0 && <p className="empty-state">{emptyText[scope]}</p>}
      {bookings && groupByDate(bookings, (booking) => booking.date).sort((left, right) => scope === "past" || scope === "removed" ? right.date.localeCompare(left.date) : left.date.localeCompare(right.date)).map((day) => <section key={day.date} className="visits-day" aria-labelledby={`visits-${mode}-${day.date}`}>
        <h3 id={`visits-${mode}-${day.date}`}>{formatShortDate(day.date)}</h3>
        <ul className="visits-booking-list">
          {day.items.map((booking) => <li key={booking.id}><BookingCard booking={booking} mode={mode} outreach={outreach} result={results.get(booking.id)} busy={busy} actions={actions} /></li>)}
        </ul>
      </section>)}
    </section>

    {dialog?.kind === "edit" && <EditVisitDialog booking={dialog.booking} teams={teams} timeZone={timeZone} onClose={() => setDialog(undefined)}
      onSaved={async (text) => { setDialog(undefined); await refresh(text); }} />}
    {dialog?.kind === "history" && <HistoryDialog booking={dialog.booking} timeZone={timeZone} teamName={teamName} onClose={() => setDialog(undefined)}
      onRestored={async () => { setRemoved(undefined); await refresh(`${teamText(dialog.booking.team)} restored to an earlier version.`); }} />}
    {dialog?.kind === "cancel" && <ConfirmDialog title="Cancel this visit?" confirmLabel="Cancel visit" cancelLabel="Keep visit" danger busy={busy} error={dialogError} onClose={() => setDialog(undefined)}
      onConfirm={() => void act(() => staffRequest(adminVisitsRoutes.bookingCancel(dialog.booking.id), { method: "POST", body: { revision: dialog.booking.revision } }), `${teamText(dialog.booking.team)} canceled. The team gets an email.`)}>
      <p>{teamText(dialog.booking.team)}, {formatVisitWhen(dialog.booking.date, dialog.booking.arrival, dialog.booking.departure)}.</p>
      <p>The visit leaves the guest page and {dialog.booking.contactEmail} gets a cancellation email. You can restore it from its history.</p>
    </ConfirmDialog>}
    {dialog?.kind === "remove" && <ConfirmDialog title="Remove this visit?" confirmLabel="Remove visit" cancelLabel="Keep visit" danger busy={busy} error={dialogError} onClose={() => setDialog(undefined)}
      onConfirm={() => { const booking = dialog.booking; void act(() => staffRequest(`${adminVisitsRoutes.booking(booking.id)}?${new URLSearchParams({ revision: String(booking.revision) })}`, { method: "DELETE" }), `${teamText(booking.team)} removed.`, () => setRemoved(booking)); }}>
      <p>{teamText(dialog.booking.team)}, {formatVisitWhen(dialog.booking.date, dialog.booking.arrival, dialog.booking.departure)}.</p>
      <p>Removing hides the visit from the guest page and these lists without emailing the team. Use it for duplicates and test bookings; cancel instead when the team should hear about it. It stays under Removed with its history, so you can restore it.</p>
    </ConfirmDialog>}
  </div>;
}

type BookingActions = {
  readonly edit: (booking: StaffBooking) => void;
  readonly history: (booking: StaffBooking) => void;
  readonly cancel: (booking: StaffBooking) => void;
  readonly remove: (booking: StaffBooking) => void;
  readonly resend: (booking: StaffBooking) => void;
  readonly handled: (booking: StaffBooking) => void;
  readonly record: (ids: readonly string[]) => void;
};

function BookingCard({ booking, mode, outreach, result, busy, actions }: { booking: StaffBooking; mode: "visits" | "attention"; outreach: Outreach; result: OutreachRecordResult | undefined; busy: boolean; actions: BookingActions }) {
  const team = teamText(booking.team);
  const notes = mode === "attention" ? attentionNotes(booking) : [];
  const booked = booking.status === "booked" && !booking.removed;
  return <article className="visits-booking" aria-label={`${team}, ${formatTimeRange(booking.arrival, booking.departure)}`}>
    <div className="visits-booking-heading">
      <h4>{team}</h4>
      <Badges badges={bookingBadges(booking, outreach.available)} />
    </div>
    {notes.length > 0 && <ul className="visits-attention-notes">{notes.map((note) => <li key={note}>{note}</li>)}</ul>}
    {result && result.state !== "recorded" && <p className="ui-status settings-notice visits-outreach-result" data-tone={resultTones[result.state]} role="status">{outreachResultText(result)}</p>}
    <dl className="visits-details">
      <div><dt>Time</dt><dd>{formatTimeRange(booking.arrival, booking.departure)}{booking.windowTitle ? ` (${booking.windowTitle})` : ""}</dd></div>
      <div><dt>People</dt><dd>{peopleText(booking.headcount)}</dd></div>
      <div><dt>Contact</dt><dd>{booking.contactName}{booking.contactPhone && <>, <a href={`tel:${booking.contactPhone.replace(/[^\d+]/g, "")}`}>{booking.contactPhone}</a></>}</dd></div>
      <div><dt>Email</dt><dd className="visits-break"><a href={`mailto:${booking.contactEmail}`}>{booking.contactEmail}</a></dd></div>
      {booking.note && <div className="visits-details-wide"><dt>Note</dt><dd className="visits-multiline">{booking.note}</dd></div>}
    </dl>
    {booking.removed ? <div className="module-actions visits-row-actions">
      <button className="ui-button" type="button" aria-haspopup="dialog" disabled={busy} onClick={() => actions.history(booking)}>History and restore<span className="visually-hidden"> {team}</span></button>
    </div> : <div className="module-actions visits-row-actions">
      {mode === "attention" && canMarkHandled(booking) && <button className="ui-button ui-button--primary" type="button" disabled={busy} onClick={() => actions.handled(booking)}>Mark handled<span className="visually-hidden"> {team}</span></button>}
      <button className="ui-button" type="button" aria-haspopup="dialog" disabled={busy} onClick={() => actions.edit(booking)}>Edit<span className="visually-hidden"> {team}</span></button>
      <button className="ui-button" type="button" aria-haspopup="dialog" disabled={busy} onClick={() => actions.history(booking)}>History<span className="visually-hidden"> of {team}</span></button>
      {booked && <button className="ui-button" type="button" disabled={busy} onClick={() => actions.resend(booking)}>Resend confirmation<span className="visually-hidden"> to {team}</span></button>}
      {canRecordInOutreach(booking, outreach) && <button className="ui-button" type="button" disabled={busy} onClick={() => actions.record([booking.id])}>Record in Outreach<span className="visually-hidden"> {team}</span></button>}
      {booked && <button className="ui-button" type="button" aria-haspopup="dialog" disabled={busy} onClick={() => actions.cancel(booking)}>Cancel visit<span className="visually-hidden"> {team}</span></button>}
      <button className="ui-button ui-button--danger" type="button" aria-haspopup="dialog" disabled={busy} onClick={() => actions.remove(booking)}>Remove<span className="visually-hidden"> {team}</span></button>
    </div>}
  </article>;
}

const staffFieldOrder = ["teamId", ...visitFieldOrder, "contactEmail"];

function EditVisitDialog({ booking, teams, timeZone, onSaved, onClose }: { booking: StaffBooking; teams: readonly StaffTeam[]; timeZone: string; onSaved: (text: string) => Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState<StaffVisitDraft>(() => staffVisitDraft(booking));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [openWindows, setOpenWindows] = useState<string>();
  const ids = useFieldIds();
  const focus = useFocusRequest();
  const choices = useMemo(() => sortTeams(teams.filter((team) => !team.archived || team.id === booking.team.id)), [teams, booking.team.id]);
  const edit = staffVisitEdit(booking, draft);

  // The open windows on the chosen date, so staff can see where the visit may go.
  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) { setOpenWindows(undefined); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void staffRequest<StaffOverview>(`${adminVisitsRoutes.overview}?${new URLSearchParams({ from: draft.date, to: draft.date })}`, { signal: controller.signal }).then((overview) => {
        const open = overview.windows.filter((window) => window.status === "open" && window.date === draft.date).sort((left, right) => left.startMs - right.startMs);
        setOpenWindows(open.length ? `Open on this date: ${open.map((window) => `${formatTimeRange(window.startTime, window.endTime)}${window.title ? ` (${window.title})` : ""}`).join("; ")}.` : "No open window on this date. A visit must fit inside one open window.");
      }).catch(() => setOpenWindows(undefined));
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [draft.date]);

  function change<Key extends keyof StaffVisitDraft>(field: Key, value: StaffVisitDraft[Key]) {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => { if (!current[field]) return current; const next = { ...current }; delete next[field]; return next; });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const found = validateStaffVisitDraft(draft);
    if (Object.keys(found).length) { setErrors(found); focus(ids(firstProblem(found, staffFieldOrder) ?? "date")); return; }
    if (!edit) { onClose(); return; }
    setBusy(true); setErrors({}); setFormError("");
    try {
      await staffRequest(adminVisitsRoutes.booking(booking.id), { method: "PUT", body: edit });
      await onSaved(edit.contactEmail ? `${teamText(booking.team)} saved. Earlier links stopped working; the update email with a fresh link goes to ${edit.contactEmail}.` : `${teamText(booking.team)} saved. The team gets an email with the updated details.`);
    } catch (caught) {
      const failure = failureOf(caught);
      if (failure.field && staffFieldOrder.includes(failure.field)) { setErrors({ [failure.field]: failure.message }); focus(ids(failure.field)); }
      else setFormError(failure.message);
    } finally { setBusy(false); }
  }

  return <VisitsDialog title="Edit visit" description={`${teamText(booking.team)}, ${formatVisitWhen(booking.date, booking.arrival, booking.departure)}`} busy={busy} onClose={onClose}>
    <form className="ui-form visits-form" noValidate onSubmit={(event) => void submit(event)} onKeyDown={preventImplicitSubmission}>
      <fieldset className="visits-fieldset" disabled={busy}>
        <legend>Team and contact</legend>
        <Field id={ids("teamId")} label="Guest team" error={errors.teamId} help="Moving a visit to another team keeps its contact details.">
          <select {...fieldAria(ids("teamId"), errors.teamId, true)} className="ui-control ui-native-select" value={draft.teamId} onChange={(event) => change("teamId", event.target.value)} data-modal-initial-focus>
            {!choices.some((team) => team.id === booking.team.id) && <option value={booking.team.id}>{teamText(booking.team)}</option>}
            {choices.map((team) => <option key={team.id} value={team.id}>{teamText(team)}{team.archived ? " (merged)" : ""}</option>)}
          </select>
        </Field>
        <Field id={ids("contactName")} label="Contact name" error={errors.contactName}>
          <input {...fieldAria(ids("contactName"), errors.contactName)} className="ui-control" maxLength={100} value={draft.contactName} onChange={(event) => change("contactName", event.target.value)} />
        </Field>
        <Field id={ids("contactEmail")} label="Email" error={errors.contactEmail} help="Correcting the address stops every earlier link from working. The update email with a fresh link goes to the new address.">
          <input {...fieldAria(ids("contactEmail"), errors.contactEmail, true)} className="ui-control" type="email" maxLength={254} spellCheck={false} value={draft.contactEmail} onChange={(event) => change("contactEmail", event.target.value)} />
        </Field>
        <Field id={ids("contactPhone")} label="Phone" optional error={errors.contactPhone}>
          <input {...fieldAria(ids("contactPhone"), errors.contactPhone)} className="ui-control" type="tel" maxLength={40} value={draft.contactPhone} onChange={(event) => change("contactPhone", event.target.value)} />
        </Field>
      </fieldset>
      <fieldset className="visits-fieldset" disabled={busy}>
        <legend>Visit</legend>
        <Field id={ids("date")} label="Date" error={errors.date} help={openWindows}>
          <input {...fieldAria(ids("date"), errors.date, Boolean(openWindows))} className="ui-control" type="date" value={draft.date} onChange={(event) => change("date", event.target.value)} />
        </Field>
        <div className="visits-time-grid">
          <Field id={ids("arrival")} label="Arrival" error={errors.arrival}><input {...fieldAria(ids("arrival"), errors.arrival)} className="ui-control" type="time" step={300} value={draft.arrival} onChange={(event) => change("arrival", event.target.value)} /></Field>
          <Field id={ids("departure")} label="Departure" error={errors.departure}><input {...fieldAria(ids("departure"), errors.departure)} className="ui-control" type="time" step={300} value={draft.departure} onChange={(event) => change("departure", event.target.value)} /></Field>
        </div>
        <Field id={ids("headcount")} label="People coming" error={errors.headcount}>
          <input {...fieldAria(ids("headcount"), errors.headcount)} className="ui-control visits-number" type="number" inputMode="numeric" min={1} max={100} step={1} value={draft.headcount} onChange={(event) => change("headcount", event.target.value)} />
        </Field>
        <Field id={ids("note")} label="Note" optional error={errors.note}>
          <textarea {...fieldAria(ids("note"), errors.note)} className="ui-control" rows={3} maxLength={1000} value={draft.note} onChange={(event) => change("note", event.target.value)} />
        </Field>
      </fieldset>
      <p className="field-help">Times are in the {timeZone.replace(/_/g, " ")} time zone. Saving emails the team the updated details with a fresh link.</p>
      {formError && <p className="ui-status settings-notice" data-tone="error" role="alert">{formError}</p>}
      <div className="dialog-actions">
        <button className="ui-button" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="ui-button ui-button--primary" type="submit" disabled={busy || !edit}>{busy ? "Saving..." : "Save visit"}</button>
      </div>
    </form>
  </VisitsDialog>;
}

function HistoryDialog({ booking, timeZone, teamName, onRestored, onClose }: { booking: StaffBooking; timeZone: string; teamName: (id: string) => string | undefined; onRestored: () => Promise<void>; onClose: () => void }) {
  const [detail, setDetail] = useState<StaffBookingDetail>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeValue>();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void staffRequest<StaffBookingDetail>(adminVisitsRoutes.booking(booking.id), { signal: controller.signal }).then(setDetail)
      .catch((caught) => { if (!aborted(caught)) setError(failureOf(caught).message); });
    return () => controller.abort();
  }, [booking.id, version]);

  async function restore(entryId: string) {
    if (!detail) return;
    setBusy(true); setNotice(undefined);
    try {
      await staffRequest(adminVisitsRoutes.bookingRestore(booking.id), { method: "POST", body: { revisionId: entryId, revision: detail.revision } });
      setNotice({ tone: "success", text: "Restored. The team gets an email with the restored details." });
      setVersion((current) => current + 1);
      await onRestored();
    } catch (caught) { setNotice({ tone: "error", text: failureOf(caught).message }); }
    finally { setBusy(false); }
  }

  const entries = detail ? historyNewestFirst(detail.history) : [];
  return <VisitsDialog title="Visit history" description={`${teamText(booking.team)}, ${formatVisitWhen(booking.date, booking.arrival, booking.departure)}`} busy={busy} onClose={onClose} wide>
    <div className="visits-stack">
      <Notice notice={notice} />
      <LoadState loading={!detail && !error} error={error} label="history" onRetry={() => setVersion((current) => current + 1)} />
      {detail && entries.length === 0 && <p className="empty-state">No history yet.</p>}
      {entries.length > 0 && <ol className="visits-history">
        {entries.map(({ entry, restorable }, index) => <li key={entry.id} className="visits-history-entry">
          <div className="visits-record-heading">
            <strong>{historyActionText(entry.action)}{index === 0 ? " (current)" : ""}</strong>
            <span className="field-help">{formatInstant(entry.atMs, timeZone)}</span>
          </div>
          <p>{historyActorText(entry.actor, entry.action)}</p>
          {entry.changes.length > 0 && <ul className="visits-compact-list">{entry.changes.map((change, item) => <li key={`${change.field}-${item}`}>{describeChange(change, { timeZone, teamName })}</li>)}</ul>}
          {restorable && <button className="ui-button" type="button" disabled={busy} onClick={() => void restore(entry.id)}>Restore this version<span className="visually-hidden"> from {formatInstant(entry.atMs, timeZone)}</span></button>}
        </li>)}
      </ol>}
      <div className="dialog-actions"><button className="ui-button" type="button" disabled={busy} onClick={onClose}>Close</button></div>
    </div>
  </VisitsDialog>;
}
