import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../lib/errors.js";
import { toPage } from "../../lib/pagination.js";
import { slugify } from "../../lib/slug.js";
import { DEFAULT_PIPELINE_TEMPLATE } from "../../domain/pipeline/template.js";

type EmploymentType = "FULL_TIME" | "PART_TIME" | "CONTRACT" | "INTERNSHIP";
type StageKind = "APPLIED" | "SCREEN" | "INTERVIEW" | "OFFER" | "HIRED" | "REJECTED";

// Structurally match the Zod-inferred types of the same names in
// server/src/modules/jobs/schema.ts - see public/service.ts for why these
// are redeclared here rather than imported across the package boundary.
interface CreateJobInput {
  title: string;
  description: string;
  department?: string;
  location?: string;
  employmentType: EmploymentType;
  openings: number;
}
interface UpdateJobInput {
  title?: string;
  description?: string;
  department?: string;
  location?: string;
  employmentType?: EmploymentType;
  openings?: number;
}
interface CreateStageInput {
  name: string;
  kind: StageKind;
  order: number;
  slaDays?: number | null;
}
interface UpdateStageInput {
  name?: string;
  kind?: StageKind;
  slaDays?: number | null;
}
interface ReorderStagesInput {
  order: string[];
}

// Every query below is scoped by orgId - callers never pass a client-supplied
// orgId, it always comes from the authenticated req.auth context. This is
// the tenant-isolation boundary for the whole module.

export async function createJob(orgId: string, input: CreateJobInput) {
  return prisma.job.create({
    data: {
      orgId,
      ...input,
      publicSlug: slugify(input.title),
      stages: { create: DEFAULT_PIPELINE_TEMPLATE.map((s, i) => ({ ...s, order: i })) },
    },
    include: { stages: { orderBy: { order: "asc" } } },
  });
}

export async function listJobs(orgId: string, params: { status?: string; cursor?: string; limit: number }) {
  const rows = await prisma.job.findMany({
    where: { orgId, ...(params.status ? { status: params.status as never } : {}) },
    orderBy: { id: "asc" },
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    include: { stages: { orderBy: { order: "asc" } } },
  });
  return toPage(rows, params.limit);
}

async function findOwnedJob(orgId: string, jobId: string) {
  const job = await prisma.job.findFirst({ where: { id: jobId, orgId }, include: { stages: { orderBy: { order: "asc" } } } });
  if (!job) throw ApiError.notFound("Job not found");
  return job;
}

export async function getJob(orgId: string, jobId: string) {
  return findOwnedJob(orgId, jobId);
}

export async function updateJob(orgId: string, jobId: string, input: UpdateJobInput) {
  await findOwnedJob(orgId, jobId);
  return prisma.job.update({ where: { id: jobId }, data: input, include: { stages: { orderBy: { order: "asc" } } } });
}

export async function publishJob(orgId: string, actorId: string, jobId: string) {
  const job = await findOwnedJob(orgId, jobId);
  if (job.status === "PUBLISHED") throw ApiError.conflict("Job is already published");
  if (job.status === "CLOSED") throw ApiError.conflict("Cannot publish a closed job");
  return prisma.$transaction(async (tx) => {
    const updated = await tx.job.update({ where: { id: jobId }, data: { status: "PUBLISHED", publishedAt: new Date() } });
    await tx.auditLog.create({
      data: { orgId, actorId, action: "job.publish", entityType: "Job", entityId: jobId, before: { status: job.status }, after: { status: "PUBLISHED" } },
    });
    return updated;
  });
}

export async function closeJob(orgId: string, actorId: string, jobId: string) {
  const job = await findOwnedJob(orgId, jobId);
  if (job.status === "CLOSED") throw ApiError.conflict("Job is already closed");
  return prisma.$transaction(async (tx) => {
    const updated = await tx.job.update({ where: { id: jobId }, data: { status: "CLOSED", closedAt: new Date() } });
    await tx.auditLog.create({
      data: { orgId, actorId, action: "job.close", entityType: "Job", entityId: jobId, before: { status: job.status }, after: { status: "CLOSED" } },
    });
    return updated;
  });
}

