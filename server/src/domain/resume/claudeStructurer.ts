import Anthropic from "@anthropic-ai/sdk";
import type { ParsedProfile, ResumeStructurer } from "./types.js";

const MODEL = "claude-sonnet-5";

const EXTRACT_TOOL = {
  name: "record_resume_profile",
  description: "Records structured fields extracted from a resume's raw text.",
  input_schema: {
    type: "object" as const,
    properties: {
      name: { type: "string" },
      email: { type: "string" },
      phone: { type: "string" },
      skills: { type: "array", items: { type: "string" } },
      experience: {
        type: "array",
        items: {
          type: "object",
          properties: {
            employer: { type: "string" },
            title: { type: "string" },
            dates: { type: "string" },
            description: { type: "string" },
          },
        },
      },
      education: {
        type: "array",
        items: {
          type: "object",
          properties: {
            school: { type: "string" },
            degree: { type: "string" },
            field: { type: "string" },
            dates: { type: "string" },
          },
        },
      },
    },
    required: ["skills", "experience", "education"],
  },
};

// Enhancement over the heuristic parser, used only when ANTHROPIC_API_KEY is
// configured. Forces the model's answer through a single tool call so the
// result is guaranteed-structured JSON rather than free text to re-parse.
export function createClaudeStructurer(apiKey: string): ResumeStructurer {
  const client = new Anthropic({ apiKey });

  return {
    version: `${MODEL}@1`,
    async structure(rawText: string): Promise<ParsedProfile> {
      const message = await client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        tools: [EXTRACT_TOOL],
        tool_choice: { type: "tool", name: EXTRACT_TOOL.name },
        messages: [
          {
            role: "user",
            content: `Extract structured fields from this resume text. Only use information present in the text - do not invent employers, dates, or skills.\n\n${rawText.slice(0, 15_000)}`,
          },
        ],
      });

      const toolUse = message.content.find((block) => block.type === "tool_use");
      if (!toolUse || toolUse.type !== "tool_use") {
        throw new Error("Claude did not return a tool_use block");
      }

      const input = toolUse.input as Partial<ParsedProfile>;
      return {
        name: input.name,
        email: input.email,
        phone: input.phone,
        skills: input.skills ?? [],
        experience: input.experience ?? [],
        education: input.education ?? [],
      };
    },
  };
}
