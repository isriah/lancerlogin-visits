// Settings > Guest Visits, for Admins: the guest page link and intro text, the reply-to address and a test email, and
// Discord messages with the weekly summary. Sections use Core's settings section navigation, and leaving a section with
// unsaved changes asks first.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { SettingsSectionNavigation, routeWillChangeEvent, settingsSectionHref, usePath } from "@lancerlogin/module-sdk/dashboard";
import { adminVisitsRoutes, type VisitsSettings, type VisitsSettingsUpdate, type VisitsStatus } from "../shared/visits-api.ts";
import { parseEmail } from "../shared/visits-booking.ts";
import { isLocalTime, weekdayNames } from "../shared/visits-time.ts";
import { discordChannelPattern, guestPageLink, settingsUpdate, type FieldErrors } from "./visits-forms.ts";
import { failureOf, staffRequest } from "./visits-http.ts";
import { formatInstant } from "./visits-local.ts";
import { ConfirmDialog, Field, fieldAria, inPageLink, LoadState, Notice, preventImplicitSubmission, useFieldIds, useFocusRequest, type NoticeValue } from "./visits-ui";

const sections = [["guest-page", "Guest page"], ["email", "Email"], ["discord", "Discord"]] as const;
type Section = (typeof sections)[number][0];
const isSection = (value: string | null): value is Section => sections.some(([id]) => id === value);
const isSettings = (value: unknown): value is VisitsSettings => Boolean(value) && typeof value === "object" && typeof (value as VisitsSettings).revision === "number" && typeof (value as VisitsSettings).introText === "string";

type SectionProps = {
  readonly settings: VisitsSettings;
  readonly status: VisitsStatus;
  readonly save: (update: VisitsSettingsUpdate) => Promise<void>;
  readonly onDirty: (dirty: boolean) => void;
  readonly navigate: (path: string) => void;
};

export function VisitsSettingsPage({ openSetup }: { openSetup?: () => void }) {
  const { path, search, navigate } = usePath();
  const requested = new URLSearchParams(search).get("section");
  const section: Section = isSection(requested) ? requested : "guest-page";
  const [settings, setSettings] = useState<VisitsSettings>();
  const [status, setStatus] = useState<VisitsStatus>();
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<string>();
  const allowNext = useRef(false);
  const current = `${path}${search}`;

  useEffect(() => {
    let active = true;
    setError("");
    void Promise.all([staffRequest<VisitsSettings>(adminVisitsRoutes.settings), staffRequest<VisitsStatus>(adminVisitsRoutes.status)])
      .then(([nextSettings, nextStatus]) => { if (active) { setSettings(nextSettings); setStatus(nextStatus); } })
      .catch((caught) => { if (active) setError(failureOf(caught).message); });
    return () => { active = false; };
  }, [version]);

  // Keep unsaved changes: in-place navigation asks first, and closing the tab gets the browser's own prompt.
  useEffect(() => {
    const guard = (event: Event) => {
      if (allowNext.current) { allowNext.current = false; return; }
      const next = (event as CustomEvent<{ next: string }>).detail?.next;
      if (!dirty || !next || next === current) return;
      event.preventDefault();
      setPendingLeave(next);
    };
    const unload = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener(routeWillChangeEvent, guard);
    window.addEventListener("beforeunload", unload);
    return () => { window.removeEventListener(routeWillChangeEvent, guard); window.removeEventListener("beforeunload", unload); };
  }, [dirty, current]);
  useEffect(() => { setDirty(false); }, [section]);

  async function save(update: VisitsSettingsUpdate) {
    const result = await staffRequest<unknown>(adminVisitsRoutes.settings, { method: "PUT", body: update });
    if (isSettings(result)) setSettings(result);
    else setSettings(await staffRequest<VisitsSettings>(adminVisitsRoutes.settings));
  }
  function leave() {
    const next = pendingLeave;
    setPendingLeave(undefined);
    if (!next) return;
    setDirty(false);
    allowNext.current = true;
    navigate(next);
  }

  const props: SectionProps | undefined = settings && status ? { settings, status, save, onDirty: setDirty, navigate } : undefined;
  return <section className="settings-page visits-settings" aria-labelledby="visits-settings-title">
    <div className="page-intro"><h1 id="visits-settings-title">Guest Visits</h1><p>The guest page, confirmation emails and Discord messages.</p></div>
    <div className="settings-section-toolbar">
      <SettingsSectionNavigation label="Guest Visits settings sections" pickerLabel="Guest Visits section" currentHref={settingsSectionHref(path, search, section)} navigate={navigate}
        sections={sections.map(([id, label]): [string, string] => [settingsSectionHref(path, search, id), label])} />
    </div>
    <LoadState loading={!props && !error} error={props ? "" : error} label="Guest Visits settings" onRetry={() => setVersion((value) => value + 1)} />
    {props && section === "guest-page" && <GuestPageSettings {...props} />}
    {props && section === "email" && <EmailSettings {...props} reload={() => setVersion((value) => value + 1)} />}
    {props && section === "discord" && <DiscordSettings {...props} />}
    {props && section === "guest-page" && openSetup && <article className="settings-callout">
      <div><h2>Guided setup</h2><p>Review the test email and first availability steps again.</p></div>
      <button className="ui-button" type="button" onClick={openSetup}>Open Guest Visits setup</button>
    </article>}
    {pendingLeave && <ConfirmDialog title="Leave without saving?" confirmLabel="Leave without saving" cancelLabel="Keep editing" danger busy={false} onConfirm={leave} onClose={() => setPendingLeave(undefined)}>
      <p>Your changes in this section are not saved yet.</p>
    </ConfirmDialog>}
  </section>;
}

