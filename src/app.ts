import Fastify from "fastify";
import type { Config } from "./config.ts";
import { TokenCipher } from "./crypto.ts";
import { ensureOrganization, migrateToLatest, openDatabase, type DB } from "./db/index.ts";
import { loggerOptions } from "./logger.ts";
import { apiKeyGuard } from "./http/auth.ts";
import { defaultHttpDeps, type HttpDeps } from "./providers/http.ts";
import { PlanningCenterConnectionService } from "./services/planningCenterConnection.ts";
import { errorToResponse, planningCenterRoutes } from "./routes/planningCenter.ts";
import { PlanningCenterReadService } from "./services/planningCenterReads.ts";
import { planningCenterDataRoutes } from "./routes/planningCenterData.ts";

export interface AppOptions {
  config: Config;
  db?: DB;
  http?: HttpDeps;
  now?: () => number;
  logLevel?: string;
}

export async function buildApp(opts: AppOptions) {
  const { config } = opts;
  const db = opts.db ?? openDatabase(config.DATABASE_PATH);
  await migrateToLatest(db);
  const orgId = await ensureOrganization(db, config.DEFAULT_ORG_SLUG, config.DEFAULT_ORG_NAME);

  const cipher = new TokenCipher(config.TOKEN_ENCRYPTION_KEY_ID, config.TOKEN_ENCRYPTION_KEY, {
    id: config.TOKEN_ENCRYPTION_KEY_PREVIOUS_ID,
    keyB64: config.TOKEN_ENCRYPTION_KEY_PREVIOUS,
  });

  const pco = new PlanningCenterConnectionService(
    db,
    cipher,
    { clientId: config.PCO_CLIENT_ID, clientSecret: config.PCO_CLIENT_SECRET, redirectUri: config.PCO_REDIRECT_URI, userAgent: config.PCO_USER_AGENT },
    { expectedOrganizationId: config.PCO_EXPECTED_ORGANIZATION_ID || undefined, http: opts.http ?? defaultHttpDeps, now: opts.now },
  );

  const app = Fastify({
    logger: loggerOptions(opts.logLevel ?? (config.NODE_ENV === "test" ? "silent" : "info")),
    trustProxy: config.NODE_ENV === "production",
    bodyLimit: 64 * 1024,
  });

  app.setErrorHandler((err, req, reply) => {
    const { status, body } = errorToResponse(err);
    if (status >= 500) req.log.error({ errName: (err as Error).name, errMessage: (err as Error).message }, "request failed");
    if (body.retryAfterSeconds) reply.header("Retry-After", String(body.retryAfterSeconds));
    return reply.code(status).send(body);
  });

  app.get("/healthz", async () => ({ ok: true }));
  const guard = apiKeyGuard(config.INTERNAL_API_KEY, orgId);
  planningCenterRoutes(app, pco, guard);
  const reads = new PlanningCenterReadService(db, pco, { now: opts.now });
  planningCenterDataRoutes(app, reads, guard);

  app.addHook("onClose", async () => {
    await db.destroy();
  });
  return { app, db, pco, reads, orgId };
}
