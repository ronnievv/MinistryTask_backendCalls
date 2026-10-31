import { describe, expect, it } from "vitest";
import { FakePco, auth, clock, connect, json, makeApp } from "./helpers.ts";
import { CHANGE_REQUEST_TTL_MS } from "../src/services/planningCenterChanges.ts";

const R = "/v1/planning-center";

/** A fake Planning Center person whose record changes when written to. */
function personFake() {
  const state = {
    person: { first_name: "Ana", last_name: "Diaz", nickname: null as string | null, name: "Ana Diaz", status: "active" },
    emails: [
      { id: "11", address: "ana@example.com", location: "Home", primary: true },
      { id: "12", address: "ana@work.example", location: "Work", primary: false },
    ],
    phones: [{ id: "21", number: "(555) 010-0000", e164: "+15550100000", location: "Mobile", primary: true }],
    nextId: 100,
  };
  const fake = new FakePco().withDefaults();
  fake.on("GET /people/v2/people/101", () =>
    json(200, {
      data: {
        type: "Person", id: "101", attributes: state.person,
        relationships: {
          emails: { data: state.emails.map((e) => ({ type: "Email", id: e.id })) },
          phone_numbers: { data: state.phones.map((p) => ({ type: "PhoneNumber", id: p.id })) },
          households: { data: [] },
        },
      },
      included: [
        ...state.emails.map(({ id, ...attributes }) => ({ type: "Email", id, attributes })),
        ...state.phones.map(({ id, ...attributes }) => ({ type: "PhoneNumber", id, attributes })),
      ],
    }),
  );
  fake.on("PATCH /people/v2/people/101", ({ body }) => {
    Object.assign(state.person, JSON.parse(body).data.attributes);
    return json(200, { data: { type: "Person", id: "101", attributes: state.person } });
  });
  fake.on("POST /people/v2/people/101/emails", ({ body }) => {
    const a = JSON.parse(body).data.attributes;
    const id = String(state.nextId++);
    if (a.primary) state.emails.forEach((e) => (e.primary = false));
    state.emails.push({ id, ...a });
    return json(201, { data: { type: "Email", id, attributes: a } });
  });
  const patchEmail = (id: string) => ({ body }: { body: string }) => {
    const a = JSON.parse(body).data.attributes;
    if (a.primary) state.emails.forEach((e) => (e.primary = false));
    Object.assign(state.emails.find((e) => e.id === id)!, a);
    return json(200, { data: { type: "Email", id, attributes: a } });
  };
  fake.on("PATCH /people/v2/emails/11", patchEmail("11"));
  fake.on("PATCH /people/v2/emails/12", patchEmail("12"));
  fake.on("POST /people/v2/people/101/phone_numbers", ({ body }) => {
    const a = JSON.parse(body).data.attributes;
    const id = String(state.nextId++);
    state.phones.push({ id, e164: null, ...a });
    return json(201, { data: { type: "PhoneNumber", id, attributes: a } });
  });
  return { fake, state };
}

async function setup() {
  const { fake, state } = personFake();
  const built = await makeApp(fake);
  await connect(built.app, fake);
  return { ...built, fake, state };
}

const writes = (fake: FakePco) => fake.calls.filter((c) => c.method !== "GET" && c.path.startsWith("/people/v2/"));

async function preview(app: Awaited<ReturnType<typeof setup>>["app"], operations: unknown[], headers: Record<string, string> = auth) {
  return app.inject({ method: "POST", url: `${R}/people/101/changes`, headers, payload: { operations } });
}

