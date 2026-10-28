// The staff workspace at /visits, for Admins and the Operators assigned Guest Visits: Availability, Visits, Needs
// attention and Guest teams, chosen with ?section= like Core's sectioned pages, under status banners for email, Discord
// and failed notifications.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { SettingsSectionNavigation, settingsSectionHref, usePath, type DashboardRole } from "@lancerlogin/module-sdk/dashboard";
import { adminVisitsRoutes, type VisitsStatus } from "../shared/visits-api.ts";
import { AvailabilitySection } from "./visits-availability";
import { BookingsSection } from "./visits-bookings";
import { failureOf, staffRequest } from "./visits-http.ts";
import { TeamsSection } from "./visits-teams";
import { inPageLink, LoadState } from "./visits-ui";

const sections = [["availability", "Availability"], ["visits", "Visits"], ["attention", "Needs attention"], ["teams", "Guest teams"]] as const;
type Section = (typeof sections)[number][0];
const isSection = (value: string | null): value is Section => sections.some(([id]) => id === value);

export function VisitsWorkspace({ role }: { role: DashboardRole }) {
  const { path, search, navigate } = usePath();
  const requested = new URLSearchParams(search).get("section");
  const section: Section = isSection(requested) ? requested : "availability";
  const [status, setStatus] = useState<VisitsStatus>();
  const [statusError, setStatusError] = useState("");

  const refreshStatus = useCallback(async () => {
    try { setStatus(await staffRequest<VisitsStatus>(adminVisitsRoutes.status)); setStatusError(""); }
    catch (error) { setStatusError(failureOf(error).message); }
  }, []);
  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  const href = (id: Section) => settingsSectionHref(path, search, id);
  const links = sections.map(([id, label]): [string, string] => [href(id), id === "attention" && status?.attentionCount ? `${label} (${status.attentionCount})` : label]);
  const outreach = status?.outreach ?? { available: false, granted: false };

  return <section className="visits-workspace operational-browser-page" aria-labelledby="visits-title">
    <div className="page-intro operational-page-intro visits-page-intro">
      <h1 id="visits-title">Guest Visits</h1>
      <a className="visits-header-link" href="/visit" target="_blank" rel="noopener">Open guest page<span className="visually-hidden"> in a new tab</span></a>
    </div>
    <div className="settings-section-toolbar">
      <SettingsSectionNavigation label="Guest Visits sections" pickerLabel="Guest Visits section" currentHref={href(section)} navigate={navigate} sections={links} />
    </div>
    {!status && <LoadState loading={!statusError} error={statusError} label="Guest Visits" onRetry={() => { setStatusError(""); void refreshStatus(); }} />}
    {status && <StatusBanners status={status} role={role} section={section} attentionHref={href("attention")} navigate={navigate} />}
    {status && section === "availability" && <AvailabilitySection timeZone={status.timeZone} onChanged={refreshStatus} />}
    {status && section === "visits" && <BookingsSection key="visits" mode="visits" timeZone={status.timeZone} outreach={outreach} onChanged={refreshStatus} />}
    {status && section === "attention" && <BookingsSection key="attention" mode="attention" timeZone={status.timeZone} outreach={outreach} onChanged={refreshStatus} />}
    {status && section === "teams" && <TeamsSection outreachAvailable={outreach.available} onChanged={refreshStatus} />}
  </section>;
}

/** Where Admins grant Guest Visits access to Outreach: Settings > Modules > Module access. */
const moduleAccessPath = "/settings/modules";

/**
 * Problems staff should know about before anything else: email not ready, Discord on but unavailable, failed sends. On
 * the Visits section, Admins also learn how to let Guest Visits record visits in Outreach on its own.
 */
function StatusBanners({ status, role, section, attentionHref, navigate }: { status: VisitsStatus; role: DashboardRole; section: Section; attentionHref: string; navigate: (path: string) => void }) {
  const failed = status.failedNotifications;
  const banners: { key: string; tone: string; text: ReactNode }[] = [
    !status.email.ready && { key: "email", tone: "warning", text: `Confirmation emails are waiting: Core's Resend connection is not ready. Bookings still save, and their emails send once it is ready.${role === "admin" ? " Check Settings > Integrations." : " Ask an Admin to check Settings > Integrations."}` },
    status.discord.enabled && !status.discord.ready && { key: "discord", tone: "warning", text: "Guest Visits Discord messages are on, but Core's Discord connection is not ready, so no Discord messages are queued." },
    failed > 0 && { key: "failed", tone: "error", text: `${failed} ${failed === 1 ? "message" : "messages"} failed to send. Guest Visits retries every five minutes; visits whose email failed are in Needs attention.` },
    status.outreach.available && !status.outreach.granted && role === "admin" && section === "visits" && {
      key: "outreach", tone: "neutral",
      text: <>Visits are recorded in Outreach only when staff use Record in Outreach. To record every booking automatically, grant Guest Visits access to Outreach in <a href={moduleAccessPath} onClick={inPageLink(navigate, moduleAccessPath)}>Settings &gt; Modules &gt; Module access</a>.</>,
    },
  ].filter((banner): banner is { key: string; tone: string; text: ReactNode } => Boolean(banner));
  const attention = status.attentionCount > 0 && section !== "attention";
  if (!banners.length && !attention) return null;
  return <div className="visits-banners">
    {banners.map((banner) => <p key={banner.key} className="ui-status settings-notice" data-tone={banner.tone} role={banner.tone === "error" ? "alert" : "status"}>{banner.text}</p>)}
    {attention && <p className="ui-status settings-notice visits-attention-banner" data-tone="warning" role="status">
      <span>{status.attentionCount} {status.attentionCount === 1 ? "visit needs" : "visits need"} attention.</span>
      <a href={attentionHref} onClick={inPageLink(navigate, attentionHref)}>Review Needs attention</a>
    </p>}
  </div>;
}