/** A settings card with its own notice. */
function SettingsCard({ id, title, intro, notice, children }: { id: string; title: string; intro?: ReactNode; notice?: NoticeValue; children: ReactNode }) {
  return <article className="ui-card visits-stack" aria-labelledby={id}>
    <div><h2 id={id}>{title}</h2>{intro && <p className="field-help">{intro}</p>}</div>
    {children}
    <Notice notice={notice} />
  </article>;
}

function useSaving() {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeValue>();
  const [errors, setErrors] = useState<FieldErrors>({});
  async function run(work: () => Promise<void>, success: string, fieldIds: (field: string) => string, focus: (id: string | undefined) => void) {
    setBusy(true); setNotice(undefined); setErrors({});
    try { await work(); setNotice({ tone: "success", text: success }); }
    catch (caught) {
      const failure = failureOf(caught);
      if (failure.field && failure.field !== "revision") { setErrors({ [failure.field]: failure.message }); focus(fieldIds(failure.field)); }
      else setNotice({ tone: "error", text: failure.field === "revision" ? `${failure.message} Reload the page to see the latest settings.` : failure.message });
    } finally { setBusy(false); }
  }
  return { busy, notice, setNotice, errors, setErrors, run };
}

function GuestPageSettings({ settings, status, save, onDirty }: SectionProps) {
  const [introText, setIntroText] = useState(settings.introText);
  const [copied, setCopied] = useState<NoticeValue>();
  const saving = useSaving();
  const ids = useFieldIds();
  const focus = useFocusRequest();
  const link = guestPageLink(window.location.origin, status.guestPagePath);
  const update = settingsUpdate(settings, { ...settings, introText: introText.trim() }, ["introText"]);
  useEffect(() => { onDirty(Boolean(update)); }, [Boolean(update)]);
  useEffect(() => { setIntroText(settings.introText); }, [settings.revision]);

  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied({ tone: "success", text: "Guest page link copied." }); }
    catch { (document.getElementById(ids("link")) as HTMLInputElement | null)?.select(); setCopied({ tone: "neutral", text: "Copying is blocked in this browser. The link is selected; copy it with your keyboard." }); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!update) return;
    await saving.run(() => save(update), "Guest page intro saved.", ids, focus);
  }

  return <div className="visits-stack">
    <SettingsCard id="visits-link-title" title="Guest page link" intro="Share this link with teams that want to visit. Anyone with it can see open times and book." notice={copied}>
      <div className="visits-copy-link">
        <Field id={ids("link")} label="Guest page link"><input id={ids("link")} className="ui-control" readOnly value={link} onFocus={(event) => event.target.select()} /></Field>
        <button className="ui-button" type="button" onClick={() => void copy()}>Copy link</button>
      </div>
      <p><a href={link} target="_blank" rel="noopener">Open the guest page<span className="visually-hidden"> in a new tab</span></a></p>
    </SettingsCard>
    <SettingsCard id="visits-intro-title" title="Intro text" intro="Shown at the top of the guest page, for example where to park and what to bring." notice={saving.notice}>
      <form className="ui-form visits-form" noValidate onSubmit={(event) => void submit(event)}>
        <Field id={ids("introText")} label="Intro text" optional error={saving.errors.introText}>
          <textarea {...fieldAria(ids("introText"), saving.errors.introText)} className="ui-control" rows={5} maxLength={4000} disabled={saving.busy} value={introText} onChange={(event) => setIntroText(event.target.value)} />
        </Field>
        <div className="module-actions"><button className="ui-button ui-button--primary" type="submit" disabled={saving.busy || !update}>{saving.busy ? "Saving..." : "Save intro text"}</button></div>
      </form>
    </SettingsCard>
  </div>;
}

