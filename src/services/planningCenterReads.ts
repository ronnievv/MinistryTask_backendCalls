import type { DB } from "../db/index.ts";
import type { PcoClient } from "../providers/planningCenter/client.ts";
import type {
  PcoAttendanceAttributes,
  PcoEmailAttributes,
  PcoGroupAttributes,
  PcoGroupEventAttributes,
  PcoHouseholdAttributes,
  PcoPersonAttributes,
  PcoPhoneNumberAttributes,
  PcoPlanAttributes,
  PcoPlanPersonAttributes,
  PcoResource,
  PcoScheduleAttributes,
  PcoServiceTypeAttributes,
  PcoTeamAttributes,
} from "../providers/planningCenter/types.ts";
import type { PlanningCenterConnectionService } from "./planningCenterConnection.ts";

/** Computed attendance is reused this long before Planning Center is asked again. */
export const ATTENDANCE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Upper bound on events checked per request (one Planning Center call each). */
export const MAX_ATTENDANCE_EVENTS = 150;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- internal models (what ministrytask sees) ----------

export interface PersonProfile {
  id: string;
  firstName: string | null;
  lastName: string | null;
  nickname: string | null;
  name: string | null;
  status: string | null;
  emails: { id: string; address: string; location: string | null; primary: boolean }[];
  phoneNumbers: { id: string; number: string; e164: string | null; location: string | null; primary: boolean }[];
  households: { id: string; name: string | null; primaryContactId: string | null; members: { id: string; name: string | null }[] }[];
}

export type AssignmentStatus = "confirmed" | "unconfirmed" | "declined" | "unknown";

export interface ScheduleItem {
  scheduleId: string;
  planId: string | null;
  serviceTypeId: string | null;
  teamId: string | null;
  serviceTypeName: string | null;
  teamName: string | null;
  positionName: string | null;
  status: AssignmentStatus;
  declineReason: string | null;
  sortDate: string | null;
  dates: string | null;
}

export interface PlanSummary {
  id: string;
  title: string | null;
  seriesTitle: string | null;
  dates: string | null;
  sortDate: string | null;
}

export interface PlanAssignments {
  plan: PlanSummary & { serviceTypeId: string };
  assignments: {
    planPersonId: string;
    personId: string | null;
    name: string | null;
    teamId: string | null;
    teamName: string | null;
    positionName: string | null;
    status: AssignmentStatus;
    declineReason: string | null;
  }[];
}

export interface GroupAttendance {
  personId: string;
  from: string;
  to: string;
  windowDays: number;
  events: {
    eventId: string;
    groupId: string | null;
    groupName: string | null;
    name: string | null;
    startsAt: string;
    canceled: boolean;
    /** null: no attendance was recorded for this person at this event. */
    attended: boolean | null;
    role: string | null;
  }[];
  summary: { events: number; attended: number; absent: number; notRecorded: number; canceled: number };
  /** True when the window held more than MAX_ATTENDANCE_EVENTS events; only the most recent were checked. */
  truncated: boolean;
  fetchedAt: string;
  fromCache: boolean;
}

// ---------- service ----------

