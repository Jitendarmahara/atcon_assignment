import type { Job } from "bullmq";
import { prisma } from "../../lib/prisma.js";
import { storage } from "../../lib/storage.js";
import { extractResumeText, structureResume } from "../../domain/resume/index.js";
import { scanFullDuplicatesForCandidate } from "../../domain/dedupe/scan.js";
import { notifyOrgRecruiters } from "../../lib/notify.js";
import type { ResumeUploadedPayload } from "../../events/types.js";

// extract -> structure -> persist -> full dedupe scan. Each resume upload
// runs this exactly once; retried by BullMQ (exponential backoff, 5
// attempts) on any failure, with the Resume row left in FAILED status and
// its error message recorded so a recruiter can see why parsing didn't work.
export async function processResumeParse(job: Job<ResumeUploadedPayload>) {
  const { resumeId, candidateId, orgId } = job.data;
  await prisma.resume.update({ where: { id: resumeId }, data: { parseStatus: "PARSING" } });

  try {
    const resume = await prisma.resume.findUniqueOrThrow({ where: { id: resumeId } });
    const buffer = await storage.read(resume.storageKey);
    const rawText = await extractResumeText(buffer, resume.mimeType);
    const { profile, parserVersion } = await structureResume(rawText);

    await prisma.resume.update({
      where: { id: resumeId },
      data: { parseStatus: "PARSED", parsedProfile: profile as never, parserVersion, parseError: null },
    });

    const pendingWhere = { status: "PENDING" as const, OR: [{ candidateAId: candidateId }, { candidateBId: candidateId }] };
    const before = await prisma.duplicateCandidateLink.count({ where: pendingWhere });
    await scanFullDuplicatesForCandidate(orgId, candidateId);
    const after = await prisma.duplicateCandidateLink.count({ where: pendingWhere });

    if (after > before) {
      await notifyOrgRecruiters(orgId, "candidate.duplicate_suspected", { candidateId });
    }
  } catch (err) {
    await prisma.resume.update({
      where: { id: resumeId },
      data: { parseStatus: "FAILED", parseError: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}