describe("change previews", () => {
  it("previews before/after values, writes nothing and stores the request encrypted", async () => {
    const { app, fake, db } = await setup();
    const res = await preview(app, [
      { op: "update_name", nickname: "Annie" },
      { op: "add_email", address: "Ana@New.example", location: "Other" },
      { op: "set_primary_email", emailId: "12" },
    ]);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("pending");
    expect(body.requestedBy).toBe("ronnie@cityhope.cc");
    expect(body.preview).toEqual([
      { index: 0, op: "update_name", field: "nickname", before: null, after: "Annie" },
      { index: 1, op: "add_email", field: "emails", before: null, after: { address: "ana@new.example", location: "Other", primary: false } },
      { index: 2, op: "set_primary_email", field: "primaryEmail", before: "ana@example.com", after: "ana@work.example" },
    ]);
    expect(writes(fake)).toHaveLength(0);

    const row = await db.selectFrom("pco_change_requests").selectAll().executeTakeFirstOrThrow();
    expect(row.payload_enc).toMatch(/^v1:k1:/);
    expect(row.payload_enc).not.toContain("ana@");
    const audits = await db.selectFrom("audit_events").selectAll().where("action", "like", "people.change%").execute();
    expect(audits.map((a) => a.action)).toEqual(["people.change.preview"]);
    expect(JSON.stringify(audits)).not.toContain("ana@");
  });

  it("requires X-Actor", async () => {
    const { app } = await setup();
    const res = await preview(app, [{ op: "update_name", nickname: "Annie" }], { "x-api-key": auth["x-api-key"] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("actor_required");
  });

  it.each([
    ["an email that belongs to someone else", [{ op: "set_primary_email", emailId: "999" }], "does not belong"],
    ["a duplicate email address", [{ op: "add_email", address: "ANA@example.com", location: "Home" }], "already has that email"],
    ["a name that would not change", [{ op: "update_name", firstName: "Ana" }], "already"],
    ["an email that is already primary", [{ op: "set_primary_email", emailId: "11" }], "already primary"],
    ["two operations on one target", [{ op: "set_primary_email", emailId: "12" }, { op: "add_email", address: "x@example.com", location: "Home", primary: true }], "same thing"],
    ["a duplicate phone number", [{ op: "add_phone", number: "555.010.0000", location: "Home" }], "already has that phone"],
  ])("rejects %s", async (_label, operations, message) => {
    const { app, fake } = await setup();
    const res = await preview(app, operations);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_operation");
    expect(res.json().message).toContain(message);
    expect(writes(fake)).toHaveLength(0);
  });

  it.each([
    [[]],
    [[{ op: "delete_email", emailId: "11" }]],
    [[{ op: "add_email", address: "not-an-email", location: "Home" }]],
    [[{ op: "add_phone", number: "12", location: "Mobile" }]],
    [[{ op: "add_email", address: "a@example.com", location: "Castle" }]],
    [[{ op: "update_name", firstName: "A", birthdate: "2000-01-01" }]],
  ])("rejects malformed operations %j without echoing values", async (operations) => {
    const { app } = await setup();
    const res = await preview(app, operations);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(res.json().message).not.toContain("not-an-email");
  });
});

describe("approving and rejecting", () => {
  it("applies operations in order and reports each one", async () => {
    const { app, fake, state } = await setup();
    const id = (
      await preview(app, [
        { op: "update_name", nickname: "Annie" },
        { op: "add_email", address: "ana@new.example", location: "Other" },
        { op: "set_primary_email", emailId: "12" },
        { op: "add_phone", number: "+1 555 010 9999", location: "Work" },
      ])
    ).json().id;

    const res = await app.inject({ method: "POST", url: `${R}/changes/${id}/approve`, headers: { ...auth, "x-actor": "pastor@cityhope.cc" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("applied");
    expect(body.decidedBy).toBe("pastor@cityhope.cc");
    expect(body.results).toEqual([
      { index: 0, op: "update_name", status: "applied" },
      { index: 1, op: "add_email", status: "applied", createdId: "100" },
      { index: 2, op: "set_primary_email", status: "applied" },
      { index: 3, op: "add_phone", status: "applied", createdId: "101" },
    ]);
    expect(writes(fake).map((c) => `${c.method} ${c.path}`)).toEqual([
      "PATCH /people/v2/people/101",
      "POST /people/v2/people/101/emails",
      "PATCH /people/v2/emails/12",
      "POST /people/v2/people/101/phone_numbers",
    ]);
    // Only the fields asked for are sent.
    expect(JSON.parse(writes(fake)[0]!.body)).toEqual({ data: { type: "Person", id: "101", attributes: { nickname: "Annie" } } });
    expect(writes(fake)[0]!.headers.get("content-type")).toBe("application/json");
    expect(state.person.nickname).toBe("Annie");
    expect(state.emails.find((e) => e.primary)!.id).toBe("12");

    const again = await app.inject({ method: "POST", url: `${R}/changes/${id}/approve`, headers: auth });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("not_pending");
    expect(writes(fake)).toHaveLength(4);
  });

  it("marks the request stale and writes nothing if the record changed after the preview", async () => {
    const { app, fake, state } = await setup();
    const id = (await preview(app, [{ op: "update_name", nickname: "Annie" }])).json().id;
    state.emails[0]!.address = "changed@example.com"; // someone edited Planning Center meanwhile
    const res = await app.inject({ method: "POST", url: `${R}/changes/${id}/approve`, headers: auth });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("stale");
    expect(writes(fake)).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: `${R}/changes/${id}`, headers: auth })).json().status).toBe("stale");
  });

  it("stops at the first failure, never retries it, and reports partial application", async () => {
    const { app, fake } = await setup();
    fake.on("POST /people/v2/people/101/emails", () => json(422, { errors: [{ title: "Address is invalid" }] }));
    const id = (
      await preview(app, [
        { op: "update_name", nickname: "Annie" },
        { op: "add_email", address: "ana@new.example", location: "Other" },
        { op: "set_primary_email", emailId: "12" },
      ])
    ).json().id;
    const res = await app.inject({ method: "POST", url: `${R}/changes/${id}/approve`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("partially_applied");
    expect(res.json().results.map((r: any) => [r.status, r.error?.code])).toEqual([
      ["applied", undefined],
      ["failed", "planning_center_validation"],
      ["not_attempted", undefined],
    ]);
    expect(fake.count("POST /people/v2/people/101/emails")).toBe(1);
    expect(fake.count("PATCH /people/v2/emails/12")).toBe(0);
  });

  it("does not retry a write that hit a server error", async () => {
    const { app, fake } = await setup();
    fake.on("PATCH /people/v2/people/101", () => json(503, { errors: [] }));
    const id = (await preview(app, [{ op: "update_name", nickname: "Annie" }])).json().id;
    const res = await app.inject({ method: "POST", url: `${R}/changes/${id}/approve`, headers: auth });
    expect(res.json().status).toBe("failed");
    expect(fake.count("PATCH /people/v2/people/101")).toBe(1);
  });

  it("marks the connection needs_reauth if access is revoked mid-apply, keeping the results", async () => {
    const { app, fake } = await setup();
    fake.on("PATCH /people/v2/people/101", () => json(401, { errors: [{ code: "CAPUCHIN" }] }));
    const id = (await preview(app, [{ op: "update_name", nickname: "Annie" }])).json().id;
    const res = await app.inject({ method: "POST", url: `${R}/changes/${id}/approve`, headers: auth });
    expect(res.statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/v1/integrations/planning-center/status", headers: auth })).json().status).toBe("needs_reauth");
    const view = (await app.inject({ method: "GET", url: `${R}/changes/${id}`, headers: auth })).json();
    expect(view.status).toBe("failed");
    expect(view.results[0].error.code).toBe("planning_center_revoked_token");
  });

  it("rejects without writing, and a rejected request can't be approved", async () => {
    const { app, fake } = await setup();
    const id = (await preview(app, [{ op: "update_name", nickname: "Annie" }])).json().id;
    const rej = await app.inject({ method: "POST", url: `${R}/changes/${id}/reject`, headers: auth });
    expect(rej.json()).toMatchObject({ status: "rejected", decidedBy: "ronnie@cityhope.cc" });
    expect((await app.inject({ method: "POST", url: `${R}/changes/${id}/approve`, headers: auth })).statusCode).toBe(409);
    expect(writes(fake)).toHaveLength(0);
  });

  it("expires pending requests after 24 hours", async () => {
    const { app, fake } = await setup();
    const id = (await preview(app, [{ op: "update_name", nickname: "Annie" }])).json().id;
    clock.now += CHANGE_REQUEST_TTL_MS + 1;
    expect((await app.inject({ method: "GET", url: `${R}/people/101/changes`, headers: auth })).json().changes[0].status).toBe("expired");
    expect((await app.inject({ method: "POST", url: `${R}/changes/${id}/approve`, headers: auth })).statusCode).toBe(409);
    expect(writes(fake)).toHaveLength(0);
  });

  it("returns 404 for unknown ids and 400 for malformed ones", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: `${R}/changes/00000000-0000-4000-8000-000000000000`, headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `${R}/changes/not-a-uuid`, headers: auth })).statusCode).toBe(400);
  });
});
