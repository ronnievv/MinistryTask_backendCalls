import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sha256, type TokenCipher } from "../crypto.ts";
import type { DB } from "../db/index.ts";
import type { ChangeRequestStatus, PcoChangeRequestsTable } from "../db/schema.ts";
import type { PcoClient } from "../providers/planningCenter/client.ts";
import { PcoError, toPcoError } from "../providers/planningCenter/errors.ts";
import { ConnectionError, type PlanningCenterConnectionService } from "./planningCenterConnection.ts";
import { fetchContactProfile, type ContactProfile } from "./planningCenterReads.ts";
import { audit } from "./audit.ts";

/** A previewed change waits this long for approval. */
export const CHANGE_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_OPERATIONS = 10;

export class ChangeRequestError extends ConnectionError {
  override name = "ChangeRequestError";
}

// ---------- operations (the only writes this service will make) ----------

const name = z.string().trim().min(1).max(100);
const email = z.string().trim().toLowerCase().email().max(254);
const phone = z
  .string()
  .trim()
  .regex(/^[+()\d .-]{7,30}$/, "Use digits, spaces and + ( ) - . only")
  .refine((v) => v.replace(/\D/g, "").length >= 7, "A phone number needs at least 7 digits");
const pcoId = z.string().regex(/^\d{1,20}$/);
const emailLocation = z.enum(["Home", "Work", "Other"]);
const phoneLocation = z.enum(["Mobile", "Home", "Work", "Pager", "Fax", "Skype", "Other"]);

export const operationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("update_name"), firstName: name.optional(), lastName: name.optional(), nickname: name.optional() }).strict(),
  z.object({ op: z.literal("add_email"), address: email, location: emailLocation, primary: z.boolean().default(false) }).strict(),
  z.object({ op: z.literal("update_email"), emailId: pcoId, address: email.optional(), location: emailLocation.optional() }).strict(),
  z.object({ op: z.literal("set_primary_email"), emailId: pcoId }).strict(),
  z.object({ op: z.literal("add_phone"), number: phone, location: phoneLocation, primary: z.boolean().default(false) }).strict(),
  z.object({ op: z.literal("update_phone"), phoneId: pcoId, number: phone.optional(), location: phoneLocation.optional() }).strict(),
  z.object({ op: z.literal("set_primary_phone"), phoneId: pcoId }).strict(),
]);
export type Operation = z.infer<typeof operationSchema>;

export const changeRequestBody = z.object({ operations: z.array(operationSchema).min(1).max(MAX_OPERATIONS) }).strict();

export interface PreviewItem {
  index: number;
  op: Operation["op"];
  field: string;
  before: unknown;
  after: unknown;
}

export interface OperationResult {
  index: number;
  op: Operation["op"];
  status: "applied" | "failed" | "not_attempted";
  /** For add_email / add_phone: the new Planning Center id. */
  createdId?: string;
  error?: { code: string; message: string };
}

export interface ChangeRequestView {
  id: string;
  personId: string;
  status: ChangeRequestStatus;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  operations: Operation[];
  preview: PreviewItem[];
  results: OperationResult[] | null;
}

interface Payload {
  operations: Operation[];
  preview: PreviewItem[];
  fingerprint: string;
}

// ---------- service ----------

