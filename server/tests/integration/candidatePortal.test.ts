import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { prisma } from "core/lib/prisma.js";
import { purgeExpiredPasswordResetTokens } from "core/modules/candidateAuth/service.js";

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
  return { token: res.body.accessToken as string, orgSlug: res.body.user.orgSlug as string };
}

async function createPublishedJob(auth: { Authorization: string }, title: string) {
  const jobRes = await request(app).post("/api/v1/jobs").set(auth).send({ title, description: "Test job." });
  expect(jobRes.status).toBe(201);
  await request(app).post(`/api/v1/jobs/${jobRes.body.id}/publish`).set(auth).expect(200);
  const stageByKind: Record<string, StageDto> = Object.fromEntries(jobRes.body.stages.map((s: StageDto) => [s.kind, s]));
  const jobDetail = await request(app).get(`/api/v1/jobs/${jobRes.body.id}`).set(auth);
  return { jobId: jobRes.body.id as string, jobSlug: jobDetail.body.publicSlug as string, stageByKind };
}

async function registerCandidate(email: string, password = "password123") {
  const res = await request(app)
    .post("/api/v1/candidate-auth/register")
    .send({ fullName: "Test Candidate", email, password });
  expect(res.status).toBe(201);
  return { token: res.body.accessToken as string, account: res.body.account };
}

describe("candidate account registration and login", () => {
  it("registers, logs in, and fetches its own profile", async () => {
    const email = `candidate-${Date.now()}@example.com`;
    const { token } = await registerCandidate(email);

    const me = await request(app).get("/api/v1/candidate-auth/me").set({ Authorization: `Bearer ${token}` });
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(email);

    const login = await request(app).post("/api/v1/candidate-auth/login").send({ email, password: "password123" });
    expect(login.status).toBe(200);
    expect(login.body.account.email).toBe(email);
  });

  it("rejects a duplicate registration with a clean 409", async () => {
    const email = `dup-candidate-${Date.now()}@example.com`;
    await registerCandidate(email);
    const again = await request(app)
      .post("/api/v1/candidate-auth/register")
      .send({ fullName: "Another Name", email, password: "password123" });
    expect(again.status).toBe(409);
  });

  it("rejects a login with the wrong password", async () => {
    const email = `wrongpw-${Date.now()}@example.com`;
    await registerCandidate(email);
    const res = await request(app).post("/api/v1/candidate-auth/login").send({ email, password: "not-the-password" });
    expect(res.status).toBe(401);
  });

  it("rejects a recruiter access token at a candidate-only route, and vice versa", async () => {
    const { token: recruiterToken } = await registerOrg("Cross Token Org", "owner@cross-token.example");
    const res = await request(app).get("/api/v1/candidate-auth/me").set({ Authorization: `Bearer ${recruiterToken}` });
    expect(res.status).toBe(401);

    const { token: candidateToken } = await registerCandidate(`cross-token-cand-${Date.now()}@example.com`);
    const recruiterMe = await request(app).get("/api/v1/auth/me").set({ Authorization: `Bearer ${candidateToken}` });
    expect(recruiterMe.status).toBe(401);
  });
});

