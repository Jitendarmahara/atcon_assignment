import { createServer } from "node:http";
import { Worker, type Processor } from "bullmq";
import { logger } from "core/lib/logger.js";
import { disconnectPrisma } from "core/lib/prisma.js";
import { createRedisConnection } from "core/lib/redis.js";

// A worker never opens a port for its actual job - nothing ever connects
// INTO a queue consumer, it only makes outbound calls to Redis/Postgres.
// This listener exists purely so a container orchestrator has something to
// ask "is this process's event loop still alive" - the same role
// src/index.ts's GET /health plays for the API. Every worker container in
// docker-compose.prod.yml points its HEALTHCHECK at this port instead of
// inheriting the API's (they share one image, but only the API actually
// listens on 4000 - pointing every container's healthcheck at 4000
// unconditionally was a real bug caught while testing this file: every
// worker container sat permanently unhealthy, which in a real orchestrator
// means an endless kill-and-restart loop on a process that was working
// fine). Container-internal only, never published to the host - the exact
// port number can't collide across *containers*, since each has its own
// network namespace and docker-compose.prod.yml never sets HEALTH_PORT, so
// every container safely uses the same default. Local dev is different: all
// 5 processes share one host network namespace, so each of workers/
// package.json's dev:* scripts sets a distinct HEALTH_PORT (4001-4005) -
// without that, only the first worker to start would ever bind the port and
// the rest would crash on EADDRINUSE (caught exactly this running all 5
// locally for the first time after this port was added).
const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? 4001);

function startHealthServer(): void {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(HEALTH_PORT);
  // Never keeps the process alive on its own - the actual work (BullMQ's
  // Worker, or the relay's interval) does that; this is purely a responder.
  server.unref();
}

// One shared graceful-shutdown implementation for every standalone process
// this app runs besides the HTTP API (index.ts has its own copy of this,
// since it also has to close an HTTP server and SSE connections first).
// Each of the 4 queue workers plus the relay process wires this up
// identically - this is the one place that logic is written, so there are
// 5 callers instead of 5 near-duplicate copies of the same signal handling.
//
// Longer than the API's shutdown window by default: BullMQ's own
// Worker.close() waits up to ~30s for an in-progress job to finish before it
// resolves, so the outer guard here must not fire first and cut that off.
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 35_000;

export function runManagedProcess(opts: {
  name: string;
  onShutdown: () => Promise<void>;
  shutdownTimeoutMs?: number;
}): void {
  const { name, onShutdown, shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS } = opts;
  startHealthServer();
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down ${name}`);

    const forceExit = setTimeout(() => {
      logger.error(`${name}: graceful shutdown timed out, forcing exit`);
      process.exit(1);
    }, shutdownTimeoutMs);
    forceExit.unref();

    try {
      await onShutdown();
      await disconnectPrisma();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (err) {
      logger.error(err, `${name}: error during shutdown`);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    logger.error(err, `${name}: uncaught exception`);
    void shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, `${name}: unhandled rejection`);
    void shutdown("unhandledRejection");
  });
}

// Every queue worker is one process, one queue, one Redis connection
// (BullMQ's requirement - a Worker's blocking commands can't share a
// connection with Queue producers) and its own concurrency tuned to that
// queue's workload.
//
// Horizontal scale for a queue is running this *same* entrypoint as N
// independent OS processes - N terminals locally, or in a real production
// deployment, N pods behind that queue's own Kubernetes Deployment and HPA
// (see docker-compose.prod.yml's header comment for the scaling signals
// that HPA would actually use) - never by raising concurrency within one
// process. Concurrency and replica count
// are different knobs: concurrency buys more in-flight jobs sharing one
// process's event loop and memory; replica count buys independent crash
// isolation and real OS-level parallelism. WORKER_INSTANCE is just this
// process's replica identity for logs, set by whatever launched it - BullMQ
// itself doesn't need it, multiple Workers on the same queue name already
// compete correctly for jobs with no coordination required.
export function runQueueWorker<DataType = unknown, ResultType = unknown, NameType extends string = string>(
  queueName: string,
  processor: Processor<DataType, ResultType, NameType>,
  concurrency: number,
): void {
  const instanceId = process.env.WORKER_INSTANCE;
  const label = instanceId ? `${queueName}#${instanceId}` : queueName;

  const worker = new Worker<DataType, ResultType, NameType>(queueName, processor, {
    connection: createRedisConnection(),
    concurrency,
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, queue: queueName, replica: instanceId, attempts: job?.attemptsMade, err }, "job failed");
  });
  worker.on("completed", (job) => {
    logger.info({ jobId: job.id, queue: queueName, replica: instanceId }, "job completed");
  });

  logger.info(`Worker process started for queue "${label}" (concurrency=${concurrency})`);

  runManagedProcess({ name: `${label} worker`, onShutdown: () => worker.close() });
}