function EmailSettings({ settings, status, save, onDirty, navigate, reload }: SectionProps & { reload: () => void }) {
  const [replyTo, setReplyTo] = useState(settings.replyTo);
  const [testTo, setTestTo] = useState("");
  const [testError, setTestError] = useState("");
  const [testNotice, setTestNotice] = useState<NoticeValue>();
  const [testing, setTesting] = useState(false);
  const saving = useSaving();
  const ids = useFieldIds();
  const focus = useFocusRequest();
  const update = settingsUpdate(settings, { ...settings, replyTo: replyTo.trim() }, ["replyTo"]);
  useEffect(() => { onDirty(Boolean(update)); }, [Boolean(update)]);
  useEffect(() => { setReplyTo(settings.replyTo); }, [settings.revision]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!update) return;
    if (replyTo.trim()) {
      const checked = parseEmail(replyTo, "replyTo");
      if (!checked.ok) { saving.setErrors({ replyTo: "Enter one email address, like coach@example.org, or leave it empty" }); focus(ids("replyTo")); return; }
    }
    await saving.run(() => save(update), replyTo.trim() ? "Reply-to address saved. Replies to guest emails go there." : "Reply-to address cleared.", ids, focus);
  }
  async function sendTest(event: FormEvent) {
    event.preventDefault();
    const checked = parseEmail(testTo, "to");
    if (!checked.ok) { setTestError(checked.error); focus(ids("to")); return; }
    setTesting(true); setTestError(""); setTestNotice(undefined);
    try { await staffRequest(adminVisitsRoutes.settingsTestEmail, { method: "POST", body: { to: checked.value } }); setTestNotice({ tone: "success", text: `Test email sent to ${checked.value}. Check that inbox.` }); reload(); }
    catch (caught) { const failure = failureOf(caught); if (failure.field === "to") { setTestError(failure.message); focus(ids("to")); } else setTestNotice({ tone: "error", text: failure.message }); }
    finally { setTesting(false); }
  }

  return <div className="visits-stack">
    <p className="ui-status settings-notice" data-tone={status.email.ready ? "success" : "warning"} role="status">
      {status.email.ready ? "Core's Resend connection is ready. Guest Visits emails come from its From address." : <>Resend is not ready, so guest emails wait in the queue. Connect and verify Resend in <a href="/settings/integrations" onClick={inPageLink(navigate, "/settings/integrations")}>Settings &gt; Integrations</a>.</>}
    </p>
    <SettingsCard id="visits-reply-title" title="Reply-to address" intro="Replies to confirmation, change and cancellation emails go here. Leave it empty to use the From address." notice={saving.notice}>
      <form className="ui-form visits-form" noValidate onSubmit={(event) => void submit(event)} onKeyDown={preventImplicitSubmission}>
        <Field id={ids("replyTo")} label="Reply-to address" optional error={saving.errors.replyTo}>
          <input {...fieldAria(ids("replyTo"), saving.errors.replyTo)} className="ui-control" type="email" autoComplete="email" spellCheck={false} maxLength={254} disabled={saving.busy} value={replyTo} onChange={(event) => { setReplyTo(event.target.value); saving.setErrors({}); }} />
        </Field>
        <div className="module-actions"><button className="ui-button ui-button--primary" type="submit" disabled={saving.busy || !update}>{saving.busy ? "Saving..." : "Save reply-to address"}</button></div>
      </form>
    </SettingsCard>
    <SettingsCard id="visits-test-title" title="Test email" intro={settings.testEmailSentMs ? `The last test email was sent ${formatInstant(settings.testEmailSentMs, status.timeZone)}.` : "No test email has been sent yet."} notice={testNotice}>
      <form className="ui-form visits-form" noValidate onSubmit={(event) => void sendTest(event)} onKeyDown={preventImplicitSubmission}>
        <Field id={ids("to")} label="Send a test email to" error={testError}>
          <input {...fieldAria(ids("to"), testError)} className="ui-control" type="email" autoComplete="email" spellCheck={false} maxLength={254} disabled={testing} value={testTo} onChange={(event) => { setTestTo(event.target.value); setTestError(""); }} />
        </Field>
        <div className="module-actions"><button className="ui-button" type="submit" disabled={testing || !status.email.ready}>{testing ? "Sending..." : "Send test email"}</button></div>
      </form>
    </SettingsCard>
  </div>;
}

