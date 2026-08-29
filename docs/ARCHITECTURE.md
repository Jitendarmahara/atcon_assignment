# Architecture

## Why this shape

The brief asks for a backend-heavy system evaluated on architecture, prioritization, and
engineering reasoning — not a feature checklist. Four subsystems were treated as the actual
engineering problem and given proportionally more design effort than everything else:

1. a **pipeline state machine** that can't be bypassed by a plain `UPDATE`,
2. a **transactional outbox** so notifications/parsing can never be lost or double-sent,
3. **layered duplicate detection** with confidence scoring instead of a boolean,
4. **analytics computed live from an append-only event log**, with no counters to drift.

Everything else (CRUD for jobs/candidates, auth, file upload) is deliberately conventional —
`routes → controller → service → schema`, one module per resource — so the interesting parts
aren't buried in framework ceremony.

## System overview

```
                    ┌─────────────────────────┐
   Browser  ───────▶│   React + Vite (web/)   │
  (recruiter          - recruiter app (JWT)
   + public)          - public careers site (no auth)
                    └───────────┬─────────────┘
                                │ HTTPS / JSON, multipart for resumes
                                ▼
                    ┌─────────────────────────┐        ┌──────────────┐
                    │   Express API (server)  │───────▶│  PostgreSQL  │
                    │  routes/controllers/    │        │  (Prisma)    │
                    │  services, one module   │◀───────┤              │
                    │  per resource           │        └──────┬───────┘
                    └───────────┬─────────────┘               │
                                │ writes OutboxEvent            │ FOR UPDATE
                                │ in the same transaction       │ SKIP LOCKED
                                ▼                               │
                    ┌─────────────────────────┐                │
                    │  Outbox relay (1s poll) │◀───────────────┘
                    │  runs inside worker.ts  │
                    └───────────┬─────────────┘
                                │ enqueues
                                ▼
                    ┌─────────────────────────┐        ┌──────────────┐
                    │   BullMQ queues + Redis │───────▶│   MailHog    │
                    │  resume-parse, email-   │        │  (SMTP sink) │
                    │  send, dedupe-scan,     │
                    │  interview-reminder,    │        ┌──────────────┐
                    │  metrics-rollup         │───────▶│ Local disk / │
                    └─────────────────────────┘        │ StorageAdapter│
                                                        └──────────────┘
```

The API process and the worker process (`src/index.ts` and `src/worker.ts`) are separate from
the start — a slow LLM call parsing a resume never blocks a request-handling event loop, and
either can be scaled or restarted independently.

## Data model

```
Organization ─┬─ User (role: ADMIN | RECRUITER | HIRING_MANAGER | INTERVIEWER)
              ├─ Job ─── JobStage[]  (recruiter-configurable: name, kind, order, slaDays)
              └─ Candidate ─┬─ Resume[]  (parseStatus, parsedProfile JSON, contentHash)
                             ├─ Application (candidate × job, currentStageId, status)
                             │    ├─ StageEvent[]      ← append-only audit trail + analytics source
                             │    └─ Interview[] ─── Scorecard[] ─── ScorecardRating[]
                             └─ DuplicateCandidateLink (candidateA ↔ candidateB, confidence, signals)

OutboxEvent, Notification, AuditLog, MetricsRollup  — cross-cutting, described below
```

Full field-level detail lives in `server/prisma/schema.prisma` — it's heavily commented inline
rather than duplicated here. A few decisions worth calling out:

- **Every table that holds tenant data carries `orgId`, and every service-layer query filters by
  it from `req.auth.orgId`** — never from a client-supplied value. This is the tenant-isolation
  boundary; it's enforced by convention (every `findOwned*` helper in each service) rather than
  Postgres row-level security, which is the honest tradeoff called out in ASSUMPTIONS.md.
- **`Candidate.normalizedEmail` / `phoneE164` / `normalizedName`** are computed once at write time
  (`domain/dedupe/normalize.ts`) and indexed — exact-match dedupe checks are then plain indexed
  lookups, not a scan-and-compare.
