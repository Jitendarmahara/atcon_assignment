export type UserRole = "ADMIN" | "RECRUITER" | "HIRING_MANAGER" | "INTERVIEWER";

// Mirrors the `canManage*`/`requireRole("ADMIN", "RECRUITER", "HIRING_MANAGER")`
// gate used server-side for jobs/candidates/interviews/duplicates mutations
// (see server/src/modules/*/routes.ts). An INTERVIEWER can view everything
// these gate but every one of these actions 403s for them - used to hide
// (not just disable) the corresponding buttons rather than showing a control
// that always fails.
export function canManage(role: UserRole | null | undefined): boolean {
  return role === "ADMIN" || role === "RECRUITER" || role === "HIRING_MANAGER";
}

export interface CurrentUser {
  id: string;
  orgId: string;
  orgSlug: string;
  email: string;
  name: string;
  role: UserRole;
}

export interface OrgUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

export type StageKind = "APPLIED" | "SCREEN" | "INTERVIEW" | "OFFER" | "HIRED" | "REJECTED";

export interface JobStage {
  id: string;
  jobId: string;
  name: string;
  kind: StageKind;
  order: number;
  slaDays: number | null;
}

export type JobStatus = "DRAFT" | "PUBLISHED" | "CLOSED";

export interface Job {
  id: string;
  orgId: string;
  title: string;
  description: string;
  department: string | null;
  location: string | null;
  employmentType: string;
  openings: number;
  status: JobStatus;
  publicSlug: string;
  publishedAt: string | null;
  closedAt: string | null;
  stages: JobStage[];
}

export interface Candidate {
  id: string;
  orgId: string;
  fullName: string;
  email: string;
  phone: string | null;
  mergedIntoId: string | null;
  createdAt: string;
}

export interface Resume {
  id: string;
  candidateId: string;
  originalName: string;
  parseStatus: "PENDING" | "PARSING" | "PARSED" | "FAILED";
  parsedProfile: {
    skills?: string[];
    experience?: Array<{ employer?: string; title?: string; description?: string }>;
    education?: Array<{ school?: string; degree?: string }>;
  } | null;
  parserVersion: string | null;
  createdAt: string;
}

export type ApplicationStatus = "ACTIVE" | "HIRED" | "REJECTED" | "WITHDRAWN";

export interface Application {
  id: string;
  candidateId: string;
  jobId: string;
  currentStageId: string;
  status: ApplicationStatus;
  source: string;
  appliedAt: string;
  closedAt: string | null;
  candidate?: Candidate;
  job?: Job;
  currentStage?: JobStage;
}

export interface StageEvent {
  id: string;
  applicationId: string;
  fromStageId: string | null;
  toStageId: string;
  actorId: string | null;
  reason: string | null;
  isBackwardMove: boolean;
  durationInPrevStageSec: number | null;
  createdAt: string;
  fromStage: JobStage | null;
  toStage: JobStage;
  actor: { id: string; name: string } | null;
}

export interface DuplicateLink {
  id: string;
  candidateAId: string;
  candidateBId: string;
  confidence: number;
  signals: Array<{ name: string; weight: number; detail?: string }>;
  status: "PENDING" | "CONFIRMED" | "DISMISSED" | "MERGED";
  candidateA: Candidate;
  candidateB: Candidate;
}

export interface Interview {
  id: string;
  applicationId: string;
  scheduledAt: string;
  durationMin: number;
  mode: "ONSITE" | "VIDEO" | "PHONE";
  status: "SCHEDULED" | "COMPLETED" | "CANCELLED" | "NO_SHOW";
  locationOrLink: string | null;
  application?: Application;
  panelists?: Array<{ user: { id: string; name: string } }>;
}

export interface Notification {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}
