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
                    │  Outbox relay process   │◀───────────────┘
                    │  (workers/src/relay.ts, │
                    │   5-min backstop poll)  │
                    └───────────┬─────────────┘
                                │ enqueues, jobId = outbox row id
                                ▼
                    ┌─────────────────────────┐        ┌──────────────┐
                    │  Redis (BullMQ queues)  │        │   MailHog    │
                    │  resume-parse,          │        └──────────────┘
                    │  dedupe-scan,           │        ┌──────────────┐
                    │  notifications,         │        │ Local disk / │
                    │  scheduled-maintenance  │        │ StorageAdapter│
                    └───────────┬─────────────┘        └──────────────┘
                                │
                                ▼
                    4 separate worker processes, one per queue —
                    workers/src/{resumeParse,dedupeScan,notifications,
                    scheduledMaintenance}.ts — each with its own
                    concurrency and its own restart lifecycle
```

The API (`server/`), the outbox relay, and each of the 4 queue workers (`workers/src/relay.ts`,
`workers/src/{resumeParse,dedupeScan,notifications,scheduledMaintenance}.ts`) are 6 independent OS
processes from the start — a slow LLM call parsing a resume can never block a request-handling
event loop or the `notifications` queue's own throughput, and any one of the 6 can be scaled,
deployed, or restarted without touching the other 5. They share nothing except Postgres and Redis:
no in-process state, no shared event loop. Process-per-queue, rather than one process holding all 4
`Worker` instances (the simpler alternative), buys real isolation — a crash in one queue's
processor, a burst of slow `resume-parse` jobs, a bad deploy of just the `notifications` handler —
none of it can starve or take down the other queues, because they're not sharing a Node event loop
or a process's memory. `resume-parse` and `dedupe-scan` are deliberately two queues, not one,
despite both being "figure out what's true about this candidate" conceptually: `resume-parse` calls
out to an LLM with unpredictable latency, `dedupe-scan` is local and normally sub-second, and
merging them would let a burst of slow LLM calls starve dedupe-scan's worker pool even though it
has no external dependency of its own. `notifications`, by contrast, genuinely does merge multiple
job types (every outbound email plus the delayed interview reminder) onto one queue, because those
*do* share a bottleneck (SMTP, fast, no external LLM) — see
`packages/core/src/queues/definitions.ts` for the full reasoning on both calls. The relay gets its
own process for a related reason: it isn't tied to any single queue (`dispatch()` can enqueue onto
any of the 4 depending on the event type), so folding it into one queue's worker would create an
arbitrary dependency between an unrelated queue and outbox delivery. `workers/src/shared.ts` is the
one place the SIGINT/SIGTERM/uncaught-exception handling and graceful-shutdown logic is written —
every one of the 5 non-API processes calls into it rather than repeating it; it also runs a small
internal HTTP listener (`GET /health` on a container-internal-only port) purely so a container
orchestrator has something to ask "is this process's event loop alive," since a worker otherwise
never accepts inbound connections at all.

**Package layout**: `server/` (the API's HTTP layer — routes, controllers, Zod schemas, Express
middleware) and `workers/` (the 6 process entrypoints above) are separate top-level packages, both
depending on `packages/core/` (Prisma client + schema, `domain/` business logic, `queues/`
definitions and processors, `events/` outbox + relay, shared `lib/`) via the pnpm workspace. This
mirrors the runtime reality directly: `server/` and `workers/` are genuinely different deployables
— separate Docker images (`server/Dockerfile`, `workers/Dockerfile`), separate containers, separate
scaling, separate crash domains — so the repo structure doesn't nest one inside the other's source
tree. `packages/core` is always consumed via its compiled `dist/` (both in dev, via a
`tsc --watch` process, and in the Docker build) rather than importing raw `.ts` source across the
package boundary.

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
as the change they describe. Dispatch to the matching BullMQ queue happens through two paths that
share the same underlying logic (`dispatch()`, `events/relay.ts`):

1. **Fast path** (`dispatchNowBestEffort()`) — called directly from the write path (the
   `applications`/`interviews`/`candidates` services) right after the transaction that wrote the
   outbox row commits. Fire-and-forget: it's never awaited into the request/response cycle, and a
   failure here (Redis down, a crash mid-call) does nothing further — no retry bookkeeping, just
   leaves the row `PENDING` exactly as if this path had never run. In the common case this is what
   actually dispatches an event, typically within milliseconds of the write.
2. **Backstop poll** (`relayOnce()`, run inside its own dedicated `workers/relay.ts` process every
   5 minutes) — the correctness net
   for whatever the fast path missed, for any reason. It ticks in two phases so a slow or
   unreachable Redis can never hold a database transaction hostage:
   - **Claim** — a short transaction selects pending/lease-expired rows with `FOR UPDATE SKIP LOCKED`
     (safe for multiple relay instances) and flips them to `PROCESSING` with a 60-second lease, then
     commits immediately.
   - **Dispatch** — outside any open transaction, each claimed row is sent to the matching BullMQ
     queue using a deterministic `jobId` derived from the outbox row's id, then marked `SENT`.

That same deterministic `jobId` is what makes the two paths safe to occasionally race on the same
row (rare, since the fast path almost always finishes long before the next 5-minute tick): a
crash-and-restart between "enqueued" and "marked SENT," or the fast path and a tick both attempting
the same row, produces a duplicate `add()` call that BullMQ simply dedupes, never a duplicate email
or parse job.

This is the actual reliability story: **a transaction that rolls back never produced an event, and
Redis being briefly down never loses one** — the row just sits `PENDING`/`PROCESSING` until either
path successfully dispatches it (or, if a dispatch was mid-flight when the process crashed, until
its lease expires and a tick reclaims it) — and no single tick can pin a Postgres connection open
for longer than a Redis call actually takes, since dispatch never runs inside the claiming
transaction. The 5-minute backstop interval is safe specifically because the durability guarantee
never depended on how often that poll runs, only on the row existing in Postgres — slowing it down
changes worst-case latency for a *missed* fast-path attempt (rare), never correctness. A dispatch
failure (from either path) gets exponential backoff up to 8 attempts, then flips to `FAILED` and
surfaces at `GET /api/v1/admin/queues` as a dead-letter row for manual inspection.

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
   Word/Google Docs exports. `pdfjs-dist` is Mozilla's actual, actively-maintained engine.) Also
   strips a duplicated content layer some resume-export tools embed - see `dropRepeatedContent()`
   and the changelog below.
2. **Structure** (`deepseekStructurer.ts` / `claudeStructurer.ts`, picked by `index.ts`) — LLM-only,
   via forced structured tool-use, whichever of `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` is set
   (DeepSeek checked first). **Deliberately no offline fallback.** An earlier version fell back to
   a regex/keyword heuristic structurer whenever the LLM call failed, on the theory that some
   structure beats none. In practice the heuristic routinely produced confidently-wrong output on
   real resumes - a "KEY PROJECTS" header it didn't recognize corrupted the experience list with a
   garbled entry; skill category labels ("Languages:") ended up glued onto the first skill in that
   group; personal projects and paid jobs were indistinguishable once merged into one array - all
   still carrying a `PARSED` badge indistinguishable at a glance from a correct result. A resume
   that fails clearly (`FAILED` status, a real error message, retryable by re-uploading) is a
   better outcome for a recruiter than one that "parsed" into data they can't trust. BullMQ's own
   retry policy (5 attempts, exponential backoff) is the resilience layer instead - a transient
   failure never reaches a recruiter as a bad parse; see the changelog below for the full incident.
   Every `Resume.parserVersion` records which structurer actually produced the result.

## Background jobs

Each queue is consumed by its own dedicated process (`workers/src/*.ts`), never shared with another
queue:

| Queue | Job names (dispatched by name within the queue) | Idempotency | Process | Replicas today |
|---|---|---|---|---|
| `resume-parse` | `parse` | job id = outbox row id | `workers/resumeParse.ts` | 1 |
| `dedupe-scan` | `rescan` (`POST /candidates/:id/rescan-duplicates`) | re-running is safe — upserts links, never duplicates them | `workers/dedupeScan.ts` | 1 |
| `notifications` | `application-confirmation`, `stage-changed-notify`, `interview-invite`, `candidate-password-reset`, `remind` (delayed, fires at interview time − 24h) | job id = outbox row id (or none, for the two directly-enqueued ones — see `queues/processors/notifications.ts`) | `workers/notifications.ts` | 1 |
| `scheduled-maintenance` | `metrics-rollup` (nightly, 2am), `cleanup-expired-tokens` (nightly, 3am) | both upsert/delete-by-condition, safe to re-run | `workers/scheduledMaintenance.ts` | 1 (must never exceed 1 — a nightly job must never overlap itself) |

`notifications` deliberately merges 5 job types onto one queue — they all share a bottleneck (SMTP,
fast, no external dependency) — while `resume-parse` and `dedupe-scan` stay separate despite both
being "candidate intelligence" work, because they don't share a bottleneck (external LLM latency vs.
local Postgres). See `packages/core/src/queues/definitions.ts` for the full reasoning.

Replica count, not in-process concurrency, is the scaling knob: every worker runs BullMQ concurrency
1, and parallelism for a queue comes from running its entrypoint as N independent OS processes —
`workers/src/shared.ts`'s doc comment explains why concurrency and replica count are kept as
separate, deliberately distinct knobs. In production that means each queue worker as its own
Kubernetes Deployment with its own Horizontal Pod Autoscaler, scaled primarily on that queue's
BullMQ depth (e.g. KEDA's Redis scaler watching the queue's list length) with CPU utilization as a
secondary signal, not the primary one — every one of these workers is I/O-bound (an LLM call, an
SMTP send, a Postgres query), so a real backlog can sit at near-zero CPU the whole time; CPU alone
would never trigger scale-up for the workload that actually needs it. `scheduled-maintenance` is
deliberately excluded from all of this — pinned at exactly 1 replica always, since a second replica
autoscaled in risks the nightly rollup double-running, which is worse than not scaling at all. 1
replica per queue today (`docker-compose.prod.yml`, this repo's own deploy target), since there's
no real load in this demo to justify more — `resume-parse` is the one most likely to need it first
if that changes (LLM-call latency is the one genuinely unpredictable cost among the 4 queues). Each
process opens its own dedicated Redis connection (BullMQ's `Worker` issues blocking commands, which
can't share a connection with a `Queue` producer — see `queues/definitions.ts`).

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

## Candidate portal

A second, completely separate login (`modules/candidateAuth/`, `modules/candidatePortal/`) so a
candidate can see every application they've submitted and a live-updating record of stage changes,
independent of the recruiter-facing app covered above.

- **`CandidateAccount` is not org-scoped**, unlike `User`. The same person can apply to multiple
  orgs' public job boards with the same email and should see all of it from one login — so unlike
  every other model in this system, there's deliberately no `orgId` here, and therefore no Postgres
  Row-Level Security policy on it either (RLS scopes tenant data; this table has none to scope).
  It's matched to the existing per-org `Candidate`/`Application` rows by normalized email at *read*
  time (`domain/dedupe/normalize.ts`'s same signal, not a foreign key) — a `CandidateAccount` can
  predate, postdate, or never have a matching `Candidate` row.
- **A fully separate JWT identity.** `candidate_access`/`candidate_refresh` token types
  (`lib/jwt.ts`), reusing the same two secrets as recruiter tokens but relying on the `type` claim
  discriminator to make one type structurally unusable as the other — the same defense-in-depth
  principle that already separates access from refresh tokens, applied one level further.
  `middleware/requireCandidateAuth.ts` is the candidate equivalent of `requireAuth.ts`, and —
  critically — it never sets `req.auth`, so `lib/asyncHandler.ts` never establishes an RLS org
  scope for a candidate-authenticated request. That's not an oversight; it's exactly what makes the
  "list every application across every org" query below legal to run at all.
- **The update feed is the existing `StageEvent` audit trail, read back for the candidate it belongs
  to — not a second notification pipeline.** `GET /candidate-portal/applications/:id/timeline`
  queries the same table `GET /applications/:id/events` already does, with an explicit `select`
  (never `include`) that omits `reason` (an internal recruiter note) and `actor` (which staff member
  acted) — a candidate sees "you've reached the Interview round," never who moved them there or why
  a rejection note said what it said.
- **Password reset is the one email in this system that deliberately does not go through the
  transactional outbox.** `OutboxEvent.orgId` is `NOT NULL`, and a reset email has no single org to
  attribute it to — but more fundamentally, the outbox's guarantee matters for events that have no
  other way to happen again if missed (an application, a stage change); a reset email doesn't share
  that property, since the candidate can just click "forgot password" again. It's still enqueued
  directly onto the same `email-send` BullMQ queue, getting the same retry/backoff as everything
  else, matching the precedent `candidates/service.ts:rescanDuplicates()` already set for another
  naturally user-retriable action. Reset tokens are single-use, sha256-hashed at rest (never stored
  in plaintext, same discipline as passwords), and a successful reset bumps `tokenVersion` to
  invalidate every outstanding refresh token, mirroring `logout()`.
- **The candidate's own notification bar reuses the same "no second table" approach as the update
  feed, applied to counting instead of listing.** Rather than a per-row read flag (which would need
  its own notification table), `CandidateAccount.notificationsViewedAt` is a single watermark;
  "unread" is `COUNT(StageEvent)` across every one of the candidate's applications newer than it.
  `POST /candidate-portal/notifications/mark-viewed` bumps it - the frontend calls this a few
  seconds after the dashboard loads, since the dashboard *is* the update feed, so having it open
  already counts as having seen it.
- **Open roles are shown directly on the dashboard, not a separate "browse jobs" page** -
  `GET /candidate-portal/open-roles` lists every `PUBLISHED` job across every org, excluding ones
  already applied to (so the UI never offers an "Apply" that would `409` against the
  `(candidateId, jobId)` unique constraint). Applying still goes through the existing, already-public
  `POST /public/orgs/:orgSlug/jobs/:jobSlug/apply` - no new apply endpoint, just the candidate's
  name/email pre-filled from their account instead of asking again. The per-org public careers site
  (`/public/:orgSlug/jobs`) isn't replaced by this - it's what a company links from its own site;
  this is the complementary "I'm already logged in, let me see everything at once" view.

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
- **One process per queue, not one process for all queues** — each of the 4 workers scales,
  deploys, and restarts independently of the API *and* of each other. Horizontally scaling just
  `resume-parse` under load (the one most likely to need it, given LLM latency) means running more
  copies of exactly that one process — the other 3 queues are untouched, and their processes never
  even restart. Multiple instances of the same worker (or the relay) compete correctly for jobs and
  for outbox rows: BullMQ's own consumer-group semantics for jobs, and `FOR UPDATE SKIP LOCKED` for
  the relay's row claims, so nothing needs to be single-instance except by choice.
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
