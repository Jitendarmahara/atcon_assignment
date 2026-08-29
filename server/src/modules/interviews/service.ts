import type { UserRole } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../lib/errors.js";
import { toPage } from "../../lib/pagination.js";
import { writeOutboxEvent } from "../../events/outbox.js";
import { EVENT_TYPES } from "../../events/types.js";
import type { CreateInterviewInput, SubmitScorecardInput } from "./schema.js";

// Roles that can act on any interview regardless of panelist membership -
// the same set the route layer already gates scheduling/cancelling behind.
const MANAGE_ROLES = new Set<UserRole>(["ADMIN", "RECRUITER", "HIRING_MANAGER"]);

async function findOwnedApplication(orgId: string, applicationId: string) {
  const application = await prisma.application.findFirst({ where: { id: applicationId, job: { orgId } } });
  if (!application) throw ApiError.notFound("Application not found");
  return application;
}

async function findOwnedInterview(orgId: string, interviewId: string) {
  const interview = await prisma.interview.findFirst({
    where: { id: interviewId, application: { job: { orgId } } },
    include: { application: true, panelists: true },
  });
  if (!interview) throw ApiError.notFound("Interview not found");
  return interview;
}

export async function scheduleInterview(orgId: string, input: CreateInterviewInput) {
  await findOwnedApplication(orgId, input.applicationId);

  if (input.panelistUserIds.length > 0) {
    const panelists = await prisma.user.findMany({ where: { id: { in: input.panelistUserIds }, orgId } });
    if (panelists.length !== input.panelistUserIds.length) {
      throw ApiError.badRequest("One or more panelists do not belong to this organization");
    }
  }

  return prisma.$transaction(async (tx) => {
    const interview = await tx.interview.create({
      data: {
        applicationId: input.applicationId,
        scheduledAt: input.scheduledAt,
        durationMin: input.durationMin,
        mode: input.mode,
        locationOrLink: input.locationOrLink,
        panelists: { create: input.panelistUserIds.map((userId) => ({ userId })) },
      },
      include: { panelists: true },
    });

    await writeOutboxEvent(tx, EVENT_TYPES.INTERVIEW_SCHEDULED, {
      interviewId: interview.id,
      applicationId: input.applicationId,
      orgId,
      panelistUserIds: input.panelistUserIds,
    });

    return interview;
  });
}

export async function listInterviews(
  orgId: string,
  requester: { userId: string; role: UserRole },
  params: { applicationId?: string; cursor?: string; limit: number },
) {
  // INTERVIEWER is scoped to interviews they're actually a panelist on;
  // every other role manages interviews org-wide.
  const scopeToPanelist = !MANAGE_ROLES.has(requester.role);

  const rows = await prisma.interview.findMany({
    where: {
      application: { job: { orgId } },
      ...(params.applicationId ? { applicationId: params.applicationId } : {}),
      ...(scopeToPanelist ? { panelists: { some: { userId: requester.userId } } } : {}),
    },
    orderBy: { scheduledAt: "asc" },
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    include: {
      // select, not include: true - a panelist's full User row includes
      // passwordHash, which would otherwise serialize straight into this
      // response for any authenticated org member to read.
      panelists: { include: { user: { select: { id: true, name: true } } } },
      application: { include: { candidate: true, job: true } },
    },
  });
  return toPage(rows, params.limit);
}

export async function cancelInterview(orgId: string, interviewId: string) {
  const interview = await findOwnedInterview(orgId, interviewId);
  if (interview.status !== "SCHEDULED") throw ApiError.conflict("Only a scheduled interview can be cancelled");
  return prisma.interview.update({ where: { id: interviewId }, data: { status: "CANCELLED" } });
}

export async function submitScorecard(
  orgId: string,
  interviewId: string,
  authorId: string,
  authorRole: UserRole,
  input: SubmitScorecardInput,
) {
  const interview = await findOwnedInterview(orgId, interviewId);

  const isPanelist = interview.panelists.some((p) => p.userId === authorId);
  if (!isPanelist && !MANAGE_ROLES.has(authorRole)) {
    throw ApiError.forbidden("Only a panelist on this interview can submit a scorecard for it");
  }

  const existing = await prisma.scorecard.findUnique({ where: { interviewId_authorId: { interviewId, authorId } } });
  if (existing) throw ApiError.conflict("You have already submitted a scorecard for this interview");

  return prisma.$transaction(async (tx) => {
    const scorecard = await tx.scorecard.create({
      data: {
        interviewId,
        authorId,
        overall: input.overall,
        notes: input.notes,
        ratings: { create: input.ratings },
      },
      include: { ratings: true },
    });
    await tx.interview.update({ where: { id: interviewId }, data: { status: "COMPLETED" } });
    return scorecard;
  });
}

export async function listScorecards(orgId: string, interviewId: string) {
  await findOwnedInterview(orgId, interviewId);
  return prisma.scorecard.findMany({
    where: { interviewId },
    // select, not include: true - author: true would serialize the full
    // User row, passwordHash included, into the response.
    include: { ratings: true, author: { select: { id: true, name: true } } },
  });
}
