import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { createClaudeStructurer } from "./claudeStructurer.js";
import { createDeepseekStructurer } from "./deepseekStructurer.js";
import type { ParsedProfile, ResumeStructurer } from "./types.js";

export { extractResumeText } from "./extract.js";
export type { ParsedProfile } from "./types.js";

// DeepSeek checked first when both happen to be configured - no significance
// to the order beyond picking one deterministically; both are equally valid
// structurers behind the same interface.
const llmStructurer: ResumeStructurer | null = env.DEEPSEEK_API_KEY
  ? createDeepseekStructurer(env.DEEPSEEK_API_KEY)
  : env.ANTHROPIC_API_KEY
    ? createClaudeStructurer(env.ANTHROPIC_API_KEY)
    : null;

if (!llmStructurer) {
  logger.warn(
    "resume parsing: neither DEEPSEEK_API_KEY nor ANTHROPIC_API_KEY is set - every resume upload will fail to parse until one is configured",
  );
}

// LLM-only, deliberately: an earlier version of this fell back to a
// regex/keyword-based heuristic structurer whenever the LLM call failed,
// reasoning that "some structure, even low-quality, beats a failed job." In
// practice that traded a rare, honest failure for a routine, silent one - the
// heuristic repeatedly produced confidently-wrong output on real resumes
// (duplicated sections, category labels glued onto skill names, an
// unrecognized "KEY PROJECTS" header corrupting the experience list) that
// still carried a "PARSED" badge, indistinguishable at a glance from a
// correct result. A recruiter trusting mangled data is a worse outcome than
// a recruiter seeing a clear FAILED status and re-uploading or reading the
// original file - see ASSUMPTIONS.md's changelog for the incident that
// prompted this. BullMQ's own retry policy (5 attempts, exponential backoff -
// see queues/definitions.ts) is the resilience layer now: a transient
// failure (a network blip, a momentary rate limit) gets retried automatically
// without ever reaching a recruiter as a bad parse; a resume that still
// fails after 5 attempts, or that arrives when no LLM key is configured at
// all, ends up FAILED with a real error message, exactly the way any other
// unrecoverable job failure in this system is surfaced.
export async function structureResume(rawText: string): Promise<{ profile: ParsedProfile; parserVersion: string }> {
  if (!llmStructurer) {
    throw new Error("Resume parsing requires DEEPSEEK_API_KEY or ANTHROPIC_API_KEY to be configured");
  }
  const profile = await llmStructurer.structure(rawText);
  return { profile, parserVersion: llmStructurer.version };
}
