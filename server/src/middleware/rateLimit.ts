import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../lib/errors.js";

// Minimal fixed-window limiter backed by Redis (via INCR + EXPIRE) - enough to
// demonstrate abuse protection on auth and the public apply endpoint without
// pulling in a full library. Not distributed-clock-safe at the edges; fine at
// this scale, called out in ASSUMPTIONS.md.
import { redis } from "../lib/redis.js";

export function rateLimit(opts: { windowSec: number; max: number; keyPrefix: string }) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const ip = req.ip ?? "unknown";
    const key = `ratelimit:${opts.keyPrefix}:${ip}`;
    try {
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, opts.windowSec);
      }
      if (count > opts.max) {
        return next(ApiError.tooMany());
      }
      next();
    } catch {
      // Redis unavailable: fail open rather than blocking the whole API.
      next();
    }
  };
}
