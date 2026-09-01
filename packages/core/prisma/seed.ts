/**
 * Seeds two orgs with users across every role, published jobs with their
 * default pipeline stages, and ~20 candidates per org spread across stages
 * with backdated StageEvents - so the analytics dashboard (time-to-hire,
 * funnel, stale-candidate alerts) has meaningful numbers on first load
 * instead of an empty state. Safe to re-run: wipes all tables first.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { createHash, randomUUID } from "node:crypto";
import { normalizeEmail, normalizeName, normalizePhone } from "../src/domain/dedupe/normalize.js";
import { DEFAULT_PIPELINE_TEMPLATE } from "../src/domain/pipeline/template.js";

const prisma = new PrismaClient();

const DEMO_PASSWORD = "password123";

// Deterministic (no random suffix) unlike lib/slug.ts's slugify - seed data
// is fixed and small enough that collisions can't happen, and a stable slug
// means the demo login emails printed below are the same on every re-seed,
// so they can be written down in README.md instead of read off stdout.
function simpleSlug(input: string): string {
  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const FIRST_NAMES = [
  "Ava", "Liam", "Noah", "Emma", "Olivia", "Mason", "Sophia", "Lucas", "Mia", "Ethan",
  "Isabella", "James", "Amelia", "Benjamin", "Harper", "Elijah", "Evelyn", "Alexander", "Abigail", "Henry",
  "Priya", "Wei", "Fatima", "Diego", "Yuki", "Omar", "Ingrid", "Kwame", "Sofia", "Arjun",
];
const LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez",
  "Nair", "Chen", "Khan", "Silva", "Tanaka", "Haddad", "Larsen", "Mensah", "Rossi", "Patel",
];
const EMPLOYERS = ["Initech", "Globex", "Umbrella Co", "Stark Industries", "Wayne Enterprises", "Hooli", "Pied Piper"];
const SCHOOLS = ["State University", "Tech Institute", "Springfield College", "Metro University"];
const SOURCES = ["careers_site", "referral", "linkedin", "job_board"];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

async function wipeDatabase() {
  const tables = [
    "scorecard_ratings", "scorecards", "interview_panelists", "interviews",
    "stage_events", "applications", "duplicate_candidate_links", "resumes", "candidates",
    "job_stages", "jobs", "notifications", "audit_logs", "outbox_events", "metrics_rollups",
    "users", "organizations",
  ];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} CASCADE`);
}

async function seedOrg(orgName: string, jobTitles: string[]) {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  const org = await prisma.organization.create({ data: { name: orgName, slug: simpleSlug(orgName) } });

  const users = await Promise.all([
    prisma.user.create({ data: { orgId: org.id, name: "Ada Admin", email: `admin@${org.slug}.test`, passwordHash, role: "ADMIN" } }),
    prisma.user.create({ data: { orgId: org.id, name: "Rita Recruiter", email: `recruiter1@${org.slug}.test`, passwordHash, role: "RECRUITER" } }),
    prisma.user.create({ data: { orgId: org.id, name: "Raj Recruiter", email: `recruiter2@${org.slug}.test`, passwordHash, role: "RECRUITER" } }),
    prisma.user.create({ data: { orgId: org.id, name: "Hana Hiring-Manager", email: `hiring-manager@${org.slug}.test`, passwordHash, role: "HIRING_MANAGER" } }),
    prisma.user.create({ data: { orgId: org.id, name: "Ivan Interviewer", email: `interviewer1@${org.slug}.test`, passwordHash, role: "INTERVIEWER" } }),
    prisma.user.create({ data: { orgId: org.id, name: "Ines Interviewer", email: `interviewer2@${org.slug}.test`, passwordHash, role: "INTERVIEWER" } }),
  ]);
  const [admin, recruiter1, recruiter2, , interviewer1, interviewer2] = users;

  const jobs = [];
  for (const title of jobTitles) {
    const job = await prisma.job.create({
      data: {
        orgId: org.id,
        title,
        description: `We're looking for a ${title} to join our team. Own projects end-to-end, collaborate with a small cross-functional team, and help us scale.`,
        department: pick(["Engineering", "Product", "Design", "Sales"]),
        location: pick(["Remote", "New York, NY", "San Francisco, CA", "Austin, TX"]),
        openings: randomInt(1, 3),
        status: "PUBLISHED",
        publicSlug: simpleSlug(title),
        publishedAt: daysAgo(randomInt(20, 60)),
        stages: { create: DEFAULT_PIPELINE_TEMPLATE.map((s, i) => ({ ...s, order: i })) },
      },
      include: { stages: { orderBy: { order: "asc" } } },
    });
    jobs.push(job);
  }

  // Distribution across pipeline outcomes, weighted so the funnel narrows
  // realistically (most applicants don't make it past screening).
  type Outcome = "applied" | "screen" | "interview" | "offer" | "hired" | "rejected_early" | "rejected_late";
  const outcomeWeights: Array<[Outcome, number]> = [
    ["applied", 5], ["screen", 4], ["interview", 3], ["offer", 2],
    ["hired", 2], ["rejected_early", 6], ["rejected_late", 3],
  ];
  const weightedOutcomes: Outcome[] = outcomeWeights.flatMap(([o, w]) => Array(w).fill(o));

  // A running counter, not a random suffix: Candidate now has a DB-level
  // unique constraint on (orgId, normalizedEmail), and picking from just
  // 30 first names x 20 last names x a random 1-999 suffix left a small but
  // real birthday-paradox chance of a collision crashing the whole seed run
  // (across ~50-100 candidates per org, ballpark ~0.5%) - not acceptable for
  // a script meant to always just work.
  let candidateSeq = 0;

  for (const job of jobs) {
    const stageByKind = Object.fromEntries(job.stages.map((s) => [s.kind, s]));
    const candidateCount = randomInt(8, 12);

    for (let i = 0; i < candidateCount; i++) {
      candidateSeq++;
      const firstName = pick(FIRST_NAMES);
      const lastName = pick(LAST_NAMES);
      const fullName = `${firstName} ${lastName}`;
      const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${candidateSeq}@example.com`;
      const phone = `415-555-${String(randomInt(1000, 9999)).padStart(4, "0")}`;

      const candidate = await prisma.candidate.create({
        data: {
          orgId: org.id,
          fullName,
          email,
          phone,
          normalizedEmail: normalizeEmail(email),
          phoneE164: normalizePhone(phone) ?? undefined,
          normalizedName: normalizeName(fullName),
        },
      });

      const contentHash = createHash("sha256").update(`${email}-${randomUUID()}`).digest("hex");
      await prisma.resume.create({
        data: {
          candidateId: candidate.id,
          storageKey: `${randomUUID()}.pdf`,
          originalName: `${firstName}_${lastName}_resume.pdf`,
          mimeType: "application/pdf",
          sizeBytes: randomInt(15_000, 60_000),
          contentHash,
          parseStatus: "PARSED",
          // Matches what the real pipeline actually produces now - resume
          // parsing is LLM-only (see domain/resume/index.ts), so seed data
          // simulating a parsed resume should look like a real one.
          parserVersion: "deepseek-chat@1",
          parsedProfile: {
            name: fullName,
            email,
            phone,
            skills: [pick(["TypeScript", "Python", "Go"]), pick(["React", "Vue", "Angular"]), pick(["PostgreSQL", "MySQL", "MongoDB"])],
            experience: [{ employer: pick(EMPLOYERS), title: pick(["Engineer", "Senior Engineer", "Lead Engineer"]), description: "Relevant prior experience." }],
            projects: [],
            education: [{ school: pick(SCHOOLS), degree: "B.S. Computer Science" }],
          },
        },
      });

      const appliedDaysAgo = randomInt(3, 45);
      const appliedAt = daysAgo(appliedDaysAgo);
      const outcome = pick(weightedOutcomes);
      const source = pick(SOURCES);

      const application = await prisma.application.create({
        data: {
          candidateId: candidate.id,
          jobId: job.id,
          currentStageId: stageByKind.APPLIED!.id,
          status: "ACTIVE",
          source,
          appliedAt,
        },
      });

      let cursor = appliedAt;
      await prisma.stageEvent.create({
        data: { applicationId: application.id, fromStageId: null, toStageId: stageByKind.APPLIED!.id, actorId: null, createdAt: cursor },
      });

      // Walks the application through the stages implied by its outcome,
      // backdating each StageEvent a few days after the previous one so
      // time-in-stage and time-to-hire have realistic, non-zero spreads.
      const path: Array<{ stage: (typeof job.stages)[number]; reason?: string; status?: "ACTIVE" | "HIRED" | "REJECTED" }> = [];
      if (outcome === "rejected_early") {
        path.push({ stage: stageByKind.REJECTED!, reason: "Not enough relevant experience", status: "REJECTED" });
      } else {
        path.push({ stage: stageByKind.SCREEN! });
        if (outcome === "rejected_late") {
          path.push({ stage: stageByKind.REJECTED!, reason: "Did not pass technical interview", status: "REJECTED" });
        } else if (outcome !== "screen") {
          path.push({ stage: stageByKind.INTERVIEW! });
          if (outcome !== "interview") {
            path.push({ stage: stageByKind.OFFER! });
            if (outcome === "hired") {
              path.push({ stage: stageByKind.HIRED!, status: "HIRED" });
            }
          }
        }
      }

      let currentStageId = stageByKind.APPLIED!.id;
      for (const step of path) {
        const gapDays = randomInt(1, 6);
        cursor = new Date(Math.min(cursor.getTime() + gapDays * 24 * 60 * 60 * 1000, Date.now()));
        await prisma.stageEvent.create({
          data: {
            applicationId: application.id,
            fromStageId: currentStageId,
            toStageId: step.stage.id,
            actorId: pick([recruiter1!.id, recruiter2!.id, admin!.id]),
            reason: step.reason,
            durationInPrevStageSec: gapDays * 24 * 60 * 60,
            createdAt: cursor,
          },
        });
        currentStageId = step.stage.id;
      }

      await prisma.application.update({
        where: { id: application.id },
        data: {
          currentStageId,
          status: path.at(-1)?.status ?? "ACTIVE",
          closedAt: path.at(-1)?.status ? cursor : null,
        },
      });

      // Schedule an interview (± a completed scorecard) for anyone who made
      // it to or past the interview stage, so /interviews and scorecards
      // aren't empty in the demo either.
      if (["interview", "offer", "hired"].includes(outcome)) {
        const interviewAt = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
        const isPast = interviewAt.getTime() < Date.now();
        const interview = await prisma.interview.create({
          data: {
            applicationId: application.id,
            scheduledAt: interviewAt,
            mode: pick(["VIDEO", "ONSITE", "PHONE"]),
            status: isPast ? "COMPLETED" : "SCHEDULED",
            panelists: { create: [{ userId: interviewer1!.id }, { userId: interviewer2!.id }] },
          },
        });
        if (isPast) {
          await prisma.scorecard.create({
            data: {
              interviewId: interview.id,
              authorId: interviewer1!.id,
              overall: pick(["STRONG_YES", "YES", "YES", "NO"]),
              notes: "Seed data scorecard.",
              ratings: {
                create: [
                  { criterion: "Communication", score: randomInt(2, 4) },
                  { criterion: "Technical depth", score: randomInt(2, 4) },
                ],
              },
            },
          });
        }
      }
    }
  }

  return { org, admin };
}

async function main() {
  console.log("Wiping existing data...");
  await wipeDatabase();

  console.log("Seeding Acme Recruiting...");
  const acme = await seedOrg("Acme Recruiting", ["Backend Engineer", "Product Designer"]);

  console.log("Seeding Globex Talent...");
  const globex = await seedOrg("Globex Talent", ["Data Scientist", "Sales Development Rep"]);

  console.log("\nSeed complete. Demo logins (password for all: %s):", DEMO_PASSWORD);
  for (const { org } of [acme, globex]) {
    console.log(`  ${org.name}: admin@${org.slug}.test / recruiter1@${org.slug}.test  (org slug: ${org.slug})`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
