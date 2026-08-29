import { zodToJsonSchema } from "zod-to-json-schema";
import { registerSchema, loginSchema } from "./modules/auth/schema.js";
import { createJobSchema, createStageSchema } from "./modules/jobs/schema.js";
import { createCandidateSchema, mergeCandidateSchema } from "./modules/candidates/schema.js";
import { createApplicationSchema, transitionApplicationSchema } from "./modules/applications/schema.js";
import { createInterviewSchema, submitScorecardSchema } from "./modules/interviews/schema.js";
import { applySchema } from "./modules/public/schema.js";

// Schemas are generated from the same Zod definitions the request handlers
// validate against (zod-to-json-schema), so the spec can't silently drift
// from what the API actually accepts - only the paths/responses below are
// hand-authored. A fuller setup would attach .openapi() metadata directly to
// each Zod schema (e.g. via @asteasolutions/zod-to-openapi) to also
// auto-generate the paths; documented as a "with more time" item in
// ASSUMPTIONS.md rather than built here, to keep the dependency surface small.
function schema(zodSchema: Parameters<typeof zodToJsonSchema>[0]) {
  return zodToJsonSchema(zodSchema, { target: "openApi3" });
}

const problemDetail = {
  type: "object",
  properties: {
    type: { type: "string" },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string" },
    instance: { type: "string" },
    requestId: { type: "string" },
  },
};

const bearerAuth = [{ bearerAuth: [] as string[] }];

