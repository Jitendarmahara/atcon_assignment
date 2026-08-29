import { env } from "./config/env.js";
import { createApp } from "./app.js";
import { logger } from "./lib/logger.js";
import { disconnectPrisma } from "./lib/prisma.js";
import { closePubSub } from "./lib/pubsub.js";
import { markShuttingDown } from "./lib/shutdownState.js";
import { closeAllStreams } from "./modules/realtime/stream.js";

// Give in-flight requests a chance to finish before the process is killed
// (orchestrators like Docker/k8s send SIGTERM, then SIGKILL after a grace
// period - this needs to land well inside that window).
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main() {
  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`API listening on http://localhost:${env.PORT}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    // A second signal (or an uncaughtException arriving mid-shutdown)
    // shouldn't re-enter this and double-close things.
    if (shuttingDown) return;
    shuttingDown = true;
    markShuttingDown();
    logger.info(`${signal} received, shutting down`);

    const forceExit = setTimeout(() => {
      logger.error("graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      // SSE connections (modules/realtime/stream.ts) are held open
      // indefinitely by design - end them explicitly first, or
      // server.close()'s callback below would never fire on its own while
      // even one browser tab is still connected.
      closeAllStreams();
      // Stop accepting new connections and wait for in-flight requests to
      // finish - unlike the old fire-and-forget server.close(), nothing here
      // disconnects Prisma out from under a request that's still running.
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await disconnectPrisma();
      await closePubSub();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (err) {
      logger.error(err, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // SIGKILL can never be caught (by this or any process) - draining on
  // SIGTERM within the orchestrator's kill grace period is the only lever.
  process.on("uncaughtException", (err) => {
    logger.error(err, "uncaught exception");
    void shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "unhandled rejection");
    void shutdown("unhandledRejection");
  });
}

main().catch((err) => {
  logger.error(err, "fatal startup error");
  process.exit(1);
});
