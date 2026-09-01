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
      summary: {
        type: "string",
        description: "The resume's own professional summary/objective, if it has one. Omit if there isn't one - do not invent one.",
      },
      skills: { type: "array", items: { type: "string" } },
      experience: {
        type: "array",
        description: "Paid, professional employment only. Personal or side projects go in `projects`, even if the resume lists them under a similar-looking header.",
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
      projects: {
        type: "array",
        description:
          "Personal, side, or portfolio projects - not paid employment. For each, write a clear, plain-language description of what it actually does, in a full sentence a recruiter with no context could understand - never just the project's own name or tagline copied verbatim if that alone wouldn't explain it.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            link: { type: "string" },
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
    required: ["skills", "experience", "projects", "education"],
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
            content: `Extract structured fields from this resume text. Only use information present in the text - do not invent employers, dates, or skills. Keep paid employment in \`experience\` and personal/side projects in \`projects\` - they are not the same thing even when a resume's own formatting makes them look similar. For each project, actually explain what it does; do not just restate its name.\n\n${rawText.slice(0, 15_000)}`,
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
        summary: input.summary,
        skills: input.skills ?? [],
        experience: input.experience ?? [],
        projects: input.projects ?? [],
        education: input.education ?? [],
      };
    },
  };
}
