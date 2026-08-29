import { Queue } from "bullmq";
import { redis } from "../lib/redis.js";

export const QUEUE_NAMES = {
  RESUME_PARSE: "resume-parse",
  EMAIL_SEND: "email-send",
  DEDUPE_SCAN: "dedupe-scan",
  INTERVIEW_REMINDER: "interview-reminder",
  METRICS_ROLLUP: "metrics-rollup",
} as const;

const defaultJobOptions = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 2000 },
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 1000 },
};

// Queue instances (producers) are cheap to share one connection across -
// only Worker instances (consumers, which issue blocking commands) need
// their own dedicated connection. See worker.ts.
function makeQueue(name: string) {
  return new Queue(name, { connection: redis, defaultJobOptions });
}

export const resumeParseQueue = makeQueue(QUEUE_NAMES.RESUME_PARSE);
export const emailSendQueue = makeQueue(QUEUE_NAMES.EMAIL_SEND);
export const dedupeScanQueue = makeQueue(QUEUE_NAMES.DEDUPE_SCAN);
export const interviewReminderQueue = makeQueue(QUEUE_NAMES.INTERVIEW_REMINDER);
export const metricsRollupQueue = makeQueue(QUEUE_NAMES.METRICS_ROLLUP);

export const allQueues = [resumeParseQueue, emailSendQueue, dedupeScanQueue, interviewReminderQueue, metricsRollupQueue];
