import { beforeEach, afterAll } from "vitest";
import { prisma, disconnectPrisma } from "core/lib/prisma.js";
import { redis } from "core/lib/redis.js";
import { closePubSub } from "core/lib/pubsub.js";

const TABLES = [
  "scorecard_ratings", "scorecards", "interview_panelists", "interviews",
  "stage_events", "applications", "duplicate_candidate_links", "resumes", "candidates",
  "job_stages", "jobs", "notifications", "audit_logs", "outbox_events", "metrics_rollups",
  "users", "organizations", "password_reset_tokens", "candidate_accounts",
];

async function truncateAll() {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`);
}

// Full-table truncation before every test rather than per-test transactions:
// simpler to reason about across the Prisma $transaction calls inside the
// services under test (a wrapping test-transaction would make those nested
// transactions behave differently than they do in production).
//
// Also flush Redis (REDIS_URL points at logical DB 1, dedicated to tests -
// see .env.test - so this never touches dev/demo data): otherwise the
// fixed-window rate limiter's INCR counters survive across test runs, and
// tests exercising /auth/* or the public apply endpoint several times per
// run could start failing with a spurious 429 depending on how many times
// the suite was already run within the current window, not on anything the
// test itself is asserting.
beforeEach(async () => {
  await truncateAll();
  await redis.flushdb();
});

afterAll(async () => {
  await disconnectPrisma();
  redis.disconnect();
  await closePubSub();
});
