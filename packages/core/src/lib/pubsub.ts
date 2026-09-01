import { EventEmitter } from "node:events";
import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

// Backs live updates for the kanban board and the notification bell (see
// docs/ASSUMPTIONS.md - this used to be "no real-time push, polling only").
// Built on Redis pub/sub rather than an in-process EventEmitter alone so it
// scales the same way the rest of this system already does: any number of
// API instances behind a load balancer each subscribe independently, and a
// change made against one instance is seen by clients connected to any
// other instance, not just the one that handled the write.

export interface OrgEvent {
  type: string;
  payload: Record<string, unknown>;
}

const CHANNEL_PATTERN = "org:*:events";

// A Redis connection that issues (P)SUBSCRIBE can only be used for pub/sub
// commands afterward - kept separate from `lib/redis.ts`'s general-purpose
// client (rate limiting, BullMQ) and from the plain `publish()` caller,
// which needs an ordinary connection.
const publisher = new Redis(env.REDIS_URL);
const subscriber = new Redis(env.REDIS_URL);

// Fanned out in-process to however many SSE connections this instance is
// holding open, keyed by orgId - one Redis subscription total per process,
// not one per connected browser tab.
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let subscribed = false;
function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  subscriber.psubscribe(CHANNEL_PATTERN).catch((err) => logger.error({ err }, "pubsub: psubscribe failed"));
  subscriber.on("pmessage", (_pattern: string, channel: string, message: string) => {
    const orgId = channel.split(":")[1];
    if (!orgId) return;
    try {
      emitter.emit(orgId, JSON.parse(message) as OrgEvent);
    } catch (err) {
      logger.error({ err, channel }, "pubsub: failed to parse message");
    }
  });
}

export async function publishOrgEvent(orgId: string, event: OrgEvent): Promise<void> {
  try {
    await publisher.publish(`org:${orgId}:events`, JSON.stringify(event));
  } catch (err) {
    // Best-effort: a live-update push is a UX nicety, not a source of truth
    // (the underlying data is already durably committed via Prisma/the
    // outbox before this is ever called) - a Redis hiccup here should never
    // fail the request that triggered it.
    logger.error({ err, orgId, type: event.type }, "pubsub: publish failed");
  }
}

export function subscribeOrgEvents(orgId: string, onEvent: (event: OrgEvent) => void): () => void {
  ensureSubscribed();
  emitter.on(orgId, onEvent);
  return () => emitter.off(orgId, onEvent);
}

export async function closePubSub(): Promise<void> {
  subscriber.disconnect();
  publisher.disconnect();
}
