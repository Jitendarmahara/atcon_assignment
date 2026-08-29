import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../lib/errors.js";
import { createOrGetCandidate } from "../candidates/service.js";
import { addResume } from "../candidates/service.js";
import { createApplication } from "../applications/service.js";
import type { ApplyInput } from "./schema.js";

async function findPublishedJob(orgSlug: string, jobSlug: string) {
  const org = await prisma.organization.findUnique({ where: { slug: orgSlug } });
  if (!org) throw ApiError.notFound("Organization not found");

  const job = await prisma.job.findFirst({ where: { orgId: org.id, publicSlug: jobSlug, status: "PUBLISHED" } });
  if (!job) throw ApiError.notFound("Job not found or not currently accepting applications");

  return { org, job };
}

export async function listPublishedJobs(orgSlug: string) {
  const org = await prisma.organization.findUnique({ where: { slug: orgSlug } });
  if (!org) throw ApiError.notFound("Organization not found");

  return prisma.job.findMany({
    where: { orgId: org.id, status: "PUBLISHED" },
    orderBy: { publishedAt: "desc" },
    select: {
      id: true,
      title: true,
      description: true,
      department: true,
      location: true,
      employmentType: true,
      publicSlug: true,
      publishedAt: true,
    },
  });
}

export async function getPublishedJob(orgSlug: string, jobSlug: string) {
  const { job } = await findPublishedJob(orgSlug, jobSlug);
  return job;
}

// The one flow in the whole system that runs unauthenticated: a candidate
// hits this from the public careers site, submitting their info plus a
// resume. Ties together three already-atomic steps (create-or-reuse
// candidate, store resume, create application) - each is independently
// transactional and durable via the outbox, so a failure partway through
// leaves recoverable partial state (e.g. a candidate + resume but no
// application yet) rather than a dangling half-written row. Documented as a
// tradeoff in ASSUMPTIONS.md: a fully atomic three-table cross-module
// transaction was judged not worth the coupling it would introduce between
// candidates/applications/resume-storage for a case-study-scale system.
export async function apply(orgSlug: string, jobSlug: string, input: ApplyInput, file: Express.Multer.File | undefined) {
  const { org, job } = await findPublishedJob(orgSlug, jobSlug);

  const candidate = await createOrGetCandidate(org.id, input);

  const existingApplication = await prisma.application.findUnique({
    where: { candidateId_jobId: { candidateId: candidate.id, jobId: job.id } },
  });
  if (existingApplication) {
    throw ApiError.conflict("You have already applied to this job");
  }

  if (file) {
    await addResume(org.id, candidate.id, file);
  }

  const application = await createApplication(org.id, { candidateId: candidate.id, jobId: job.id, source: "careers_site" });

  return { candidateId: candidate.id, applicationId: application.id };
}
