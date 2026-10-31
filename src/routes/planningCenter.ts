import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { ConnectionError, type PlanningCenterConnectionService } from "../services/planningCenterConnection.ts";
import { PcoError } from "../providers/planningCenter/errors.ts";

const callbackQuery = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(512).optional(),
  error: z.string().max(200).optional(),
});

export function planningCenterRoutes(
  app: FastifyInstance,
  svc: PlanningCenterConnectionService,
  guard: (req: any, reply: any) => Promise<unknown>,
) {
  const prefix = "/v1/integrations/planning-center";

  /** Returns the Planning Center authorize URL. Open it in a browser as a PCO administrator. */
  app.post(`${prefix}/connect`, { preHandler: guard }, async (req) => {
    return svc.startConnect(req.caller!.organizationId, req.caller!.actor);
  });

  /** Browser redirect target registered in Planning Center. Authenticated by single-use state + PKCE. */
  app.get(`${prefix}/callback`, async (req, reply) => {
    const q = callbackQuery.safeParse(req.query);
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    if (!q.success) return page(reply, 400, "Connection failed", "The callback request was malformed.");
    try {
      const r = await svc.completeCallback(q.data);
      return page(reply, 200, "Planning Center connected", `Connected${r.organizationName ? ` to ${r.organizationName}` : ""}. You can close this window.`);
    } catch (err) {
      if (err instanceof ConnectionError) return page(reply, err.httpStatus, "Connection failed", err.message);
      req.log.error({ err: { name: (err as Error).name } }, "planning center callback failed");
      return page(reply, 500, "Connection failed", "Unexpected error. Check the service logs.");
    }
  });

  app.get(`${prefix}/status`, { preHandler: guard }, async (req) => svc.status(req.caller!.organizationId));

  app.post(`${prefix}/test-read`, { preHandler: guard }, async (req) => svc.testRead(req.caller!.organizationId, req.caller!.actor));

  app.post(`${prefix}/disconnect`, { preHandler: guard }, async (req) => svc.disconnect(req.caller!.organizationId, req.caller!.actor));
}

/** Maps domain errors to safe JSON responses (no provider bodies, no tokens). */
export function errorToResponse(err: unknown): { status: number; body: { error: string; message: string; retryAfterSeconds?: number } } {
  if (err instanceof ConnectionError) return { status: err.httpStatus, body: { error: err.code, message: err.message } };
  if (err instanceof PcoError) {
    const status =
      err.requiresReauth ? 409 : err.kind === "rate_limited" ? 429 : err.kind === "not_found" ? 404 : err.kind === "forbidden" || err.kind === "no_app_access" ? 403 : 502;
    return {
      status,
      body: {
        error: `planning_center_${err.kind}`,
        message: err.message,
        ...(err.retryAfterMs !== undefined ? { retryAfterSeconds: Math.ceil(err.retryAfterMs / 1000) } : {}),
      },
    };
  }
  return { status: 500, body: { error: "internal_error", message: "Unexpected error." } };
}

function page(reply: FastifyReply, status: number, title: string, message: string) {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return reply
    .code(status)
    .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
    .type("text/html; charset=utf-8")
    .send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title>` +
        `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${esc(title)}</h1><p>${esc(message)}</p></body>`,
    );
}
