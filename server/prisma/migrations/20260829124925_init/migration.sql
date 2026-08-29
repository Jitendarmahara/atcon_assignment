-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'RECRUITER', 'HIRING_MANAGER', 'INTERVIEWER');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CLOSED');

-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERNSHIP');

-- CreateEnum
CREATE TYPE "StageKind" AS ENUM ('APPLIED', 'SCREEN', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ResumeParseStatus" AS ENUM ('PENDING', 'PARSING', 'PARSED', 'FAILED');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('ACTIVE', 'HIRED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "InterviewMode" AS ENUM ('ONSITE', 'VIDEO', 'PHONE');

-- CreateEnum
CREATE TYPE "InterviewStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "ScorecardOverall" AS ENUM ('STRONG_YES', 'YES', 'NO', 'STRONG_NO');

-- CreateEnum
CREATE TYPE "DuplicateLinkStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DISMISSED', 'MERGED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'RECRUITER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "department" TEXT,
    "location" TEXT,
    "employmentType" "EmploymentType" NOT NULL DEFAULT 'FULL_TIME',
    "openings" INTEGER NOT NULL DEFAULT 1,
    "status" "JobStatus" NOT NULL DEFAULT 'DRAFT',
    "publicSlug" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_stages" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "StageKind" NOT NULL,
    "order" INTEGER NOT NULL,
    "slaDays" INTEGER,

    CONSTRAINT "job_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidates" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "normalizedEmail" TEXT NOT NULL,
    "phoneE164" TEXT,
    "normalizedName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resumes" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "parseStatus" "ResumeParseStatus" NOT NULL DEFAULT 'PENDING',
    "parsedProfile" JSONB,
    "parseError" TEXT,
    "parserVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resumes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "currentStageId" TEXT NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" TEXT NOT NULL DEFAULT 'careers_site',
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stage_events" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "fromStageId" TEXT,
    "toStageId" TEXT NOT NULL,
    "actorId" TEXT,
    "reason" TEXT,
    "isBackwardMove" BOOLEAN NOT NULL DEFAULT false,
    "durationInPrevStageSec" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interviews" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "durationMin" INTEGER NOT NULL DEFAULT 45,
    "mode" "InterviewMode" NOT NULL DEFAULT 'VIDEO',
    "status" "InterviewStatus" NOT NULL DEFAULT 'SCHEDULED',
    "locationOrLink" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_panelists" (
    "interviewId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "interview_panelists_pkey" PRIMARY KEY ("interviewId","userId")
);

-- CreateTable
CREATE TABLE "scorecards" (
    "id" TEXT NOT NULL,
    "interviewId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "overall" "ScorecardOverall" NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scorecards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scorecard_ratings" (
    "id" TEXT NOT NULL,
    "scorecardId" TEXT NOT NULL,
    "criterion" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "comment" TEXT,

    CONSTRAINT "scorecard_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "duplicate_candidate_links" (
    "id" TEXT NOT NULL,
    "candidateAId" TEXT NOT NULL,
    "candidateBId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "signals" JSONB NOT NULL,
    "status" "DuplicateLinkStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "duplicate_candidate_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metrics_rollups" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metrics_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_orgId_email_key" ON "users"("orgId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_publicSlug_key" ON "jobs"("publicSlug");

-- CreateIndex
CREATE INDEX "jobs_orgId_status_idx" ON "jobs"("orgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "job_stages_jobId_order_key" ON "job_stages"("jobId", "order");

-- CreateIndex
CREATE INDEX "candidates_orgId_normalizedEmail_idx" ON "candidates"("orgId", "normalizedEmail");

-- CreateIndex
CREATE INDEX "candidates_orgId_phoneE164_idx" ON "candidates"("orgId", "phoneE164");

-- CreateIndex
CREATE INDEX "resumes_candidateId_idx" ON "resumes"("candidateId");

-- CreateIndex
CREATE INDEX "resumes_contentHash_idx" ON "resumes"("contentHash");

-- CreateIndex
CREATE INDEX "applications_jobId_currentStageId_idx" ON "applications"("jobId", "currentStageId");

-- CreateIndex
CREATE INDEX "applications_status_idx" ON "applications"("status");

-- CreateIndex
CREATE UNIQUE INDEX "applications_candidateId_jobId_key" ON "applications"("candidateId", "jobId");

-- CreateIndex
CREATE INDEX "stage_events_applicationId_createdAt_idx" ON "stage_events"("applicationId", "createdAt");

-- CreateIndex
CREATE INDEX "stage_events_toStageId_idx" ON "stage_events"("toStageId");

-- CreateIndex
CREATE INDEX "interviews_applicationId_idx" ON "interviews"("applicationId");

-- CreateIndex
CREATE INDEX "interviews_scheduledAt_idx" ON "interviews"("scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "scorecards_interviewId_authorId_key" ON "scorecards"("interviewId", "authorId");

-- CreateIndex
CREATE INDEX "duplicate_candidate_links_status_idx" ON "duplicate_candidate_links"("status");

-- CreateIndex
CREATE UNIQUE INDEX "duplicate_candidate_links_candidateAId_candidateBId_key" ON "duplicate_candidate_links"("candidateAId", "candidateBId");

-- CreateIndex
CREATE INDEX "outbox_events_status_availableAt_idx" ON "outbox_events"("status", "availableAt");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_idx" ON "notifications"("userId", "readAt");

-- CreateIndex
CREATE INDEX "audit_logs_orgId_entityType_entityId_idx" ON "audit_logs"("orgId", "entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "metrics_rollups_orgId_metric_scope_key" ON "metrics_rollups"("orgId", "metric", "scope");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stages" ADD CONSTRAINT "job_stages_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resumes" ADD CONSTRAINT "resumes_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_currentStageId_fkey" FOREIGN KEY ("currentStageId") REFERENCES "job_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_events" ADD CONSTRAINT "stage_events_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_events" ADD CONSTRAINT "stage_events_fromStageId_fkey" FOREIGN KEY ("fromStageId") REFERENCES "job_stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_events" ADD CONSTRAINT "stage_events_toStageId_fkey" FOREIGN KEY ("toStageId") REFERENCES "job_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_events" ADD CONSTRAINT "stage_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_panelists" ADD CONSTRAINT "interview_panelists_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_panelists" ADD CONSTRAINT "interview_panelists_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecard_ratings" ADD CONSTRAINT "scorecard_ratings_scorecardId_fkey" FOREIGN KEY ("scorecardId") REFERENCES "scorecards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_candidate_links" ADD CONSTRAINT "duplicate_candidate_links_candidateAId_fkey" FOREIGN KEY ("candidateAId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_candidate_links" ADD CONSTRAINT "duplicate_candidate_links_candidateBId_fkey" FOREIGN KEY ("candidateBId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
