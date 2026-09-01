import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { prisma } from "core/lib/prisma.js";
import { dedupeScanQueue } from "core/queues/definitions.js";
import { relayOnce } from "core/events/relay.js";
import { EVENT_TYPES } from "core/events/types.js";
import { subscribeOrgEvents } from "core/lib/pubsub.js";
import { notifyOrgRecruiters } from "core/lib/notify.js";
import { prisma as scopedAwarePrisma, runWithOrgScope } from "core/lib/prisma.js";
import { scanFullDuplicatesForCandidate } from "core/domain/dedupe/scan.js";

const app = createApp();

interface StageDto {
  id: string;
  kind: string;
}

async function registerOrg(orgName: string, email: string) {
  const res = await request(app)
    .post("/api/v1/auth/register")
    .send({ orgName, name: "Test Admin", email, password: "password123" });
  expect(res.status).toBe(201);
  return { token: res.body.accessToken as string, orgSlug: res.body.user.orgSlug as string, userId: res.body.user.id as string };
}

async function createPublishedJob(auth: { Authorization: string }, title: string) {
  const jobRes = await request(app).post("/api/v1/jobs").set(auth).send({ title, description: "Test job." });
  expect(jobRes.status).toBe(201);
  await request(app).post(`/api/v1/jobs/${jobRes.body.id}/publish`).set(auth).expect(200);
  const stageByKind: Record<string, StageDto> = Object.fromEntries(jobRes.body.stages.map((s: StageDto) => [s.kind, s]));
  return { jobId: jobRes.body.id as string, stageByKind };
}

