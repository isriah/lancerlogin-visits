// Window changes update Needs attention in SQL, for every visit in the changed windows at once. These statements must
// follow the library's rule, nextAttention(current, windowAttentionReason(visit, window)), in every combination.
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "./helpers/d1.ts";
import { bookingRow, insert, teamRow, windowEnd, windowRow, windowStart } from "./helpers/rows.ts";
import { windowAttentionStatements } from "../src/api/visits-runtime.ts";
import { nextAttention, windowAttentionReason, type Attention, type AttentionReason } from "../src/shared/visits-booking.ts";
import type { WindowStatus } from "../src/shared/visits-schedule.ts";

const hour = 3_600_000;
const attentions: Attention[] = [
  { state: "none", reason: null },
  ...(["window-canceled", "window-removed", "window-changed", "outreach-activity-kept"] as AttentionReason[]).flatMap((reason) => [{ state: "needed" as const, reason }, { state: "handled" as const, reason }]),
];
const windows: { status: WindowStatus; startMs: number; endMs: number }[] = [
  { status: "open", startMs: windowStart, endMs: windowEnd },
  { status: "open", startMs: windowStart + 2 * hour, endMs: windowEnd },
  { status: "canceled", startMs: windowStart, endMs: windowEnd },
  { status: "removed", startMs: windowStart, endMs: windowEnd },
];

test("window attention statements follow nextAttention for every window state and current attention", async () => {
  for (const window of windows) {
    const db = createTestDatabase();
    await insert(db, "visits_windows", windowRow({ start_ms: window.startMs, end_ms: window.endMs, status: window.status, cancel_reason: window.status === "canceled" ? "Closed" : "" }));
    await insert(db, "visits_teams", teamRow());
    const visit = { arrivalMs: windowStart, departureMs: windowStart + hour };
    for (const [index, attention] of attentions.entries()) {
      for (const status of ["booked", "canceled"] as const) {
        await insert(db, "visits_bookings", bookingRow({ id: `${status}-${index}`, status, arrival_ms: visit.arrivalMs, departure_ms: visit.departureMs, attention: attention.state, attention_reason: attention.reason }));
      }
    }
    await db.batch(windowAttentionStatements(db as never, ["window-1"], Date.parse("2026-10-28T15:00:00Z")) as never);
    const stored = new Map(db.rows<{ id: string; attention: Attention["state"]; attention_reason: AttentionReason | null }>("SELECT id, attention, attention_reason FROM visits_bookings").map((row) => [row.id, { state: row.attention, reason: row.attention_reason }]));
    for (const [index, attention] of attentions.entries()) {
      const bookable = { id: "window-1", ...window };
      const expected = nextAttention(attention, windowAttentionReason({ status: "booked", ...visit }, bookable));
      assert.deepEqual(stored.get(`booked-${index}`), expected, `${JSON.stringify(window)} ${JSON.stringify(attention)}`);
      // Canceled visits are left alone; their attention was settled when they were canceled.
      assert.deepEqual(stored.get(`canceled-${index}`), attention);
    }
  }
});
