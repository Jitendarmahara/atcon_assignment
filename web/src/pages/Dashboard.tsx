import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Clock, TrendingUp, Users2, type LucideIcon } from "lucide-react";
import { api } from "../lib/api";

interface TimeToHire {
  overall: { hires: number; p50Days: number | null };
  byJob: Array<{ jobId: string; title: string; hires: number; p50Days: number | null; p90Days: number | null }>;
}
interface PipelineHealth {
  byStage: Array<{ stageId: string; name: string; kind: string; activeCount: number }>;
  staleCandidates: Array<{ applicationId: string; candidateName: string; jobTitle: string; stageName: string; slaDays: number; daysInStage: number }>;
}
interface SourceRow {
  source: string;
  applications: number;
  hires: number;
  hireRate: number;
}

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: LucideIcon;
  accent: string;
}) {
  return (
    <div className="card-pad">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">{label}</p>
        <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${accent}`}>
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-400">{sub}</p>}
    </div>
  );
}

export default function Dashboard() {
  const { data: ttH } = useQuery({ queryKey: ["analytics", "time-to-hire"], queryFn: () => api.get<TimeToHire>("/analytics/time-to-hire") });
  const { data: health } = useQuery({ queryKey: ["analytics", "pipeline-health"], queryFn: () => api.get<PipelineHealth>("/analytics/pipeline-health") });
  const { data: sources } = useQuery({ queryKey: ["analytics", "sources"], queryFn: () => api.get<{ items: SourceRow[] }>("/analytics/sources") });

  const totalActive = health?.byStage.reduce((sum, s) => sum + s.activeCount, 0) ?? 0;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="page-title">Dashboard</h1>
        <p className="mt-1 text-sm text-slate-500">Live snapshot of your hiring pipeline.</p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard
          label="Hires (all time)"
          value={String(ttH?.overall.hires ?? "—")}
          icon={TrendingUp}
          accent="bg-emerald-50 text-emerald-600"
        />
        <StatCard
          label="Median time-to-hire"
          value={ttH?.overall.p50Days != null ? `${ttH.overall.p50Days.toFixed(1)}d` : "—"}
          icon={Clock}
          accent="bg-brand-50 text-brand-600"
        />
        <StatCard label="Active applications" value={String(totalActive)} icon={Users2} accent="bg-sky-50 text-sky-600" />
        <StatCard
          label="Stale candidates"
          value={String(health?.staleCandidates.length ?? 0)}
          sub="past their stage's SLA"
          icon={AlertTriangle}
          accent="bg-amber-50 text-amber-600"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card-pad">
          <h2 className="section-title">Pipeline health</h2>
          <div className="mt-4 space-y-2.5">
            {health?.byStage.map((s) => (
              <div key={s.stageId} className="flex items-center gap-3">
                <span className="w-32 shrink-0 truncate text-sm text-slate-600">{s.name}</span>
                <div className="h-2 flex-1 rounded-full bg-slate-100">
                  <div
                    className="h-2 rounded-full bg-brand-gradient transition-all"
                    style={{ width: `${totalActive ? (s.activeCount / totalActive) * 100 : 0}%` }}
                  />
                </div>
                <span className="w-6 text-right text-sm text-slate-500">{s.activeCount}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="card-pad">
          <h2 className="section-title">Stale candidates</h2>
          <p className="text-xs text-slate-400">In-stage longer than that stage's SLA</p>
          <div className="mt-4 space-y-2 text-sm">
            {health?.staleCandidates.length === 0 && (
              <p className="text-slate-400">None — pipeline is healthy 🎉</p>
            )}
            {health?.staleCandidates.slice(0, 8).map((s) => (
              <div key={s.applicationId} className="flex items-center justify-between border-b border-slate-100 pb-1.5">
                <div>
                  <span className="font-medium text-slate-800">{s.candidateName}</span>
                  <span className="text-slate-400"> · {s.jobTitle}</span>
                </div>
                <span className="badge-amber">
                  {s.stageName} · {s.daysInStage.toFixed(1)}d (SLA {s.slaDays}d)
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="card-pad">
          <h2 className="section-title">Time-to-hire by job</h2>
          <table className="mt-4 w-full text-sm">
            <thead className="text-left text-slate-400">
              <tr>
                <th className="pb-2 font-normal">Job</th>
                <th className="pb-2 font-normal">Hires</th>
                <th className="pb-2 font-normal">p50</th>
                <th className="pb-2 font-normal">p90</th>
              </tr>
            </thead>
            <tbody>
              {ttH?.byJob.map((j) => (
                <tr key={j.jobId} className="border-t border-slate-100">
                  <td className="py-1.5">{j.title}</td>
                  <td className="py-1.5">{j.hires}</td>
                  <td className="py-1.5">{j.p50Days?.toFixed(1) ?? "—"}d</td>
                  <td className="py-1.5">{j.p90Days?.toFixed(1) ?? "—"}d</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card-pad">
          <h2 className="section-title">Applications by source</h2>
          <table className="mt-4 w-full text-sm">
            <thead className="text-left text-slate-400">
              <tr>
                <th className="pb-2 font-normal">Source</th>
                <th className="pb-2 font-normal">Applications</th>
                <th className="pb-2 font-normal">Hires</th>
                <th className="pb-2 font-normal">Hire rate</th>
              </tr>
            </thead>
            <tbody>
              {sources?.items.map((s) => (
                <tr key={s.source} className="border-t border-slate-100">
                  <td className="py-1.5">{s.source}</td>
                  <td className="py-1.5">{s.applications}</td>
                  <td className="py-1.5">{s.hires}</td>
                  <td className="py-1.5">{(s.hireRate * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
