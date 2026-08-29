// Named import, not default: ioredis's CJS default-export typing doesn't
// resolve cleanly under NodeNext module resolution, but its named re-export
// of the same class does.
import { Redis } from "ioredis";
import { env } from "../config/env.js";

// BullMQ requires this exact option; shared across all queues/workers.
export function createRedisConnection() {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

export const redis = createRedisConnection();