// Waits for the next org-scoped pub/sub event of a given type (see
// lib/pubsub.ts / modules/realtime/stream.ts) - the actual mechanism behind
// the kanban board and notification bell's live updates.
function waitForOrgEvent(orgId: string, type: string, timeoutMs = 2000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for org event "${type}"`));
    }, timeoutMs);
    const unsubscribe = subscribeOrgEvents(orgId, (event) => {
      if (event.type !== type) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event.payload);
    });
  });
}

describe("candidate identity integrity", () => {
  // This test intentionally loses a P2002 race in createOrGetCandidate() and
  // recovers from it (see server/src/modules/candidates/service.ts) - Prisma
  // logs the underlying constraint violation to stderr as part of its own
  // "error"-level query logging even though the app catches and handles it.
  // That "prisma:error ... Unique constraint failed" line is expected noise
  // from this specific test, not a failure.
  it("never creates two candidate rows for the same email under concurrent public applies", async () => {
    const { token, orgSlug } = await registerOrg("Race Org", "owner@race-email.example");
    const auth = { Authorization: `Bearer ${token}` };
    const { jobId } = await createPublishedJob(auth, "Race Role");
    const job = await request(app).get(`/api/v1/jobs/${jobId}`).set(auth);
    const jobSlug = job.body.publicSlug as string;

    const applyOnce = () =>
      request(app)
        .post(`/api/v1/public/orgs/${orgSlug}/jobs/${jobSlug}/apply`)
        .send({ fullName: "Double Clicker", email: "double-click@race-email.example" });

    const [r1, r2] = await Promise.all([applyOnce(), applyOnce()]);
    const statuses = [r1.status, r2.status].sort();
    // One apply wins outright (202); the other either loses the application's
    // unique-constraint race (409) or, if it lost the race before the
    // candidate row even existed, still succeeds by reusing the winner's
    // candidate id - either way, never two candidate rows.
    expect(statuses[0]).toBe(202);
    expect([202, 409]).toContain(statuses[1]);

    const candidates = await prisma.candidate.findMany({
      where: { orgId: (await prisma.organization.findUniqueOrThrow({ where: { slug: orgSlug } })).id, normalizedEmail: "double-click@race-email.example" },
    });
    expect(candidates).toHaveLength(1);
  });

  it("routes new activity for an already-merged candidate to the merge survivor, not the tombstoned record", async () => {
    const { token } = await registerOrg("Merge Chain Org", "owner@merge-chain.example");
    const auth = { Authorization: `Bearer ${token}` };

    const original = await request(app)
      .post("/api/v1/candidates")
      .set(auth)
      .send({ fullName: "Original Person", email: "reapply@merge-chain.example" });
    expect(original.status).toBe(201);

    const survivor = await request(app)
      .post("/api/v1/candidates")
      .set(auth)
      .send({ fullName: "Original Person (canonical)", email: "canonical@merge-chain.example" });
    expect(survivor.status).toBe(201);

    const merge = await request(app)
      .post(`/api/v1/candidates/${survivor.body.id}/merge`)
      .set(auth)
      .send({ duplicateId: original.body.id });
    expect(merge.status).toBe(200);

    // The same email that used to belong to the (now tombstoned) original
    // candidate comes in again - createOrGetCandidate must resolve through
    // mergedIntoId to the live survivor rather than reusing the dead row.
    const again = await request(app)
      .post("/api/v1/candidates")
      .set(auth)
      .send({ fullName: "Original Person", email: "reapply@merge-chain.example" });
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(survivor.body.id);
  });

  it("excludes an already-merged candidate as a dedupe-scan match target", async () => {
    const { token } = await registerOrg("Tombstone Scan Org", "owner@tombstone-scan.example");
    const auth = { Authorization: `Bearer ${token}` };

    const c1 = await request(app)
      .post("/api/v1/candidates")
      .set(auth)
      .send({ fullName: "Jane Doe", email: "jane@tombstone-scan.example", phone: "415-555-0100" });
    const c2 = await request(app)
      .post("/api/v1/candidates")
      .set(auth)
      .send({ fullName: "J Doe", email: "jane2@tombstone-scan.example", phone: "415-555-0100" });

    await request(app).post(`/api/v1/candidates/${c1.body.id}/merge`).set(auth).send({ duplicateId: c2.body.id }).expect(200);

    // A third candidate shares the same phone number as the now-tombstoned c2.
    const c3 = await request(app)
      .post("/api/v1/candidates")
      .set(auth)
      .send({ fullName: "J. Doe", email: "jane3@tombstone-scan.example", phone: "415-555-0100" });

    const detail = await request(app).get(`/api/v1/candidates/${c3.body.id}`).set(auth);
    const linkedIds = [
      ...detail.body.duplicateLinksA.map((l: { candidateBId: string }) => l.candidateBId),
      ...detail.body.duplicateLinksB.map((l: { candidateAId: string }) => l.candidateAId),
    ];
    expect(linkedIds).toContain(c1.body.id); // links to the live survivor
    expect(linkedIds).not.toContain(c2.body.id); // never to the tombstoned record
  });
});

describe("auth identity integrity", () => {
  it("rejects registering a new organization with an email already used in another org", async () => {
    await registerOrg("First Org", "shared@cross-org.example");
    const second = await request(app)
      .post("/api/v1/auth/register")
      .send({ orgName: "Second Org", name: "Someone Else", email: "shared@cross-org.example", password: "password123" });
    expect(second.status).toBe(409);
  });
});

// Regression coverage for a gap this review found: RefreshTokenPayload.tokenVersion
// was defined but never actually checked - there was no way to invalidate an
// issued refresh token before its 7-day expiry. Fixed by embedding the
// user's tokenVersion in every refresh token and rejecting one that no
// longer matches; POST /auth/logout bumps it.
describe("refresh token revocation", () => {
  it("rejects a refresh token issued before the most recent logout", async () => {
    const register = await request(app)
      .post("/api/v1/auth/register")
      .send({ orgName: "Revocation Org", name: "Revocation Admin", email: "owner@revocation-test.example", password: "password123" });
    expect(register.status).toBe(201);
    const { accessToken, refreshToken } = register.body as { accessToken: string; refreshToken: string };

    // The token works normally before logout.
    const refreshedOnce = await request(app).post("/api/v1/auth/refresh").send({ refreshToken });
    expect(refreshedOnce.status).toBe(200);

    const logout = await request(app).post("/api/v1/auth/logout").set({ Authorization: `Bearer ${accessToken}` });
    expect(logout.status).toBe(204);

    // Both the original refresh token AND the one minted just before logout
    // (same tokenVersion, since login/register/refresh don't bump it) are
    // now rejected - logout revokes every outstanding refresh token, not
    // just the specific one presented.
    const afterLogout = await request(app).post("/api/v1/auth/refresh").send({ refreshToken });
    expect(afterLogout.status).toBe(401);

    const secondRefreshToken = (refreshedOnce.body as { refreshToken: string }).refreshToken;
    const afterLogoutSecond = await request(app).post("/api/v1/auth/refresh").send({ refreshToken: secondRefreshToken });
    expect(afterLogoutSecond.status).toBe(401);
  });

  it("issues a working refresh token again after logging back in", async () => {
    const register = await request(app)
      .post("/api/v1/auth/register")
      .send({ orgName: "Relogin Org", name: "Relogin Admin", email: "owner@relogin-test.example", password: "password123" });
    const { accessToken } = register.body as { accessToken: string };

    await request(app).post("/api/v1/auth/logout").set({ Authorization: `Bearer ${accessToken}` }).expect(204);

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "owner@relogin-test.example", password: "password123" });
    expect(login.status).toBe(200);

    const refreshed = await request(app).post("/api/v1/auth/refresh").send({ refreshToken: login.body.refreshToken });
    expect(refreshed.status).toBe(200);
  });
});

describe("interview authorization", () => {
  async function setupInterview(auth: { Authorization: string }) {
    const { jobId } = await createPublishedJob(auth, "Backend Engineer");
    const candidate = await request(app)
      .post("/api/v1/candidates")
      .set(auth)
      .send({ fullName: "Interview Candidate", email: "interview-candidate@panel-test.example" });
    const application = await request(app)
      .post("/api/v1/applications")
      .set(auth)
      .send({ candidateId: candidate.body.id, jobId });
    return application.body.id as string;
  }

  async function inviteInterviewer(adminAuth: { Authorization: string }, email: string) {
    const res = await request(app)
      .post("/api/v1/auth/users")
      .set(adminAuth)
      .send({ name: "Panel Interviewer", email, password: "password123", role: "INTERVIEWER" });
    expect(res.status).toBe(201);
    const login = await request(app).post("/api/v1/auth/login").send({ email, password: "password123" });
    return { userId: res.body.id as string, auth: { Authorization: `Bearer ${login.body.accessToken}` } };
  }

  it("blocks scorecard submission by an authenticated user who isn't a panelist", async () => {
    const { token } = await registerOrg("Panel Org", "owner@panel-test.example");
    const adminAuth = { Authorization: `Bearer ${token}` };
    const applicationId = await setupInterview(adminAuth);

    const onPanel = await inviteInterviewer(adminAuth, "on-panel@panel-test.example");
    const offPanel = await inviteInterviewer(adminAuth, "off-panel@panel-test.example");

    const interview = await request(app)
      .post("/api/v1/interviews")
      .set(adminAuth)
      .send({ applicationId, scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), panelistUserIds: [onPanel.userId] });
    expect(interview.status).toBe(201);
    const interviewId = interview.body.id as string;

    const blocked = await request(app)
      .post(`/api/v1/interviews/${interviewId}/scorecards`)
      .set(offPanel.auth)
      .send({ overall: "YES", ratings: [{ criterion: "Overall", score: 3 }] });
    expect(blocked.status).toBe(403);

    const allowed = await request(app)
      .post(`/api/v1/interviews/${interviewId}/scorecards`)
      .set(onPanel.auth)
      .send({ overall: "YES", ratings: [{ criterion: "Overall", score: 3 }] });
    expect(allowed.status).toBe(201);

    // A managing role can still submit on a panelist's behalf even when not listed.
    const adminSubmit = await request(app)
      .post(`/api/v1/interviews/${interviewId}/scorecards`)
      .set(adminAuth)
      .send({ overall: "STRONG_YES", ratings: [{ criterion: "Overall", score: 3 }] });
    expect(adminSubmit.status).toBe(201);
  });

  it("scopes an INTERVIEWER's interview list to interviews they're a panelist on", async () => {
    const { token } = await registerOrg("Scope Org", "owner@scope-test.example");
    const adminAuth = { Authorization: `Bearer ${token}` };
    const applicationId1 = await setupInterview(adminAuth);
    const applicationId2 = await setupInterview(adminAuth);

    const onPanel = await inviteInterviewer(adminAuth, "scoped-on-panel@scope-test.example");
    const notInvolved = await inviteInterviewer(adminAuth, "scoped-not-involved@scope-test.example");

    await request(app)
      .post("/api/v1/interviews")
      .set(adminAuth)
      .send({ applicationId: applicationId1, scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), panelistUserIds: [onPanel.userId] })
      .expect(201);
    await request(app)
      .post("/api/v1/interviews")
      .set(adminAuth)
      .send({ applicationId: applicationId2, scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), panelistUserIds: [] })
      .expect(201);

    const asAdmin = await request(app).get("/api/v1/interviews").set(adminAuth);
    expect(asAdmin.body.items).toHaveLength(2);

    const asOnPanel = await request(app).get("/api/v1/interviews").set(onPanel.auth);
    expect(asOnPanel.body.items).toHaveLength(1);
    expect(asOnPanel.body.items[0].applicationId).toBe(applicationId1);

    const asNotInvolved = await request(app).get("/api/v1/interviews").set(notInvolved.auth);
    expect(asNotInvolved.body.items).toHaveLength(0);
  });
});

describe("org user directory (for the panelist picker)", () => {
  it("lists only the caller's own org's users, and denies an INTERVIEWER", async () => {
    const orgA = await registerOrg("Directory Org A", "owner@directory-a.example");
    const orgB = await registerOrg("Directory Org B", "owner@directory-b.example");
    const orgAAuth = { Authorization: `Bearer ${orgA.token}` };
    const orgBAuth = { Authorization: `Bearer ${orgB.token}` };

    const invited = await request(app)
      .post("/api/v1/auth/users")
      .set(orgAAuth)
      .send({ name: "Ivy Interviewer", email: "ivy@directory-a.example", password: "password123", role: "INTERVIEWER" });
    expect(invited.status).toBe(201);

    const listA = await request(app).get("/api/v1/auth/users").set(orgAAuth);
    expect(listA.status).toBe(200);
    expect(listA.body.items.map((u: { email: string }) => u.email).sort()).toEqual(
      ["ivy@directory-a.example", "owner@directory-a.example"].sort(),
    );

    const listB = await request(app).get("/api/v1/auth/users").set(orgBAuth);
    expect(listB.body.items).toHaveLength(1); // org B never sees org A's users

    const login = await request(app).post("/api/v1/auth/login").send({ email: "ivy@directory-a.example", password: "password123" });
    const asInterviewer = await request(app)
      .get("/api/v1/auth/users")
      .set({ Authorization: `Bearer ${login.body.accessToken}` });
    expect(asInterviewer.status).toBe(403);
  });
});

// Regression coverage for a real bug this review found: several endpoints
// joined a User relation with `include: { user: true }` / `{ author: true }`
// / `{ actor: true }` instead of a field-whitelisting `select`, which
// serialized the full row - bcrypt passwordHash included - straight into
// the HTTP response for any authenticated org member to read. Fixed by
// selecting only { id, name }; asserted here by checking the raw response
// bodies for the actual hash value, not just the shape of a typed field.
describe("no credential leakage via joined User relations", () => {
  it("never includes passwordHash in interview, scorecard, or stage-event responses", async () => {
    const { token } = await registerOrg("Leak Check Org", "owner@leak-check.example");
    const adminAuth = { Authorization: `Bearer ${token}` };

    const admin = await prisma.user.findFirstOrThrow({ where: { email: "owner@leak-check.example" } });

    const { jobId, stageByKind } = await createPublishedJob(adminAuth, "Leak Check Role");
    const candidate = await request(app)
      .post("/api/v1/candidates")
      .set(adminAuth)
      .send({ fullName: "Leak Check Candidate", email: "candidate@leak-check.example" });
    const application = await request(app)
      .post("/api/v1/applications")
      .set(adminAuth)
      .send({ candidateId: candidate.body.id, jobId });
    const applicationId = application.body.id as string;

    // Generates a StageEvent with a non-null actorId (the admin).
    await request(app)
      .post(`/api/v1/applications/${applicationId}/transition`)
      .set(adminAuth)
      .send({ toStageId: stageByKind.SCREEN!.id })
      .expect(200);

    const interview = await request(app)
      .post("/api/v1/interviews")
      .set(adminAuth)
      .send({ applicationId, scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), panelistUserIds: [admin.id] });
    expect(interview.status).toBe(201);
    const interviewId = interview.body.id as string;

    await request(app)
      .post(`/api/v1/interviews/${interviewId}/scorecards`)
      .set(adminAuth)
      .send({ overall: "YES", ratings: [{ criterion: "Overall", score: 3 }] })
      .expect(201);

    const responses = await Promise.all([
      request(app).get("/api/v1/interviews").set(adminAuth),
      request(app).get(`/api/v1/interviews/${interviewId}/scorecards`).set(adminAuth),
      request(app).get(`/api/v1/applications/${applicationId}/events`).set(adminAuth),
    ]);

    for (const res of responses) {
      const body = JSON.stringify(res.body);
      expect(body).not.toContain("passwordHash");
      expect(body).not.toContain(admin.passwordHash);
    }
  });
});

// Regression coverage for a real bug found live (not just by reading the
// code): scanFullDuplicatesForCandidate() calls scoreDuplicate() up to three
// separate times per candidate pair - once for the exact-match pass, once for
// the resume content-hash pass, once per fuzzy-name-similarity match - each
// producing an independent confidence/signals pair from a single signal.
// upsertLink()'s Prisma `update` clause used to overwrite confidence/signals
// unconditionally on every call, so whichever pass ran last always won, even
// when it was weaker - a real pair sharing an identical resume (0.85,
// resume_content_hash) AND a similar name (e.g. 0.65, name_similarity) ended
// up persisted at 0.65 with the resume-hash signal silently discarded, since
// the fuzzy-name pass always runs last. This directly contradicted
// ARCHITECTURE.md's documented invariant ("the score is the max of whichever
// signals fired, not a sum"), which score.ts's scoreDuplicate() only
// guarantees *within* a single call. Fixed by having upsertLink() read the
// existing row, keep max(existing.confidence, new), and merge signals by name
// instead of overwriting.
describe("duplicate scoring persistence", () => {
  it("keeps the strongest signal's confidence even when a weaker signal is scored afterward for the same pair", async () => {
    const { token, orgSlug } = await registerOrg("Signal Merge Org", "owner@signal-merge.example");
    const auth = { Authorization: `Bearer ${token}` };
    const org = await prisma.organization.findUniqueOrThrow({ where: { slug: orgSlug } });

    const a = await request(app)
      .post("/api/v1/candidates")
      .set(auth)
      .send({ fullName: "Zephyr Quantum", email: "zephyr-a@signal-merge.example" });
    const b = await request(app)
      .post("/api/v1/candidates")
      .set(auth)
      .send({ fullName: "Zephyr Quantumm", email: "zephyr-b@signal-merge.example" }); // similar name, matches trigram threshold

    // Give both candidates a resume with the identical content hash - the
    // strong (0.85) signal that must survive the weaker fuzzy-name pass below.
    const sameHash = "identical-resume-content-hash-for-test";
    await prisma.resume.create({
      data: { candidateId: a.body.id, storageKey: "test/a.pdf", originalName: "a.pdf", mimeType: "application/pdf", sizeBytes: 100, contentHash: sameHash, parseStatus: "PARSED" },
    });
    await prisma.resume.create({
      data: { candidateId: b.body.id, storageKey: "test/b.pdf", originalName: "b.pdf", mimeType: "application/pdf", sizeBytes: 100, contentHash: sameHash, parseStatus: "PARSED" },
    });

    await scanFullDuplicatesForCandidate(org.id, a.body.id);

    const [candA, candB] = [a.body.id, b.body.id].sort();
    const link = await prisma.duplicateCandidateLink.findUniqueOrThrow({
      where: { candidateAId_candidateBId: { candidateAId: candA, candidateBId: candB } },
    });

    expect(link.confidence).toBeGreaterThanOrEqual(0.85);
    const signalNames = (link.signals as Array<{ name: string }>).map((s) => s.name);
    expect(signalNames).toContain("resume_content_hash");
    expect(signalNames).toContain("name_similarity");
  });
});

// Regression coverage for a real gap this review found: the `dedupe-scan`
// BullMQ queue and its processor (queues/processors/dedupeScan.ts) were
// registered as a worker but nothing ever called `dedupeScanQueue.add()` -
// the on-demand rescan was dead code, unreachable from any route. Fixed by
// adding POST /candidates/:candidateId/rescan-duplicates
// (candidates/service.ts:rescanDuplicates). Asserted here by checking the
// queue's actual waiting count, not just the HTTP status code, since a route
// that returns 202 without enqueuing anything would pass a status-only check.
describe("duplicate rescan", () => {
  it("enqueues a dedupe-scan job when a recruiter triggers a rescan", async () => {
    const { token } = await registerOrg("Rescan Org", "owner@rescan-test.example");
    const auth = { Authorization: `Bearer ${token}` };

    const candidate = await request(app)
      .post("/api/v1/candidates")
      .set(auth)
      .send({ fullName: "Rescan Candidate", email: "rescan-candidate@rescan-test.example" });
    expect(candidate.status).toBe(201);

    const before = await dedupeScanQueue.getWaitingCount();

    const res = await request(app).post(`/api/v1/candidates/${candidate.body.id}/rescan-duplicates`).set(auth);
    expect(res.status).toBe(202);

    const after = await dedupeScanQueue.getWaitingCount();
    expect(after).toBe(before + 1);
  });

  it("404s a rescan request for a candidate outside the caller's org", async () => {
    const orgA = await registerOrg("Rescan Org A", "owner@rescan-a.example");
    const orgB = await registerOrg("Rescan Org B", "owner@rescan-b.example");
    const candidate = await request(app)
      .post("/api/v1/candidates")
      .set({ Authorization: `Bearer ${orgA.token}` })
      .send({ fullName: "Org A Candidate", email: "org-a-candidate@rescan-a.example" });

    const res = await request(app)
      .post(`/api/v1/candidates/${candidate.body.id}/rescan-duplicates`)
      .set({ Authorization: `Bearer ${orgB.token}` });
    expect(res.status).toBe(404);
  });
});

// Regression coverage for another gap this review found: AuditLog's own
// schema comment claims it covers "merges, role changes, job publish/close,
// etc.", but only candidate merge actually wrote a row - inviting a user and
// publishing/closing a job wrote nothing. Fixed by adding auditLog.create
// calls to auth/service.ts inviteUser() and jobs/service.ts
// publishJob()/closeJob(), each in the same transaction as the change.
describe("audit trail coverage", () => {
  it("records an audit log entry when a user is invited", async () => {
    const { token, userId: adminId, orgId } = await (async () => {
      const res = await registerOrg("Audit Invite Org", "owner@audit-invite.example");
      const org = await prisma.organization.findUniqueOrThrow({ where: { slug: res.orgSlug } });
      return { ...res, orgId: org.id };
    })();
    const auth = { Authorization: `Bearer ${token}` };

    const invited = await request(app)
      .post("/api/v1/auth/users")
      .set(auth)
      .send({ name: "New Hire", email: "new-hire@audit-invite.example", password: "password123", role: "RECRUITER" });
    expect(invited.status).toBe(201);

    const log = await prisma.auditLog.findFirst({ where: { orgId, action: "user.invite", entityId: invited.body.id } });
    expect(log).not.toBeNull();
    expect(log?.actorId).toBe(adminId);
  });

  it("records an audit log entry when a job is published and closed", async () => {
    const { token } = await registerOrg("Audit Job Org", "owner@audit-job.example");
    const auth = { Authorization: `Bearer ${token}` };

    const job = await request(app).post("/api/v1/jobs").set(auth).send({ title: "Audited Role", description: "Test." });
    expect(job.status).toBe(201);
    const jobId = job.body.id as string;

    await request(app).post(`/api/v1/jobs/${jobId}/publish`).set(auth).expect(200);
    const publishLog = await prisma.auditLog.findFirst({ where: { action: "job.publish", entityId: jobId } });
    expect(publishLog).not.toBeNull();
    expect(publishLog?.after).toMatchObject({ status: "PUBLISHED" });

    await request(app).post(`/api/v1/jobs/${jobId}/close`).set(auth).expect(200);
    const closeLog = await prisma.auditLog.findFirst({ where: { action: "job.close", entityId: jobId } });
    expect(closeLog).not.toBeNull();
    expect(closeLog?.after).toMatchObject({ status: "CLOSED" });
  });
});

// Regression coverage for a schema gap this review found: MetricsRollup.orgId
// was a bare String with no relation to Organization at all - the one
// tenant-scoped model in the schema without referential integrity. Fixed by
// adding an explicit `org Organization @relation(..., onDelete: Cascade)`.
// There's no API surface for rollups (they're written only by the nightly
// metrics-rollup job), so this goes through prisma directly, same as other
// tests in this file that assert on rows with no dedicated read endpoint.
// Regression coverage for a bug an independent review found: GET
// /admin/queues's dead-letter listing (getQueueStatus() in
// modules/admin/service.ts) queried `prisma.outboxEvent.findMany({ where:
// { status: "FAILED" } })` with no orgId filter at all - any org's ADMIN
// could see every OTHER org's failed outbox rows, JSON payload (candidateId/
// applicationId/resumeId) included. Fixed by adding an orgId column to
// OutboxEvent (denormalized from the payload every event type already
// carries) and scoping this query by the caller's own org.
describe("admin queue dead-letter tenant isolation", () => {
  it("never shows another org's failed outbox events in the dead-letter list", async () => {
    const orgA = await registerOrg("Deadletter Org A", "owner@deadletter-a.example");
    const orgB = await registerOrg("Deadletter Org B", "owner@deadletter-b.example");
    const orgAId = await prisma.organization.findUniqueOrThrow({ where: { slug: orgA.orgSlug } }).then((o) => o.id);
    const orgBId = await prisma.organization.findUniqueOrThrow({ where: { slug: orgB.orgSlug } }).then((o) => o.id);

    await prisma.outboxEvent.create({
      data: { orgId: orgAId, type: "test.event", status: "FAILED", payload: { orgId: orgAId, note: "org A failure" } },
    });
    await prisma.outboxEvent.create({
      data: { orgId: orgBId, type: "test.event", status: "FAILED", payload: { orgId: orgBId, note: "org B failure" } },
    });

    const asOrgAAdmin = await request(app).get("/api/v1/admin/queues").set({ Authorization: `Bearer ${orgA.token}` });
    expect(asOrgAAdmin.status).toBe(200);
    const deadLetter = asOrgAAdmin.body.outbox.deadLetter as Array<{ orgId: string }>;
    expect(deadLetter.some((r) => r.orgId === orgAId)).toBe(true);
    expect(deadLetter.some((r) => r.orgId === orgBId)).toBe(false);
  });
});

// Regression coverage for the actual point of Postgres Row-Level Security
// (migration 20260829213000_row_level_security, lib/prisma.ts): every
// service function in this codebase already scopes its queries by orgId
// correctly (both prior adversarial reviews confirmed this), so RLS is a
// deliberately redundant SAFETY NET - it should make no difference to any
// legitimate, correctly-scoped query, and should be the thing that saves you
// the one time a service function's `orgId` filter is missing. This test
// simulates exactly that bug directly (an app-layer query with NO orgId
// filter at all, run inside org A's request scope) and asserts the database
// itself refuses to return or touch another org's row - not because the
// query happened to be written correctly, but because it structurally
// cannot succeed regardless of what the query says.
describe("Postgres Row-Level Security (defense in depth)", () => {
  it("hides another org's row even from a query with no orgId filter at all", async () => {
    const orgA = await registerOrg("RLS Org A", "owner@rls-a.example");
    const orgB = await registerOrg("RLS Org B", "owner@rls-b.example");

    const candidateB = await request(app)
      .post("/api/v1/candidates")
      .set({ Authorization: `Bearer ${orgB.token}` })
      .send({ fullName: "Org B Candidate", email: "candidate@rls-b.example" });
    expect(candidateB.status).toBe(201);
    const candidateBId = candidateB.body.id as string;

    const orgAId = await prisma.organization.findUniqueOrThrow({ where: { slug: orgA.orgSlug } }).then((o) => o.id);
    const orgBId = await prisma.organization.findUniqueOrThrow({ where: { slug: orgB.orgSlug } }).then((o) => o.id);

    // A deliberately "buggy" query - looks up by id alone, the exact mistake
    // RLS exists to catch - scoped under org A's context even though the row
    // belongs to org B.
    const asOrgA = await runWithOrgScope(orgAId, () => scopedAwarePrisma.candidate.findMany({ where: { id: candidateBId } }));
    expect(asOrgA).toHaveLength(0);

    // Same query, scoped under org B's own context, proves the row genuinely
    // exists and the query itself is correct - the emptiness above is RLS,
    // not a typo.
    const asOrgB = await runWithOrgScope(orgBId, () => scopedAwarePrisma.candidate.findMany({ where: { id: candidateBId } }));
    expect(asOrgB).toHaveLength(1);
  });

  it("refuses to write another org's row even from an update with no orgId filter at all", async () => {
    const orgA = await registerOrg("RLS Write Org A", "owner@rls-write-a.example");
    const orgB = await registerOrg("RLS Write Org B", "owner@rls-write-b.example");

    const candidateB = await request(app)
      .post("/api/v1/candidates")
      .set({ Authorization: `Bearer ${orgB.token}` })
      .send({ fullName: "Org B Write Target", email: "write-target@rls-write-b.example" });
    const candidateBId = candidateB.body.id as string;
    const orgAId = await prisma.organization.findUniqueOrThrow({ where: { slug: orgA.orgSlug } }).then((o) => o.id);

    const result = await runWithOrgScope(orgAId, () =>
      scopedAwarePrisma.candidate.updateMany({ where: { id: candidateBId }, data: { fullName: "Hijacked" } }),
    );
    expect(result.count).toBe(0);

    const stillIntact = await prisma.candidate.findUniqueOrThrow({ where: { id: candidateBId } });
    expect(stillIntact.fullName).toBe("Org B Write Target");
  });
});

describe("metrics rollup tenant integrity", () => {
  it("cascade-deletes MetricsRollup rows when their organization is deleted", async () => {
    const org = await prisma.organization.create({ data: { name: "Rollup Org", slug: "rollup-org-cascade-test" } });
    const rollup = await prisma.metricsRollup.create({
      data: { orgId: org.id, metric: "time_to_hire", scope: "org", data: { p50: 5 } },
    });

    await prisma.organization.delete({ where: { id: org.id } });

    const found = await prisma.metricsRollup.findUnique({ where: { id: rollup.id } });
    expect(found).toBeNull();
  });
});

// Regression coverage for a bug an independent review found: removeStage()
// only checked whether an application currently sits in the stage
// (`Application.currentStageId`), but StageEvent.toStageId is
// ON DELETE RESTRICT - a stage that was ever a transition *destination*
// (every job's "Applied" stage, the moment its first application is
// created) can never actually be deleted, even once zero applications
// currently sit there. Before the fix, this hit an unmapped Prisma P2003 at
// the database layer and surfaced as a raw 500, contradicting the documented
// "409 if any application currently sits there" contract.
describe("job stage lifecycle", () => {
  it("returns 409, not a raw 500, when removing a stage referenced by past stage-change history", async () => {
    const { token } = await registerOrg("Stage History Org", "owner@stage-history.example");
    const auth = { Authorization: `Bearer ${token}` };
    const { jobId, stageByKind } = await createPublishedJob(auth, "History Role");

    const candidate = await request(app)
      .post("/api/v1/candidates")
      .set(auth)
      .send({ fullName: "History Candidate", email: "history-candidate@stage-history.example" });
    const application = await request(app)
      .post("/api/v1/applications")
      .set(auth)
      .send({ candidateId: candidate.body.id, jobId });
    const applicationId = application.body.id as string;

    // Move off "Applied" so zero applications currently sit there - the
    // initial "applied" StageEvent still points at it as toStageId, though.
    await request(app)
      .post(`/api/v1/applications/${applicationId}/transition`)
      .set(auth)
      .send({ toStageId: stageByKind.SCREEN!.id })
      .expect(200);

    const remove = await request(app).delete(`/api/v1/jobs/${jobId}/stages/${stageByKind.APPLIED!.id}`).set(auth);
    expect(remove.status).toBe(409);
  });
});

// Regression coverage for a bug an independent review found: getCandidate()
// included ALL duplicateLinksA/B rows regardless of status, so a link a
// recruiter had already dismissed ("not a duplicate") kept showing the
// "possible duplicate" warning banner on the candidate detail page forever -
// the dismiss action had no visible effect from that page.
describe("duplicate link visibility", () => {
  it("stops surfacing a dismissed duplicate link on the candidate detail page", async () => {
    const { token } = await registerOrg("Dismiss Visibility Org", "owner@dismiss-visibility.example");
    const auth = { Authorization: `Bearer ${token}` };

    const c1 = await request(app)
      .post("/api/v1/candidates")
      .set(auth)
      .send({ fullName: "Phone Match One", email: "phone-one@dismiss-visibility.example", phone: "415-555-0199" });
    const c2 = await request(app)
      .post("/api/v1/candidates")
      .set(auth)
      .send({ fullName: "Phone Match Two", email: "phone-two@dismiss-visibility.example", phone: "415-555-0199" });

    const beforeDismiss = await request(app).get(`/api/v1/candidates/${c2.body.id}`).set(auth);
    const linksBefore = [...beforeDismiss.body.duplicateLinksA, ...beforeDismiss.body.duplicateLinksB];
    expect(linksBefore.length).toBeGreaterThan(0);

    const link = await prisma.duplicateCandidateLink.findFirstOrThrow({
      where: {
        OR: [
          { candidateAId: c1.body.id, candidateBId: c2.body.id },
          { candidateAId: c2.body.id, candidateBId: c1.body.id },
        ],
      },
    });

    await request(app).post(`/api/v1/duplicates/${link.id}/dismiss`).set(auth).expect(200);

    const afterDismiss = await request(app).get(`/api/v1/candidates/${c2.body.id}`).set(auth);
    const linksAfter = [...afterDismiss.body.duplicateLinksA, ...afterDismiss.body.duplicateLinksB];
    expect(linksAfter).toHaveLength(0);
  });
});

// Regression coverage for a reliability gap an independent review found: the
// outbox relay used to dispatch (a Redis network call) from inside the same
// Postgres transaction that claimed rows with FOR UPDATE SKIP LOCKED - a
// Redis outage would hang that call indefinitely while still holding a DB
// transaction/connection open, risking connection-pool exhaustion for the
// whole API process. Fixed by claiming into a short-lived PROCESSING lease
// (committed immediately) and dispatching afterward with no open transaction;
// a row that never reaches SENT/FAILED (crash, or a hung dispatch) is
// reclaimed once its lease expires rather than being stranded forever.
// Regression coverage for a documented limitation this pass removed: "no
// real-time push - the kanban board and notification bell update via
// TanStack Query refetch, not WebSockets/SSE." Fixed with Redis pub/sub
// (lib/pubsub.ts) plus an SSE endpoint (modules/realtime/stream.ts). These
// tests exercise the actual publish call sites directly rather than the SSE
// transport itself (an HTTP response stream that never completes doesn't
// fit supertest's request/response model) - subscribeOrgEvents() is the same
// function the SSE handler uses to receive what gets published.
describe("realtime events (pub/sub)", () => {
  async function orgIdFor(orgSlug: string) {
    return (await prisma.organization.findUniqueOrThrow({ where: { slug: orgSlug } })).id;
  }

  it("publishes application.created when a new application is submitted", async () => {
    const { token, orgSlug } = await registerOrg("Realtime Applied Org", "owner@realtime-applied.example");
    const auth = { Authorization: `Bearer ${token}` };
    const orgId = await orgIdFor(orgSlug);
    const { jobId, stageByKind } = await createPublishedJob(auth, "Realtime Role");
    const candidate = await request(app)
      .post("/api/v1/candidates")
      .set(auth)
      .send({ fullName: "Realtime Candidate", email: "realtime-candidate@realtime-applied.example" });

    const eventPromise = waitForOrgEvent(orgId, "application.created");
    const application = await request(app).post("/api/v1/applications").set(auth).send({ candidateId: candidate.body.id, jobId });
    expect(application.status).toBe(201);

    const payload = await eventPromise;
    expect(payload).toMatchObject({ applicationId: application.body.id, jobId, stageId: stageByKind.APPLIED!.id });
  });

  it("publishes application.stage_changed when a transition succeeds", async () => {
    const { token, orgSlug } = await registerOrg("Realtime Transition Org", "owner@realtime-transition.example");
    const auth = { Authorization: `Bearer ${token}` };
    const orgId = await orgIdFor(orgSlug);
    const { jobId, stageByKind } = await createPublishedJob(auth, "Realtime Transition Role");
    const candidate = await request(app)
      .post("/api/v1/candidates")
      .set(auth)
      .send({ fullName: "Realtime Transition Candidate", email: "realtime-transition-candidate@realtime-transition.example" });
    const application = await request(app).post("/api/v1/applications").set(auth).send({ candidateId: candidate.body.id, jobId });

    const eventPromise = waitForOrgEvent(orgId, "application.stage_changed");
    const transition = await request(app)
      .post(`/api/v1/applications/${application.body.id}/transition`)
      .set(auth)
      .send({ toStageId: stageByKind.SCREEN!.id });
    expect(transition.status).toBe(200);

    const payload = await eventPromise;
    expect(payload).toMatchObject({
      applicationId: application.body.id,
      fromStageId: stageByKind.APPLIED!.id,
      toStageId: stageByKind.SCREEN!.id,
    });
  });

  it("publishes one notification.created event per recruiting-role user", async () => {
    const { orgSlug } = await registerOrg("Realtime Notify Org", "owner@realtime-notify.example");
    const orgId = await orgIdFor(orgSlug);
    const admin = await prisma.user.findFirstOrThrow({ where: { email: "owner@realtime-notify.example" } });

    const eventPromise = waitForOrgEvent(orgId, "notification.created");
    await notifyOrgRecruiters(orgId, "application.submitted", { applicationId: "test-app-id" });

    const payload = await eventPromise;
    expect(payload.userId).toBe(admin.id);
  });

  // Regression coverage for a real bug found live: scheduling/cancelling an
  // interview, or completing one via a scorecard, published nothing on the
  // realtime channel at all - unlike every other write path in this app,
  // which all publish here. Combined with web/src/pages/Interviews.tsx
  // having no refetchInterval either, the Interviews page had zero update
  // mechanism (no push, no poll) - not slow, genuinely static until a
  // manual navigation away and back.
  it("publishes interview.scheduled when an interview is scheduled", async () => {
    const { token, orgSlug } = await registerOrg("Realtime Interview Org", "owner@realtime-interview.example");
    const auth = { Authorization: `Bearer ${token}` };
    const orgId = await orgIdFor(orgSlug);
    const { jobId } = await createPublishedJob(auth, "Realtime Interview Role");
    const candidate = await request(app)
      .post("/api/v1/candidates")
      .set(auth)
      .send({ fullName: "Realtime Interview Candidate", email: "realtime-interview-candidate@realtime-interview.example" });
    const application = await request(app).post("/api/v1/applications").set(auth).send({ candidateId: candidate.body.id, jobId });

    const eventPromise = waitForOrgEvent(orgId, "interview.scheduled");
    const interview = await request(app)
      .post("/api/v1/interviews")
      .set(auth)
      .send({ applicationId: application.body.id, scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), panelistUserIds: [] });
    expect(interview.status).toBe(201);

    const payload = await eventPromise;
    expect(payload).toMatchObject({ interviewId: interview.body.id, applicationId: application.body.id });
  });

  it("publishes interview.updated when an interview is cancelled", async () => {
    const { token, orgSlug } = await registerOrg("Realtime Interview Cancel Org", "owner@realtime-interview-cancel.example");
    const auth = { Authorization: `Bearer ${token}` };
    const orgId = await orgIdFor(orgSlug);
    const { jobId } = await createPublishedJob(auth, "Realtime Interview Cancel Role");
    const candidate = await request(app)
      .post("/api/v1/candidates")
      .set(auth)
      .send({ fullName: "Realtime Cancel Candidate", email: "realtime-cancel-candidate@realtime-interview-cancel.example" });
    const application = await request(app).post("/api/v1/applications").set(auth).send({ candidateId: candidate.body.id, jobId });
    const interview = await request(app)
      .post("/api/v1/interviews")
      .set(auth)
      .send({ applicationId: application.body.id, scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), panelistUserIds: [] });

    const eventPromise = waitForOrgEvent(orgId, "interview.updated");
    const cancel = await request(app).post(`/api/v1/interviews/${interview.body.id}/cancel`).set(auth);
    expect(cancel.status).toBe(200);

    const payload = await eventPromise;
    expect(payload).toMatchObject({ interviewId: interview.body.id });
  });
});

describe("outbox relay crash recovery", () => {
  async function fakePayloadFor() {
    const org = await prisma.organization.create({ data: { name: "Relay Test Org", slug: `relay-test-${Date.now()}-${Math.random().toString(36).slice(2)}` } });
    return { applicationId: "x", candidateId: "y", jobId: "z", orgId: org.id };
  }

  it("reclaims a row stuck in PROCESSING once its lease has expired", async () => {
    const payload = await fakePayloadFor();
    const stuck = await prisma.outboxEvent.create({
      data: {
        orgId: payload.orgId,
        type: EVENT_TYPES.APPLICATION_SUBMITTED,
        payload,
        status: "PROCESSING",
        availableAt: new Date(Date.now() - 1000),
      },
    });

    await relayOnce();

    const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(after.status).toBe("SENT");
  });

  it("leaves a row alone while it's still inside its PROCESSING lease window", async () => {
    const payload = await fakePayloadFor();
    const leased = await prisma.outboxEvent.create({
      data: {
        orgId: payload.orgId,
        type: EVENT_TYPES.APPLICATION_SUBMITTED,
        payload,
        status: "PROCESSING",
        availableAt: new Date(Date.now() + 60_000),
      },
    });

    await relayOnce();

    const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: leased.id } });
    expect(after.status).toBe("PROCESSING");
  });
});

