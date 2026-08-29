# Demo Walkthrough

A script for a screen recording (or for manually clicking through to verify the submission). Each
step names what to do, what you should see, and which subsystem it's proving out. Run the setup
steps in the [README](../README.md) first — this assumes `docker compose up -d`, `pnpm install`,
migrations applied, `pnpm db:seed` run, and `pnpm dev` running.

## 1. Public careers site → apply with a resume

1. Open **http://localhost:5173/public/acme-recruiting** — the seeded org's published job board.
2. Click into "Backend Engineer" (or whichever job is listed).
3. Fill in the application form with a real name/email and attach an actual PDF or DOCX resume,
   then submit.
4. You should see a `202`-style confirmation message immediately — the application is created
   synchronously; parsing happens in the background.

**Proves:** the public unauthenticated apply flow, file upload, and that the API responds
immediately rather than blocking on parsing.

## 2. Watch the background pipeline work

1. Check the **worker terminal** (`pnpm dev` runs it alongside the API) — you'll see
   `resume-parse` and `email-send` jobs complete within a couple of seconds.
2. Open **http://localhost:8025** (MailHog) — the candidate's application-confirmation email is
   sitting in the inbox, sent via the same background pipeline.
3. Log into the recruiter app (**http://localhost:5173/login**,
   `admin@acme-recruiting.test` / `password123`), go to **Jobs → your job**, and find your new
   card in the **Applied** column of the kanban board. Click it.
4. On the candidate detail page, the **Resume** section shows `PARSED` with extracted skills,
   experience, and education pulled straight from the file you uploaded.

**Proves:** the transactional outbox → BullMQ pipeline, resume text extraction + structuring, and
async processing that doesn't block the request path.

## 3. Duplicate detection

1. Go back to the public job board and apply again with the **same email address** (any name/resume).
2. In the recruiter app, open **Duplicates** in the nav. Depending on which signal fired:
   - an **exact email or phone match** auto-confirms instantly and won't appear in the pending
     queue (check `GET /duplicates` shows nothing new, but the candidate record was reused rather
     than duplicated — the second apply reuses the same `Candidate` row);
   - a **fuzzy match** (similar name, or an identical resume file reused for a different email)
     shows up here as `PENDING`, with the specific signals that fired and their confidence.
3. Click **Confirm** or **Not a duplicate** on any pending row, or click **"Keep &lt;name&gt;"** to
   actually merge the two records — confirming a link never auto-merges, so this is the explicit,
   separate action that reassigns resumes/applications onto whichever candidate you keep.

**Proves:** layered dedupe scoring (exact-match auto-link vs. fuzzy-match review queue) and the
merge/review UI.

## 4. The pipeline state machine, live

1. On the job's kanban board, **drag a card from Applied straight to Hired.** It should snap
   back — the API rejected it with `422` ("Can only mark HIRED from an Offer-kind stage") and the
   UI's optimistic update rolled back.
2. Drag the same card to **Interview** — this succeeds (forward skips are allowed).
3. Drag it to **Rejected** — you'll be prompted for a reason; cancelling the prompt aborts the
   move, providing one completes it.
4. Open the candidate detail page and expand **"show timeline"** under the application — every
   move is there with actor, reason (if any), and time spent in the previous stage.

**Proves:** the state-machine guard rails, optimistic-UI-with-rollback pattern, and the audit
trail.

## 5. Concurrency guarantee (the interesting one)

From a terminal, fire two simultaneous transition requests at the same application:

```bash
TOKEN=$(curl -s -X POST localhost:4000/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@acme-recruiting.test","password":"password123"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['accessToken'])")

APP_ID=<an application id from GET /api/v1/applications>
STAGE_ID=<a legal target stage id from that job>

curl -s -o /tmp/r1.json -w "%{http_code}\n" -X POST localhost:4000/api/v1/applications/$APP_ID/transition \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"toStageId\":\"$STAGE_ID\"}" &
curl -s -o /tmp/r2.json -w "%{http_code}\n" -X POST localhost:4000/api/v1/applications/$APP_ID/transition \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"toStageId\":\"$STAGE_ID\"}" &
wait
```

You should see one `200` and one `409`. Then `GET /api/v1/applications/:id/events` shows exactly
one new `StageEvent` — never two.

**Proves:** the optimistic-concurrency guard on stage transitions (row-locked `UPDATE ... WHERE`).

## 6. Interviews & scorecards

1. From a candidate's detail page, click **Schedule interview**, pick a date/time, optionally
   check off one or more panelists (fetched from `GET /auth/users`), and submit.
2. Check MailHog again — an interview-invite email went out (to the candidate, and to any
   panelist you picked).
3. Go to **Interviews** in the nav, find it, and click **Scorecard** to submit a structured
   rating (overall verdict + per-criterion 1–4 scores + notes).
4. To see the authorization guard: invite a second user as `INTERVIEWER`
   (`POST /auth/users`), log in as them, and try submitting a scorecard for an interview they
   weren't checked off as a panelist for — `403`. Log in as `admin`/`RECRUITER`/`HIRING_MANAGER`
   instead and the same request succeeds (a manage role can record feedback on a panelist's
   behalf). The **Interviews** list is scoped the same way: an `INTERVIEWER` only sees interviews
   they're actually a panelist on.

**Proves:** interview scheduling, the delayed reminder job (visible via
`GET /api/v1/admin/queues` → `interview-reminder` → `delayed: 1`), structured scorecards, and
panelist-scoped authorization (not just a role check, but membership on the specific interview).

## 7. Dashboard & analytics

Open **Dashboard** in the recruiter nav. With the seeded data (or after a few days of demo
activity), you should see:

- non-zero **median time-to-hire**,
- a **pipeline health** bar chart across stages,
- a **stale candidates** list (seeded data intentionally backdates a few applications past their
  stage's SLA),
- **time-to-hire by job** and **applications by source** tables.

**Proves:** analytics computed live from the `StageEvent` log, with no separately-maintained
counters.

## 8. Reliability surface

Visit `GET http://localhost:4000/api/v1/admin/queues` (as an `ADMIN`, e.g. via the bearer token
from step 5) or `GET http://localhost:4000/api/docs` for the interactive API explorer. The queues
endpoint shows BullMQ depths per queue and any outbox rows that exhausted retries and landed in
`FAILED` — the dead-letter surface for the whole async pipeline.

## 9. Automated tests

```bash
cd server
pnpm test
```

48 tests: unit tests for the state-machine guards and dedupe scoring, plus HTTP-level integration
tests covering the full apply → transition → illegal-move → concurrency-conflict → merge flow,
candidate-identity race/merge edge cases, interview/scorecard authorization, a regression check
that no endpoint's response body ever contains a user's password hash, job-stage-deletion conflict
handling, duplicate-link dismiss visibility, outbox-relay crash recovery, refresh-token revocation,
live pub/sub events, and a direct proof that Postgres Row-Level Security blocks a cross-org query
with no `orgId` filter at all — all against a real (disposable) Postgres + Redis pair, not mocks.
CI (`.github/workflows/ci.yml`) runs the same suite against fresh service containers on every push.
