// The guest page at /visit and its sub pages. Anyone with the URL sees the open windows for the coming weeks with the
// teams already coming, and books a visit; /visit/manage changes or cancels one through the emailed link. Phone first.
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { DashboardPublicPageContext } from "@lancerlogin/module-sdk/dashboard";
import { publicVisitsRoutes, type PublicBookingRequest, type PublicBookingResult, type PublicCalendar, type PublicTeamLookup } from "../shared/visits-api.ts";
import type { PublicWindow, VisitProgram } from "../shared/visits-booking.ts";
import { formatShortDate, formatTime } from "../shared/visits-time.ts";
import {
  bookingFieldOrder, bookingRequest, emptyBookingDraft, lookupFill, lookupNumber, newSubmissionKey, submissionAttempt, teamLookupQuery, validateBookingDraft,
  type BookingDraft, type FieldErrors, type SubmissionAttempt,
} from "./visits-forms.ts";
import { aborted, failureOf, guestRequest } from "./visits-http.ts";
import { programChoices, teamText } from "./visits-labels.ts";
import {
  arrivalChoices, defaultDeparture, departureChoices, formatTimeRange, groupRangesByDate, localReading, localSpan, peopleText, teamCountText, type LocalSpan,
} from "./visits-local.ts";
import { GuestManagePage } from "./visits-manage";
import { Field, fieldAria, firstProblem, inPageLink, preventImplicitSubmission, useFieldIds, useFocusRequest } from "./visits-ui";

export function GuestVisitsPublicPage({ subpath, navigate }: DashboardPublicPageContext) {
  if (subpath === "") return <GuestBookingPage />;
  if (subpath === "manage") return <GuestManagePage navigate={navigate} />;
  return <main id="dashboard-content" className="visits-public-page">
    <section className="ui-card visits-public-message" aria-labelledby="visits-unavailable-title">
      <h1 id="visits-unavailable-title">Page unavailable</h1>
      <p>This guest visit page does not exist.</p>
      <p><a href="/visit" onClick={inPageLink(navigate, "/visit")}>See open times and book a visit</a></p>
    </section>
  </main>;
}

type BookableWindow = PublicWindow & { readonly local: LocalSpan };

/** The arrival a guest may still choose in a window: arrivals after now when the window is today. */
function earliestArrival(window: BookableWindow, now: { date: string; time: string }): string | undefined {
  return window.local.date === now.date ? now.time : undefined;
}

