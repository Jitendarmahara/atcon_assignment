import { prisma } from "../../lib/prisma.js";
import { AUTO_LINK_THRESHOLD, REVIEW_THRESHOLD, scoreDuplicate, type DedupeSignal } from "./score.js";

// Ordering convention so a pair only ever gets one link row regardless of
// which candidate triggered the scan (matches the (candidateAId, candidateBId)
// unique constraint).
function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

// scanFullDuplicatesForCandidate calls this up to three times per pair (exact
// match, resume hash, fuzzy name), each with only its own single signal -
// score.ts's "max, not sum" logic only applies within one of those calls. Merge
// by signal name so a later, weaker call can't clobber an earlier, stronger one.
function mergeSignals(existing: DedupeSignal[], incoming: DedupeSignal[]): DedupeSignal[] {
  const byName = new Map(existing.map((s) => [s.name, s]));
  for (const s of incoming) byName.set(s.name, s);
  return [...byName.values()];
}

async function upsertLink(orgId: string, aId: string, bId: string, confidence: number, signals: DedupeSignal[]) {
  const [candidateAId, candidateBId] = orderedPair(aId, bId);

  // Not atomic (read then upsert) - acceptable here since dedupe scans for a
  // given candidate run one at a time from the BullMQ queue, not concurrently;
  // a race would at worst drop one signal from the merge, never corrupt data.
  const existing = await prisma.duplicateCandidateLink.findUnique({
    where: { candidateAId_candidateBId: { candidateAId, candidateBId } },
  });
  const finalSignals = mergeSignals((existing?.signals as unknown as DedupeSignal[] | undefined) ?? [], signals);
  const finalConfidence = Math.max(existing?.confidence ?? 0, confidence);
  const shouldConfirm = finalConfidence >= AUTO_LINK_THRESHOLD;

  // Auto-linking (>=0.9) marks the link CONFIRMED automatically since the
  // signal is essentially unambiguous (exact email/phone/resume hash) - but
  // it still does NOT merge the records. Merging candidate history is a
  // separate, explicit, audited action (POST /candidates/:id/merge) even
  // when confidence is high, so a recruiter always sees what changed.
  await prisma.duplicateCandidateLink.upsert({
    where: { candidateAId_candidateBId: { candidateAId, candidateBId } },
    create: {
      candidateAId,
      candidateBId,
      confidence: finalConfidence,
      signals: finalSignals as never,
      status: shouldConfirm ? "CONFIRMED" : "PENDING",
    },
    update: {
      confidence: finalConfidence,
      signals: finalSignals as never,
      ...(shouldConfirm ? { status: "CONFIRMED" } : {}),
    },
  });

  void orgId; // reserved: org is implied by candidate scoping upstream, kept for future cross-org guard
}

// Cheap, synchronous: run right after a candidate is created/updated, before
// any resume parsing has happened. Only checks exact email/phone matches -
// no similarity scan yet since it's on the request's critical path.
export async function scanExactMatchesForCandidate(orgId: string, candidateId: string) {
  const candidate = await prisma.candidate.findUniqueOrThrow({ where: { id: candidateId } });

  const matches = await prisma.candidate.findMany({
    where: {
      orgId,
      id: { not: candidateId },
      mergedIntoId: null, // a tombstoned candidate is a dead end for the review queue - see mergeCandidates
      OR: [
        { normalizedEmail: candidate.normalizedEmail },
        ...(candidate.phoneE164 ? [{ phoneE164: candidate.phoneE164 }] : []),
      ],
    },
  });

  for (const other of matches) {
    const emailMatch = other.normalizedEmail === candidate.normalizedEmail;
    const phoneMatch = !!candidate.phoneE164 && other.phoneE164 === candidate.phoneE164;
    const { confidence, signals } = scoreDuplicate({
      emailMatch,
      phoneMatch,
      resumeContentHashMatch: false,
      nameSimilarity: 0,
      sharedEmployerOrSchool: false,
    });
    await upsertLink(orgId, candidateId, other.id, confidence, signals);
  }
}

