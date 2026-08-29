# Assumptions, Limitations, and What We'd Improve

## Assumptions made

- **"Recruiter roles"** was interpreted as four roles — `ADMIN`, `RECRUITER`,
  `HIRING_MANAGER`, `INTERVIEWER` — with `ADMIN`/`RECRUITER`/`HIRING_MANAGER` able to manage
  jobs/candidates/pipeline, and `INTERVIEWER` scoped to viewing assigned interviews and
  submitting their own scorecards.
- **The public careers site is scoped by an org slug in the URL** (`/public/orgs/:orgSlug/jobs`)
  rather than a per-org custom domain — a reasonable stand-in for a real multi-tenant SaaS careers
  page without provisioning DNS/subdomains for a case study.
- **Configurable pipeline stages are per-job**, seeded from one default template
  (`domain/pipeline/template.ts`) and editable afterward (add/rename/reorder/remove). There's no
  separate "template library" for reusing a custom pipeline across jobs — each job's stages are
  independent once created.
- **Phone normalization defaults to a US country hint** (`libphonenumber-js`, `defaultCountry:
  "US"`) since seed/demo data doesn't include country codes. International numbers written with a
  `+` prefix still normalize correctly regardless of the default.
- **Resume uploads are capped at PDF/DOCX, 10MB** — the two formats the parsing pipeline actually
  supports; anything else is rejected at the upload boundary with a clear error.
- Registration (`POST /auth/register`) has no email verification step — it creates a new
  organization and its first admin immediately. Fine for a demo/self-serve trial flow; a real
  product would gate this behind email confirmation.

## Known limitations

- **The public apply flow (candidate → resume → application) is three independently-transactional
  steps, not one cross-module transaction.** A failure between steps (e.g., the process crashes
  after the resume is stored but before the application row is created) leaves a recoverable but
  incomplete state — a candidate + resume with no application. Each individual step is atomic and
  the state is always inspectable/repairable; it was a deliberate tradeoff against introducing
  tight coupling between three otherwise-independent modules for a case-study-scale system. See
  `modules/public/service.ts` for the reasoning inline.
- **Rate limiting is a simple Redis fixed-window counter** (`middleware/rateLimit.ts`), not a
  sliding window, and fails open (lets the request through) if Redis is unreachable. Adequate for
  the two paths that need it (`/auth/*`, the public apply endpoint) at this scale.
- **Uploaded files are validated by declared MIME type, not by sniffing file content.** A client
  could lie about the `Content-Type` of a multipart part; the worst case is a failed parse
  (`Resume.parseStatus = FAILED`, with the error recorded), not a security issue, since the file
  is never executed — but it's not defense-in-depth.
- **No virus/malware scanning** of uploaded resumes.
- **No GDPR-style data export or right-to-erasure flow** for candidate PII, despite storing it
  (name, email, phone, resume contents).
- **The OpenAPI spec's request/response schemas are generated from Zod (`zod-to-json-schema`),
  but the path definitions themselves are hand-authored** around those schemas rather than fully
  derived from route metadata. It can't silently drift on request bodies, but a path or status
  code could still go stale if a route changes without updating `src/openapi.ts`.
- **The frontend's stage-reorder UI is missing** even though the API supports it
  (`PATCH /jobs/:jobId/stages/reorder`) — stages can be added and their kind/name/SLA edited from
  the UI, but reordering currently requires calling the endpoint directly.

## What we'd improve with more time

Roughly in priority order (Postgres Row-Level Security, real-time updates, and refresh-token
revocation were all on this list as of an earlier draft — see the changelog below for why they've
moved to "already done"):

1. **Proper pagination UI** in the frontend for orgs with more candidates/applications than fit on
   one page (the API already supports cursor pagination throughout — only the UI would need to
   grow "load more" controls).
2. **Drag-and-drop stage reordering** in the job-stages UI, matching the existing API endpoint.
3. **Content-sniffing validation** on uploaded resumes (magic bytes, not just declared MIME type)
   and a virus-scanning step before storage.
