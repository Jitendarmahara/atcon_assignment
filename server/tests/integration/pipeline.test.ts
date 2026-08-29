import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";

const app = createApp();

interface StageDto {
  id: string;
  kind: string;
}

async function registerOrg(email: string) {
  const res = await request(app)
    .post("/api/v1/auth/register")
    .send({ orgName: `Test Org ${email}`, name: "Test Admin", email, password: "password123" });
  expect(res.status).toBe(201);
  return res.body.accessToken as string;
}

async function createPublishedJob(auth: { Authorization: string }, title: string) {
  const jobRes = await request(app).post("/api/v1/jobs").set(auth).send({ title, description: "Test job." });
  expect(jobRes.status).toBe(201);
  await request(app).post(`/api/v1/jobs/${jobRes.body.id}/publish`).set(auth).expect(200);
  const stageByKind: Record<string, StageDto> = Object.fromEntries(jobRes.body.stages.map((s: StageDto) => [s.kind, s]));
  return { jobId: jobRes.body.id as string, stageByKind };
}

// Covers the state machine end-to-end through the real HTTP layer (not just
// the domain unit tests in tests/unit/) - this is the flow described in the
// case study's own verification script: apply, move through stages, hit the
// guard rails, and confirm the concurrency guarantee holds.
describe("applicant pipeline (HTTP)", () => {
  it("walks an application through legal transitions and rejects illegal ones", async () => {
    const token = await registerOrg("owner1@pipeline-test.example");
    const auth = { Authorization: `Bearer ${token}` };
    const { jobId, stageByKind } = await createPublishedJob(auth, "QA Engineer");

    const candidate = await request(app)
      .post("/api/v1/candidates")
      .set(auth)
      .send({ fullName: "Test Candidate", email: "candidate@pipeline-test.example" });
    expect(candidate.status).toBe(201);

    const application = await request(app)
      .post("/api/v1/applications")
      .set(auth)
      .send({ candidateId: candidate.body.id, jobId });
    expect(application.status).toBe(201);
    const applicationId = application.body.id as string;

    // illegal: straight to HIRED from APPLIED
    const illegalHire = await request(app)
      .post(`/api/v1/applications/${applicationId}/transition`)
      .set(auth)
      .send({ toStageId: stageByKind.HIRED!.id });
    expect(illegalHire.status).toBe(422);

    // legal forward skip: APPLIED -> INTERVIEW
    const toInterview = await request(app)
      .post(`/api/v1/applications/${applicationId}/transition`)
      .set(auth)
      .send({ toStageId: stageByKind.INTERVIEW!.id });
    expect(toInterview.status).toBe(200);

    // reject without a reason is rejected (pun intended)
    const rejectNoReason = await request(app)
      .post(`/api/v1/applications/${applicationId}/transition`)
      .set(auth)
      .send({ toStageId: stageByKind.REJECTED!.id });
    expect(rejectNoReason.status).toBe(422);

    // reject with a reason succeeds and closes the application
    const reject = await request(app)
      .post(`/api/v1/applications/${applicationId}/transition`)
      .set(auth)
      .send({ toStageId: stageByKind.REJECTED!.id, reason: "Not a fit" });
    expect(reject.status).toBe(200);
    expect(reject.body.application.status).toBe("REJECTED");

    // once terminal, no further transitions are allowed
    const afterTerminal = await request(app)
      .post(`/api/v1/applications/${applicationId}/transition`)
      .set(auth)
      .send({ toStageId: stageByKind.INTERVIEW!.id });
    expect(afterTerminal.status).toBe(422);

    // timeline: initial "applied" + interview move + rejection = 3 events
    const events = await request(app).get(`/api/v1/applications/${applicationId}/events`).set(auth);
    expect(events.body.items).toHaveLength(3);
  });

  it("enforces optimistic concurrency on simultaneous transitions", async () => {
    const token = await registerOrg("owner2@pipeline-test.example");
    const auth = { Authorization: `Bearer ${token}` };
    const { jobId, stageByKind } = await createPublishedJob(auth, "Concurrency Role");

    const candidate = await request(app)
      .post("/api/v1/candidates")
      .set(auth)
      .send({ fullName: "Race Condition", email: "race@pipeline-test.example" });
    const application = await request(app)
      .post("/api/v1/applications")
      .set(auth)
      .send({ candidateId: candidate.body.id, jobId });
    const applicationId = application.body.id as string;

    const [r1, r2] = await Promise.all([
      request(app).post(`/api/v1/applications/${applicationId}/transition`).set(auth).send({ toStageId: stageByKind.SCREEN!.id }),
      request(app).post(`/api/v1/applications/${applicationId}/transition`).set(auth).send({ toStageId: stageByKind.SCREEN!.id }),
    ]);

    expect([r1.status, r2.status].sort()).toEqual([200, 409]);

    // exactly one successful transition was recorded, never two
    const events = await request(app).get(`/api/v1/applications/${applicationId}/events`).set(auth);
    expect(events.body.items).toHaveLength(2); // initial "applied" + the one winning transition
  });

  it("prevents a second application from the same candidate to the same job", async () => {
    const token = await registerOrg("owner3@pipeline-test.example");
    const auth = { Authorization: `Bearer ${token}` };
    const { jobId } = await createPublishedJob(auth, "Duplicate Apply Role");

    const candidate = await request(app)
      .post("/api/v1/candidates")
      .set(auth)
      .send({ fullName: "Repeat Applicant", email: "repeat@pipeline-test.example" });

    await request(app).post("/api/v1/applications").set(auth).send({ candidateId: candidate.body.id, jobId }).expect(201);
    const second = await request(app).post("/api/v1/applications").set(auth).send({ candidateId: candidate.body.id, jobId });
    expect(second.status).toBe(409);
  });

  it("dedupes candidates by exact phone match and supports an explicit merge", async () => {
    const token = await registerOrg("owner4@pipeline-test.example");
    const auth = { Authorization: `Bearer ${token}` };

    const c1 = await request(app)
      .post("/api/v1/candidates")
      .set(auth)
      .send({ fullName: "Jane Doe", email: "jane@dedupe-test.example", phone: "415-555-0111" });
    const c2 = await request(app)
      .post("/api/v1/candidates")
      .set(auth)
      .send({ fullName: "J Doe", email: "jane2@dedupe-test.example", phone: "415-555-0111" });

    expect(c1.body.id).not.toBe(c2.body.id);

    const merge = await request(app).post(`/api/v1/candidates/${c1.body.id}/merge`).set(auth).send({ duplicateId: c2.body.id });
    expect(merge.status).toBe(200);

    const survivor = await request(app).get(`/api/v1/candidates/${c1.body.id}`).set(auth);
    expect(survivor.body.mergedIntoId).toBeNull();

    const merged = await request(app).get(`/api/v1/candidates/${c2.body.id}`).set(auth);
    expect(merged.body.mergedIntoId).toBe(c1.body.id);
  });
});
