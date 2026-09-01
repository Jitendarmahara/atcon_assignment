import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../lib/errors.js";
import { normalizeEmail } from "../../domain/dedupe/normalize.js";

// A candidate's applications span potentially multiple orgs (the same email
// can apply to different companies' public job boards) - this is a
// deliberately cross-org query, unscoped by design (see
// requireCandidateAuth.ts's comment on why this never sets req.auth, and
// therefore never runs under Row-Level Security's per-org scope). The email
// it filters by always comes from the caller's own verified JWT
// (candidateAuth), never from a client-supplied value, so a candidate can
// only ever see their own applications despite the query spanning orgs.
//
// mergedIntoId: null excludes a tombstoned Candidate row (see
// domain/dedupe - candidate merge) - a candidate should never see a ghost
// duplicate of their own application that a recruiter already merged away.
export async function listMyApplications(email: string) {
  const normalizedEmail = normalizeEmail(email);
  const candidates = await prisma.candidate.findMany({
    where: { normalizedEmail, mergedIntoId: null },
    select: {
      applications: {
        select: {
          id: true,
          status: true,
          appliedAt: true,
          closedAt: true,
          job: { select: { title: true, org: { select: { name: true } } } },
          currentStage: { select: { name: true, kind: true } },
        },
        orderBy: { appliedAt: "desc" },
      },
    },
  });

  return candidates.flatMap((c) =>
    c.applications.map((a) => ({
      id: a.id,
      jobTitle: a.job.title,
      orgName: a.job.org.name,
      status: a.status,
      currentStageName: a.currentStage.name,
      currentStageKind: a.currentStage.kind,
      appliedAt: a.appliedAt,
      closedAt: a.closedAt,
    })),
  );
}

// The "you've reached this round" update feed the dashboard renders is
// deliberately not a separate notification system - it's the exact same
// StageEvent audit trail the recruiter side already relies on
// (docs/ARCHITECTURE.md's pipeline state machine), read back for the
// candidate whose application it is. Reusing already-reliable, already-
// transactional data instead of standing up a second notification-delivery
// pipeline (its own outbox event type, its own BullMQ job, its own
// reliability story) for something that already exists and is already correct.
//
// Explicit `select`, not `include`: an internal `reason` (a recruiter's
// rejection note, often written for internal eyes, not the candidate's) and
// `actor` (which staff member made the move) are deliberately never
// returned to a candidate - the same "don't over-fetch, don't leak an
// internal field via a careless include" discipline the credential-leak fix
// (docs/ASSUMPTIONS.md's changelog) already established for interview/
// scorecard responses.
export async function getApplicationTimeline(email: string, applicationId: string) {
  const normalizedEmail = normalizeEmail(email);
  const application = await prisma.application.findFirst({
    where: { id: applicationId, candidate: { normalizedEmail, mergedIntoId: null } },
    select: {
      id: true,
      status: true,
      appliedAt: true,
      closedAt: true,
      job: { select: { title: true, org: { select: { name: true } } } },
      currentStage: { select: { name: true, kind: true } },
    },
  });
  if (!application) throw ApiError.notFound("Application not found");

  const events = await prisma.stageEvent.findMany({
    where: { applicationId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      createdAt: true,
      fromStage: { select: { name: true } },
      toStage: { select: { name: true, kind: true } },
    },
  });

  return {
    application: {
      id: application.id,
      jobTitle: application.job.title,
      orgName: application.job.org.name,
      status: application.status,
      currentStageName: application.currentStage.name,
      currentStageKind: application.currentStage.kind,
      appliedAt: application.appliedAt,
      closedAt: application.closedAt,
    },
    events: events.map((e) => ({
      id: e.id,
      fromStageName: e.fromStage?.name ?? null,
      toStageName: e.toStage.name,
      toStageKind: e.toStage.kind,
      createdAt: e.createdAt,
    })),
  };
}

// "Unread" here means "a StageEvent, across any of my applications, newer
// than the last time I looked" - a single watermark (CandidateAccount.
// notificationsViewedAt) rather than a per-row read flag, since there's no
// separate notification table to carry one (see this file's top comment on
// why the update feed reuses StageEvent directly). Null watermark (never
// viewed) counts everything - a brand-new account should see "you have N
// updates" for history that predates it registering, not zero.
export async function getUnreadUpdateCount(candidateAccountId: string, email: string): Promise<number> {
  const account = await prisma.candidateAccount.findUniqueOrThrow({ where: { id: candidateAccountId } });
  const normalizedEmail = normalizeEmail(email);
  return prisma.stageEvent.count({
    where: {
      application: { candidate: { normalizedEmail, mergedIntoId: null } },
      ...(account.notificationsViewedAt ? { createdAt: { gt: account.notificationsViewedAt } } : {}),
    },
  });
}

export async function markUpdatesViewed(candidateAccountId: string): Promise<void> {
  await prisma.candidateAccount.update({ where: { id: candidateAccountId }, data: { notificationsViewedAt: new Date() } });
}

// The actual list behind the bell's dropdown - getUnreadUpdateCount() above
// only ever returns a number, which isn't something a click can do anything
// with. Spans every application (unlike getApplicationTimeline(), which is
// scoped to one), most recent first, each event carrying enough job/org
// context to be legible outside of any one application's card.
export async function listRecentUpdates(email: string, limit = 20) {
  const normalizedEmail = normalizeEmail(email);
  const events = await prisma.stageEvent.findMany({
    where: { application: { candidate: { normalizedEmail, mergedIntoId: null } } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      createdAt: true,
      toStage: { select: { name: true, kind: true } },
      application: {
        select: { id: true, job: { select: { title: true, org: { select: { name: true } } } } },
      },
    },
  });

  return events.map((e) => ({
    id: e.id,
    applicationId: e.application.id,
    jobTitle: e.application.job.title,
    orgName: e.application.job.org.name,
    toStageName: e.toStage.name,
    toStageKind: e.toStage.kind,
    createdAt: e.createdAt,
  }));
}

// Shown directly on the candidate's own dashboard, not a separate "browse
// jobs" page - deliberately the same cross-org shape as listMyApplications()
// above, so applying and tracking status live on one screen instead of
// sending the candidate back out to a per-org public careers page they'd
// have to separately discover.
//
// Excludes jobs already applied to (rather than showing them with an
// "Applied" label) - the candidate's own Applications section above already
// covers that, and this keeps the list to what's actually still actionable;
// it also means the UI never offers an "Apply" action that would 409 against
// the (candidateId, jobId) unique constraint.
export async function listOpenRoles(email: string) {
  const normalizedEmail = normalizeEmail(email);
  const appliedJobs = await prisma.application.findMany({
    where: { candidate: { normalizedEmail, mergedIntoId: null } },
    select: { jobId: true },
  });
  const appliedJobIds = appliedJobs.map((a) => a.jobId);

  const jobs = await prisma.job.findMany({
    where: { status: "PUBLISHED", id: { notIn: appliedJobIds } },
    select: {
      id: true,
      title: true,
      description: true,
      department: true,
      location: true,
      employmentType: true,
      publicSlug: true,
      org: { select: { name: true, slug: true } },
    },
    orderBy: { publishedAt: "desc" },
  });

  return jobs.map((j) => ({
    id: j.id,
    title: j.title,
    description: j.description,
    department: j.department,
    location: j.location,
    employmentType: j.employmentType,
    orgName: j.org.name,
    orgSlug: j.org.slug,
    jobSlug: j.publicSlug,
  }));
}
