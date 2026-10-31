import { randomUUID } from "node:crypto";
import type { DB } from "../db/index.ts";
import type { IntegrationConnectionsTable } from "../db/schema.ts";
import { pkceChallenge, randomUrlToken, sha256, type TokenCipher } from "../crypto.ts";
import { type HttpDeps, defaultHttpDeps } from "../providers/http.ts";
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserInfo,
  missingScopes,
  refreshTokens,
  revokeToken,
  type PcoOAuthConfig,
  type PcoTokenResponse,
} from "../providers/planningCenter/oauth.ts";
import { PcoError, toPcoError } from "../providers/planningCenter/errors.ts";
import { PcoClient } from "../providers/planningCenter/client.ts";
import type { PcoPersonAttributes } from "../providers/planningCenter/types.ts";
import { audit } from "./audit.ts";

const PROVIDER = "planning_center" as const;
const STATE_TTL_MS = 10 * 60 * 1000;
/** Refresh this long before expiry so in-flight requests don't race the deadline. */
const EXPIRY_SKEW_MS = 2 * 60 * 1000;
/** Planning Center honors refresh tokens for 90 days after issue. */
const REFRESH_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

export class ConnectionError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus = 400) {
    super(message);
    this.name = "ConnectionError";
  }
}

export interface ConnectionStatusView {
  provider: "planning_center";
  status: "not_connected" | IntegrationConnectionsTable["status"];
  planningCenterOrganization: { id: string | null; name: string | null } | null;
  connectedAs: { id: string | null; name: string | null } | null;
  grantedScopes: string[];
  missingScopes: string[];
  accessTokenExpiresAt: string | null;
  refreshTokenMustBeUsedBy: string | null;
  connectedAt: string | null;
  lastError: { code: string; at: string } | null;
}

export class PlanningCenterConnectionService {
  /** Per-connection in-process lock so concurrent requests share one refresh. */
  private readonly refreshInFlight = new Map<string, Promise<string>>();

  constructor(
    private readonly db: DB,
    private readonly cipher: TokenCipher,
    private readonly oauth: PcoOAuthConfig,
    private readonly opts: { expectedOrganizationId?: string; now?: () => number; http?: HttpDeps } = {},
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }
  private get http() {
    return this.opts.http ?? defaultHttpDeps;
  }

  // ---------- connect ----------

  async startConnect(organizationId: string, actor: string): Promise<{ authorizeUrl: string; expiresAt: string }> {
    const state = randomUrlToken(32);
    const verifier = randomUrlToken(48); // 64 chars, within RFC 7636's 43-128
    const stateHash = sha256(state);
    const expiresAt = new Date(this.now() + STATE_TTL_MS).toISOString();

    await this.db.deleteFrom("oauth_states").where("expires_at", "<", new Date(this.now()).toISOString()).execute();
    await this.db
      .insertInto("oauth_states")
      .values({
        state_hash: stateHash,
        organization_id: organizationId,
        provider: PROVIDER,
        code_verifier_enc: this.cipher.encrypt(verifier, `oauth_state:${stateHash}`),
        initiated_by: actor,
        expires_at: expiresAt,
        created_at: new Date(this.now()).toISOString(),
      })
      .execute();

    await audit(this.db, { organizationId, provider: PROVIDER, actor, action: "connect.started", outcome: "success" });
    return { authorizeUrl: buildAuthorizeUrl(this.oauth, state, pkceChallenge(verifier)), expiresAt };
  }

