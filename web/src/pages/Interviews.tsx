import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Calendar } from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { Application, Interview, Page } from "../lib/types";

const SCORECARD_CRITERIA = ["Communication", "Technical depth", "Culture add"];

function ScorecardForm({ interviewId, onDone }: { interviewId: string; onDone: () => void }) {
  const [overall, setOverall] = useState("YES");
  const [notes, setNotes] = useState("");
  const [scores, setScores] = useState<Record<string, number>>(Object.fromEntries(SCORECARD_CRITERIA.map((c) => [c, 3])));
  const [error, setError] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: () =>
      api.post(`/interviews/${interviewId}/scorecards`, {
        overall,
        notes: notes || undefined,
        ratings: SCORECARD_CRITERIA.map((criterion) => ({ criterion, score: scores[criterion] })),
      }),
    onSuccess: onDone,
    onError: (err) => setError(err instanceof ApiError ? (err.detail ?? err.message) : "Failed to submit"),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    submit.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 animate-fade-up space-y-3 rounded-lg bg-slate-50 p-4 text-sm">
      {error && <p className="rounded-lg bg-red-50 px-2 py-1 text-red-700">{error}</p>}
      <div>
        <label className="field-label">Overall</label>
        <select value={overall} onChange={(e) => setOverall(e.target.value)} className="input mt-1 w-auto">
          {["STRONG_YES", "YES", "NO", "STRONG_NO"].map((o) => (
            <option key={o} value={o}>{o.replace("_", " ")}</option>
          ))}
        </select>
      </div>
      {SCORECARD_CRITERIA.map((c) => (
        <div key={c} className="flex items-center gap-3">
          <span className="w-36 text-slate-600">{c}</span>
          <input
            type="range"
            min={1}
            max={4}
            value={scores[c]}
            onChange={(e) => setScores((s) => ({ ...s, [c]: Number(e.target.value) }))}
            className="accent-brand-600"
          />
          <span className="font-medium text-slate-700">{scores[c]}/4</span>
        </div>
      ))}
      <textarea placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} className="input" rows={2} />
      <button type="submit" disabled={submit.isPending} className="btn-primary btn-sm">
        {submit.isPending ? "Submitting…" : "Submit scorecard"}
      </button>
    </form>
  );
}

const STATUS_BADGE: Record<Interview["status"], string> = {
  SCHEDULED: "badge-brand",
  COMPLETED: "badge-green",
  CANCELLED: "badge-slate",
  NO_SHOW: "badge-red",
};

export default function Interviews() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["interviews"],
    queryFn: () => api.get<Page<Interview>>("/interviews?limit=50"),
    // useRealtime() invalidates this on interview.scheduled/interview.updated
    // - this interval is the same reconciliation safety net every other
    // live-updated list in this app keeps, in case a push was ever missed.
    // Previously absent entirely, which combined with the missing push
    // (fixed alongside this) meant the page had no update mechanism at all.
    refetchInterval: 120_000,
  });
  const [openScorecard, setOpenScorecard] = useState<string | null>(null);

  const cancel = useMutation({
    mutationFn: (interviewId: string) => api.post(`/interviews/${interviewId}/cancel`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["interviews"] }),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Interviews</h1>
        <p className="mt-1 text-sm text-slate-500">
          Interviews are scheduled from a candidate's application. Submit structured scorecards here once completed.
        </p>
      </div>

      <div className="card divide-y divide-slate-100">
        {data?.items.map((interview) => {
          const app = interview.application as Application | undefined;
          return (
            <div key={interview.id} className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <Link to={`/app/candidates/${app?.candidateId}`} className="font-medium text-slate-900 hover:text-brand-600">
                    {app?.candidate?.fullName}
                  </Link>
                  <span className="ml-2 text-sm text-slate-400">{app?.job?.title}</span>
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-400">
                    <Calendar className="h-3 w-3" />
                    {new Date(interview.scheduledAt).toLocaleString()} · {interview.mode}
                    <span className={STATUS_BADGE[interview.status]}>{interview.status}</span>
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {interview.status === "SCHEDULED" && (
                    <button onClick={() => cancel.mutate(interview.id)} className="text-xs font-medium text-red-600 hover:underline">
                      Cancel
                    </button>
                  )}
                  <button
                    onClick={() => setOpenScorecard(openScorecard === interview.id ? null : interview.id)}
                    className="link-muted font-medium"
                  >
                    {openScorecard === interview.id ? "Close" : "Scorecard"}
                  </button>
                </div>
              </div>
              {openScorecard === interview.id && (
                <ScorecardForm interviewId={interview.id} onDone={() => setOpenScorecard(null)} />
              )}
            </div>
          );
        })}
        {data?.items.length === 0 && <p className="p-4 text-slate-400">No interviews scheduled.</p>}
      </div>
    </div>
  );
}
