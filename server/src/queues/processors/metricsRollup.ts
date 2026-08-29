import type { Job } from "bullmq";
import { prisma } from "../../lib/prisma.js";
import { computeAndStoreRollups } from "../../modules/analytics/service.js";

// Repeatable nightly job (scheduled in worker.ts). Snapshots every org's
// analytics into MetricsRollup - the scale-out path for the live-SQL
// analytics endpoints once dataset size makes querying StageEvent directly
// on every request too slow. Not required at this dataset size, included to
// demonstrate the pattern.
export async function processMetricsRollup(_job: Job) {
  const orgs = await prisma.organization.findMany({ select: { id: true } });
  for (const org of orgs) {
    await computeAndStoreRollups(org.id);
  }
}