// The relay's poll interval was slowed from 1s to 5 minutes once it became a
// backstop rather than the primary dispatch path - dispatchNowBestEffort()
// (events/relay.ts), called directly from the write path right after each
// transaction that writes an outbox row commits, is what actually dispatches
// events promptly now. This proves that's real, not just present in code:
// it never calls relayOnce() or waits anywhere near 5 minutes, so this would
// time out if the fast path weren't actually running.
describe("outbox fast-path dispatch", () => {
  it("dispatches a newly-submitted application's outbox event without waiting for a relay poll tick", async () => {
    const { token, orgSlug } = await registerOrg("Fast Path Org", "owner@fast-path.example");
    const auth = { Authorization: `Bearer ${token}` };
    const { jobId } = await createPublishedJob(auth, "Fast Path Role");
    const job = await request(app).get(`/api/v1/jobs/${jobId}`).set(auth);
    const jobSlug = job.body.publicSlug as string;

    const apply = await request(app)
      .post(`/api/v1/public/orgs/${orgSlug}/jobs/${jobSlug}/apply`)
      .field("fullName", "Fast Path Applicant")
      .field("email", "fast-path-applicant@fast-path.example");
    expect(apply.status).toBe(202);

    const org = await prisma.organization.findUniqueOrThrow({ where: { slug: orgSlug } });
    const deadline = Date.now() + 2000;
    let event = await prisma.outboxEvent.findFirst({
      where: { orgId: org.id, type: EVENT_TYPES.APPLICATION_SUBMITTED },
    });
    while (event?.status !== "SENT" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      event = await prisma.outboxEvent.findFirst({ where: { orgId: org.id, type: EVENT_TYPES.APPLICATION_SUBMITTED } });
    }

    expect(event?.status).toBe("SENT");
  });
});

