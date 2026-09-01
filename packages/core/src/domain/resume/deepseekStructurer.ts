import OpenAI from "openai";
import type { ParsedProfile, ResumeStructurer } from "./types.js";

const MODEL = "deepseek-chat";
const BASE_URL = "https://api.deepseek.com/v1";

// DeepSeek's chat-completions API is OpenAI-compatible (same request/response
// shape, including function/tool calling) - the official `openai` client
// pointed at DeepSeek's base URL is DeepSeek's own documented integration
// path, so no separate SDK or hand-rolled HTTP client is needed.
const EXTRACT_TOOL = {
  type: "function" as const,
  function: {
    name: "record_resume_profile",
    description: "Records structured fields extracted from a resume's raw text.",
    parameters: {
      type: "object",
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
  },
};

// Enhancement over the heuristic parser, used only when DEEPSEEK_API_KEY is
// configured - same ResumeStructurer interface and the same "force a single
// tool call so the result is guaranteed-structured JSON" pattern as
// claudeStructurer.ts, so structureResume() (index.ts) can pick either
// without callers needing to know which one produced a given result.
export function createDeepseekStructurer(apiKey: string): ResumeStructurer {
  const client = new OpenAI({ apiKey, baseURL: BASE_URL });

  return {
    version: `${MODEL}@1`,
    async structure(rawText: string): Promise<ParsedProfile> {
      const completion = await client.chat.completions.create({
        model: MODEL,
        max_tokens: 2048,
        tools: [EXTRACT_TOOL],
        tool_choice: { type: "function", function: { name: EXTRACT_TOOL.function.name } },
        messages: [
          {
            role: "user",
            content: `Extract structured fields from this resume text. Only use information present in the text - do not invent employers, dates, or skills. If the same content appears more than once (e.g. a duplicated text layer), extract it only once. Keep paid employment in \`experience\` and personal/side projects in \`projects\` - they are not the same thing even when a resume's own formatting makes them look similar. For each project, actually explain what it does; do not just restate its name.\n\n${rawText.slice(0, 15_000)}`,
          },
        ],
      });

      const toolCall = completion.choices[0]?.message.tool_calls?.[0];
      if (!toolCall || toolCall.type !== "function") {
        throw new Error("DeepSeek did not return a tool call");
      }

      const input = JSON.parse(toolCall.function.arguments) as Partial<ParsedProfile>;
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
