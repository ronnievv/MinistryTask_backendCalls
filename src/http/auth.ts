import type { FastifyReply, FastifyRequest } from "fastify";
import { safeEqual } from "../crypto.ts";

export interface CallerContext {
  organizationId: string;
  actor: string;
}

declare module "fastify" {
  interface FastifyRequest {
    caller?: CallerContext;
  }
}

/**
 * Service-to-service auth for the ministrytask backend.
 * The organization comes from the credential, never from request input, so one
 * tenant can't address another tenant's connection.
 *
 * Single-tenant phase: one key maps to the default organization. When multiple
 * churches are added, replace with per-organization keys or signed user tokens.
 */
export function apiKeyGuard(apiKey: string, organizationId: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const presented = req.headers["x-api-key"];
    if (typeof presented !== "string" || !safeEqual(presented, apiKey)) {
      return reply.code(401).send({ error: "unauthorized", message: "Missing or invalid X-Api-Key." });
    }
    // Optional label for audit logs (who in ministrytask asked). Trusted only after the key check.
    const rawActor = req.headers["x-actor"];
    const actor = typeof rawActor === "string" && /^[\w.@+-]{1,100}$/.test(rawActor) ? rawActor : "api-key";
    req.caller = { organizationId, actor };
  };
}
