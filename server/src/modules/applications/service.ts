import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../lib/errors.js";
import { toPage } from "../../lib/pagination.js";
import { validateTransition } from "../../domain/pipeline/transitions.js";
import { writeOutboxEvent } from "../../events/outbox.js";
import { EVENT_TYPES } from "../../events/types.js";
import { publishOrgEvent } from "../../lib/pubsub.js";
import type { CreateApplicationInput, TransitionApplicationInput } from "./schema.js";

// Verifies both the job and candidate belong to the caller's org before any
// write - the two most common tenant-isolation mistakes are trusting a
// candidateId/jobId from the request body, or joining across org boundaries.
async function assertSameOrg(orgId: string, jobId: string, candidateId: string) {
  const [job, candidate] = await Promise.all([
    prisma.job.findFirst({ where: { id: jobId, orgId }, include: { stages: { orderBy: { order: "asc" } } } }),
    prisma.candidate.findFirst({ where: { id: candidateId, orgId } }),
  ]);
  if (!job) throw ApiError.notFound("Job not found");
  if (!candidate) throw ApiError.notFound("Candidate not found");
  return { job, candidate };
}

// Creates the Application plus its founding StageEvent (fromStageId: null,
// actorId: null - system-initiated) in one transaction, so an application
// never exists for even an instant without a matching audit trail entry.
export async function createApplication(orgId: string, input: CreateApplicationInput) {
  const { job, candidate } = await assertSameOrg(orgId, input.jobId, input.candidateId);

  const firstStage = job.stages.find((s) => s.kind === "APPLIED") ?? job.stages[0];
  if (!firstStage) throw ApiError.badRequest("Job has no configured pipeline stages");

  const existing = await prisma.application.findUnique({
    where: { candidateId_jobId: { candidateId: candidate.id, jobId: job.id } },
  });
  if (existing) throw ApiError.conflict("This candidate has already applied to this job");

  const application = await prisma.$transaction(async (tx) => {
    const created = await tx.application.create({
      data: {
        candidateId: candidate.id,
        jobId: job.id,
        currentStageId: firstStage.id,
        source: input.source,
      },
    });

    await tx.stageEvent.create({
      data: {
        applicationId: created.id,
        fromStageId: null,
        toStageId: firstStage.id,
        actorId: null,
        reason: null,
        isBackwardMove: false,
        durationInPrevStageSec: null,
      },
    });

    await writeOutboxEvent(tx, EVENT_TYPES.APPLICATION_SUBMITTED, {
      applicationId: created.id,
      candidateId: candidate.id,
      jobId: job.id,
      orgId,
    });

    return created;
  });

  // Live-update the kanban board for anyone with this job open - a broadcast
  // (no userId), since any org member viewing this job's board should see
  // the new "Applied" card without a manual refresh.
  await publishOrgEvent(orgId, {
    type: "application.created",
    payload: { applicationId: application.id, jobId: job.id, stageId: firstStage.id },
  });

  return application;
}

export async function listApplications(
  orgId: string,
  params: { jobId?: string; stageId?: string; status?: string; cursor?: string; limit: number },
) {
  const rows = await prisma.application.findMany({
    where: {
      job: { orgId },
      ...(params.jobId ? { jobId: params.jobId } : {}),
      ...(params.stageId ? { currentStageId: params.stageId } : {}),
      ...(params.status ? { status: params.status as never } : {}),
    },
    orderBy: { id: "asc" },
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    include: { candidate: true, job: true, currentStage: true },
  });
  return toPage(rows, params.limit);
}

async function findOwnedApplication(orgId: string, applicationId: string) {
  const application = await prisma.application.findFirst({
    where: { id: applicationId, job: { orgId } },
    include: { job: { include: { stages: { orderBy: { order: "asc" } } } }, currentStage: true, candidate: true },
  });
  if (!application) throw ApiError.notFound("Application not found");
  return application;
}

export async function getApplication(orgId: string, applicationId: string) {
  return findOwnedApplication(orgId, applicationId);
}

export async function listStageEvents(orgId: string, applicationId: string) {
  await findOwnedApplication(orgId, applicationId);
  return prisma.stageEvent.findMany({
    where: { applicationId },
    orderBy: { createdAt: "asc" },
    // select, not include: true - actor: true would serialize the acting
    // user's full row, passwordHash included, into this response.
    include: { fromStage: true, toStage: true, actor: { select: { id: true, name: true } } },
  });
}

// The state-machine entry point. Runs as a single transaction:
//   1. guard check (domain/pipeline/transitions.ts),
//   2. optimistic-concurrency update guarded by `WHERE currentStageId = fromStageId`
//      (Postgres row-locks the UPDATE, so two concurrent transitions on the
//      SAME application serialize correctly - the loser sees 0 rows affected
//      and gets a 409, never a silent overwrite),
//   3. StageEvent insert with computed time-in-previous-stage,
//   4. OutboxEvent insert.
// One commit, or nothing - there is no way to observe a StageEvent without
// its Application update, or vice versa.
export async function transitionApplication(
  orgId: string,
  actorId: string,
  applicationId: string,
  input: TransitionApplicationInput,
) {
  const application = await findOwnedApplication(orgId, applicationId);
  const toStage = application.job.stages.find((s) => s.id === input.toStageId);
  if (!toStage) throw ApiError.badRequest("Target stage does not belong to this job");

  const { isBackwardMove } = validateTransition(application.currentStage, toStage, input.reason);
  const fromStageId = application.currentStageId;

  const result = await prisma.$transaction(async (tx) => {
    const updateResult = await tx.application.updateMany({
      where: { id: applicationId, currentStageId: application.currentStageId },
      data: {
        currentStageId: toStage.id,
        ...(toStage.kind === "HIRED" ? { status: "HIRED", closedAt: new Date() } : {}),
        ...(toStage.kind === "REJECTED" ? { status: "REJECTED", closedAt: new Date() } : {}),
      },
    });

    if (updateResult.count === 0) {
      // Someone else moved this application between our read and this write.
      throw ApiError.conflict("Application was moved by another user - refresh and try again", {
        applicationId,
      });
    }

    const lastEvent = await tx.stageEvent.findFirst({
      where: { applicationId },
      orderBy: { createdAt: "desc" },
    });
    const since = lastEvent?.createdAt ?? application.appliedAt;
    const durationInPrevStageSec = Math.max(0, Math.round((Date.now() - since.getTime()) / 1000));

    const stageEvent = await tx.stageEvent.create({
      data: {
        applicationId,
        fromStageId: application.currentStageId,
        toStageId: toStage.id,
        actorId,
        reason: input.reason,
        isBackwardMove,
        durationInPrevStageSec,
      },
      include: { fromStage: true, toStage: true },
    });

    await writeOutboxEvent(tx, EVENT_TYPES.APPLICATION_STAGE_CHANGED, {
      applicationId,
      orgId,
      fromStageId: application.currentStageId,
      toStageId: toStage.id,
      toStageKind: toStage.kind,
      actorId,
    });

    return { application: await tx.application.findUniqueOrThrow({ where: { id: applicationId } }), stageEvent };
  });

  await publishOrgEvent(orgId, {
    type: "application.stage_changed",
    payload: { applicationId, jobId: application.jobId, fromStageId, toStageId: toStage.id },
  });

  return result;
}
