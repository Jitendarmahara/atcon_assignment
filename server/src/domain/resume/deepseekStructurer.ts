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
            content: `Extract structured fields from this resume text. Only use information present in the text - do not invent employers, dates, or skills. If the same content appears more than once (e.g. a duplicated text layer), extract it only once.\n\n${rawText.slice(0, 15_000)}`,
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
        skills: input.skills ?? [],
        experience: input.experience ?? [],
        education: input.education ?? [],
      };
    },
  };
}
