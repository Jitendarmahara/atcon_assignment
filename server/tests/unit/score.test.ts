import { describe, it, expect } from "vitest";
import { AUTO_LINK_THRESHOLD, REVIEW_THRESHOLD, scoreDuplicate } from "core/domain/dedupe/score.js";

const base = { emailMatch: false, phoneMatch: false, resumeContentHashMatch: false, nameSimilarity: 0, sharedEmployerOrSchool: false };

describe("scoreDuplicate", () => {
  it("scores an exact email match at 1.0, above the auto-link threshold", () => {
    const { confidence, signals } = scoreDuplicate({ ...base, emailMatch: true });
    expect(confidence).toBe(1.0);
    expect(confidence).toBeGreaterThanOrEqual(AUTO_LINK_THRESHOLD);
    expect(signals.map((s) => s.name)).toContain("exact_email");
  });

  it("scores an exact phone match at 0.9, meeting the auto-link threshold", () => {
    const { confidence } = scoreDuplicate({ ...base, phoneMatch: true });
    expect(confidence).toBe(0.9);
    expect(confidence).toBeGreaterThanOrEqual(AUTO_LINK_THRESHOLD);
  });

  it("scores a resume content-hash match at 0.85, below auto-link but above review", () => {
    const { confidence } = scoreDuplicate({ ...base, resumeContentHashMatch: true });
    expect(confidence).toBe(0.85);
    expect(confidence).toBeLessThan(AUTO_LINK_THRESHOLD);
    expect(confidence).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
  });

  it("puts moderate name similarity in the review band without auto-linking", () => {
    const { confidence } = scoreDuplicate({ ...base, nameSimilarity: 0.5 });
    expect(confidence).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
    expect(confidence).toBeLessThan(AUTO_LINK_THRESHOLD);
  });

  it("does not flag candidates with no meaningful signal as duplicates", () => {
    const { confidence, signals } = scoreDuplicate({ ...base, nameSimilarity: 0.1 });
    expect(confidence).toBe(0);
    expect(signals).toHaveLength(0);
  });

  it("a shared employer/school nudges name-similarity confidence up, but still caps below auto-link", () => {
    const without = scoreDuplicate({ ...base, nameSimilarity: 0.8, sharedEmployerOrSchool: false });
    const withShared = scoreDuplicate({ ...base, nameSimilarity: 0.8, sharedEmployerOrSchool: true });
    expect(withShared.confidence).toBeGreaterThan(without.confidence);
    expect(withShared.confidence).toBeLessThan(AUTO_LINK_THRESHOLD);
  });

  it("takes the strongest signal rather than summing multiple weak ones", () => {
    const { confidence, signals } = scoreDuplicate({ ...base, phoneMatch: true, nameSimilarity: 0.4 });
    expect(confidence).toBe(0.9); // phone match alone, not phone + name-similarity summed
    expect(signals.length).toBeGreaterThan(1); // both signals are still recorded for the audit trail
  });
});
