// The `visits.bookings` report projection. Core resolves the report period to local dates, checks that the reader may use
// the dataset and passes the module-scoped database; the projection reads visits whose local date lies in the period and
// fills one cell per declared field. The SDK's row helpers arrive as an argument so this file runs in tests without Core.
import type { D1Database, ReportCell } from "@lancerlogin/module-sdk/api";
import { programLabels, teamLabel, type VisitProgram } from "../shared/visits-booking.ts";
import { visitReportFields as fields } from "../shared/visits-report-fields.ts";
import { addDays, localInstant, localMoment, minuteMs, type CivilTime } from "../shared/visits-time.ts";
import { installationId, rows } from "./visits-runtime.ts";

export type VisitReportRecord = {
  readonly id: string;
  readonly date: string;
  readonly arrival: string;
  readonly departure: string;
  readonly durationMinutes: number;
  readonly teamNumber: string;
  readonly teamName: string;
  readonly program: VisitProgram;
  readonly headcount: number;
  readonly status: "booked" | "canceled";
  readonly recordedInOutreach: boolean;
};

/** Visits (not removed) whose local date lies from `from` (or the beginning) through `to`, by arrival. */
export async function visitReportRecords(db: D1Database, civil: CivilTime, timeZone: string, period: { readonly from?: string; readonly to: string }): Promise<VisitReportRecord[]> {
  const fromMs = period.from ? localInstant(civil, timeZone, period.from, "00:00", "start") : null;
  const toMs = localInstant(civil, timeZone, addDays(period.to, 1), "00:00", "start");
  const result = await rows<{ id: string; arrival_ms: number; departure_ms: number; headcount: number; status: "booked" | "canceled"; outreach_activity_id: string | null; number: string; name: string; program: VisitProgram }>(
    db.prepare(`SELECT b.id,b.arrival_ms,b.departure_ms,b.headcount,b.status,b.outreach_activity_id,t.number,t.name,t.program FROM visits_bookings b
      JOIN visits_teams t ON t.installation_id=b.installation_id AND t.id=b.team_id
      WHERE b.installation_id=? AND b.removed=0 AND (? IS NULL OR b.arrival_ms>=?) AND b.arrival_ms<? ORDER BY b.arrival_ms,b.id`).bind(installationId, fromMs, fromMs, toMs));
  return result.map((row) => {
    const arrival = localMoment(civil, timeZone, row.arrival_ms);
    return {
      id: row.id, date: arrival.date, arrival: arrival.time, departure: localMoment(civil, timeZone, row.departure_ms).time,
      durationMinutes: Math.round((row.departure_ms - row.arrival_ms) / minuteMs), teamNumber: row.number, teamName: row.name, program: row.program,
      headcount: row.headcount, status: row.status, recordedInOutreach: row.outreach_activity_id !== null,
    };
  });
}

/** One cell per dataset field. Durations are minutes; Core shows them in hours when the column asks for hours. */
export function visitReportValues(record: VisitReportRecord): Record<string, ReportCell> {
  const status = record.status === "booked" ? "Booked" : "Canceled";
  return {
    [fields.id]: { text: record.id, sortValue: record.id },
    [fields.date]: { text: record.date, sortValue: record.date },
    [fields.teamNumber]: { text: record.teamNumber, sortValue: record.teamNumber.padStart(10, "0") },
    [fields.teamName]: { text: record.teamName, sortValue: record.teamName.toLocaleLowerCase() },
    [fields.program]: { text: programLabels[record.program], sortValue: programLabels[record.program].toLocaleLowerCase() },
    [fields.arrival]: { text: record.arrival, sortValue: `${record.date} ${record.arrival}` },
    [fields.departure]: { text: record.departure, sortValue: `${record.date} ${record.departure}` },
    [fields.duration]: { text: String(record.durationMinutes), sortValue: record.durationMinutes },
    [fields.headcount]: { text: String(record.headcount), sortValue: record.headcount },
    [fields.status]: { text: status, sortValue: status.toLocaleLowerCase() },
    [fields.outreach]: { text: record.recordedInOutreach ? "Yes" : "No", sortValue: record.recordedInOutreach ? 1 : 0 },
  };
}

/** "FRC 321 Lancers on 2026-11-02". */
export function visitReportLabel(record: VisitReportRecord): string {
  return `${teamLabel({ number: record.teamNumber, name: record.teamName, program: record.program })} on ${record.date}`;
}
