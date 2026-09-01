import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../lib/errors.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../../lib/jwt.js";
import { slugify } from "../../lib/slug.js";

// Structurally match the Zod-inferred types of the same names in
// server/src/modules/auth/schema.ts - see public/service.ts for why these
// are redeclared here rather than imported across the package boundary.
interface RegisterInput {
  orgName: string;
  name: string;
  email: string;
  password: string;
}
interface LoginInput {
  email: string;
  password: string;
}
interface InviteUserInput {
  name: string;
  email: string;
  password: string;
  role: "ADMIN" | "RECRUITER" | "HIRING_MANAGER" | "INTERVIEWER";
}

const BCRYPT_ROUNDS = 10;

function issueTokenPair(user: { id: string; orgId: string; role: import("@prisma/client").UserRole; tokenVersion: number }) {
  const accessToken = signAccessToken({ sub: user.id, orgId: user.orgId, role: user.role });
  const refreshToken = signRefreshToken({ sub: user.id, tokenVersion: user.tokenVersion });
  return { accessToken, refreshToken };
}

function publicUser(
  user: {
    id: string;
    orgId: string;
    email: string;
    name: string;
    role: import("@prisma/client").UserRole;
  },
  orgSlug: string,
) {
  return { id: user.id, orgId: user.orgId, orgSlug, email: user.email, name: user.name, role: user.role };
}

// Registration creates a brand-new organization + its first ADMIN user. Every
// subsequent user in that org is created via inviteUser() by an existing admin.
// Email is checked globally, not per-org: login() takes only {email,
// password} with no org selector, so email must be a unique lookup key
// across the whole system (enforced at the DB layer too, as the backstop
// for a concurrent registration with the same email).
export async function register(input: RegisterInput) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw ApiError.conflict("A user with this email already exists");

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  const org = await prisma.organization.create({
    data: {
      name: input.orgName,
      slug: slugify(input.orgName),
      users: {
        create: { name: input.name, email: input.email, passwordHash, role: "ADMIN" },
      },
    },
    include: { users: true },
  });

  const user = org.users[0]!;
  return {
    user: publicUser({ ...user, orgId: org.id }, org.slug),
    ...issueTokenPair({ id: user.id, orgId: org.id, role: user.role, tokenVersion: user.tokenVersion }),
  };
}

export async function inviteUser(orgId: string, actorId: string, input: InviteUserInput) {
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw ApiError.conflict("A user with this email already exists");

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { orgId, name: input.name, email: input.email, passwordHash, role: input.role },
      include: { org: true },
    });
    await tx.auditLog.create({
      data: {
        orgId,
        actorId,
        action: "user.invite",
        entityType: "User",
        entityId: user.id,
        after: { email: user.email, role: user.role },
      },
    });
    return publicUser(user, user.org.slug);
  });
}

export async function login(input: LoginInput) {
  const user = await prisma.user.findFirst({ where: { email: input.email }, include: { org: true } });
  if (!user) throw ApiError.unauthorized("Invalid email or password");

  const valid = await bcrypt.compare(input.password, user.passwordHash);
  if (!valid) throw ApiError.unauthorized("Invalid email or password");

  return { user: publicUser(user, user.org.slug), ...issueTokenPair(user) };
}

export async function refresh(refreshToken: string) {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw ApiError.unauthorized("Invalid or expired refresh token");
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) throw ApiError.unauthorized("User no longer exists");
  // The token's embedded version must match the user's current version -
  // logout() (or a future "sign out everywhere") bumps tokenVersion, which
  // immediately invalidates every refresh token issued before that point,
  // even though the JWT itself is still cryptographically valid and unexpired.
  if (payload.tokenVersion !== user.tokenVersion) {
    throw ApiError.unauthorized("Refresh token has been revoked");
  }

  return issueTokenPair(user);
}

// Revokes every refresh token issued to this user up to now (a single
// "logout" bumps tokenVersion, so it's really "log out everywhere" - there's
// no per-device token tracking, which is a reasonable scope cut for this
// system's size). The caller's access token keeps working until it expires
// on its own (access tokens are short-lived and carry no version check by
// design - only refresh needs revocation since it's what grants a new
// 15-minute window every time).
export async function logout(userId: string) {
  await prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
}

export async function me(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { org: true } });
  if (!user) throw ApiError.notFound("User not found");
  return publicUser(user, user.org.slug);
}

// Used by the "schedule interview" panelist picker - a recruiter needs to
// see who's in their org to assign them, and interview panelist membership
// is what interviews/service.ts now gates scorecard submission and the
// INTERVIEWER role's interview list on.
export async function listOrgUsers(orgId: string) {
  return prisma.user.findMany({
    where: { orgId },
    select: { id: true, name: true, email: true, role: true },
    orderBy: { name: "asc" },
  });
}
