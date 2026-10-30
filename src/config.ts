import { z } from "zod";

const PLACEHOLDER = /^replace/i;
const notPlaceholder = (name: string) =>
  z.string().min(1).refine((v) => !PLACEHOLDER.test(v), { message: `${name} still has its placeholder value` });

const base64Key = (name: string) =>
  notPlaceholder(name).refine((v) => Buffer.from(v, "base64").length === 32, {
    message: `${name} must be 32 bytes, base64-encoded (run: npm run gen:key)`,
  });

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    PUBLIC_BASE_URL: z.url(),
    DATABASE_PATH: z.string().min(1).default("./data/integrations.db"),
    DEFAULT_ORG_SLUG: z.string().regex(/^[a-z0-9-]+$/).default("cityhope"),
    DEFAULT_ORG_NAME: z.string().min(1).default("City Hope Church"),
    INTERNAL_API_KEY: notPlaceholder("INTERNAL_API_KEY").refine((v) => v.length >= 32, {
      message: "INTERNAL_API_KEY must be at least 32 characters",
    }),
    TOKEN_ENCRYPTION_KEY: base64Key("TOKEN_ENCRYPTION_KEY"),
    TOKEN_ENCRYPTION_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).default("k1"),
    TOKEN_ENCRYPTION_KEY_PREVIOUS: z.string().optional().default(""),
    TOKEN_ENCRYPTION_KEY_PREVIOUS_ID: z.string().optional().default(""),
    PCO_CLIENT_ID: notPlaceholder("PCO_CLIENT_ID"),
    PCO_CLIENT_SECRET: notPlaceholder("PCO_CLIENT_SECRET"),
    PCO_USER_AGENT: z.string().min(8),
    PCO_EXPECTED_ORGANIZATION_ID: z.string().optional().default(""),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === "production" && !c.PUBLIC_BASE_URL.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["PUBLIC_BASE_URL"], message: "must be https in production" });
    }
    if (c.TOKEN_ENCRYPTION_KEY_PREVIOUS && Buffer.from(c.TOKEN_ENCRYPTION_KEY_PREVIOUS, "base64").length !== 32) {
      ctx.addIssue({ code: "custom", path: ["TOKEN_ENCRYPTION_KEY_PREVIOUS"], message: "must be 32 bytes base64" });
    }
    if (c.TOKEN_ENCRYPTION_KEY_PREVIOUS && !c.TOKEN_ENCRYPTION_KEY_PREVIOUS_ID) {
      ctx.addIssue({ code: "custom", path: ["TOKEN_ENCRYPTION_KEY_PREVIOUS_ID"], message: "required with previous key" });
    }
  });

export type Config = z.infer<typeof schema> & { PCO_REDIRECT_URI: string };

/** Validates env at startup. Error messages name variables but never echo their values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${problems}\nSee .env.example.`);
  }
  const c = parsed.data;
  const base = c.PUBLIC_BASE_URL.replace(/\/+$/, "");
  return { ...c, PUBLIC_BASE_URL: base, PCO_REDIRECT_URI: `${base}/v1/integrations/planning-center/callback` };
}
