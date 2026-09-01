import { Queue } from "bullmq";
import { redis } from "../lib/redis.js";

// 4 queues, grouped by workload shape, not by event type - each queue's job
// types share a bottleneck and a worker pool:
//   - resume-parse: extract + structure a resume, including an external LLM
//     call (DeepSeek/Claude) that can be slow or rate-limited. Kept separate
//     from dedupe-scan deliberately - they're both "figure out what's true
//     about this candidate" conceptually, but merging them would let a burst
//     of slow LLM calls starve dedupe-scan's worker pool even though
//     dedupe-scan itself has no external dependency and normally finishes in
//     milliseconds. Different bottleneck, different queue.
//   - dedupe-scan: on-demand full rescan (POST /candidates/:id/rescan-
//     duplicates) - local, deterministic, Postgres-only, human-triggered so
//     inherently low volume.
//   - notifications: everything that reaches a person - outbound email and
//     the (delayed) interview reminder - genuinely share a bottleneck (SMTP,
//     fast, no external LLM), so these two ARE merged.
//   - scheduled-maintenance: the nightly rollup today; the landing spot for
//     any future cron-shaped/cleanup job.
export const QUEUE_NAMES = {
  RESUME_PARSE: "resume-parse",
  DEDUPE_SCAN: "dedupe-scan",
  NOTIFICATIONS: "notifications",
  SCHEDULED_MAINTENANCE: "scheduled-maintenance",
} as const;

const defaultJobOptions = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 2000 },
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 1000 },
};

// Queue instances (producers) are cheap to share one connection across -
// only Worker instances (consumers, which issue blocking commands) need
// their own dedicated connection. See workers/shared.ts.
function makeQueue(name: string) {
  return new Queue(name, { connection: redis, defaultJobOptions });
}

export const resumeParseQueue = makeQueue(QUEUE_NAMES.RESUME_PARSE);
export const dedupeScanQueue = makeQueue(QUEUE_NAMES.DEDUPE_SCAN);
export const notificationsQueue = makeQueue(QUEUE_NAMES.NOTIFICATIONS);
export const scheduledMaintenanceQueue = makeQueue(QUEUE_NAMES.SCHEDULED_MAINTENANCE);

export const allQueues = [resumeParseQueue, dedupeScanQueue, notificationsQueue, scheduledMaintenanceQueue];
