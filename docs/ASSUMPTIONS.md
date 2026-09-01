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
- **Candidate portal registration (`POST /candidate-auth/register`) has the same no-email-
  verification tradeoff**, for the same reason — anyone can create an account under any email
  address without proving they own it. A real product would verify it, especially since this
  account then gets read access to that email's application history across every org.

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

## Changelog: a seventh pass — independent verification with a real browser

A seventh, independent review, driving the actual UI with a headless real browser (Playwright/
Chromium against the live `vite` dev server, not just reading component source) through every
documented flow end-to-end: public apply with a real file upload, the resume-parse and email-send
pipeline, duplicate detection (exact-match reuse, resume-content-hash match, and fuzzy-name match,
each confirmed by inspecting the persisted `DuplicateCandidateLink` row directly), Confirm/Dismiss/
Merge from the actual `Duplicates.tsx` UI, legal and illegal kanban drag-and-drop transitions
(including the optimistic-UI rollback on a rejected move), the reject-with-reason prompt, interview
scheduling and scorecard submission, and role-based UI hiding verified for both `ADMIN` and
`INTERVIEWER` logins. Found and fixed two real bugs, both with regression tests added and both
re-verified live against the running dev server (not just the test suite) after fixing:

- **(Most significant) Duplicate-detection confidence could be silently downgraded, losing the
  strongest signal.** `scanFullDuplicatesForCandidate()` calls `scoreDuplicate()` up to three
  separate times per candidate pair - once for the exact-match pass, once for the resume
  content-hash pass, once per fuzzy-name-similarity match - each producing an independent
  confidence/signals pair from a single signal (`scoreDuplicate()`'s own "max, not sum" logic only
  applies *within* one of those calls). `upsertLink()`'s Prisma `update` clause overwrote
  `confidence`/`signals` unconditionally on every call, so whichever pass ran last always won, even
  when it was weaker. Reproduced live: two candidates sharing both an identical resume (0.85,
  `resume_content_hash`) and a similar name (~0.65, `name_similarity`) persisted at 0.65 with the
  resume-hash signal discarded entirely, since the fuzzy-name pass always runs last - directly
  contradicting this document's own "the score is the max of whichever signals fired, not a sum"
  claim. Fixed by having `upsertLink()` read the existing row and keep `max(existing.confidence,
  new)` with signals merged by name, never overwritten. Verified both ways: a new integration test
  (`tests/integration/security-and-integrity.test.ts`, "duplicate scoring persistence") calls
  `scanFullDuplicatesForCandidate()` directly and asserts the persisted row keeps both signals at
  0.85, and the fix was independently reproduced and confirmed against a live dev server before and
  after (the buggy behavior required restarting the `tsx watch` dev processes to stop reproducing,
  since the file-watcher hadn't actually picked up the mid-session edit - a reminder that "the code
  changed" and "the running process is executing the new code" are different claims).
- **A rejected file upload returned a raw 500, not the "clear error" this document already
  claimed.** `middleware/upload.ts`'s `fileFilter` threw a plain `Error` (and Multer's own
  `LIMIT_FILE_SIZE` error behaves the same way) for a disallowed MIME type or an oversized resume -
  neither is an `ApiError`/`ZodError`/known Prisma error code, so both fell through
  `errorHandler.ts`'s typed branches to the generic 500 handler. Reproduced live with `curl`
  (uploading a `.exe` at the public apply endpoint returned `{"type":"internal-error","status":500}`
  instead of a 4xx explaining why). Fixed by throwing `ApiError.badRequest()` from `fileFilter`
  (now handled by the existing `ApiError` branch) and by mapping `multer.MulterError` to a clean 400
  in `errorHandler.ts`. Two regression tests added (unsupported type, oversized file), both
  asserting `res.status(400)` and `res.body.type !== "internal-error"` rather than just checking the
  request didn't throw.

Also confirmed, without needing a fix: an apparent "1 failed job" in `GET /admin/queues`'s
`resume-parse` counter turned out to reference a `resumeId` that no longer existed in Postgres -
stale BullMQ job history in the long-running dev Redis container from an earlier session's testing
against a database that has since been reset, not a reproducible defect in the current code (the
processor's own try/catch already correctly leaves a genuinely-failed resume's row at
`parseStatus: FAILED` with the error recorded, per `queues/processors/resumeParse.ts`).

## Changelog: an eighth pass — a real-resume parsing bug, a second LLM structurer, and an outbox latency improvement

Prompted by a real resume upload coming back with empty `skills`/`experience`/`education`, diagnosed
against the actual uploaded file rather than assumed - plus two follow-on pieces of work that came
out of a design discussion about the outbox relay's polling interval.

