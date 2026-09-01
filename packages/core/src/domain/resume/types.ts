export interface ParsedExperience {
  employer?: string;
  title?: string;
  dates?: string;
  description?: string;
}

// Deliberately not folded into experience: a personal/side/portfolio
// project isn't paid employment, and a fresher (entry-level candidate with
// little or no work history) is often mostly *made of* this section - if it
// were merged into experience, the two would render identically and a
// recruiter would lose the one signal ("did they get paid to do this, or
// build it on their own") that a fresher's resume most needs to convey.
export interface ParsedProject {
  name?: string;
  // A plain-language explanation of what the project actually does, not
  // just its name copied verbatim - a resume's own project name ("preps")
  // rarely explains itself to a recruiter with no context.
  description?: string;
  link?: string;
}

export interface ParsedEducation {
  school?: string;
  degree?: string;
  field?: string;
  dates?: string;
}

export interface ParsedProfile {
  name?: string;
  email?: string;
  phone?: string;
  summary?: string;
  skills: string[];
  experience: ParsedExperience[];
  projects: ParsedProject[];
  education: ParsedEducation[];
}

// Both LLM structurers (DeepSeek, Claude) implement this interface so
// structureResume() (index.ts) never needs to know which one produced a
// given result - parserVersion on the Resume record does, for
// reproducibility. There is no third, non-LLM implementation: an earlier
// heuristic/regex-based structurer existed as a fallback for exactly this
// interface, but repeatedly produced confidently-wrong-looking output (see
// ASSUMPTIONS.md's changelog) - a resume genuinely failing to parse, with a
// clear FAILED status and error message, is a better outcome for a
// recruiter than a "PARSED" badge on data that's silently mangled.
export interface ResumeStructurer {
  readonly version: string;
  structure(rawText: string): Promise<ParsedProfile>;
}
