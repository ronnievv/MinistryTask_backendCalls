import type { Generated } from "kysely";

export type Provider = "planning_center" | "clickup" | "google_calendar";

/**
 * connected      tokens valid (or refreshable)
 * needs_reauth   refresh failed / token revoked / scopes missing: a human must reconnect
 * disconnected   user disconnected; credentials wiped
 */
export type ConnectionStatus = "connected" | "needs_reauth" | "disconnected";

export interface OrganizationsTable {
  id: string;
  slug: string;
  name: string;
  created_at: string;
}

export interface IntegrationConnectionsTable {
  id: string;
  organization_id: string;
  provider: Provider;
  status: ConnectionStatus;
  /** Provider-side organization / workspace id (Planning Center organization_id). */
  external_account_id: string | null;
  external_account_name: string | null;
  /** Provider user the credentials act as. */
  external_user_id: string | null;
  external_user_name: string | null;
  granted_scopes: string; // space-separated
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  access_token_expires_at: string | null;
  refresh_token_issued_at: string | null;
  /** Incremented on each token write; used for compare-and-swap during refresh. */
  token_version: number;
  last_error_code: string | null;
  last_error_at: string | null;
  connected_by: string | null;
  connected_at: string | null;
  updated_at: string;
}

export interface OAuthStatesTable {
  /** sha256 of the state value; the raw state only ever exists in the redirect URL. */
  state_hash: string;
  organization_id: string;
  provider: Provider;
  code_verifier_enc: string;
  initiated_by: string;
  expires_at: string;
  created_at: string;
}

export interface AuditEventsTable {
  id: Generated<number>;
  organization_id: string;
  provider: Provider;
  actor: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  outcome: "success" | "failure";
  /** Never contains tokens or personal contact data. */
  detail: string | null;
  created_at: string;
}

/**
 * Computed Groups attendance for one person and window. Planning Center has no per-person
 * attendance endpoint, so building this costs one call per event: cache the result.
 * Holds attendance only, never contact data.
 */
export interface PcoGroupAttendanceCacheTable {
  organization_id: string;
  person_id: string;
  window_days: number;
  payload: string; // JSON
  fetched_at: string;
}

export type ChangeRequestStatus =
  | "pending" // previewed, waiting for approval
  | "applying" // approved, being written now
  | "applied" // every operation written
  | "partially_applied" // stopped at a failed operation; earlier ones were written
  | "failed" // the first operation failed; nothing was written
  | "rejected"
  | "stale" // the record changed in Planning Center after the preview; nothing was written
  | "expired";

/** A previewed edit to one Planning Center person, applied only after approval. */
export interface PcoChangeRequestsTable {
  id: string;
  organization_id: string;
  person_id: string;
  status: ChangeRequestStatus;
  /** Encrypted JSON: operations, preview and the record fingerprint. Contains contact data. */
  payload_enc: string;
  /** Encrypted JSON: per-operation results after approval. */
  result_enc: string | null;
  requested_by: string;
  requested_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  updated_at: string;
}

export interface Database {
  organizations: OrganizationsTable;
  integration_connections: IntegrationConnectionsTable;
  oauth_states: OAuthStatesTable;
  audit_events: AuditEventsTable;
  pco_group_attendance_cache: PcoGroupAttendanceCacheTable;
  pco_change_requests: PcoChangeRequestsTable;
}
