import test from "node:test";
import assert from "node:assert/strict";
import { at, civil, newYork } from "./helpers/civil-time.ts";
import {
  cancellationEmail, changeLabels, confirmationEmail, discordBookedMessage, discordCanceledMessage, discordChangedMessage, discordMessageBody, discordVisitLine,
  escapeDiscord, escapeHtml, updateEmail, visitMessageDetails, type VisitMessageDetails,
} from "../src/shared/visits-text.ts";

const zeroWidthSpace = String.fromCharCode(0x200b);
const manageUrl = `https://dashboard.example.org/visit/manage#${"T".repeat(43)}`;

const details = (overrides: Partial<VisitMessageDetails> = {}): VisitMessageDetails => ({
  hostName: "FRC 321", team: { number: "1234", name: "Gear Heads", program: "FRC" }, contactName: "Pat Coach", contactPhone: "555-010-0199",
  date: "2026-11-02", arrival: "18:30", departure: "20:00", headcount: 12, note: "", windowTitle: "Open shop", ...overrides,
});

const hostile = details({
  team: { number: "1234", name: "<script>alert('x')</script> & @everyone **bold**", program: "FRC" },
  contactName: "Pat <b>Coach</b>", note: "Line one\n<img src=x onerror=alert(1)>", contactPhone: "555 \"010\" 0199",
});

test("HTML escaping covers element text and quoted attributes", () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>Tom & Jerry</a>`), "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;Tom &amp; Jerry&lt;/a&gt;");
});

test("Discord escaping makes guest text inert", () => {
  assert.equal(escapeDiscord("**bold** _it_ ~~gone~~ `code` ||spoiler|| > quote # head - item"), "\\*\\*bold\\*\\* \\_it\\_ \\~\\~gone\\~\\~ \\`code\\` \\|\\|spoiler\\|\\| \\> quote \\# head \\- item");
  assert.equal(escapeDiscord("[click](https://evil.example)"), `\\[click\\]\\(https:${zeroWidthSpace}//evil.example\\)`);
  assert.equal(escapeDiscord("@everyone @here"), `@${zeroWidthSpace}everyone @${zeroWidthSpace}here`);
  assert.equal(escapeDiscord("<@123456789012345678> <#123> <@&42> <t:1700000000:F>"), `\\<@${zeroWidthSpace}123456789012345678\\> \\<\\#123\\> \\<@${zeroWidthSpace}&42\\> \\<t:1700000000:F\\>`);
  assert.equal(escapeDiscord("back\\slash"), "back\\\\slash");
  assert.equal(escapeDiscord("Line one\n# Line two"), "Line one \\# Line two");
});

test("message details are read in the installation time zone", () => {
  const result = visitMessageDetails(civil, newYork, {
    hostName: "FRC 321", team: { number: "1234", name: "Gear Heads", program: "FRC" }, windowTitle: "Open shop",
    booking: { contactName: "Pat Coach", contactPhone: "", arrivalMs: at("2026-11-02T23:30:00Z"), departureMs: at("2026-11-03T01:00:00Z"), headcount: 12, note: "Hi" },
  });
  assert.deepEqual(result, { ...details({ contactPhone: "", note: "Hi" }) });
});

test("the confirmation email states the visit plainly and carries the manage link", () => {
  const email = confirmationEmail(details({ note: "Bringing our robot" }), manageUrl);
  assert.equal(email.subject, "Your visit to FRC 321 on Monday, November 2");
  assert.match(email.text, /^Hello Pat Coach,\n\nYour visit to FRC 321 is booked\. Here are the details\.\n/);
  for (const line of ["Team: FRC 1234 Gear Heads", "Date: Monday, November 2, 2026", "Time slot: Open shop", "Arrival: 6:30 PM", "Departure: 8:00 PM", "People: 12", "Phone: 555-010-0199", "Note: Bringing our robot", manageUrl]) {
    assert.ok(email.text.includes(line), line);
  }
  assert.ok(email.html.includes(`<a href="${manageUrl}">Change or cancel this visit</a>`));
  assert.match(email.text, /works until your visit ends/);
  assert.doesNotMatch(email.text + email.html + email.subject, /[\u2013\u2014]/);
});

