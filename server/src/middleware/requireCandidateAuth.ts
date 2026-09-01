import type { NextFunction, Request, Response } from "express";
import { verifyCandidateAccessToken } from "core/lib/jwt.js";
import { ApiError } from "core/lib/errors.js";

export interface CandidateAuthContext {
  candidateAccountId: string;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      candidateAuth?: CandidateAuthContext;
    }
  }
}

// Deliberately separate from req.auth (requireAuth.ts) - lib/asyncHandler.ts
// only establishes Row-Level Security's org scope when req.auth is set, and
// a candidate has no single org to scope by (see CandidateAccount's schema
// comment), so a request authenticated this way correctly runs unscoped,
// the same as the public careers site and pre-auth recruiter routes.
export function requireCandidateAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    return next(ApiError.unauthorized("Missing bearer token"));
  }
  try {
    const payload = verifyCandidateAccessToken(header.slice("Bearer ".length));
    req.candidateAuth = { candidateAccountId: payload.sub, email: payload.email };
    next();
  } catch {
    next(ApiError.unauthorized("Invalid or expired token"));
  }
}
