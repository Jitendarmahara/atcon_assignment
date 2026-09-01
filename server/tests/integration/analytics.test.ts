import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";

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
  return { jobId: jobRes.body.id as string, stageByKind };
}

// Regression coverage for a real bug found live: GET /analytics/pipeline-health
// with no jobId (the only way the dashboard actually calls it) grouped by
// individual JobStage id, so every job's own "Applied"/"Phone Screen"/etc.
// rows showed up separately - four jobs meant four "Applied" rows, mostly
// zero, with nothing distinguishing which job was which. Fixed by grouping
// by stage kind for the org-wide view, summing active counts across every
// job's stages of that kind.
describe("pipeline health aggregation", () => {
  it("sums active counts across every job's stages of the same kind, into one row per kind, when no jobId is given", async () => {
    const { token } = await registerOrg("Pipeline Health Org", "owner@pipeline-health.example");
    const auth = { Authorization: `Bearer ${token}` };

    const jobA = await createPublishedJob(auth, "Pipeline Health Role A");
    const jobB = await createPublishedJob(auth, "Pipeline Health Role B");

    // One active application sitting in the APPLIED-kind stage of each job.
    for (const job of [jobA, jobB]) {
      const candidate = await request(app)
        .post("/api/v1/candidates")
        .set(auth)
        .send({ fullName: `Candidate for ${job.jobId}`, email: `candidate-${job.jobId}@pipeline-health.example` });
      await request(app).post("/api/v1/applications").set(auth).send({ candidateId: candidate.body.id, jobId: job.jobId });
    }

    const res = await request(app).get("/api/v1/analytics/pipeline-health").set(auth);
    expect(res.status).toBe(200);

    const appliedRows = res.body.byStage.filter((s: { kind: string }) => s.kind === "APPLIED");
    expect(appliedRows).toHaveLength(1); // one row, not one per job
    expect(appliedRows[0].activeCount).toBe(2); // summed across both jobs
    expect(appliedRows[0].name).toBe("Applied");

    // No duplicate kind rows anywhere in the response.
    const kinds = res.body.byStage.map((s: { kind: string }) => s.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("keeps per-stage detail (not kind-aggregated) when scoped to a single job", async () => {
    const { token } = await registerOrg("Pipeline Health Scoped Org", "owner@pipeline-health-scoped.example");
    const auth = { Authorization: `Bearer ${token}` };
    const { jobId } = await createPublishedJob(auth, "Scoped Role");

    const res = await request(app).get(`/api/v1/analytics/pipeline-health?jobId=${jobId}`).set(auth);
    expect(res.status).toBe(200);
    // The default template seeds 6 distinct stages for one job - all present,
    // each with its own real stageId (not a kind used as a synthetic one).
    expect(res.body.byStage.length).toBe(6);
    for (const stage of res.body.byStage) {
      expect(stage.stageId).not.toBe(stage.kind);
    }
  });
});