function GuestBookingPage() {
  const [calendar, setCalendar] = useState<PublicCalendar>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [draft, setDraft] = useState<BookingDraft>(emptyBookingDraft);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [booked, setBooked] = useState<{ result: PublicBookingResult; team: string }>();
  const [lookupNote, setLookupNote] = useState("");
  const attempt = useRef<SubmissionAttempt | null>(null);
  const filledName = useRef<string | null>(null);
  const formErrorRef = useRef<HTMLParagraphElement>(null);
  const receiptHeading = useRef<HTMLHeadingElement>(null);
  const ids = useFieldIds();
  const focus = useFocusRequest();

  async function load(signal?: AbortSignal) {
    setLoading(true); setLoadError("");
    try { const next = await guestRequest<PublicCalendar>(publicVisitsRoutes.calendar, { signal }); setCalendar(next); setNow(Date.now()); }
    catch (error) { if (!aborted(error)) setLoadError(failureOf(error).message); }
    finally { if (!signal?.aborted) setLoading(false); }
  }
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, []);
  useEffect(() => { if (formError) formErrorRef.current?.focus(); }, [formError]);
  useEffect(() => { if (booked) receiptHeading.current?.focus(); }, [booked]);

  // Fill the team name from the saved team once the program and number identify one.
  useEffect(() => {
    const number = lookupNumber(draft.program, draft.teamNumber);
    if (!number || !draft.program) { setLookupNote(""); return; }
    const program = draft.program as VisitProgram;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void guestRequest<PublicTeamLookup>(`${publicVisitsRoutes.team}?${teamLookupQuery(program, number)}`, { signal: controller.signal }).then((found) => {
        setDraft((current) => {
          const name = lookupFill(found.team, current.teamName, filledName.current);
          if (name === null) return current;
          filledName.current = found.team ? name : null;
          return { ...current, teamName: name };
        });
        setLookupNote(found.team ? `Filled in from an earlier visit by ${teamText(found.team)}. Change it if your team name changed.` : "");
      }).catch(() => { /* The guest types the name instead. */ });
    }, 400);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [draft.program, draft.teamNumber]);

  const timeZone = calendar?.timeZone ?? "UTC";
  const localNow = useMemo(() => localReading(now, timeZone), [now, timeZone]);
  const days = useMemo(() => calendar ? groupRangesByDate(calendar.windows, timeZone) : [], [calendar, timeZone]);
  const bookable = useMemo(() => days.flatMap((day) => day.items).filter((window) => window.status === "open" && window.endMs > now
    && arrivalChoices(window.local, earliestArrival(window, localNow)).length > 0), [days, now, localNow]);
  const chosen = bookable.find((window) => window.id === draft.windowId);
  const arrivals = chosen ? arrivalChoices(chosen.local, earliestArrival(chosen, localNow)) : [];
  const departures = chosen ? departureChoices(chosen.local, draft.arrival) : [];

  function change<Key extends keyof BookingDraft>(field: Key, value: BookingDraft[Key], errorField: string = field) {
    setDraft((current) => ({ ...current, [field]: value }));
    if (errors[errorField]) setErrors((current) => { const next = { ...current }; delete next[errorField]; return next; });
  }
  function chooseWindow(id: string) {
    const window = bookable.find((item) => item.id === id);
    const arrival = window ? arrivalChoices(window.local, earliestArrival(window, localNow))[0] ?? "" : "";
    setDraft((current) => ({ ...current, windowId: id, arrival, departure: window && arrival ? defaultDeparture(window.local, arrival) : "" }));
    setErrors((current) => { const next = { ...current }; delete next.date; delete next.arrival; delete next.departure; return next; });
  }
  function chooseArrival(arrival: string) {
    setDraft((current) => {
      const keep = chosen && departureChoices(chosen.local, arrival).includes(current.departure);
      return { ...current, arrival, departure: keep || !chosen ? current.departure : defaultDeparture(chosen.local, arrival) };
    });
    setErrors((current) => { const next = { ...current }; delete next.arrival; delete next.departure; return next; });
  }
  function bookWindow(id: string) { chooseWindow(id); focus(ids("date")); }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const found = validateBookingDraft(draft, chosen?.local.date);
    if (Object.keys(found).length) {
      setErrors(found); setFormError("");
      focus(ids(firstProblem(found, bookingFieldOrder) ?? "program"));
      return;
    }
    const request = bookingRequest(draft, chosen!.local.date);
    attempt.current = submissionAttempt(attempt.current, request, () => newSubmissionKey());
    const body: PublicBookingRequest = { ...request, submissionKey: attempt.current.key };
    setBusy(true); setErrors({}); setFormError("");
    try {
      const result = await guestRequest<PublicBookingResult>(publicVisitsRoutes.bookings, { method: "POST", body });
      attempt.current = null;
      setBooked({ result, team: teamText({ number: request.teamNumber, name: request.teamName, program: request.program }) });
      void load();
    } catch (error) {
      const failure = failureOf(error);
      const field = failure.field === "date" || (bookingFieldOrder as readonly string[]).includes(failure.field) ? failure.field : "";
      if (field && !failure.transient) { setErrors({ [field]: failure.message }); focus(ids(field)); }
      else setFormError(failure.transient ? `${failure.message} Sending again is safe: it never books twice.` : failure.field === "submissionKey" ? "Reload the page and try again." : failure.message);
      if (failure.field === "date" || failure.field === "arrival") void load();
    } finally { setBusy(false); }
  }

  function backToTimes() {
    setBooked(undefined);
    setDraft((current) => ({ ...current, windowId: "", arrival: "", departure: "", headcount: "", note: "" }));
  }

  if (booked) {
    const visit = booked.result.visit;
    return <main id="dashboard-content" className="visits-public-page">
      <section className="ui-card visits-receipt" aria-labelledby="visits-receipt-title">
        <p className="kicker">Guest Visits</p>
        <h1 id="visits-receipt-title" ref={receiptHeading} tabIndex={-1}>Visit booked</h1>
        <p><strong>{booked.team}</strong> is coming on {formatShortDate(visit.date)}, {formatTimeRange(visit.arrival, visit.departure)}{visit.windowTitle ? ` (${visit.windowTitle})` : ""}.</p>
        <p>A confirmation email is on its way to <strong className="visits-break">{booked.result.emailTo}</strong>. The link in that email is the only way to change or cancel this visit, so keep the email.</p>
        <p className="field-help">No email after a few minutes? Check your spam folder, or ask the team you are visiting to resend it.</p>
        <div className="module-actions"><button className="ui-button ui-button--primary" type="button" onClick={backToTimes}>Back to open times</button></div>
      </section>
    </main>;
  }

  return <main id="dashboard-content" className="visits-public-page">
    <header className="visits-public-intro">
      <p className="kicker">Guest Visits</p>
      <h1>Book a team visit</h1>
      {calendar?.introText && <p className="visits-intro-text">{calendar.introText}</p>}
      {calendar && <p className="field-help">Times are in the {calendar.timeZone.replace(/_/g, " ")} time zone.</p>}
    </header>
    {loading && !calendar && <p className="ui-status settings-notice" role="status">Loading open times...</p>}
    {loadError && !calendar && <div className="visits-load-error"><p className="ui-status settings-notice" data-tone="error" role="alert">{loadError}</p><button className="ui-button" type="button" onClick={() => void load()}>Try again</button></div>}
    {calendar && <>
      <section className="visits-stack" aria-labelledby="visits-open-times-title">
        <h2 id="visits-open-times-title">Open times</h2>
        {days.length === 0 && <p className="ui-card visits-empty">No open times are posted for the next {Math.round(calendar.horizonDays / 7)} weeks. Check back later.</p>}
        {days.map((day) => <section key={day.date} className="visits-day" aria-labelledby={`visits-day-${day.date}`}>
          <h3 id={`visits-day-${day.date}`}>{formatShortDate(day.date)}</h3>
          {day.items.map((window) => <PublicWindowCard key={window.id} window={window} timeZone={timeZone} bookable={bookable.some((item) => item.id === window.id)} onBook={() => bookWindow(window.id)} />)}
        </section>)}
      </section>
      <section className="ui-card visits-booking-card" aria-labelledby="visits-book-title">
        <h2 id="visits-book-title">Book a visit</h2>
        <p className="field-help">Everyone with this page sees your team number, name and program, your times and how many people are coming. Contact details and your note go only to the team you are visiting.</p>
        {bookable.length === 0 ? <p>There are no open times to book right now.</p> : <form className="ui-form visits-form" noValidate onSubmit={(event) => void submit(event)} onKeyDown={preventImplicitSubmission}>
          {formError && <p ref={formErrorRef} tabIndex={-1} className="ui-status settings-notice" data-tone="error" role="alert">{formError}</p>}
          <fieldset className="visits-fieldset" disabled={busy}>
            <legend>Your team</legend>
            <Field id={ids("program")} label="Program" error={errors.program}>
              <select {...fieldAria(ids("program"), errors.program)} className="ui-control ui-native-select" required value={draft.program} onChange={(event) => change("program", event.target.value as VisitProgram | "")}>
                <option value="">Choose a program</option>
                {programChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
              </select>
            </Field>
            <Field id={ids("teamNumber")} label="Team number" error={errors.teamNumber}>
              <input {...fieldAria(ids("teamNumber"), errors.teamNumber)} className="ui-control" required autoComplete="off" spellCheck={false} inputMode={draft.program === "Other" ? "text" : "numeric"} maxLength={12} value={draft.teamNumber} onChange={(event) => change("teamNumber", event.target.value)} />
            </Field>
            <Field id={ids("teamName")} label="Team name" error={errors.teamName} help={lookupNote || undefined}>
              <input {...fieldAria(ids("teamName"), errors.teamName, Boolean(lookupNote))} className="ui-control" required autoComplete="organization" maxLength={100} value={draft.teamName} onChange={(event) => { filledName.current = null; change("teamName", event.target.value); }} />
            </Field>
          </fieldset>
          <fieldset className="visits-fieldset" disabled={busy}>
            <legend>Contact</legend>
            <Field id={ids("contactName")} label="Your name" error={errors.contactName}>
              <input {...fieldAria(ids("contactName"), errors.contactName)} className="ui-control" required autoComplete="name" maxLength={100} value={draft.contactName} onChange={(event) => change("contactName", event.target.value)} />
            </Field>
            <Field id={ids("contactEmail")} label="Email" error={errors.contactEmail} help="The confirmation and the link to change or cancel the visit go here.">
              <input {...fieldAria(ids("contactEmail"), errors.contactEmail, true)} className="ui-control" type="email" required autoComplete="email" inputMode="email" spellCheck={false} maxLength={254} value={draft.contactEmail} onChange={(event) => change("contactEmail", event.target.value)} />
            </Field>
            <Field id={ids("contactPhone")} label="Phone" optional error={errors.contactPhone}>
              <input {...fieldAria(ids("contactPhone"), errors.contactPhone)} className="ui-control" type="tel" autoComplete="tel" maxLength={40} value={draft.contactPhone} onChange={(event) => change("contactPhone", event.target.value)} />
            </Field>
          </fieldset>
          <fieldset className="visits-fieldset" disabled={busy}>
            <legend>Visit</legend>
            <Field id={ids("date")} label="When" error={errors.date}>
              <select {...fieldAria(ids("date"), errors.date)} className="ui-control ui-native-select" required value={chosen ? chosen.id : ""} onChange={(event) => chooseWindow(event.target.value)}>
                <option value="">Choose an open time</option>
                {groupRangesByDate(bookable, timeZone).map((day) => <optgroup key={day.date} label={formatShortDate(day.date)}>
                  {day.items.map((window) => <option key={window.id} value={window.id}>{formatTimeRange(window.local.startTime, window.local.endTime)}{window.title ? ` - ${window.title}` : ""}</option>)}
                </optgroup>)}
              </select>
            </Field>
            <div className="visits-time-grid">
              <Field id={ids("arrival")} label="Arrival" error={errors.arrival}>
                <select {...fieldAria(ids("arrival"), errors.arrival)} className="ui-control ui-native-select" required disabled={!chosen} value={draft.arrival} onChange={(event) => chooseArrival(event.target.value)}>
                  {!chosen && <option value="">Choose a time first</option>}
                  {arrivals.map((time) => <option key={time} value={time}>{formatTime(time)}</option>)}
                </select>
              </Field>
              <Field id={ids("departure")} label="Departure" error={errors.departure}>
                <select {...fieldAria(ids("departure"), errors.departure)} className="ui-control ui-native-select" required disabled={!chosen} value={draft.departure} onChange={(event) => change("departure", event.target.value)}>
                  {!chosen && <option value="">Choose a time first</option>}
                  {departures.map((time) => <option key={time} value={time}>{formatTime(time)}</option>)}
                </select>
              </Field>
            </div>
            <Field id={ids("headcount")} label="People coming" error={errors.headcount} help="Count everyone: students, mentors and parents.">
              <input {...fieldAria(ids("headcount"), errors.headcount, true)} className="ui-control visits-number" type="number" inputMode="numeric" required min={1} max={100} step={1} value={draft.headcount} onChange={(event) => change("headcount", event.target.value)} />
            </Field>
            <Field id={ids("note")} label="Note to the team" optional error={errors.note} help="Only the team you are visiting sees this.">
              <textarea {...fieldAria(ids("note"), errors.note, true)} className="ui-control" rows={3} maxLength={1000} value={draft.note} onChange={(event) => change("note", event.target.value)} />
            </Field>
          </fieldset>
          <div className="module-actions"><button className="ui-button ui-button--primary" type="submit" disabled={busy}>{busy ? "Booking..." : "Book visit"}</button></div>
        </form>}
      </section>
    </>}
    <p className="visits-staff-link"><a href="/dashboard">Staff sign in</a></p>
  </main>;
}

