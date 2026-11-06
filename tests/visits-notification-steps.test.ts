// The visits.notifications job in scheduler steps (module SDK 1.6.0): recover, deliver, one notification per send slice,
// then purge, with the step carried in Core's cursor; the full-pass fallback for Cores without steps; and a per-slice
// CPU estimate in the spirit of Core's tests-ts/scheduler-slice-cpu.test.ts.
//
// Slice CPU on Cloudflare is mostly per call: Core measured on dev about 1.5 ms + 0.45 ms per D1 query + 1.5 ms per
// provider request, and holds every Core slice to an estimated 7 ms of the Workers Free plan's 10 ms. These tests count
// the job's own D1 calls (a batch is one) and charge what Core adds around them: the slice's state read and two state
// writes, the time zone read, each provider readiness check, Discord's configuration, Resend's configuration, the
// Outreach grant lookup, and for each Outreach operation Core's call-state read and audit row plus Outreach's own
// queries. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { book, visitsHarness, withShopSeries, type Harness } from "./helpers/visits-harness.ts";
import {
  formatNotificationCursor, notificationsPerPass, notificationsPerRound, parseNotificationCursor, runVisitsNotificationsJob, type NotificationStep,
} from "../src/api/visits-delivery.ts";
import type { VisitsDeps } from "../src/api/visits-runtime.ts";

const channel = "123456789012345678";
const estimatedCpuMs = (d1: number, provider: number) => 1.5 + 0.45 * d1 + 1.5 * provider;
const steadyBudgetMs = 7;
/** The scheduler state read and two state writes Core makes in every slice. */
const coreSliceQueries = 3;

type Usage = { d1: number; provider: number; calls: string[] };

/** The harness's database and job deps, counting D1 calls, provider requests and the calls Core makes for them. */
function counted(harness: Harness) {
  let usage: Usage = { d1: 0, provider: 0, calls: [] };
  const charge = (d1: number, provider: number, call: string) => { usage.d1 += d1; usage.provider += provider; usage.calls.push(call); };
  const originals = new WeakMap<object, unknown>();
  const wrap = (statement: any): any => {
    const wrapped = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      first: (...args: unknown[]) => { charge(1, 0, "d1"); return statement.first(...args); },
      all: () => { charge(1, 0, "d1"); return statement.all(); },
      run: () => { charge(1, 0, "d1"); return statement.run(); },
    };
    originals.set(wrapped, statement);
    return wrapped;
  };
  const db = {
    prepare: (sql: string) => wrap(harness.db.prepare(sql)),
    batch: (statements: object[]) => { charge(1, 0, "d1 batch"); return harness.db.batch(statements.map((statement) => (originals.get(statement) ?? statement) as never)); },
  };
  const base = harness.depsFor(true, null);
  const slice = (): VisitsDeps => {
    let timeZone: Promise<string> | undefined;
    return {
      ...base,
      timeZone: () => timeZone ??= (charge(1, 0, "time zone"), base.timeZone()),
      email: {
        ready: () => { charge(1, 0, "email ready"); return harness.email.ready(); },
        send: (message: never) => { charge(1, 1, "email send"); return harness.email.send(message); },
        providerStatus: (error: unknown) => harness.email.providerStatus(error),
      } as never,
      discord: {
        ready: () => { charge(1, 0, "discord ready"); return harness.discord.ready(); },
        client: async () => {
          charge(1, 0, "discord config");
          const client = await harness.discord.client();
          return { ...client, request: (path: string, init: RequestInit) => { charge(0, 1, `discord ${init.method}`); return client.request(path, init); } };
        },
        providerStatus: (error: unknown) => harness.discord.providerStatus(error),
      } as never,
      outreach: {
        ...base.outreach,
        client: async () => {
          charge(1, 0, "outreach grant");
          const client = await base.outreach.client();
          // Core reads the call state and writes an audit row; Outreach then reads (find-teams) or finds or creates.
          return client && { call: (operation: string, input?: unknown) => { charge(operation === "find-teams" ? 3 : 4, 0, `outreach ${operation}`); return client.call(operation, input as never); } };
        },
      },
    };
  };
  return {
    db: db as never,
    /** One slice: fresh deps (Core builds them per run) and Core's own queries. */
    async run(cursor: string | undefined) {
      usage = { d1: coreSliceQueries, provider: 0, calls: [] };
      const result = await runVisitsNotificationsJob(db as never, slice(), { steps: true, ...(cursor ? { cursor } : {}) }) as NotificationStep;
      return { result, ...usage };
    },
  };
}

