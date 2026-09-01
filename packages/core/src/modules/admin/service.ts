import { prisma } from "../../lib/prisma.js";
import { allQueues } from "../../queues/definitions.js";

// Surfaces both layers of the reliability pipeline: BullMQ's own queue
// depths (global/system-wide by nature - BullMQ queues aren't per-tenant,
// they process every org's jobs), and the outbox table's FAILED rows for
// the CALLER'S OWN org (the dead-letter queue for events that exhausted
// MAX_ATTEMPTS in events/relay.ts) - each row's JSON payload can carry
// another org's candidateId/applicationId/etc., so this must never mix orgs.
export async function getQueueStatus(orgId: string) {
  const bullmq = await Promise.all(
    allQueues.map(async (q) => ({
      name: q.name,
      waiting: await q.getWaitingCount(),
      active: await q.getActiveCount(),
      delayed: await q.getDelayedCount(),
      failed: await q.getFailedCount(),
      completed: await q.getCompletedCount(),
    })),
  );

  const outboxByStatus = await prisma.outboxEvent.groupBy({ by: ["status"], where: { orgId }, _count: { _all: true } });
  const deadLetter = await prisma.outboxEvent.findMany({
    where: { orgId, status: "FAILED" },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return {
    bullmq,
    outbox: {
      counts: Object.fromEntries(outboxByStatus.map((r) => [r.status, r._count._all])),
      deadLetter,
    },
  };
}