// Regression coverage for a real bug found live against a running dev server
// (not just by reading the code): both middleware/upload.ts's fileFilter and
// multer's own file-size-limit check throw a plain Error/MulterError, neither
// of which errorHandler.ts's typed branches (ApiError/ZodError/known Prisma
// codes) recognized - both fell through to the generic 500 handler. This
// directly contradicted ASSUMPTIONS.md's documented behavior ("anything else
// is rejected at the upload boundary with a clear error") - a rejected upload
// returned an opaque 500 "Internal server error", not a 4xx explaining why.
// Fixed by having fileFilter throw ApiError.badRequest() (already handled)
// and by mapping MulterError explicitly in errorHandler.ts.
describe("resume upload validation", () => {
  it("rejects an unsupported file type at the public apply endpoint with a clean 400, not a 500", async () => {
    const { token, orgSlug } = await registerOrg("Upload Validation Org", "owner@upload-validation.example");
    const auth = { Authorization: `Bearer ${token}` };
    const { jobId } = await createPublishedJob(auth, "Upload Test Role");
    const job = await request(app).get(`/api/v1/jobs/${jobId}`).set(auth);
    const jobSlug = job.body.publicSlug as string;

    const res = await request(app)
      .post(`/api/v1/public/orgs/${orgSlug}/jobs/${jobSlug}/apply`)
      .field("fullName", "Bad File Applicant")
      .field("email", "bad-file@upload-validation.example")
      .attach("resume", Buffer.from("not a real resume"), { filename: "resume.exe", contentType: "application/x-msdownload" });

    expect(res.status).toBe(400);
    expect(res.body.type).not.toBe("internal-error");
    expect(res.body.detail).toMatch(/PDF and DOCX/);
  });

  it("rejects an oversized resume with a clean 400, not a 500", async () => {
    const { token, orgSlug } = await registerOrg("Upload Size Org", "owner@upload-size.example");
    const auth = { Authorization: `Bearer ${token}` };
    const { jobId } = await createPublishedJob(auth, "Upload Size Role");
    const job = await request(app).get(`/api/v1/jobs/${jobId}`).set(auth);
    const jobSlug = job.body.publicSlug as string;

    const oversized = Buffer.alloc(11 * 1024 * 1024, 0x41); // default MAX_UPLOAD_MB is 10
    const res = await request(app)
      .post(`/api/v1/public/orgs/${orgSlug}/jobs/${jobSlug}/apply`)
      .field("fullName", "Oversized File Applicant")
      .field("email", "oversized@upload-size.example")
      .attach("resume", oversized, { filename: "resume.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
    expect(res.body.type).not.toBe("internal-error");
  });
});

// Regression coverage for a real bug found live: the recruiter notification
// bell's badge count was derived from `items.length` of a `limit=10`-capped
// list (web/src/components/Layout.tsx) - accurate only while unread count
// stayed under 10, then frozen forever past that point even though new
// notifications kept arriving and being visible on the notifications page
// itself. Fixed with a dedicated GET /notifications/unread-count backed by a
// plain COUNT(*), with no list-size ceiling.
describe("notification unread count", () => {
  it("keeps counting past the list endpoint's page size, unlike items.length off a limited list", async () => {
    const { token, orgSlug, userId } = await registerOrg("Unread Count Org", "owner@unread-count.example");
    const auth = { Authorization: `Bearer ${token}` };
    const org = await prisma.organization.findUniqueOrThrow({ where: { slug: orgSlug } });

    // More than the frontend's limit=10 page size.
    await prisma.notification.createMany({
      data: Array.from({ length: 15 }, () => ({ orgId: org.id, userId, type: "application.submitted", payload: {} })),
    });

    const listRes = await request(app).get("/api/v1/notifications?unreadOnly=true&limit=10").set(auth);
    expect(listRes.body.items.length).toBe(10); // the page is correctly capped

    const countRes = await request(app).get("/api/v1/notifications/unread-count").set(auth);
    expect(countRes.status).toBe(200);
    expect(countRes.body.count).toBe(15); // but the count is not
  });
});

// Regression coverage for a real bug found live: GET /notifications ordered
// by `orderBy: { id: "desc" }` - lib/pagination.ts's own comment calls a
// Prisma `id` field "uuid, effectively insertion-ordered enough," which is
// false for a plain v4 UUID (Prisma's default `uuid()`): it's random, with
// no correlation to creation order. Harmless for the several other list
// endpoints using the same `orderBy: { id }` convention (candidates, jobs,
// applications, duplicates - none of them promise newest-first), but a real,
// visible bug for a notification feed, where reverse-chronological order is
// the entire point - notifications appeared to jump around rather than
// listing most-recent-first. Fixed with `orderBy: [{ createdAt: "desc" },
// { id: "desc" }]`, verified here by creating rows with explicit createdAt
// timestamps in a deliberately non-id-correlated order and asserting the
// response comes back sorted by time, not insertion/id order.
describe("notification ordering", () => {
  it("returns notifications ordered by creation time, not by id", async () => {
    const { token, orgSlug, userId } = await registerOrg("Notification Order Org", "owner@notification-order.example");
    const auth = { Authorization: `Bearer ${token}` };
    const org = await prisma.organization.findUniqueOrThrow({ where: { slug: orgSlug } });

    const now = Date.now();
    // Deliberately created in an order where insertion/id order and
    // createdAt order diverge - the middle-timestamped row is created last.
    const oldest = await prisma.notification.create({
      data: { orgId: org.id, userId, type: "application.submitted", payload: {}, createdAt: new Date(now - 60_000) },
    });
    const newest = await prisma.notification.create({
      data: { orgId: org.id, userId, type: "application.submitted", payload: {}, createdAt: new Date(now) },
    });
    const middle = await prisma.notification.create({
      data: { orgId: org.id, userId, type: "application.submitted", payload: {}, createdAt: new Date(now - 30_000) },
    });

    const res = await request(app).get("/api/v1/notifications?limit=10").set(auth);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((n: { id: string }) => n.id);
    expect(ids).toEqual([newest.id, middle.id, oldest.id]);
  });
});

describe("notification removal", () => {
  it("lets a user remove their own notification, and never someone else's", async () => {
    const orgA = await registerOrg("Notification Remove Org A", "owner-a@notification-remove.example");
    const orgB = await registerOrg("Notification Remove Org B", "owner-b@notification-remove.example");
    const authA = { Authorization: `Bearer ${orgA.token}` };
    const authB = { Authorization: `Bearer ${orgB.token}` };
    const org = await prisma.organization.findUniqueOrThrow({ where: { slug: orgA.orgSlug } });

    const notification = await prisma.notification.create({
      data: { orgId: org.id, userId: orgA.userId, type: "application.submitted", payload: {} },
    });

    const crossOrgAttempt = await request(app).delete(`/api/v1/notifications/${notification.id}`).set(authB);
    expect(crossOrgAttempt.status).toBe(404);

    const ownRemoval = await request(app).delete(`/api/v1/notifications/${notification.id}`).set(authA);
    expect(ownRemoval.status).toBe(204);

    const stillThere = await prisma.notification.findUnique({ where: { id: notification.id } });
    expect(stillThere).toBeNull();
  });
});