  /** Handles the browser redirect back from Planning Center. */
  async completeCallback(params: { state?: string; code?: string; error?: string }): Promise<{ organizationName: string | null }> {
    if (!params.state) throw new ConnectionError("invalid_state", "Missing state parameter.");
    const stateHash = sha256(params.state);

    // Atomically consume the state so it can never be used twice.
    const row = await this.db.deleteFrom("oauth_states").where("state_hash", "=", stateHash).returningAll().executeTakeFirst();
    if (!row || row.provider !== PROVIDER) {
      throw new ConnectionError("invalid_state", "This connection link is invalid or was already used. Start again.");
    }
    if (Date.parse(row.expires_at) < this.now()) {
      throw new ConnectionError("expired_state", "This connection link expired. Start again.");
    }
    const actor = row.initiated_by;
    const orgId = row.organization_id;

    if (params.error) {
      await audit(this.db, { organizationId: orgId, provider: PROVIDER, actor, action: "connect.denied", outcome: "failure", detail: { error: params.error.slice(0, 100) } });
      throw new ConnectionError("authorization_denied", "Planning Center authorization was cancelled or denied.");
    }
    if (!params.code) throw new ConnectionError("missing_code", "Planning Center did not return an authorization code.");

    const verifier = this.cipher.decrypt(row.code_verifier_enc, `oauth_state:${stateHash}`);

    let tokens: PcoTokenResponse;
    try {
      tokens = await exchangeCode(this.oauth, params.code, verifier, this.http);
    } catch (err) {
      const e = toPcoError(err);
      await audit(this.db, { organizationId: orgId, provider: PROVIDER, actor, action: "connect.token_exchange", outcome: "failure", detail: { kind: e.kind, status: e.status } });
      throw new ConnectionError("token_exchange_failed", "Planning Center would not complete the connection. Try again.", 502);
    }

    try {
      const missing = missingScopes(tokens.scope);
      if (missing.length) throw new ConnectionError("insufficient_scope", `Planning Center did not grant: ${missing.join(", ")}.`);

      const info = await fetchUserInfo(this.oauth, tokens.access_token, this.http);

      const existing = await this.findConnection(orgId);
      const lockedOrg = this.opts.expectedOrganizationId || (existing?.status !== "disconnected" ? existing?.external_account_id : null);
      if (lockedOrg && lockedOrg !== info.organization_id) {
        throw new ConnectionError(
          "wrong_organization",
          `That Planning Center account belongs to a different organization (${info.organization_name ?? info.organization_id}).`,
          403,
        );
      }

      const id = existing?.id ?? randomUUID();
      const nowIso = new Date(this.now()).toISOString();
      const values = {
        status: "connected" as const,
        external_account_id: info.organization_id,
        external_account_name: info.organization_name ?? null,
        external_user_id: info.sub,
        external_user_name: info.name ?? null,
        granted_scopes: tokens.scope ?? "",
        ...this.encryptTokens(id, tokens),
        token_version: (existing?.token_version ?? 0) + 1,
        last_error_code: null,
        last_error_at: null,
        connected_by: actor,
        connected_at: nowIso,
        updated_at: nowIso,
      };
      if (existing) await this.db.updateTable("integration_connections").set(values).where("id", "=", id).execute();
      else await this.db.insertInto("integration_connections").values({ id, organization_id: orgId, provider: PROVIDER, ...values }).execute();

      await audit(this.db, {
        organizationId: orgId,
        provider: PROVIDER,
        actor,
        action: "connect.completed",
        outcome: "success",
        targetType: "pco_organization",
        targetId: info.organization_id,
        detail: { pcoUserId: info.sub, scopes: tokens.scope ?? null },
      });
      return { organizationName: info.organization_name ?? null };
    } catch (err) {
      // Don't leave a live grant behind that we aren't going to store.
      await revokeToken(this.oauth, tokens.refresh_token, "refresh_token", this.http).catch(() => undefined);
      const code = err instanceof ConnectionError ? err.code : toPcoError(err).kind;
      await audit(this.db, { organizationId: orgId, provider: PROVIDER, actor, action: "connect.rejected", outcome: "failure", detail: { code } });
      if (err instanceof ConnectionError) throw err;
      throw new ConnectionError("connect_failed", "Could not verify the Planning Center account. Try again.", 502);
    }
  }

  // ---------- tokens ----------

  /** Returns a usable access token, refreshing (once, serialized) when needed. */
  async getAccessToken(organizationId: string, opts: { forceRefresh?: boolean } = {}): Promise<string> {
    const conn = await this.requireConnected(organizationId);
    const expiresAt = conn.access_token_expires_at ? Date.parse(conn.access_token_expires_at) : 0;
    if (!opts.forceRefresh && expiresAt - EXPIRY_SKEW_MS > this.now()) {
      return this.cipher.decrypt(conn.access_token_enc!, `${conn.id}:access_token`);
    }
    const pending = this.refreshInFlight.get(conn.id);
    if (pending) return pending;
    const p = this.refresh(conn).finally(() => this.refreshInFlight.delete(conn.id));
    this.refreshInFlight.set(conn.id, p);
    return p;
  }

