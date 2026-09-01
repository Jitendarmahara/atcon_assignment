import { QUEUE_NAMES } from "core/queues/definitions.js";
import { processNotifications } from "core/queues/processors/notifications.js";
import { runQueueWorker } from "./shared.js";

// 1 replica today; scales independently of every other queue - its own
// Deployment + HPA in Kubernetes - if volume ever justifies it (every
// application submit, stage change, and interview schedule fans out an
// email here) - see shared.ts.
runQueueWorker(QUEUE_NAMES.NOTIFICATIONS, processNotifications, 1);