- **A `pg_trgm` GIN index on `normalizedName`** backs the fuzzy-match half of dedupe detection.
- **`Candidate.mergedIntoId`** — a merged candidate's row is kept (not deleted) with this pointer
  set, so old references and history stay intact instead of orphaning.

## The four load-bearing pieces

### 1. Pipeline state machine (`domain/pipeline/`)

A stage move is never `UPDATE application SET currentStageId = ...`. Every move goes through
`transitionApplication()` (`modules/applications/service.ts`), which:

1. **Validates the move** (`domain/pipeline/transitions.ts`) against a small, deliberately
   permissive policy:
   - nothing moves once an application is in a terminal stage (`HIRED`/`REJECTED`),
   - `HIRED` is only reachable from an `OFFER`-kind stage,
   - `REJECTED` is reachable from any non-terminal stage, but requires a `reason`,
   - every other forward/backward move is allowed (real pipelines skip steps — fast-tracking a
     referral past a phone screen is normal), but a backward move is flagged
     (`isBackwardMove: true`) in the audit trail rather than silently allowed.
2. **Applies an optimistic-concurrency update**: `UPDATE applications SET currentStageId = ...
   WHERE id = ? AND currentStageId = ?`. Postgres row-locks this statement, so if two recruiters
   drag the same card at once, the loser's `UPDATE` affects zero rows the moment it's unblocked
   (it re-evaluates the `WHERE` clause against the now-committed row) and the request returns
   `409 Conflict` — never a silent overwrite, never two winners.
3. **Writes exactly one `StageEvent`** in the same transaction, with `durationInPrevStageSec`
   computed from the previous event's timestamp.
4. **Writes an `OutboxEvent`** (`application.stage_changed`) in the same transaction.

One commit, or nothing. This is verified directly: `tests/integration/pipeline.test.ts` fires two
concurrent transition requests at the same application and asserts exactly one `200`, one `409`,
and exactly one new `StageEvent` row.

### 2. Transactional outbox (`events/`)

Domain events (`resume.uploaded`, `application.submitted`, `application.stage_changed`,
`interview.scheduled`) are written to an `OutboxEvent` row inside the *same* database transaction
as the change they describe. A relay (`events/relay.ts`), running inside `worker.ts` on a 1-second
poll, ticks in two phases so a slow or unreachable Redis can never hold a database transaction
hostage:

1. **Claim** — a short transaction selects pending/lease-expired rows with `FOR UPDATE SKIP LOCKED`
   (safe for multiple relay instances) and flips them to `PROCESSING` with a 60-second lease, then
   commits immediately.
2. **Dispatch** — outside any open transaction, each claimed row is sent to the matching BullMQ
   queue using a deterministic `jobId` derived from the outbox row's id (so a crash-and-restart
   between "enqueued" and "marked SENT" produces a duplicate `add()` call that BullMQ simply
   dedupes, not a duplicate email), then marked `SENT`.

This is the actual reliability story: **a transaction that rolls back never produced an event, and
Redis being briefly down never loses one** — the row just sits `PENDING`/`PROCESSING` until the
relay's next tick (or, if a dispatch was mid-flight when the process crashed, until its lease
expires and another tick reclaims it) — and no single tick can pin a Postgres connection open for
longer than a Redis call actually takes, since dispatch never runs inside the claiming transaction.
A dispatch failure gets exponential backoff up to 8 attempts, then flips to `FAILED` and surfaces
at `GET /api/v1/admin/queues` as a dead-letter row for manual inspection.

### 3. Duplicate detection (`domain/dedupe/`)

Layered, with a confidence score rather than a boolean (`domain/dedupe/score.ts`):

| Signal | Weight | When it fires |
|---|---|---|
| Exact email match | 1.0 | always checked, synchronously, on candidate create/update |
| Exact phone match (E.164) | 0.9 | same |
| Resume content-hash match | 0.85 | after resume parsing, in the background |
| Name similarity (`pg_trgm`) + shared employer/school | 0.4–0.75 | same |

