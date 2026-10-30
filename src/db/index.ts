import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { Migrator } from "kysely/migration";
import type { Database } from "./schema.ts";
import { migrationProvider } from "./migrations.ts";

export type DB = Kysely<Database>;

export function openDatabase(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new SQLite(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
}

export async function migrateToLatest(db: DB): Promise<void> {
  const { error, results } = await new Migrator({ db, provider: migrationProvider }).migrateToLatest();
  for (const r of results ?? []) {
    if (r.status === "Error") throw new Error(`Migration ${r.migrationName} failed`);
  }
  if (error) throw error;
}

export async function ensureOrganization(db: DB, slug: string, name: string): Promise<string> {
  const existing = await db.selectFrom("organizations").select("id").where("slug", "=", slug).executeTakeFirst();
  if (existing) return existing.id;
  const id = randomUUID();
  await db.insertInto("organizations").values({ id, slug, name, created_at: new Date().toISOString() }).execute();
  return id;
}
