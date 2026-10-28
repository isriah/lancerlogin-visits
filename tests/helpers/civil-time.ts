// An Intl-based stand-in for the module SDK's civil-time helpers, so the src/shared rules run in `npm test` without a
// Core checkout. It implements the same contract as the SDK's `resolveCivilTime` and `instantToCivil` (every instant
// showing a local date and time, earliest first; the local reading of an instant), which is all the CivilTime adapter
// needs. `npm run plugins:dev` and `verify:core` exercise the real helpers.
import type { CivilTime, CivilTimeCandidate, CivilTimeFields, CivilTimeInput } from "../../src/shared/visits-time.ts";

const dayMs = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let result = formatters.get(timeZone);
  if (!result) {
    result = new Intl.DateTimeFormat("en-US", { timeZone, calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    formatters.set(timeZone, result);
  }
  return result;
}

/** The wall-clock reading of an instant, as if it were UTC. */
function wallClock(epochMs: number, timeZone: string): number {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(epochMs).map((part) => [part.type, Number(part.value)]));
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!, new Date(epochMs).getUTCMilliseconds());
}

function nominal(input: CivilTimeInput): number {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.date);
  const time = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(input.time);
  if (!date || !time) throw new RangeError(`Invalid local date or time: ${input.date} ${input.time}`);
  return Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]), Number(time[1]), Number(time[2]), Number(time[3] ?? 0));
}

export function instantToCivil(epochMilliseconds: number, timeZone: string): CivilTimeFields {
  const reading = wallClock(epochMilliseconds, timeZone);
  const iso = new Date(reading).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 23), offsetSeconds: (reading - epochMilliseconds) / 1000 };
}

export function resolveCivilTime(input: CivilTimeInput): CivilTimeCandidate[] {
  const local = nominal(input);
  // Any offset in force near the local time is one of the offsets a day either side (transitions are rarer than daily).
  const offsets = new Set([local - dayMs, local + dayMs].map((probe) => wallClock(probe, input.timeZone) - probe));
  return [...offsets].map((offset) => ({ epochMilliseconds: local - offset, offsetSeconds: offset / 1000 }))
    .filter((candidate) => wallClock(candidate.epochMilliseconds, input.timeZone) === local)
    .sort((left, right) => left.epochMilliseconds - right.epochMilliseconds);
}

export const civil: CivilTime = { resolveCivilTime, instantToCivil };

/** Epoch milliseconds of an ISO instant, for readable tests. */
export const at = (iso: string): number => {
  const value = Date.parse(iso);
  if (!Number.isFinite(value)) throw new RangeError(`Invalid instant ${iso}`);
  return value;
};

export const newYork = "America/New_York";