type Slice = Awaited<ReturnType<ReturnType<typeof counted>["run"]>> & { cursor: string | undefined };

/** One round on the Durable Object: the first slice, then each step it asks for, a second apart. */
async function round(harness: Harness, counter = counted(harness)): Promise<Slice[]> {
  const slices: Slice[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < 60; index += 1) {
    const slice = await counter.run(cursor);
    slices.push({ ...slice, cursor });
    if (!slice.result.more) return slices;
    cursor = slice.result.cursor;
    assert.ok(cursor && cursor.length <= 64, `a cursor Core keeps: ${cursor}`);
    harness.clock.now += 1_000;
  }
  throw new Error("The round did not finish");
}

const steps = (slices: Slice[]) => slices.map((slice) => slice.result.step);
const cursors = (slices: Slice[]) => slices.map((slice) => slice.cursor ?? null);
const total = (slices: Slice[], key: "delivered" | "pending" | "failed" | "skipped") => slices.reduce((sum, slice) => sum + slice.result[key], 0);

async function enableDiscord(harness: Harness, extra: Record<string, unknown> = {}) {
  const current = await harness.call("GET", "/admin/visits/settings");
  const saved = await harness.call("PUT", "/admin/visits/settings", { body: { revision: current.body.revision, discordEnabled: true, discordChannelId: channel, ...extra } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
}

/**
 * Bookings whose confirmation emails (and Discord posts, when Discord messages are on) wait for the job. Discord posts
 * are queued only while Discord is ready, so they are sent at booking and then put back in the queue unsent.
 */
async function queued(harness: Harness, count: number) {
  harness.email.readyValue = false;
  for (let index = 0; index < count; index += 1) await book(harness, { teamNumber: String(99800 + index), teamName: `Test Team ${index}`, contactEmail: `guest-${index}@example.test`, headcount: index + 1 });
  harness.email.readyValue = true;
  harness.db.sqlite.prepare("UPDATE visits_notifications SET status='pending',attempts=0,next_attempt_ms=?,external_id=NULL WHERE channel='discord'").run(harness.clock.now);
  harness.discord.posts.length = 0;
  harness.discord.byNonce.clear();
}

test("the cursor names the step and round-trips; anything unreadable starts the round again", () => {
  for (const cursor of [
    { step: "deliver" }, { step: "purge", grantChecked: false }, { step: "purge", grantChecked: true },
    { step: "send", sent: 0, channels: ["email", "discord", "outreach"], grantChecked: true }, { step: "send", sent: notificationsPerRound - 1, channels: ["discord"], grantChecked: false },
  ] as const) {
    const text = formatNotificationCursor(cursor);
    assert.ok(text.length <= 64);
    assert.deepEqual(parseNotificationCursor(text), cursor);
  }
  assert.equal(formatNotificationCursor({ step: "send", sent: 3, channels: ["email", "discord"], grantChecked: false }), "send:3:ed:-");
  for (const text of [undefined, "", "recover", "cleanup", "send:1::-", "send:1:x:-", "send:-1:e:-", "purge", "send:1:e:g:extra"]) assert.deepEqual(parseNotificationCursor(text), { step: "recover" }, String(text));
  // A round that reached its cap purges, even from a hand-made cursor.
  assert.deepEqual(parseNotificationCursor(`send:${notificationsPerRound}:e:g`), { step: "purge", grantChecked: true });
});

test("an idle round is two slices that check no provider and write nothing that did not change", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  harness.outreach.ready = true;
  harness.outreach.granted = true;
  // The grant is already stored, as an earlier pass left it.
  harness.db.exec("UPDATE visits_settings SET outreach_granted=1, outreach_checked_ms=5");
  const slices = await round(harness);
  assert.deepEqual(steps(slices), ["recover", "deliver"]);
  assert.deepEqual(cursors(slices), [null, "deliver"]);
  assert.deepEqual(slices[0]!.result, { step: "recover", more: true, cursor: "deliver", recovered: 0, delivered: 0, pending: 0, failed: 0, skipped: 0, summary: "off" });
  assert.equal(slices[1]!.result.more, false);
  assert.equal(slices[1]!.result.outreachGranted, true, "the last slice refreshes the stored grant");
  const calls = slices.flatMap((slice) => slice.calls);
  assert.ok(!calls.includes("email ready") && !calls.includes("discord ready"), calls.join(", "));
  assert.deepEqual(harness.db.rows("SELECT outreach_granted, outreach_checked_ms FROM visits_settings").map((row) => ({ ...row })), [{ outreach_granted: 1, outreach_checked_ms: 5 }], "an unchanged grant is not rewritten");
  // A revoked grant is noticed by the next round and stored, so requests stop queueing Outreach records.
  harness.outreach.granted = false;
  const revoked = await round(harness);
  assert.equal(revoked.at(-1)!.result.outreachGranted, false);
  assert.deepEqual(harness.db.rows("SELECT outreach_granted FROM visits_settings").map((row) => ({ ...row })), [{ outreach_granted: 0 }]);
});

test("a round goes recover, deliver, one notification per send slice, then purges; the cursor carries the step and the count", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  await enableDiscord(harness);
  await queued(harness, 2);
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_notifications WHERE status='pending'"), 4);
  const slices = await round(harness);
  assert.deepEqual(steps(slices), ["recover", "deliver", "send", "send", "send", "send", "send"]);
  assert.deepEqual(cursors(slices), [null, "deliver", "send:0:ed:-", "send:1:ed:-", "send:2:ed:-", "send:3:ed:-", "send:4:ed:-"]);
  assert.deepEqual(slices.slice(2, 6).map((slice) => slice.result.delivered), [1, 1, 1, 1]);
  assert.equal(slices.at(-1)!.result.delivered, 0, "the last send slice found nothing left and purged");
  assert.equal(slices.at(-1)!.result.more, false);
  assert.equal(harness.email.sent.length, 2);
  assert.equal(harness.discord.posts.length, 2);
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_notifications WHERE status='delivered'"), 4);
  for (const slice of slices) assert.ok(slice.provider <= 1, `${slice.result.step} makes at most one provider request: ${slice.calls.join(", ")}`);
});

