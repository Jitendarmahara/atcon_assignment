import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { EVENT_TYPES } from "./types.js";
import type {
  ApplicationStageChangedPayload,
  ApplicationSubmittedPayload,
  InterviewScheduledPayload,
  ResumeUploadedPayload,
} from "./types.js";
import { notificationsQueue, resumeParseQueue } from "../queues/definitions.js";

// This is now a backstop, not the primary dispatch path - see
// dispatchNowBestEffort() below, called directly from the write path right
// after each transaction that writes an outbox row commits. A tick only
// needs to catch whatever that fast path missed (a crash, a Redis blip, a
// dispatch that failed silently) - see ARCHITECTURE.md's "Transactional
// outbox" section for the reasoning on why 5 minutes is safe here: the
// durability guarantee never depended on the poll interval, only on the row
// existing in Postgres, so slowing this down changes worst-case latency for
// a missed fast-path attempt, never correctness.
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const BATCH_SIZE = 20;
const MAX_ATTEMPTS = 8;
// How long a row can sit PROCESSING before another tick is allowed to
// reclaim it. Acts as a crash lease: if the process dies between claiming a
// row and marking it SENT/FAILED, the row isn't stuck forever - it just
// waits out the lease. Comfortably longer than any single dispatch() call
// should ever take.
const PROCESSING_LEASE_MS = 60_000;

interface OutboxRow {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
}

// Fans a durably-committed domain event out to the right BullMQ queue(s).
// jobId is derived from the outbox row id so a relay crash-and-restart
// between "enqueue succeeded" and "mark SENT" produces a duplicate add()
// call that BullMQ simply dedupes, instead of a duplicate email/parse job.
// That same idempotency is exactly what makes it safe for both
// dispatchNowBestEffort() (the fast path, below) and a poll tick to
// occasionally both attempt this for the same row - never a duplicate job.
export async function dispatch(event: OutboxRow) {
  switch (event.type) {
    case EVENT_TYPES.RESUME_UPLOADED: {
      await resumeParseQueue.add("parse", event.payload as ResumeUploadedPayload, { jobId: `resume-parse-${event.id}` });
      return;
    }
    case EVENT_TYPES.APPLICATION_SUBMITTED: {
      await notificationsQueue.add("application-confirmation", event.payload as ApplicationSubmittedPayload, {
        jobId: `app-confirm-${event.id}`,
      });
      return;
    }
    case EVENT_TYPES.APPLICATION_STAGE_CHANGED: {
      const payload = event.payload as ApplicationStageChangedPayload;
      // Only HIRED/REJECTED are candidate-facing emails; every stage change
      // still produces an in-app notification (handled inside the processor).
      await notificationsQueue.add("stage-changed-notify", payload, { jobId: `stage-notify-${event.id}` });
      return;
    }
    case EVENT_TYPES.INTERVIEW_SCHEDULED: {
      const payload = event.payload as InterviewScheduledPayload;
      await notificationsQueue.add("interview-invite", payload, { jobId: `interview-invite-${event.id}` });

      const interview = await prisma.interview.findUnique({ where: { id: payload.interviewId } });
      if (interview) {
        const delay = Math.max(0, interview.scheduledAt.getTime() - 24 * 60 * 60 * 1000 - Date.now());
        await notificationsQueue.add(
          "remind",
          { interviewId: payload.interviewId },
          { delay, jobId: `interview-remind-${event.id}` },
        );
      }
      return;
    }
    default:
      logger.warn({ type: event.type }, "outbox relay: no handler registered for event type");
  }
}

