import { describe, it, expect } from "vitest";
import type { JobStage } from "@prisma/client";
import { validateTransition } from "core/domain/pipeline/transitions.js";

function stage(overrides: Partial<JobStage> & Pick<JobStage, "id" | "kind" | "order">): JobStage {
  return {
    jobId: "job-1",
    name: overrides.name ?? overrides.kind,
    slaDays: overrides.slaDays ?? null,
    ...overrides,
  };
}

describe("validateTransition", () => {
  it("rejects any move out of a terminal stage", () => {
    const hired = stage({ id: "hired", kind: "HIRED", order: 4 });
    const offer = stage({ id: "offer", kind: "OFFER", order: 3 });
    expect(() => validateTransition(hired, offer)).toThrow(/terminal/i);
  });

  it("rejects transitioning to the current stage", () => {
    const applied = stage({ id: "applied", kind: "APPLIED", order: 0 });
    expect(() => validateTransition(applied, applied)).toThrow(/already in this stage/i);
  });

  it("only allows HIRED from an OFFER-kind stage", () => {
    const applied = stage({ id: "applied", kind: "APPLIED", order: 0 });
    const hired = stage({ id: "hired", kind: "HIRED", order: 4 });
    expect(() => validateTransition(applied, hired)).toThrow(/Offer-kind/);

    const offer = stage({ id: "offer", kind: "OFFER", order: 3 });
    expect(validateTransition(offer, hired)).toEqual({ isBackwardMove: false });
  });

  it("requires a non-empty reason when rejecting", () => {
    const screen = stage({ id: "screen", kind: "SCREEN", order: 1 });
    const rejected = stage({ id: "rejected", kind: "REJECTED", order: 5 });
    expect(() => validateTransition(screen, rejected)).toThrow(/reason/i);
    expect(() => validateTransition(screen, rejected, "   ")).toThrow(/reason/i);
    expect(validateTransition(screen, rejected, "Not a fit")).toEqual({ isBackwardMove: false });
  });

  it("allows rejection from any non-terminal stage regardless of order", () => {
    const applied = stage({ id: "applied", kind: "APPLIED", order: 0 });
    const rejected = stage({ id: "rejected", kind: "REJECTED", order: 5 });
    expect(validateTransition(applied, rejected, "No response")).toEqual({ isBackwardMove: false });
  });

  it("allows forward skips (e.g. Applied straight to Interview)", () => {
    const applied = stage({ id: "applied", kind: "APPLIED", order: 0 });
    const interview = stage({ id: "interview", kind: "INTERVIEW", order: 2 });
    expect(validateTransition(applied, interview)).toEqual({ isBackwardMove: false });
  });

  it("allows backward moves but flags them for the audit trail", () => {
    const interview = stage({ id: "interview", kind: "INTERVIEW", order: 2 });
    const screen = stage({ id: "screen", kind: "SCREEN", order: 1 });
    expect(validateTransition(interview, screen)).toEqual({ isBackwardMove: true });
  });
});
