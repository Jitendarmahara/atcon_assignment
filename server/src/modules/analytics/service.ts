import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

// Every query here reads from StageEvent/Application directly - there are no
// separately-maintained counter columns to drift out of sync with reality.
// At meaningfully larger scale these would be precomputed by the
// metrics-rollup job (queues/processors/metricsRollup.ts) into
// MetricsRollup and read from there instead; live SQL is simplest and
// entirely correct at this dataset size, so that's the only thing running
// today (see ARCHITECTURE.md).

export async function timeToHire(orgId: string, jobId?: string) {
  const jobFilter = jobId ? Prisma.sql`AND a."jobId" = ${jobId}` : Prisma.empty;

  const perJob = await prisma.$queryRaw<Array<{ jobId: string; title: string; hires: bigint; p50Days: number | null; p90Days: number | null }>>`
    WITH hires AS (
      SELECT a."jobId", j.title,
             EXTRACT(EPOCH FROM (se."createdAt" - a."appliedAt")) / 86400.0 AS days_to_hire
      FROM applications a
      JOIN stage_events se ON se."applicationId" = a.id
      JOIN job_stages js ON js.id = se."toStageId"
      JOIN jobs j ON j.id = a."jobId"
      WHERE j."orgId" = ${orgId} AND js.kind = 'HIRED' ${jobFilter}
    )
    SELECT "jobId", title, count(*) AS hires,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY days_to_hire) AS "p50Days",
           percentile_cont(0.9) WITHIN GROUP (ORDER BY days_to_hire) AS "p90Days"
    FROM hires
    GROUP BY "jobId", title
    ORDER BY title
  `;

  const overallRows = perJob;
  const totalHires = overallRows.reduce((sum, r) => sum + Number(r.hires), 0);
  const allDays = overallRows.flatMap((r) => (r.p50Days !== null ? [r.p50Days] : []));
  const overallP50 = allDays.length ? median(allDays) : null;

  return {
    overall: { hires: totalHires, p50Days: overallP50 },
    byJob: perJob.map((r) => ({ jobId: r.jobId, title: r.title, hires: Number(r.hires), p50Days: r.p50Days, p90Days: r.p90Days })),
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

export async function funnel(orgId: string, jobId: string) {
  const rows = await prisma.$queryRaw<Array<{ id: string; name: string; kind: string; order: number; reached: bigint }>>`
    SELECT js.id, js.name, js.kind, js.order, COUNT(DISTINCT se."applicationId") AS reached
    FROM job_stages js
    JOIN jobs j ON j.id = js."jobId"
    LEFT JOIN stage_events se ON se."toStageId" = js.id
    WHERE js."jobId" = ${jobId} AND j."orgId" = ${orgId}
    GROUP BY js.id, js.name, js.kind, js.order
    ORDER BY js.order
  `;

  let previous: number | null = null;
  return rows.map((r) => {
    const reached = Number(r.reached);
    const conversionFromPrevious = previous && previous > 0 ? reached / previous : null;
    previous = reached;
    return { stageId: r.id, name: r.name, kind: r.kind, order: r.order, reached, conversionFromPrevious };
  });
}

export async function pipelineHealth(orgId: string, jobId?: string) {
  const jobFilter = jobId ? Prisma.sql`AND js."jobId" = ${jobId}` : Prisma.empty;

  const byStage = await prisma.$queryRaw<Array<{ id: string; name: string; kind: string; order: number; activeCount: bigint }>>`
    SELECT js.id, js.name, js.kind, js.order, COUNT(a.id) AS "activeCount"
    FROM job_stages js
    JOIN jobs j ON j.id = js."jobId"
    LEFT JOIN applications a ON a."currentStageId" = js.id AND a.status = 'ACTIVE'
    WHERE j."orgId" = ${orgId} ${jobFilter}
    GROUP BY js.id, js.name, js.kind, js.order
    ORDER BY js.order
  `;

  const stale = await prisma.$queryRaw<
    Array<{ applicationId: string; candidateName: string; jobTitle: string; stageName: string; slaDays: number; daysInStage: number }>
  >`
    SELECT a.id AS "applicationId", c."fullName" AS "candidateName", j.title AS "jobTitle",
           js.name AS "stageName", js."slaDays" AS "slaDays",
           EXTRACT(EPOCH FROM (now() - se."createdAt")) / 86400.0 AS "daysInStage"
    FROM applications a
    JOIN jobs j ON j.id = a."jobId"
    JOIN candidates c ON c.id = a."candidateId"
    JOIN job_stages js ON js.id = a."currentStageId"
    JOIN LATERAL (
      SELECT "createdAt" FROM stage_events se2 WHERE se2."applicationId" = a.id ORDER BY se2."createdAt" DESC LIMIT 1
    ) se ON true
    WHERE j."orgId" = ${orgId} ${jobId ? Prisma.sql`AND a."jobId" = ${jobId}` : Prisma.empty}
      AND a.status = 'ACTIVE' AND js."slaDays" IS NOT NULL
      AND EXTRACT(EPOCH FROM (now() - se."createdAt")) / 86400.0 > js."slaDays"
    ORDER BY "daysInStage" DESC
  `;

  return {
    byStage: byStage.map((r) => ({ stageId: r.id, name: r.name, kind: r.kind, order: r.order, activeCount: Number(r.activeCount) })),
    staleCandidates: stale.map((r) => ({ ...r, daysInStage: Math.round(r.daysInStage * 10) / 10 })),
  };
}

export async function sourceEffectiveness(orgId: string) {
  const rows = await prisma.$queryRaw<Array<{ source: string; applications: bigint; hires: bigint }>>`
    SELECT a.source, COUNT(*) AS applications, COUNT(*) FILTER (WHERE a.status = 'HIRED') AS hires
    FROM applications a
    JOIN jobs j ON j.id = a."jobId"
    WHERE j."orgId" = ${orgId}
    GROUP BY a.source
    ORDER BY applications DESC
  `;
  return rows.map((r) => ({
    source: r.source,
    applications: Number(r.applications),
    hires: Number(r.hires),
    hireRate: Number(r.applications) > 0 ? Number(r.hires) / Number(r.applications) : 0,
  }));
}

// Snapshots every metric above into MetricsRollup, keyed by (orgId, metric,
// scope). This is the scale-out path referenced in ARCHITECTURE.md: at
// larger data volumes, the analytics endpoints would read from this table
// (refreshed by queues/processors/metricsRollup.ts) instead of running the
// live queries above on every request.
export async function computeAndStoreRollups(orgId: string) {
  const [ttH, health, sources] = await Promise.all([timeToHire(orgId), pipelineHealth(orgId), sourceEffectiveness(orgId)]);

  // Callback form, not an array of upserts: lib/prisma.ts's RLS-scoping Proxy
  // invokes each top-level `prisma.x.y(...)` call eagerly and independently
  // the instant it's called (see the comment on jobs/service.ts's
  // reorderStages, which hit exactly this as a real, reproducible bug) - an
  // array of upserts would each commit as its own transaction with no actual
  // atomicity, rather than the one-transaction guarantee this function's own
  // comment above claims.
  await prisma.$transaction(async (tx) => {
    await tx.metricsRollup.upsert({
      where: { orgId_metric_scope: { orgId, metric: "time_to_hire", scope: "org" } },
      create: { orgId, metric: "time_to_hire", scope: "org", data: ttH as never },
      update: { data: ttH as never, computedAt: new Date() },
    });
    await tx.metricsRollup.upsert({
      where: { orgId_metric_scope: { orgId, metric: "pipeline_health", scope: "org" } },
      create: { orgId, metric: "pipeline_health", scope: "org", data: health as never },
      update: { data: health as never, computedAt: new Date() },
    });
    await tx.metricsRollup.upsert({
      where: { orgId_metric_scope: { orgId, metric: "sources", scope: "org" } },
      create: { orgId, metric: "sources", scope: "org", data: sources as never },
      update: { data: sources as never, computedAt: new Date() },
    });
  });
}
