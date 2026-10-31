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

export interface Database {
  organizations: OrganizationsTable;
  integration_connections: IntegrationConnectionsTable;
  oauth_states: OAuthStatesTable;
  audit_events: AuditEventsTable;
}
