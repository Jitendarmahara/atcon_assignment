import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { heuristicStructurer } from "./heuristicStructurer.js";
import { createClaudeStructurer } from "./claudeStructurer.js";
import type { ParsedProfile } from "./types.js";

export { extractResumeText } from "./extract.js";
export type { ParsedProfile } from "./types.js";

const claudeStructurer = env.ANTHROPIC_API_KEY ? createClaudeStructurer(env.ANTHROPIC_API_KEY) : null;

// Tries the LLM structurer first when configured; any failure (network,
// rate limit, malformed response) falls back to the heuristic parser rather
// than failing the whole resume-parse job. Every result is tagged with the
// structurer version that actually produced it.
export async function structureResume(rawText: string): Promise<{ profile: ParsedProfile; parserVersion: string }> {
  if (claudeStructurer) {
    try {
      const profile = await claudeStructurer.structure(rawText);
      return { profile, parserVersion: claudeStructurer.version };
    } catch (err) {
      logger.warn({ err }, "Claude resume structurer failed, falling back to heuristic parser");
    }
  }

  const profile = await heuristicStructurer.structure(rawText);
  return { profile, parserVersion: heuristicStructurer.version };
}
