import { QUEUE_NAMES } from "core/queues/definitions.js";
import { processResumeParse } from "core/queues/processors/resumeParse.js";
import { runQueueWorker } from "./shared.js";

// Concurrency 1: parallelism for this queue comes from running N replicas
// of this same process, not from concurrent jobs sharing one process - see
// shared.ts. 1 replica today (no real load to justify more); this is the
// queue most likely to need replicas first if that changes, since resume
// parsing calls out to an LLM with unpredictable latency - in Kubernetes,
// its own Deployment + HPA, scaled primarily on this queue's depth rather
// than CPU (an LLM call is I/O-bound; a backlog doesn't show up as CPU).
// No code change required either way, just a replica count.
runQueueWorker(QUEUE_NAMES.RESUME_PARSE, processResumeParse, 1);
