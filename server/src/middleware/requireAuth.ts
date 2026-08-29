import type { NextFunction, Request, Response } from "express";
import type { UserRole } from "@prisma/client";
import { verifyAccessToken } from "../lib/jwt.js";
import { ApiError } from "../lib/errors.js";

export interface AuthContext {
  userId: string;
  orgId: string;
  role: UserRole;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    return next(ApiError.unauthorized("Missing bearer token"));
  }
  try {
    const payload = verifyAccessToken(header.slice("Bearer ".length));
    req.auth = { userId: payload.sub, orgId: payload.orgId, role: payload.role };
    next();
  } catch {
    next(ApiError.unauthorized("Invalid or expired token"));
  }
}

// Every non-public route is org-scoped through req.auth.orgId - services never
// trust a client-supplied orgId, closing off cross-tenant access by construction.
export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(ApiError.unauthorized());
    if (!roles.includes(req.auth.role)) {
      return next(ApiError.forbidden(`Requires one of roles: ${roles.join(", ")}`));
    }
    next();
  };
}