- **The heuristic resume structurer never recognized a letter-spaced or "PROFESSIONAL EXPERIENCE"
  section header.** Diagnosed by running the real extraction + structuring pipeline against an
  actual uploaded PDF end-to-end (not a synthetic test case): its section headers were styled with
  letter-spacing, a common resume-template design choice, which `pdf.js`'s text extraction has no
  way to distinguish from a real inter-word space - `"TECHNICAL SKILLS"` came back as
  `"T E C H N I C A L S K I L L S"`. The old word-boundary regex (`/^skills\b/i`) never matched
  that, so `splitIntoSections()`'s state machine never left `"header"` mode, and every subsequent
  line - the candidate's actual skills, experience, and education - silently landed in the wrong
  bucket. Separately, `"PROFESSIONAL EXPERIENCE"` wasn't in the recognized vocabulary at all even
  without the spacing issue (only `"EXPERIENCE"`/`"WORK EXPERIENCE"`/`"EMPLOYMENT"` were). Fixed in
  `domain/resume/heuristicStructurer.ts` by matching a fully despaced, lowercased form of each
  candidate header line against an enumerated keyword list (`"technicalskills"`,
  `"professionalexperience"`, etc.) instead of a regex expecting normal word spacing - this handles
  both the plain and the letter-spaced case identically. Verified against the real resume that
  surfaced the bug (skills/experience/education went from all-empty to correctly populated) and with
  4 new unit tests (`tests/unit/heuristicStructurer.test.ts`) using generic synthetic resume text.
- **Added a second LLM resume structurer (DeepSeek), alongside the existing Claude one.**
  `domain/resume/deepseekStructurer.ts` implements the same `ResumeStructurer` interface via
  DeepSeek's OpenAI-compatible chat-completions API (the `openai` npm client pointed at DeepSeek's
  base URL, DeepSeek's own documented integration path), using the identical forced-tool-call
  pattern as `claudeStructurer.ts` so the result is guaranteed-structured JSON. `DEEPSEEK_API_KEY`
  is a new optional env var (`config/env.ts`), checked before `ANTHROPIC_API_KEY` in
  `domain/resume/index.ts`'s `structureResume()` when both happen to be set; either falls back to
  the heuristic parser automatically on any failure, unchanged from the existing pattern. The
  frontend (`CandidateDetail.tsx`) now also surfaces which parser actually produced a given profile
  (`Resume.parserVersion`) as a visible badge - "AI-parsed (DeepSeek/Claude)" vs. "Parsed by offline
  heuristic" - rather than that being an invisible backend implementation detail.
