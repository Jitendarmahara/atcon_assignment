import type { UserRole } from "@prisma/client";

// core and server compile as separate tsc projects, so a `declare global`
// augmentation in one is invisible to the other - this file exists purely
// so core's own lib/asyncHandler.ts can see req.auth's shape. The values are
// still only ever set by server/src/middleware/{requireAuth,
// requireCandidateAuth,requestId}.ts, which declare this identical
// augmentation for their own project; this is the accepted duplication for
// two independently-compiled packages sharing one ambient type, not a
// second source of truth for the auth logic itself.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: { userId: string; orgId: string; role: UserRole };
      candidateAuth?: { candidateAccountId: string; email: string };
      requestId: string;
    }
  }
}