test("guest text is escaped in email HTML and kept out of the subject", () => {
  const email = confirmationEmail(hostile, manageUrl);
  assert.doesNotMatch(email.html, /<script|<img|<b>/);
  assert.ok(email.html.includes("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; @everyone **bold**"));
  assert.ok(email.html.includes("Line one<br>&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(email.html.includes("555 &quot;010&quot; 0199"));
  assert.equal(email.subject, "Your visit to FRC 321 on Monday, November 2");
  assert.equal(confirmationEmail(details({ hostName: "FRC 321\r\nBcc: x@example.org" }), manageUrl).subject, "Your visit to FRC 321 Bcc: x@example.org on Monday, November 2");
});

test("update and cancellation emails say what happened, with a fresh link", () => {
  const changes = [{ field: "arrivalMs" as const, from: 1, to: 2 }, { field: "departureMs" as const, from: 1, to: 2 }, { field: "headcount" as const, from: 12, to: 14 }];
  assert.deepEqual(changeLabels(changes), ["date and time", "headcount"]);
  const update = updateEmail(details({ headcount: 14 }), manageUrl, changes);
  assert.equal(update.subject, "Updated: your visit to FRC 321 on Monday, November 2");
  assert.ok(update.text.includes("Your visit to FRC 321 was changed (date and time, headcount). Here are the updated details."));
  assert.ok(update.text.includes(manageUrl) && update.html.includes(manageUrl));
  const canceled = cancellationEmail(details(), manageUrl);
  assert.equal(canceled.subject, "Canceled: your visit to FRC 321 on Monday, November 2");
  assert.ok(canceled.text.includes("Your visit to FRC 321 is canceled."));
  assert.ok(canceled.html.includes(">View this visit</a>"));
  const noLink = cancellationEmail(details(), null);
  assert.doesNotMatch(noLink.text + noLink.html, /visit\/manage|href=/);
});

test("Discord lines name the team, time and headcount, never contacts or notes", () => {
  const visit = details({ note: "Private note", contactName: "Pat Coach" });
  assert.equal(discordVisitLine(visit), "FRC 1234 Gear Heads - Monday, November 2, 6:30 PM to 8:00 PM - 12 people");
  assert.equal(discordBookedMessage(visit), "New guest visit: FRC 1234 Gear Heads - Monday, November 2, 6:30 PM to 8:00 PM - 12 people");
  assert.equal(discordChangedMessage(visit, [{ field: "headcount", from: 10, to: 12 }]), "Guest visit changed (headcount): FRC 1234 Gear Heads - Monday, November 2, 6:30 PM to 8:00 PM - 12 people");
  assert.equal(discordCanceledMessage(details({ headcount: 1 })), "Guest visit canceled: FRC 1234 Gear Heads - Monday, November 2, 6:30 PM to 8:00 PM - 1 person");
  for (const message of [discordBookedMessage(visit), discordChangedMessage(visit), discordCanceledMessage(visit)]) assert.doesNotMatch(message, /Pat|Private|555/);
  assert.equal(discordBookedMessage(hostile), `New guest visit: FRC 1234 \\<script\\>alert\\('x'\\)\\</script\\> & @${zeroWidthSpace}everyone \\*\\*bold\\*\\* - Monday, November 2, 6:30 PM to 8:00 PM - 12 people`);
});

test("Discord bodies mention nobody, suppress previews and carry a nonce Discord enforces", () => {
  assert.deepEqual(discordMessageBody("Hello", "abc123"), { content: "Hello", allowed_mentions: { parse: [] }, nonce: "abc123", enforce_nonce: true, flags: 4 });
  assert.throws(() => discordMessageBody("", "abc"), RangeError);
  assert.throws(() => discordMessageBody("x".repeat(2001), "abc"), RangeError);
  assert.throws(() => discordMessageBody("Hello", "x".repeat(26)), RangeError);
});
