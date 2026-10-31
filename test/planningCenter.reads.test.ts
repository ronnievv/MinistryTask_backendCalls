import { describe, expect, it } from "vitest";
import { FakePco, auth, clock, connect, json, makeApp } from "./helpers.ts";
import { ATTENDANCE_CACHE_TTL_MS } from "../src/services/planningCenterReads.ts";

const R = "/v1/planning-center";

async function connected(fake = new FakePco().withDefaults()) {
  const built = await makeApp(fake);
  await connect(built.app, fake);
  return { ...built, fake };
}

describe("people profile", () => {
  it("returns approved fields only, with emails, phones and household members", async () => {
    const fake = new FakePco().withDefaults();
    fake.on("GET /people/v2/people/101", () =>
      json(200, {
        data: {
          type: "Person", id: "101",
          attributes: { first_name: "Ana", last_name: "Diaz", nickname: "Annie", name: "Annie Diaz", status: "active" },
          relationships: {
            emails: { data: [{ type: "Email", id: "e1" }, { type: "Email", id: "e2" }] },
            phone_numbers: { data: [{ type: "PhoneNumber", id: "p1" }] },
            households: { data: [{ type: "Household", id: "h1" }] },
          },
        },
        included: [
          { type: "Email", id: "e1", attributes: { address: "ana@example.com", location: "Home", primary: true } },
          { type: "Email", id: "e2", attributes: { address: "ana@work.example", location: "Work", primary: false } },
          { type: "PhoneNumber", id: "p1", attributes: { number: "(555) 010-0000", e164: "+15550100000", location: "Mobile", primary: true } },
          { type: "Household", id: "h1", attributes: { name: "Diaz Household", member_count: 2, primary_contact_id: "101" } },
        ],
      }),
    );
    fake.on("GET /people/v2/households/h1", () =>
      json(200, {
        data: { type: "Household", id: "h1", attributes: { name: "Diaz Household" }, relationships: { people: { data: [{ type: "Person", id: "101" }, { type: "Person", id: "102" }] } } },
        included: [
          { type: "Person", id: "101", attributes: { name: "Annie Diaz" } },
          { type: "Person", id: "102", attributes: { name: "Leo Diaz" } },
        ],
      }),
    );
    const { app } = await connected(fake);

    const res = await app.inject({ method: "GET", url: `${R}/people/101`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: "101", firstName: "Ana", lastName: "Diaz", nickname: "Annie", name: "Annie Diaz", status: "active",
      emails: [
        { id: "e1", address: "ana@example.com", location: "Home", primary: true },
        { id: "e2", address: "ana@work.example", location: "Work", primary: false },
      ],
      phoneNumbers: [{ id: "p1", number: "(555) 010-0000", e164: "+15550100000", location: "Mobile", primary: true }],
      households: [{ id: "h1", name: "Diaz Household", primaryContactId: "101", members: [{ id: "101", name: "Annie Diaz" }, { id: "102", name: "Leo Diaz" }] }],
    });

    // Sparse fieldsets: sensitive Person attributes are never requested.
    const q = fake.calls.find((c) => c.path === "/people/v2/people/101")!.url.searchParams;
    expect(q.get("fields[Person]")).toBe("first_name,last_name,nickname,name,status,emails,phone_numbers,households");
    expect(q.get("include")).toBe("emails,phone_numbers,households");
  });

  it("rejects non-numeric ids without calling Planning Center", async () => {
    const { app, fake } = await connected();
    const before = fake.calls.length;
    for (const id of ["abc", "1%2F..%2Fme", "12345678901234567890123"]) {
      const res = await app.inject({ method: "GET", url: `${R}/people/${id}`, headers: auth });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_request");
    }
    expect(fake.calls.length).toBe(before);
  });

  it("requires the API key", async () => {
    const { app } = await connected();
    expect((await app.inject({ method: "GET", url: `${R}/people/101` })).statusCode).toBe(401);
  });

  it("audits reads by id only and marks needs_reauth when access is revoked", async () => {
    const fake = new FakePco().withDefaults();
    fake.on("GET /people/v2/people/101", () => json(401, { errors: [{ code: "CAPUCHIN" }] }));
    const { app, db } = await connected(fake);
    const res = await app.inject({ method: "GET", url: `${R}/people/101`, headers: auth });
    expect(res.statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/v1/integrations/planning-center/status", headers: auth })).json().status).toBe("needs_reauth");
    const row = await db.selectFrom("audit_events").selectAll().where("action", "=", "people.read").executeTakeFirstOrThrow();
    expect(row).toMatchObject({ outcome: "failure", target_type: "pco_person", target_id: "101", actor: "ronnie@cityhope.cc" });
  });
});

describe("services", () => {
  it("maps a person's schedule, including declined assignments", async () => {
    const fake = new FakePco().withDefaults();
    fake.on("GET /services/v2/people/101/schedules", () =>
      json(200, {
        data: [
          {
            type: "Schedule", id: "s1",
            attributes: { sort_date: "2026-11-08T15:00:00Z", dates: "November 8, 2026", status: "C", decline_reason: null, service_type_name: "Sunday", team_name: "Band", team_position_name: "Bass" },
            relationships: { plan: { data: { type: "Plan", id: "p1" } }, service_type: { data: { type: "ServiceType", id: "st1" } }, team: { data: { type: "Team", id: "t1" } } },
          },
          { type: "Schedule", id: "s2", attributes: { status: "D", decline_reason: "Out of town", team_name: "Band" }, relationships: {} },
        ],
        links: { next: null },
      }),
    );
    const { app, fake: f } = await connected(fake);
    const res = await app.inject({ method: "GET", url: `${R}/people/101/schedule`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([
      { scheduleId: "s1", planId: "p1", serviceTypeId: "st1", teamId: "t1", serviceTypeName: "Sunday", teamName: "Band", positionName: "Bass", status: "confirmed", declineReason: null, sortDate: "2026-11-08T15:00:00Z", dates: "November 8, 2026" },
      { scheduleId: "s2", planId: null, serviceTypeId: null, teamId: null, serviceTypeName: null, teamName: "Band", positionName: null, status: "declined", declineReason: "Out of town", sortDate: null, dates: null },
    ]);
    expect(f.calls.find((c) => c.path.endsWith("/schedules"))!.url.searchParams.get("filter")).toBe("future,with_declined");
  });

  it("lists active service types by name and upcoming plans with a limit", async () => {
    const fake = new FakePco().withDefaults();
    fake.on("GET /services/v2/service_types", () =>
      json(200, {
        data: [
          { type: "ServiceType", id: "2", attributes: { name: "Youth", archived_at: null, deleted_at: null } },
          { type: "ServiceType", id: "1", attributes: { name: "Adult", archived_at: null, deleted_at: null } },
          { type: "ServiceType", id: "3", attributes: { name: "Old", archived_at: "2020-01-01T00:00:00Z", deleted_at: null } },
        ],
      }),
    );
    fake.on("GET /services/v2/service_types/1/plans", () =>
      json(200, { data: [{ type: "Plan", id: "p1", attributes: { title: "Week 1", series_title: "Hope", dates: "Nov 8", sort_date: "2026-11-08T15:00:00Z" } }] }),
    );
    const { app, fake: f } = await connected(fake);
    expect((await app.inject({ method: "GET", url: `${R}/service-types`, headers: auth })).json()).toEqual({ serviceTypes: [{ id: "1", name: "Adult" }, { id: "2", name: "Youth" }] });

    const plans = await app.inject({ method: "GET", url: `${R}/service-types/1/plans?limit=5`, headers: auth });
    expect(plans.json()).toEqual({ plans: [{ id: "p1", title: "Week 1", seriesTitle: "Hope", dates: "Nov 8", sortDate: "2026-11-08T15:00:00Z" }] });
    const q = f.calls.find((c) => c.path === "/services/v2/service_types/1/plans")!.url.searchParams;
    expect([q.get("filter"), q.get("per_page")]).toEqual(["future", "5"]);
    expect((await app.inject({ method: "GET", url: `${R}/service-types/1/plans?limit=500`, headers: auth })).statusCode).toBe(400);
  });

  it("returns plan assignments across pages with team names", async () => {
    const fake = new FakePco().withDefaults();
    const member = (id: string, person: string, team: string, status: string) => ({
      type: "PlanPerson", id, attributes: { name: `Person ${person}`, status, team_position_name: "Vocals", decline_reason: null },
      relationships: { person: { data: { type: "Person", id: person } }, team: { data: { type: "Team", id: team } } },
    });
    fake.on("GET /services/v2/service_types/1/plans/55", () => json(200, { data: { type: "Plan", id: "55", attributes: { title: "Week 1", series_title: null, dates: "Nov 8", sort_date: null } } }));
    fake.on(
      "GET /services/v2/service_types/1/plans/55/team_members",
      () => json(200, { data: [member("pp1", "101", "t1", "C")], included: [{ type: "Team", id: "t1", attributes: { name: "Band" } }], links: { next: "https://api.planningcenteronline.com/services/v2/service_types/1/plans/55/team_members?offset=100" } }),
      () => json(200, { data: [member("pp2", "102", "t2", "U")], included: [{ type: "Team", id: "t2", attributes: { name: "Tech" } }], links: { next: null } }),
    );
    const { app } = await connected(fake);
    const ok = await app.inject({ method: "GET", url: `${R}/service-types/1/plans/55/assignments`, headers: auth });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().plan).toMatchObject({ id: "55", title: "Week 1", serviceTypeId: "1" });
    expect(ok.json().assignments).toEqual([
      { planPersonId: "pp1", personId: "101", name: "Person 101", teamId: "t1", teamName: "Band", positionName: "Vocals", status: "confirmed", declineReason: null },
      { planPersonId: "pp2", personId: "102", name: "Person 102", teamId: "t2", teamName: "Tech", positionName: "Vocals", status: "unconfirmed", declineReason: null },
    ]);
  });
});

describe("groups attendance", () => {
  function attendanceFake() {
    const fake = new FakePco().withDefaults();
    const ev = (id: string, startsAt: string, canceled = false) => ({
      type: "Event", id, attributes: { name: `Event ${id}`, starts_at: startsAt, ends_at: null, canceled },
      relationships: { group: { data: { type: "Group", id: "g1" } } },
    });
    fake.on("GET /groups/v2/people/101/events", () =>
      json(200, {
        data: [ev("1", "2026-10-25T18:00:00Z"), ev("2", "2026-10-18T18:00:00Z"), ev("3", "2026-10-11T18:00:00Z", true), ev("4", "2026-10-04T18:00:00Z")],
        included: [{ type: "Group", id: "g1", attributes: { name: "Young Adults" } }],
        links: { next: null },
      }),
    );
    const att = (person: string, attended: boolean) => ({ type: "Attendance", id: `a${person}`, attributes: { attended, role: "member" }, relationships: { person: { data: { type: "Person", id: person } } } });
    // Event 1: present (second page). Event 2: absent. Event 4: not recorded for this person.
    fake.on(
      "GET /groups/v2/events/1/attendances",
      () => json(200, { data: [att("999", true)], links: { next: "https://api.planningcenteronline.com/groups/v2/events/1/attendances?offset=100" } }),
      () => json(200, { data: [att("101", true)], links: { next: null } }),
    );
    fake.on("GET /groups/v2/events/2/attendances", () => json(200, { data: [att("101", false)], links: { next: null } }));
    fake.on("GET /groups/v2/events/4/attendances", () => json(200, { data: [att("999", true)], links: { next: null } }));
    return fake;
  }

  it("builds per-person attendance from events and per-event attendances", async () => {
    const { app, fake } = await connected(attendanceFake());
    const res = await app.inject({ method: "GET", url: `${R}/people/101/group-attendance`, headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.windowDays).toBe(90);
    expect(body.fromCache).toBe(false);
    expect(body.summary).toEqual({ events: 3, attended: 1, absent: 1, notRecorded: 1, canceled: 1 });
    expect(body.events.map((e: any) => [e.eventId, e.groupName, e.attended, e.canceled])).toEqual([
      ["1", "Young Adults", true, false],
      ["2", "Young Adults", false, false],
      ["3", "Young Adults", null, true],
      ["4", "Young Adults", null, false],
    ]);
    // Canceled events are not looked up.
    expect(fake.count("GET /groups/v2/events/3/attendances")).toBe(0);
    // The window is passed to Planning Center.
    const q = fake.calls.find((c) => c.path === "/groups/v2/people/101/events")!.url.searchParams;
    expect(q.get("where[starts_at][gte]")).toBe(new Date(clock.now - 90 * 86_400_000).toISOString());
    expect(q.get("include")).toBe("group");
  });

  it("serves from cache, honours refresh=true, and expires after the TTL", async () => {
    const { app, fake } = await connected(attendanceFake());
    const url = `${R}/people/101/group-attendance?days=30`;
    await app.inject({ method: "GET", url, headers: auth });
    const calls = fake.count("GET /groups/v2/people/101/events");

    const cached = await app.inject({ method: "GET", url, headers: auth });
    expect(cached.json().fromCache).toBe(true);
    expect(fake.count("GET /groups/v2/people/101/events")).toBe(calls);

    // A different window is cached separately.
    expect((await app.inject({ method: "GET", url: `${R}/people/101/group-attendance?days=60`, headers: auth })).json().fromCache).toBe(false);

    expect((await app.inject({ method: "GET", url: `${url}&refresh=true`, headers: auth })).json().fromCache).toBe(false);

    clock.now += ATTENDANCE_CACHE_TTL_MS + 1;
    expect((await app.inject({ method: "GET", url, headers: auth })).json().fromCache).toBe(false);
  });

  it("does not serve cached attendance after disconnect", async () => {
    const { app, db } = await connected(attendanceFake());
    await app.inject({ method: "GET", url: `${R}/people/101/group-attendance`, headers: auth });
    expect(await db.selectFrom("pco_group_attendance_cache").selectAll().execute()).toHaveLength(1);

    await app.inject({ method: "POST", url: "/v1/integrations/planning-center/disconnect", headers: auth });
    expect(await db.selectFrom("pco_group_attendance_cache").selectAll().execute()).toHaveLength(0);
    const res = await app.inject({ method: "GET", url: `${R}/people/101/group-attendance`, headers: auth });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_connected");
  });

  it("validates days and refresh", async () => {
    const { app } = await connected(attendanceFake());
    for (const qs of ["days=0", "days=366", "days=abc", "refresh=yes"]) {
      expect((await app.inject({ method: "GET", url: `${R}/people/101/group-attendance?${qs}`, headers: auth })).statusCode).toBe(400);
    }
  });
});