4. **A richer merge UX** — a diff view showing what will change before confirming a candidate
   merge, and the ability to choose which fields survive when both records have data. Non-email
   dedupe signals (phone, resume hash, fuzzy name) also don't currently get re-pointed at the
   merge survivor when they'd have matched a tombstoned candidate instead — see the changelog
   below for what merge *does* already handle correctly.
5. **GDPR-style candidate data export/delete**, given the system stores PII.
6. **Fully route-metadata-driven OpenAPI generation** (e.g. attaching `.openapi()` to each Zod
   schema via `@asteasolutions/zod-to-openapi`), so paths/responses are generated too, not just
   request-body schemas.
7. **Denormalize `orgId` onto the deepest RLS-scoped tables** (`scorecard_ratings` currently walks a
   four-table join per row check) if this ever ran at a scale where that join cost showed up in
   practice — not needed at this dataset size, but the honest next step, the same shape as
   `Candidate.normalizedEmail` already being a computed/indexed column rather than derived per query.

## Changelog: a bug-hunt pass

The items below were found in a subsequent senior-engineer-style review of the initial build and
fixed directly, with integration tests added for each
(`server/tests/integration/security-and-integrity.test.ts`). Listed here rather than silently
folded into the sections above, since "what was actually wrong and how it was fixed" is itself
useful signal.

- **(Most severe) Three endpoints leaked every affected user's bcrypt password hash.**
  `GET /interviews`, `GET /interviews/:id/scorecards`, and `GET /applications/:id/events` each
  joined a `User` relation (a panelist, a scorecard author, a stage-change actor) with
  `include: { user: true }` / `{ author: true }` / `{ actor: true }` instead of a
  field-whitelisting `select` — which serializes the *entire* row, `passwordHash` included,
  straight into the JSON response. Any authenticated org member (any role, including the
  least-privileged `INTERVIEWER`) could pull the password hash of every admin/recruiter/hiring
  manager/interviewer who ever acted on an interview, scorecard, or stage change they could see —
  verified live against a running dev server (`curl` showed the hash in the response) before and
  after the fix, not just inferred from reading the code. Fixed by replacing every such `include`
  with a `select: { id: true, name: true }` (or `{ email: true }` for the one internal,
  never-HTTP-facing use in the email worker). Covered by an explicit regression test that greps
  raw response bodies for the actual hash value, not just the shape of a typed field.
- **Race condition in candidate identity.** `createOrGetCandidate()`'s "reuse an existing candidate
  with this email" check was check-then-act with no database backstop — unlike `Application`,
  `Candidate` had only an index, not a unique constraint, on `(orgId, normalizedEmail)`. Two
  concurrent requests with the same email (a double-clicked public apply is the realistic case,
  since that's the one unauthenticated write path) could each pass the check and create two
  candidate rows. Fixed with a DB-level unique constraint (migration
  `20260829140000_candidate_email_unique`) plus a `P2002` catch-and-reuse fallback, the same
  pattern already used for `Application`'s uniqueness.
- **Merged candidates weren't actually out of circulation.** Two related gaps, both from the same
  root cause: nothing in `createOrGetCandidate()` or the dedupe scan (`domain/dedupe/scan.ts`)
  checked `mergedIntoId`. (1) New activity (a re-application, a contact-info update) for an email
  that belonged to an already-merged candidate silently attached to the tombstoned row instead of
  the merge survivor, defeating the point of merging. (2) The dedupe scan could create new
  `DuplicateCandidateLink` rows pointing at a tombstoned candidate, which a recruiter can never
  usefully act on (any merge attempt involving an already-merged candidate is rejected). Fixed by
  resolving through `mergedIntoId` to the live candidate before reusing a match, and by excluding
  merged candidates from every "find other candidates" query in the scan. `mergeCandidates()` also
  now dismisses any other pending/confirmed link still pointing at the candidate being merged
  away, instead of leaving it as a dead end in the review queue.
- **Any authenticated org member could submit a scorecard for any interview**, not just an
  assigned panelist — this was called out as a known limitation in an earlier draft of this
  document; it's now enforced. `submitScorecard()` requires the caller to be either a listed
  `InterviewPanelist` or hold a managing role (`ADMIN`/`RECRUITER`/`HIRING_MANAGER` — the same set
  already gated behind scheduling/cancelling), so a recruiter can still record feedback on a
  panelist's behalf without opening it up to every org member.
- **The "Schedule interview" UI never let anyone pick a panelist** (`panelistUserIds: []`, always)
  — harmless before the two authorization fixes above, but combined with them it meant an
  `INTERVIEWER` could never be assigned to (or see, or submit a scorecard for) any interview
  scheduled through the live app, since nothing ever made them a panelist. There wasn't even an
  endpoint to list an org's users to build that picker from. Added `GET /auth/users` (scoped to
  the same manage roles that schedule interviews) and a panelist checklist in the schedule form.
  The seeded demo data was unaffected (`prisma/seed.ts` assigns panelists directly, bypassing the
  API), which is exactly why this gap wasn't visible until the authorization was actually correct.
