import type { Job } from "bullmq";
import { processMetricsRollup } from "./metricsRollup.js";
import { processTokenCleanup } from "./tokenCleanup.js";

// Two independent nightly jobs sharing one queue/worker - both are
// "recurring, time-based maintenance" with no meaningful volume, so there's
// no reason to give either its own process. See workers/scheduledMaintenance.ts
// for the repeatable-job registrations.
export async function processScheduledMaintenance(job: Job) {
  switch (job.name) {
    case "metrics-rollup":
      return processMetricsRollup(job);
    case "cleanup-expired-tokens":
      return processTokenCleanup(job);
    default:
      return;
  }
}
