import { Worker } from "bullmq";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { disconnectPrisma } from "./lib/prisma.js";
import { createRedisConnection } from "./lib/redis.js";
import { startRelay } from "./events/relay.js";
import { QUEUE_NAMES, metricsRollupQueue } from "./queues/definitions.js";
import { processResumeParse } from "./queues/processors/resumeParse.js";
import { processEmailSend } from "./queues/processors/emailSend.js";
import { processDedupeScan } from "./queues/processors/dedupeScan.js";
import { processInterviewReminder } from "./queues/processors/interviewReminder.js";
import { processMetricsRollup } from "./queues/processors/metricsRollup.js";

// Separate process from the HTTP API (run via `pnpm dev:worker` /
// `node dist/worker.js`) so a slow resume parse or an LLM call never blocks
// a single request-handling event loop. Each Worker gets its own Redis
// connection (BullMQ's requirement - blocking BRPOPLPUSH-style commands
// can't share a connection with Queue producers).

// Longer than the API's shutdown window: BullMQ's own Worker.close() waits
// up to ~30s for an in-progress job to finish before it resolves, so the
// outer guard here must not fire first and cut that off.
const SHUTDOWN_TIMEOUT_MS = 35_000;

function main() {
  const stopRelay = startRelay();

  const workers = [
    new Worker(QUEUE_NAMES.RESUME_PARSE, processResumeParse, { connection: createRedisConnection(), concurrency: 4 }),
    new Worker(QUEUE_NAMES.EMAIL_SEND, processEmailSend, { connection: createRedisConnection(), concurrency: 4 }),
    new Worker(QUEUE_NAMES.DEDUPE_SCAN, processDedupeScan, { connection: createRedisConnection(), concurrency: 2 }),
    new Worker(QUEUE_NAMES.INTERVIEW_REMINDER, processInterviewReminder, { connection: createRedisConnection(), concurrency: 2 }),
    new Worker(QUEUE_NAMES.METRICS_ROLLUP, processMetricsRollup, { connection: createRedisConnection(), concurrency: 1 }),
  ];

  for (const worker of workers) {
    worker.on("failed", (job, err) => {
      logger.error({ jobId: job?.id, queue: worker.name, attempts: job?.attemptsMade, err }, "job failed");
    });
    worker.on("completed", (job) => {
      logger.info({ jobId: job.id, queue: worker.name }, "job completed");
    });
  }

  // Nightly rollup - repeatable job registered once; BullMQ dedupes by jobId
  // so restarting the worker doesn't create a second schedule.
  void metricsRollupQueue.add(
    "nightly",
    {},
    { repeat: { pattern: "0 2 * * *" }, jobId: "metrics-rollup-nightly" },
  );

  logger.info(`Worker process started (env=${env.NODE_ENV})`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down worker`);

    const forceExit = setTimeout(() => {
      logger.error("worker graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      stopRelay();
      await Promise.all(workers.map((w) => w.close()));
      await disconnectPrisma();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (err) {
      logger.error(err, "error during worker shutdown");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    logger.error(err, "uncaught exception in worker");
    void shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "unhandled rejection in worker");
    void shutdown("unhandledRejection");
  });
}

main();
