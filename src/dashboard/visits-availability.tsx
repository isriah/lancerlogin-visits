// Availability: the month calendar (or a table) of dated windows with their visits, and repeating availability. Staff add
// a repeating series or a one-off window, edit one window, cancel it with a reason guests see, restore it, or remove it.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { CalendarViewToggle, MonthCalendar, PencilIcon, useCalendarSelection } from "@lancerlogin/module-sdk/dashboard";
import { adminVisitsRoutes, type StaffBooking, type StaffOverview, type StaffSeries, type StaffWindow } from "../shared/visits-api.ts";
import { addDays, formatShortDate, weekdayNames } from "../shared/visits-time.ts";
import { availabilityDraft, availabilityRequest, cancelReason, type AvailabilityDraft, type FieldErrors } from "./visits-forms.ts";
import { aborted, failureOf, staffRequest } from "./visits-http.ts";
import { teamText } from "./visits-labels.ts";
import { compactTime, formatCompactDate, formatTimeRange, monthGridRange, peopleText, todayIn, visitCountText, weekdayListText } from "./visits-local.ts";
import { ConfirmDialog, Field, fieldAria, LoadState, Notice, preventImplicitSubmission, useFieldIds, useFocusRequest, VisitsDialog, type NoticeValue } from "./visits-ui";

type View = "calendar" | "table";
const viewKey = "lancerlogin-visits-availability-view";
const readView = (): View => { try { return window.localStorage.getItem(viewKey) === "table" ? "table" : "calendar"; } catch { return "calendar"; } };

type Dialog =
  | { readonly kind: "add" }
  | { readonly kind: "edit-window"; readonly window: StaffWindow }
  | { readonly kind: "edit-series"; readonly series: StaffSeries }
  | { readonly kind: "cancel"; readonly window: StaffWindow }
  | { readonly kind: "remove-window"; readonly window: StaffWindow }
  | { readonly kind: "remove-series"; readonly series: StaffSeries };

