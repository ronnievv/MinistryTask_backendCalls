import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import pino from "pino";
import { TokenCipher, pkceChallenge } from "../src/crypto.ts";
import { backoffMs, parseRetryAfter, providerFetch, ProviderHttpError } from "../src/providers/http.ts";
import { PcoClient } from "../src/providers/planningCenter/client.ts";
import { toPcoError } from "../src/providers/planningCenter/errors.ts";
import { REDACT_PATHS, stripQuery } from "../src/logger.ts";
import { loadConfig } from "../src/config.ts";
import { FakePco, httpDeps, json } from "./helpers.ts";

const key = () => randomBytes(32).toString("base64");

describe("TokenCipher", () => {
  it("round-trips and never stores plaintext", () => {
    const c = new TokenCipher("k1", key());
    const enc = c.encrypt("secret-token", "conn1:access_token");
    expect(enc).not.toContain("secret-token");
    expect(c.decrypt(enc, "conn1:access_token")).toBe("secret-token");
  });

  it("rejects ciphertext moved to another row/column (AAD binding)", () => {
    const c = new TokenCipher("k1", key());
    const enc = c.encrypt("secret-token", "conn1:access_token");
    expect(() => c.decrypt(enc, "conn2:access_token")).toThrow();
    expect(() => c.decrypt(enc, "conn1:refresh_token")).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    const c = new TokenCipher("k1", key());
    const parts = c.encrypt("secret-token", "ctx").split(":");
    const ct = Buffer.from(parts[4]!, "base64url");
    ct[0]! ^= 1;
    parts[4] = ct.toString("base64url");
    expect(() => c.decrypt(parts.join(":"), "ctx")).toThrow();
  });

  it("decrypts with the previous key during rotation and flags it", () => {
    const oldKey = key();
    const enc = new TokenCipher("k1", oldKey).encrypt("t", "ctx");
    const rotated = new TokenCipher("k2", key(), { id: "k1", keyB64: oldKey });
    expect(rotated.decrypt(enc, "ctx")).toBe("t");
    expect(rotated.needsRotation(enc)).toBe(true);
    expect(() => new TokenCipher("k2", key()).decrypt(enc, "ctx")).toThrow(/No decryption key/);
  });

  it("computes RFC 7636 S256 challenge", () => {
    // Test vector from RFC 7636 appendix B
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("providerFetch", () => {
  it("honors Retry-After on 429 for GET, then succeeds", async () => {
    const sleeps: number[] = [];
    const fake = new FakePco().on("GET /x", () => json(429, {}, { "retry-after": "19" }), () => json(200, { ok: true }));
    const res = await providerFetch({ url: "https://api.planningcenteronline.com/x" }, httpDeps(fake, sleeps));
    expect(res.status).toBe(200);
    expect(sleeps[0]).toBeGreaterThanOrEqual(19_000);
    expect(sleeps[0]).toBeLessThan(19_300);
  });

  it("never retries a non-idempotent POST", async () => {
    const fake = new FakePco().on("POST /x", () => json(503, {}), () => json(200, {}));
    await expect(providerFetch({ url: "https://api.planningcenteronline.com/x", method: "POST" }, httpDeps(fake))).rejects.toBeInstanceOf(ProviderHttpError);
    expect(fake.count("POST /x")).toBe(1);
  });

  it("gives up when Retry-After exceeds the cap and reports it", async () => {
    const fake = new FakePco().on("GET /x", () => json(429, {}, { "retry-after": "3600" }));
    const err = await providerFetch({ url: "https://api.planningcenteronline.com/x" }, httpDeps(fake)).catch((e) => e);
    expect(fake.count("GET /x")).toBe(1);
    expect(toPcoError(err).kind).toBe("rate_limited");
    expect(toPcoError(err).retryAfterMs).toBe(3_600_000);
  });

  it("stops after max retries", async () => {
    const fake = new FakePco().on("GET /x", () => json(503, {}));
    await expect(providerFetch({ url: "https://api.planningcenteronline.com/x" }, httpDeps(fake))).rejects.toThrow(/503/);
    expect(fake.count("GET /x")).toBe(4); // 1 + maxRetries(3)
  });

  it("retries network failures on GET with backoff", async () => {
    let n = 0;
    const deps = { ...httpDeps(new FakePco()), fetch: (async () => { if (n++ === 0) throw new TypeError("fetch failed"); return json(200, {}); }) as typeof fetch };
    expect((await providerFetch({ url: "https://api.planningcenteronline.com/x" }, deps)).status).toBe(200);
  });

  it("parses Retry-After seconds and HTTP-date; backoff is capped", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10_000);
    expect(parseRetryAfter("nonsense")).toBeUndefined();
    expect(backoffMs(30, () => 0.999)).toBeLessThanOrEqual(20_000);
  });
});

describe("Planning Center error mapping", () => {
  const err = (status: number, body: string) => toPcoError(new ProviderHttpError("x", status, body));
  it("recognizes documented hints", () => {
    expect(err(401, '{"errors":[{"detail":"BABOON"}]}').kind).toBe("expired_token");
    expect(err(401, "CAPUCHIN").kind).toBe("revoked_token");
    expect(err(403, "PELICAN").kind).toBe("insufficient_scope");
    expect(err(401, "CAPUCHIN").requiresReauth).toBe(true);
    expect(err(401, "BABOON").requiresReauth).toBe(false);
  });
  it("falls back to status codes", () => {
    expect(err(404, "").kind).toBe("not_found");
    expect(err(422, "").kind).toBe("validation");
    expect(err(500, "").kind).toBe("unavailable");
  });
});

describe("PcoClient pagination", () => {
  it("follows links.next across pages with per_page=100", async () => {
    const base = "https://api.planningcenteronline.com/people/v2/people";
    const fake = new FakePco().on(
      "GET /people/v2/people",
      () => json(200, { data: [{ type: "Person", id: "1", attributes: {} }], links: { next: `${base}?offset=100&per_page=100` } }),
      () => json(200, { data: [{ type: "Person", id: "2", attributes: {} }], links: { next: `${base}?offset=200&per_page=100` } }),
      () => json(200, { data: [{ type: "Person", id: "3", attributes: {} }], links: {} }),
    );
    const client = new PcoClient(async () => "tok", "ua", httpDeps(fake));
    const all = await client.listAll("/people/v2/people");
    expect(all.map((p) => p.id)).toEqual(["1", "2", "3"]);
    expect(fake.calls[0]!.url.searchParams.get("per_page")).toBe("100");
    expect(fake.calls[0]!.headers.get("user-agent")).toBe("ua");
  });

  it("refuses to send credentials to a non-Planning Center host", async () => {
    const client = new PcoClient(async () => "tok", "ua", httpDeps(new FakePco()));
    await expect(client.get("https://evil.example.com/people")).rejects.toThrow(/another host/);
  });

  it("stops runaway pagination", async () => {
    const fake = new FakePco().on("GET /p", () => json(200, { data: [], links: { next: "https://api.planningcenteronline.com/p?offset=1" } }));
    const client = new PcoClient(async () => "tok", "ua", httpDeps(fake));
    await expect(client.listAll("/p", {}, 3)).rejects.toThrow(/Stopped after 3 pages/);
  });
});

describe("logging", () => {
  it("redacts tokens, secrets, contact data and strips query strings", () => {
    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } }, stream);
    log.info({ tokens: { access_token: "AAA", refresh_token: "RRR" }, person: { email: "a@b.c" }, oauth: { code: "CCC" } }, "x");
    const out = lines.join("");
    for (const s of ["AAA", "RRR", "a@b.c", "CCC"]) expect(out).not.toContain(s);
    expect(stripQuery("/cb?code=CCC&state=SSS")).toBe("/cb");
  });
});

describe("config", () => {
  it("rejects placeholders without echoing secret values", () => {
    expect(() =>
      loadConfig({ PUBLIC_BASE_URL: "http://localhost:3000", INTERNAL_API_KEY: "replace-with-a-long-random-value-xxxxxxxx", TOKEN_ENCRYPTION_KEY: "replace", PCO_CLIENT_ID: "replace-me", PCO_CLIENT_SECRET: "super-secret-value", PCO_USER_AGENT: "ua ua ua ua" }),
    ).toThrow(/INTERNAL_API_KEY[\s\S]*placeholder/);
    try {
      loadConfig({ PUBLIC_BASE_URL: "x", PCO_CLIENT_SECRET: "super-secret-value" });
    } catch (e) {
      expect(String(e)).not.toContain("super-secret-value");
    }
  });

  it("requires https in production", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "production", PUBLIC_BASE_URL: "http://example.com", INTERNAL_API_KEY: "x".repeat(40), TOKEN_ENCRYPTION_KEY: key(), PCO_CLIENT_ID: "a", PCO_CLIENT_SECRET: "b", PCO_USER_AGENT: "ua ua ua ua" }),
    ).toThrow(/https/);
  });
});
