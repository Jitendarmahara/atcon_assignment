import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { heuristicStructurer } from "./heuristicStructurer.js";
import { createClaudeStructurer } from "./claudeStructurer.js";
import { createDeepseekStructurer } from "./deepseekStructurer.js";
import type { ParsedProfile, ResumeStructurer } from "./types.js";

export { extractResumeText } from "./extract.js";
export type { ParsedProfile } from "./types.js";

// DeepSeek checked first when both happen to be configured - no significance
// to the order beyond picking one deterministically; both are equally valid
// "strict enhancement" structurers behind the same interface.
const llmStructurer: ResumeStructurer | null = env.DEEPSEEK_API_KEY
  ? createDeepseekStructurer(env.DEEPSEEK_API_KEY)
  : env.ANTHROPIC_API_KEY
    ? createClaudeStructurer(env.ANTHROPIC_API_KEY)
    : null;

// Tries the LLM structurer first when configured; any failure (network,
// rate limit, malformed response) falls back to the heuristic parser rather
// than failing the whole resume-parse job. Every result is tagged with the
// structurer version that actually produced it.
export async function structureResume(rawText: string): Promise<{ profile: ParsedProfile; parserVersion: string }> {
  if (llmStructurer) {
    try {
      const profile = await llmStructurer.structure(rawText);
      return { profile, parserVersion: llmStructurer.version };
    } catch (err) {
      logger.warn({ err }, "LLM resume structurer failed, falling back to heuristic parser");
    }
  }

  const profile = await heuristicStructurer.structure(rawText);
  return { profile, parserVersion: heuristicStructurer.version };
}