- **`GET /interviews` didn't scope by panelist for the `INTERVIEWER` role**, contradicting the
  documented role model ("`INTERVIEWER` scoped to viewing assigned interviews"). An interviewer
  could see every interview, and the candidate details on it, across the whole org. Fixed: an
  `INTERVIEWER` now only sees interviews they're a panelist on.
- **Login couldn't disambiguate by organization.** `User.email` was only unique per-org, but
  `POST /auth/login` takes `{email, password}` with no org selector — nothing stopped
  `POST /auth/register` from creating a second organization reusing an email already registered
  in a different one, at which point `login()`'s `findFirst({ where: { email } })` would pick
  whichever row Postgres happened to return first. `email` is now globally unique (migration
  `20260829140100_user_email_global_unique`), and both `register()` and `inviteUser()` check that
  up front for a clean `409` instead of relying solely on the constraint.
- **Access and refresh JWTs weren't distinguishable except by which secret verified them.** If
  `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` were ever set to the same value, a refresh token
  (payload `{sub}`, no `orgId`/`role`) would verify successfully as an access token, and
  `requireAuth` would hand every downstream service an `orgId` of `undefined` — which Prisma
  treats as "no filter on this field", silently turning an org-scoped query into an unscoped one.
  The two secrets were in fact always distinct in the shipped `.env.example`/`.env.test`, so this
  wasn't exploitable as configured, but nothing guarded against an operator setting them equal
  later. Fixed with defense in depth: every token now carries an explicit `type: "access" |
  "refresh"` claim that's checked on verify, and `env.ts` refuses to boot at all if the two
  secrets are equal.
- **No way to find your own org's public careers-site URL.** Registering a new organization (as
  opposed to using the seeded demo org) gave no way to discover `/public/:orgSlug` — no
  authenticated endpoint exposed the org's slug, and the frontend's "View careers page" link on
  the landing page hardcoded the demo org (`acme-recruiting`). `GET /auth/me` (and the
  login/register response) now include `orgSlug`, and the Jobs page links to it directly.
- **No CI.** Added `.github/workflows/ci.yml`: two parallel jobs on every push/PR to `main` - one
  spins up real Postgres 16 + Redis service containers, applies migrations, and runs `tsc --noEmit`
  + the full `vitest` integration/unit suite against them (not a mocked DB); the other typechecks
  and builds the frontend. Verified locally against disposable containers standing in for the CI
  service containers before relying on GitHub's runners to catch anything.