test("a round sends at most its cap and leaves the rest for the next round; a provider that is not ready keeps its rows queued", async () => {
  const harness = visitsHarness();
  await withShopSeries(harness);
  await queued(harness, notificationsPerRound + 2);
  harness.discord.readyValue = false;
  const first = await round(harness);
  assert.equal(total(first, "delivered"), notificationsPerRound);
  assert.deepEqual(cursors(first).slice(-2), [`send:${notificationsPerRound - 1}:e:-`, "purge:-"]);
  assert.equal(first.at(-1)!.result.step, "purge");
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_notifications WHERE status='pending'"), 2);
  harness.clock.now += 300_000;
  const second = await round(harness);
  assert.equal(total(second, "delivered"), 2);
  assert.equal(new Set(harness.email.sent.map((message) => message.to)).size, notificationsPerRound + 2);
  // Email not ready: its rows wait, and the round neither claims them nor checks Discord, which has nothing due.
  harness.email.readyValue = false;
  await book(harness, { teamNumber: "99701", teamName: "Late", contactEmail: "late@example.test" });
  const waiting = await round(harness);
  assert.deepEqual(steps(waiting), ["recover", "deliver"]);
  assert.ok(waiting[1]!.calls.includes("email ready") && !waiting[1]!.calls.includes("discord ready"), waiting[1]!.calls.join(", "));
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_notifications WHERE status='pending' AND attempts=0"), 1);
});

