import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import type { UserRole } from "@prisma/client";

export interface AccessTokenPayload {
  type: "access";
  sub: string; // user id
  orgId: string;
  role: UserRole;
}

export interface RefreshTokenPayload {
  type: "refresh";
  sub: string;
  tokenVersion: number;
}

// Every payload carries an explicit `type`, checked on verify - not just
// "whichever secret happens to validate it". This is defense-in-depth against
// JWT_ACCESS_SECRET and JWT_REFRESH_SECRET ever being set to the same value
// (env.ts also refuses to boot if they are): without a type claim, a
// refresh token would then verify successfully as an access token, and its
// payload has no orgId/role - which would hand requireAuth an `orgId` of
// `undefined`, and Prisma treats an `undefined` where-clause value as "no
// filter", silently turning an org-scoped query into an unscoped one.
export function signAccessToken(payload: Omit<AccessTokenPayload, "type">): string {
  return jwt.sign({ ...payload, type: "access" }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions["expiresIn"],
  });
}

export function signRefreshToken(payload: Omit<RefreshTokenPayload, "type">): string {
  return jwt.sign({ ...payload, type: "refresh" }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL as jwt.SignOptions["expiresIn"],
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
  if (payload.type !== "access" || !payload.orgId || !payload.role) {
    throw new Error("Not a valid access token");
  }
  return payload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const payload = jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshTokenPayload;
  if (payload.type !== "refresh") {
    throw new Error("Not a valid refresh token");
  }
  return payload;
}
