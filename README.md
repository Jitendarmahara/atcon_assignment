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

# 5. Run everything (API on :4000, worker process, web app on :5173)
pnpm dev
```

Then:

- **Recruiter app**: http://localhost:5173/login
  Demo login: `admin@acme-recruiting.test` / `password123` (see `server/prisma/seed.ts` for
  every seeded user, across all four roles, in both seeded orgs)
- **Public careers site**: http://localhost:5173/public/acme-recruiting
- **API docs (OpenAPI/Swagger UI)**: http://localhost:4000/api/docs
- **MailHog inbox** (all outbound email lands here in dev): http://localhost:8025

### Environment

Copy `server/.env.example` to `server/.env` — the defaults already match `docker-compose.yml`.
Resume parsing works fully offline via a heuristic parser; setting `ANTHROPIC_API_KEY` upgrades it
to an LLM-based structurer with automatic fallback (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#resume-parsing)).

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

## Project layout

```
server/          Express API + BullMQ worker + Prisma schema/migrations/seed
  src/domain/    Framework-free business logic: pipeline state machine, dedupe scoring, resume parsing
  src/modules/   HTTP layer per resource: routes → controller → service → schema (Zod)
  src/events/    Transactional outbox + relay (see ARCHITECTURE.md)
  src/queues/    BullMQ queue definitions + job processors
  tests/         Vitest: unit tests for domain logic, Supertest integration tests for the API
web/             React + Vite recruiter app + public careers site
docs/            The four documents linked above
```
