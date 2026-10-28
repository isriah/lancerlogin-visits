// A small D1-shaped adapter over Node's built-in node:sqlite, in memory: prepare, bind, first, all, run and an atomic
// batch, the subset the Worker uses. It applies the plugin's migrations after minimal stand-ins for Core's
// `installations` and `users` tables, with foreign keys enforced as D1 enforces them.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

type Row = Record<string, unknown>;
export type D1Meta = { readonly changes: number; readonly last_row_id: number };
export type D1Result<T = Row> = { readonly success: true; readonly results: T[]; readonly meta: D1Meta };

const returning = /\bRETURNING\b/i;

function value(input: unknown): SQLInputValue {
  if (input === undefined) throw new TypeError("D1 does not bind undefined");
  if (typeof input === "boolean") return input ? 1 : 0;
  return input as SQLInputValue;
}

const plain = (row: Row): Row => ({ ...row });

export class TestStatement {
  readonly db: DatabaseSync;
  readonly sql: string;
  readonly values: readonly SQLInputValue[];
  constructor(db: DatabaseSync, sql: string, values: readonly SQLInputValue[] = []) { this.db = db; this.sql = sql; this.values = values; }
  bind(...values: unknown[]): TestStatement { return new TestStatement(this.db, this.sql, values.map(value)); }
  async first<T = Row>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.values) as Row | undefined;
    if (!row) return null;
    return (column === undefined ? plain(row) : row[column]) as T;
  }
  async all<T = Row>(): Promise<D1Result<T>> { return this.execute<T>(); }
  async run<T = Row>(): Promise<D1Result<T>> { return this.execute<T>(); }
  execute<T>(): D1Result<T> {
    const statement = this.db.prepare(this.sql);
    if (returning.test(this.sql) || /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(this.sql)) {
      const results = statement.all(...this.values).map((row) => plain(row as Row)) as T[];
      const changes = Number((this.db.prepare("SELECT changes() AS changes").get() as Row).changes);
      return { success: true, results, meta: { changes: /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(this.sql) ? 0 : changes, last_row_id: 0 } };
    }
    const outcome = statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(outcome.changes), last_row_id: Number(outcome.lastInsertRowid) } };
  }
}

export class TestDatabase {
  readonly sqlite: DatabaseSync;
  constructor(sqlite: DatabaseSync) { this.sqlite = sqlite; }
  prepare(sql: string): TestStatement { return new TestStatement(this.sqlite, sql); }
  /** Run statements in one transaction, as a D1 batch does: all of them apply, or none. */
  async batch<T = Row>(statements: readonly TestStatement[]): Promise<D1Result<T>[]> {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute<T>());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  exec(sql: string): void { this.sqlite.exec(sql); }
  /** Rows of a query, as plain objects. */
  rows<T = Row>(sql: string, ...values: unknown[]): T[] { return this.sqlite.prepare(sql).all(...values.map(value)).map((row) => plain(row as Row)) as T[]; }
  close(): void { this.sqlite.close(); }
}

const migrationsDirectory = new URL("../../migrations/", import.meta.url);

/** The plugin's migration files, in order. */
export function migrationFiles(): { readonly name: string; readonly sql: string }[] {
  return readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort().map((name) => ({ name, sql: readFileSync(new URL(name, migrationsDirectory), "utf8") }));
}

/**
 * A fresh in-memory database with Core stand-ins and every plugin migration applied, each in its own transaction as
 * Core applies one atomic batch per migration. Installation "primary" and user "user-1" exist.
 */
export function createTestDatabase(): TestDatabase {
  const sqlite = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  sqlite.exec(`
    CREATE TABLE installations (id TEXT PRIMARY KEY NOT NULL, created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z');
    CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE);
    INSERT INTO installations(id) VALUES ('primary');
    INSERT INTO users(id, installation_id) VALUES ('user-1', 'primary');
  `);
  for (const migration of migrationFiles()) {
    sqlite.exec("BEGIN");
    try { sqlite.exec(migration.sql); sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw new Error(`${migration.name} failed: ${(error as Error).message}`); }
  }
  return new TestDatabase(sqlite);
}