// ── Stages ─────────────────────────────────────────────────────────────

export async function listStages(orgId: string, jobId: string) {
  const job = await findOwnedJob(orgId, jobId);
  return job.stages;
}

export async function addStage(orgId: string, jobId: string, input: CreateStageInput) {
  await findOwnedJob(orgId, jobId);
  const clash = await prisma.jobStage.findUnique({ where: { jobId_order: { jobId, order: input.order } } });
  if (clash) throw ApiError.conflict(`A stage already exists at order ${input.order}`);
  return prisma.jobStage.create({ data: { jobId, ...input } });
}

async function findOwnedStage(orgId: string, jobId: string, stageId: string) {
  await findOwnedJob(orgId, jobId);
  const stage = await prisma.jobStage.findFirst({ where: { id: stageId, jobId } });
  if (!stage) throw ApiError.notFound("Stage not found");
  return stage;
}

export async function updateStage(orgId: string, jobId: string, stageId: string, input: UpdateStageInput) {
  await findOwnedStage(orgId, jobId, stageId);
  return prisma.jobStage.update({ where: { id: stageId }, data: input });
}

export async function removeStage(orgId: string, jobId: string, stageId: string) {
  const stage = await findOwnedStage(orgId, jobId, stageId);
  const inUse = await prisma.application.count({ where: { currentStageId: stage.id } });
  if (inUse > 0) throw ApiError.conflict("Cannot remove a stage with active applications in it");
  // StageEvent.toStageId is ON DELETE RESTRICT (it's the audit trail - a
  // historical event must keep pointing at a real stage even after the
  // application has moved on and no application currently sits here). Check
  // for that up front so this is a clean 409 rather than a raw P2003 at the
  // database layer.
  const hasHistory = await prisma.stageEvent.count({ where: { toStageId: stage.id } });
  if (hasHistory > 0) throw ApiError.conflict("Cannot remove a stage that appears in past stage-change history");
  await prisma.jobStage.delete({ where: { id: stageId } });
}

// Reassigns `order` for every stage of the job to match the given id sequence,
// in one transaction. Uses a temporary negative-offset pass to dodge the
// unique (jobId, order) constraint while shuffling.
//
// Must use the callback form of $transaction (a tx-scoped update per stage),
// not the array form (`prisma.$transaction([update1, update2, ...])`):
// lib/prisma.ts's RLS-scoping Proxy invokes each top-level `prisma.x.y(...)`
// call eagerly, in its own short-lived mini-transaction, the instant it's
// called - which for an array literal happens while the array is being
// built, before `$transaction` itself is ever invoked. Every update in the
// array would run as its own independent, immediately-committing
// transaction, racing the others with no ordering guarantee - defeating both
// the atomicity and the negative-offset trick this comment used to describe.
// The callback form runs every update against the same `tx`, sequentially,
// inside one real transaction, which is exactly the safe pattern this proxy
// already relies on everywhere else.
export async function reorderStages(orgId: string, jobId: string, input: ReorderStagesInput) {
  const job = await findOwnedJob(orgId, jobId);
  const currentIds = new Set(job.stages.map((s) => s.id));
  if (input.order.length !== job.stages.length || !input.order.every((id) => currentIds.has(id))) {
    throw ApiError.badRequest("Reorder list must contain exactly the job's existing stage ids");
  }

  await prisma.$transaction(async (tx) => {
    for (const [i, id] of input.order.entries()) {
      await tx.jobStage.update({ where: { id }, data: { order: -(i + 1) } });
    }
    for (const [i, id] of input.order.entries()) {
      await tx.jobStage.update({ where: { id }, data: { order: i } });
    }
  });

  return listStages(orgId, jobId);
}