function op(summary: string, opts: { auth?: boolean; body?: unknown; tags: string[] } = { tags: [] }) {
  return {
    summary,
    tags: opts.tags,
    ...(opts.auth === false ? {} : { security: bearerAuth }),
    ...(opts.body ? { requestBody: { content: { "application/json": { schema: opts.body } } } } : {}),
    responses: {
      "200": { description: "OK" },
      "201": { description: "Created" },
      "202": { description: "Accepted" },
      "400": { description: "Bad request", content: { "application/problem+json": { schema: problemDetail } } },
      "401": { description: "Unauthorized", content: { "application/problem+json": { schema: problemDetail } } },
      "403": { description: "Forbidden", content: { "application/problem+json": { schema: problemDetail } } },
      "404": { description: "Not found", content: { "application/problem+json": { schema: problemDetail } } },
      "409": { description: "Conflict", content: { "application/problem+json": { schema: problemDetail } } },
      "422": { description: "Unprocessable entity", content: { "application/problem+json": { schema: problemDetail } } },
    },
  };
}

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "ATS + Candidate Pipeline API",
    version: "1.0.0",
    description:
      "Applicant Tracking + Candidate Pipeline System. All authenticated routes require a Bearer access token from /auth/login. The /public/* routes are unauthenticated (the careers site).",
  },
  servers: [{ url: "/api/v1" }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    schemas: {
      RegisterInput: schema(registerSchema),
      LoginInput: schema(loginSchema),
      CreateJobInput: schema(createJobSchema),
      CreateStageInput: schema(createStageSchema),
      CreateCandidateInput: schema(createCandidateSchema),
      MergeCandidateInput: schema(mergeCandidateSchema),
      CreateApplicationInput: schema(createApplicationSchema),
      TransitionApplicationInput: schema(transitionApplicationSchema),
      CreateInterviewInput: schema(createInterviewSchema),
      SubmitScorecardInput: schema(submitScorecardSchema),
      ApplyInput: schema(applySchema),
      ProblemDetail: problemDetail,
    },
  },
  paths: {
    "/auth/register": { post: op("Register a new organization + admin user", { auth: false, body: { $ref: "#/components/schemas/RegisterInput" }, tags: ["auth"] }) },
    "/auth/login": { post: op("Log in", { auth: false, body: { $ref: "#/components/schemas/LoginInput" }, tags: ["auth"] }) },
    "/auth/refresh": { post: op("Exchange a refresh token for a new token pair", { auth: false, tags: ["auth"] }) },
    "/auth/me": { get: op("Get the current user", { tags: ["auth"] }) },
    "/auth/logout": { post: op("Revoke every refresh token issued to the caller (bumps tokenVersion)", { tags: ["auth"] }) },
    "/auth/users": {
      post: op("Invite a new user into the org (admin only)", { tags: ["auth"] }),
      get: op("List the org's users (for picking interview panelists)", { tags: ["auth"] }),
    },

    "/jobs": {
      post: op("Create a job (seeds the default pipeline stages)", { body: { $ref: "#/components/schemas/CreateJobInput" }, tags: ["jobs"] }),
      get: op("List jobs", { tags: ["jobs"] }),
    },
    "/jobs/{jobId}": { get: op("Get a job", { tags: ["jobs"] }), patch: op("Update a job", { tags: ["jobs"] }) },
    "/jobs/{jobId}/publish": { post: op("Publish a job", { tags: ["jobs"] }) },
    "/jobs/{jobId}/close": { post: op("Close a job", { tags: ["jobs"] }) },
    "/jobs/{jobId}/stages": {
      get: op("List a job's pipeline stages", { tags: ["jobs"] }),
      post: op("Add a pipeline stage", { body: { $ref: "#/components/schemas/CreateStageInput" }, tags: ["jobs"] }),
    },
    "/jobs/{jobId}/stages/reorder": { patch: op("Reorder pipeline stages", { tags: ["jobs"] }) },
    "/jobs/{jobId}/stages/{stageId}": {
      patch: op("Update a pipeline stage", { tags: ["jobs"] }),
      delete: op("Remove a pipeline stage", { tags: ["jobs"] }),
    },

    "/candidates": {
      post: op("Create (or reuse, by email) a candidate", { body: { $ref: "#/components/schemas/CreateCandidateInput" }, tags: ["candidates"] }),
      get: op("List / search candidates", { tags: ["candidates"] }),
    },
    "/candidates/{candidateId}": { get: op("Get a candidate", { tags: ["candidates"] }), patch: op("Update a candidate", { tags: ["candidates"] }) },
    "/candidates/{candidateId}/resumes": { post: op("Upload a resume (multipart/form-data, field: resume)", { tags: ["candidates"] }) },
    "/candidates/{candidateId}/merge": { post: op("Merge a duplicate candidate into this one", { body: { $ref: "#/components/schemas/MergeCandidateInput" }, tags: ["candidates"] }) },
    "/candidates/{candidateId}/rescan-duplicates": { post: op("Trigger a full duplicate-detection rescan for this candidate (async)", { tags: ["candidates"] }) },

    "/duplicates": { get: op("List pending duplicate-candidate links", { tags: ["duplicates"] }) },
    "/duplicates/{linkId}/confirm": { post: op("Confirm a duplicate link", { tags: ["duplicates"] }) },
    "/duplicates/{linkId}/dismiss": { post: op("Dismiss a duplicate link", { tags: ["duplicates"] }) },

    "/applications": {
      post: op("Create an application", { body: { $ref: "#/components/schemas/CreateApplicationInput" }, tags: ["applications"] }),
      get: op("List applications", { tags: ["applications"] }),
    },
    "/applications/{applicationId}": { get: op("Get an application", { tags: ["applications"] }) },
    "/applications/{applicationId}/events": { get: op("Get an application's stage-change timeline", { tags: ["applications"] }) },
    "/applications/{applicationId}/transition": {
      post: op("Move an application to a different pipeline stage", { body: { $ref: "#/components/schemas/TransitionApplicationInput" }, tags: ["applications"] }),
    },

    "/interviews": {
      post: op("Schedule an interview", { body: { $ref: "#/components/schemas/CreateInterviewInput" }, tags: ["interviews"] }),
      get: op("List interviews", { tags: ["interviews"] }),
    },
    "/interviews/{interviewId}/cancel": { post: op("Cancel an interview", { tags: ["interviews"] }) },
    "/interviews/{interviewId}/scorecards": {
      post: op("Submit a scorecard for an interview", { body: { $ref: "#/components/schemas/SubmitScorecardInput" }, tags: ["interviews"] }),
      get: op("List scorecards for an interview", { tags: ["interviews"] }),
    },

    "/analytics/time-to-hire": { get: op("Time-to-hire p50/p90, overall and by job", { tags: ["analytics"] }) },
    "/analytics/funnel": { get: op("Per-stage funnel conversion for a job", { tags: ["analytics"] }) },
    "/analytics/pipeline-health": { get: op("Active counts per stage + stale-candidate alerts", { tags: ["analytics"] }) },
    "/analytics/sources": { get: op("Applications/hires by source", { tags: ["analytics"] }) },

    "/notifications": { get: op("List the current user's notifications", { tags: ["notifications"] }) },
    "/notifications/{notificationId}/read": { post: op("Mark a notification read", { tags: ["notifications"] }) },

    "/admin/queues": { get: op("Queue depths + outbox dead-letter rows (admin only)", { tags: ["admin"] }) },

    "/public/orgs/{orgSlug}/jobs": { get: op("List an org's published jobs (careers site)", { auth: false, tags: ["public"] }) },
    "/public/orgs/{orgSlug}/jobs/{jobSlug}": { get: op("Get a published job (careers site)", { auth: false, tags: ["public"] }) },
    "/public/orgs/{orgSlug}/jobs/{jobSlug}/apply": {
      post: op("Apply to a job (multipart/form-data: fullName, email, phone?, resume file)", { auth: false, body: { $ref: "#/components/schemas/ApplyInput" }, tags: ["public"] }),
    },
  },
};