- **The outbox relay's 1-second poll became a backstop rather than the primary dispatch path.**
  Prompted by a design discussion about whether polling every second was the right call at all. It
  wasn't a correctness problem (the query is covered by `@@index([status, availableAt])`, so it was
  already a cheap, sub-millisecond, empty-result index scan at idle) - the real argument for
  changing it was resilience, not performance: coupling "can a request succeed" to "is Redis
  reachable right now" is exactly the failure mode the outbox pattern exists to prevent, and a
  bare 1-second poll interval means every event waits up to a full second even when nothing is
  wrong. Added `dispatchNowBestEffort()` (`events/relay.ts`), called directly from the write path
  (`applications`/`interviews`/`candidates` services) right after the transaction that wrote an
  outbox row commits - fire-and-forget, never awaited into the request/response cycle, and a
  failure does nothing beyond logging a warning (no retry bookkeeping duplicated here - the row is
  simply left `PENDING`, exactly as if the fast path had never run). `dispatch()` itself (previously
  private to `relay.ts`) is now exported and shared by both paths, so there's one implementation of
  "how to dispatch an event," not two. The poll interval (`relayOnce()`, run from `worker.ts`) moved
  from 1 second to 5 minutes, now purely the correctness backstop for whatever the fast path missed
  (a crash, a Redis blip, anything) rather than the primary mechanism - safe because the durability
  guarantee never depended on poll frequency, only on the row existing in Postgres. The existing
  deterministic-`jobId` dedup (already relied on for the relay's own crash-recovery story) is what
  makes it safe for the fast path and a backstop tick to occasionally both attempt the same row: a
  second `add()` call for the same event is a no-op in BullMQ, never a duplicate job. Verified with
  a new regression test (`tests/integration/security-and-integrity.test.ts`, "outbox fast-path
  dispatch") that submits a real application through the API and asserts its outbox row reaches
  `SENT` within 2 seconds without ever calling `relayOnce()` - which would time out if the fast path
  weren't actually running, not just present in code.

## Changelog: a ninth pass — a candidate-facing portal

Added a genuinely new capability, not a fix: candidates can now create their own account and see
every application they've submitted, across every org, with a live-updating record of stage changes
- "you've reached the Interview round" rather than a raw audit log entry. Full design writeup in
`docs/ARCHITECTURE.md`'s new "Candidate portal" section; summarized here.

- **A `CandidateAccount` is deliberately not org-scoped**, unlike `User` - the same person can apply
  to multiple orgs' public job boards with the same email and should see all of it from one account.
  Matched to the existing (per-org) `Candidate`/`Application` rows by normalized email at read time,
  not a foreign key - a `CandidateAccount` can be registered before, after, or with no matching
  `Candidate` row at all. No Postgres Row-Level Security on it either: RLS scopes tenant (org) data,
  and this table has no `orgId` to scope by - protected the same way `Organization`/`User`
  registration already is before any org context exists, by requiring the right credentials at the
  API layer.
- **A separate JWT identity, not a bolted-on field.** `lib/jwt.ts` gained `candidate_access`/
  `candidate_refresh` token types alongside the existing `access`/`refresh` ones, reusing the same
  two secrets but relying on the same `type`-claim discrimination already used to keep access and
  refresh tokens from being mistaken for each other. A candidate token can never be accepted by
  `requireAuth` (recruiter routes) and a recruiter's access token can never be accepted by the new
  `requireCandidateAuth` - verified directly with a test that tries both directions and asserts `401`
  either way, not just that each works with its own token type.
- **The "you've reached this round" update feed is not a new notification-delivery system.** It's
  the exact same `StageEvent` audit trail the recruiter side already relies on
  (`docs/ARCHITECTURE.md`'s pipeline state machine), read back for the candidate whose application it
  is, with an explicit `select` (never `include`) that deliberately omits `reason` (a recruiter's
  internal note, not written for candidate eyes) and `actor` (which staff member made the move) -
  same "don't leak an internal field via a careless include" discipline the credential-leak fix
  (the first changelog pass, above) already established. Building a second outbox-backed
  notification pipeline for something the first one's data already answers correctly would have
  been duplicated infrastructure for no real gain.
- **Password reset deliberately bypasses the transactional outbox** that every other email in this
  system goes through, for two concrete reasons: `OutboxEvent.orgId` is `NOT NULL` and a password
  reset has no single org to attribute it to, and - more fundamentally - the outbox's durability
  guarantee exists because *some* events have no other way to ever happen again if missed (an
  application submission, a stage change); a reset email doesn't share that property, since the
  candidate can simply click "forgot password" again. Still enqueued directly onto the same
  `email-send` BullMQ queue (same retry/backoff as everything else), matching the existing precedent
  `candidates/service.ts:rescanDuplicates()` already set for another naturally user-retriable action
  that doesn't need outbox-level guarantees.
- **Reset tokens are single-use and never stored in plaintext** - a `PasswordResetToken` row holds a
  sha256 hash of the token, the same discipline already applied to passwords themselves; the raw
  token only ever exists in the one email it's sent in. A password reset also bumps
  `CandidateAccount.tokenVersion`, invalidating every outstanding refresh token, mirroring
  `logout()`'s existing reasoning.
- **`POST /candidate-auth/forgot-password` never reveals whether an email is registered** - the
  response is identical either way, so the endpoint can't be used to enumerate which emails have
  accounts. Verified directly: a test asserts the response body for a registered and an unregistered
  email are byte-for-byte equal.
- Verified live end-to-end, not just via the test suite: registered a candidate account, applied to
  a job with the same email from a separate public-apply flow, confirmed the dashboard picked it up
  by email match, moved the application forward via the recruiter API and confirmed the dashboard's
  update feed reflected it on refresh, then completed a full password reset by extracting and
  clicking the *actual* link from the *actual* email that landed in MailHog (not a synthetically
  reconstructed token) and logging in with the new password.
- Investigated a separate report that recruiter in-app notifications were arriving "very late"
  before starting this work. Root-caused to the exact 1-second outbox-poll latency the eighth pass
  above had already fixed by that point (a fast-path dispatch had just been added, but the running
  dev server was still executing pre-fix code - restarting it resolved this immediately). Verified
  with real timing, not assumption: a live browser test showed the notification bell updating in
  318-332ms after triggering stage-change and new-application events, for both the plain case and
  the case that also sends an email first. No changes were made to how or whether email sends -
  only how quickly an event reaches the dispatch step.

## Changelog: a tenth pass — a real notification-count bug, a candidate-side notification bar, and apply-in-dashboard

Three more items from the same conversation as the ninth pass, one of them a genuine bug (not the
"very late" report above, which had already been resolved by that point - this is a second,
different issue found while investigating).

- **The recruiter notification bell's badge count silently froze once unread count passed 10.**
  `web/src/components/Layout.tsx` computed it as `items.length` from
  `GET /notifications?unreadOnly=true&limit=10` - accurate only while unread count stayed under the
  page size, then permanently stuck at 10 no matter how many more notifications actually arrived
  (visible on the notifications page itself, just not reflected in the badge). Fixed with a
  dedicated `GET /notifications/unread-count`, a plain `COUNT(*)` with no list-size ceiling. Same
  fix applied to the candidate portal's own notification bar (below) from the start, rather than
  copying the bug into new code. Verified live, not just by the regression test: pumped a recruiter
  account's unread count to 25, confirmed the badge correctly showed the capped-for-display "9+",
  then triggered one more notification and confirmed the *underlying count* went 25→26 - proving it
  never freezes, only the visual "9+" ever caps.
- **Added a notification bar to the candidate portal** - `CandidateAccount.notificationsViewedAt`
  (a single watermark, not a per-row read flag) plus `GET .../notifications/unread-count` and
  `POST .../notifications/mark-viewed`. Deliberately not a second notification-delivery pipeline -
  "unread" is `COUNT(StageEvent)` newer than the watermark, reusing data that's already there. The
  frontend auto-marks-viewed a few seconds after the dashboard loads, since the dashboard already
  shows the update feed directly - no separate "inbox" to dismiss. Verified live: a fresh account
  showed "1" for its one pre-existing stage event, the badge cleared a few seconds later, and moving
  the candidate to a new stage brought it back to "1" on the next visit.
- **Open roles now show directly on the candidate dashboard, with apply-in-place** - a deliberate
  product call, not a technical one: a logged-in candidate previously had no way to apply to a new
  role without leaving the portal for a specific org's separate public careers page. Rather than
  adding a *second* new page ("browse jobs"), `GET /candidate-portal/open-roles` lists every
  published job across every org (excluding ones already applied to) directly on the existing
  dashboard, and "Apply" expands an inline form using the *already-existing*, already-public apply
  endpoint - just with name/email pre-filled from the account instead of asking again. No new apply
  path, no new page, one screen for both "here's your status" and "here's what's still open."
  Verified live: a fresh account with zero applications saw 5 open roles spanning both seeded orgs,
  applying to one moved it from "Open roles" into "Your applications" on the same page with no
  navigation, and the remaining 4 roles stayed correctly listed.

## Changelog: an eleventh pass — the notification feed's real bugs, and the Interview-stage/Interview-record gap

- **The recruiter notification page never live-updated at all - only its own bell-count query did.**
  `useRealtime.ts`'s SSE handler invalidated `["notifications", "unread"]` specifically, which
  TanStack Query's prefix-match invalidation never reaches `["notifications", "all"]` through (a
  sibling key, not a descendant) - the page you'd actually go read notifications on just sat there
  until a manual navigation away and back. Fixed by invalidating the shorter `["notifications"]`
  prefix instead, which covers both. Also added the same `refetchInterval` reconciliation backstop
  every other live-updated list already has.
- **Notifications were ordered `orderBy: { id: "desc" }` - not remotely the same thing as
  newest-first.** `lib/pagination.ts`'s own comment calls a Prisma `id` "uuid, effectively
  insertion-ordered enough for a demo dataset" - false for a plain v4 UUID (Prisma's default
  `uuid()`), which is random with zero correlation to creation time. Notifications visibly
  reshuffled rather than listing reverse-chronologically. Harmless for the several other endpoints
  using the same `orderBy: { id }` convention (candidates/jobs/applications/duplicates - none
  promise newest-first), a real bug for a feed whose entire point is recency. Fixed with
  `orderBy: [{ createdAt: "desc" }, { id: "desc" }]`; Prisma's cursor pagination still works
  correctly against a compound orderBy. Verified with rows deliberately inserted in an order where
  id/insertion order and createdAt order diverge.
- **Added notification removal** - `DELETE /notifications/:notificationId`, ownership-checked the
  same way `markRead` already is, plus an X button per row.
- **(Most significant) Reaching an INTERVIEW-kind pipeline stage and having an actual `Interview`
  record scheduled were two entirely disconnected things, and nothing in the UI ever said so.**
  Dragging a candidate to a stage named "Interview" only ever changes `Application.currentStageId` -
  it was never connected to `POST /interviews`, which needs a real date/panelists a drag can't
  supply. A recruiter doing exactly what the stage name suggests - drag to Interview - saw the
  candidate move, got the stage-change notification, and then found nothing on the Interviews page,
  with no indication anything further was needed. Two fixes, one underlying and one product-facing:
  - `interviews/service.ts` published no realtime event at all for scheduling, cancelling, or
    completing an interview (unlike every other write path in this app), and
    `web/src/pages/Interviews.tsx` had no `refetchInterval` either - no push, no poll, the page had
    *zero* update mechanism, not just a slow one. Fixed with `interview.scheduled`/
    `interview.updated` events and the same push+poll pattern used everywhere else. Verified live:
    scheduling and cancelling an interview from a separate process both reflected on an already-open
    Interviews page within ~310ms.
  - Closed the actual workflow gap: dropping a card onto an INTERVIEW-kind stage now prompts
    ("Schedule their interview now?") and, if confirmed, lands the recruiter straight on the
    candidate's page with the schedule form already open (via a one-shot `?scheduleFor=` param,
    stripped from the URL right after so a later refresh doesn't reopen it) - one extra click
    instead of a recruiter needing to remember a second, separate action. Declining the prompt
    leaves the stage move as-is, exactly like before. Verified live end-to-end: drag → confirm
    dialog → landed with the form open → submitted → interview appears on the Interviews tab.

## Changelog: a twelfth pass — the dashboard's Pipeline health widget

- **`GET /analytics/pipeline-health` with no `jobId` (the only way the dashboard ever calls it)
  grouped active counts by individual `JobStage.id`, not by anything that made sense to look at
  together.** Every job has its own `JobStage` rows even when several jobs happen to use the same
  stage name - four published jobs meant four separate "Applied" rows (most of them 0), four
  "Phone Screen" rows, and so on, with no job label to explain why the same name kept repeating.
  Not a rendering bug - the query itself returned the wrong shape of data for a summary widget.
  Fixed by grouping by stage *kind* instead when no `jobId` is given: one row per
  `APPLIED`/`SCREEN`/`INTERVIEW`/`OFFER`/`HIRED`/`REJECTED`, summed across every job's stages of
  that kind, in a fixed canonical order with human labels ("Screening," not "SCREEN"). Scoped to a
  single job (`?jobId=`, not currently exercised by any caller but kept working), the original
  per-stage detail is unchanged - within one job's own pipeline, stage names are already distinct
  and meaningful, and no aggregation is appropriate there. Verified live: a dashboard that
  previously showed 16 rows including four separate "Applied" labels now shows a clean 6-row
  breakdown (Applied 1, Screening 3, Interview 10, Offer 2, Hired 0, Rejected 0) - the 10 for
  Interview correctly being the sum of what were previously two separate, confusingly-labeled rows
  (1 and 9). Regression test added asserting the summed count and that no stage kind appears twice
  in the org-wide response.

## Changelog: a thirteenth pass — one process per queue

- **`worker.ts` ran all 5 BullMQ `Worker` instances plus the outbox relay inside a single Node
  process.** That was a reasonable simplification for a case-study demo (one `pnpm dev:worker`,
  one thing to restart), but it means a crash triggered by one queue's processor - an unhandled
  rejection in an LLM call, a bad deploy of just the `email-send` handler - takes every queue down
  with it, and there's no way to scale (or even just restart) `resume-parse` under load without
  also restarting `metrics-rollup` and the other three queues that were doing nothing wrong.
  Split into 6 independent processes: one per queue (`server/src/workers/{resumeParse,emailSend,
  dedupeScan,interviewReminder,metricsRollup}.ts`) plus a dedicated outbox relay process
  (`workers/relay.ts`, since `dispatch()` can enqueue onto any of the 5 queues and doesn't belong
  to one of them). The SIGINT/SIGTERM/uncaught-exception/graceful-shutdown logic that `worker.ts`
  had written once now lives in exactly one place, `workers/shared.ts`'s `runManagedProcess()` /
  `runQueueWorker()`, and all 6 processes call into it - splitting the file didn't mean duplicating
  its most careful part six times. `server/package.json` gained a `dev:*`/`start:*` script pair per
  process; the root `package.json`'s `concurrently`-driven `dev` script now launches all 8
  processes (API, relay, 5 queue workers, web) together, plus a `dev:workers` script for the 6
  non-API/non-web ones on their own. The Dockerfile comment documenting `CMD` overrides was updated
  to list all 7 backend entrypoints instead of the old single `worker.ts` override. Verified: full
  typecheck, full test suite unchanged and green (none of this touches job-processing logic, only
  which process each `Worker` instance runs inside), and a live restart of each of the 6 processes
  individually - confirming each starts, logs its own queue name, and shuts down cleanly on
  `SIGTERM` without the other 5 (or the API) so much as noticing.

## Changelog: a fourteenth pass — 5 queues to 4, a real cleanup gap, a worker healthcheck bug, and a package split

- **`resume-parse` and `dedupe-scan` stayed separate queues, but `email-send` and
  `interview-reminder` were merged into one `notifications` queue.** The distinction that matters
  isn't "how many queues," it's whether the jobs sharing a worker pool actually share a bottleneck.
  `resume-parse` calls out to an LLM with unpredictable latency; `dedupe-scan` is local Postgres
  work, normally sub-second - merging them would let a burst of slow LLM calls starve dedupe-scan
  behind them even though it has no external dependency of its own, so those stayed separate.
  Every outbound email plus the delayed interview reminder, by contrast, genuinely do share a
  bottleneck (SMTP, fast, no LLM) - merging those cost nothing and is one fewer process to run.
  `queues/processors/notifications.ts` dispatches by job name (`application-confirmation`,
  `stage-changed-notify`, `interview-invite`, `candidate-password-reset`, `remind`) the same way
  `email-send`'s processor already did for its 4 job types; `interviewReminder.ts`'s actual logic
  didn't move, only what dispatches to it.
- **Replica count, not in-process `concurrency`, became the scaling knob for every queue worker.**
  Previously each worker's `concurrency` was tuned per queue (4/4/2/2/1). Now every worker runs
  concurrency 1, and parallelism for a queue comes from running its entrypoint as N independent OS
  processes - `docker compose --scale <service>=N` in production, N terminals locally. This is the
  real production pattern (a Kubernetes Deployment's replica count, not a process's internal
  thread/async pool) and makes the scaling story concrete rather than a config number nobody
  demonstrates: `docker-compose.prod.yml` runs each queue worker as its own named service with an
  explicit comment on what replica count it'd take under real load, and the actual default is 1
  replica per queue - no real traffic in this demo justifies more, and running more processes
  without a load-driven reason isn't production judgment, just process count for its own sake.
- **`PasswordResetToken` rows were never deleted.** Every "forgot password" click, used or not,
  expired or not, left a permanent row in the table forever - not exploitable (an expired/used row
  is already rejected at read time), but silent, unbounded table growth. Added
  `purgeExpiredPasswordResetTokens()` (`modules/candidateAuth/service.ts`) and a second nightly job,
  `cleanup-expired-tokens` (`queues/processors/tokenCleanup.ts`), dispatched from the same
  `scheduled-maintenance` queue the metrics rollup already runs on (`workers/scheduledMaintenance.ts`
  now registers two repeatable jobs, `metrics-rollup` at 2am and `cleanup-expired-tokens` at 3am) -
  zero extra processes, since that queue's worker was already there. Deletes only rows past their
  expiry; a used-but-not-yet-expired token is left to age out on its own. Verified with a new test
  (`tests/integration/candidatePortal.test.ts`) that creates one expired and one live token and
  asserts only the expired one is gone afterward - and, separately, verified live inside the real
  containerized stack: created an expired token in the running Postgres, manually enqueued the
  cleanup job, watched the row actually disappear.
- **Every worker container's Docker `HEALTHCHECK` was silently broken.** All processes (API and
  every worker) shared one image whose `HEALTHCHECK` hit `http://localhost:4000/health` - correct
  for the API, but no worker ever opens port 4000 (a queue consumer only makes outbound calls to
  Redis/Postgres; nothing connects into it). Every worker container sat permanently
  unhealthy - in a real orchestrator, a failing liveness probe means an endless kill-and-restart
  loop on a process that was actually working fine. Caught by testing the built image directly, not
  just trusting the Dockerfile. Fixed by giving every worker process (via
  `workers/shared.ts`'s shared `runManagedProcess()`) a small internal `GET /health` HTTP listener
  on a container-internal-only port (4001, never published to the host), and pointing
  `workers/Dockerfile`'s `HEALTHCHECK` at that instead. Verified: built the image, ran a worker
  container standalone, confirmed `docker inspect`'s health status actually reaches `healthy` (it
  previously never would have).