The score is the **max** of whichever signals fired, not a sum — two weak signals shouldn't
outrank one strong one. `confidence ≥ 0.9` auto-confirms the link (no review queue entry needed);
`0.5 ≤ confidence < 0.9` creates a `PENDING DuplicateCandidateLink` for a recruiter to confirm or
dismiss at `GET /duplicates`. **Auto-confirming a link never auto-merges the underlying records** —
merging (`POST /candidates/:id/merge`) is always an explicit, audited action, even at 1.0
confidence, because reassigning applications and resumes is not something that should happen
without a human in the loop.

### 4. Analytics (`modules/analytics/`)

Every number on the dashboard is a live SQL query over `StageEvent`/`Application` — there are no
separately-maintained counters that could drift from reality:

- **time-to-hire** — `percentile_cont` (p50/p90) over `hire_event.createdAt - application.appliedAt`,
  overall and per job
- **funnel** — `COUNT(DISTINCT applicationId)` of `StageEvent`s reaching each configured stage, with
  conversion-from-previous computed in application code
- **pipeline health** — active-application count per stage, plus a **stale-candidates** list (a
  `LATERAL` join finds each active application's most recent `StageEvent` and flags it if
  `now() - createdAt > stage.slaDays`) — this is the number a recruiting lead actually opens the
  dashboard to see
- **source effectiveness** — applications and hires grouped by `Application.source`

A nightly `metrics-rollup` BullMQ job (repeatable, 2am) snapshots all of the above into a
`MetricsRollup` table keyed by `(orgId, metric, scope)`. Nothing reads from it yet — it exists to
demonstrate the scale-out path (see below) without adding a caching layer that a dataset this size
doesn't need.

## Resume parsing

Two independently-swappable stages, both behind interfaces (`domain/resume/`):

1. **Extract** (`extract.ts`) — `pdfjs-dist` for PDF, `mammoth` for DOCX, both to raw text. Line
   breaks are reconstructed from pdf.js's per-item `hasEOL` flag, not by joining items with
   spaces — the naive approach collapses an entire page into one line and silently breaks every
   section-header heuristic downstream. (`pdf-parse`, a more commonly reached-for library, was
   tried first and dropped: it bundles a frozen 2018-era pdf.js that throws on any PDF using
   cross-reference streams — the default output of LibreOffice, Chrome's print-to-PDF, and modern
   Word/Google Docs exports. `pdfjs-dist` is Mozilla's actual, actively-maintained engine.)
2. **Structure** (`heuristicStructurer.ts` / `claudeStructurer.ts`, picked by `index.ts`) — a
   regex/section-header heuristic that always works offline, or `claude-sonnet-5` via structured
   tool-use when `ANTHROPIC_API_KEY` is set. The LLM path is a strict enhancement: any failure
   (network, rate limit, malformed response) falls back to the heuristic rather than failing the
   job. Every `Resume.parserVersion` records which one actually produced the result.

## Background jobs

| Queue | Trigger | Idempotency |
|---|---|---|
| `resume-parse` | `resume.uploaded` outbox event | job id = outbox row id |
| `email-send` | `application.submitted`, `application.stage_changed`, `interview.scheduled` | same |
| `interview-reminder` | scheduled by the relay as a **delayed** job at (interview time − 24h) | re-checks interview status at fire time; a no-op if cancelled/rescheduled |
| `dedupe-scan` | `POST /candidates/:id/rescan-duplicates` | re-running is safe — it upserts links, never duplicates them |
| `metrics-rollup` | repeatable, nightly cron | upserts by `(orgId, metric, scope)` |

All queues use exponential backoff (5 attempts, base 2s) and bounded retention
(`removeOnComplete`/`removeOnFail` counts) so Redis memory doesn't grow unbounded in a long-running
demo.

## Postgres Row-Level Security

Tenant isolation used to be enforced entirely at the application layer — every service function
scoping its own queries by `orgId` from `req.auth`, consistently, but by convention rather than by
anything the database itself would refuse to violate. It's now also enforced at the database layer
(migration `20260829213000_row_level_security`), as a deliberately redundant safety net: every
query a correctly-written service function issues should see identical results either way; RLS is
the thing that saves you the one time a future service function's `orgId` filter is missing.

- A dedicated, unprivileged Postgres role (`ats_app`) — not a superuser, not a table owner — with
  `ENABLE`/`FORCE ROW LEVEL SECURITY` on every tenant table and one policy per table comparing
  against `current_setting('app.org_id', true)`. Tables without a direct `orgId` column (`job_stages`,
  `resumes`, `applications`, `stage_events`, `interviews`, `interview_panelists`, `scorecards`,
  `scorecard_ratings`, `duplicate_candidate_links`) are scoped through a join chain up to the owning
  `jobs`/`candidates` row instead — up to four levels deep for `scorecard_ratings`. The `true`
  (missing_ok) argument makes an unset setting resolve to `NULL` rather than error, and `NULL` never
  equals anything — a query that somehow runs with no org context set returns zero rows, not every
  org's rows.
- `lib/prisma.ts` exports one `prisma` that every existing service function already imports,
  unchanged — a `Proxy` that accumulates the property-access path (`prisma.candidate.findFirst` →
  `["candidate", "findFirst"]`) until it's actually called, then decides how to run it: unscoped
  against the original connection when there's no request-level org context (pre-auth routes, the
  public careers site, the worker/relay, the seed script — identical to before RLS existed); scoped
  through `ats_app` otherwise. `lib/asyncHandler.ts` is the one place that establishes the org context
  for a request, so this needed no per-route or per-service wiring.
