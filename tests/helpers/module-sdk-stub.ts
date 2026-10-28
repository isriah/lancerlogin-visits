// The parts of @lancerlogin/module-sdk and @lancerlogin/module-sdk/api that src/api.ts uses at run time. Core provides the
// real SDK in a composed build; tests/visits-api-wiring.test.ts maps both specifiers here so the Worker contribution loads
// without a Core checkout.
import { instantToCivil, resolveCivilTime } from "./civil-time.ts";

export { instantToCivil, resolveCivilTime };

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function defineApiModule<T>(contribution: T): T { return contribution; }

type Statement = { bind(...values: unknown[]): Statement; first<T>(): Promise<T | null> };
export async function installationTimeZone(db: { prepare(sql: string): Statement }, installationId: string): Promise<string> {
  const row = await db.prepare("SELECT time_zone AS timeZone FROM organization_settings WHERE installation_id=?").bind(installationId).first<{ timeZone: string }>();
  if (!row?.timeZone) throw new HttpError(409, "The installation time zone is not configured");
  return row.timeZone;
}

type Cell = { text: string; sortValue: string | number | null };
type Definition = { columns: { key: string }[]; sort: { column: { key: string }; direction: "asc" | "desc" } };
export function reportRow(definition: Definition, id: string, label: string, values: Record<string, Cell>, href?: string) {
  return { id, label, href, cells: Object.fromEntries(definition.columns.map((column) => [column.key, values[column.key] ?? { text: "N/A", sortValue: null }])) };
}

export function filterAndSortReportRows(definition: Definition, rows: { cells: Record<string, Cell> }[]) {
  const key = definition.sort.column.key;
  const order = definition.sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => String(left.cells[key]?.sortValue).localeCompare(String(right.cells[key]?.sortValue)) * order);
}
