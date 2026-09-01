import { describe, it, expect } from "vitest";
import { dropRepeatedContent } from "core/domain/resume/extract.js";

// Regression coverage for a real bug found live, diagnosed against a real
// uploaded resume: some resume-builder export pipelines embed the entire
// resume's text twice in one file (a visibly-rendered layer plus a
// duplicate, often an "ATS-friendly" hidden text layer some tools add
// deliberately). pdf.js extracts every text-showing operator regardless of
// layer, so the duplication carried straight into the raw string, and the
// offline heuristic structurer - which has no semantic understanding -
// faithfully doubled every skill, job, and bullet in the parsed output. Only
// the LLM path happened to self-heal it, which is why this went unnoticed
// until a heuristic-parsed resume was inspected directly.
describe("dropRepeatedContent", () => {
  it("truncates to the first copy when the document's opening line repeats verbatim later", () => {
    const text = [
      "Jane Alexandra Doe",
      "SUMMARY",
      "Backend engineer with five years of experience.",
      "SKILLS",
      "TypeScript, PostgreSQL",
      "Jane Alexandra Doe",
      "SUMMARY",
      "Backend engineer with five years of experience.",
      "SKILLS",
      "TypeScript, PostgreSQL",
    ].join("\n");

    const result = dropRepeatedContent(text);
    expect(result.match(/Jane Alexandra Doe/g)?.length).toBe(1);
    expect(result).toContain("TypeScript, PostgreSQL");
    expect(result).not.toContain("SUMMARY\nBackend engineer with five years of experience.\nSKILLS\nTypeScript, PostgreSQL\nJane");
  });

  it("leaves ordinary, non-duplicated text completely untouched", () => {
    const text = ["Jane Alexandra Doe", "SUMMARY", "Backend engineer with five years of experience."].join("\n");
    expect(dropRepeatedContent(text)).toBe(text);
  });

  it("never truncates on a short, generic opening line, to avoid a false positive on a coincidental repeat", () => {
    const text = ["Resume", "Jane Doe worked here.", "Later, Jane Doe also did this."].join("\n");
    expect(dropRepeatedContent(text)).toBe(text);
  });
});
