import { QUEUE_NAMES, scheduledMaintenanceQueue } from "core/queues/definitions.js";
import { processScheduledMaintenance } from "core/queues/processors/scheduledMaintenance.js";
import { runQueueWorker } from "./shared.js";

// Repeatable jobs registered once per process start; BullMQ dedupes by
// jobId, so a restart (deploy, crash-restart) never creates a second
// schedule. Staggered an hour apart - not required (concurrency 1 already
// means they'd just queue back-to-back if they landed at the same minute),
// but keeps each one's run easy to find in logs.
void scheduledMaintenanceQueue.add(
  "metrics-rollup",
  {},
  { repeat: { pattern: "0 2 * * *" }, jobId: "metrics-rollup-nightly" },
);
void scheduledMaintenanceQueue.add(
  "cleanup-expired-tokens",
  {},
  { repeat: { pattern: "0 3 * * *" }, jobId: "token-cleanup-nightly" },
);

// Exactly 1 replica, always: neither job here has real volume, and the
// rollup specifically must never overlap itself.
runQueueWorker(QUEUE_NAMES.SCHEDULED_MAINTENANCE, processScheduledMaintenance, 1);
