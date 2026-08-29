import { Prisma, type Candidate } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../lib/errors.js";
import { toPage } from "../../lib/pagination.js";
import { storage } from "../../lib/storage.js";
import { normalizeEmail, normalizeName, normalizePhone } from "../../domain/dedupe/normalize.js";
import { scanExactMatchesForCandidate } from "../../domain/dedupe/scan.js";
import { writeOutboxEvent } from "../../events/outbox.js";
import { EVENT_TYPES } from "../../events/types.js";
import { dedupeScanQueue } from "../../queues/definitions.js";
import type { CreateCandidateInput, UpdateCandidateInput } from "./schema.js";

// Follows Candidate.mergedIntoId to the live, canonical record. A candidate
// matched by email/phone/etc. may itself have already been merged away into
// someone else - without this, new activity (a re-application, a phone
// number update) would silently attach to the tombstoned row instead of the
// survivor, and the recruiter looking at the survivor's profile would never
// see it. Bounded by `seen` since a merge can in principle chain
// (A -> B, then B -> C later), never by a cycle (mergeCandidates refuses to
// merge a candidate that already has mergedIntoId set, on either side).
async function resolveLiveCandidate(candidate: Candidate): Promise<Candidate> {
  let current = candidate;
  const seen = new Set([current.id]);
  while (current.mergedIntoId && !seen.has(current.mergedIntoId)) {
    const next = await prisma.candidate.findUnique({ where: { id: current.mergedIntoId } });
    if (!next) break;
    current = next;
    seen.add(current.id);
  }
  return current;
}

// Shared by the authenticated "create candidate" endpoint AND the
// unauthenticated public apply flow. If a candidate with the same normalized
// email already exists in the org, we reuse it (updating name/phone if
// blank) rather than creating a sibling record - this is the cheapest,
// highest-confidence dedupe check, done inline instead of deferred to a scan.
// (orgId, normalizedEmail) is a DB-level unique constraint, so the
// create-on-miss path below is still race-safe under concurrent requests
// with the same email (e.g. a double-clicked public apply).
export async function createOrGetCandidate(orgId: string, input: CreateCandidateInput) {
  const normalizedEmail = normalizeEmail(input.email);
  const phoneE164 = normalizePhone(input.phone);
  const normalizedName = normalizeName(input.fullName);

  const existing = await prisma.candidate.findFirst({ where: { orgId, normalizedEmail } });
  if (existing) {
    const live = await resolveLiveCandidate(existing);
    return prisma.candidate.update({
      where: { id: live.id },
      data: {
        phone: live.phone ?? input.phone,
        phoneE164: live.phoneE164 ?? phoneE164,
      },
    });
  }

  try {
    const candidate = await prisma.candidate.create({
      data: { orgId, fullName: input.fullName, email: input.email, phone: input.phone, normalizedEmail, phoneE164, normalizedName },
    });
    await scanExactMatchesForCandidate(orgId, candidate.id);
    return candidate;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Lost the create race to a concurrent request with the same email -
      // reuse the winner instead of failing the whole apply/create flow.
      const winner = await prisma.candidate.findFirstOrThrow({ where: { orgId, normalizedEmail } });
      return resolveLiveCandidate(winner);
    }
    throw err;
  }
}

