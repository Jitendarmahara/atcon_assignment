import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";

// Every response carries X-Request-Id, echoing an inbound value if the
// caller already has one (useful for tracing across the public apply flow).
export function requestId(req: Request, res: Response, next: NextFunction) {
  const id = (req.header("x-request-id") ?? randomUUID()).slice(0, 100);
  req.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}