  private async refresh(conn: IntegrationConnectionsTable): Promise<string> {
    const refreshToken = this.cipher.decrypt(conn.refresh_token_enc!, `${conn.id}:refresh_token`);
    let tokens: PcoTokenResponse;
    try {
      tokens = await refreshTokens(this.oauth, refreshToken, this.http);
    } catch (err) {
      const e = toPcoError(err);
      if (e.requiresReauth) {
        await this.markNeedsReauth(conn, e.kind);
        throw e;
      }
      await this.recordError(conn.id, e.kind);
      throw e;
    }
    // Compare-and-swap: if another process already rotated the tokens, use its result.
    const nowIso = new Date(this.now()).toISOString();
    const result = await this.db
      .updateTable("integration_connections")
      .set({ ...this.encryptTokens(conn.id, tokens), token_version: conn.token_version + 1, updated_at: nowIso, last_error_code: null, last_error_at: null })
      .where("id", "=", conn.id)
      .where("token_version", "=", conn.token_version)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) {
      const latest = await this.requireConnected(conn.organization_id);
      return this.cipher.decrypt(latest.access_token_enc!, `${latest.id}:access_token`);
    }
    return tokens.access_token;
  }

  private encryptTokens(connectionId: string, t: PcoTokenResponse) {
    const issuedMs = t.created_at ? t.created_at * 1000 : this.now();
    return {
      access_token_enc: this.cipher.encrypt(t.access_token, `${connectionId}:access_token`),
      refresh_token_enc: this.cipher.encrypt(t.refresh_token, `${connectionId}:refresh_token`),
      access_token_expires_at: new Date(issuedMs + t.expires_in * 1000).toISOString(),
      refresh_token_issued_at: new Date(issuedMs).toISOString(),
    };
  }

  // ---------- client / reads ----------

  clientFor(organizationId: string): PcoClient {
    return new PcoClient((o) => this.getAccessToken(organizationId, o), this.oauth.userAgent, this.http);
  }

  /**
   * Runs a read against Planning Center and audits it. A reauth-class failure marks the
   * connection needs_reauth so status reflects it. `target.id` must not be contact data.
   */
  async runRead<T>(
    organizationId: string,
    actor: string,
    action: string,
    target: { type: string; id?: string },
    fn: (client: PcoClient) => Promise<T>,
  ): Promise<T> {
    try {
      const result = await fn(this.clientFor(organizationId));
      await audit(this.db, { organizationId, provider: PROVIDER, actor, action, outcome: "success", targetType: target.type, targetId: target.id });
      return result;
    } catch (err) {
      const e = err instanceof ConnectionError ? err : toPcoError(err);
      if (e instanceof PcoError && e.requiresReauth) {
        const conn = await this.findConnection(organizationId);
        if (conn) await this.markNeedsReauth(conn, e.kind);
      }
      await audit(this.db, {
        organizationId, provider: PROVIDER, actor, action, outcome: "failure", targetType: target.type, targetId: target.id,
        detail: { code: e instanceof PcoError ? e.kind : e.code },
      });
      throw e;
    }
  }

  /** Minimal read-only check against one explicit resource: the connected user's own profile. */
  async testRead(organizationId: string, actor: string): Promise<{ personId: string; name: string | null }> {
    return this.runRead(organizationId, actor, "test_read", { type: "pco_person" }, async (client) => {
      const res = await client.getOne<PcoPersonAttributes>("/people/v2/me", { "fields[Person]": "first_name,last_name,nickname,name" });
      return { personId: res.data.id, name: res.data.attributes.name };
    });
  }

  // ---------- status / disconnect ----------

  async status(organizationId: string): Promise<ConnectionStatusView> {
    const c = await this.findConnection(organizationId);
    if (!c) {
      return {
        provider: PROVIDER, status: "not_connected", planningCenterOrganization: null, connectedAs: null,
        grantedScopes: [], missingScopes: [], accessTokenExpiresAt: null, refreshTokenMustBeUsedBy: null, connectedAt: null, lastError: null,
      };
    }
    const connected = c.status === "connected";
    return {
      provider: PROVIDER,
      status: c.status,
      planningCenterOrganization: { id: c.external_account_id, name: c.external_account_name },
      connectedAs: { id: c.external_user_id, name: c.external_user_name },
      grantedScopes: c.granted_scopes.split(/\s+/).filter(Boolean),
      missingScopes: connected ? missingScopes(c.granted_scopes || undefined) : [],
      accessTokenExpiresAt: connected ? c.access_token_expires_at : null,
      refreshTokenMustBeUsedBy:
        connected && c.refresh_token_issued_at ? new Date(Date.parse(c.refresh_token_issued_at) + REFRESH_TOKEN_LIFETIME_MS).toISOString() : null,
      connectedAt: c.connected_at,
      lastError: c.last_error_code && c.last_error_at ? { code: c.last_error_code, at: c.last_error_at } : null,
    };
  }

  /** Revokes at Planning Center, then wipes stored credentials regardless of the revoke result. */
  async disconnect(organizationId: string, actor: string): Promise<{ revokedAtProvider: boolean }> {
    const c = await this.findConnection(organizationId);
    if (!c || c.status === "disconnected") return { revokedAtProvider: true };

    let revoked = false;
    if (c.refresh_token_enc) {
      try {
        // Revoking the refresh token also invalidates its access token (per PCO docs).
        await revokeToken(this.oauth, this.cipher.decrypt(c.refresh_token_enc, `${c.id}:refresh_token`), "refresh_token", this.http);
        revoked = true;
      } catch {
        revoked = false;
      }
    }
    await this.db
      .updateTable("integration_connections")
      .set({
        status: "disconnected", access_token_enc: null, refresh_token_enc: null, access_token_expires_at: null,
        refresh_token_issued_at: null, token_version: c.token_version + 1, updated_at: new Date(this.now()).toISOString(),
      })
      .where("id", "=", c.id)
      .execute();
    // Data read through this connection goes with it.
    await this.db.deleteFrom("pco_group_attendance_cache").where("organization_id", "=", organizationId).execute();
    await audit(this.db, { organizationId, provider: PROVIDER, actor, action: "disconnect", outcome: "success", detail: { revokedAtProvider: revoked } });
    return { revokedAtProvider: revoked };
  }

  /** Throws the same 409 errors a read would when the connection can't be used. */
  async assertConnected(organizationId: string): Promise<void> {
    await this.requireConnected(organizationId);
  }

  // ---------- helpers ----------

  private findConnection(organizationId: string) {
    return this.db
      .selectFrom("integration_connections")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("provider", "=", PROVIDER)
      .executeTakeFirst();
  }

  private async requireConnected(organizationId: string): Promise<IntegrationConnectionsTable> {
    const c = await this.findConnection(organizationId);
    if (!c || c.status === "disconnected") throw new ConnectionError("not_connected", "Planning Center is not connected.", 409);
    if (c.status === "needs_reauth") throw new ConnectionError("needs_reauth", "Planning Center needs to be reconnected by an administrator.", 409);
    if (!c.access_token_enc || !c.refresh_token_enc) throw new ConnectionError("needs_reauth", "Stored credentials are missing. Reconnect Planning Center.", 409);
    return c;
  }

  private async markNeedsReauth(conn: IntegrationConnectionsTable, code: string) {
    const nowIso = new Date(this.now()).toISOString();
    await this.db
      .updateTable("integration_connections")
      .set({ status: "needs_reauth", access_token_enc: null, refresh_token_enc: null, last_error_code: code, last_error_at: nowIso, updated_at: nowIso, token_version: conn.token_version + 1 })
      .where("id", "=", conn.id)
      .execute();
    await audit(this.db, { organizationId: conn.organization_id, provider: PROVIDER, actor: "system", action: "connection.needs_reauth", outcome: "failure", detail: { code } });
  }

  private async recordError(id: string, code: string) {
    const nowIso = new Date(this.now()).toISOString();
    await this.db.updateTable("integration_connections").set({ last_error_code: code, last_error_at: nowIso }).where("id", "=", id).execute();
  }
}
