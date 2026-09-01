import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../lib/errors.js";
import { toPage } from "../../lib/pagination.js";

export async function listDuplicates(orgId: string, params: { cursor?: string; limit: number }) {
  // A link only stores candidate ids, not orgId directly - scope through the
  // candidate relation so cross-tenant links can never surface here.
  const rows = await prisma.duplicateCandidateLink.findMany({
    where: { status: "PENDING", candidateA: { orgId } },
    orderBy: { id: "asc" },
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    include: { candidateA: true, candidateB: true },
  });
  return toPage(rows, params.limit);
}

async function findOwnedLink(orgId: string, linkId: string) {
  const link = await prisma.duplicateCandidateLink.findFirst({
    where: { id: linkId, candidateA: { orgId } },
  });
  if (!link) throw ApiError.notFound("Duplicate link not found");
  return link;
}

export async function confirmDuplicate(orgId: string, linkId: string) {
  await findOwnedLink(orgId, linkId);
  return prisma.duplicateCandidateLink.update({
    where: { id: linkId },
    data: { status: "CONFIRMED", resolvedAt: new Date() },
  });
}

export async function dismissDuplicate(orgId: string, linkId: string) {
  await findOwnedLink(orgId, linkId);
  return prisma.duplicateCandidateLink.update({
    where: { id: linkId },
    data: { status: "DISMISSED", resolvedAt: new Date() },
  });
}
