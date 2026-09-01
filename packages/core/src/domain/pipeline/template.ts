import type { StageKind } from "@prisma/client";

// Seeded onto every new job; fully editable afterwards via the job-stages API
// (rename, reorder, add/remove SCREEN/INTERVIEW rounds). HIRED and REJECTED
// are kept as the last two slots by convention but their reachability is
// governed by `kind`, not by `order` - see domain/pipeline/transitions.ts.
export const DEFAULT_PIPELINE_TEMPLATE: Array<{ name: string; kind: StageKind; slaDays: number | null }> = [
  { name: "Applied", kind: "APPLIED", slaDays: 2 },
  { name: "Phone Screen", kind: "SCREEN", slaDays: 3 },
  { name: "Interview", kind: "INTERVIEW", slaDays: 5 },
  { name: "Offer", kind: "OFFER", slaDays: 5 },
  { name: "Hired", kind: "HIRED", slaDays: null },
  { name: "Rejected", kind: "REJECTED", slaDays: null },
];
