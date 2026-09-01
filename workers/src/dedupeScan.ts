import { QUEUE_NAMES } from "core/queues/definitions.js";
import { processDedupeScan } from "core/queues/processors/dedupeScan.js";
import { runQueueWorker } from "./shared.js";

// 1 replica: human-triggered (a recruiter clicking "rescan"), inherently
// low volume - see shared.ts for the replica-vs-concurrency split.
runQueueWorker(QUEUE_NAMES.DEDUPE_SCAN, processDedupeScan, 1);
