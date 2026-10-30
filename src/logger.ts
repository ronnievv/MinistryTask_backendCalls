import type { FastifyServerOptions } from "fastify";

/**
 * Paths pino will censor wherever they appear in a log object.
 * Tokens, secrets, codes and personal contact data must never reach logs.
 */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  "*.access_token",
  "*.refresh_token",
  "*.id_token",
  "*.client_secret",
  "*.code",
  "*.code_verifier",
  "*.token",
  "*.authorization",
  "*.email",
  "*.phone",
  "*.address",
];

/** Strip query strings from logged URLs: the OAuth callback carries `code` and `state` there. */
export function stripQuery(url: string | undefined): string | undefined {
  return url?.split("?")[0];
}

export function loggerOptions(level: string): FastifyServerOptions["logger"] {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    serializers: {
      req(req) {
        return { method: req.method, url: stripQuery(req.url), reqId: req.id };
      },
    },
  };
}
