import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";

const app = createApp();

interface StageDto {
  id: string;
  order: number;
}

async function registerOrg(email: string) {
  const res = await request(app)
    .post("/api/v1/auth/register")
    .send({ orgName: `Test Org ${email}`, name: "Test Admin", email, password: "password123" });
  expect(res.status).toBe(201);
  return res.body.accessToken as string;
}

describe("job stage reordering", () => {
  // Regression test for a bug where PATCH /jobs/:jobId/stages/reorder ran its
  // updates as an array passed to prisma.$transaction([...]) - which, under
  // lib/prisma.ts's Row-Level-Security-scoping Proxy, executes each update as
  // its own independent, immediately-committing mini-transaction (the array
  // elements are invoked eagerly while the array literal is built, before
  // $transaction is ever called) rather than atomically. In practice this
  // corrupted stage ordering on every real (authenticated, RLS-scoped) call:
  // the negative-offset pass and the final-order pass raced with no ordering
  // guarantee, so stages routinely ended up with a mix of negative and
  // duplicate `order` values instead of a clean 0..n-1 permutation. See
  // jobs/service.ts:reorderStages for the fix.
  it("persists a clean 0..n-1 permutation of stage order, matching the requested sequence", async () => {
    const token = await registerOrg("stage-reorder@jobs-test.example");
    const auth = { Authorization: `Bearer ${token}` };

    const jobRes = await request(app)
      .post("/api/v1/jobs")
      .set(auth)
      .send({ title: "Reorder Test Role", description: "Test job." });
    expect(jobRes.status).toBe(201);
    const jobId = jobRes.body.id as string;
    const originalStages = jobRes.body.stages as StageDto[];
    const reversedIds = [...originalStages].reverse().map((s) => s.id);

    const reorderRes = await request(app)
      .patch(`/api/v1/jobs/${jobId}/stages/reorder`)
      .set(auth)
      .send({ order: reversedIds });
    expect(reorderRes.status).toBe(200);

    function assertCleanPermutation(stages: StageDto[]) {
      const byId = new Map(stages.map((s) => [s.id, s.order]));
      // Every id from the request appears with the exact order it was
      // requested at - not a negative offset, not a value some other
      // concurrently-committing update happened to leave behind.
      reversedIds.forEach((id, expectedOrder) => {
        expect(byId.get(id)).toBe(expectedOrder);
      });
      // And the full set of order values is a clean 0..n-1 permutation - no
      // duplicates, nothing still sitting at a negative offset.
      const orders = stages.map((s) => s.order).sort((a, b) => a - b);
      expect(orders).toEqual(reversedIds.map((_, i) => i));
    }

    assertCleanPermutation(reorderRes.body.items);

    // Re-fetch independently of the mutation's own response, to prove the
    // corrupted state (if any) was actually persisted, not just returned.
    const stagesRes = await request(app).get(`/api/v1/jobs/${jobId}/stages`).set(auth);
    expect(stagesRes.status).toBe(200);
    assertCleanPermutation(stagesRes.body.items);
  });
});
