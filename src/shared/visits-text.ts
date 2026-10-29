// Guest emails and Discord messages. Guest-entered text is HTML-escaped in email HTML and Discord-escaped in Discord
// messages. Emails carry the manage link; Discord messages and the weekly summary never carry contacts or the guest's
// team needs (`note`).
import { teamLabel, type FieldChange, type TeamIdentity } from "./visits-booking.ts";
import { formatDate, formatShortDate, formatTime, localMoment, singleLine, type CivilTime } from "./visits-time.ts";

/** Escape text for HTML element content and quoted attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Make guest text inert in a Discord message: one line, every Markdown character backslash-escaped (so no bold, spoilers,
 * masked links, headings or quotes), `<` escaped (so no user, role or channel mentions, timestamps or custom emoji), and a
 * zero-width space after every `@` and inside `://` (so @everyone and @here stay plain text and links do not unfurl).
 * Messages also send `allowed_mentions: { parse: [] }`, so nothing pings even if a mention got through.
 */
export function escapeDiscord(text: string): string {
  return singleLine(text)
    .replace(/[\\*_~`|>#\-[\]()<]/g, (character) => `\\${character}`)
    .replace(/@/g, "@\u200b")
    .replace(/:\/\//g, ":\u200b//");
}

/** The longest host team name settings accept. */
export const maximumHostNameLength = 80;
/** The longest guest page intro settings accept. */
export const maximumIntroTextLength = 2000;
/** Who guests visit when settings name no host team: "Your visit to our team is booked." */
export const defaultHostName = "our team";

/** The host team's name for guest text: the name from settings on one line, or "our team" when none is set. */
export function hostNameText(hostName: string | null | undefined): string {
  return singleLine(hostName ?? "") || defaultHostName;
}

/** Everything a guest message says about one visit, in local terms. */
export type VisitMessageDetails = {
  /** Who the guests are visiting, for example "FRC 321". */
  readonly hostName: string;
  readonly team: TeamIdentity;
  readonly contactName: string;
  readonly contactPhone: string;
  /** Local date (YYYY-MM-DD) and HH:MM times in the installation time zone. */
  readonly date: string;
  readonly arrival: string;
  readonly departure: string;
  /** Null when the guest did not give one. */
  readonly headcount: number | null;
  readonly note: string;
  /** The window's title, such as "Open shop", or empty. */
  readonly windowTitle: string;
};

/** Message details for a booking, read in the installation time zone. */
export function visitMessageDetails(civil: CivilTime, timeZone: string, input: {
  readonly hostName: string;
  readonly team: TeamIdentity;
  readonly booking: { readonly contactName: string; readonly contactPhone: string; readonly arrivalMs: number; readonly departureMs: number; readonly headcount: number | null; readonly note: string };
  readonly windowTitle?: string;
}): VisitMessageDetails {
  const arrival = localMoment(civil, timeZone, input.booking.arrivalMs);
  const departure = localMoment(civil, timeZone, input.booking.departureMs);
  return {
    hostName: input.hostName, team: input.team, contactName: input.booking.contactName, contactPhone: input.booking.contactPhone,
    date: arrival.date, arrival: arrival.time, departure: departure.time, headcount: input.booking.headcount, note: input.booking.note,
    windowTitle: input.windowTitle ?? "",
  };
}

/** What staff and guests read for a headcount the guest did not give. */
export const headcountNotGiven = "Not given";

/** "1 person", "12 people", or "headcount not given" in a sentence. */
export function peopleCount(count: number | null): string {
  return count === null ? "headcount not given" : `${count} ${count === 1 ? "person" : "people"}`;
}
const timeSpan = (details: Pick<VisitMessageDetails, "arrival" | "departure">) => `${formatTime(details.arrival)} to ${formatTime(details.departure)}`;

/** Plain-language names of what changed, for update emails and Discord: "date and time", "headcount" and so on. */
export function changeLabels(changes: readonly FieldChange[]): string[] {
  const labels: Record<FieldChange["field"], string> = {
    windowId: "date and time", arrivalMs: "date and time", departureMs: "date and time", headcount: "headcount", note: "team needs",
    contactName: "contact name", contactPhone: "phone", contactEmail: "email address", teamId: "team", status: "status",
  };
  return [...new Set(changes.map((change) => labels[change.field]))];
}

export type EmailContent = { readonly subject: string; readonly html: string; readonly text: string };

function detailRows(details: VisitMessageDetails): [string, string][] {
  const rows: [string, string][] = [
    ["Team", teamLabel(details.team)],
    ["Date", formatDate(details.date)],
    ["Arrival", formatTime(details.arrival)],
    ["Departure", formatTime(details.departure)],
    ["People", details.headcount === null ? headcountNotGiven : String(details.headcount)],
    ["Contact", details.contactName],
  ];
  if (details.windowTitle) rows.splice(2, 0, ["Time slot", details.windowTitle]);
  if (details.contactPhone) rows.push(["Phone", details.contactPhone]);
  if (details.note) rows.push(["Team needs", details.note]);
  return rows;
}

function emailContent(input: { subject: string; details: VisitMessageDetails; lead: string; manageUrl: string | null; linkLabel: string }): EmailContent {
  const { details } = input;
  const rows = detailRows(details);
  const linkText = input.manageUrl
    ? ["", `${input.linkLabel}:`, input.manageUrl, "", "This link works until your visit ends. Keep it private: anyone who has it can change or cancel this visit."]
    : [];
  const text = [`Hello ${details.contactName},`, "", input.lead, "", ...rows.map(([label, value]) => `${label}: ${value}`), ...linkText, "", `If you have questions, reply to this email.`].join("\n");
  const cell = (value: string) => escapeHtml(value).replace(/\n/g, "<br>");
  const html = [
    "<!doctype html>",
    `<html><body style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#1a1a1a">`,
    `<p>Hello ${escapeHtml(details.contactName)},</p>`,
    `<p>${escapeHtml(input.lead)}</p>`,
    `<table role="presentation" style="border-collapse:collapse">`,
    ...rows.map(([label, value]) => `<tr><th align="left" valign="top" style="padding:2px 16px 2px 0">${escapeHtml(label)}</th><td style="padding:2px 0">${cell(value)}</td></tr>`),
    "</table>",
    ...(input.manageUrl ? [
      `<p><a href="${escapeHtml(input.manageUrl)}">${escapeHtml(input.linkLabel)}</a></p>`,
      "<p>This link works until your visit ends. Keep it private: anyone who has it can change or cancel this visit.</p>",
    ] : []),
    "<p>If you have questions, reply to this email.</p>",
    "</body></html>",
  ].join("\n");
  return { subject: singleLine(input.subject), html, text };
}

/** The email sent when a visit is booked, and again when staff resend the confirmation. */
export function confirmationEmail(details: VisitMessageDetails, manageUrl: string): EmailContent {
  return emailContent({
    subject: `Your visit to ${details.hostName} on ${formatShortDate(details.date)}`, details, manageUrl,
    lead: `Your visit to ${details.hostName} is booked. Here are the details.`, linkLabel: "Change or cancel this visit",
  });
}

/** The email sent after the guest or staff change a visit, with the updated details and a fresh link. */
export function updateEmail(details: VisitMessageDetails, manageUrl: string, changes: readonly FieldChange[] = []): EmailContent {
  const changed = changeLabels(changes);
  return emailContent({
    subject: `Updated: your visit to ${details.hostName} on ${formatShortDate(details.date)}`, details, manageUrl, linkLabel: "Change or cancel this visit",
    lead: `Your visit to ${details.hostName} was changed${changed.length ? ` (${changed.join(", ")})` : ""}. Here are the updated details.`,
  });
}

/** The email sent after the guest or staff cancel a visit. The link, when given, shows the canceled visit until it would have ended. */
export function cancellationEmail(details: VisitMessageDetails, manageUrl: string | null): EmailContent {
  return emailContent({
    subject: `Canceled: your visit to ${details.hostName} on ${formatShortDate(details.date)}`, details, manageUrl, linkLabel: "View this visit",
    lead: `Your visit to ${details.hostName} is canceled. To visit another time, book again on the guest visit page.`,
  });
}

/** The longest message Discord accepts. */
export const discordContentLimit = 2000;

/** "FRC 321 RoboLancers - Monday, November 2, 6:00 PM to 8:00 PM - 12 people", with guest text escaped. */
export function discordVisitLine(details: Pick<VisitMessageDetails, "team" | "date" | "arrival" | "departure" | "headcount">): string {
  return `${escapeDiscord(teamLabel(details.team))} - ${formatShortDate(details.date)}, ${timeSpan(details)} - ${peopleCount(details.headcount)}`;
}

export function discordBookedMessage(details: VisitMessageDetails): string {
  return `New guest visit: ${discordVisitLine(details)}`;
}

export function discordChangedMessage(details: VisitMessageDetails, changes: readonly FieldChange[] = []): string {
  const changed = changeLabels(changes);
  return `Guest visit changed${changed.length ? ` (${changed.join(", ")})` : ""}: ${discordVisitLine(details)}`;
}

export function discordCanceledMessage(details: VisitMessageDetails): string {
  return `Guest visit canceled: ${discordVisitLine(details)}`;
}

/** Discord's SUPPRESS_EMBEDS message flag. */
export const discordSuppressEmbeds = 1 << 2;

export type DiscordMessageBody = {
  readonly content: string;
  readonly allowed_mentions: { readonly parse: readonly [] };
  readonly nonce: string;
  readonly enforce_nonce: true;
  readonly flags: number;
};

/**
 * The body to POST to `/channels/<channel>/messages`. Nothing is mentioned, link previews are off, and the nonce with
 * `enforce_nonce` makes Discord return the earlier message instead of posting twice when a send is retried.
 */
export function discordMessageBody(content: string, nonce: string): DiscordMessageBody {
  if (!content || content.length > discordContentLimit) throw new RangeError(`Discord messages are 1 to ${discordContentLimit} characters`);
  if (!/^[A-Za-z0-9_-]{1,25}$/.test(nonce)) throw new RangeError("Discord nonces are at most 25 characters");
  return { content, allowed_mentions: { parse: [] }, nonce, enforce_nonce: true, flags: discordSuppressEmbeds };
}