- **`server/src/workers/` moved to its own top-level `workers/` package, and everything both the
  API and the workers need (Prisma client + schema, `domain/`, `queues/`, `events/`, `lib/`,
  `config/`, and every `modules/*/service.ts` - the business logic, as opposed to
  `modules/*/{controller,routes,schema}.ts`, the HTTP layer) moved to a new `packages/core/`
  package that both depend on.** The API and the workers were already fully independent OS
  processes (proven in the thirteenth pass); this pass made the repo's structure say the same
  thing - `server/` and `workers/` are genuinely different deployables (separate Docker images now,
  `server/Dockerfile` and `workers/Dockerfile`, both building from the same `packages/core`), not
  one codebase with a subfolder. The mechanical risk in a move like this is the package boundary:
  7 `service.ts` files imported input types from a sibling `schema.ts` that stayed in `server/`
  (the Zod schema is genuinely an HTTP-validation concern) - fixed by having each moved service
  file declare its own structurally-matching plain interface instead of importing across the
  boundary, so `packages/core` has zero dependency on `server`. Same for `Express.Multer.File` (two
  service functions used it for an uploaded file's type) - replaced with a 4-field `UploadedFile`
  interface local to `packages/core`, decoupling it from the `multer` package entirely. Verified
  exhaustively: `pnpm install` resolves the new workspace layout; `core`, `server`, and `workers`
  all build and typecheck clean; the full test suite (80 tests, plus the new token-cleanup test
  above) still passes with its imports updated to the new package boundary; `server/Dockerfile` and
  the new `workers/Dockerfile` were each actually built AND run standalone (not just built) to
  confirm the compiled `core/lib/prisma.js`-style package imports genuinely resolve at container
  runtime, not only at `tsc` time; `docker-compose.prod.yml` was updated (each queue/relay service
  now builds from `workers/Dockerfile`, `migrate`'s working directory moved to
  `packages/core` since that's where `prisma/migrations` now lives) and re-validated. One real
  mistake surfaced and fixed along the way, worth recording since it's a mistake anyone extending
  this compose setup could repeat: `docker-compose.prod.yml` had no explicit `name:`, so it
  defaulted to the same project name (`casestudy`, from the directory) that `docker-compose.yml`
  (the dev stack) also defaults to - bringing the prod stack up recreated the dev stack's
  `ats-postgres`/`ats-redis`/`ats-mailhog` containers to match the *prod* file's service
  definitions instead of leaving them alone, and tearing the prod stack down took the dev stack
  down with it. No data was lost (`docker compose down` never touches named volumes, and the dev
  volumes were confirmed untouched by their creation timestamp), but the dev containers had to be
  recreated. Fixed with an explicit `name: ats-prod` in `docker-compose.prod.yml`, and reverified
  by bringing the prod stack fully up (migrations applied, a real application submitted through the
  containerized API, an email landed in the containerized MailHog, `resume-parse-worker` scaled
  live from 1 to 4 replicas) and back down again without the dev stack so much as restarting.

## Changelog: a fifteenth pass — resume parsing goes LLM-only

- **The PDF's own extracted text contained the entire resume twice.** Diagnosed against a real
  resume upload that came back with every skill, job, and bullet duplicated: some resume-export
  tools embed the visibly-rendered text layer *and* a duplicate (often meant as a hidden
  "ATS-friendly" layer), and `pdfjs-dist` extracts every text-showing operator regardless of layer,
  so the duplication carried straight into the raw string before either structurer ever saw it. An
  LLM structurer tended to silently self-heal this (already explicitly instructed to, in
  `deepseekStructurer.ts`'s prompt: "if the same content appears more than once... extract it only
  once"), which is exactly why it went unnoticed until a *heuristic*-parsed resume was inspected
  directly - the heuristic parser has no semantic understanding and faithfully doubled everything.
  Fixed in `extract.ts`: `dropRepeatedContent()` detects when the document's own opening line (long
  enough to be a reliable signal - a resume's first line is almost always the candidate's full
  name) reappears later in the text, and truncates to the first clean copy before any structurer
  runs. Verified directly against the real file: 8,635 → 4,004 extracted characters, name/section
  headers dropping from 2 occurrences to 1.
- **Two more heuristic-parser bugs surfaced on the same resume, on top of the duplication.** Skill
  lines grouped under an inline category label ("Languages: TypeScript, Python") came back with the
  label glued onto the first skill ("Languages: TypeScript" as one entry, not "TypeScript") -
  `parseSkills()` joined every line before splitting on commas, with nothing stripping the label
  first. Separately, "KEY PROJECTS" and "CERTIFICATIONS & ACHIEVEMENTS" weren't in the recognized
  section-header vocabulary, so each one's content silently fell through into whichever section
  came directly before it instead of being recognized as its own - "KEY PROJECTS" landed inside
  `experience`, producing a garbled entry literally titled "K E Y P R O J E C T S" (the letter
  spacing itself faithfully preserved, since the header-matching only recognizes phrasings already
  enumerated); "CERTIFICATIONS" landed inside `education`, mixing unrelated bullets into what
  should have been a clean degree line. Both are real, structural limitations of a regex/keyword
  approach to a document format with effectively unbounded layout variation - not one-off typos in
  the pattern list, since the next unusual resume would just hit a different unrecognized header.
- **Decision: resume parsing is now LLM-only, with no heuristic fallback.** The heuristic
  structurer (`heuristicStructurer.ts`) is deleted, along with its tests. The original reasoning for
  keeping a fallback - some structure beats a failed job, and it kept the demo working with zero
  API keys configured - traded a rare, honest failure for a routine, silent one: every one of the
  bugs above still produced a resume tagged `PARSED`, indistinguishable at a glance from a correct
  result, which is a worse outcome for a recruiter than a resume that's clearly `FAILED` with a real
  error message and an obvious next step (re-upload, or read the original file). `structureResume()`
  (`domain/resume/index.ts`) now throws when neither `DEEPSEEK_API_KEY` nor `ANTHROPIC_API_KEY` is
  configured - logged as a startup warning too, so this is discoverable before the first upload ever
  fails, not just at upload time. The resilience story shifts to what already existed and was
  already tested: BullMQ's 5-attempt exponential-backoff retry on the queue absorbs a transient LLM
  failure (a network blip, a momentary rate limit) before it ever reaches a recruiter as a bad
  parse; only a resume that still fails after every retry, or one uploaded when no key is configured
  at all, ends up `FAILED` - the same well-defined failure path every other unrecoverable job in
  this system already uses, not a new mechanism built for this.
- **`ParsedProfile` gained `summary` and a separate `projects` array**, distinct from `experience`.
  Previously a resume's own summary/objective paragraph was silently discarded (nothing recognized
  it as a section, so it fell into whatever bucket was active), and personal/side projects had no
  field of their own - the heuristic parser's only option was folding them into `experience`, which
  produces identical-looking entries for "got paid to do this" and "built this on my own," exactly
  the distinction a fresher's resume (an entry-level candidate, often with little or no paid work
  history but real project work) most needs to convey clearly. Both DeepSeek's and Claude's tool
  schemas were updated to match, with explicit prompt instructions to keep the two separate even
  when a resume's own formatting blurs them, and to write an actual plain-language description of
  what each project does rather than just restating its name (a real, named example that prompted
  this: a heuristic-parsed project titled only "Perpetual Futures Exchange ('preps')" told a
  recruiter nothing about what it actually was - the LLM path, prompted this way, correctly
  describes it as a live perpetual-futures trading platform with sub-second order matching and a
  real-time order-book depth feed). `CandidateDetail.tsx`'s resume card was reworked to render
  Summary, Skills, Experience, Projects, and Education as distinct sections - title/employer/dates
  laid out separately instead of concatenated into one run-on line, each project's description and
  optional link shown under its name, and a `FAILED` resume now surfaces its actual error message
  inline instead of just a bare status badge.
