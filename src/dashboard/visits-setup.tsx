// Guided setup, shown to Admins until both required steps are complete: a successful test email through Core's Resend
// connection, and the first availability (a repeating series or one window). Each step is recorded with Core's module
// setup state, as Core and Outreach setup cards do, and Core calls the module ready once both are recorded and valid.
import { useEffect, useState, type FormEvent } from "react";
import { dashboardApi, type DashboardSetupProps } from "@lancerlogin/module-sdk/dashboard";
import { setupVisitsRoutes, type VisitsSetupStatus } from "../shared/visits-api.ts";
import { parseEmail } from "../shared/visits-booking.ts";
import { formatShortDate } from "../shared/visits-time.ts";
import { availabilityDraft } from "./visits-forms.ts";
import { failureOf, staffRequest } from "./visits-http.ts";
import { formatInstant, formatTimeRange, todayIn, weekdayListText } from "./visits-local.ts";
import { AvailabilityFields, useAvailabilityForm, type AvailabilityRequest } from "./visits-availability";
import { Field, fieldAria, inPageLink, Notice, preventImplicitSubmission, useFieldIds, useFocusRequest, type NoticeValue } from "./visits-ui";

type Module = DashboardSetupProps["module"];
type SetupStep = Module["setup"]["steps"][number] & { readonly valid: boolean; readonly outcome: "completed" | "skipped" | null };
type SetupState = { readonly ready: boolean; readonly steps: readonly SetupStep[] };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Core's setup state for this module, checked against the snapshot the setup screen was opened with. */
function readState(value: unknown, module: Module): SetupState {
  const unverified = new Error("Guest Visits setup state could not be verified. Reload setup.");
  if (!record(value) || value.moduleId !== module.id || value.generation !== module.generation || value.version !== module.setup.version || typeof value.ready !== "boolean" || !Array.isArray(value.steps) || value.steps.length !== module.setup.steps.length) throw unverified;
  const steps = value.steps.map((item: unknown, index) => {
    const expected = module.setup.steps[index];
    if (!record(item) || item.id !== expected?.id || item.required !== expected.required || typeof item.valid !== "boolean" || ![null, "completed", "skipped"].includes(item.outcome as string | null)) throw unverified;
    return item as SetupStep;
  });
  return { ready: value.ready, steps };
}

const done = (step: SetupStep) => step.outcome === "skipped" || step.outcome === "completed" && step.valid;

export function VisitsSetup({ module, navigate, onReady }: DashboardSetupProps) {
  const [state, setState] = useState<SetupState>();
  const [visits, setVisits] = useState<VisitsSetupStatus>();
  const [current, setCurrent] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeValue>();
  const [loadError, setLoadError] = useState("");
  const setupPath = `/admin/modules/${encodeURIComponent(module.id)}/setup`;

  async function load() {
    setLoadError("");
    try {
      const [core, status] = await Promise.all([dashboardApi<unknown>(setupPath), staffRequest<VisitsSetupStatus>(setupVisitsRoutes.status)]);
      const next = readState(core, module);
      setState(next); setVisits(status);
      const pending = next.steps.findIndex((step) => step.required ? !done(step) : step.outcome === null);
      setCurrent(pending < 0 ? 0 : pending);
    } catch (error) { setLoadError(error instanceof Error && error.message ? error.message : "Guest Visits setup could not be loaded."); }
  }
  useEffect(() => { void load(); }, [module.id, module.generation]);

  /** Record a step as complete with Core, then move on, or finish when every required step is recorded. */
  async function complete(stepId: string, success?: string) {
    setBusy(true);
    try {
      const next = readState(await dashboardApi<unknown>(setupPath, { method: "PUT", body: JSON.stringify({ generation: module.generation, stepId, outcome: "completed" }) }), module);
      setState(next);
      setVisits(await staffRequest<VisitsSetupStatus>(setupVisitsRoutes.status));
      if (success) setNotice({ tone: "success", text: success });
      const index = next.steps.findIndex((step) => step.id === stepId);
      if (index < next.steps.length - 1) setCurrent(index + 1);
      else if (next.ready) { await onReady(); navigate("/visits"); }
      else setNotice({ tone: "error", text: "Complete every required Guest Visits step before finishing setup." });
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "Setup could not be saved." }); }
    finally { setBusy(false); }
  }

  const step = state?.steps[current];
  const recorded = state?.steps.filter(done).length ?? 0;
  return <section className="module-onboarding visits-setup" aria-labelledby="visits-setup-title">
    <div className="page-intro"><p className="kicker">Guest Visits module</p><h1 id="visits-setup-title">Set up Guest Visits</h1><p>Send a test email, then add the first time guest teams can visit.</p></div>
    <Notice notice={notice} />
    {!state && !loadError && <p className="ui-status settings-notice" role="status">Loading Guest Visits setup...</p>}
    {loadError && <div className="visits-load-error"><p className="ui-status settings-notice" data-tone="error" role="alert">{loadError}</p><button className="ui-button" type="button" onClick={() => void load()}>Try again</button></div>}
    {state && step && visits && <>
      <div className="module-setup-summary" role="status"><strong>{state.ready ? "Setup complete" : "Setup required"}</strong><span>Step {current + 1} of {state.steps.length} - {recorded} recorded</span></div>
      <article className="module-setup-card" aria-labelledby={`visits-step-${step.id}`}>
        <div className="module-setup-card-heading">
          <div><p className="kicker">Step {current + 1} - {step.required ? "Required" : "Optional"}</p><h2 id={`visits-step-${step.id}`}>{step.label}</h2></div>
          <span className="ui-status visits-badge" data-tone={done(step) ? "success" : step.valid ? "neutral" : "warning"}>{done(step) ? "Complete" : step.valid ? "Ready" : "Action needed"}</span>
        </div>
        {step.id === "email" && <EmailStep visits={visits} busy={busy} navigate={navigate} onSent={(to) => void complete("email", `Test email sent to ${to}. Check that inbox.`)} onContinue={() => void complete("email")} />}
        {step.id === "availability" && <AvailabilityStep visits={visits} busy={busy} last={current === state.steps.length - 1}
          onSaved={(text) => complete("availability", text)} onContinue={() => void complete("availability")} />}
        {step.id !== "email" && step.id !== "availability" && <p>This step is not part of this version of Guest Visits. Reload the dashboard.</p>}
        <div className="module-actions"><button className="ui-button" type="button" disabled={busy || current === 0} onClick={() => setCurrent((index) => index - 1)}>Back</button></div>
      </article>
    </>}
  </section>;
}