- **Each top-level Prisma call gets its own short-lived mini-transaction** (`SET LOCAL app.org_id`,
  then the call, then commit) rather than the whole request sharing one — deliberately. An earlier
  version of this did wrap the entire request in a single transaction; it was simpler, but it
  silently changed the timing of every service function that reads before conditionally writing.
  `transitionApplication`'s optimistic-concurrency check depends on its pre-write read
  (`findOwnedApplication`) and its write happening as two *separate* database operations with a real
  gap between them — folding them into one transaction span removed that gap, and under load the
  concurrency test started intermittently returning `422` instead of `409` (a second, "concurrent"
  request's read was now sometimes seeing the first request's already-committed write, no longer
  racing at the database row-lock level at all). Scoping per-call instead — mirroring exactly which
  operations already used an explicit `prisma.$transaction(...)` before RLS existed — restores the
  original timing untouched while still giving every call `app.org_id`. Caught by running the full
  suite repeatedly rather than once (a single clean run doesn't prove a race-prone change is safe);
  the fix was verified with 10+ consecutive clean runs before being trusted.
- Proved directly, not just asserted: `tests/integration/security-and-integrity.test.ts` runs a
  query with **no `orgId` filter at all** — the exact bug this exists to catch — against another
  org's row, scoped under a different org's context, and asserts it returns nothing (and that the
  identical query *does* return the row when scoped correctly, ruling out a typo rather than RLS
  being the reason).

## Real-time updates

The kanban board and notification bell used to be polling-only (TanStack Query refetch on an
interval). They're now pushed live over Server-Sent Events, backed by Redis pub/sub:

- `lib/pubsub.ts` publishes to a `org:{orgId}:events` Redis channel from exactly three points:
  `createApplication`/`transitionApplication` (`application.created` / `application.stage_changed`,
  broadcast to anyone viewing that org's board) and `lib/notify.ts` (`notification.created`, one
  event per addressed user). One `psubscribe('org:*:events')` per API process fans these out
  in-process to however many SSE connections that process is holding, rather than one Redis
  subscription per connected browser tab — the same "scales with API instance count, not client
  count" shape as everything else stateless about this API.
- `GET /api/v1/realtime/stream?token=<accessToken>` (`modules/realtime/stream.ts`) is the one
  endpoint with its own auth path — the browser's native `EventSource` can't set an `Authorization`
  header, so the token travels as a query param and is verified exactly like a bearer token
  otherwise. The frontend (`web/src/hooks/useRealtime.ts`) reconnects every 10 minutes with a fresh
  token, since a token used to open a stream isn't re-verified for the life of that connection, and
  a browser-initiated reconnect with an expired one would otherwise close the `EventSource`
  permanently (a non-200 response to a reconnect attempt is terminal, per spec).
- SSE connections are held open indefinitely by design, which meant graceful shutdown (`src/index.ts`)
  would previously stall for its full timeout waiting on `server.close()` to notice — fixed by
  explicitly ending every open stream (`closeAllStreams()`) before that wait begins.
- Polling isn't gone entirely — both the notification bell and the kanban board's queries keep a
  long-interval (120s) `refetchInterval` as a reconciliation safety net, in case a push was ever
  missed (a brief disconnect, a dropped Redis message), rather than trusting push alone to never lose
  one.

## API design

- **Cursor pagination** (`lib/pagination.ts`) on `id`, not `OFFSET` — avoids page drift on a
  pipeline that's actively changing under a recruiter's feet.
- **RFC 7807 `application/problem+json`** for every error response, uniformly, via one
  `errorHandler` middleware that also maps Zod validation errors and known Prisma error codes
  (`P2002` unique violation → `409`, `P2025` not found → `404`).
- **`X-Request-Id`** on every response (generated or echoed from the caller), threaded through
  `pino-http` request logging.
- **Rate limiting** (`middleware/rateLimit.ts`, Redis `INCR`+`EXPIRE`) on `/auth/*` and the public
  apply endpoint — the two paths reachable without an account.
- **OpenAPI 3** generated from the same Zod schemas the handlers validate against
  (`zod-to-json-schema`), served at `/api/docs`. Paths/responses are hand-authored around those
  schemas rather than fully auto-derived — see ASSUMPTIONS.md.

## Scalability considerations

What's already built to scale, and what the next step would be:

- **Stateless API** — no in-process session state; JWTs mean any number of API instances can sit
  behind a load balancer today.
- **Separate worker process** — scales independently of the API; multiple worker instances would
  compete correctly for BullMQ jobs and for outbox rows (`FOR UPDATE SKIP LOCKED` is safe for
  concurrent relays).
- **Read-heavy analytics** — live SQL is correct and fast at this dataset size (tens of thousands
  of `StageEvent` rows). Past that, `MetricsRollup` is already the landing spot to switch
  dashboard reads to a cached snapshot instead of the live query — the schema and the nightly job
  exist; only the read path would need to change.
- **Postgres connection pressure** — the natural next step at higher API instance counts is
  PgBouncer in front of Postgres; Prisma's own pool is per-process and would otherwise multiply
  with each API/worker replica.
- **File storage** — resumes go through a `StorageAdapter` interface (`lib/storage.ts`) with one
  local-disk implementation; swapping to S3/GCS is a single new file, not a refactor.
- **Multi-tenancy** — every query is `orgId`-scoped at the application layer, *and* enforced at the
  database layer via Postgres Row-Level Security (see above) — cross-tenant access is structurally
  impossible, not just absent by convention.

## Reliability considerations

- Outbox + relay: no event lost to a transaction rollback or a Redis outage (above).
- Optimistic concurrency on stage transitions: no lost updates on concurrent moves (above).
- BullMQ retries with exponential backoff + a visible dead-letter surface
  (`GET /api/v1/admin/queues`) rather than jobs silently vanishing on failure.
- `/health` (process is up) and `/ready` (Postgres + Redis are both reachable) are separate, so an
  orchestrator can distinguish "starting up" from "genuinely broken."
- Every write that fans out to multiple tables (application create, stage transition, interview
  scheduling, candidate merge) is one Prisma `$transaction` — partial writes aren't possible for
  any single one of those operations.
- Refresh tokens carry the issuing user's `tokenVersion`; `POST /auth/logout` bumps it, immediately
  invalidating every outstanding refresh token for that user rather than only ever expiring on its
  own after 7 days.
