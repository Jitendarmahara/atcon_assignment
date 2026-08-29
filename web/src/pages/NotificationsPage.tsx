import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, GitCommitHorizontal, ScanSearch, UserPlus } from "lucide-react";
import { api } from "../lib/api";
import type { Notification, Page } from "../lib/types";

function describe(n: Notification): string {
  const p = n.payload as Record<string, string>;
  switch (n.type) {
    case "application.submitted":
      return `New application: ${p.candidateName} → ${p.jobTitle}`;
    case "application.stage_changed":
      return `${p.candidateName} moved to ${p.toStage}`;
    case "candidate.duplicate_suspected":
      return `Possible duplicate candidate detected`;
    default:
      return n.type;
  }
}

function iconFor(type: string) {
  switch (type) {
    case "application.submitted":
      return UserPlus;
    case "application.stage_changed":
      return GitCommitHorizontal;
    case "candidate.duplicate_suspected":
      return ScanSearch;
    default:
      return Bell;
  }
}

export default function NotificationsPage() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["notifications", "all"], queryFn: () => api.get<Page<Notification>>("/notifications?limit=50") });

  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });

  return (
    <div className="space-y-6">
      <h1 className="page-title">Notifications</h1>
      <div className="card divide-y divide-slate-100">
        {data?.items.map((n) => {
          const Icon = iconFor(n.type);
          return (
            <div key={n.id} className={`flex items-center gap-3 p-4 ${n.readAt ? "" : "bg-brand-50/40"}`}>
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                  n.readAt ? "bg-slate-100 text-slate-400" : "bg-brand-100 text-brand-600"
                }`}
              >
                <Icon className="h-4 w-4" />
              </span>
              <div className="flex-1">
                <p className="text-sm text-slate-800">{describe(n)}</p>
                <p className="text-xs text-slate-400">{new Date(n.createdAt).toLocaleString()}</p>
              </div>
              {!n.readAt && (
                <button onClick={() => markRead.mutate(n.id)} className="link-muted shrink-0 font-medium">
                  Mark read
                </button>
              )}
            </div>
          );
        })}
        {data?.items.length === 0 && <p className="p-4 text-slate-400">No notifications yet.</p>}
      </div>
    </div>
  );
}
