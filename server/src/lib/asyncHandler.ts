import type { NextFunction, Request, RequestHandler, Response } from "express";
import { runWithOrgScope } from "./prisma.js";

// Express 4 doesn't await handlers - this forwards rejected promises to
// errorHandler.ts instead of crashing the process or hanging the request.
//
// Every authenticated request (req.auth set by requireAuth, which always
// runs before this) additionally runs inside runWithOrgScope() - this is the
// single place that establishes Row-Level Security's per-request org
// context, so every route handler in the app gets it automatically with no
// per-route wiring. A request with no req.auth (public routes, and
// register/login/refresh before there's an org to scope by) runs unscoped,
// exactly as before RLS existed.
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    const run = req.auth ? runWithOrgScope(req.auth.orgId, () => fn(req, res, next)) : fn(req, res, next);
    run.catch(next);
  };
}