test("recover takes back a stopped sender's row and queues the weekly summary; the send slices then post it", async () => {
  const harness = visitsHarness(Date.parse("2026-10-20T12:00:00Z"));
  await harness.call("POST", "/admin/visits/windows", { body: { date: "2026-10-27", startTime: "18:00", endTime: "21:00" } });
  await withShopSeries(harness);
  await enableDiscord(harness);
  harness.email.readyValue = false;
  await book(harness, { date: "2026-10-27", arrival: "18:00", departure: "19:00" });
  harness.email.readyValue = true;
  harness.discord.posts.length = 0;
  harness.clock.now = Date.parse("2026-10-26T16:00:00Z");
  const email = harness.db.rows<{ id: string }>("SELECT id FROM visits_notifications WHERE channel='email'")[0]!;
  harness.db.sqlite.prepare("UPDATE visits_notifications SET status='sending', lease_token='lease-token-expired', lease_expires_ms=?, next_attempt_ms=NULL, attempts=1 WHERE id=?").run(harness.clock.now - 1, email.id);
  const slices = await round(harness);
  assert.equal(slices[0]!.result.recovered, 1);
  assert.equal(slices[0]!.result.summary, "queue");
  assert.equal(total(slices, "delivered"), 2);
  assert.equal(harness.email.sent.length, 1);
  assert.equal(harness.discord.posts.length, 1);
  assert.match(harness.discord.posts[0]!.body.content, /^\*\*Guest visits from Monday, October 26/);
  assert.deepEqual(harness.db.rows("SELECT channel, kind, status, attempts FROM visits_notifications ORDER BY channel, kind").map((row) => ({ ...row })), [
    { channel: "discord", kind: "booked", status: "delivered", attempts: 1 }, { channel: "discord", kind: "weekly-summary", status: "delivered", attempts: 1 },
    { channel: "email", kind: "booked", status: "delivered", attempts: 2 },
  ]);
});

test("Outreach is looked up only when a record is due; a new team is found, created and recorded one operation per slice", async () => {
  const harness = visitsHarness();
  harness.outreach.ready = true;
  harness.outreach.granted = true;
  await withShopSeries(harness);
  harness.email.readyValue = false;
  await book(harness);
  harness.email.readyValue = true;
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_notifications WHERE channel='outreach' AND status='pending'"), 1);
  const slices = await round(harness);
  // The email, then find-teams (none), ensure-team and the record, then nothing left.
  assert.deepEqual(cursors(slices), [null, "deliver", "send:0:eo:g", "send:1:eo:g", "send:2:eo:g", "send:3:eo:g", "send:4:eo:g"]);
  assert.deepEqual(slices.map((slice) => slice.calls.filter((call) => call.startsWith("outreach ") && call !== "outreach grant").length), [0, 0, ...slices.slice(2).map((slice) => slice.calls.some((call) => call === "email send") || slice === slices.at(-1) ? 0 : 1)]);
  assert.equal(slices.slice(2).reduce((sum, slice) => sum + slice.result.pending, 0), 2, "the two linking slices put the record back in the queue");
  assert.equal(total(slices, "delivered"), 2);
  assert.equal(slices[1]!.result.outreachGranted, true);
  assert.equal(slices.at(-1)!.result.outreachGranted, undefined, "the purge does not look the grant up again");
  assert.deepEqual(harness.outreach.calls.map((call) => call.operation), ["find-teams", "ensure-team", "ensure-team-support-activity"]);
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_bookings WHERE outreach_activity_id IS NOT NULL"), 1);
  assert.equal(harness.email.sent.length, 1);
  // The team is linked now, so the next visit's record is one slice.
  harness.email.readyValue = false;
  await book(harness, { contactEmail: "again@example.test", date: "2026-11-04", arrival: "18:00", departure: "19:00" });
  harness.email.readyValue = true;
  const linked = await round(harness);
  assert.equal(linked.length, 5, "recover, deliver, the email, the record, then nothing left");
  assert.deepEqual(harness.outreach.calls.slice(3).map((call) => call.operation), ["ensure-team-support-activity"]);
  // A due record without a grant: the deliver slice stores the revoked grant and the record waits.
  await book(harness, { teamNumber: "99902", teamName: "Two", contactEmail: "two@example.test" });
  harness.outreach.granted = false;
  const revoked = await round(harness);
  assert.deepEqual(steps(revoked), ["recover", "deliver"]);
  assert.equal(revoked[1]!.result.outreachGranted, false);
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_notifications WHERE channel='outreach' AND status='pending' AND attempts=0"), 1);
  assert.deepEqual(harness.db.rows("SELECT outreach_granted FROM visits_settings").map((row) => ({ ...row })), [{ outreach_granted: 0 }]);
});