- **A real, separate bug caught during this pass: `CandidateDetail.tsx`'s query never polled.**
  Once loaded, a resume stuck `PARSING` (or `PENDING`, immediately after upload and before the
  worker has even picked the job up) never updated on its own - nothing pushes a completion event to
  this specific page, so a recruiter had no way to know a parse had finished short of manually
  reloading the tab. Added a `refetchInterval` that polls every 3s while the resume's status is
  `PENDING` or `PARSING`, and stops entirely once it resolves - confirmed live, twice: the first fix
  only checked for `PARSING` and still didn't poll (a fresh upload's very next fetch reads
  `PENDING`, before `PARSING` is ever the state that fetch itself returns), caught by watching a
  live upload sit unchanged for 18s with no reload; fixed by including `PENDING`, then reverified the
  same live upload resolving to a rendered result with zero manual reloads.
- Verified end to end, live, not just unit-tested: `pnpm --filter core build` + full typecheck across
  all four packages clean; full suite green (79 tests - the 4 removed heuristic-specific tests
  outnumbered by tests already covering the surrounding behavior); the exact previously-broken
  resume re-uploaded through the real UI and rendering cleanly (summary paragraph, deduplicated
  skills, jobs and projects in separate sections, a real "preps" description); the failure path
  exercised for real, not assumed - `DEEPSEEK_API_KEY` unset, the resume-parse worker restarted,
  a fresh upload landing `FAILED` with the exact configured error message, rendered inline on the
  candidate page - then the key restored and a normal parse reverified before moving on.
