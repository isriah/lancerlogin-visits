// The Guest Visits report dataset, `visits.bookings`: one row per visit (removed visits are left out), filtered by the
// report period on the visit's local date. The manifest declares it and the Worker's projection fills these fields.
// Field IDs are part of saved reports, so they never change once released.

export const visitReportDatasetId = "visits.bookings";

/** Field IDs of the dataset. */
export const visitReportFields = {
  id: "visits.booking.id",
  date: "visits.booking.date",
  teamNumber: "visits.booking.team-number",
  teamName: "visits.booking.team-name",
  program: "visits.booking.program",
  arrival: "visits.booking.arrival",
  departure: "visits.booking.departure",
  duration: "visits.booking.duration",
  headcount: "visits.booking.headcount",
  status: "visits.booking.status",
  outreach: "visits.booking.outreach",
} as const;

// The filter operators Core allows for each value type (the SDK's `reportFilterOperators`), written out so the manifest
// stays free of imports.
const textOperators = ["contains", "equals", "empty", "not_empty"] as const;
const dateOperators = ["contains", "equals", "minimum", "maximum", "between", "empty", "not_empty"] as const;
const numberOperators = ["minimum", "equals", "maximum", "between", "empty", "not_empty"] as const;

const text = (id: string, label: string, group: string) => ({ id, label, group, kind: "dimension", valueType: "text", sortable: true, filterOperators: textOperators }) as const;

export const visitReportDataset = {
  id: visitReportDatasetId,
  label: "Guest visits",
  description: "Guest team visits with their date, times, team and headcount.",
  rowIdentity: visitReportFields.id,
  capability: "visits.manage",
  fields: [
    text(visitReportFields.id, "Visit record ID", "Visit"),
    { id: visitReportFields.date, label: "Visit date", group: "Visit", kind: "dimension", valueType: "date", sortable: true, filterOperators: dateOperators },
    text(visitReportFields.teamNumber, "Guest team number", "Guest team"),
    text(visitReportFields.teamName, "Guest team name", "Guest team"),
    text(visitReportFields.program, "Guest team program", "Guest team"),
    text(visitReportFields.arrival, "Arrival", "Visit"),
    text(visitReportFields.departure, "Departure", "Visit"),
    { id: visitReportFields.duration, label: "Visit length", group: "Visit", kind: "measure", valueType: "number", sortable: true, filterOperators: numberOperators, durationUnits: ["minutes", "hours"], defaultDurationUnit: "hours" },
    { id: visitReportFields.headcount, label: "Headcount", group: "Visit", kind: "measure", valueType: "number", sortable: true, filterOperators: numberOperators },
    text(visitReportFields.status, "Visit status", "Visit"),
    text(visitReportFields.outreach, "Recorded in Outreach", "Outreach"),
  ],
  filters: ["period"],
  groupBy: [visitReportFields.id, visitReportFields.date, visitReportFields.teamName, visitReportFields.program, visitReportFields.status],
  defaultColumns: [
    visitReportFields.date, visitReportFields.teamNumber, visitReportFields.teamName, visitReportFields.program, visitReportFields.arrival,
    visitReportFields.departure, visitReportFields.duration, visitReportFields.headcount, visitReportFields.status,
  ],
  defaultSort: { field: visitReportFields.date, direction: "desc" },
  relationships: [],
} as const;
