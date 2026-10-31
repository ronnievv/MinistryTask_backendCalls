import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { PlanningCenterReadService } from "../services/planningCenterReads.ts";

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
