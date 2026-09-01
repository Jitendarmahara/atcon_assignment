import { logger } from "core/lib/logger.js";
import { startRelay } from "core/events/relay.js";
import { runManagedProcess } from "./shared.js";

// The outbox relay isn't tied to any one queue - relayOnce() can dispatch to
// any of the 5 depending on what's pending - so it gets its own dedicated
// process rather than being bolted onto one of the queue workers. That also
// means it scales and restarts independently: a slow Postgres poll never
// competes with a queue worker's event loop, and redeploying this process
// alone can't stall any queue's throughput.
//
// Shorter shutdown budget than a queue worker: there's no in-flight BullMQ
// job to wait out here, only the current poll tick (bounded by however long
// a single relayOnce() batch takes to dispatch, which is small - see
// events/relay.ts).
const RELAY_SHUTDOWN_TIMEOUT_MS = 10_000;

const stopRelay = startRelay();
logger.info("Relay process started");

runManagedProcess({
  name: "outbox relay",
  onShutdown: async () => stopRelay(),
  shutdownTimeoutMs: RELAY_SHUTDOWN_TIMEOUT_MS,
});
