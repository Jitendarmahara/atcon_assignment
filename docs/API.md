# API Reference

Full interactive docs (generated from the same Zod schemas the handlers validate against) are
served at **http://localhost:4000/api/docs** when the API is running, with the raw spec at
`/api/docs.json`. This document is a quick-scan index.

All routes are under `/api/v1` unless noted. Authenticated routes require
`Authorization: Bearer <accessToken>` from `POST /auth/login`. Errors are
`application/problem+json` throughout (`{ type, title, status, detail, requestId }`).

## Auth

| Method & path | Auth | Notes |
|---|---|---|
| `POST /auth/register` | none | Creates a new org + its first `ADMIN` user. `409` if the email is already in use in *any* org - login has no org selector, so email is a globally unique lookup key |
| `POST /auth/login` | none | Returns `{ user, accessToken, refreshToken }` |
| `POST /auth/refresh` | none | Exchanges a refresh token for a new pair |
| `GET /auth/me` | any | Current user, including `orgSlug` (your public careers-site URL is `/public/:orgSlug`) |
| `POST /auth/logout` | any | Revokes every refresh token issued to the caller (bumps `User.tokenVersion`) - the current access token still works until it naturally expires |
| `POST /auth/users` | `ADMIN` | Invite a user into your org with a given role |
| `GET /auth/users` | `ADMIN`/`RECRUITER`/`HIRING_MANAGER` | List your org's users (id/name/email/role) - used to pick interview panelists |

## Jobs & pipeline stages

| Method & path | Auth | Notes |
|---|---|---|
| `POST /jobs` | manage* | Seeds the default 6-stage pipeline |
| `GET /jobs` | any | Cursor-paginated, `?status=` filter |
| `GET /jobs/:jobId` | any | |
| `PATCH /jobs/:jobId` | manage | |
| `POST /jobs/:jobId/publish` | manage | `DRAFT → PUBLISHED` |
| `POST /jobs/:jobId/close` | manage | `→ CLOSED` |
| `GET /jobs/:jobId/stages` | any | |
| `POST /jobs/:jobId/stages` | manage | |
| `PATCH /jobs/:jobId/stages/reorder` | manage | Body: `{ order: [stageId, ...] }` (full sequence) |
| `PATCH /jobs/:jobId/stages/:stageId` | manage | |
| `DELETE /jobs/:jobId/stages/:stageId` | manage | Rejected (`409`) if any application currently sits there |

\* "manage" = `ADMIN`, `RECRUITER`, or `HIRING_MANAGER`.

## Candidates & duplicates

| Method & path | Auth | Notes |
|---|---|---|
| `POST /candidates` | manage | Create-or-reuse by normalized email |
| `GET /candidates` | any | `?q=` searches name/email |
| `GET /candidates/:candidateId` | any | Includes resumes, applications, duplicate links |
| `PATCH /candidates/:candidateId` | manage | |
| `POST /candidates/:candidateId/resumes` | manage | `multipart/form-data`, field `resume` (PDF/DOCX ≤10MB); returns `202`, parsing happens async |
| `POST /candidates/:candidateId/merge` | manage | Body: `{ duplicateId }` — reassigns resumes/applications onto the caller's candidate id |
| `POST /candidates/:candidateId/rescan-duplicates` | manage | Triggers a full async dedupe rescan (email/phone/resume-hash/fuzzy-name) via the `dedupe-scan` queue; returns `202` |
| `GET /duplicates` | manage | `PENDING` links awaiting review |
| `POST /duplicates/:linkId/confirm` | manage | |
| `POST /duplicates/:linkId/dismiss` | manage | |

## Applications (the pipeline)

| Method & path | Auth | Notes |
|---|---|---|
| `POST /applications` | manage | Body: `{ candidateId, jobId, source? }`; `409` if already applied to that job |
| `GET /applications` | any | `?jobId=&stageId=&status=` filters |
| `GET /applications/:applicationId` | any | |
| `GET /applications/:applicationId/events` | any | Full stage-change audit trail |
| `POST /applications/:applicationId/transition` | manage | Body: `{ toStageId, reason? }`. `422` on an illegal move, `409` on a concurrent-move conflict |

## Interviews & scorecards

