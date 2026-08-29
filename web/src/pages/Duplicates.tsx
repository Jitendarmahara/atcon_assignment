import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowLeftRight, Merge, PartyPopper } from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { DuplicateLink, Page } from "../lib/types";

export default function Duplicates() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["duplicates"], queryFn: () => api.get<Page<DuplicateLink>>("/duplicates?limit=50") });

  const confirm = useMutation({
    mutationFn: (linkId: string) => api.post(`/duplicates/${linkId}/confirm`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["duplicates"] }),
  });
  const dismiss = useMutation({
    mutationFn: (linkId: string) => api.post(`/duplicates/${linkId}/dismiss`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["duplicates"] }),
  });
  // Confirming a link never auto-merges the underlying records (see
  // docs/ARCHITECTURE.md) - merge is a separate, explicit, audited action
  // (POST /candidates/:survivorId/merge). The recruiter picks which of the
  // two records survives; the other is tombstoned (Candidate.mergedIntoId)
  // with its resumes/applications reassigned to the survivor.
  const merge = useMutation({
    mutationFn: ({ survivorId, duplicateId }: { survivorId: string; duplicateId: string }) =>
      api.post(`/candidates/${survivorId}/merge`, { duplicateId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["duplicates"] }),
    onError: (err) => window.alert(err instanceof ApiError ? (err.detail ?? "Merge failed") : "Merge failed"),
  });

  function onMerge(survivorName: string, survivorId: string, duplicateName: string, duplicateId: string) {
    // window.confirm, not the bare identifier - `confirm` above is this
    // component's "Confirm duplicate" mutation, and shadows the global.
    if (window.confirm(`Merge "${duplicateName}" into "${survivorName}"? This can't be undone.`)) {
      merge.mutate({ survivorId, duplicateId });
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Duplicate review queue</h1>
        <p className="mt-1 text-sm text-slate-500">
          Candidates flagged by fuzzy matching (name similarity, shared employer/resume signals). Exact email/phone
          matches are auto-linked and don't need review.
        </p>
      </div>

      <div className="card divide-y divide-slate-100">
        {data?.items.map((link) => (
          <div key={link.id} className="flex items-center justify-between gap-4 p-4">
            <div className="flex-1">
              <div className="flex items-center gap-2 text-sm">
                <Link to={`/app/candidates/${link.candidateA.id}`} className="font-medium text-slate-900 hover:text-brand-600">
                  {link.candidateA.fullName}
                </Link>
                <ArrowLeftRight className="h-3.5 w-3.5 text-slate-400" />
                <Link to={`/app/candidates/${link.candidateB.id}`} className="font-medium text-slate-900 hover:text-brand-600">
                  {link.candidateB.fullName}
                </Link>
                <span className="badge-brand">{(link.confidence * 100).toFixed(0)}% confidence</span>
              </div>
              <p className="mt-1 text-xs text-slate-400">Signals: {link.signals.map((s) => s.name).join(", ")}</p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <button onClick={() => confirm.mutate(link.id)} className="btn-primary btn-sm">
                Confirm duplicate
              </button>
              <button onClick={() => dismiss.mutate(link.id)} className="btn-secondary btn-sm">
                Not a duplicate
              </button>
              <button
                onClick={() => onMerge(link.candidateA.fullName, link.candidateA.id, link.candidateB.fullName, link.candidateB.id)}
                className="btn-secondary btn-sm"
                title={`Keep ${link.candidateA.fullName}, merge ${link.candidateB.fullName} into it`}
              >
                <Merge className="h-3.5 w-3.5" /> Keep {link.candidateA.fullName.split(" ")[0]}
              </button>
              <button
                onClick={() => onMerge(link.candidateB.fullName, link.candidateB.id, link.candidateA.fullName, link.candidateA.id)}
                className="btn-secondary btn-sm"
                title={`Keep ${link.candidateB.fullName}, merge ${link.candidateA.fullName} into it`}
              >
                <Merge className="h-3.5 w-3.5" /> Keep {link.candidateB.fullName.split(" ")[0]}
              </button>
            </div>
          </div>
        ))}
        {data?.items.length === 0 && (
          <p className="flex items-center justify-center gap-2 p-8 text-slate-400">
            <PartyPopper className="h-4 w-4" /> No pending duplicates.
          </p>
        )}
      </div>
    </div>
  );
}