// Heavier scan run from the background queue after resume parsing completes:
// adds resume content-hash matches and fuzzy name similarity (pg_trgm) on
// top of the exact-match pass, since it now also has a parsed profile to
// compare employers/schools against.
export async function scanFullDuplicatesForCandidate(orgId: string, candidateId: string) {
  const candidate = await prisma.candidate.findUniqueOrThrow({
    where: { id: candidateId },
    include: { resumes: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  const latestResume = candidate.resumes[0];

  // 1. Exact email/phone (idempotent re-run of the sync pass; catches cases
  //    where the candidate's contact info was edited since creation).
  await scanExactMatchesForCandidate(orgId, candidateId);

  // 2. Resume content hash - byte-identical resume uploaded under a different name/email.
  if (latestResume) {
    const hashMatches = await prisma.resume.findMany({
      where: {
        contentHash: latestResume.contentHash,
        candidateId: { not: candidateId },
        // Scope through the relation so this is a tenant-scoped lookup, not
        // a full cross-org table scan filtered after the fact.
        candidate: { orgId, mergedIntoId: null },
      },
      select: { candidateId: true },
    });
    for (const { candidateId: otherId } of hashMatches) {
      const other = await prisma.candidate.findFirst({ where: { id: otherId, orgId, mergedIntoId: null } });
      if (!other) continue;
      const { confidence, signals } = scoreDuplicate({
        emailMatch: other.normalizedEmail === candidate.normalizedEmail,
        phoneMatch: !!candidate.phoneE164 && other.phoneE164 === candidate.phoneE164,
        resumeContentHashMatch: true,
        nameSimilarity: 0,
        sharedEmployerOrSchool: false,
      });
      await upsertLink(orgId, candidateId, otherId, confidence, signals);
    }
  }

  // 3. Fuzzy name similarity via the pg_trgm GIN index on normalizedName.
  const fuzzy = await prisma.$queryRaw<Array<{ id: string; similarity: number }>>`
    SELECT id, similarity("normalizedName", ${candidate.normalizedName}) AS similarity
    FROM candidates
    WHERE "orgId" = ${orgId}
      AND id != ${candidateId}
      AND "mergedIntoId" IS NULL
      AND similarity("normalizedName", ${candidate.normalizedName}) >= 0.3
    ORDER BY similarity DESC
    LIMIT 10
  `;

  const parsedProfile = latestResume?.parsedProfile as { experience?: Array<{ employer?: string }>; education?: Array<{ school?: string }> } | null;
  const myOrgs = new Set([
    ...(parsedProfile?.experience?.map((e) => e.employer?.toLowerCase().trim()).filter(Boolean) ?? []),
    ...(parsedProfile?.education?.map((e) => e.school?.toLowerCase().trim()).filter(Boolean) ?? []),
  ]);

  for (const { id: otherId, similarity } of fuzzy) {
    let sharedEmployerOrSchool = false;
    if (myOrgs.size > 0) {
      const otherResume = await prisma.resume.findFirst({
        where: { candidateId: otherId },
        orderBy: { createdAt: "desc" },
        select: { parsedProfile: true },
      });
      const otherProfile = otherResume?.parsedProfile as { experience?: Array<{ employer?: string }>; education?: Array<{ school?: string }> } | null;
      const otherOrgs = [
        ...(otherProfile?.experience?.map((e) => e.employer?.toLowerCase().trim()) ?? []),
        ...(otherProfile?.education?.map((e) => e.school?.toLowerCase().trim()) ?? []),
      ];
      sharedEmployerOrSchool = otherOrgs.some((o) => o && myOrgs.has(o));
    }

    const other = await prisma.candidate.findFirst({ where: { id: otherId, orgId, mergedIntoId: null } });
    if (!other) continue;
    const { confidence, signals } = scoreDuplicate({
      emailMatch: other.normalizedEmail === candidate.normalizedEmail,
      phoneMatch: !!candidate.phoneE164 && other.phoneE164 === candidate.phoneE164,
      resumeContentHashMatch: false,
      nameSimilarity: similarity,
      sharedEmployerOrSchool,
    });
    if (confidence >= REVIEW_THRESHOLD) {
      await upsertLink(orgId, candidateId, otherId, confidence, signals);
    }
  }
}
