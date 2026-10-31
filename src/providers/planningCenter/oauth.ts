import { z } from "zod";
import { providerFetch, type HttpDeps, defaultHttpDeps } from "../http.ts";
import { PcoError, toPcoError } from "./errors.ts";

/** Endpoints documented at https://api.planningcenteronline.com/docs/overview/authentication */
export const PCO_BASE = "https://api.planningcenteronline.com";
const AUTHORIZE_URL = `${PCO_BASE}/oauth/authorize`;
const TOKEN_URL = `${PCO_BASE}/oauth/token`;
const REVOKE_URL = `${PCO_BASE}/oauth/revoke`;
const USERINFO_URL = `${PCO_BASE}/oauth/userinfo`;

/** Least privilege for the approved operations. `openid` is only used to read who connected and which org. */
export const PCO_REQUIRED_SCOPES = ["people", "services", "groups"] as const;
export const PCO_REQUESTED_SCOPES = ["openid", ...PCO_REQUIRED_SCOPES];

export interface PcoOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  userAgent: string;
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1),
  scope: z.string().optional(),
  created_at: z.number().int().optional(),
});
export type PcoTokenResponse = z.infer<typeof tokenSchema>;

const userinfoSchema = z.object({
  sub: z.union([z.string(), z.number()]).transform(String),
  name: z.string().optional(),
  organization_id: z.union([z.string(), z.number()]).transform(String),
  organization_name: z.string().optional(),
});
export type PcoUserInfo = z.infer<typeof userinfoSchema>;

export function buildAuthorizeUrl(cfg: PcoOAuthConfig, state: string, codeChallenge: string): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", PCO_REQUESTED_SCOPES.join(" "));
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  // Lets the admin confirm which Planning Center account they are authorizing.
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

const formHeaders = (cfg: PcoOAuthConfig) => ({
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json",
  "User-Agent": cfg.userAgent,
});

/** Code exchange is single-use: never retried. */
export async function exchangeCode(cfg: PcoOAuthConfig, code: string, codeVerifier: string, deps: HttpDeps = defaultHttpDeps) {
  try {
    const res = await providerFetch(
      {
        url: TOKEN_URL,
        method: "POST",
        headers: formHeaders(cfg),
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          redirect_uri: cfg.redirectUri,
        }),
      },
      deps,
    );
    return tokenSchema.parse(await res.json());
  } catch (err) {
    throw toPcoError(err);
  }
}

/**
 * Refresh rotates the refresh token, so a replay could invalidate the new one: never retried here.
 * Callers serialize refreshes per connection.
 */
export async function refreshTokens(cfg: PcoOAuthConfig, refreshToken: string, deps: HttpDeps = defaultHttpDeps) {
  try {
    const res = await providerFetch(
      {
        url: TOKEN_URL,
        method: "POST",
        headers: formHeaders(cfg),
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
        }),
      },
      deps,
    );
    return tokenSchema.parse(await res.json());
  } catch (err) {
    const e = toPcoError(err);
    // OAuth servers answer an unusable refresh token with 400/401 (invalid_grant).
    if (e.status === 400 || e.status === 401) {
      throw new PcoError("revoked_token", "Planning Center refused the refresh token. An administrator needs to reconnect.", e.status);
    }
    throw e;
  }
}

/** Documented as returning 200 even for already-revoked tokens, so it is safe to retry. */
export async function revokeToken(
  cfg: PcoOAuthConfig,
  token: string,
  hint: "access_token" | "refresh_token",
  deps: HttpDeps = defaultHttpDeps,
): Promise<void> {
  try {
    await providerFetch(
      {
        url: REVOKE_URL,
        method: "POST",
        idempotent: true,
        headers: formHeaders(cfg),
        body: new URLSearchParams({ token, token_type_hint: hint, client_id: cfg.clientId, client_secret: cfg.clientSecret }),
      },
      deps,
    );
  } catch (err) {
    throw toPcoError(err);
  }
}

export async function fetchUserInfo(cfg: PcoOAuthConfig, accessToken: string, deps: HttpDeps = defaultHttpDeps) {
  try {
    const res = await providerFetch(
      { url: USERINFO_URL, headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "User-Agent": cfg.userAgent } },
      deps,
    );
    return userinfoSchema.parse(await res.json());
  } catch (err) {
    throw toPcoError(err);
  }
}

export function missingScopes(granted: string | undefined): string[] {
  // If the server omits `scope`, OAuth 2.0 says the granted scope equals the requested scope.
  if (granted === undefined) return [];
  const set = new Set(granted.split(/[\s,]+/).filter(Boolean));
  return PCO_REQUIRED_SCOPES.filter((s) => !set.has(s));
}
