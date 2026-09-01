# Applicant Tracking + Candidate Pipeline System

A lightweight recruitment platform: publish job openings, receive applications, parse resumes,
move candidates through a configurable hiring pipeline, schedule interviews with structured
scorecards, and track time-to-hire and pipeline health.

Built as a case-study submission for a Full Stack Developer role. See:

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — technical overview: architecture decisions,
  data model, the four load-bearing subsystems, scalability considerations
- **[docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md)** — assumptions, limitations, what we'd improve
  with more time
- **[docs/API.md](docs/API.md)** — endpoint reference (also served live at `/api/docs`)
- **[docs/DEMO.md](docs/DEMO.md)** — a walkthrough script exercising every major feature

## Stack

| Layer | Choice |
|---|---|
| API | Node 20+, TypeScript (strict), Express |
| Database | PostgreSQL 16 + Prisma ORM (`pg_trgm` for fuzzy name matching, Row-Level Security for tenant isolation) |
| Validation | Zod (also drives the generated OpenAPI schemas) |
| Auth | JWT access + refresh tokens (revocable via `tokenVersion`), bcrypt, role-based access control |
| Background jobs | BullMQ + Redis |
| Real-time | Server-Sent Events + Redis pub/sub (kanban board, notifications) |
| Email | Nodemailer → MailHog (zero-credential local inbox) |
| Frontend | React + Vite + TypeScript + Tailwind + TanStack Query |
| Infra | Docker Compose (Postgres, Redis, MailHog) |

## Setup

Requires Docker, Node 20+, and pnpm.

```bash
# 1. Start infra (Postgres on :5433, Redis on :6380, MailHog on :1025/:8025)
docker compose up -d

# 2. Install all workspace dependencies (server + web)
pnpm install

# 3. Apply the database schema
cd server && npx prisma migrate deploy && cd ..

# 4. Seed demo data (2 orgs, users in every role, 4 published jobs, ~40 candidates
#    with realistic stage histories so the dashboard isn't empty on first load)
pnpm db:seed

# 5. Run everything: API on :4000, web app on :5173, the outbox relay, all 4
#    queue workers (resume-parse, dedupe-scan, notifications, scheduled-
#    maintenance), and packages/core's own build watcher - one terminal.
pnpm dev
```

Then:

- **Recruiter app**: http://localhost:5173/login
  Demo login: `admin@acme-recruiting.test` / `password123` (see `server/prisma/seed.ts` for
  every seeded user, across all four roles, in both seeded orgs)
- **Public careers site**: http://localhost:5173/public/acme-recruiting
- **Candidate portal** (a separate login — track your own applications across every org):
  http://localhost:5173/candidate/register
- **API docs (OpenAPI/Swagger UI)**: http://localhost:4000/api/docs
- **MailHog inbox** (all outbound email lands here in dev): http://localhost:8025

### Environment

Copy `server/.env.example` to `server/.env` — the defaults already match `docker-compose.yml`.
Resume parsing is LLM-only: set `DEEPSEEK_API_KEY` or `ANTHROPIC_API_KEY` for it to work at all (see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#resume-parsing) for why there's no offline fallback).

### Running tests

```bash
cd server
docker exec ats-postgres psql -U ats -d postgres -c "CREATE DATABASE ats_test;"
docker exec ats-postgres psql -U ats -d ats_test -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
DATABASE_URL="postgresql://ats:ats@localhost:5433/ats_test?schema=public" npx prisma migrate deploy
pnpm test
```

(One-time setup — the test DB is separate from the dev/demo database so `pnpm test` never
touches your seeded data.)

## Production deployment

One command builds and starts the entire stack as containers - API, web (nginx), the outbox
relay, and all 4 queue workers, plus Postgres/Redis/MailHog. Migrations run automatically first;
nothing else starts until they've applied:

```bash
docker compose -f docker-compose.prod.yml --env-file server/.env up -d --build
```

- **Recruiter app**: http://localhost:5173
- **API**: http://localhost:4000 (`/api/docs`, `/health`, `/ready`)
- **MailHog**: http://localhost:8025

This stack's Postgres starts **empty** - separate from your dev database's seeded demo data.
Register a fresh org through the UI, or seed the same demo data dev uses (one-time, and it wipes
whatever's already there, so don't run it against real data):

```bash
docker compose -f docker-compose.prod.yml --env-file server/.env run --rm migrate npx tsx prisma/seed.ts
```

Login afterward: `admin@acme-recruiting.test` / `password123`.

Tear down with `docker compose -f docker-compose.prod.yml down` (add `-v` to also drop its
Postgres/Redis volumes). Runs under its own isolated project name (`ats-prod`), so it can't
collide with or tear down `docker-compose.yml`'s dev containers even if both are running at once.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why each worker is its own service (real
per-queue scaling, real crash isolation) and how that maps to Kubernetes in an actual deployment.

## Project layout

```
packages/core/   Shared by server/ and workers/: Prisma schema/client, domain logic, queue
  src/domain/    definitions + job processors, outbox + relay, lib/ (prisma, jwt, mailer, storage,
  src/queues/    logger, ...), and every modules/*/service.ts (business logic, not the HTTP layer -
  src/events/    see ARCHITECTURE.md's "Package layout"). Always consumed via its compiled dist/.
  src/lib/
  src/modules/
  prisma/        schema.prisma, migrations/, seed.ts
server/          Express API only - a separate deployable from workers/ (own Docker image)
  src/modules/   HTTP layer per resource: routes → controller → schema (Zod); service.ts lives in core
  src/middleware/  requireAuth, rateLimit, upload, errorHandler
  tests/         Vitest: unit tests for domain logic, Supertest integration tests for the API
workers/         One entrypoint per queue + the relay process, each its own OS process, own
  src/           Docker image (workers/Dockerfile) - see ARCHITECTURE.md
web/             React + Vite recruiter app + public careers site
docs/            The four documents linked above
```
