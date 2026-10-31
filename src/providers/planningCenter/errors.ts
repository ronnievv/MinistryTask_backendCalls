import { ProviderHttpError, ProviderNetworkError } from "../http.ts";

/**
 * Planning Center error hints, from https://api.planningcenteronline.com/docs/overview/errors
 * The docs list the hint names but not exactly where they appear in the body, so we
 * match them anywhere in the response text.
 */
const HINTS = {
  BABOON: "expired_token",
  CAPUCHIN: "revoked_token",
  PELICAN: "insufficient_scope",
  TRASH_PANDA: "no_app_access",
  CHINCHILLA: "invalid_client",
  FLAMINGO: "user_missing",
  LEMMING: "organization_missing",
} as const;

export type PcoErrorKind =
  | (typeof HINTS)[keyof typeof HINTS]
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation"
  | "conflict"
  | "rate_limited"
  | "unavailable"
  | "timeout"
  | "network"
  | "unknown";

export class PcoError extends Error {
  constructor(
    readonly kind: PcoErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "PcoError";
  }

  /** True when no retry will help and a person must reconnect Planning Center. */
  get requiresReauth(): boolean {
    return ["revoked_token", "insufficient_scope", "invalid_client", "user_missing", "organization_missing"].includes(this.kind);
  }
}

const MESSAGES: Record<PcoErrorKind, string> = {
  expired_token: "Planning Center access token expired.",
  revoked_token: "Planning Center access was revoked. An administrator needs to reconnect Planning Center.",
  insufficient_scope: "The Planning Center connection is missing a required permission. Reconnect and approve all requested access.",
  no_app_access: "The connected Planning Center user does not have access to this Planning Center product.",
  invalid_client: "The Planning Center OAuth application is invalid. Check PCO_CLIENT_ID / PCO_CLIENT_SECRET.",
  user_missing: "The connected Planning Center user no longer exists. Reconnect with another administrator.",
  organization_missing: "The connected Planning Center organization no longer exists.",
  unauthorized: "Planning Center rejected the credentials.",
  forbidden: "The connected Planning Center user lacks permission for this record.",
  not_found: "That Planning Center record was not found.",
  validation: "Planning Center rejected the submitted values.",
  conflict: "Planning Center reported a conflicting change. Refresh and try again.",
  rate_limited: "Planning Center rate limit reached. Try again shortly.",
  unavailable: "Planning Center is temporarily unavailable. Try again later.",
  timeout: "Planning Center did not respond in time.",
  network: "Could not reach Planning Center.",
  unknown: "Unexpected error from Planning Center.",
};

export function toPcoError(err: unknown): PcoError {
  if (err instanceof PcoError) return err;
  if (err instanceof ProviderNetworkError) {
    return new PcoError(err.timedOut ? "timeout" : "network", MESSAGES[err.timedOut ? "timeout" : "network"]);
  }
  if (err instanceof ProviderHttpError) {
    const hint = (Object.keys(HINTS) as (keyof typeof HINTS)[]).find((h) => err.bodyText.includes(h));
    let kind: PcoErrorKind;
    if (hint) kind = HINTS[hint];
    else if (err.status === 401) kind = "unauthorized";
    else if (err.status === 403) kind = "forbidden";
    else if (err.status === 404) kind = "not_found";
    else if (err.status === 409) kind = "conflict";
    else if (err.status === 422) kind = "validation";
    else if (err.status === 429) kind = "rate_limited";
    else if (err.status >= 500) kind = "unavailable";
    else kind = "unknown";
    return new PcoError(kind, MESSAGES[kind], err.status, err.retryAfterMs);
  }
  return new PcoError("unknown", MESSAGES.unknown);
}
