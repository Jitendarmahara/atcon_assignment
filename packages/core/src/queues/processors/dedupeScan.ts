import type { Job } from "bullmq";
import { scanFullDuplicatesForCandidate } from "../../domain/dedupe/scan.js";

// On-demand full rescan, triggered by POST /candidates/:candidateId/rescan-duplicates
// (candidates/service.ts:rescanDuplicates). The inline scan after resume parsing
// (queues/processors/resumeParse.ts) covers the common path; this queue exists
// so a recruiter can re-check a candidate after editing their info, without
// needing a new resume upload to trigger it. Its own queue, deliberately not
// merged with resume-parse - see queues/definitions.ts for why.
export async function processDedupeScan(job: Job<{ orgId: string; candidateId: string }>) {
  await scanFullDuplicatesForCandidate(job.data.orgId, job.data.candidateId);
}