- **The test suite's rate limiter and full-scan tests could flake depending on run history.**
  `tests/setup.ts` truncated every Postgres table before each test but never touched Redis, so the
  fixed-window rate limiter's `INCR` counters (shared across `/auth/*` and the public apply
  endpoint) persisted across test runs within the same 60-second window - a `pnpm test` run soon
  after a previous one could start failing on an unrelated `429` depending on timing, not on
  anything the test itself asserts. `beforeEach` now also `FLUSHDB`s the tests' dedicated Redis
  logical DB (index 1 - separate from dev, per `.env.test`), matching the isolation the Postgres
  truncation already provided.

## Changelog: a second pass (external code review)

A follow-up review (not by the original author) flagged four smaller correctness/completeness
gaps, all fixed directly with tests added, following the same convention as the pass above.

- **The `dedupe-scan` queue was dead code.** `dedupeScanQueue`/`processDedupeScan`
  (`queues/definitions.ts`, `queues/processors/dedupeScan.ts`) were registered as a worker but
  nothing ever called `dedupeScanQueue.add()` - the on-demand full rescan was unreachable from any
  route, not just missing a UI button. Added `POST /candidates/:candidateId/rescan-duplicates`
  (`candidates/service.ts:rescanDuplicates`), so a recruiter can re-check a candidate after
  editing their contact info without needing a new resume upload to trigger a scan.
- **`AuditLog`'s own schema comment oversold it.** It claims to cover "merges, role changes, job
  publish/close, etc.", but only candidate merge ever wrote a row. `auth/service.ts:inviteUser()`
  and `jobs/service.ts:publishJob()`/`closeJob()` now write an `AuditLog` entry in the same
  transaction as the change, matching the pattern merge already used.
- **`MetricsRollup.orgId` had no foreign key to `Organization`** - the one tenant-scoped model in
  the schema without referential integrity, unlike every other `orgId` field. Added an explicit
  `org Organization @relation(..., onDelete: Cascade)` (migration
  `20260829192254_metrics_rollup_org_fk`). While in the schema, also made the already-correct but
  implicit `onDelete` behavior on `Scorecard.authorId`/`AuditLog.actorId`/`StageEvent.actorId`
  explicit (`Restrict`/`SetNull` respectively) for readability - verified this produced no SQL
  diff, since Prisma's defaults already matched.
- **A leftover empty `modules/scorecards/` directory** (scorecard routes actually live under
  `modules/interviews/`) was deleted.

## Changelog: a third pass (independent review)

