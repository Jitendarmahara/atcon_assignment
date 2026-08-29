import type { Prisma } from "@prisma/client";
import type { EventType } from "./types.js";

type TxClient = Prisma.TransactionClient;

// Write inside the SAME transaction as the domain change. This is the
// reliability guarantee: if the transaction rolls back, the event never
// existed; if it commits, the event is durably queued for the relay to pick
// up even if Redis is down at that exact moment.
//
// Every event payload defined in events/types.ts carries orgId - pulled out
// into its own column (rather than left buried in the JSON payload) so this
// table can be RLS-scoped and tenant-filtered like every other table, and so
// GET /api/v1/admin/queues's dead-letter listing can be scoped to the
// caller's own org instead of every org's.
export async function writeOutboxEvent(tx: TxClient, type: EventType, payload: { orgId: string } & Record<string, unknown>) {
  await tx.outboxEvent.create({ data: { type, orgId: payload.orgId, payload: payload as never } });
}