export async function listCandidates(orgId: string, params: { q?: string; cursor?: string; limit: number }) {
  const rows = await prisma.candidate.findMany({
    where: {
      orgId,
      mergedIntoId: null,
      ...(params.q
        ? {
            OR: [
              { fullName: { contains: params.q, mode: "insensitive" } },
              { email: { contains: params.q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { id: "asc" },
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  });
  return toPage(rows, params.limit);
}

async function findOwnedCandidate(orgId: string, candidateId: string) {
  const candidate = await prisma.candidate.findFirst({ where: { id: candidateId, orgId } });
  if (!candidate) throw ApiError.notFound("Candidate not found");
  return candidate;
}

export async function getCandidate(orgId: string, candidateId: string) {
  await findOwnedCandidate(orgId, candidateId);
  return prisma.candidate.findUnique({
    where: { id: candidateId },
    include: {
      resumes: { orderBy: { createdAt: "desc" } },
      applications: { include: { job: true, currentStage: true }, orderBy: { appliedAt: "desc" } },
      // Only surface links still actionable by a recruiter - a DISMISSED
      // ("not a duplicate") or MERGED (already resolved) link shouldn't keep
      // showing the "possible duplicate" warning on this page forever.
      duplicateLinksA: { where: { status: { in: ["PENDING", "CONFIRMED"] } }, include: { candidateB: true } },
      duplicateLinksB: { where: { status: { in: ["PENDING", "CONFIRMED"] } }, include: { candidateA: true } },
    },
  });
}

export async function updateCandidate(orgId: string, candidateId: string, input: UpdateCandidateInput) {
  const candidate = await findOwnedCandidate(orgId, candidateId);
  return prisma.candidate.update({
    where: { id: candidateId },
    data: {
      ...input,
      ...(input.fullName ? { normalizedName: normalizeName(input.fullName) } : {}),
      ...(input.phone ? { phoneE164: normalizePhone(input.phone) } : {}),
    },
  });
}

// On-demand full rescan (email/phone/resume-hash/fuzzy-name) for a single
// candidate - the async counterpart to the exact-match check that already
// runs inline on create. Distinct from the automatic post-resume-parse scan
// (queues/processors/resumeParse.ts): this is for a recruiter who wants to
// re-check a candidate after editing their info, without re-uploading a resume.
export async function rescanDuplicates(orgId: string, candidateId: string) {
  await findOwnedCandidate(orgId, candidateId);
  await dedupeScanQueue.add("rescan", { orgId, candidateId });
}

export async function addResume(orgId: string, candidateId: string, file: Express.Multer.File) {
  await findOwnedCandidate(orgId, candidateId);

  const resume = await prisma.$transaction(async (tx) => {
    const { storageKey, contentHash } = await storage.save(file.buffer, file.originalname);
    const created = await tx.resume.create({
      data: {
        candidateId,
        storageKey,
        originalName: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        contentHash,
      },
    });
    await writeOutboxEvent(tx, EVENT_TYPES.RESUME_UPLOADED, { resumeId: created.id, candidateId, orgId });
    return created;
  });

  return resume;
}

// Best-effort merge: reassigns resumes and non-conflicting applications from
// `duplicateId` onto `survivorId`, marks the duplicate CONFIRMED->MERGED,
// and records an AuditLog entry. Where both candidates already have an
// application to the same job, the duplicate's application is left in place
// but the candidate record itself is redirected via mergedIntoId - see the
// schema comment on Candidate.mergedIntoId. This is a pragmatic tradeoff
// documented in ASSUMPTIONS.md rather than a fully automated history merge.
export async function mergeCandidates(orgId: string, actorId: string, survivorId: string, duplicateId: string) {
  if (survivorId === duplicateId) throw ApiError.badRequest("Cannot merge a candidate into itself");

  const [survivor, duplicate] = await Promise.all([
    findOwnedCandidate(orgId, survivorId),
    findOwnedCandidate(orgId, duplicateId),
  ]);
  if (survivor.mergedIntoId) throw ApiError.conflict("Survivor candidate has itself been merged elsewhere");
  if (duplicate.mergedIntoId) throw ApiError.conflict("Duplicate candidate has already been merged");

  return prisma.$transaction(async (tx) => {
    await tx.resume.updateMany({ where: { candidateId: duplicateId }, data: { candidateId: survivorId } });

    const dupApplications = await tx.application.findMany({ where: { candidateId: duplicateId } });
    for (const app of dupApplications) {
      const clash = await tx.application.findUnique({ where: { candidateId_jobId: { candidateId: survivorId, jobId: app.jobId } } });
      if (!clash) {
        await tx.application.update({ where: { id: app.id }, data: { candidateId: survivorId } });
      }
      // else: leave the duplicate's application in place; it's still reachable
      // via the (now-redirected) duplicate candidate record for audit purposes.
    }

    const before = { fullName: duplicate.fullName, email: duplicate.email };
    await tx.candidate.update({ where: { id: duplicateId }, data: { mergedIntoId: survivorId } });

    await tx.duplicateCandidateLink.updateMany({
      where: { OR: [{ candidateAId: duplicateId, candidateBId: survivorId }, { candidateAId: survivorId, candidateBId: duplicateId }] },
      data: { status: "MERGED", resolvedAt: new Date() },
    });

    // Any OTHER pending/confirmed link still pointing at the now-tombstoned
    // duplicate (e.g. duplicate<->someThirdCandidate) is dead weight in the
    // review queue - acting on it would just 409 ("already merged"), since
    // duplicateId can never be a survivor or duplicate again. Dismiss them
    // rather than leaving a dead end for a recruiter to click into.
    await tx.duplicateCandidateLink.updateMany({
      where: {
        status: { in: ["PENDING", "CONFIRMED"] },
        OR: [{ candidateAId: duplicateId }, { candidateBId: duplicateId }],
      },
      data: { status: "DISMISSED", resolvedAt: new Date() },
    });

    await tx.auditLog.create({
      data: {
        orgId,
        actorId,
        action: "candidate.merge",
        entityType: "Candidate",
        entityId: survivorId,
        before,
        after: { mergedFromId: duplicateId },
      },
    });

    return tx.candidate.findUnique({ where: { id: survivorId }, include: { resumes: true, applications: true } });
  });
}