A third, independent review (parallel adversarial passes over the server and web code, each
explicitly told not to trust this document's own claims) found four backend issues and one
frontend issue that the first two passes missed. Fixed directly, with regression tests added
following the same convention.

- **(Most severe) Deleting a job stage that was ever a transition *destination* crashed with a raw
  500, not the documented 409.** `removeStage()` only checked whether an application currently sits
  in the stage (`Application.currentStageId`), but `StageEvent.toStageId` is `ON DELETE RESTRICT` -
  the initial "Applied" stage is a transition destination the moment a job's first application is
  created, and stays one forever even after every application has moved on. Deleting such a stage
  hit an unmapped Prisma `P2003` foreign-key violation, which fell through to the generic 500
  handler - contradicting `docs/API.md`'s "Rejected (409) if any application currently sits there."
  Fixed two ways: `removeStage()` now also checks for historical `StageEvent` references and
  returns a clean 409, and `errorHandler.ts` now maps `P2003` to 409 generally (matching the
  existing `P2002`/`P2025` pattern), so any other FK-constrained delete fails the same clean way.
- **The outbox relay dispatched to Redis from inside the same Postgres transaction that claimed
  rows with `FOR UPDATE SKIP LOCKED`.** `ioredis` is configured with `maxRetriesPerRequest: null`
  (BullMQ requires this), so a real Redis outage would hang the dispatch call indefinitely while
  still holding that transaction's row locks and connection open - risking connection-pool
  exhaustion for the whole API process during the exact outage the outbox is supposed to survive
  gracefully. Fixed by using the schema's already-defined-but-previously-unused `PROCESSING` status
  as a crash-safe lease: claiming a row now flips it to `PROCESSING` with a 60-second lease inside a
  short transaction that commits immediately, and dispatch happens afterward with no open
  transaction. A row that never reaches `SENT`/`FAILED` (a crash, or a hung dispatch) is simply
  reclaimed once its lease expires rather than being stranded. `startRelay()` also now skips a tick
  if the previous one is still in flight, instead of letting ticks pile up under a slow Redis.
- **The resume content-hash dedupe check did a full cross-org table scan before filtering.**
  `scanFullDuplicatesForCandidate()`'s hash-match query had no `orgId` filter, unlike every other
  query in the same file - not an authorization bug (results were still correctly filtered before
  anything was persisted), but a real tenant-boundary inconsistency and an unnecessary full-table
  scan on every parsed resume. Fixed by scoping the query through the `candidate` relation.
- **Scorecards could be submitted with zero per-criterion ratings.** `submitScorecardSchema`
  defaulted `ratings` to `[]`; given the brief's "structured scorecards" framing this looked like an
  oversight rather than a considered tradeoff, so it now requires at least one rating.
- **(Frontend) A dismissed duplicate link kept showing the "possible duplicate" warning on the
  candidate detail page forever.** `getCandidate()` included every `DuplicateCandidateLink`
  regardless of status, so confirming "not a duplicate" in the review queue had no visible effect on
  the candidate's own page. Fixed by scoping that include to `PENDING`/`CONFIRMED` links only.

Also added, as genuine product-completeness gaps rather than bugs: a **Candidates** page
(search by name/email, using the `GET /candidates?q=` endpoint the API already supported with no
UI consumer) and an **in-app resume upload** control on the candidate detail page (the API endpoint
existed; previously the only way a resume could enter the system was the public apply form).

## Changelog: a fourth pass — closing three documented gaps, and one more bug along the way

The three items removed from "what we'd improve" above (Postgres Row-Level Security, real-time
updates, refresh-token revocation) were built out, not just re-described as done. Verified the same
way as everything else in these changelogs: the full test suite, plus tests added specifically to
prove the new behavior rather than just exercise it.

- **Refresh-token revocation.** `User.tokenVersion` (migration `20260829210630_user_token_version`)
  is embedded in every refresh token issued; `refresh()` now rejects a token whose version doesn't
  match the user's current one. `POST /auth/logout` bumps it, immediately invalidating every
  outstanding refresh token for that user - the frontend's logout button now calls it (best-effort;
  local tokens are always cleared regardless of whether the request succeeds).
- **Real-time updates**, replacing "kanban board and notifications are polling-only" - see
  ARCHITECTURE.md's new "Real-time updates" section for the mechanism (Redis pub/sub + SSE).
- **Postgres Row-Level Security** on every tenant table - see ARCHITECTURE.md's new "Postgres
  Row-Level Security" section. Building this surfaced two things worth calling out on their own:
  - **A genuine, intermittent bug in the first version of this work**, not a passing side note: an
    early implementation wrapped each entire authenticated request in one transaction. It read as
    simpler and passed the suite on the first several runs - but it silently changed *when* a
    pre-write read and its later write happen relative to each other, and
    `transitionApplication()`'s optimistic-concurrency guarantee depends on exactly that gap. Under
    load, deep into a full test-suite run (never in isolation, never against a freshly-booted
    server taking requests one at a time - only when enough prior load had shifted the timing), the
    concurrency test started intermittently getting `422` instead of `409`. Diagnosed by first
    ruling out the obvious suspects (a leaked Postgres connection - checked directly against
    `pg_stat_activity` during a run, found none) before landing on the real cause, then fixed by
    scoping each *individual* Prisma call (or each pre-existing `prisma.$transaction(...)` call) to
    its own short transaction instead of the whole request - restoring the exact timing the
    optimistic-concurrency check already depended on before RLS existed. Confirmed fixed with 10+
    consecutive clean full-suite runs, not one - a single green run doesn't prove a race-prone
    change is safe, and this bug specifically only ever showed up partway through a full run.
  - **`OutboxEvent` had no queryable tenant column at all** - only an `orgId` buried inside its JSON
    `payload`. Adding a real `orgId` column (backfilled from the payload in migration
    `20260829212225_outbox_event_org_id`) was necessary for RLS, but it also exposed a real,
    separate bug while doing it: `GET /api/v1/admin/queues`'s dead-letter listing
    (`admin/service.ts:getQueueStatus`) queried every `FAILED` outbox row with **no org filter at
    all** - any org's `ADMIN` could see every other org's failed events, JSON payload
    (candidateId/applicationId/resumeId) included. Fixed by scoping that query by the caller's own
    org now that the column exists to scope it by.
