-- Postgres Row-Level Security: makes cross-tenant data access structurally
-- impossible at the database layer, not just absent by convention in every
-- service function's `orgId` filter (which was the honest, documented gap
-- in docs/ASSUMPTIONS.md - "enforced by convention... a bug in a future
-- service function could, in principle, forget the scope check").
--
-- Mechanism: a dedicated, unprivileged role (`ats_app`) that every
-- AUTHENTICATED request connects as (see server/src/lib/prisma.ts /
-- lib/asyncHandler.ts). Before running any query, the request sets
-- `app.org_id` via `SET LOCAL` inside a transaction - LOCAL, not SESSION,
-- so it's automatically reset the instant that transaction ends and the
-- connection is returned to the pool, and can never leak onto a different
-- request/org that later reuses the same pooled connection. Every table's
-- policy compares against `current_setting('app.org_id', true)` - the
-- `true` (missing_ok) makes an unset setting resolve to NULL rather than
-- error, and NULL never equals anything, so a query that somehow runs
-- without that SET LOCAL having happened returns zero rows rather than
-- either erroring or (far worse) silently seeing every org's data.
--
-- The original, unrestricted connection (DATABASE_URL, whatever role
-- docker-compose's Postgres was initialized with) keeps working completely
-- unchanged - it's a superuser in the local dev image, which always bypasses
-- RLS regardless of ENABLE/FORCE. It's used for exactly the paths that
-- legitimately need cross-org or pre-tenant-context access: registration
-- and login (there's no org to scope by yet - see users' own unique-email
-- comment in schema.prisma), the public unauthenticated careers site, the
-- background worker/relay (a single process servicing every tenant's
-- queued jobs), and the seed script.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ats_app') THEN
    -- Dev-only fixed password, consistent with every other secret already
    -- committed in .env.example - not meant to survive past local/demo use.
    CREATE ROLE ats_app LOGIN PASSWORD 'ats_app_password_dev_only' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO ats_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ats_app;
-- Covers any table added by a later migration without a follow-up GRANT.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ats_app;

-- ── Tables with a direct orgId (or, for organizations, id-as-org) column ──

ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "organizations" FOR ALL TO ats_app
  USING ("id" = current_setting('app.org_id', true))
  WITH CHECK ("id" = current_setting('app.org_id', true));

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "users" FOR ALL TO ats_app
  USING ("orgId" = current_setting('app.org_id', true))
  WITH CHECK ("orgId" = current_setting('app.org_id', true));

ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "jobs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "jobs" FOR ALL TO ats_app
  USING ("orgId" = current_setting('app.org_id', true))
  WITH CHECK ("orgId" = current_setting('app.org_id', true));

ALTER TABLE "candidates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "candidates" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "candidates" FOR ALL TO ats_app
  USING ("orgId" = current_setting('app.org_id', true))
  WITH CHECK ("orgId" = current_setting('app.org_id', true));

ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "outbox_events" FOR ALL TO ats_app
  USING ("orgId" = current_setting('app.org_id', true))
  WITH CHECK ("orgId" = current_setting('app.org_id', true));

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notifications" FOR ALL TO ats_app
  USING ("orgId" = current_setting('app.org_id', true))
  WITH CHECK ("orgId" = current_setting('app.org_id', true));

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_logs" FOR ALL TO ats_app
  USING ("orgId" = current_setting('app.org_id', true))
  WITH CHECK ("orgId" = current_setting('app.org_id', true));

ALTER TABLE "metrics_rollups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "metrics_rollups" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "metrics_rollups" FOR ALL TO ats_app
  USING ("orgId" = current_setting('app.org_id', true))
  WITH CHECK ("orgId" = current_setting('app.org_id', true));

-- ── Tables scoped through a join to an org-scoped table ──

ALTER TABLE "job_stages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_stages" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "job_stages" FOR ALL TO ats_app
  USING (EXISTS (SELECT 1 FROM "jobs" j WHERE j."id" = "job_stages"."jobId" AND j."orgId" = current_setting('app.org_id', true)))
  WITH CHECK (EXISTS (SELECT 1 FROM "jobs" j WHERE j."id" = "job_stages"."jobId" AND j."orgId" = current_setting('app.org_id', true)));

ALTER TABLE "resumes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resumes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "resumes" FOR ALL TO ats_app
  USING (EXISTS (SELECT 1 FROM "candidates" c WHERE c."id" = "resumes"."candidateId" AND c."orgId" = current_setting('app.org_id', true)))
  WITH CHECK (EXISTS (SELECT 1 FROM "candidates" c WHERE c."id" = "resumes"."candidateId" AND c."orgId" = current_setting('app.org_id', true)));

ALTER TABLE "applications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "applications" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "applications" FOR ALL TO ats_app
  USING (EXISTS (SELECT 1 FROM "jobs" j WHERE j."id" = "applications"."jobId" AND j."orgId" = current_setting('app.org_id', true)))
  WITH CHECK (EXISTS (SELECT 1 FROM "jobs" j WHERE j."id" = "applications"."jobId" AND j."orgId" = current_setting('app.org_id', true)));

ALTER TABLE "duplicate_candidate_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "duplicate_candidate_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "duplicate_candidate_links" FOR ALL TO ats_app
  USING (EXISTS (SELECT 1 FROM "candidates" c WHERE c."id" = "duplicate_candidate_links"."candidateAId" AND c."orgId" = current_setting('app.org_id', true)))
  WITH CHECK (EXISTS (SELECT 1 FROM "candidates" c WHERE c."id" = "duplicate_candidate_links"."candidateAId" AND c."orgId" = current_setting('app.org_id', true)));

ALTER TABLE "stage_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stage_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stage_events" FOR ALL TO ats_app
  USING (EXISTS (
    SELECT 1 FROM "applications" a JOIN "jobs" j ON j."id" = a."jobId"
    WHERE a."id" = "stage_events"."applicationId" AND j."orgId" = current_setting('app.org_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "applications" a JOIN "jobs" j ON j."id" = a."jobId"
    WHERE a."id" = "stage_events"."applicationId" AND j."orgId" = current_setting('app.org_id', true)
  ));

ALTER TABLE "interviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "interviews" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "interviews" FOR ALL TO ats_app
  USING (EXISTS (
    SELECT 1 FROM "applications" a JOIN "jobs" j ON j."id" = a."jobId"
    WHERE a."id" = "interviews"."applicationId" AND j."orgId" = current_setting('app.org_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "applications" a JOIN "jobs" j ON j."id" = a."jobId"
    WHERE a."id" = "interviews"."applicationId" AND j."orgId" = current_setting('app.org_id', true)
  ));

ALTER TABLE "interview_panelists" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "interview_panelists" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "interview_panelists" FOR ALL TO ats_app
  USING (EXISTS (
    SELECT 1 FROM "interviews" i JOIN "applications" a ON a."id" = i."applicationId" JOIN "jobs" j ON j."id" = a."jobId"
    WHERE i."id" = "interview_panelists"."interviewId" AND j."orgId" = current_setting('app.org_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "interviews" i JOIN "applications" a ON a."id" = i."applicationId" JOIN "jobs" j ON j."id" = a."jobId"
    WHERE i."id" = "interview_panelists"."interviewId" AND j."orgId" = current_setting('app.org_id', true)
  ));

ALTER TABLE "scorecards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scorecards" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "scorecards" FOR ALL TO ats_app
  USING (EXISTS (
    SELECT 1 FROM "interviews" i JOIN "applications" a ON a."id" = i."applicationId" JOIN "jobs" j ON j."id" = a."jobId"
    WHERE i."id" = "scorecards"."interviewId" AND j."orgId" = current_setting('app.org_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "interviews" i JOIN "applications" a ON a."id" = i."applicationId" JOIN "jobs" j ON j."id" = a."jobId"
    WHERE i."id" = "scorecards"."interviewId" AND j."orgId" = current_setting('app.org_id', true)
  ));

ALTER TABLE "scorecard_ratings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scorecard_ratings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "scorecard_ratings" FOR ALL TO ats_app
  USING (EXISTS (
    SELECT 1 FROM "scorecards" s
      JOIN "interviews" i ON i."id" = s."interviewId"
      JOIN "applications" a ON a."id" = i."applicationId"
      JOIN "jobs" j ON j."id" = a."jobId"
    WHERE s."id" = "scorecard_ratings"."scorecardId" AND j."orgId" = current_setting('app.org_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "scorecards" s
      JOIN "interviews" i ON i."id" = s."interviewId"
      JOIN "applications" a ON a."id" = i."applicationId"
      JOIN "jobs" j ON j."id" = a."jobId"
    WHERE s."id" = "scorecard_ratings"."scorecardId" AND j."orgId" = current_setting('app.org_id', true)
  ));