export class PlanningCenterChangeService {
  constructor(
    private readonly db: DB,
    private readonly cipher: TokenCipher,
    private readonly pco: PlanningCenterConnectionService,
    private readonly opts: { now?: () => number } = {},
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  /** Validates the operations against the person's current record and stores a preview. Writes nothing to Planning Center. */
  async preview(organizationId: string, actor: string, personId: string, operations: Operation[]): Promise<ChangeRequestView> {
    const target = { type: "pco_person", id: personId };
    return this.pco.runCall(organizationId, actor, "people.change.preview", target, async (client) => {
      const { profile } = await fetchContactProfile(client, personId);
      const preview = buildPreview(profile, operations);
      const id = randomUUID();
      const nowIso = new Date(this.now()).toISOString();
      const payload: Payload = { operations, preview, fingerprint: fingerprint(profile) };
      const row: PcoChangeRequestsTable = {
        id,
        organization_id: organizationId,
        person_id: personId,
        status: "pending",
        payload_enc: this.cipher.encrypt(JSON.stringify(payload), `${id}:payload`),
        result_enc: null,
        requested_by: actor,
        requested_at: nowIso,
        expires_at: new Date(this.now() + CHANGE_REQUEST_TTL_MS).toISOString(),
        decided_by: null,
        decided_at: null,
        updated_at: nowIso,
      };
      await this.db.insertInto("pco_change_requests").values(row).execute();
      return this.view(row);
    });
  }

  async get(organizationId: string, changeId: string): Promise<ChangeRequestView> {
    return this.view(await this.load(organizationId, changeId));
  }

  async listForPerson(organizationId: string, personId: string): Promise<ChangeRequestView[]> {
    const rows = await this.db
      .selectFrom("pco_change_requests")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("person_id", "=", personId)
      .orderBy("requested_at", "desc")
      .limit(50)
      .execute();
    const out: ChangeRequestView[] = [];
    for (const r of rows) out.push(await this.view(await this.expireIfDue(r)));
    return out;
  }

  async reject(organizationId: string, actor: string, changeId: string): Promise<ChangeRequestView> {
    const row = await this.load(organizationId, changeId);
    if (row.status !== "pending") throw notPending(row.status);
    const nowIso = new Date(this.now()).toISOString();
    const res = await this.db
      .updateTable("pco_change_requests")
      .set({ status: "rejected", decided_by: actor, decided_at: nowIso, updated_at: nowIso })
      .where("id", "=", row.id)
      .where("status", "=", "pending")
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) throw notPending((await this.load(organizationId, changeId)).status);
    await this.auditDecision(organizationId, actor, row, "people.change.reject", "success");
    return this.get(organizationId, changeId);
  }

  /**
   * Re-reads the person; if anything changed since the preview, marks the request stale and
   * writes nothing. Otherwise applies the operations in order and stops at the first failure.
   * Writes are never retried: a failure is reported per operation.
   */
  async approve(organizationId: string, actor: string, changeId: string): Promise<ChangeRequestView> {
    const row = await this.load(organizationId, changeId);
    if (row.status !== "pending") throw notPending(row.status);

    // Claim the request so a second approval can't apply it twice.
    const nowIso = new Date(this.now()).toISOString();
    const claimed = await this.db
      .updateTable("pco_change_requests")
      .set({ status: "applying", decided_by: actor, decided_at: nowIso, updated_at: nowIso })
      .where("id", "=", row.id)
      .where("status", "=", "pending")
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) === 0) throw notPending((await this.load(organizationId, changeId)).status);

    const payload = this.payload(row);
    const target = { type: "pco_person", id: row.person_id };
    try {
      return await this.pco.runCall(organizationId, actor, "people.change.apply", target, async (client) => {
        let current: ContactProfile;
        try {
          current = (await fetchContactProfile(client, row.person_id)).profile;
        } catch (err) {
          await this.setStatus(row.id, "pending", { decided_by: null, decided_at: null }); // nothing written; can be approved again
          throw err;
        }
        if (fingerprint(current) !== payload.fingerprint) {
          await this.setStatus(row.id, "stale");
          throw new ChangeRequestError("stale", "This person's record changed in Planning Center after the preview. Nothing was written. Create a new preview.", 409);
        }

        const results: OperationResult[] = payload.operations.map((o, index) => ({ index, op: o.op, status: "not_attempted" }));
        let reauthError: PcoError | undefined;
        for (const [index, op] of payload.operations.entries()) {
          try {
            const createdId = await applyOperation(client, row.person_id, op);
            results[index] = { index, op: op.op, status: "applied", ...(createdId ? { createdId } : {}) };
          } catch (err) {
            const e = err instanceof ConnectionError ? err : toPcoError(err);
            results[index] = { index, op: op.op, status: "failed", error: { code: e instanceof PcoError ? `planning_center_${e.kind}` : e.code, message: e.message } };
            if (e instanceof PcoError && e.requiresReauth) reauthError = e;
            break;
          }
        }
        const applied = results.filter((r) => r.status === "applied").length;
        const status: ChangeRequestStatus = applied === results.length ? "applied" : applied === 0 ? "failed" : "partially_applied";
        await this.setStatus(row.id, status, { result_enc: this.cipher.encrypt(JSON.stringify(results), `${row.id}:result`) });
        if (reauthError) throw reauthError; // results are stored; let runCall mark the connection needs_reauth
        return this.get(organizationId, changeId);
      });
    } catch (err) {
      // Anything unexpected before results were stored: never leave the request stuck in "applying".
      const latest = await this.load(organizationId, changeId);
      if (latest.status === "applying") await this.setStatus(row.id, "failed");
      throw err;
    }
  }

  // ---------- helpers ----------

  private async load(organizationId: string, changeId: string): Promise<PcoChangeRequestsTable> {
    const row = await this.db
      .selectFrom("pco_change_requests")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("id", "=", changeId)
      .executeTakeFirst();
    if (!row) throw new ChangeRequestError("not_found", "No such change request.", 404);
    return this.expireIfDue(row);
  }

  private async expireIfDue(row: PcoChangeRequestsTable): Promise<PcoChangeRequestsTable> {
    if (row.status !== "pending" || Date.parse(row.expires_at) > this.now()) return row;
    await this.setStatus(row.id, "expired");
    return { ...row, status: "expired" };
  }

  private async setStatus(id: string, status: ChangeRequestStatus, extra: Partial<PcoChangeRequestsTable> = {}) {
    await this.db
      .updateTable("pco_change_requests")
      .set({ status, ...extra, updated_at: new Date(this.now()).toISOString() })
      .where("id", "=", id)
      .execute();
  }

  private payload(row: PcoChangeRequestsTable): Payload {
    return JSON.parse(this.cipher.decrypt(row.payload_enc, `${row.id}:payload`)) as Payload;
  }

  private async view(row: PcoChangeRequestsTable): Promise<ChangeRequestView> {
    const latest = await this.db.selectFrom("pco_change_requests").selectAll().where("id", "=", row.id).executeTakeFirstOrThrow();
    const p = this.payload(latest);
    return {
      id: latest.id,
      personId: latest.person_id,
      status: latest.status,
      requestedBy: latest.requested_by,
      requestedAt: latest.requested_at,
      expiresAt: latest.expires_at,
      decidedBy: latest.decided_by,
      decidedAt: latest.decided_at,
      operations: p.operations,
      preview: p.preview,
      results: latest.result_enc ? (JSON.parse(this.cipher.decrypt(latest.result_enc, `${latest.id}:result`)) as OperationResult[]) : null,
    };
  }

  private async auditDecision(organizationId: string, actor: string, row: PcoChangeRequestsTable, action: string, outcome: "success" | "failure") {
    await audit(this.db, { organizationId, provider: "planning_center", actor, action, outcome, targetType: "pco_person", targetId: row.person_id, detail: { changeId: row.id } });
  }
}

