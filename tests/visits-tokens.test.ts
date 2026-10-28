import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  base64Url, checkManageToken, generateManageToken, hashManageToken, isManageToken, issueManageToken, manageLink, manageTokenLength, sha256Hex,
} from "../src/shared/visits-tokens.ts";

const booking = { id: "booking-1", departureMs: Date.UTC(2026, 10, 3, 1) };

test("tokens are 32 random bytes in unpadded base64url", () => {
  const tokens = new Set(Array.from({ length: 200 }, () => generateManageToken()));
  assert.equal(tokens.size, 200);
  for (const token of tokens) {
    assert.equal(token.length, manageTokenLength);
    assert.ok(isManageToken(token), token);
    assert.equal(Buffer.from(token, "base64url").length, 32);
  }
  const fixed = generateManageToken((bytes) => bytes.fill(255));
  assert.equal(fixed, "_".repeat(42) + "8");
  assert.equal(base64Url(new Uint8Array([251, 255])), "-_8");
  let requested = 0;
  generateManageToken((bytes) => { requested = bytes.length; return bytes; });
  assert.equal(requested, 32);
});

test("only the token's SHA-256 is stored", async () => {
  const token = generateManageToken();
  const stored = await hashManageToken(token);
  assert.equal(stored, createHash("sha256").update(token).digest("hex"));
  assert.match(stored, /^[0-9a-f]{64}$/);
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  await assert.rejects(async () => hashManageToken("not a token"), RangeError);
  for (const value of ["", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}=`, `${"a".repeat(42)}+`, 42, null]) assert.ok(!isManageToken(value), String(value));
});

test("the manage link carries the token in the fragment of the dashboard origin", () => {
  const token = generateManageToken();
  assert.equal(manageLink("https://dashboard.example.org", token), `https://dashboard.example.org/visit/manage#${token}`);
  assert.equal(manageLink("https://dashboard.example.org/", token), `https://dashboard.example.org/visit/manage#${token}`);
  assert.equal(manageLink("http://localhost:5173", token), `http://localhost:5173/visit/manage#${token}`);
  for (const origin of ["dashboard.example.org", "javascript:alert(1)", "https://dashboard.example.org/app", "https://dashboard.example.org/?a=1", "https://user:pass@dashboard.example.org"]) {
    assert.throws(() => manageLink(origin, token), RangeError, origin);
  }
  assert.throws(() => manageLink("https://dashboard.example.org", "short"), RangeError);
});

test("a token works only for its own booking, until the visit ends, unless revoked", () => {
  const now = Date.UTC(2026, 9, 28);
  const record = issueManageToken({ bookingId: "booking-1", departureMs: booking.departureMs, now });
  assert.deepEqual(record, { bookingId: "booking-1", issuedMs: now, expiresMs: booking.departureMs, revokedMs: null });
  assert.deepEqual(checkManageToken(record, booking, now), { ok: true });
  assert.deepEqual(checkManageToken(record, booking, booking.departureMs - 1), { ok: true });
  assert.deepEqual(checkManageToken(record, booking, booking.departureMs), { ok: false, reason: "expired" });
  assert.deepEqual(checkManageToken(record, { ...booking, id: "booking-2" }, now), { ok: false, reason: "other-booking" });
  assert.deepEqual(checkManageToken({ ...record, revokedMs: now }, booking, now), { ok: false, reason: "revoked" });
  assert.deepEqual(checkManageToken(undefined, booking, now), { ok: false, reason: "unknown" });
  // Moving the visit later keeps every earlier link working until the new end.
  const later = { ...booking, departureMs: booking.departureMs + 7 * 86_400_000 };
  assert.deepEqual(checkManageToken(record, later, booking.departureMs + 1), { ok: true });
  // Two links sent for one booking both work.
  const second = issueManageToken({ bookingId: "booking-1", departureMs: booking.departureMs, now: now + 1000 });
  assert.ok(checkManageToken(record, booking, now + 2000).ok && checkManageToken(second, booking, now + 2000).ok);
});
