import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/config.ts";
import { buildApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";
import type { HttpDeps } from "../src/providers/http.ts";

export const API_KEY = "test-api-key-0123456789-abcdefghijklmnop";

export function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    PUBLIC_BASE_URL: "http://localhost:3000",
    DATABASE_PATH: ":memory:",
    INTERNAL_API_KEY: API_KEY,
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    PCO_CLIENT_ID: "client-id-123",
    PCO_CLIENT_SECRET: "client-secret-456",
    PCO_USER_AGENT: "ministrytask tests (test@example.com)",
    ...overrides,
  });
}

type Handler = (req: { url: URL; method: string; headers: Headers; body: string }) => Response | Promise<Response>;

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * Fake Planning Center. Routes are "METHOD /path"; each can be a handler or a queue of
 * handlers consumed in order (last one repeats). Every request is recorded.
 */
export class FakePco {
  calls: { method: string; path: string; url: URL; headers: Headers; body: string }[] = [];
  private routes = new Map<string, Handler[]>();
  issued = 0;

  on(route: string, ...handlers: Handler[]) {
    this.routes.set(route, handlers);
    return this;
  }

  count(route: string) {
    return this.calls.filter((c) => `${c.method} ${c.path}` === route).length;
  }

  /** Default happy-path behaviour. */
  withDefaults(opts: { orgId?: string; scope?: string } = {}) {
    this.on("POST /oauth/token", () => this.tokenResponse(opts.scope ?? "openid people services groups"));
    this.on("GET /oauth/userinfo", () =>
      json(200, { sub: "777", name: "Ronnie Admin", organization_id: opts.orgId ?? 42, organization_name: "City Hope Church" }),
    );
    this.on("POST /oauth/revoke", () => json(200, {}));
    this.on("GET /people/v2/me", () => json(200, { data: { type: "Person", id: "777", attributes: { name: "Ronnie Admin", first_name: "Ronnie", last_name: "Admin", nickname: null } } }));
    return this;
  }

  tokenResponse(scope = "openid people services groups", expiresIn = 7200) {
    this.issued++;
    return json(200, {
      access_token: `access-${this.issued}`,
      token_type: "bearer",
      expires_in: expiresIn,
      refresh_token: `refresh-${this.issued}`,
      scope,
      created_at: Math.floor(clock.now / 1000),
    });
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = init?.body == null ? "" : String(init.body);
    this.calls.push({ method, path: url.pathname, url, headers, body });
    const handlers = this.routes.get(`${method} ${url.pathname}`);
    if (!handlers?.length) return json(404, { errors: [{ code: "404", detail: `no fake route ${method} ${url.pathname}` }] });
    const h = handlers.length > 1 ? handlers.shift()! : handlers[0]!;
    return h({ url, method, headers, body });
  };
}

/** Controllable clock shared by fakes and the app. */
export const clock = { now: Date.parse("2026-11-01T12:00:00Z") };

export function httpDeps(fake: FakePco, sleeps: number[] = []): HttpDeps {
  return {
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    maxRetries: 3,
    maxRetryAfterMs: 60_000,
  };
}

export async function makeApp(fake: FakePco, configOverrides: Record<string, string> = {}, sleeps: number[] = []) {
  clock.now = Date.parse("2026-11-01T12:00:00Z");
  const config = testConfig(configOverrides);
  const db = openDatabase(":memory:");
  const built = await buildApp({ config, db, http: httpDeps(fake, sleeps), now: () => clock.now });
  return { ...built, config };
}

export const auth = { "x-api-key": API_KEY, "x-actor": "ronnie@cityhope.cc" };

/** Runs connect + callback and returns the state used. */
export async function connect(app: Awaited<ReturnType<typeof makeApp>>["app"], fake: FakePco) {
  const res = await app.inject({ method: "POST", url: "/v1/integrations/planning-center/connect", headers: auth });
  const authorizeUrl = new URL(res.json().authorizeUrl);
  const state = authorizeUrl.searchParams.get("state")!;
  const cb = await app.inject({ method: "GET", url: `/v1/integrations/planning-center/callback?code=auth-code-1&state=${encodeURIComponent(state)}` });
  return { authorizeUrl, state, callback: cb };
}