// One tick, in two phases:
//
// 1. Claim up to BATCH_SIZE eligible rows with FOR UPDATE SKIP LOCKED (so a
//    second relay instance, or worker.ts and a future horizontally-scaled
//    copy of it, never double-claims the same row) and flip them to
//    PROCESSING with a short lease. This transaction only ever does Postgres
//    work, so it holds its row locks and connection for milliseconds.
// 2. Dispatch each claimed row OUTSIDE any transaction. Dispatch means a
//    network call to Redis (BullMQ's queue.add()), which can legitimately
//    hang for a while under a real Redis outage - it must never do that
//    while holding a DB transaction/connection hostage, or a Redis blip
//    starves Prisma's connection pool for the whole API process.
//
// A row that's claimed but never reaches SENT/FAILED (process crash, or a
// dispatch call that's still hanging) simply falls back to eligible once its
// PROCESSING_LEASE_MS lease expires - see the WHERE clause below.
export async function relayOnce(): Promise<number> {
  const rows = await prisma.$transaction(async (tx) => {
    const claimed = await tx.$queryRaw<OutboxRow[]>`
      SELECT id, type, payload, attempts
      FROM outbox_events
      WHERE "availableAt" <= now()
        AND (status = 'PENDING' OR status = 'PROCESSING')
      ORDER BY "createdAt" ASC
      LIMIT ${BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    `;
    if (claimed.length > 0) {
      await tx.outboxEvent.updateMany({
        where: { id: { in: claimed.map((r) => r.id) } },
        data: { status: "PROCESSING", availableAt: new Date(Date.now() + PROCESSING_LEASE_MS) },
      });
    }
    return claimed;
  });

  for (const row of rows) {
    try {
      await dispatch(row);
      await prisma.outboxEvent.update({ where: { id: row.id }, data: { status: "SENT" } });
    } catch (err) {
      const attempts = row.attempts + 1;
      const backoffMs = Math.min(2 ** attempts * 1000, 5 * 60 * 1000);
      await prisma.outboxEvent.update({
        where: { id: row.id },
        data: {
          attempts,
          lastError: err instanceof Error ? err.message : String(err),
          status: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING",
          availableAt: new Date(Date.now() + backoffMs),
        },
      });
      logger.error({ err, eventId: row.id, type: row.type, attempts }, "outbox relay: dispatch failed");
    }
  }

  return rows.length;
}

// The fast path: called directly from the write path (applications/,
// interviews/, candidates/ services) right after the transaction that wrote
// `row` commits, instead of only ever waiting for the next poll tick.
// Deliberately fire-and-forget - the caller must never await this into its
// response, and a failure here must never surface to the request that
// triggered it:
//   - On success, the row is marked SENT immediately - typically dispatched
//     within milliseconds of the write, not up to POLL_INTERVAL_MS later.
//   - On failure (Redis down, a crash mid-call, anything), this does nothing
//     further - no retry/backoff bookkeeping here, because relayOnce()'s
//     poll tick already owns that. The row is simply left PENDING, exactly
//     as if this fast path had never been attempted at all, and the next
//     tick's normal claim-and-retry logic picks it up from there.
// This never introduces a duplicate job even if a poll tick's claim and this
// fast path race on the same row (possible but very unlikely, since a
// successful call here almost always completes long before the next tick
// fires) - dispatch()'s deterministic jobId makes a second attempt at the
// same event a safe no-op in BullMQ.
export function dispatchNowBestEffort(row: OutboxRow): void {
  dispatch(row)
    .then(() => prisma.outboxEvent.update({ where: { id: row.id }, data: { status: "SENT" } }))
    .catch((err) => {
      logger.warn({ err, eventId: row.id, type: row.type }, "outbox: immediate dispatch failed, will retry on next relay tick");
    });
}

export function startRelay(): () => void {
  // Guards against overlapping ticks: if a tick is still dispatching (e.g.
  // a slow Redis) when the next interval fires, skip that firing rather than
  // starting a second concurrent pass over the same lease window.
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    relayOnce()
      .catch((err) => logger.error({ err }, "outbox relay: tick failed"))
      .finally(() => {
        inFlight = false;
      });
  }, POLL_INTERVAL_MS);
  return () => clearInterval(timer);
}