- Proved the RLS mechanism directly rather than only asserting it's wired up: a test runs a query
  with no `orgId` filter at all against another org's row (the exact class of bug RLS exists to
  catch) and confirms the database returns nothing - see ARCHITECTURE.md.

## Changelog: a fifth pass

A fifth review, run against a live dev server (Postgres + Redis via `docker compose`, not just
static reading) rather than assuming the prior passes' test-suite-green result meant every code
path was exercised. Found one data-corrupting bug that had escaped all four prior passes precisely
because nothing - not the integration suite, not manual demo testing - ever called the affected
endpoint, plus three smaller gaps. Fixed directly, with a regression test added for the first one
following the same convention as every pass above.

- **(Most severe) `PATCH /jobs/:jobId/stages/reorder` corrupted stage ordering on every real call.**
  `reorderStages()` built its negative-offset-then-final-order updates as an array passed to
  `prisma.$transaction([...])`. Under `lib/prisma.ts`'s Row-Level-Security-scoping Proxy (added in
  the fourth pass), each `prisma.x.y(...)` call is invoked eagerly, in its own independent,
  immediately-committing mini-transaction, the instant it's called - which for an array literal
  happens while the array is being *built*, before `$transaction` is ever invoked. Every "batched"
  update actually ran as its own separate transaction, racing every other one with no ordering
  guarantee, so both passes (negative offsets and final positions) interleaved arbitrarily. Verified
  live, not just read: calling the endpoint repeatedly against a running server returned `200` every
  time but left stages with a mix of negative and duplicate `order` values instead of a clean
  `0..n-1` permutation, on every single call. `computeAndStoreRollups()` (`analytics/service.ts`)
  had the identical pattern but happened to never misbehave in practice, since it's only ever called
  from the worker (no per-request org scope, so it fell through to the safe unscoped path) - fixed
  for consistency rather than left as a latent trap. Both now use the callback form of
  `$transaction`, matching every other transaction in the codebase; `lib/prisma.ts` also now throws
  a clear error if the array form is ever passed while org-scoped, instead of silently returning a
  result that looks like a successful atomic batch. Covered by
  `tests/integration/jobs.test.ts`, which reorders a job's stages and asserts the persisted state
  (re-fetched independently of the mutation's own response) is an exact, clean permutation - this
  is the test all four prior passes were missing.
- **`GET /notifications?unreadOnly=false` silently returned only-unread notifications**, the
  opposite of what the parameter says. `z.coerce.boolean()` coerces via JS's `Boolean(value)`, so
  any non-empty string - including the literal query string `"false"` - comes out `true`. Not
  reachable through the shipped frontend (which only ever sends `unreadOnly=true` or omits the
  param), so this shipped invisibly, but it's a real bug in the documented API contract for any
  other caller. Fixed by explicitly parsing the two accepted string values instead of coercing.
- **The job-stages UI didn't match what this document claimed it already did.** This file said
  "stages can be added and their kind/name/SLA edited from the UI" - `JobDetail.tsx` had an add-stage
  form (which didn't even collect an SLA) and zero editing capability for existing stages, even
  though `PATCH /jobs/:jobId/stages/:stageId` already existed and worked. Added an inline edit form
  per stage (name/kind/SLA) and an SLA field to the add form, so the claim above is now actually
  true rather than aspirational.
- **Graceful shutdown never cleanly disconnected the RLS-scoped Prisma client.** `index.ts` and
  `worker.ts` both called `prisma.$disconnect()` on `SIGTERM`/`SIGINT` - but through the RLS-scoping
  Proxy, outside any request/transaction context, that resolves the same way any other unscoped
  top-level call does: against `basePrisma` only. `scopedPrisma` - the actual connection every
  authenticated request's RLS-scoped queries run through - was left to be torn down only by the
  process exiting, not a clean disconnect. Added `disconnectPrisma()` (`lib/prisma.ts`), which closes
  both, and switched `index.ts`, `worker.ts`, and `tests/setup.ts` to use it.

## Changelog: a sixth pass — live end-to-end exercise + frontend-only gaps

A sixth pass, run against a live dev server *and* a live `vite` dev server (every documented flow
in this file and `DEMO.md` walked through with real HTTP requests and, separately, a full read of
every frontend file cross-checked against the actual API contracts), rather than trusting that a
green test suite meant every UI path was exercised. The backend held up completely - every flow
(auth, jobs, pipeline transitions and their guard rails, interviews, scorecards, duplicate
detection, candidate merge, notifications, rate limiting, RLS, SSE headers, a production Docker
build run against real Postgres/Redis) behaved exactly as documented, and a second focused pass
over `mailer.ts`/`storage.ts`/`rateLimit.ts`/`realtime/stream.ts`/`shutdownState.ts`/
`admin/service.ts`/the queue processors/`lib/prisma.ts`'s RLS proxy/`config/env.ts`/`upload.ts`
found nothing further. What this pass actually found was entirely in `web/src/`:

- **(Most significant) Candidate merge had no UI control at all.** `POST /candidates/:id/merge`
  worked correctly end-to-end (verified directly: merging two candidates reassigns resumes and
  non-clashing applications, tombstones the duplicate, and dismisses any other pending link
  pointing at it) but nothing in `Duplicates.tsx` ever called it - only "Confirm duplicate" (which,
  by design, never auto-merges) and "Not a duplicate" were wired up. A recruiter could flag and
  confirm duplicates indefinitely but never actually consolidate two records through the app. Fixed
  by adding two "Keep &lt;name&gt;" buttons per pending link, each merging the other candidate into
  the chosen survivor after a confirmation prompt.
- **`JobDetail.tsx` and `CandidateDetail.tsx` got stuck on "Loading…" forever on a fetch failure**
  (`if (!job) return <div>Loading…</div>` / same for `candidate`) - neither checked `isError` from
  `useQuery`. A deleted job/candidate, a bad URL, or any other 404 left the page spinning
  indefinitely with no way to tell it was actually broken, since `main.tsx`'s global `retry: 1`
  still resolves to a permanently-failed query rather than an infinite pending one. Fixed by
  destructuring `isLoading`/`isError` and rendering a real not-found state.
- **Every management-only control was shown to every role, including `INTERVIEWER`, and simply
  403'd on click** - "New job"/"Publish" (`Jobs.tsx`), add/edit stage and kanban drag-to-transition
  (`JobDetail.tsx`), "Schedule interview"/"Upload resume" (`CandidateDetail.tsx`), and the
  "Duplicates" nav link itself (the whole `/duplicates` router requires a manage role, so an
  `INTERVIEWER` following it got nothing but a 403). None of this was a security hole - the server
  already enforced every one of these correctly - but it contradicted the stated role model by
  showing controls that could never succeed for the role using them. Fixed with a shared
  `canManage(role)` helper (`lib/types.ts`, mirroring the exact `requireRole("ADMIN", "RECRUITER",
  "HIRING_MANAGER")` set already used server-side) and hid, rather than disabled, every one of the
  above for a role it isn't for.
