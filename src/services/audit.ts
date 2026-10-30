import type { DB } from "../db/index.ts";
import type { Provider } from "../db/schema.ts";

export interface AuditInput {
  organizationId: string;
  provider: Provider;
  actor: string;
  action: string;
  outcome: "success" | "failure";
  targetType?: string;
  targetId?: string;
  /** Must not include tokens or personal contact data. */
  detail?: Record<string, unknown>;
}

export async function audit(db: DB, e: AuditInput): Promise<void> {
  await db
    .insertInto("audit_events")
    .values({
      organization_id: e.organizationId,
      provider: e.provider,
      actor: e.actor,
      action: e.action,
      outcome: e.outcome,
      target_type: e.targetType ?? null,
      target_id: e.targetId ?? null,
      detail: e.detail ? JSON.stringify(e.detail) : null,
      created_at: new Date().toISOString(),
    })
    .execute();
}
