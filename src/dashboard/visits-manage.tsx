// /visit/manage: the page the confirmation email links to, with the manage-link token in the URL fragment. The token is
// read from location.hash and sent only in POST bodies. Opening the page loads the visit and changes nothing; saving and
// canceling each need a button press, so an email scanner that opens the link cannot change a visit.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { DashboardNavigate } from "@lancerlogin/module-sdk/dashboard";
import { publicVisitsRoutes, type ManageView } from "../shared/visits-api.ts";
import { isManageToken } from "../shared/visits-tokens.ts";
import { formatShortDate, formatTime } from "../shared/visits-time.ts";
import { checkVisitField, validateVisitDraft, visitDraft, visitEdit, visitFieldOrder, type VisitDraft } from "./visits-forms.ts";
import { failureOf, guestRequest } from "./visits-http.ts";
import { teamNeedsHelp, teamNeedsLabel, teamText } from "./visits-labels.ts";
import { useLiveChecks } from "./visits-live-checks.ts";
import { arrivalChoices, defaultDeparture, departureChoices, formatTimeRange, formatVisitWhen, groupRangesByDate, headcountText, localReading, type LocalSpan } from "./visits-local.ts";
import { ConfirmDialog, Field, fieldAria, firstProblem, inPageLink, Notice, preventImplicitSubmission, useFieldIds, useFocusRequest, type NoticeValue } from "./visits-ui";

