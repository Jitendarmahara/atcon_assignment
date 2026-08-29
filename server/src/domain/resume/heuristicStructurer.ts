import type { ParsedProfile, ResumeStructurer } from "./types.js";

// Deterministic, dependency-free fallback: works fully offline and always
// succeeds (in the worst case, returns an empty-ish profile) so the parse
// pipeline never hard-fails just because a resume has an unusual layout or
// no LLM key is configured. Section detection is regex/keyword based -
// good enough for well-formatted resumes, documented in ASSUMPTIONS.md as
// the main place accuracy is traded for zero external dependencies.

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/;

const SECTION_HEADERS: Record<"skills" | "experience" | "education", RegExp> = {
  skills: /^(technical\s+)?skills\b/i,
  experience: /^(work\s+)?experience\b|^employment\b/i,
  education: /^education\b/i,
};

function splitIntoSections(lines: string[]) {
  const sections: Record<string, string[]> = { header: [], skills: [], experience: [], education: [] };
  let current = "header";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const matchedSection = (Object.keys(SECTION_HEADERS) as Array<keyof typeof SECTION_HEADERS>).find((key) =>
      SECTION_HEADERS[key].test(trimmed),
    );
    if (matchedSection && trimmed.length < 40) {
      current = matchedSection;
      continue;
    }
    sections[current]!.push(trimmed);
  }
  return sections;
}

function parseSkills(lines: string[]): string[] {
  return lines
    .join(", ")
    .split(/[,;•|]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length < 40);
}

// Groups consecutive lines into blocks (blank-line-free chunks are already
// collapsed by splitIntoSections, so instead we treat every line as a
// candidate "entry start" when it looks like a title/employer line, and
// attach subsequent lines as its description until the next such line).
function parseEntries(lines: string[]): Array<{ heading: string; body: string[] }> {
  const entries: Array<{ heading: string; body: string[] }> = [];
  for (const line of lines) {
    const looksLikeHeading = line.length < 100 && /[A-Z]/.test(line[0] ?? "");
    if (looksLikeHeading && (entries.length === 0 || entries[entries.length - 1]!.body.length > 0)) {
      entries.push({ heading: line, body: [] });
    } else if (entries.length > 0) {
      entries[entries.length - 1]!.body.push(line);
    }
  }
  return entries;
}

export const heuristicStructurer: ResumeStructurer = {
  version: "heuristic@1",
  async structure(rawText: string): Promise<ParsedProfile> {
    const lines = rawText.split(/\r?\n/);
    const sections = splitIntoSections(lines);

    const emailMatch = rawText.match(EMAIL_RE);
    const phoneMatch = rawText.match(PHONE_RE);
    const name = sections.header?.[0]?.slice(0, 100);

    const experience = parseEntries(sections.experience ?? []).map((e) => {
      const [employerOrTitle, ...rest] = e.heading.split(/\s+[-–—@]\s+/);
      return {
        title: employerOrTitle?.trim(),
        employer: rest.join(" - ").trim() || undefined,
        description: e.body.join(" ").slice(0, 500) || undefined,
      };
    });

    const education = parseEntries(sections.education ?? []).map((e) => {
      const [school, ...rest] = e.heading.split(/\s+[-–—@]\s+/);
      return {
        school: school?.trim(),
        degree: rest.join(" - ").trim() || undefined,
      };
    });

    return {
      name,
      email: emailMatch?.[0],
      phone: phoneMatch?.[0],
      skills: parseSkills(sections.skills ?? []),
      experience,
      education,
    };
  },
};
