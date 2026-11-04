// The staff workspace at /visits, for Admins and the Operators assigned Guest Visits: Availability, Visits, Needs
// attention and Guest teams, chosen with ?section= like Core's sectioned pages, under status banners for email, Discord
// and failed sends. Each failed Discord post has its own banner saying why, with Retry and Dismiss for Admins.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { SettingsSectionNavigation, settingsSectionHref, usePath, type DashboardRole } from "@lancerlogin/module-sdk/dashboard";
import { adminVisitsRoutes, type DiscordFailure, type VisitsStatus } from "../shared/visits-api.ts";
import { AvailabilitySection } from "./visits-availability";
import { BookingsSection } from "./visits-bookings";
import { failureOf, staffRequest } from "./visits-http.ts";
import { bookingFailureBanners, discordFailureBanner, moreDiscordFailuresText, type BannerPart } from "./visits-labels.ts";
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
    {status && <StatusBanners status={status} role={role} section={section} attentionHref={href("attention")} navigate={navigate} onStatus={setStatus} />}
    {status && section === "availability" && <AvailabilitySection timeZone={status.timeZone} onChanged={refreshStatus} />}
    {status && section === "visits" && <BookingsSection key="visits" mode="visits" timeZone={status.timeZone} outreach={outreach} onChanged={refreshStatus} />}
    {status && section === "attention" && <BookingsSection key="attention" mode="attention" timeZone={status.timeZone} outreach={outreach} onChanged={refreshStatus} />}
    {status && section === "teams" && <TeamsSection outreachAvailable={outreach.available} onChanged={refreshStatus} />}
  </section>;
}

type Banner = { readonly key: string; readonly tone: string; readonly text: ReactNode };
/** Where Admins grant Guest Visits access to Outreach: Settings > Modules > Module access. */
const moduleAccessPath = "/settings/modules";
/** Where Admins choose the Guest Visits Discord channel. */
const discordSettingsPath = "/settings/visits?section=discord";

type BannerLinks = { readonly attentionHref: string; readonly navigate: (path: string) => void };

function BannerParts({ parts, attentionHref, navigate }: BannerLinks & { parts: readonly BannerPart[] }) {
  return <>{parts.map((part, index) => {
    if (typeof part === "string") return part;
    const target = part.link === "attention" ? attentionHref : discordSettingsPath;
    return <a key={index} href={target} onClick={inPageLink(navigate, target)}>{part.label}</a>;
  })}</>;
}

/**
 * Problems staff should know about before anything else: email not ready, Discord on but unavailable, failed sends. On
 * the Visits section, Admins also learn how to let Guest Visits record visits in Outreach on its own.
 */
function StatusBanners({ status, role, section, attentionHref, navigate, onStatus }: BannerLinks & { status: VisitsStatus; role: DashboardRole; section: Section; onStatus: (status: VisitsStatus) => void }) {
  const links = { attentionHref, navigate };
  const candidates: (Banner | false)[] = [
    !status.email.ready && { key: "email", tone: "warning", text: `Confirmation emails are waiting: Core's Resend connection is not ready. Bookings still save, and their emails send once it is ready.${role === "admin" ? " Check Settings > Integrations." : " Ask an Admin to check Settings > Integrations."}` },
    status.discord.enabled && !status.discord.ready && { key: "discord", tone: "warning", text: "Guest Visits Discord messages are on, but Core's Discord connection is not ready, so no Discord messages are queued." },
    ...bookingFailureBanners(status.failures).map((banner): Banner => ({ key: banner.key, tone: "error", text: <BannerParts parts={banner.parts} {...links} /> })),
    status.outreach.available && !status.outreach.granted && role === "admin" && section === "visits" && {
      key: "outreach", tone: "neutral",
      text: <>Visits are recorded in Outreach only when staff use Record in Outreach. To record every booking automatically, grant Guest Visits access to Outreach in <a href={moduleAccessPath} onClick={inPageLink(navigate, moduleAccessPath)}>Settings &gt; Modules &gt; Module access</a>.</>,
    },
  ];
  const banners = candidates.filter((banner): banner is Banner => Boolean(banner));
  const more = moreDiscordFailuresText(status.failures);
  const attention = status.attentionCount > 0 && section !== "attention";
  if (!banners.length && !status.failures.discord.length && !attention) return null;
  return <div className="visits-banners">
    {banners.map((banner) => <p key={banner.key} className="ui-status settings-notice" data-tone={banner.tone} role={banner.tone === "error" ? "alert" : "status"}>{banner.text}</p>)}
    {status.failures.discord.map((failure) => <DiscordFailureBanner key={failure.id} failure={failure} channelId={status.failures.discordChannelId} admin={role === "admin"} onStatus={onStatus} {...links} />)}
    {more && <p className="ui-status settings-notice" data-tone="error" role="status">{more}</p>}
    {attention && <p className="ui-status settings-notice visits-attention-banner" data-tone="warning" role="status">
      <span>{status.attentionCount} {status.attentionCount === 1 ? "visit needs" : "visits need"} attention.</span>
      <a href={attentionHref} onClick={inPageLink(navigate, attentionHref)}>Review Needs attention</a>
    </p>}
  </div>;
}

/** One failed Discord post: what failed and why, and for Admins Retry (while it can still be sent) and Dismiss. */
function DiscordFailureBanner({ failure, channelId, admin, onStatus, ...links }: BannerLinks & { failure: DiscordFailure; channelId: string; admin: boolean; onStatus: (status: VisitsStatus) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = async (action: "retry" | "dismiss") => {
    setBusy(true);
    setError("");
    try { onStatus(await staffRequest<VisitsStatus>(action === "retry" ? adminVisitsRoutes.notificationRetry(failure.id) : adminVisitsRoutes.notificationDismiss(failure.id), { method: "POST" })); }
    catch (failed) { setError(failureOf(failed).message); }
    finally { setBusy(false); }
  };
  return <div className="ui-status settings-notice visits-failure-banner" data-tone="error" role="alert">
    <p><BannerParts parts={discordFailureBanner(failure, { channelId, admin })} {...links} /></p>
    {admin && <div className="visits-failure-actions">
      {failure.retryable && <button className="ui-button" type="button" disabled={busy} onClick={() => void act("retry")}>Retry</button>}
      <button className="ui-button" type="button" disabled={busy} onClick={() => void act("dismiss")}>Dismiss</button>
    </div>}
    {error && <p className="visits-failure-error">{error}</p>}
  </div>;
}