const readToken = () => window.location.hash.replace(/^#/, "").trim();
const isView = (value: unknown): value is ManageView => Boolean(value) && typeof value === "object" && "booking" in (value as object) && "windows" in (value as object);
/** The current window is shown as its own choice when the visit no longer sits in an open window. */
const currentChoice = "current";

type Load = { readonly state: "loading" } | { readonly state: "invalid" } | { readonly state: "refused"; readonly message: string } | { readonly state: "unreachable"; readonly message: string } | { readonly state: "ready"; readonly view: ManageView };

export function GuestManagePage({ navigate }: { navigate: DashboardNavigate }) {
  const [token, setToken] = useState(readToken);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  // Kept here, outside the form, so a success message survives the refreshed visit replacing the form.
  const [notice, setNotice] = useState<NoticeValue>();
  useEffect(() => { const update = () => setToken(readToken()); window.addEventListener("hashchange", update); return () => window.removeEventListener("hashchange", update); }, []);

  /** Load the visit. A refresh after a change keeps the current view on screen until the new one arrives. */
  async function open(signal?: { cancelled: boolean }, refresh = false) {
    // A different link must never show the previous visit's message, even when the new link is invalid.
    if (!refresh) setNotice(undefined);
    if (!isManageToken(token)) { setLoad({ state: "invalid" }); return; }
    if (!refresh) setLoad({ state: "loading" });
    try {
      const view = await guestRequest<ManageView>(publicVisitsRoutes.manage, { method: "POST", body: { token } });
      if (!signal?.cancelled) setLoad({ state: "ready", view });
    } catch (error) {
      if (signal?.cancelled) return;
      const failure = failureOf(error);
      setLoad(failure.transient ? { state: "unreachable", message: failure.message } : { state: "refused", message: failure.message });
    }
  }
  useEffect(() => { const signal = { cancelled: false }; void open(signal); return () => { signal.cancelled = true; }; }, [token]);

  const bookLink = <p><a href="/visit" onClick={inPageLink(navigate, "/visit")}>See open times and book a visit</a></p>;
  return <main id="dashboard-content" className="visits-public-page">
    <header className="visits-public-intro"><p className="kicker">Guest Visits</p><h1>{load.state === "ready" && load.view.hostName ? `Your visit to ${load.view.hostName}` : "Your visit"}</h1></header>
    {load.state === "loading" && <p className="ui-status settings-notice" role="status">Loading your visit...</p>}
    {load.state === "invalid" && <section className="ui-card visits-public-message" aria-label="Link problem">
      <p>This link is incomplete. Open the link in your most recent Guest Visits email again, or copy the whole link into the address bar.</p>{bookLink}
    </section>}
    {load.state === "refused" && <section className="ui-card visits-public-message" aria-label="Link problem">
      <p role="alert">{load.message}</p>
      <p>Links work until the visit ends, and only the newest email works after the team you are visiting corrects the email address. Ask that team to resend the confirmation if you need a new link.</p>{bookLink}
    </section>}
    {load.state === "unreachable" && <div className="visits-load-error"><p className="ui-status settings-notice" data-tone="error" role="alert">{load.message}</p><button className="ui-button" type="button" onClick={() => void open()}>Try again</button></div>}
    {load.state === "ready" && <ManageVisit key={`${load.view.booking.id}:${load.view.booking.revision}:${load.view.booking.status}`} token={token} view={load.view} onNotice={setNotice} onView={(view) => setLoad({ state: "ready", view })} onReload={() => open(undefined, true)} />}
    <Notice notice={notice} />
    {load.state === "ready" && load.view.booking.status === "canceled" && bookLink}
  </main>;
}

function ManageVisit({ token, view, onNotice: setNotice, onView, onReload }: { token: string; view: ManageView; onNotice: (notice: NoticeValue | undefined) => void; onView: (view: ManageView) => void; onReload: () => Promise<void> }) {
  const { booking, timeZone } = view;
  const ids = useFieldIds();
  const focus = useFocusRequest();
  const windows = useMemo(() => groupRangesByDate(view.windows.filter((window) => window.status === "open"), timeZone).flatMap((day) => day.items), [view.windows, timeZone]);
  const currentWindow = windows.find((window) => window.startMs <= booking.arrivalMs && booking.departureMs <= window.endMs);
  const [windowId, setWindowId] = useState(currentWindow?.id ?? currentChoice);
  const [draft, setDraft] = useState<VisitDraft>(() => visitDraft(booking));
  // While an Admin requires a headcount, the guest cannot clear it; otherwise it is optional.
  const headcountRequired = view.headcountRequired;
  const { errors, setErrors, blur } = useLiveChecks(draft, (field: string, next: VisitDraft) => checkVisitField(field, next, headcountRequired));
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const canceled = booking.status === "canceled";

  const now = localReading(Date.now(), timeZone);
  const chosen = windows.find((window) => window.id === windowId);
  const withCurrent = (choices: string[], current: string) => chosen?.id === currentWindow?.id && !choices.includes(current) ? [...choices, current].sort() : choices;
  const span: LocalSpan | undefined = chosen?.local;
  const arrivals = span ? withCurrent(arrivalChoices(span, span.date === now.date ? now.time : undefined), booking.arrival) : [booking.arrival];
  const departureOptions = (arrival: string) => span ? withCurrent(departureChoices(span, arrival), booking.departure).filter((time) => time > arrival) : [booking.departure];
  const departures = departureOptions(draft.arrival);
  const edit = visitEdit(booking, draft);

  // Live checks clear or update a field's error as it changes.
  function change<Key extends keyof VisitDraft>(field: Key, value: VisitDraft[Key]) { setDraft((current) => ({ ...current, [field]: value })); }
  function chooseWindow(id: string) {
    setWindowId(id);
    if (id === currentChoice || id === currentWindow?.id) { setDraft((current) => ({ ...current, date: booking.date, arrival: booking.arrival, departure: booking.departure })); return; }
    const window = windows.find((item) => item.id === id);
    if (!window) return;
    const arrival = arrivalChoices(window.local, window.local.date === now.date ? now.time : undefined)[0] ?? "";
    setDraft((current) => ({ ...current, date: window.local.date, arrival, departure: defaultDeparture(window.local, arrival) }));
  }
  function chooseArrival(arrival: string) {
    setDraft((current) => {
      const keep = !span || departureOptions(arrival).includes(current.departure);
      return { ...current, arrival, departure: keep || !span ? current.departure : defaultDeparture(span, arrival) };
    });
  }

  function applyResult(result: unknown, success: string) {
    setNotice({ tone: "success", text: success });
    if (isView(result)) onView(result); else void onReload();
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || canceled) return;
    const found = validateVisitDraft(draft, headcountRequired);
    if (Object.keys(found).length) { setErrors(found); focus(ids(firstProblem(found, visitFieldOrder) ?? "date")); return; }
    if (!edit) { setNotice({ tone: "neutral", text: "Nothing has changed yet." }); return; }
    setBusy(true); setNotice(undefined); setErrors({});
    try {
      const result = await guestRequest<unknown>(publicVisitsRoutes.manageUpdate, { method: "POST", body: { token, edit } });
      applyResult(result, `Saved. The updated details are on their way to ${booking.contactEmail}.`);
    } catch (error) {
      const failure = failureOf(error);
      if (failure.field === "revision") { setStale(true); setNotice({ tone: "error", text: failure.message }); }
      else if (failure.field && (visitFieldOrder as readonly string[]).includes(failure.field)) { setErrors({ [failure.field]: failure.message }); focus(ids(failure.field)); }
      else setNotice({ tone: "error", text: failure.message });
    } finally { setBusy(false); }
  }

  async function cancelVisit() {
    setBusy(true); setCancelError("");
    try {
      const result = await guestRequest<unknown>(publicVisitsRoutes.manageCancel, { method: "POST", body: { token, revision: booking.revision } });
      setCanceling(false);
      applyResult(result, `Visit canceled. A confirmation is on its way to ${booking.contactEmail}.`);
    } catch (error) {
      const failure = failureOf(error);
      if (failure.field === "revision") setStale(true);
      setCancelError(failure.message);
    } finally { setBusy(false); }
  }

  return <>
    <section className="ui-card visits-stack visits-manage-summary" aria-labelledby={ids("summary")}>
      <h2 id={ids("summary")}>{teamText(booking.team)}</h2>
      {canceled && <p className="ui-status settings-notice" data-tone="warning">This visit is canceled.</p>}
      <dl className="visits-details">
        <div><dt>When</dt><dd>{formatVisitWhen(booking.date, booking.arrival, booking.departure)}{booking.windowTitle ? ` (${booking.windowTitle})` : ""}</dd></div>
        <div><dt>People</dt><dd>{headcountText(booking.headcount)}</dd></div>
        <div><dt>Contact</dt><dd>{booking.contactName}{booking.contactPhone ? `, ${booking.contactPhone}` : ""}</dd></div>
        <div><dt>Email</dt><dd className="visits-break">{booking.contactEmail}</dd></div>
        {booking.note && <div><dt>{teamNeedsLabel}</dt><dd className="visits-multiline">{booking.note}</dd></div>}
      </dl>
      <p className="field-help">To change the team or the email address, contact the team you are visiting.</p>
    </section>
    {stale && <div className="module-actions"><button className="ui-button" type="button" onClick={() => { setNotice(undefined); void onReload(); }}>Load the latest details</button></div>}
    {!canceled && <section className="ui-card visits-booking-card" aria-labelledby={ids("change")}>
      <h2 id={ids("change")}>Change this visit</h2>
      <form className="ui-form visits-form" noValidate onSubmit={(event) => void save(event)} onKeyDown={preventImplicitSubmission}>
        <fieldset className="visits-fieldset visits-fieldset--plain" disabled={busy}>
          <legend className="visually-hidden">Visit details</legend>
          <Field id={ids("date")} label="When" error={errors.date}>
            <select {...fieldAria(ids("date"), errors.date)} className="ui-control ui-native-select" value={windowId} onChange={(event) => chooseWindow(event.target.value)}>
              {!currentWindow && <option value={currentChoice}>{formatVisitWhen(booking.date, booking.arrival, booking.departure)} (current, no longer open)</option>}
              {groupRangesByDate(windows, timeZone).map((day) => <optgroup key={day.date} label={formatShortDate(day.date)}>
                {day.items.map((window) => <option key={window.id} value={window.id}>{formatTimeRange(window.local.startTime, window.local.endTime)}{window.title ? ` - ${window.title}` : ""}{window.id === currentWindow?.id ? " (current)" : ""}</option>)}
              </optgroup>)}
            </select>
          </Field>
          <div className="visits-time-grid">
            <Field id={ids("arrival")} label="Arrival" error={errors.arrival}>
              <select {...fieldAria(ids("arrival"), errors.arrival)} className="ui-control ui-native-select" value={draft.arrival} onChange={(event) => chooseArrival(event.target.value)}>
                {arrivals.map((time) => <option key={time} value={time}>{formatTime(time)}</option>)}
              </select>
            </Field>
            <Field id={ids("departure")} label="Departure" error={errors.departure}>
              <select {...fieldAria(ids("departure"), errors.departure)} className="ui-control ui-native-select" value={draft.departure} onChange={(event) => change("departure", event.target.value)}>
                {departures.map((time) => <option key={time} value={time}>{formatTime(time)}</option>)}
              </select>
            </Field>
          </div>
          <Field id={ids("headcount")} label="Headcount" optional={!headcountRequired} error={errors.headcount}>
            <input {...fieldAria(ids("headcount"), errors.headcount)} className="ui-control visits-number" type="number" inputMode="numeric" required={headcountRequired} min={1} max={100} step={1} value={draft.headcount} onChange={(event) => change("headcount", event.target.value)} onBlur={blur("headcount")} />
          </Field>
          <Field id={ids("contactName")} label="Your name" error={errors.contactName}>
            <input {...fieldAria(ids("contactName"), errors.contactName)} className="ui-control" autoComplete="name" maxLength={100} value={draft.contactName} onChange={(event) => change("contactName", event.target.value)} onBlur={blur("contactName")} />
          </Field>
          <Field id={ids("contactPhone")} label="Phone" optional error={errors.contactPhone}>
            <input {...fieldAria(ids("contactPhone"), errors.contactPhone)} className="ui-control" type="tel" autoComplete="tel" maxLength={40} value={draft.contactPhone} onChange={(event) => change("contactPhone", event.target.value)} onBlur={blur("contactPhone")} />
          </Field>
          <Field id={ids("note")} label={teamNeedsLabel} optional error={errors.note} help={teamNeedsHelp}>
            <textarea {...fieldAria(ids("note"), errors.note, true)} className="ui-control" rows={3} maxLength={1000} value={draft.note} onChange={(event) => change("note", event.target.value)} onBlur={blur("note")} />
          </Field>
        </fieldset>
        <div className="module-actions">
          <button className="ui-button ui-button--primary" type="submit" disabled={busy || !edit}>{busy && !canceling ? "Saving..." : "Save changes"}</button>
          <button className="ui-button ui-button--danger" type="button" disabled={busy} aria-haspopup="dialog" onClick={() => { setCancelError(""); setCanceling(true); }}>Cancel visit</button>
        </div>
      </form>
    </section>}
    {canceling && <ConfirmDialog title="Cancel this visit?" confirmLabel="Cancel visit" cancelLabel="Keep visit" danger busy={busy} error={cancelError} onConfirm={() => void cancelVisit()} onClose={() => setCanceling(false)}>
      <p>{teamText(booking.team)}, {formatVisitWhen(booking.date, booking.arrival, booking.departure)}.</p>
      <p>We will email {booking.contactEmail}. To visit later, book again on the guest page.</p>
    </ConfirmDialog>}
  </>;
}
