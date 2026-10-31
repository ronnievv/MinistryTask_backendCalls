import type { Kysely } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";

/**
 * Migrations are kept in code (portable to Postgres later: only standard types used).
 * Later phases add: record_mappings, sync_checkpoints, jobs, webhook_events.
 */
const migrations: Record<string, Migration> = {
  "001_connections": {
    async up(db: Kysely<any>) {
      await db.schema
        .createTable("organizations")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("slug", "text", (c) => c.notNull().unique())
        .addColumn("name", "text", (c) => c.notNull())
        .addColumn("created_at", "text", (c) => c.notNull())
        .execute();

      await db.schema
        .createTable("integration_connections")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("organization_id", "text", (c) => c.notNull().references("organizations.id").onDelete("cascade"))
        .addColumn("provider", "text", (c) => c.notNull())
        .addColumn("status", "text", (c) => c.notNull())
        .addColumn("external_account_id", "text")
        .addColumn("external_account_name", "text")
        .addColumn("external_user_id", "text")
        .addColumn("external_user_name", "text")
        .addColumn("granted_scopes", "text", (c) => c.notNull().defaultTo(""))
        .addColumn("access_token_enc", "text")
        .addColumn("refresh_token_enc", "text")
        .addColumn("access_token_expires_at", "text")
        .addColumn("refresh_token_issued_at", "text")
        .addColumn("token_version", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("last_error_code", "text")
        .addColumn("last_error_at", "text")
        .addColumn("connected_by", "text")
        .addColumn("connected_at", "text")
        .addColumn("updated_at", "text", (c) => c.notNull())
        .addUniqueConstraint("uq_connection_org_provider", ["organization_id", "provider"])
        .execute();

      await db.schema
        .createTable("oauth_states")
        .addColumn("state_hash", "text", (c) => c.primaryKey())
        .addColumn("organization_id", "text", (c) => c.notNull().references("organizations.id").onDelete("cascade"))
        .addColumn("provider", "text", (c) => c.notNull())
        .addColumn("code_verifier_enc", "text", (c) => c.notNull())
        .addColumn("initiated_by", "text", (c) => c.notNull())
        .addColumn("expires_at", "text", (c) => c.notNull())
        .addColumn("created_at", "text", (c) => c.notNull())
        .execute();

      await db.schema
        .createTable("audit_events")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("organization_id", "text", (c) => c.notNull())
        .addColumn("provider", "text", (c) => c.notNull())
        .addColumn("actor", "text", (c) => c.notNull())
        .addColumn("action", "text", (c) => c.notNull())
        .addColumn("target_type", "text")
        .addColumn("target_id", "text")
        .addColumn("outcome", "text", (c) => c.notNull())
        .addColumn("detail", "text")
        .addColumn("created_at", "text", (c) => c.notNull())
        .execute();
      await db.schema.createIndex("ix_audit_org_created").on("audit_events").columns(["organization_id", "created_at"]).execute();
    },
    async down(db: Kysely<any>) {
      for (const t of ["audit_events", "oauth_states", "integration_connections", "organizations"]) {
        await db.schema.dropTable(t).ifExists().execute();
      }
    },
  },
  "002_group_attendance_cache": {
    async up(db: Kysely<any>) {
      await db.schema
        .createTable("pco_group_attendance_cache")
        .addColumn("organization_id", "text", (c) => c.notNull().references("organizations.id").onDelete("cascade"))
        .addColumn("person_id", "text", (c) => c.notNull())
        .addColumn("window_days", "integer", (c) => c.notNull())
        .addColumn("payload", "text", (c) => c.notNull())
        .addColumn("fetched_at", "text", (c) => c.notNull())
        .addPrimaryKeyConstraint("pk_pco_group_attendance_cache", ["organization_id", "person_id", "window_days"])
        .execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable("pco_group_attendance_cache").ifExists().execute();
    },
  },
};

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};