function notPending(status: ChangeRequestStatus) {
  return new ChangeRequestError("not_pending", `This change request is ${status.replace("_", " ")} and can no longer be approved or rejected.`, 409);
}

// ---------- preview ----------

/** Checks every operation against the current record and describes it as before/after. Throws 400 on anything invalid. */
export function buildPreview(p: ContactProfile, operations: Operation[]): PreviewItem[] {
  const items: PreviewItem[] = [];
  const touched = new Set<string>();
  const claim = (key: string, index: number) => {
    if (touched.has(key)) throw invalid(index, "Another operation in this request already changes the same thing.");
    touched.add(key);
  };
  const findEmail = (id: string, index: number) => p.emails.find((e) => e.id === id) ?? throwInvalid(index, "That email does not belong to this person.");
  const findPhone = (id: string, index: number) => p.phoneNumbers.find((x) => x.id === id) ?? throwInvalid(index, "That phone number does not belong to this person.");
  const emailTaken = (address: string, exceptId?: string) => p.emails.some((e) => e.id !== exceptId && e.address.toLowerCase() === address);
  const phoneTaken = (n: string, exceptId?: string) => p.phoneNumbers.some((x) => x.id !== exceptId && digits(x.number) === digits(n));

  for (const [index, op] of operations.entries()) {
    const push = (field: string, before: unknown, after: unknown) => items.push({ index, op: op.op, field, before, after });
    switch (op.op) {
      case "update_name": {
        claim("name", index);
        const fields = [["firstName", op.firstName], ["lastName", op.lastName], ["nickname", op.nickname]] as const;
        let changed = 0;
        for (const [field, value] of fields) {
          if (value === undefined) continue;
          if (value === p[field]) throw invalid(index, `${field} is already "${value}".`);
          push(field, p[field], value);
          changed++;
        }
        if (!changed) throw invalid(index, "update_name needs firstName, lastName or nickname.");
        break;
      }
      case "add_email":
        if (emailTaken(op.address)) throw invalid(index, "This person already has that email address.");
        if (op.primary) claim("primary_email", index);
        push("emails", null, { address: op.address, location: op.location, primary: op.primary });
        break;
      case "update_email": {
        claim(`email:${op.emailId}`, index);
        const e = findEmail(op.emailId, index);
        if (op.address === undefined && op.location === undefined) throw invalid(index, "update_email needs address or location.");
        if (op.address !== undefined && emailTaken(op.address, e.id)) throw invalid(index, "This person already has that email address.");
        const after = { address: op.address ?? e.address, location: op.location ?? e.location };
        if (after.address === e.address && after.location === e.location) throw invalid(index, "Nothing would change.");
        push(`emails[${e.id}]`, { address: e.address, location: e.location }, after);
        break;
      }
      case "set_primary_email": {
        claim("primary_email", index);
        const e = findEmail(op.emailId, index);
        if (e.primary) throw invalid(index, "That email is already primary.");
        push("primaryEmail", p.emails.find((x) => x.primary)?.address ?? null, e.address);
        break;
      }
      case "add_phone":
        if (phoneTaken(op.number)) throw invalid(index, "This person already has that phone number.");
        if (op.primary) claim("primary_phone", index);
        push("phoneNumbers", null, { number: op.number, location: op.location, primary: op.primary });
        break;
      case "update_phone": {
        claim(`phone:${op.phoneId}`, index);
        const x = findPhone(op.phoneId, index);
        if (op.number === undefined && op.location === undefined) throw invalid(index, "update_phone needs number or location.");
        if (op.number !== undefined && phoneTaken(op.number, x.id)) throw invalid(index, "This person already has that phone number.");
        const after = { number: op.number ?? x.number, location: op.location ?? x.location };
        if (digits(after.number) === digits(x.number) && after.location === x.location) throw invalid(index, "Nothing would change.");
        push(`phoneNumbers[${x.id}]`, { number: x.number, location: x.location }, after);
        break;
      }
      case "set_primary_phone": {
        claim("primary_phone", index);
        const x = findPhone(op.phoneId, index);
        if (x.primary) throw invalid(index, "That phone number is already primary.");
        push("primaryPhone", p.phoneNumbers.find((y) => y.primary)?.number ?? null, x.number);
        break;
      }
    }
  }
  return items;
}

