import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { PlanningCenterReadService } from "../services/planningCenterReads.ts";
import { changeRequestBody, type PlanningCenterChangeService } from "../services/planningCenterChanges.ts";

/** Planning Center ids are numeric. Validating them also keeps request input out of URL paths. */
const pcoId = z.string().regex(/^\d{1,20}$/);

const personParams = z.object({ personId: pcoId });
const serviceTypeParams = z.object({ serviceTypeId: pcoId });
const planParams = z.object({ serviceTypeId: pcoId, planId: pcoId });
const plansQuery = z.object({ limit: z.coerce.number().int().min(1).max(25).default(10) });
const attendanceQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(90),
  refresh: z.enum(["true", "false"]).default("false"),
});

/** Read-only Planning Center data for ministrytask (Phase 3). Every route requires the API key. */
export function planningCenterDataRoutes(
  app: FastifyInstance,
  reads: PlanningCenterReadService,
  guard: (req: any, reply: any) => Promise<unknown>,
) {
  const prefix = "/v1/planning-center";

  app.get(`${prefix}/people/:personId`, { preHandler: guard }, async (req, reply) => {
    const p = personParams.safeParse(req.params);
    if (!p.success) return invalid(reply, "personId must be a Planning Center person id.");
    return reads.person(req.caller!.organizationId, req.caller!.actor, p.data.personId);
  });

  app.get(`${prefix}/people/:personId/schedule`, { preHandler: guard }, async (req, reply) => {
    const p = personParams.safeParse(req.params);
    if (!p.success) return invalid(reply, "personId must be a Planning Center person id.");
    return reads.schedule(req.caller!.organizationId, req.caller!.actor, p.data.personId);
  });

  app.get(`${prefix}/people/:personId/group-attendance`, { preHandler: guard }, async (req, reply) => {
    const p = personParams.safeParse(req.params);
    const q = attendanceQuery.safeParse(req.query);
    if (!p.success) return invalid(reply, "personId must be a Planning Center person id.");
    if (!q.success) return invalid(reply, "days must be 1-365 and refresh must be true or false.");
    return reads.groupAttendance(req.caller!.organizationId, req.caller!.actor, p.data.personId, q.data.days, q.data.refresh === "true");
  });

  app.get(`${prefix}/service-types`, { preHandler: guard }, async (req) => {
    return { serviceTypes: await reads.serviceTypes(req.caller!.organizationId, req.caller!.actor) };
  });

  app.get(`${prefix}/service-types/:serviceTypeId/plans`, { preHandler: guard }, async (req, reply) => {
    const p = serviceTypeParams.safeParse(req.params);
    const q = plansQuery.safeParse(req.query);
    if (!p.success) return invalid(reply, "serviceTypeId must be a Planning Center id.");
    if (!q.success) return invalid(reply, "limit must be 1-25.");
    return { plans: await reads.upcomingPlans(req.caller!.organizationId, req.caller!.actor, p.data.serviceTypeId, q.data.limit) };
  });

  app.get(`${prefix}/service-types/:serviceTypeId/plans/:planId/assignments`, { preHandler: guard }, async (req, reply) => {
    const p = planParams.safeParse(req.params);
    if (!p.success) return invalid(reply, "serviceTypeId and planId must be Planning Center ids.");
    return reads.planAssignments(req.caller!.organizationId, req.caller!.actor, p.data.serviceTypeId, p.data.planId);
  });
}

function invalid(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: "invalid_request", message });
}

const changeParams = z.object({ changeId: z.string().uuid() });

/**
 * Previewed, approved writes to a Planning Center person (Phase 3). Every route needs X-Actor:
 * the staff member who asked for, approved or rejected the change.
 */
export function planningCenterChangeRoutes(
  app: FastifyInstance,
  changes: PlanningCenterChangeService,
  guard: (req: any, reply: any) => Promise<unknown>,
) {
  const prefix = "/v1/planning-center";
  const needsActor = async (req: any, reply: FastifyReply) => {
    if (req.caller?.actor === "api-key") {
      return reply.code(400).send({ error: "actor_required", message: "Send X-Actor with the email of the staff member making this change." });
    }
  };
  const pre = { preHandler: [guard, needsActor] };

  app.post(`${prefix}/people/:personId/changes`, pre, async (req, reply) => {
    const p = personParams.safeParse(req.params);
    const b = changeRequestBody.safeParse(req.body);
    if (!p.success) return invalid(reply, "personId must be a Planning Center person id.");
    if (!b.success) return invalid(reply, describeIssues(b.error));
    const view = await changes.preview(req.caller!.organizationId, req.caller!.actor, p.data.personId, b.data.operations);
    return reply.code(201).send(view);
  });

  app.get(`${prefix}/people/:personId/changes`, pre, async (req, reply) => {
    const p = personParams.safeParse(req.params);
    if (!p.success) return invalid(reply, "personId must be a Planning Center person id.");
    return { changes: await changes.listForPerson(req.caller!.organizationId, p.data.personId) };
  });

  app.get(`${prefix}/changes/:changeId`, pre, async (req, reply) => {
    const p = changeParams.safeParse(req.params);
    if (!p.success) return invalid(reply, "changeId must be a change request id.");
    return changes.get(req.caller!.organizationId, p.data.changeId);
  });

  app.post(`${prefix}/changes/:changeId/approve`, pre, async (req, reply) => {
    const p = changeParams.safeParse(req.params);
    if (!p.success) return invalid(reply, "changeId must be a change request id.");
    return changes.approve(req.caller!.organizationId, req.caller!.actor, p.data.changeId);
  });

  app.post(`${prefix}/changes/:changeId/reject`, pre, async (req, reply) => {
    const p = changeParams.safeParse(req.params);
    if (!p.success) return invalid(reply, "changeId must be a change request id.");
    return changes.reject(req.caller!.organizationId, req.caller!.actor, p.data.changeId);
  });
}

/** Field paths and messages only: never echoes submitted values (they may be contact data). */
function describeIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? i.path.join(".") : "body"}: ${i.message}`)
    .join("; ");
}