function DiscordSettings({ settings, status, save, onDirty, navigate }: SectionProps) {
  const fromSettings = () => ({
    discordEnabled: settings.discordEnabled, discordChannelId: settings.discordChannelId, weeklySummaryEnabled: settings.weeklySummaryEnabled,
    weeklySummaryWeekday: settings.weeklySummaryWeekday, weeklySummaryTime: settings.weeklySummaryTime,
  });
  const [draft, setDraft] = useState(fromSettings);
  useEffect(() => { setDraft(fromSettings()); }, [settings.revision]);
  const saving = useSaving();
  const ids = useFieldIds();
  const focus = useFocusRequest();
  const fields = ["discordEnabled", "discordChannelId", "weeklySummaryEnabled", "weeklySummaryWeekday", "weeklySummaryTime"] as const;
  const update = settingsUpdate(settings, { ...settings, ...draft, discordChannelId: draft.discordChannelId.trim() }, fields);
  useEffect(() => { onDirty(Boolean(update)); }, [Boolean(update)]);
  const set = <Key extends keyof typeof draft>(field: Key, value: (typeof draft)[Key]) => { setDraft((current) => ({ ...current, [field]: value })); saving.setErrors({}); };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!update) return;
    const channel = draft.discordChannelId.trim();
    const problems: Record<string, string> = {};
    if (draft.discordEnabled && !channel) problems.discordChannelId = "Enter the Discord channel ID";
    else if (channel && !discordChannelPattern.test(channel)) problems.discordChannelId = "A channel ID is 17 to 20 digits";
    if (!isLocalTime(draft.weeklySummaryTime)) problems.weeklySummaryTime = "Enter the time as HH:MM";
    if (Object.keys(problems).length) { saving.setErrors(problems); focus(ids(Object.keys(problems)[0]!)); return; }
    await saving.run(() => save(update), draft.discordEnabled ? "Discord settings saved." : "Discord messages are off.", ids, focus);
  }

  return <div className="visits-stack">
    <p className="ui-status settings-notice" data-tone={status.discord.ready ? "success" : "warning"} role="status">
      {status.discord.ready ? "Core's Discord connection is ready." : <>Discord is not connected, so Guest Visits queues no Discord messages. Set up the bot in <a href="/settings/integrations" onClick={inPageLink(navigate, "/settings/integrations")}>Settings &gt; Integrations</a>.</>}
    </p>
    <SettingsCard id="visits-discord-title" title="Discord messages" intro="Post a message for every booking, change and cancellation, and a weekly summary of upcoming visits. Contact details and notes are never posted." notice={saving.notice}>
      <form className="ui-form visits-form" noValidate onSubmit={(event) => void submit(event)} onKeyDown={preventImplicitSubmission}>
        <fieldset className="visits-fieldset visits-fieldset--plain" disabled={saving.busy}>
          <legend className="visually-hidden">Discord messages</legend>
          <label className="checkbox-field"><input id={ids("discordEnabled")} className="ui-checkbox" type="checkbox" checked={draft.discordEnabled} onChange={(event) => set("discordEnabled", event.target.checked)} />Post Guest Visits messages in Discord</label>
          <Field id={ids("discordChannelId")} label="Channel ID" error={saving.errors.discordChannelId} help="In Discord, turn on Developer Mode, right-click the channel and choose Copy Channel ID.">
            <input {...fieldAria(ids("discordChannelId"), saving.errors.discordChannelId, true)} className="ui-control" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={20} value={draft.discordChannelId} onChange={(event) => set("discordChannelId", event.target.value)} />
          </Field>
        </fieldset>
        <fieldset className="visits-fieldset" disabled={saving.busy || !draft.discordEnabled}>
          <legend>Weekly summary</legend>
          <label className="checkbox-field"><input id={ids("weeklySummaryEnabled")} className="ui-checkbox" type="checkbox" checked={draft.weeklySummaryEnabled} onChange={(event) => set("weeklySummaryEnabled", event.target.checked)} />Post a summary of the coming week's visits</label>
          <div className="visits-time-grid">
            <Field id={ids("weeklySummaryWeekday")} label="Day" error={saving.errors.weeklySummaryWeekday}>
              <select {...fieldAria(ids("weeklySummaryWeekday"), saving.errors.weeklySummaryWeekday)} className="ui-control ui-native-select" disabled={!draft.weeklySummaryEnabled} value={draft.weeklySummaryWeekday} onChange={(event) => set("weeklySummaryWeekday", Number(event.target.value))}>
                {weekdayNames.map((name, day) => <option key={name} value={day}>{name}</option>)}
              </select>
            </Field>
            <Field id={ids("weeklySummaryTime")} label="Time" error={saving.errors.weeklySummaryTime}>
              <input {...fieldAria(ids("weeklySummaryTime"), saving.errors.weeklySummaryTime)} className="ui-control" type="time" step={300} disabled={!draft.weeklySummaryEnabled} value={draft.weeklySummaryTime} onChange={(event) => set("weeklySummaryTime", event.target.value)} />
            </Field>
          </div>
          <p className="field-help">In the {status.timeZone.replace(/_/g, " ")} time zone. A week with no visits still posts, saying so.</p>
        </fieldset>
        <div className="module-actions"><button className="ui-button ui-button--primary" type="submit" disabled={saving.busy || !update}>{saving.busy ? "Saving..." : "Save Discord settings"}</button></div>
      </form>
    </SettingsCard>
  </div>;
}
