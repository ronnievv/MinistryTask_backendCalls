import { describe, expect, it } from "vitest";
import { pkceChallenge } from "../src/crypto.ts";
import { FakePco, auth, clock, connect, json, makeApp } from "./helpers.ts";

const P = "/v1/integrations/planning-center";

async function connectionRow(db: Awaited<ReturnType<typeof makeApp>>["db"]) {
  return db.selectFrom("integration_connections").selectAll().executeTakeFirstOrThrow();
}

describe("API auth", () => {
  it("rejects missing or wrong API keys", async () => {
    const { app } = await makeApp(new FakePco().withDefaults());
    expect((await app.inject({ method: "GET", url: `${P}/status` })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `${P}/status`, headers: { "x-api-key": "wrong" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `${P}/status`, headers: auth })).json().status).toBe("not_connected");
  });
});

describe("connect flow", () => {
  it("builds an authorize URL with state, PKCE S256 and least-privilege scopes", async () => {
    const fake = new FakePco().withDefaults();
    const { app, config } = await makeApp(fake);
    const { authorizeUrl, callback } = await connect(app, fake);

    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe("https://api.planningcenteronline.com/oauth/authorize");
    expect(authorizeUrl.searchParams.get("scope")).toBe("openid people services groups");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(config.PCO_REDIRECT_URI);
    expect(authorizeUrl.searchParams.get("client_secret")).toBeNull();
    expect(callback.statusCode).toBe(200);
    expect(callback.body).toContain("Connected to City Hope Church");

    // The verifier sent at exchange time must hash to the challenge sent at authorize time.
    const exchange = new URLSearchParams(fake.calls.find((c) => c.path === "/oauth/token")!.body);
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(pkceChallenge(exchange.get("code_verifier")!)).toBe(authorizeUrl.searchParams.get("code_challenge"));
  });

  it("stores tokens encrypted and never returns them", async () => {
    const fake = new FakePco().withDefaults();
    const { app, db } = await makeApp(fake);
    await connect(app, fake);
    const row = await connectionRow(db);
    expect(row.access_token_enc).not.toContain("access-1");
    expect(row.refresh_token_enc).not.toContain("refresh-1");
    const status = await app.inject({ method: "GET", url: `${P}/status`, headers: auth });
    expect(status.json()).toMatchObject({ status: "connected", planningCenterOrganization: { id: "42" }, connectedAs: { id: "777" }, missingScopes: [] });
    expect(status.body).not.toMatch(/access-1|refresh-1/);
    const audits = await db.selectFrom("audit_events").select(["action", "detail"]).execute();
    expect(audits.map((a) => a.action)).toEqual(["connect.started", "connect.completed"]);
    expect(JSON.stringify(audits)).not.toMatch(/access-1|refresh-1/);
  });

  it("rejects a reused state", async () => {
    const fake = new FakePco().withDefaults();
    const { app } = await makeApp(fake);
    const { state } = await connect(app, fake);
    const again = await app.inject({ method: "GET", url: `${P}/callback?code=x&state=${state}` });
    expect(again.statusCode).toBe(400);
    expect(again.body).toContain("already used");
    expect(fake.count("POST /oauth/token")).toBe(1);
  });

  it("rejects unknown and expired states without calling Planning Center", async () => {
    const fake = new FakePco().withDefaults();
    const { app } = await makeApp(fake);
    expect((await app.inject({ method: "GET", url: `${P}/callback?code=x&state=forged` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `${P}/callback?code=x` })).statusCode).toBe(400);

    const res = await app.inject({ method: "POST", url: `${P}/connect`, headers: auth });
    const state = new URL(res.json().authorizeUrl).searchParams.get("state")!;
    clock.now += 11 * 60 * 1000;
    const late = await app.inject({ method: "GET", url: `${P}/callback?code=x&state=${state}` });
    expect(late.statusCode).toBe(400);
    expect(late.body).toContain("expired");
    expect(fake.count("POST /oauth/token")).toBe(0);
  });

  it("handles a denied authorization", async () => {
    const fake = new FakePco().withDefaults();
    const { app } = await makeApp(fake);
    const res = await app.inject({ method: "POST", url: `${P}/connect`, headers: auth });
    const state = new URL(res.json().authorizeUrl).searchParams.get("state")!;
    const cb = await app.inject({ method: "GET", url: `${P}/callback?error=access_denied&state=${state}` });
    expect(cb.statusCode).toBe(400);
    expect(fake.count("POST /oauth/token")).toBe(0);
  });

  it("rejects a different Planning Center organization and revokes the new grant", async () => {
    const fake = new FakePco().withDefaults({ orgId: "999" });
    const { app, db } = await makeApp(fake, { PCO_EXPECTED_ORGANIZATION_ID: "42" });
    const { callback } = await connect(app, fake);
    expect(callback.statusCode).toBe(403);
    expect(fake.count("POST /oauth/revoke")).toBe(1);
    expect(await db.selectFrom("integration_connections").selectAll().execute()).toHaveLength(0);
  });

  it("rejects a grant missing a required scope", async () => {
    const fake = new FakePco().withDefaults({ scope: "openid people" });
    const { app } = await makeApp(fake);
    const { callback } = await connect(app, fake);
    expect(callback.statusCode).toBe(400);
    expect(callback.body).toContain("services, groups");
    expect(fake.count("POST /oauth/revoke")).toBe(1);
  });
});

