// The guest page at /visit and its sub pages. Anyone with the URL sees a month calendar of the coming weeks and chooses a
// day with open times; a card opens over the calendar (a full-screen sheet on phones) with that day's time slots and the
// teams already coming, the guest's arrival and departure, their team found by number in FIRST's team lists, contact
// details and team needs. /visit/manage changes or cancels a visit through the emailed link.
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { DashboardPublicPageContext } from "@lancerlogin/module-sdk/dashboard";
import { publicVisitsRoutes, type PublicBookingRequest, type PublicBookingResult, type PublicCalendar, type PublicTeamSearch, type TeamMatch } from "../shared/visits-api.ts";
import type { PublicWindow, VisitProgram } from "../shared/visits-booking.ts";
import { formatShortDate, formatTime } from "../shared/visits-time.ts";
import {
  bookingFieldOrder, bookingRequest, emptyBookingDraft, newSubmissionKey, submissionAttempt, validateBookingDraft,
  type BookingDraft, type FieldErrors, type SubmissionAttempt,
} from "./visits-forms.ts";
import { GuestCalendar } from "./visits-guest-calendar";
import { aborted, failureOf, guestRequest } from "./visits-http.ts";
import { programChoices, teamNeedsHelp, teamNeedsLabel, teamText } from "./visits-labels.ts";
import {
  arrivalChoices, defaultDeparture, departureChoices, formatTimeRange, groupRangesByDate, guestDays, guestMonths, localReading, localSpan, peopleText, teamCountText, type LocalSpan,
} from "./visits-local.ts";
import { GuestManagePage } from "./visits-manage";
import { manualReason, searchableNumber, teamAfterSearch, teamEntryMode, type TeamSearch } from "./visits-team-entry.ts";
import { Field, fieldAria, firstProblem, inPageLink, preventImplicitSubmission, useFieldIds, useFocusRequest, VisitsDialog } from "./visits-ui";

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
  const [selectedDate, setSelectedDate] = useState("");
  const [month, setMonth] = useState("");
  const [search, setSearch] = useState<TeamSearch>({ status: "idle" });
  const [manual, setManual] = useState(false);
  const attempt = useRef<SubmissionAttempt | null>(null);
  const filledByLookup = useRef(false);
  const manualRef = useRef(false);
  useEffect(() => { manualRef.current = manual; }, [manual]);
  const formErrorRef = useRef<HTMLParagraphElement>(null);
  const receiptRef = useRef<HTMLParagraphElement>(null);
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
  useEffect(() => { if (booked) receiptRef.current?.focus(); }, [booked]);

  // Look the team number up once the guest stops typing. A result fills the program and name, or offers the matches;
  // values an earlier lookup filled are cleared when the number changes, and values the guest typed stay.
  useEffect(() => {
    const number = searchableNumber(draft.teamNumber);
    if (!number) { setSearch({ status: "idle" }); return; }
    setSearch({ status: "searching", number });
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void guestRequest<PublicTeamSearch>(`${publicVisitsRoutes.teamSearch}?${new URLSearchParams({ number })}`, { signal: controller.signal }).then((result) => {
        setSearch({ status: "found", number, result });
        if (manualRef.current) return;
        // The updater stays pure (React may run it twice), so the flag is read before it and set after it.
        const wasFilled = filledByLookup.current;
        setDraft((current) => ({ ...current, ...teamAfterSearch(result.matches, current, wasFilled) }));
        filledByLookup.current = result.matches.length > 0;
      }).catch((error) => { if (!aborted(error)) setSearch({ status: "failed", number }); });
    }, 450);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [draft.teamNumber]);

  const timeZone = calendar?.timeZone ?? "UTC";
  const localNow = useMemo(() => localReading(now, timeZone), [now, timeZone]);
  const days = useMemo(() => calendar ? groupRangesByDate(calendar.windows, timeZone) : [], [calendar, timeZone]);
  const bookable = useMemo(() => days.flatMap((day) => day.items).filter((window) => window.status === "open" && window.endMs > now
    && arrivalChoices(window.local, earliestArrival(window, localNow)).length > 0), [days, now, localNow]);
  const calendarDays = useMemo(() => guestDays(days.flatMap((day) => day.items), new Set(bookable.map((window) => window.id))), [days, bookable]);
  const browse = useMemo(() => guestMonths(localNow.date, calendar?.horizonDays ?? 0, calendarDays), [localNow.date, calendar, calendarDays]);
  const shownMonth = browse.months.includes(month) ? month : browse.initial;
  const calendarId = ids("calendar");
  const dayWindows = days.find((day) => day.date === selectedDate)?.items ?? [];
  const dayBookable = bookable.filter((window) => window.local.date === selectedDate);
  const chosen = dayBookable.find((window) => window.id === draft.windowId);
  const arrivals = chosen ? arrivalChoices(chosen.local, earliestArrival(chosen, localNow)) : [];
  const departures = chosen ? departureChoices(chosen.local, draft.arrival) : [];
  const entry = teamEntryMode(search, manual, draft.teamNumber);
  const matches = search.status === "found" ? search.result.matches : [];

  function clearErrors(...fields: string[]) { setErrors((current) => { const next = { ...current }; for (const field of fields) delete next[field]; return next; }); }
  function change<Key extends keyof BookingDraft>(field: Key, value: BookingDraft[Key], errorField: string = field) {
    setDraft((current) => ({ ...current, [field]: value }));
    if (errors[errorField]) clearErrors(errorField);
  }
  /** A slot with its first arrival and suggested departure. */
  function slotTimes(id: string) {
    const window = bookable.find((item) => item.id === id);
    const arrival = window ? arrivalChoices(window.local, earliestArrival(window, localNow))[0] ?? "" : "";
    return { windowId: id, arrival, departure: window && arrival ? defaultDeparture(window.local, arrival) : "" };
  }
  function chooseWindow(id: string) { setDraft((current) => ({ ...current, ...slotTimes(id) })); clearErrors("date", "arrival", "departure"); }
  function chooseArrival(arrival: string) {
    setDraft((current) => {
      const keep = chosen && departureChoices(chosen.local, arrival).includes(current.departure);
      return { ...current, arrival, departure: keep || !chosen ? current.departure : defaultDeparture(chosen.local, arrival) };
    });
    clearErrors("arrival", "departure");
  }
  function chooseMatch(match: TeamMatch) { filledByLookup.current = true; setDraft((current) => ({ ...current, program: match.program, teamName: match.name })); clearErrors("program", "teamName"); }
  function enterByHand() { setManual(true); focus(ids("program")); }
  function useLookup() {
    setManual(false);
    const team = teamAfterSearch(matches, draft, false);
    if (matches.length) { filledByLookup.current = true; setDraft((current) => ({ ...current, ...team })); }
    focus(ids("teamNumber"));
  }

  // After a refresh, keep the chosen slot in step with the day: a slot that closed is dropped and a day left with one open
  // slot chooses it, keeping the error that explained why.
  const dayBookableIds = dayBookable.map((window) => window.id).join(" ");
  useEffect(() => {
    if (!selectedDate || !draft.windowId || dayBookable.some((window) => window.id === draft.windowId)) return;
    const only = dayBookable.length === 1 ? dayBookable[0]!.id : "";
    setDraft((current) => ({ ...current, ...(only ? slotTimes(only) : { windowId: "", arrival: "", departure: "" }) }));
    if (!dayBookable.length) focus(ids("dayNotice"));
  }, [dayBookableIds]);

  // Choosing a day opens its card over the calendar; a day with one open time chooses it. What the guest typed stays.
  function selectDay(date: string) {
    const open = bookable.filter((window) => window.local.date === date);
    setSelectedDate(date); setMonth(date.slice(0, 7)); setFormError("");
    if (open.length === 1) chooseWindow(open[0]!.id);
    else { setDraft((current) => ({ ...current, windowId: "", arrival: "", departure: "" })); clearErrors("date", "arrival", "departure"); }
  }
  /** Close the card; focus returns to the day. After a booking, the next visit starts from a fresh time, headcount and team needs. */
  function closeDay() {
    if (booked) { setBooked(undefined); setDraft((current) => ({ ...current, windowId: "", arrival: "", departure: "", headcount: "", note: "" })); }
    setSelectedDate(""); setFormError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const checked = validateBookingDraft(draft, chosen?.local.date);
    const found: FieldErrors = entry === "pick" && checked.program ? { ...checked, program: "Choose your team" } : checked;
    if (Object.keys(found).length) {
      setErrors(found); setFormError("");
      const first = firstProblem(found, bookingFieldOrder) ?? "program";
      focus(ids((first === "program" || first === "teamName") && entry === "confirm" ? "teamNumber" : first));
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
      if (field && !failure.transient) {
        // A program or name problem from the server needs the fields that hold them.
        if ((field === "program" || field === "teamName") && entry !== "manual") setManual(true);
        setErrors({ [field]: failure.message }); focus(ids(field));
      } else setFormError(failure.transient ? `${failure.message} Sending again is safe: it never books twice.` : failure.field === "submissionKey" ? "Reload the page and try again." : failure.message);
      if (failure.field === "date" || failure.field === "arrival") void load();
    } finally { setBusy(false); }
  }

  const reason = manualReason(search, manual, draft.teamNumber);
  const teamFields = <fieldset className="visits-fieldset" disabled={busy}>
    <legend>Your team</legend>
    <Field id={ids("teamNumber")} label="Team number" error={errors.teamNumber} help={entry === "searching" ? `Looking up team ${searchableNumber(draft.teamNumber)}...` : undefined}>
      <input {...fieldAria(ids("teamNumber"), errors.teamNumber, entry === "searching")} className="ui-control visits-number" required autoComplete="off" spellCheck={false} inputMode={entry === "manual" && draft.program === "Other" ? "text" : "numeric"} maxLength={12} value={draft.teamNumber} onChange={(event) => { setManual(false); change("teamNumber", event.target.value); }} />
    </Field>
    {entry === "confirm" && matches[0] && <div className="visits-team-found" role="status">
      <span><strong>{teamText(matches[0])}</strong>{matches[0].location && <span>{matches[0].location}</span>}</span>
      <button className="ui-button visits-link-button" type="button" onClick={enterByHand}>Not your team?</button>
    </div>}
    {entry === "pick" && <fieldset className="visits-fieldset visits-team-pick" aria-describedby={errors.program ? `${ids("program")}-error` : undefined}>
      <legend>Which team is yours?</legend>
      {matches.map((match, index) => <label key={match.program} className="checkbox-field">
        <input id={index === 0 ? ids("program") : undefined} type="radio" name={ids("team")} checked={draft.program === match.program} onChange={() => chooseMatch(match)} />
        <span><strong>{teamText(match)}</strong>{match.location && <span className="visits-team-location">{match.location}</span>}</span>
      </label>)}
      {errors.program && <span id={`${ids("program")}-error`} className="field-help visits-field-error">{errors.program}</span>}
      <button className="ui-button visits-link-button" type="button" onClick={enterByHand}>Not listed? Enter your team</button>
    </fieldset>}
    {entry === "manual" && <>
      {reason && <p className="field-help" role="status">{reason}</p>}
      <Field id={ids("program")} label="Program" error={errors.program}>
        <select {...fieldAria(ids("program"), errors.program)} className="ui-control ui-native-select" required value={draft.program} onChange={(event) => { filledByLookup.current = false; change("program", event.target.value as VisitProgram | ""); }}>
          <option value="">Choose a program</option>
          {programChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </select>
      </Field>
      <Field id={ids("teamName")} label="Team name" error={errors.teamName}>
        <input {...fieldAria(ids("teamName"), errors.teamName)} className="ui-control" required autoComplete="organization" maxLength={100} value={draft.teamName} onChange={(event) => { filledByLookup.current = false; change("teamName", event.target.value); }} />
      </Field>
      {manual && matches.length > 0 && <button className="ui-button visits-link-button" type="button" onClick={useLookup}>Use the team we found</button>}
    </>}
  </fieldset>;

  return <main id="dashboard-content" className="visits-public-page">
    <header className="visits-public-intro">
      <p className="kicker">Guest Visits</p>
      <h1>{calendar?.hostName ? `Book a visit with ${calendar.hostName}` : "Book a team visit"}</h1>
      {calendar?.introText && <p className="visits-intro-text">{calendar.introText}</p>}
    </header>
    {loading && !calendar && <p className="ui-status settings-notice" role="status">Loading open times...</p>}
    {loadError && !calendar && <div className="visits-load-error"><p className="ui-status settings-notice" data-tone="error" role="alert">{loadError}</p><button className="ui-button" type="button" onClick={() => void load()}>Try again</button></div>}
    {calendar && <>
      {bookable.length === 0 && <p className="ui-card visits-empty" role="status">No open times are posted for the next {Math.round(calendar.horizonDays / 7)} weeks. Check back later.</p>}
      <GuestCalendar id={calendarId} months={browse.months} month={shownMonth} onMonth={setMonth} today={localNow.date} days={calendarDays} selected={selectedDate} onSelect={selectDay} />
    </>}
    <p className="visits-staff-link"><a href="/dashboard">Staff sign in</a></p>
    {selectedDate && <VisitsDialog title={formatShortDate(selectedDate)} busy={busy} onClose={closeDay} className="visits-dialog--sheet" dismissOnBackdrop>
      {booked ? <div className="visits-stack visits-receipt">
        <p ref={receiptRef} tabIndex={-1} role="status"><strong>Visit booked.</strong> {booked.team} is coming on {formatShortDate(booked.result.visit.date)}, {formatTimeRange(booked.result.visit.arrival, booked.result.visit.departure)}{booked.result.visit.windowTitle ? ` (${booked.result.visit.windowTitle})` : ""}.</p>
        <p>A confirmation email is on its way to <strong className="visits-break">{booked.result.emailTo}</strong>. The link in that email is the only way to change or cancel this visit, so keep the email.</p>
        <p className="field-help">No email after a few minutes? Check your spam folder, or ask {calendar?.hostName || "the team you are visiting"} to resend it.</p>
        <div className="dialog-actions"><button className="ui-button ui-button--primary" type="button" onClick={closeDay} data-modal-initial-focus>Done</button></div>
      </div> : dayBookable.length === 0 ? <div className="visits-stack">
        <p id={ids("dayNotice")} tabIndex={-1} className={formError || errors.date ? "ui-status settings-notice" : undefined} data-tone={formError || errors.date ? "error" : undefined} role={formError || errors.date ? "alert" : undefined}>
          {formError || errors.date || "No open times are left on this day. Choose another highlighted day."}
        </p>
        {dayWindows.map((window) => <SlotCard key={window.id} window={window} timeZone={timeZone} />)}
      </div> : <form className="ui-form visits-form" noValidate onSubmit={(event) => void submit(event)} onKeyDown={preventImplicitSubmission}>
        {formError && <p ref={formErrorRef} tabIndex={-1} className="ui-status settings-notice" data-tone="error" role="alert">{formError}</p>}
        <fieldset className="visits-fieldset visits-slots" disabled={busy} aria-describedby={errors.date ? `${ids("date")}-error` : undefined}>
          <legend>Time slot</legend>
          {dayWindows.map((window) => {
            const open = dayBookable.some((item) => item.id === window.id);
            return <SlotCard key={window.id} window={window} timeZone={timeZone} choice={open
              ? { name: ids("slot"), id: window.id === dayBookable[0]!.id ? ids("date") : undefined, checked: draft.windowId === window.id, onChoose: () => chooseWindow(window.id) }
              : undefined} />;
          })}
          {errors.date && <span id={`${ids("date")}-error`} className="field-help visits-field-error">{errors.date}</span>}
        </fieldset>
        <fieldset className="visits-fieldset" disabled={busy}>
          <legend>When you will be there</legend>
          <div className="visits-time-grid">
            <Field id={ids("arrival")} label="Arrival" error={errors.arrival}>
              <select {...fieldAria(ids("arrival"), errors.arrival)} className="ui-control ui-native-select" required disabled={!chosen} value={draft.arrival} onChange={(event) => chooseArrival(event.target.value)}>
                {!chosen && <option value="">Choose a slot</option>}
                {arrivals.map((time) => <option key={time} value={time}>{formatTime(time)}</option>)}
              </select>
            </Field>
            <Field id={ids("departure")} label="Departure" error={errors.departure}>
              <select {...fieldAria(ids("departure"), errors.departure)} className="ui-control ui-native-select" required disabled={!chosen} value={draft.departure} onChange={(event) => change("departure", event.target.value)}>
                {!chosen && <option value="">Choose a slot</option>}
                {departures.map((time) => <option key={time} value={time}>{formatTime(time)}</option>)}
              </select>
            </Field>
          </div>
        </fieldset>
        {teamFields}
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
          <Field id={ids("headcount")} label="People coming" error={errors.headcount} help="Count everyone: students, mentors and parents.">
            <input {...fieldAria(ids("headcount"), errors.headcount, true)} className="ui-control visits-number" type="number" inputMode="numeric" required min={1} max={100} step={1} value={draft.headcount} onChange={(event) => change("headcount", event.target.value)} />
          </Field>
          <Field id={ids("note")} label={teamNeedsLabel} optional error={errors.note} help={teamNeedsHelp}>
            <textarea {...fieldAria(ids("note"), errors.note, true)} className="ui-control" rows={3} maxLength={1000} value={draft.note} onChange={(event) => change("note", event.target.value)} />
          </Field>
        </fieldset>
        <p className="field-help">Everyone with this page sees your team, your times and how many people are coming. Contact details and team needs go only to the team you are visiting.</p>
        <div className="dialog-actions"><button className="ui-button ui-button--primary" type="submit" disabled={busy}>{busy ? "Booking..." : "Book visit"}</button></div>
      </form>}
    </VisitsDialog>}
  </main>;
}