function EmailStep({ visits, busy, navigate, onSent, onContinue }: { visits: VisitsSetupStatus; busy: boolean; navigate: (path: string) => void; onSent: (to: string) => void; onContinue: () => void }) {
  const [to, setTo] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const ids = useFieldIds();
  const focus = useFocusRequest();
  const sent = visits.testEmailSentMs !== null;
  async function send(event: FormEvent) {
    event.preventDefault();
    const checked = parseEmail(to, "to");
    if (!checked.ok) { setError(checked.error); focus(ids("to")); return; }
    setSending(true); setError("");
    try { await staffRequest(setupVisitsRoutes.testEmail, { method: "POST", body: { to: checked.value } }); onSent(checked.value); }
    catch (caught) { setError(failureOf(caught).message); focus(ids("to")); }
    finally { setSending(false); }
  }
  return <div className="visits-stack">
    <p>Guest Visits emails each team a confirmation with the only link that can change or cancel its visit, so email must work before guests can book. Emails go through Core's Resend connection.</p>
    {!visits.emailReady && <p className="ui-status settings-notice" data-tone="warning" role="status">Resend is not connected or not verified yet. Set it up in <a href="/settings/integrations" onClick={inPageLink(navigate, "/settings/integrations")}>Settings &gt; Integrations</a>, then come back.</p>}
    {sent && <p className="ui-status settings-notice" data-tone="success" role="status">A test email was sent {formatInstant(visits.testEmailSentMs!, visits.timeZone)}.</p>}
    <form className="ui-form visits-form" noValidate onSubmit={(event) => void send(event)} onKeyDown={preventImplicitSubmission}>
      <Field id={ids("to")} label="Send a test email to" error={error} help="Use an inbox you can check now.">
        <input {...fieldAria(ids("to"), error, true)} className="ui-control" type="email" autoComplete="email" spellCheck={false} maxLength={254} disabled={sending || busy || !visits.emailReady} value={to} onChange={(event) => { setTo(event.target.value); setError(""); }} />
      </Field>
      <div className="module-actions">
        <button className={`ui-button${sent ? "" : " ui-button--primary"}`} type="submit" disabled={sending || busy || !visits.emailReady}>{sending ? "Sending..." : sent ? "Send another test email" : "Send test email"}</button>
        {sent && <button className="ui-button ui-button--primary" type="button" disabled={sending || busy} onClick={onContinue}>{busy ? "Saving..." : "Continue"}</button>}
      </div>
    </form>
  </div>;
}

function AvailabilityStep({ visits, busy, last, onSaved, onContinue }: { visits: VisitsSetupStatus; busy: boolean; last: boolean; onSaved: (text: string) => Promise<void>; onContinue: () => void }) {
  const today = todayIn(visits.timeZone);
  const form = useAvailabilityForm(availabilityDraft(today), async (request: AvailabilityRequest) => {
    if (request.kind === "series") {
      await staffRequest(setupVisitsRoutes.series, { method: "POST", body: request.value });
      await onSaved(`Repeating availability added: ${weekdayListText(request.value.weekdays)}, ${formatTimeRange(request.value.startTime, request.value.endTime)}.`);
    } else {
      await staffRequest(setupVisitsRoutes.windows, { method: "POST", body: request.value });
      await onSaved(`Availability added on ${formatShortDate(request.value.date)}.`);
    }
  });
  const finish = last ? "Finish Guest Visits setup" : "Save and continue";
  if (visits.windowCount > 0) return <div className="visits-stack">
    <p>{visits.windowCount} availability {visits.windowCount === 1 ? "window exists" : "windows exist"}. Add more, cancel or change them later under Guest Visits &gt; Availability.</p>
    <div className="module-actions"><button className="ui-button ui-button--primary" type="button" disabled={busy} onClick={onContinue}>{busy ? "Saving..." : finish}</button></div>
  </div>;
  return <form className="ui-form visits-form" noValidate onSubmit={(event) => void form.submit(event)} onKeyDown={preventImplicitSubmission}>
    <p>Add when guest teams may visit. A repeating window covers the same weekdays and times between two dates; you can cancel single dates later.</p>
    <fieldset className="visits-fieldset visits-fieldset--plain" disabled={form.busy || busy}>
      <legend className="visually-hidden">First availability</legend>
      <AvailabilityFields draft={form.draft} onChange={form.setDraft} errors={form.errors} ids={form.ids} />
    </fieldset>
    {form.formError && <p className="ui-status settings-notice" data-tone="error" role="alert">{form.formError}</p>}
    <div className="module-actions"><button className="ui-button ui-button--primary" type="submit" disabled={form.busy || busy}>{form.busy || busy ? "Saving..." : finish}</button></div>
  </form>;
}
