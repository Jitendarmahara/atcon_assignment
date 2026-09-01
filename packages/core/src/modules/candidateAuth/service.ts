import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../lib/errors.js";
import { env } from "../../config/env.js";
import {
  signCandidateAccessToken,
  signCandidateRefreshToken,
  verifyCandidateRefreshToken,
} from "../../lib/jwt.js";
import { normalizeEmail } from "../../domain/dedupe/normalize.js";
import { notificationsQueue } from "../../queues/definitions.js";

// Structurally match the Zod-inferred types of the same names in
// server/src/modules/candidateAuth/schema.ts - see public/service.ts for why
// these are redeclared here rather than imported across the package boundary.
interface CandidateRegisterInput {
  fullName: string;
  email: string;
  password: string;
}
interface CandidateLoginInput {
  email: string;
  password: string;
}
interface CandidateForgotPasswordInput {
  email: string;
}
interface CandidateResetPasswordInput {
  token: string;
  newPassword: string;
}

const BCRYPT_ROUNDS = 10;
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

function issueTokenPair(account: { id: string; email: string; tokenVersion: number }) {
  const accessToken = signCandidateAccessToken({ sub: account.id, email: account.email });
  const refreshToken = signCandidateRefreshToken({ sub: account.id, tokenVersion: account.tokenVersion });
  return { accessToken, refreshToken };
}

function publicAccount(account: { id: string; email: string; fullName: string; createdAt: Date }) {
  return { id: account.id, email: account.email, fullName: account.fullName, createdAt: account.createdAt };
}

export async function register(input: CandidateRegisterInput) {
  const normalizedEmail = normalizeEmail(input.email);
  const existing = await prisma.candidateAccount.findUnique({ where: { normalizedEmail } });
  if (existing) throw ApiError.conflict("An account with this email already exists");

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const account = await prisma.candidateAccount.create({
    data: { email: input.email, normalizedEmail, fullName: input.fullName, passwordHash },
  });

  return { account: publicAccount(account), ...issueTokenPair(account) };
}

export async function login(input: CandidateLoginInput) {
  const normalizedEmail = normalizeEmail(input.email);
  const account = await prisma.candidateAccount.findUnique({ where: { normalizedEmail } });
  if (!account) throw ApiError.unauthorized("Invalid email or password");

  const valid = await bcrypt.compare(input.password, account.passwordHash);
  if (!valid) throw ApiError.unauthorized("Invalid email or password");

  return { account: publicAccount(account), ...issueTokenPair(account) };
}

export async function refresh(refreshToken: string) {
  let payload;
  try {
    payload = verifyCandidateRefreshToken(refreshToken);
  } catch {
    throw ApiError.unauthorized("Invalid or expired refresh token");
  }

  const account = await prisma.candidateAccount.findUnique({ where: { id: payload.sub } });
  if (!account) throw ApiError.unauthorized("Account no longer exists");
  if (payload.tokenVersion !== account.tokenVersion) {
    throw ApiError.unauthorized("Refresh token has been revoked");
  }

  return issueTokenPair(account);
}

export async function logout(candidateAccountId: string) {
  await prisma.candidateAccount.update({ where: { id: candidateAccountId }, data: { tokenVersion: { increment: 1 } } });
}

export async function me(candidateAccountId: string) {
  const account = await prisma.candidateAccount.findUnique({ where: { id: candidateAccountId } });
  if (!account) throw ApiError.notFound("Account not found");
  return publicAccount(account);
}

// Deliberately bypasses the transactional outbox (events/outbox.ts) that
// every other email in this system goes through: that mechanism exists to
// guarantee a domain event is never silently lost, because for something
// like "an application was submitted" there is no other way for it to ever
// happen again once it's missed. A password-reset email doesn't share that
// property - if it never arrives, the candidate can simply click "forgot
// password" again, so the stronger guarantee isn't buying anything here,
// and OutboxEvent.orgId is NOT NULL besides (a password reset has no single
// org to attribute it to - see CandidateAccount's schema comment). Still
// goes through the same BullMQ queue and gets the same retry/backoff as
// every other outbound email, just enqueued directly rather than via the
// relay - the same pattern candidates/service.ts:rescanDuplicates() already
// uses for another naturally-user-retriable action.
//
// Never reveals whether an email is registered - the response is identical
// either way, so this endpoint can't be used to enumerate accounts.
export async function forgotPassword(input: CandidateForgotPasswordInput) {
  const normalizedEmail = normalizeEmail(input.email);
  const account = await prisma.candidateAccount.findUnique({ where: { normalizedEmail } });
  if (!account) return;

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  await prisma.passwordResetToken.create({
    data: { candidateAccountId: account.id, tokenHash, expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
  });

  const resetUrl = `${env.WEB_ORIGIN}/candidate/reset-password?token=${rawToken}`;
  await notificationsQueue.add("candidate-password-reset", {
    email: account.email,
    fullName: account.fullName,
    resetUrl,
  });
}

// Run nightly from the scheduled-maintenance queue
// (queues/processors/tokenCleanup.ts). An expired row can never be redeemed
// - resetPassword() above already rejects it on expiresAt alone - so once
// expiresAt has passed, the row is pure dead weight: every "forgot
// password" click, used or not, otherwise leaves a permanent row in this
// table forever. Deletes only past-expiry rows (used-but-not-yet-expired
// tokens are left alone; they age out naturally on their own schedule).
export async function purgeExpiredPasswordResetTokens(): Promise<number> {
  const { count } = await prisma.passwordResetToken.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return count;
}

export async function resetPassword(input: CandidateResetPasswordInput) {
  const tokenHash = crypto.createHash("sha256").update(input.token).digest("hex");
  const resetToken = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
  if (!resetToken || resetToken.usedAt || resetToken.expiresAt < new Date()) {
    throw ApiError.badRequest("This password reset link is invalid or has expired");
  }

  const passwordHash = await bcrypt.hash(input.newPassword, BCRYPT_ROUNDS);
  await prisma.$transaction(async (tx) => {
    await tx.candidateAccount.update({
      where: { id: resetToken.candidateAccountId },
      // Bumping tokenVersion here too - same reasoning as logout(): a
      // password reset should invalidate every outstanding refresh token,
      // not just future ones.
      data: { passwordHash, tokenVersion: { increment: 1 } },
    });
    await tx.passwordResetToken.update({ where: { id: resetToken.id }, data: { usedAt: new Date() } });
  });
}