test("without scheduler steps (the cron fallback, or a Core before SDK 1.6.0) the job does one full pass of up to five", async () => {
  for (const scheduler of [undefined, { steps: false }, { steps: false, cursor: "send:0:e:-" }]) {
    const harness = visitsHarness();
    await withShopSeries(harness);
    await queued(harness, 7);
    const pass = await runVisitsNotificationsJob(harness.db as never, harness.depsFor(true, null), scheduler);
    assert.deepEqual(pass, { recovered: 0, delivered: notificationsPerPass, pending: 0, failed: 0, skipped: 0, summary: "off", outreachGranted: false }, JSON.stringify(scheduler));
    assert.equal("more" in pass, false, "a full pass asks for no continuation, as before");
    assert.equal(harness.email.sent.length, 5);
    assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_notifications WHERE status='pending'"), 2);
    // A full pass still notes the grant check on every run, as before.
    assert.equal(harness.db.rows<{ outreach_checked_ms: number }>("SELECT outreach_checked_ms FROM visits_settings")[0]!.outreach_checked_ms, harness.clock.now);
  }
});

test("every slice of a busy round stays within an estimated 7 ms of Free-plan CPU and makes at most one provider request", async (t) => {
  const harness = visitsHarness(Date.parse("2026-10-20T12:00:00Z"));
  harness.outreach.ready = true;
  harness.outreach.granted = true;
  await harness.call("POST", "/admin/visits/windows", { body: { date: "2026-10-27", startTime: "18:00", endTime: "21:00" } });
  await withShopSeries(harness);
  await enableDiscord(harness);
  await queued(harness, 3);
  harness.clock.now = Date.parse("2026-10-26T16:00:00Z");
  // A change email (with its list of changes), its Discord post and Outreach records for new teams wait too.
  harness.email.readyValue = false;
  harness.discord.readyValue = false;
  const changed = await book(harness, { teamNumber: "99811", teamName: "Changed", contactEmail: "changed@example.test", date: "2026-10-27", arrival: "18:00", departure: "19:00" });
  assert.equal((await harness.call("PUT", `/admin/visits/bookings/${changed.id}`, { body: { revision: 0, date: "2026-11-04", arrival: "18:00", departure: "19:00" } })).status, 200);
  harness.email.readyValue = true;
  harness.discord.readyValue = true;
  const table: Record<string, unknown>[] = [];
  const check = (slices: Slice[], label: string) => {
    slices.forEach((slice, index) => {
      const estimate = estimatedCpuMs(slice.d1, slice.provider);
      table.push({ label, step: index + 1, name: slice.result.step, d1: slice.d1, provider: slice.provider, estimate: Number(estimate.toFixed(2)) });
      assert.ok(estimate <= steadyBudgetMs, `${label} slice ${index + 1} (${slice.result.step}): ${slice.d1} D1 queries and ${slice.provider} provider requests estimate ${estimate.toFixed(2)} ms: ${slice.calls.join(", ")}`);
      assert.ok(slice.provider <= 1, `${label} slice ${index + 1} makes at most one provider request: ${slice.calls.join(", ")}`);
    });
  };
  const waiting = () => harness.count("SELECT COUNT(*) AS n FROM visits_notifications WHERE status IN ('pending','sending')");
  const queuedRows = waiting();
  assert.ok(queuedRows >= 12, `${queuedRows} rows wait`);
  // A round stops at its cap, so the queue takes two rounds, five minutes apart.
  for (let index = 1; waiting() && index <= 3; index += 1) {
    check(await round(harness), `busy ${index}`);
    harness.clock.now += 300_000;
  }
  assert.equal(waiting(), 0);
  assert.equal(harness.count("SELECT COUNT(*) AS n FROM visits_notifications WHERE status!='delivered'"), 0);
  check(await round(harness), "idle");
  t.diagnostic(JSON.stringify(table));
});