function PublicWindowCard({ window, timeZone, bookable, onBook }: { window: PublicWindow & { local: LocalSpan }; timeZone: string; bookable: boolean; onBook: () => void }) {
  const range = formatTimeRange(window.local.startTime, window.local.endTime);
  const canceled = window.status === "canceled";
  return <article className="visits-window" data-status={window.status} aria-labelledby={`visits-window-${window.id}`}>
    <div className="visits-window-heading">
      <div>
        <h4 id={`visits-window-${window.id}`}>{range}</h4>
        {window.title && <p className="visits-window-title">{window.title}</p>}
      </div>
      {canceled
        ? <span className="ui-status visits-badge" data-tone="warning">{window.cancelReason ? `Canceled - ${window.cancelReason}` : "Canceled"}</span>
        : <span className="visits-team-count">{teamCountText(window.teamCount)}</span>}
    </div>
    {!canceled && window.visits.length > 0 && <ul className="visits-team-list" aria-label={`Teams coming ${range}`}>
      {window.visits.map((visit, index) => {
        const arrival = localReading(visit.arrivalMs, timeZone).time;
        const departure = localSpan({ startMs: visit.arrivalMs, endMs: visit.departureMs }, timeZone).endTime;
        return <li key={`${visit.program}-${visit.teamNumber}-${index}`}>
          <strong>{teamText({ number: visit.teamNumber, name: visit.teamName, program: visit.program })}</strong>
          <span>{formatTimeRange(arrival, departure)}, {peopleText(visit.headcount)}</span>
        </li>;
      })}
    </ul>}
    {bookable && <button className="ui-button" type="button" onClick={onBook}>Book this time<span className="visually-hidden">: {formatShortDate(window.local.date)}, {range}</span></button>}
  </article>;
}
