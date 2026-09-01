// Layered duplicate-detection scoring. Each signal fires independently and
// contributes a weight; the final confidence is the max of the fired
// signals (not a sum) - two weak signals shouldn't outrank one strong one,
// but the top signal that fired is a good enough estimate of "how sure are we".
//
// Thresholds (enforced by callers, not here):
//   >= 0.9            -> auto-link, no human review needed
//   0.5 <= score < 0.9-> create a PENDING DuplicateCandidateLink for a recruiter to confirm
//   <  0.5            -> not considered a duplicate

export interface DedupeSignal {
  name: string;
  weight: number;
  detail?: string;
}

export interface DedupeInput {
  emailMatch: boolean;
  phoneMatch: boolean;
  resumeContentHashMatch: boolean;
  nameSimilarity: number; // 0-1, e.g. from pg_trgm similarity()
  sharedEmployerOrSchool: boolean;
}

export function scoreDuplicate(input: DedupeInput): { confidence: number; signals: DedupeSignal[] } {
  const signals: DedupeSignal[] = [];

  if (input.emailMatch) signals.push({ name: "exact_email", weight: 1.0 });
  if (input.phoneMatch) signals.push({ name: "exact_phone", weight: 0.9 });
  if (input.resumeContentHashMatch) signals.push({ name: "resume_content_hash", weight: 0.85 });

  if (input.nameSimilarity >= 0.3) {
    // Scale trigram similarity into the 0.4-0.7 "needs review" band; a shared
    // employer/school nudges it up since it's strong corroborating evidence
    // for two records that are NOT exact-matching on email or phone.
    const base = 0.4 + Math.min(input.nameSimilarity, 1) * 0.3;
    const bonus = input.sharedEmployerOrSchool ? 0.15 : 0;
    const weight = Math.min(base + bonus, 0.75);
    signals.push({ name: "name_similarity", weight, detail: `similarity=${input.nameSimilarity.toFixed(2)}` });
  }

  const confidence = signals.reduce((max, s) => Math.max(max, s.weight), 0);
  return { confidence, signals };
}

export const AUTO_LINK_THRESHOLD = 0.9;
export const REVIEW_THRESHOLD = 0.5;