/** Everything a change could depend on. Any difference at approval time means the preview is out of date. */
export function fingerprint(p: ContactProfile): string {
  const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
  return sha256(
    JSON.stringify({
      n: [p.firstName, p.lastName, p.nickname],
      e: byId(p.emails).map((e) => [e.id, e.address, e.location, e.primary]),
      ph: byId(p.phoneNumbers).map((x) => [x.id, x.number, x.location, x.primary]),
    }),
  );
}

// ---------- apply ----------

/** Performs one operation. Returns the new record id for adds. */
async function applyOperation(client: PcoClient, personId: string, op: Operation): Promise<string | undefined> {
  switch (op.op) {
    case "update_name":
      await client.write("PATCH", `/people/v2/people/${personId}`, {
        data: { type: "Person", id: personId, attributes: compact({ first_name: op.firstName, last_name: op.lastName, nickname: op.nickname }) },
      });
      return;
    case "add_email": {
      const res = await client.write<{ data: { id: string } }>("POST", `/people/v2/people/${personId}/emails`, {
        data: { type: "Email", attributes: { address: op.address, location: op.location, primary: op.primary } },
      });
      return res.data.id;
    }
    case "update_email":
      await client.write("PATCH", `/people/v2/emails/${op.emailId}`, { data: { type: "Email", id: op.emailId, attributes: compact({ address: op.address, location: op.location }) } });
      return;
    case "set_primary_email":
      await client.write("PATCH", `/people/v2/emails/${op.emailId}`, { data: { type: "Email", id: op.emailId, attributes: { primary: true } } });
      return;
    case "add_phone": {
      const res = await client.write<{ data: { id: string } }>("POST", `/people/v2/people/${personId}/phone_numbers`, {
        data: { type: "PhoneNumber", attributes: { number: op.number, location: op.location, primary: op.primary } },
      });
      return res.data.id;
    }
    case "update_phone":
      await client.write("PATCH", `/people/v2/phone_numbers/${op.phoneId}`, {
        data: { type: "PhoneNumber", id: op.phoneId, attributes: compact({ number: op.number, location: op.location }) },
      });
      return;
    case "set_primary_phone":
      await client.write("PATCH", `/people/v2/phone_numbers/${op.phoneId}`, { data: { type: "PhoneNumber", id: op.phoneId, attributes: { primary: true } } });
      return;
  }
}

const compact = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const digits = (s: string) => s.replace(/\D/g, "");

function invalid(index: number, message: string) {
  return new ChangeRequestError("invalid_operation", `Operation ${index + 1}: ${message}`, 400);
}
function throwInvalid(index: number, message: string): never {
  throw invalid(index, message);
}
