import "dotenv/config";
import { z } from "zod";

// Fail fast at boot rather than surfacing a cryptic error deep in a request handler.
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Same database, connected as the unprivileged `ats_app` role that
  // Postgres Row-Level Security actually restricts (see migration
  // 20260829213000_row_level_security) - used for every authenticated
  // request (lib/asyncHandler.ts). DATABASE_URL itself keeps its existing,
  // unrestricted role for pre-auth flows, the public careers site, the
  // worker/relay, and the seed script.
  SCOPED_DATABASE_URL: z.string().min(1, "SCOPED_DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  JWT_ACCESS_SECRET: z.string().min(16, "JWT_ACCESS_SECRET must be at least 16 chars"),
  JWT_REFRESH_SECRET: z.string().min(16, "JWT_REFRESH_SECRET must be at least 16 chars"),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("7d"),

  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_FROM: z.string().default("ATS Platform <no-reply@ats.local>"),

  STORAGE_DIR: z.string().default("./storage/resumes"),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(10),

  WEB_ORIGIN: z.string().default("http://localhost:5173"),

  ANTHROPIC_API_KEY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

// If these were ever equal, a refresh token would successfully verify as an
// access token (see lib/jwt.ts) - fail fast here rather than depend solely
// on the type-claim check to catch a misconfiguration like this.
if (parsed.data.JWT_ACCESS_SECRET === parsed.data.JWT_REFRESH_SECRET) {
  console.error("❌ JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values");
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