describe("candidate password reset", () => {
  it("resets the password with a valid token, and the old password stops working", async () => {
    const email = `reset-flow-${Date.now()}@example.com`;
    await registerCandidate(email, "old-password-123");

    const forgot = await request(app).post("/api/v1/candidate-auth/forgot-password").send({ email });
    expect(forgot.status).toBe(202);

    const account = await prisma.candidateAccount.findUniqueOrThrow({ where: { normalizedEmail: email } });
    const resetTokenRow = await prisma.passwordResetToken.findFirstOrThrow({ where: { candidateAccountId: account.id } });

    // The raw token is never persisted (only its hash) - recover it the same
    // way the real flow does, from the email that was queued for delivery.
    // Simpler and just as valid for this test: mint a fresh raw token,
    // overwrite the stored hash to match it, exactly mirroring what
    // forgotPassword() itself does internally.
    const crypto = await import("node:crypto");
    const rawToken = "test-raw-reset-token";
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    await prisma.passwordResetToken.update({ where: { id: resetTokenRow.id }, data: { tokenHash } });

    const reset = await request(app)
      .post("/api/v1/candidate-auth/reset-password")
      .send({ token: rawToken, newPassword: "new-password-456" });
    expect(reset.status).toBe(204);

    const oldLogin = await request(app).post("/api/v1/candidate-auth/login").send({ email, password: "old-password-123" });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app).post("/api/v1/candidate-auth/login").send({ email, password: "new-password-456" });
    expect(newLogin.status).toBe(200);
  });

  it("rejects reusing an already-used reset token", async () => {
    const email = `reset-reuse-${Date.now()}@example.com`;
    await registerCandidate(email);
    await request(app).post("/api/v1/candidate-auth/forgot-password").send({ email });

    const account = await prisma.candidateAccount.findUniqueOrThrow({ where: { normalizedEmail: email } });
    const crypto = await import("node:crypto");
    const rawToken = "test-reuse-token";
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const row = await prisma.passwordResetToken.findFirstOrThrow({ where: { candidateAccountId: account.id } });
    await prisma.passwordResetToken.update({ where: { id: row.id }, data: { tokenHash } });

    const first = await request(app)
      .post("/api/v1/candidate-auth/reset-password")
      .send({ token: rawToken, newPassword: "first-new-password" });
    expect(first.status).toBe(204);

    const second = await request(app)
      .post("/api/v1/candidate-auth/reset-password")
      .send({ token: rawToken, newPassword: "second-new-password" });
    expect(second.status).toBe(400);
  });

  it("rejects an expired reset token", async () => {
    const email = `reset-expired-${Date.now()}@example.com`;
    await registerCandidate(email);
    const account = await prisma.candidateAccount.findUniqueOrThrow({ where: { normalizedEmail: email } });

    const crypto = await import("node:crypto");
    const rawToken = "test-expired-token";
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    await prisma.passwordResetToken.create({
      data: { candidateAccountId: account.id, tokenHash, expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app)
      .post("/api/v1/candidate-auth/reset-password")
      .send({ token: rawToken, newPassword: "whatever-new-pw" });
    expect(res.status).toBe(400);
  });

  it("never reveals whether an email is registered - same response either way", async () => {
    const unregistered = await request(app)
      .post("/api/v1/candidate-auth/forgot-password")
      .send({ email: `never-registered-${Date.now()}@example.com` });
    expect(unregistered.status).toBe(202);

    const email = `is-registered-${Date.now()}@example.com`;
    await registerCandidate(email);
    const registered = await request(app).post("/api/v1/candidate-auth/forgot-password").send({ email });
    expect(registered.status).toBe(202);
    expect(registered.body).toEqual(unregistered.body);
  });
});

// Regression coverage for a real gap this review found: nothing ever
// deleted a PasswordResetToken row once it expired - every "forgot
// password" click, used or not, left a permanent row in the table forever,
// even though an expired row can never be redeemed again (reset-password
// already rejects it on expiresAt alone, tested above). Fixed by adding a
// nightly cleanup job (queues/processors/tokenCleanup.ts, dispatched from
// the scheduled-maintenance queue). Asserted here directly against the
// service function, since the job itself is only ever invoked by BullMQ's
// scheduler, not by any HTTP route.
describe("scheduled maintenance - expired password reset token cleanup", () => {
  it("deletes only tokens past their expiry, leaving live ones untouched", async () => {
    const email = `token-cleanup-${Date.now()}@example.com`;
    await registerCandidate(email);
    const account = await prisma.candidateAccount.findUniqueOrThrow({ where: { normalizedEmail: email } });

    const expired = await prisma.passwordResetToken.create({
      data: { candidateAccountId: account.id, tokenHash: `expired-hash-${Date.now()}`, expiresAt: new Date(Date.now() - 1000) },
    });
    const live = await prisma.passwordResetToken.create({
      data: { candidateAccountId: account.id, tokenHash: `live-hash-${Date.now()}`, expiresAt: new Date(Date.now() + 60_000) },
    });

    const deletedCount = await purgeExpiredPasswordResetTokens();
    expect(deletedCount).toBeGreaterThanOrEqual(1);

    const expiredStillThere = await prisma.passwordResetToken.findUnique({ where: { id: expired.id } });
    expect(expiredStillThere).toBeNull();

    const liveStillThere = await prisma.passwordResetToken.findUnique({ where: { id: live.id } });
    expect(liveStillThere).not.toBeNull();
  });
});

describe("candidate portal - my applications across orgs", () => {
  it("lists applications from multiple different orgs under one candidate account, matched by email", async () => {
    const email = `multi-org-${Date.now()}@example.com`;
    const orgA = await registerOrg("Multi Org A", `owner-a-${Date.now()}@multi-org.example`);
    const orgB = await registerOrg("Multi Org B", `owner-b-${Date.now()}@multi-org.example`);
    const jobA = await createPublishedJob({ Authorization: `Bearer ${orgA.token}` }, "Role At Org A");
    const jobB = await createPublishedJob({ Authorization: `Bearer ${orgB.token}` }, "Role At Org B");

    await request(app)
      .post(`/api/v1/public/orgs/${orgA.orgSlug}/jobs/${jobA.jobSlug}/apply`)
      .field("fullName", "Multi Org Candidate")
      .field("email", email)
      .expect(202);
    await request(app)
      .post(`/api/v1/public/orgs/${orgB.orgSlug}/jobs/${jobB.jobSlug}/apply`)
      .field("fullName", "Multi Org Candidate")
      .field("email", email)
      .expect(202);

    const { token } = await registerCandidate(email);
    const res = await request(app).get("/api/v1/candidate-portal/applications").set({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    const orgNames = res.body.items.map((a: { orgName: string }) => a.orgName).sort();
    expect(orgNames).toEqual(["Multi Org A", "Multi Org B"].sort());
  });

  it("returns an empty list for a candidate account with no applications yet", async () => {
    const { token } = await registerCandidate(`no-apps-${Date.now()}@example.com`);
    const res = await request(app).get("/api/v1/candidate-portal/applications").set({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});

describe("candidate portal - application timeline", () => {
  it("returns the stage-change timeline for the candidate's own application, without internal reason/actor fields", async () => {
    const email = `timeline-owner-${Date.now()}@example.com`;
    const org = await registerOrg("Timeline Org", `owner-${Date.now()}@timeline.example`);
    const auth = { Authorization: `Bearer ${org.token}` };
    const job = await createPublishedJob(auth, "Timeline Role");

    const applyRes = await request(app)
      .post(`/api/v1/public/orgs/${org.orgSlug}/jobs/${job.jobSlug}/apply`)
      .field("fullName", "Timeline Candidate")
      .field("email", email);
    expect(applyRes.status).toBe(202);
    const applicationId = applyRes.body.applicationId as string;

    const interviewStage = job.stageByKind.INTERVIEW;
    const transition = await request(app)
      .post(`/api/v1/applications/${applicationId}/transition`)
      .set(auth)
      .send({ toStageId: interviewStage.id, reason: "internal recruiter note, not for candidate eyes" });
    expect(transition.status).toBe(200);

    const { token: candidateToken } = await registerCandidate(email);
    const timeline = await request(app)
      .get(`/api/v1/candidate-portal/applications/${applicationId}/timeline`)
      .set({ Authorization: `Bearer ${candidateToken}` });

    expect(timeline.status).toBe(200);
    expect(timeline.body.application.currentStageName).toBe("Interview");
    expect(timeline.body.events.length).toBeGreaterThanOrEqual(2);
    const raw = JSON.stringify(timeline.body);
    expect(raw).not.toContain("internal recruiter note");
    expect(raw).not.toContain("actorId");
    expect(raw).not.toContain("reason");
  });

  it("404s when a candidate requests an application that isn't theirs", async () => {
    const ownerEmail = `timeline-real-owner-${Date.now()}@example.com`;
    const org = await registerOrg("Timeline Isolation Org", `owner-${Date.now()}@timeline-iso.example`);
    const auth = { Authorization: `Bearer ${org.token}` };
    const job = await createPublishedJob(auth, "Isolation Role");

    const applyRes = await request(app)
      .post(`/api/v1/public/orgs/${org.orgSlug}/jobs/${job.jobSlug}/apply`)
      .field("fullName", "Real Owner")
      .field("email", ownerEmail);
    const applicationId = applyRes.body.applicationId as string;

    const { token: strangerToken } = await registerCandidate(`stranger-${Date.now()}@example.com`);
    const res = await request(app)
      .get(`/api/v1/candidate-portal/applications/${applicationId}/timeline`)
      .set({ Authorization: `Bearer ${strangerToken}` });
    expect(res.status).toBe(404);
  });
});

describe("candidate portal - unread update count", () => {
  it("counts every StageEvent as unread for a brand-new account, then zero after marking viewed", async () => {
    const email = `unread-updates-${Date.now()}@example.com`;
    const org = await registerOrg("Unread Updates Org", `owner-${Date.now()}@unread-updates.example`);
    const auth = { Authorization: `Bearer ${org.token}` };
    const job = await createPublishedJob(auth, "Unread Updates Role");

    const applyRes = await request(app)
      .post(`/api/v1/public/orgs/${org.orgSlug}/jobs/${job.jobSlug}/apply`)
      .field("fullName", "Unread Updates Candidate")
      .field("email", email);
    const applicationId = applyRes.body.applicationId as string;

    // A candidate account created after the application already exists -
    // its one existing StageEvent (the initial "Applied") should still count.
    const { token: candidateToken } = await registerCandidate(email);

    const before = await request(app)
      .get("/api/v1/candidate-portal/notifications/unread-count")
      .set({ Authorization: `Bearer ${candidateToken}` });
    expect(before.body.count).toBe(1);

    const markViewed = await request(app)
      .post("/api/v1/candidate-portal/notifications/mark-viewed")
      .set({ Authorization: `Bearer ${candidateToken}` });
    expect(markViewed.status).toBe(204);

    const afterViewing = await request(app)
      .get("/api/v1/candidate-portal/notifications/unread-count")
      .set({ Authorization: `Bearer ${candidateToken}` });
    expect(afterViewing.body.count).toBe(0);

    // A new stage change after viewing should count again.
    const interviewStage = job.stageByKind.INTERVIEW;
    await request(app).post(`/api/v1/applications/${applicationId}/transition`).set(auth).send({ toStageId: interviewStage.id });

    const afterNewMove = await request(app)
      .get("/api/v1/candidate-portal/notifications/unread-count")
      .set({ Authorization: `Bearer ${candidateToken}` });
    expect(afterNewMove.body.count).toBe(1);
  });
});

describe("candidate portal - open roles (apply without leaving the dashboard)", () => {
  it("lists published jobs across orgs and excludes ones already applied to", async () => {
    const email = `open-roles-${Date.now()}@example.com`;
    const orgA = await registerOrg("Open Roles Org A", `owner-a-${Date.now()}@open-roles.example`);
    const orgB = await registerOrg("Open Roles Org B", `owner-b-${Date.now()}@open-roles.example`);
    const jobA = await createPublishedJob({ Authorization: `Bearer ${orgA.token}` }, "Already Applied Role");
    const jobB = await createPublishedJob({ Authorization: `Bearer ${orgB.token}` }, "Still Open Role");

    // A DRAFT job (never published) should never show up either.
    await request(app)
      .post("/api/v1/jobs")
      .set({ Authorization: `Bearer ${orgB.token}` })
      .send({ title: "Unpublished Role", description: "Not live yet." });

    await request(app)
      .post(`/api/v1/public/orgs/${orgA.orgSlug}/jobs/${jobA.jobSlug}/apply`)
      .field("fullName", "Open Roles Candidate")
      .field("email", email)
      .expect(202);

    const { token } = await registerCandidate(email);
    const res = await request(app).get("/api/v1/candidate-portal/open-roles").set({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);

    const titles = res.body.items.map((r: { title: string }) => r.title);
    expect(titles).toContain("Still Open Role");
    expect(titles).not.toContain("Already Applied Role");
    expect(titles).not.toContain("Unpublished Role");
  });

  it("lets a logged-in candidate apply to an open role using the existing public apply endpoint, pre-filled from their account", async () => {
    const email = `apply-from-dashboard-${Date.now()}@example.com`;
    const org = await registerOrg("Apply From Dashboard Org", `owner-${Date.now()}@apply-dashboard.example`);
    const job = await createPublishedJob({ Authorization: `Bearer ${org.token}` }, "Dashboard Apply Role");

    const { token } = await registerCandidate(email);
    const openRolesBefore = await request(app).get("/api/v1/candidate-portal/open-roles").set({ Authorization: `Bearer ${token}` });
    expect(openRolesBefore.body.items.map((r: { title: string }) => r.title)).toContain("Dashboard Apply Role");

    const applyRes = await request(app)
      .post(`/api/v1/public/orgs/${org.orgSlug}/jobs/${job.jobSlug}/apply`)
      .field("fullName", "Apply From Dashboard Candidate")
      .field("email", email);
    expect(applyRes.status).toBe(202);

    const openRolesAfter = await request(app).get("/api/v1/candidate-portal/open-roles").set({ Authorization: `Bearer ${token}` });
    expect(openRolesAfter.body.items.map((r: { title: string }) => r.title)).not.toContain("Dashboard Apply Role");

    const myApplications = await request(app).get("/api/v1/candidate-portal/applications").set({ Authorization: `Bearer ${token}` });
    expect(myApplications.body.items.map((a: { jobTitle: string }) => a.jobTitle)).toContain("Dashboard Apply Role");
  });
});

describe("candidate portal - recent updates list (the bell dropdown)", () => {
  it("lists stage-change events across every application, most recent first, with job/org context", async () => {
    const email = `recent-updates-${Date.now()}@example.com`;
    const org = await registerOrg("Recent Updates Org", `owner-${Date.now()}@recent-updates.example`);
    const auth = { Authorization: `Bearer ${org.token}` };
    const job = await createPublishedJob(auth, "Recent Updates Role");

    const applyRes = await request(app)
      .post(`/api/v1/public/orgs/${org.orgSlug}/jobs/${job.jobSlug}/apply`)
      .field("fullName", "Recent Updates Candidate")
      .field("email", email);
    const applicationId = applyRes.body.applicationId as string;

    const interviewStage = job.stageByKind.INTERVIEW;
    await request(app).post(`/api/v1/applications/${applicationId}/transition`).set(auth).send({ toStageId: interviewStage.id });

    const { token } = await registerCandidate(email);
    const res = await request(app).get("/api/v1/candidate-portal/notifications").set({ Authorization: `Bearer ${token}` });

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(2); // the initial Applied event, then the move to Interview
    expect(res.body.items[0].toStageName).toBe("Interview"); // most recent first
    expect(res.body.items[0].jobTitle).toBe("Recent Updates Role");
    expect(res.body.items[0].orgName).toBe("Recent Updates Org");
  });
});