| Method & path | Auth | Notes |
|---|---|---|
| `POST /interviews` | manage | Body: `{ applicationId, scheduledAt, durationMin?, mode?, panelistUserIds? }` |
| `GET /interviews` | any | `?applicationId=` filter; an `INTERVIEWER` only sees interviews they're a panelist on, manage roles see all |
| `POST /interviews/:interviewId/cancel` | manage | |
| `POST /interviews/:interviewId/scorecards` | panelist or manage | One per `(interview, author)`. `403` if the caller is neither an assigned panelist nor a manage role |
| `GET /interviews/:interviewId/scorecards` | any | |

## Analytics

| Method & path | Notes |
|---|---|
| `GET /analytics/time-to-hire` | `?jobId=` optional; p50/p90 overall and per job |
| `GET /analytics/funnel` | `?jobId=` **required**; per-stage reach + conversion-from-previous |
| `GET /analytics/pipeline-health` | `?jobId=` optional; active count per stage + stale-candidate list |
| `GET /analytics/sources` | applications/hires/hire-rate by `Application.source` |

## Notifications & admin

| Method & path | Auth | Notes |
|---|---|---|
| `GET /notifications` | any | `?unreadOnly=true` |
| `GET /notifications/unread-count` | any | Plain `COUNT(*)`, not `items.length` off a `limit`-capped list - see ASSUMPTIONS.md for why that distinction is load-bearing |
| `POST /notifications/:notificationId/read` | any (own only) | |
| `GET /admin/queues` | `ADMIN` | BullMQ queue depths + the outbox dead-letter list |

## Public (unauthenticated careers site)

| Method & path | Notes |
|---|---|
| `GET /public/orgs/:orgSlug/jobs` | Published jobs for that org |
| `GET /public/orgs/:orgSlug/jobs/:jobSlug` | One published job |
| `POST /public/orgs/:orgSlug/jobs/:jobSlug/apply` | `multipart/form-data`: `fullName`, `email`, `phone?`, `resume?`. Rate-limited per IP. Returns `202` with `{ candidateId, applicationId }` |

## Candidate portal (a candidate's own login - separate from recruiter auth)

Authenticated with `Authorization: Bearer <candidate accessToken>` from `POST /candidate-auth/login` -
a completely separate token type from a recruiter's (see `lib/jwt.ts`'s `type` claim); one can never
be used in place of the other. Not org-scoped: the same email can have applications across multiple
orgs, all visible from one account.

| Method & path | Auth | Notes |
|---|---|---|
| `POST /candidate-auth/register` | none | `{ fullName, email, password }`. `409` if already registered |
| `POST /candidate-auth/login` | none | Returns `{ account, accessToken, refreshToken }` |
| `POST /candidate-auth/refresh` | none | |
| `GET /candidate-auth/me` | candidate | |
| `POST /candidate-auth/logout` | candidate | Revokes every outstanding refresh token (bumps `CandidateAccount.tokenVersion`) |
| `POST /candidate-auth/forgot-password` | none | Always `202`, regardless of whether the email is registered - never confirms/denies an account's existence |
| `POST /candidate-auth/reset-password` | none | `{ token, newPassword }`. Single-use, 30-minute expiry |
| `GET /candidate-portal/applications` | candidate | Every application matching the caller's own email, across every org |
| `GET /candidate-portal/applications/:applicationId/timeline` | candidate | `404` if the application isn't the caller's own. Deliberately omits `reason`/`actor` - internal recruiter fields, never returned to a candidate |
| `GET /candidate-portal/open-roles` | candidate | Every `PUBLISHED` job across every org, excluding ones already applied to. Applying still goes through the existing public apply endpoint below, just with name/email pre-filled from the account - no separate "browse jobs" page |
| `GET /candidate-portal/notifications/unread-count` | candidate | Count of `StageEvent`s (across every application) newer than the account's `notificationsViewedAt` watermark - the candidate-side equivalent of the recruiter bell, without a second notification table |
| `POST /candidate-portal/notifications/mark-viewed` | candidate | Bumps that watermark to now |

## Real-time

| Method & path | Auth | Notes |
|---|---|---|
| `GET /realtime/stream?token=<accessToken>` | any | Server-Sent Events. The access token travels as a query param (browsers' native `EventSource` can't set an `Authorization` header) - see `modules/realtime/stream.ts`. Pushes `application.created`, `application.stage_changed` (kanban board) and `notification.created` (bell) events, scoped to the caller's org (and, for notifications, the caller's own user id) |

## Outside `/api/v1`

| Method & path | Notes |
|---|---|
| `GET /health` | Process liveness |
| `GET /ready` | Postgres + Redis reachability (`503` if either is down) |
| `GET /api/docs` | Swagger UI |
| `GET /api/docs.json` | Raw OpenAPI 3 document |