type SlotChoice = { readonly name: string; readonly id?: string; readonly checked: boolean; readonly onChoose: () => void };

/**
 * A time slot on the chosen day: its hours and title, then the teams coming or the reason it was canceled. A slot that can
 * be booked carries the radio that chooses it, and a tap anywhere on its card chooses it too; the radio is the keyboard
 * and screen reader path.
 */
function SlotCard({ window, timeZone, choice }: { window: PublicWindow & { local: LocalSpan }; timeZone: string; choice?: SlotChoice }) {
  const range = formatTimeRange(window.local.startTime, window.local.endTime);
  const canceled = window.status === "canceled";
  const text = <span className="visits-slot-text"><strong>{range}</strong>{window.title && <span className="visits-window-title">{window.title}</span>}</span>;
  return <div className="visits-window" data-status={window.status} data-choosable={choice ? "true" : undefined} data-selected={choice?.checked ? "true" : undefined} onClick={choice?.onChoose}>
    <div className="visits-window-heading">
      {choice ? <label className="visits-slot-label"><input id={choice.id} type="radio" name={choice.name} checked={choice.checked} onChange={choice.onChoose} />{text}</label> : text}
      {canceled
        ? <span className="ui-status visits-badge" data-tone="warning">{window.cancelReason ? `Canceled - ${window.cancelReason}` : "Canceled"}</span>
        : <span className="visits-team-count">{teamCountText(window.teamCount)}</span>}
    </div>
    {!choice && !canceled && <p className="field-help">This time has started, so it can no longer be booked.</p>}
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
  </div>;
}
