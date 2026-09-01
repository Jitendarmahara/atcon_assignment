// Domain event catalogue. Each is written to OutboxEvent inside the same
// transaction as the state change it describes (see events/outbox.ts) and
// picked up by the relay in queues/index.ts, which fans it out to the
// appropriate BullMQ queue.

export const EVENT_TYPES = {
  RESUME_UPLOADED: "resume.uploaded",
  APPLICATION_SUBMITTED: "application.submitted",
  APPLICATION_STAGE_CHANGED: "application.stage_changed",
  INTERVIEW_SCHEDULED: "interview.scheduled",
  CANDIDATE_DUPLICATE_SUSPECTED: "candidate.duplicate_suspected",
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export interface ResumeUploadedPayload {
  resumeId: string;
  candidateId: string;
  orgId: string;
}

export interface ApplicationSubmittedPayload {
  applicationId: string;
  candidateId: string;
  jobId: string;
  orgId: string;
}

export interface ApplicationStageChangedPayload {
  applicationId: string;
  orgId: string;
  fromStageId: string | null;
  toStageId: string;
  toStageKind: string;
  actorId: string | null;
}

export interface InterviewScheduledPayload {
  interviewId: string;
  applicationId: string;
  orgId: string;
  panelistUserIds: string[];
}