export class PlanningCenterReadService {
  constructor(
    private readonly db: DB,
    private readonly pco: PlanningCenterConnectionService,
    private readonly opts: { now?: () => number } = {},
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  /** Approved profile fields only: sparse fieldsets keep birthdate, medical notes etc. out of the response. */
  person(organizationId: string, actor: string, personId: string): Promise<PersonProfile> {
    return this.pco.runRead(organizationId, actor, "people.read", { type: "pco_person", id: personId }, async (client) => {
      const res = await client.getOne<PcoPersonAttributes & { status: string | null }>(`/people/v2/people/${personId}`, {
        include: "emails,phone_numbers,households",
        "fields[Person]": "first_name,last_name,nickname,name,status,emails,phone_numbers,households",
        "fields[Email]": "address,location,primary",
        "fields[PhoneNumber]": "number,e164,location,primary",
        "fields[Household]": "name,member_count,primary_contact_id",
      });
      const inc = res.included ?? [];
      const emails = related<PcoEmailAttributes>(res.data, "emails", inc);
      const phones = related<PcoPhoneNumberAttributes>(res.data, "phone_numbers", inc);
      const households = related<PcoHouseholdAttributes>(res.data, "households", inc);

      // Household members: one call per household (people usually have one).
      const withMembers = [];
      for (const h of households) {
        const hr = await client.getOne<PcoHouseholdAttributes>(`/people/v2/households/${h.id}`, { include: "people", "fields[Person]": "name" });
        const members = related<PcoPersonAttributes>(hr.data, "people", hr.included ?? []).map((p) => ({ id: p.id, name: p.attributes.name ?? null }));
        withMembers.push({ id: h.id, name: h.attributes.name ?? null, primaryContactId: h.attributes.primary_contact_id ?? null, members });
      }

      const a = res.data.attributes;
      return {
        id: res.data.id,
        firstName: a.first_name ?? null,
        lastName: a.last_name ?? null,
        nickname: a.nickname ?? null,
        name: a.name ?? null,
        status: a.status ?? null,
        emails: emails.map((e) => ({ id: e.id, address: e.attributes.address, location: e.attributes.location ?? null, primary: !!e.attributes.primary })),
        phoneNumbers: phones.map((p) => ({
          id: p.id, number: p.attributes.number, e164: p.attributes.e164 ?? null, location: p.attributes.location ?? null, primary: !!p.attributes.primary,
        })),
        households: withMembers,
      };
    });
  }

  /** The person's upcoming Services assignments, including declined ones. */
  schedule(organizationId: string, actor: string, personId: string): Promise<{ personId: string; items: ScheduleItem[] }> {
    return this.pco.runRead(organizationId, actor, "services.schedule.read", { type: "pco_person", id: personId }, async (client) => {
      const rows = await client.listAll<PcoScheduleAttributes>(`/services/v2/people/${personId}/schedules`, { filter: "future,with_declined", order: "starts_at" }, 5);
      const items = rows.map((s) => ({
        scheduleId: s.id,
        planId: relId(s, "plan"),
        serviceTypeId: relId(s, "service_type"),
        teamId: relId(s, "team"),
        serviceTypeName: s.attributes.service_type_name ?? null,
        teamName: s.attributes.team_name ?? null,
        positionName: s.attributes.team_position_name ?? null,
        status: assignmentStatus(s.attributes.status),
        declineReason: s.attributes.decline_reason ?? null,
        sortDate: s.attributes.sort_date ?? null,
        dates: s.attributes.dates ?? null,
      }));
      return { personId, items };
    });
  }

  /** Active (not archived or deleted) service types, by name. */
  serviceTypes(organizationId: string, actor: string): Promise<{ id: string; name: string }[]> {
    return this.pco.runRead(organizationId, actor, "services.service_types.read", { type: "pco_service_type" }, async (client) => {
      const rows = await client.listAll<PcoServiceTypeAttributes>("/services/v2/service_types", {}, 10);
      return rows
        .filter((r) => !r.attributes.archived_at && !r.attributes.deleted_at)
        .map((r) => ({ id: r.id, name: r.attributes.name }))
        .sort((x, y) => x.name.localeCompare(y.name));
    });
  }

  /** The next `limit` plans of one service type. */
  upcomingPlans(organizationId: string, actor: string, serviceTypeId: string, limit: number): Promise<PlanSummary[]> {
    return this.pco.runRead(organizationId, actor, "services.plans.read", { type: "pco_service_type", id: serviceTypeId }, async (client) => {
      const res = await client.get<{ data: PcoResource<PcoPlanAttributes>[] }>(`/services/v2/service_types/${serviceTypeId}/plans`, {
        filter: "future", order: "sort_date", per_page: String(limit),
      });
      return res.data.map(planSummary);
    });
  }

  /** Everyone scheduled on one plan, with team, position and response. */
  planAssignments(organizationId: string, actor: string, serviceTypeId: string, planId: string): Promise<PlanAssignments> {
    return this.pco.runRead(organizationId, actor, "services.plan_assignments.read", { type: "pco_plan", id: planId }, async (client) => {
      const base = `/services/v2/service_types/${serviceTypeId}/plans/${planId}`;
      const plan = await client.getOne<PcoPlanAttributes>(base);
      const { data, included } = await client.listAllWithIncluded<PcoPlanPersonAttributes>(`${base}/team_members`, { include: "team" }, 10);
      const teams = new Map(included.filter((i) => i.type === "Team").map((t) => [t.id, (t.attributes as Partial<PcoTeamAttributes>).name ?? null]));
      return {
        plan: { ...planSummary(plan.data), serviceTypeId },
        assignments: data.map((pp) => {
          const teamId = relId(pp, "team");
          return {
            planPersonId: pp.id,
            personId: relId(pp, "person"),
            name: pp.attributes.name ?? null,
            teamId,
            teamName: teamId ? (teams.get(teamId) ?? null) : null,
            positionName: pp.attributes.team_position_name ?? null,
            status: assignmentStatus(pp.attributes.status),
            declineReason: pp.attributes.decline_reason ?? null,
          };
        }),
      };
    });
  }

  /**
   * Groups attendance for one person over the last `windowDays`. Planning Center has no
   * per-person attendance endpoint: list the person's group events, then read each event's
   * attendances. The result is cached per person and window for ATTENDANCE_CACHE_TTL_MS.
   */
  groupAttendance(organizationId: string, actor: string, personId: string, windowDays: number, refresh = false): Promise<GroupAttendance> {
    return this.pco.runRead(organizationId, actor, "groups.attendance.read", { type: "pco_person", id: personId }, async (client) => {
      // Never serve cached data for a connection that is no longer usable.
      await this.pco.assertConnected(organizationId);

      if (!refresh) {
        const cached = await this.db
          .selectFrom("pco_group_attendance_cache")
          .selectAll()
          .where("organization_id", "=", organizationId)
          .where("person_id", "=", personId)
          .where("window_days", "=", windowDays)
          .executeTakeFirst();
        if (cached && Date.parse(cached.fetched_at) + ATTENDANCE_CACHE_TTL_MS > this.now()) {
          return { ...(JSON.parse(cached.payload) as GroupAttendance), fromCache: true };
        }
      }

      const to = new Date(this.now());
      const from = new Date(this.now() - windowDays * DAY_MS);
      const { data: allEvents, included } = await client.listAllWithIncluded<PcoGroupEventAttributes>(`/groups/v2/people/${personId}/events`, {
        include: "group",
        order: "-starts_at",
        "where[starts_at][gte]": from.toISOString(),
        "where[starts_at][lte]": to.toISOString(),
      }, 10);
      const groups = new Map(included.filter((i) => i.type === "Group").map((g) => [g.id, (g.attributes as Partial<PcoGroupAttributes>).name ?? null]));
      const truncated = allEvents.length > MAX_ATTENDANCE_EVENTS;
      const events = allEvents.slice(0, MAX_ATTENDANCE_EVENTS);

      const out: GroupAttendance["events"] = [];
      for (const ev of events) {
        let attended: boolean | null = null;
        let role: string | null = null;
        if (!ev.attributes.canceled) {
          const rows = await client.listAll<PcoAttendanceAttributes>(`/groups/v2/events/${ev.id}/attendances`, {}, 20);
          const mine = rows.find((r) => relId(r, "person") === personId);
          if (mine) {
            attended = !!mine.attributes.attended;
            role = mine.attributes.role ?? null;
          }
        }
        const groupId = relId(ev, "group");
        out.push({
          eventId: ev.id,
          groupId,
          groupName: groupId ? (groups.get(groupId) ?? null) : null,
          name: ev.attributes.name ?? null,
          startsAt: ev.attributes.starts_at,
          canceled: !!ev.attributes.canceled,
          attended,
          role,
        });
      }

      const live = out.filter((e) => !e.canceled);
      const result: GroupAttendance = {
        personId,
        from: from.toISOString(),
        to: to.toISOString(),
        windowDays,
        events: out,
        summary: {
          events: live.length,
          attended: live.filter((e) => e.attended === true).length,
          absent: live.filter((e) => e.attended === false).length,
          notRecorded: live.filter((e) => e.attended === null).length,
          canceled: out.length - live.length,
        },
        truncated,
        fetchedAt: to.toISOString(),
        fromCache: false,
      };

      const payload = JSON.stringify(result);
      await this.db
        .insertInto("pco_group_attendance_cache")
        .values({ organization_id: organizationId, person_id: personId, window_days: windowDays, payload, fetched_at: result.fetchedAt })
        .onConflict((oc) => oc.columns(["organization_id", "person_id", "window_days"]).doUpdateSet({ payload, fetched_at: result.fetchedAt }))
        .execute();
      return result;
    });
  }
}

// ---------- mapping helpers ----------

function relId(r: PcoResource<unknown>, name: string): string | null {
  const d = r.relationships?.[name]?.data;
  return d && !Array.isArray(d) ? d.id : null;
}

/** Resolves a to-many relationship against the `included` list, keeping relationship order. */
function related<A>(r: PcoResource<unknown>, name: string, included: PcoResource[]): PcoResource<A>[] {
  const d = r.relationships?.[name]?.data;
  const refs = Array.isArray(d) ? d : d ? [d] : [];
  return refs
    .map((ref) => included.find((i) => i.type === ref.type && i.id === ref.id))
    .filter((x): x is PcoResource => !!x) as PcoResource<A>[];
}

/** Planning Center uses C / U / D for scheduled people. */
function assignmentStatus(s: string | null | undefined): AssignmentStatus {
  return s === "C" ? "confirmed" : s === "U" ? "unconfirmed" : s === "D" ? "declined" : "unknown";
}

function planSummary(p: PcoResource<PcoPlanAttributes>): PlanSummary {
  return {
    id: p.id,
    title: p.attributes.title ?? null,
    seriesTitle: p.attributes.series_title ?? null,
    dates: p.attributes.dates ?? null,
    sortDate: p.attributes.sort_date ?? null,
  };
}
