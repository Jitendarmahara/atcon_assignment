export interface ParsedExperience {
  employer?: string;
  title?: string;
  dates?: string;
  description?: string;
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
  skills: string[];
  experience: ParsedExperience[];
  education: ParsedEducation[];
}

// The LLM structurer is a strict enhancement over the heuristic one, not a
// hard dependency - both implement this interface so callers never need to
// know which one produced a given result (parserVersion on Resume records
// which one did, for reproducibility).
export interface ResumeStructurer {
  readonly version: string;
  structure(rawText: string): Promise<ParsedProfile>;
}