describe("token lifecycle", () => {
  it("refreshes an expired token before calling the API, with rotation", async () => {
    const fake = new FakePco().withDefaults();
    const { app, db } = await makeApp(fake);
    await connect(app, fake);
    clock.now += 2 * 60 * 60 * 1000; // past the 2h expiry
    const res = await app.inject({ method: "POST", url: `${P}/test-read`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ personId: "777", name: "Ronnie Admin" });
    const refresh = new URLSearchParams(fake.calls.filter((c) => c.path === "/oauth/token")[1]!.body);
    expect(refresh.get("grant_type")).toBe("refresh_token");
    expect(refresh.get("refresh_token")).toBe("refresh-1");
    expect(fake.calls.at(-1)!.headers.get("authorization")).toBe("Bearer access-2");
    expect((await connectionRow(db)).token_version).toBe(2);
  });

  it("concurrent callers share a single refresh", async () => {
    const fake = new FakePco().withDefaults();
    const { app, pco, orgId } = await makeApp(fake);
    await connect(app, fake);
    clock.now += 3 * 60 * 60 * 1000;
    const tokens = await Promise.all(Array.from({ length: 5 }, () => pco.getAccessToken(orgId)));
    expect(new Set(tokens)).toEqual(new Set(["access-2"]));
    expect(fake.count("POST /oauth/token")).toBe(2); // 1 exchange + 1 refresh
  });

  it("refreshes once and retries when the API says the token expired (BABOON)", async () => {
    const fake = new FakePco().withDefaults();
    fake.on("GET /people/v2/me", () => json(401, { errors: [{ code: "BABOON" }] }), () =>
      json(200, { data: { type: "Person", id: "777", attributes: { name: "Ronnie Admin" } } }),
    );
    const { app } = await makeApp(fake);
    await connect(app, fake);
    const res = await app.inject({ method: "POST", url: `${P}/test-read`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(fake.count("GET /people/v2/me")).toBe(2);
  });

  it("marks the connection needs_reauth when the refresh token is refused", async () => {
    const fake = new FakePco().withDefaults();
    const { app, db } = await makeApp(fake);
    await connect(app, fake);
    fake.on("POST /oauth/token", () => json(400, { error: "invalid_grant" }));
    clock.now += 3 * 60 * 60 * 1000;
    const res = await app.inject({ method: "POST", url: `${P}/test-read`, headers: auth });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("planning_center_revoked_token");
    const row = await connectionRow(db);
    expect(row.status).toBe("needs_reauth");
    expect(row.access_token_enc).toBeNull();
    expect(row.refresh_token_enc).toBeNull();
    const again = await app.inject({ method: "POST", url: `${P}/test-read`, headers: auth });
    expect(again.json().error).toBe("needs_reauth");
  });

  it("marks needs_reauth when Planning Center reports a revoked token (CAPUCHIN)", async () => {
    const fake = new FakePco().withDefaults();
    fake.on("GET /people/v2/me", () => json(401, { errors: [{ code: "CAPUCHIN" }] }));
    const { app, db } = await makeApp(fake);
    await connect(app, fake);
    const res = await app.inject({ method: "POST", url: `${P}/test-read`, headers: auth });
    expect(res.statusCode).toBe(409);
    expect((await connectionRow(db)).status).toBe("needs_reauth");
  });

  it("surfaces rate limits with Retry-After after bounded retries", async () => {
    const fake = new FakePco().withDefaults();
    fake.on("GET /people/v2/me", () => json(429, { errors: [{ code: "429" }] }, { "retry-after": "19" }));
    const sleeps: number[] = [];
    const { app } = await makeApp(fake, {}, sleeps);
    await connect(app, fake);
    const res = await app.inject({ method: "POST", url: `${P}/test-read`, headers: auth });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("19");
    expect(fake.count("GET /people/v2/me")).toBe(4);
    expect(sleeps.every((s) => s >= 19_000)).toBe(true);
  });
});

describe("disconnect", () => {
  it("revokes the refresh token at Planning Center and wipes credentials", async () => {
    const fake = new FakePco().withDefaults();
    const { app, db } = await makeApp(fake);
    await connect(app, fake);
    const res = await app.inject({ method: "POST", url: `${P}/disconnect`, headers: auth });
    expect(res.json()).toEqual({ revokedAtProvider: true });
    const revoke = new URLSearchParams(fake.calls.find((c) => c.path === "/oauth/revoke")!.body);
    expect(revoke.get("token")).toBe("refresh-1");
    expect(revoke.get("token_type_hint")).toBe("refresh_token");
    const row = await connectionRow(db);
    expect(row).toMatchObject({ status: "disconnected", access_token_enc: null, refresh_token_enc: null });
    expect((await app.inject({ method: "POST", url: `${P}/test-read`, headers: auth })).json().error).toBe("not_connected");
  });

  it("still wipes local credentials if Planning Center is unreachable", async () => {
    const fake = new FakePco().withDefaults();
    const { app, db } = await makeApp(fake);
    await connect(app, fake);
    fake.on("POST /oauth/revoke", () => json(503, {}));
    const res = await app.inject({ method: "POST", url: `${P}/disconnect`, headers: auth });
    expect(res.json()).toEqual({ revokedAtProvider: false });
    expect((await connectionRow(db)).refresh_token_enc).toBeNull();
  });

  it("can reconnect after disconnecting", async () => {
    const fake = new FakePco().withDefaults();
    const { app } = await makeApp(fake);
    await connect(app, fake);
    await app.inject({ method: "POST", url: `${P}/disconnect`, headers: auth });
    const { callback } = await connect(app, fake);
    expect(callback.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `${P}/status`, headers: auth })).json().status).toBe("connected");
  });
});