export function AvailabilitySection({ timeZone, onChanged }: { timeZone: string; onChanged: () => Promise<void> }) {
  const today = todayIn(timeZone);
  const [view, setView] = useState<View>(readView);
  const [selection, setSelection] = useCalendarSelection("lancerlogin-visits-availability-calendar", today);
  const range = view === "calendar" ? monthGridRange(today, selection.offset) : { from: today, to: addDays(today, 119) };
  const [overview, setOverview] = useState<StaffOverview>();
  const [series, setSeries] = useState<StaffSeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState<Dialog>();
  const [notice, setNotice] = useState<NoticeValue>();
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    const query = new URLSearchParams({ from: range.from, to: range.to });
    void Promise.all([
      staffRequest<StaffOverview>(`${adminVisitsRoutes.overview}?${query}`, { signal: controller.signal }),
      staffRequest<StaffSeries[]>(adminVisitsRoutes.series, { signal: controller.signal }),
    ]).then(([nextOverview, nextSeries]) => { setOverview(nextOverview); setSeries(nextSeries); })
      .catch((caught) => { if (!aborted(caught)) setError(failureOf(caught).message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [range.from, range.to, version]);

  const windows = useMemo(() => [...(overview?.windows ?? [])].sort((left, right) => left.startMs - right.startMs), [overview]);
  const visitsByWindow = useMemo(() => {
    const map = new Map<string, StaffBooking[]>();
    for (const booking of overview?.bookings ?? []) if (booking.status === "booked") map.set(booking.windowId, [...(map.get(booking.windowId) ?? []), booking].sort((left, right) => left.arrivalMs - right.arrivalMs));
    return map;
  }, [overview]);

  function chooseView(next: View) { setView(next); try { window.localStorage.setItem(viewKey, next); } catch { /* The view still changes without browser storage. */ } }
  function open(next: Dialog) { setDialogError(""); setDialog(next); }
  async function changed(text: string) { setDialog(undefined); setNotice({ tone: "success", text }); setVersion((current) => current + 1); await onChanged(); }

  async function act(run: () => Promise<unknown>, success: string) {
    setBusy(true); setDialogError("");
    try { await run(); await changed(success); }
    catch (caught) { const message = failureOf(caught).message; if (dialog) setDialogError(message); else setNotice({ tone: "error", text: message }); }
    finally { setBusy(false); }
  }
  const restore = (window: StaffWindow) => act(() => staffRequest(adminVisitsRoutes.windowRestore(window.id), { method: "POST", body: { revision: window.revision } }), `Window on ${formatShortDate(window.date)} restored. Guests can book it again.`);

  const addButton = <button className="ui-button ui-button--primary" type="button" aria-haspopup="dialog" onClick={() => open({ kind: "add" })}><span aria-hidden="true">+ </span>Add availability</button>;
  const record = (window: StaffWindow) => <WindowRecord key={window.id} window={window} visits={visitsByWindow.get(window.id) ?? []} busy={busy}
    onEdit={() => open({ kind: "edit-window", window })} onCancel={() => open({ kind: "cancel", window })} onRestore={() => void restore(window)} onRemove={() => open({ kind: "remove-window", window })} />;

  return <div className="visits-stack">
    <div className="visits-section-toolbar"><CalendarViewToggle name="visits-availability-view" label="Availability view" value={view} onChange={chooseView} /></div>
    <Notice notice={notice} />
    <LoadState loading={loading && !overview} error={overview ? "" : error} label="availability" onRetry={() => setVersion((current) => current + 1)} />
    {overview && error && <p className="ui-status settings-notice" data-tone="error" role="alert">{error}</p>}
    {overview && (view === "calendar"
      ? <MonthCalendar title="Availability" id="visits-availability-calendar" today={today} selection={selection} onSelectionChange={setSelection} items={windows}
        itemDate={(window) => window.date} label="windows" showToday action={addButton} emptyText="No availability on this day."
        itemSummary={(window) => ({ title: window.status === "canceled" ? "Canceled" : window.title || "Open", detail: `${compactTime(window.startTime)} to ${compactTime(window.endTime)}${window.bookedCount ? `, ${visitCountText(window.bookedCount)}` : ""}` })}
        renderItem={record} />
      : <section className="ui-card visits-stack" aria-labelledby="visits-window-table-title">
        <div className="panel-heading"><div><h2 id="visits-window-table-title">Availability</h2><p>The next 120 days</p></div>{addButton}</div>
        {windows.length === 0 ? <p className="empty-state">No availability in the next 120 days.</p> : <div className="responsive-table"><table className="ui-table visits-table">
          <thead><tr><th scope="col">Date</th><th scope="col">Time</th><th scope="col">Title</th><th scope="col">Status</th><th scope="col">Visits</th><th scope="col">Actions</th></tr></thead>
          <tbody>{windows.map((window) => <tr key={window.id}>
            <th scope="row">{formatShortDate(window.date)}</th>
            <td>{formatTimeRange(window.startTime, window.endTime)}</td>
            <td>{window.title || "None"}</td>
            <td>{window.status === "canceled" ? `Canceled: ${window.cancelReason}` : "Open"}</td>
            <td>{visitCountText(window.bookedCount)}</td>
            <td><WindowActions window={window} busy={busy} onEdit={() => open({ kind: "edit-window", window })} onCancel={() => open({ kind: "cancel", window })} onRestore={() => void restore(window)} onRemove={() => open({ kind: "remove-window", window })} /></td>
          </tr>)}</tbody>
        </table></div>}
      </section>)}
    {overview && <SeriesList series={series} busy={busy} onEdit={(item) => open({ kind: "edit-series", series: item })} onRemove={(item) => open({ kind: "remove-series", series: item })} />}

    {dialog?.kind === "add" && <AvailabilityDialog title="Add availability" today={today} timeZone={timeZone} onClose={() => setDialog(undefined)}
      onSave={async (request) => {
        if (request.kind === "series") { await staffRequest(adminVisitsRoutes.series, { method: "POST", body: request.value }); await changed(`Repeating availability added: ${weekdayListText(request.value.weekdays)}, ${formatTimeRange(request.value.startTime, request.value.endTime)}.`); }
        else { await staffRequest(adminVisitsRoutes.windows, { method: "POST", body: request.value }); await changed(`Window added on ${formatShortDate(request.value.date)}.`); }
      }} />}
    {dialog?.kind === "edit-window" && <AvailabilityDialog title="Edit window" today={today} timeZone={timeZone} fixed="window"
      description={dialog.window.seriesId ? "This window changes on its own. Later edits to its repeating availability leave it as you set it here." : undefined}
      initial={{ ...availabilityDraft(today), repeating: false, date: dialog.window.date, startTime: dialog.window.startTime, endTime: dialog.window.endTime, title: dialog.window.title }}
      note={dialog.window.bookedCount ? `${visitCountText(dialog.window.bookedCount)} in this window. Visits that no longer fit move to Needs attention.` : undefined}
      onClose={() => setDialog(undefined)}
      onSave={async (request) => { if (request.kind !== "window") return; await staffRequest(adminVisitsRoutes.window(dialog.window.id), { method: "PUT", body: { ...request.value, revision: dialog.window.revision } }); await changed(`Window on ${formatShortDate(request.value.date)} saved.`); }} />}
    {dialog?.kind === "edit-series" && <AvailabilityDialog title="Edit repeating availability" today={today} timeZone={timeZone} fixed="series"
      description="Changes apply to this series' future windows that were not edited on their own."
      initial={{ ...availabilityDraft(today), repeating: true, weekdays: dialog.series.weekdays, firstDate: dialog.series.firstDate, lastDate: dialog.series.lastDate, startTime: dialog.series.startTime, endTime: dialog.series.endTime, title: dialog.series.title }}
      onClose={() => setDialog(undefined)}
      onSave={async (request) => { if (request.kind !== "series") return; await staffRequest(adminVisitsRoutes.seriesItem(dialog.series.id), { method: "PUT", body: { ...request.value, revision: dialog.series.revision } }); await changed("Repeating availability saved."); }} />}
    {dialog?.kind === "cancel" && <CancelWindowDialog window={dialog.window} onClose={() => setDialog(undefined)}
      onCancel={async (reason) => { await staffRequest(adminVisitsRoutes.windowCancel(dialog.window.id), { method: "POST", body: { reason, revision: dialog.window.revision } }); await changed(`Window on ${formatShortDate(dialog.window.date)} canceled. Guests see "${reason}".`); }} />}
    {dialog?.kind === "remove-window" && <ConfirmDialog title="Remove this window?" confirmLabel="Remove window" cancelLabel="Keep window" danger busy={busy} error={dialogError} onClose={() => setDialog(undefined)}
      onConfirm={() => void act(() => staffRequest(`${adminVisitsRoutes.window(dialog.window.id)}?${new URLSearchParams({ revision: String(dialog.window.revision) })}`, { method: "DELETE" }), `Window on ${formatShortDate(dialog.window.date)} removed.`)}>
      <p>{formatShortDate(dialog.window.date)}, {formatTimeRange(dialog.window.startTime, dialog.window.endTime)}{dialog.window.title ? ` (${dialog.window.title})` : ""} disappears from the guest page.{dialog.window.bookedCount ? ` Its ${visitCountText(dialog.window.bookedCount)} move to Needs attention; Guest Visits does not email those teams.` : ""}</p>
      <p>To keep it listed with a reason, cancel it instead.</p>
    </ConfirmDialog>}
    {dialog?.kind === "remove-series" && <ConfirmDialog title="Remove repeating availability?" confirmLabel="Remove repeating availability" cancelLabel="Keep it" danger busy={busy} error={dialogError} onClose={() => setDialog(undefined)}
      onConfirm={() => void act(() => staffRequest(adminVisitsRoutes.seriesItem(dialog.series.id), { method: "DELETE" }), "Repeating availability removed.")}>
      <p>{weekdayListText(dialog.series.weekdays)}, {formatTimeRange(dialog.series.startTime, dialog.series.endTime)}, from {formatCompactDate(dialog.series.firstDate)} to {formatCompactDate(dialog.series.lastDate)}.</p>
      <p>Its future windows that were not edited on their own are removed. Visits in them move to Needs attention; Guest Visits does not email those teams.</p>
    </ConfirmDialog>}
  </div>;
}

function WindowRecord({ window, visits, busy, onEdit, onCancel, onRestore, onRemove }: { window: StaffWindow; visits: readonly StaffBooking[]; busy: boolean; onEdit: () => void; onCancel: () => void; onRestore: () => void; onRemove: () => void }) {
  const canceled = window.status === "canceled";
  return <article className="calendar-selected-record visits-window-record">
    <div className="visits-record-heading">
      <strong>{formatTimeRange(window.startTime, window.endTime)}{window.title ? ` - ${window.title}` : ""}</strong>
      <span className="ui-status visits-badge" data-tone={canceled ? "warning" : "success"}>{canceled ? "Canceled" : "Open"}</span>
    </div>
    {canceled && <p>Guests see: Canceled - {window.cancelReason}</p>}
    <p>{visitCountText(window.bookedCount)}{window.teamCount ? `, ${window.teamCount} ${window.teamCount === 1 ? "team" : "teams"}` : ""}. {window.seriesId ? window.edited ? "Repeating, edited on its own." : "Repeating." : "One-off."}</p>
    {visits.length > 0 && <ul className="visits-compact-list" aria-label={`Visits ${formatTimeRange(window.startTime, window.endTime)}`}>
      {visits.map((visit) => <li key={visit.id}>{teamText(visit.team)}: {formatTimeRange(visit.arrival, visit.departure)}, {peopleText(visit.headcount)}</li>)}
    </ul>}
    <WindowActions window={window} busy={busy} onEdit={onEdit} onCancel={onCancel} onRestore={onRestore} onRemove={onRemove} />
  </article>;
}

function WindowActions({ window, busy, onEdit, onCancel, onRestore, onRemove }: { window: StaffWindow; busy: boolean; onEdit: () => void; onCancel: () => void; onRestore: () => void; onRemove: () => void }) {
  const label = `${formatShortDate(window.date)}, ${formatTimeRange(window.startTime, window.endTime)}`;
  return <div className="module-actions visits-row-actions">
    <button className="ui-button visits-icon-button" type="button" aria-haspopup="dialog" disabled={busy} onClick={onEdit}><PencilIcon />Edit<span className="visually-hidden"> window {label}</span></button>
    {window.status === "canceled"
      ? <button className="ui-button" type="button" disabled={busy} onClick={onRestore}>Restore<span className="visually-hidden"> window {label}</span></button>
      : <button className="ui-button" type="button" aria-haspopup="dialog" disabled={busy} onClick={onCancel}>Cancel window<span className="visually-hidden"> {label}</span></button>}
    <button className="ui-button ui-button--danger" type="button" aria-haspopup="dialog" disabled={busy} onClick={onRemove}>Remove<span className="visually-hidden"> window {label}</span></button>
  </div>;
}

function SeriesList({ series, busy, onEdit, onRemove }: { series: readonly StaffSeries[]; busy: boolean; onEdit: (series: StaffSeries) => void; onRemove: (series: StaffSeries) => void }) {
  return <section className="ui-card visits-stack" aria-labelledby="visits-series-title">
    <div><h2 id="visits-series-title">Repeating availability</h2><p className="field-help">Each series creates a window on its weekdays. Editing a series changes its future windows that were not edited on their own.</p></div>
    {series.length === 0 ? <p className="empty-state">No repeating availability yet. Add availability and choose Every week.</p> : <ul className="visits-record-list">
      {series.map((item) => <li key={item.id} className="visits-record">
        <div>
          <strong>{weekdayListText(item.weekdays)}, {formatTimeRange(item.startTime, item.endTime)}</strong>
          <p>{formatCompactDate(item.firstDate)} to {formatCompactDate(item.lastDate)}{item.title ? `, ${item.title}` : ""}. {item.windowCount} {item.windowCount === 1 ? "window" : "windows"}.</p>
        </div>
        <div className="module-actions visits-row-actions">
          <button className="ui-button visits-icon-button" type="button" aria-haspopup="dialog" disabled={busy} onClick={() => onEdit(item)}><PencilIcon />Edit<span className="visually-hidden"> {weekdayListText(item.weekdays)} series</span></button>
          <button className="ui-button ui-button--danger" type="button" aria-haspopup="dialog" disabled={busy} onClick={() => onRemove(item)}>Remove<span className="visually-hidden"> {weekdayListText(item.weekdays)} series</span></button>
        </div>
      </li>)}
    </ul>}
  </section>;
}

export type AvailabilityRequest = Extract<ReturnType<typeof availabilityRequest>, { ok: true }>;
const availabilityFieldOrder = ["repeating", "weekdays", "firstDate", "lastDate", "date", "startTime", "endTime", "title"];

/** The fields of a repeating series or a one-off window. `fixed` hides the choice when editing one or the other. */
export function AvailabilityFields({ draft, onChange, errors, ids, fixed }: { draft: AvailabilityDraft; onChange: (draft: AvailabilityDraft) => void; errors: FieldErrors; ids: (field: string) => string; fixed?: "series" | "window" }) {
  const set = <Key extends keyof AvailabilityDraft>(field: Key, value: AvailabilityDraft[Key]) => onChange({ ...draft, [field]: value });
  const toggleDay = (day: number, on: boolean) => set("weekdays", on ? [...draft.weekdays, day].sort((left, right) => left - right) : draft.weekdays.filter((item) => item !== day));
  return <>
    {!fixed && <fieldset className="visits-fieldset visits-choice">
      <legend>Repeats</legend>
      <label className="checkbox-field"><input id={ids("repeating")} type="radio" name={ids("repeats")} checked={draft.repeating} onChange={() => set("repeating", true)} />Every week</label>
      <label className="checkbox-field"><input type="radio" name={ids("repeats")} checked={!draft.repeating} onChange={() => set("repeating", false)} />One date</label>
    </fieldset>}
    {draft.repeating ? <>
      <fieldset className="visits-fieldset visits-weekdays" aria-describedby={errors.weekdays ? `${ids("weekdays")}-error` : undefined}>
        <legend>Weekdays</legend>
        <div className="visits-weekday-options">{weekdayNames.map((name, day) => <label key={name} className="checkbox-field">
          <input id={day === 0 ? ids("weekdays") : undefined} className="ui-checkbox" type="checkbox" checked={draft.weekdays.includes(day)} aria-invalid={errors.weekdays ? true : undefined} onChange={(event) => toggleDay(day, event.target.checked)} />{name}
        </label>)}</div>
        {errors.weekdays && <span id={`${ids("weekdays")}-error`} className="field-help visits-field-error">{errors.weekdays}</span>}
      </fieldset>
      <div className="visits-time-grid">
        <Field id={ids("firstDate")} label="First date" error={errors.firstDate}><input {...fieldAria(ids("firstDate"), errors.firstDate)} className="ui-control" type="date" required value={draft.firstDate} onChange={(event) => set("firstDate", event.target.value)} /></Field>
        <Field id={ids("lastDate")} label="Last date" error={errors.lastDate}><input {...fieldAria(ids("lastDate"), errors.lastDate)} className="ui-control" type="date" required value={draft.lastDate} onChange={(event) => set("lastDate", event.target.value)} /></Field>
      </div>
    </> : <Field id={ids("date")} label="Date" error={errors.date}><input {...fieldAria(ids("date"), errors.date)} className="ui-control" type="date" required value={draft.date} onChange={(event) => set("date", event.target.value)} /></Field>}
    <div className="visits-time-grid">
      <Field id={ids("startTime")} label="Start time" error={errors.startTime}><input {...fieldAria(ids("startTime"), errors.startTime)} className="ui-control" type="time" step={300} required value={draft.startTime} onChange={(event) => set("startTime", event.target.value)} /></Field>
      <Field id={ids("endTime")} label="End time" error={errors.endTime}><input {...fieldAria(ids("endTime"), errors.endTime)} className="ui-control" type="time" step={300} required value={draft.endTime} onChange={(event) => set("endTime", event.target.value)} /></Field>
    </div>
    <Field id={ids("title")} label="Title" optional error={errors.title} help="Guests see it beside the time, for example Open shop.">
      <input {...fieldAria(ids("title"), errors.title, true)} className="ui-control" maxLength={80} value={draft.title} onChange={(event) => set("title", event.target.value)} />
    </Field>
  </>;
}

/** Check a draft, show the first problem at its field, and save it; Worker refusals land on their field too. */
export function useAvailabilityForm(initial: AvailabilityDraft, save: (request: AvailabilityRequest) => Promise<void>) {
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const ids = useFieldIds();
  const focus = useFocusRequest();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const request = availabilityRequest(draft);
    if (!request.ok) { setErrors(request.field ? { [request.field]: request.error } : {}); setFormError(request.field ? "" : request.error); focus(ids(request.field || "startTime")); return; }
    setBusy(true); setErrors({}); setFormError("");
    try { await save(request); }
    catch (caught) {
      const failure = failureOf(caught);
      if (failure.field && availabilityFieldOrder.includes(failure.field)) { setErrors({ [failure.field]: failure.message }); focus(ids(failure.field)); }
      else setFormError(failure.message);
    } finally { setBusy(false); }
  }
  return { draft, setDraft: (next: AvailabilityDraft) => { setDraft(next); setErrors({}); }, errors, formError, busy, ids, submit };
}

function AvailabilityDialog({ title, description, note, today, timeZone, initial, fixed, onSave, onClose }: {
  title: string; description?: string; note?: string; today: string; timeZone: string; initial?: AvailabilityDraft; fixed?: "series" | "window"; onSave: (request: AvailabilityRequest) => Promise<void>; onClose: () => void;
}) {
  const form = useAvailabilityForm(initial ?? availabilityDraft(today), onSave);
  return <VisitsDialog title={title} description={description} busy={form.busy} onClose={onClose}>
    <form className="ui-form visits-form" noValidate onSubmit={(event) => void form.submit(event)} onKeyDown={preventImplicitSubmission}>
      <fieldset className="visits-fieldset" disabled={form.busy}>
        <legend className="visually-hidden">{title}</legend>
        <AvailabilityFields draft={form.draft} onChange={form.setDraft} errors={form.errors} ids={form.ids} fixed={fixed} />
      </fieldset>
      <p className="field-help">Times are in the {timeZone.replace(/_/g, " ")} time zone. Windows cannot overlap.</p>
      {note && <p className="field-help">{note}</p>}
      {form.formError && <p className="ui-status settings-notice" data-tone="error" role="alert">{form.formError}</p>}
      <div className="dialog-actions">
        <button className="ui-button" type="button" disabled={form.busy} onClick={onClose}>Cancel</button>
        <button className="ui-button ui-button--primary" type="submit" disabled={form.busy}>{form.busy ? "Saving..." : "Save availability"}</button>
      </div>
    </form>
  </VisitsDialog>;
}

function CancelWindowDialog({ window, onCancel, onClose }: { window: StaffWindow; onCancel: (reason: string) => Promise<void>; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ids = useFieldIds();
  const focus = useFocusRequest();
  async function submit(event: FormEvent) {
    event.preventDefault();
    const checked = cancelReason(reason);
    if (!checked.ok) { setError(checked.error); focus(ids("reason")); return; }
    setBusy(true); setError("");
    try { await onCancel(checked.reason); }
    catch (caught) { setError(failureOf(caught).message); focus(ids("reason")); }
    finally { setBusy(false); }
  }
  return <VisitsDialog title="Cancel this window?" description={`${formatShortDate(window.date)}, ${formatTimeRange(window.startTime, window.endTime)}${window.title ? ` (${window.title})` : ""}`} busy={busy} onClose={onClose}>
    <form className="ui-form visits-form" noValidate onSubmit={(event) => void submit(event)} onKeyDown={preventImplicitSubmission}>
      <Field id={ids("reason")} label="Reason guests see" error={error} help="Shown on the guest page as Canceled - your reason, for example Thanksgiving break.">
        <input {...fieldAria(ids("reason"), error, true)} className="ui-control" required maxLength={200} disabled={busy} value={reason} onChange={(event) => { setReason(event.target.value); setError(""); }} data-modal-initial-focus />
      </Field>
      <p className="field-help">{window.bookedCount ? `${visitCountText(window.bookedCount)} in this window move to Needs attention. Guest Visits does not email those teams; contact them from there.` : "No visits are booked in this window."} You can restore the window later.</p>
      <div className="dialog-actions">
        <button className="ui-button" type="button" disabled={busy} onClick={onClose}>Keep window</button>
        <button className="ui-button ui-button--danger" type="submit" disabled={busy}>{busy ? "Canceling..." : "Cancel window"}</button>
      </div>
    </form>
  </VisitsDialog>;
}
