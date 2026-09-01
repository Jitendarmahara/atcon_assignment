import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Briefcase, Calendar, CheckCircle2, LayoutGrid, LogOut, MapPin, PartyPopper, UploadCloud } from "lucide-react";
import { candidateApi, ApiError } from "../lib/candidateApi";
import { useCandidateAuth, type CandidateAccount } from "../hooks/useCandidateAuth";

interface MyApplication {
  id: string;
  jobTitle: string;
  orgName: string;
  status: "ACTIVE" | "HIRED" | "REJECTED" | "WITHDRAWN";
  currentStageName: string;
  currentStageKind: string;
  appliedAt: string;
  closedAt: string | null;
}

interface OpenRole {
  id: string;
  title: string;
  description: string;
  department: string | null;
  location: string | null;
  employmentType: string;
  orgName: string;
  orgSlug: string;
  jobSlug: string;
}

interface TimelineEvent {
  id: string;
  fromStageName: string | null;
  toStageName: string;
  toStageKind: string;
  createdAt: string;
}

const STAGE_BADGE: Record<string, string> = {
  APPLIED: "badge-slate",
  SCREEN: "badge-brand",
  INTERVIEW: "badge-brand",
  OFFER: "badge-amber",
  HIRED: "badge-green",
  REJECTED: "badge-red",
};

// Mirrors the recruiter side's stage-kind vocabulary (server/prisma/schema.prisma's
// StageKind enum) but phrased for the person it's actually about, not the
// person who moved them - this is literally the feature that was asked for:
// "you have reached this round" rather than a raw stage name.
function reachedMessage(kind: string, stageName: string): string {
  switch (kind) {
    case "HIRED":
      return `You got the offer! 🎉`;
    case "REJECTED":
      return `This application won't be moving forward`;
    case "OFFER":
      return `You've reached the Offer stage`;
    default:
      return `You've reached the ${stageName} round`;
  }
}

interface RecentUpdate {
  id: string;
  applicationId: string;
  jobTitle: string;
  orgName: string;
  toStageName: string;
  toStageKind: string;
  createdAt: string;
}

// The bell used to be a plain <span> with a count and no click handler -
// looked like a button, did nothing like one. This is what clicking it
// actually opens: the real list behind the number, not just the number.
function NotificationDropdown({ onClose }: { onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["candidate-recent-updates"],
    queryFn: () => candidateApi.get<{ items: RecentUpdate[] }>("/candidate-portal/notifications"),
  });

  return (
    <div className="absolute right-0 top-full z-20 mt-2 w-80 rounded-xl border border-slate-200 bg-white shadow-card">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
        <span className="text-sm font-semibold text-slate-900">Updates</span>
        <button onClick={onClose} className="text-xs text-slate-400 hover:text-slate-600">
          Close
        </button>
      </div>
      <div className="max-h-80 overflow-y-auto">
        {isLoading && <p className="p-4 text-sm text-slate-400">Loading…</p>}
        {data?.items.map((u) => (
          <div key={u.id} className="border-b border-slate-50 px-4 py-2.5 text-sm last:border-b-0">
            <p className="font-medium text-slate-800">{reachedMessage(u.toStageKind, u.toStageName)}</p>
            <p className="text-xs text-slate-400">
              {u.jobTitle} · {u.orgName}
            </p>
            <p className="mt-0.5 text-xs text-slate-400">{new Date(u.createdAt).toLocaleString()}</p>
          </div>
        ))}
        {data && data.items.length === 0 && <p className="p-4 text-sm text-slate-400">No updates yet.</p>}
      </div>
    </div>
  );
}

function Timeline({ applicationId }: { applicationId: string }) {
  const { data } = useQuery({
    queryKey: ["candidate-timeline", applicationId],
    queryFn: () => candidateApi.get<{ events: TimelineEvent[] }>(`/candidate-portal/applications/${applicationId}/timeline`),
  });

  return (
    <ol className="mt-3 space-y-2 border-l-2 border-slate-200 pl-4">
      {data?.events.map((e) => (
        <li key={e.id} className="text-sm">
          <p className="font-medium text-slate-800">{reachedMessage(e.toStageKind, e.toStageName)}</p>
          <p className="text-xs text-slate-400">{new Date(e.createdAt).toLocaleString()}</p>
        </li>
      ))}
    </ol>
  );
}

function ApplicationCard({ app }: { app: MyApplication }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="card-pad">
      <button onClick={() => setExpanded((v) => !v)} className="flex w-full items-center justify-between gap-4 text-left">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-slate-900">{app.jobTitle}</h2>
            <span className={STAGE_BADGE[app.currentStageKind] ?? "badge-slate"}>{app.currentStageName}</span>
          </div>
          <p className="mt-1 flex items-center gap-3 text-sm text-slate-500">
            <span className="flex items-center gap-1">
              <Briefcase className="h-3.5 w-3.5" /> {app.orgName}
            </span>
            <span className="flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" /> Applied {new Date(app.appliedAt).toLocaleDateString()}
            </span>
          </p>
        </div>
        <span className="text-xs text-slate-400">{expanded ? "hide updates" : "show updates"}</span>
      </button>
      {expanded && <Timeline applicationId={app.id} />}
    </div>
  );
}

// Applying still goes through the existing public apply endpoint
// (POST /public/orgs/:orgSlug/jobs/:jobSlug/apply) - it was already
// unauthenticated and public, so there's no new backend apply path here,
// just name/email pre-filled from the logged-in account instead of asking
// for them again. The candidate's own bearer token rides along on the
// request (candidateApi attaches it to everything) but the endpoint itself
// doesn't require or check it - harmless, same as any other extra header.
function OpenRoleCard({ role, account, onApplied }: { role: OpenRole; account: CandidateAccount; onApplied: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [resume, setResume] = useState<File | null>(null);
  const [status, setStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus("submitting");
    setError(null);
    try {
      const form = new FormData();
      form.set("fullName", account.fullName);
      form.set("email", account.email);
      if (resume) form.set("resume", resume);
      await candidateApi.post(`/public/orgs/${role.orgSlug}/jobs/${role.jobSlug}/apply`, form);
      onApplied();
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.message) : "Something went wrong");
      setStatus("idle");
    }
  }

  return (
    <div className="card-pad">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-slate-900">{role.title}</h3>
            <span className="badge-slate">{role.employmentType.replace("_", " ")}</span>
          </div>
          <p className="mt-1 flex items-center gap-3 text-sm text-slate-500">
            <span className="flex items-center gap-1">
              <Briefcase className="h-3.5 w-3.5" /> {role.orgName}
            </span>
            {role.location && (
              <span className="flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5" /> {role.location}
              </span>
            )}
          </p>
        </div>
        {!expanded && (
          <button onClick={() => setExpanded(true)} className="btn-primary btn-sm shrink-0">
            Apply
          </button>
        )}
      </div>

      {expanded && (
        <form onSubmit={onSubmit} className="mt-4 animate-fade-up space-y-3 border-t border-slate-100 pt-4 text-sm">
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-red-700">{error}</p>}
          <p className="text-slate-500">
            Applying as <span className="font-medium text-slate-700">{account.fullName}</span> ({account.email})
          </p>
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-xs text-slate-500 transition-colors hover:border-brand-400 hover:bg-brand-50/40">
            {resume ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" /> : <UploadCloud className="h-3.5 w-3.5 shrink-0 text-slate-400" />}
            <span className="truncate">{resume ? resume.name : "Attach a resume (optional, PDF or DOCX)"}</span>
            <input type="file" accept=".pdf,.docx" onChange={(e) => setResume(e.target.files?.[0] ?? null)} className="hidden" />
          </label>
          <div className="flex items-center gap-2">
            <button type="submit" disabled={status === "submitting"} className="btn-primary btn-sm">
              {status === "submitting" ? "Submitting…" : "Submit application"}
            </button>
            <button type="button" onClick={() => setExpanded(false)} className="btn-secondary btn-sm">
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export default function CandidateDashboard() {
  const { account, logout } = useCandidateAuth();
  const navigate = useNavigate();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["candidate-applications"],
    queryFn: () => candidateApi.get<{ items: MyApplication[] }>("/candidate-portal/applications"),
    // No SSE channel for the candidate portal (deliberately out of scope for
    // this pass - see docs/ASSUMPTIONS.md) - a moderate poll is the whole
    // update mechanism here, not just a reconciliation safety net on top of
    // a push.
    refetchInterval: 30_000,
  });

  const queryClient = useQueryClient();

  const { data: openRoles, isLoading: openRolesLoading } = useQuery({
    queryKey: ["candidate-open-roles"],
    queryFn: () => candidateApi.get<{ items: OpenRole[] }>("/candidate-portal/open-roles"),
    refetchInterval: 30_000,
  });

  function onApplied() {
    // The applied-to role disappears from "Open roles" (the server excludes
    // it) and the new application shows up in "Your applications" above -
    // both driven by the same refetch, one page, no navigation.
    queryClient.invalidateQueries({ queryKey: ["candidate-open-roles"] });
    queryClient.invalidateQueries({ queryKey: ["candidate-applications"] });
  }

  const { data: unreadData } = useQuery({
    queryKey: ["candidate-unread-count"],
    queryFn: () => candidateApi.get<{ count: number }>("/candidate-portal/notifications/unread-count"),
    refetchInterval: 30_000,
  });
  const unreadCount = unreadData?.count ?? 0;

  const markViewed = useMutation({
    mutationFn: () => candidateApi.post("/candidate-portal/notifications/mark-viewed"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["candidate-unread-count"] }),
  });

  // Give the badge a moment to actually be seen before clearing it - the
  // whole dashboard already *is* the update feed (each application's
  // timeline is right there), so simply having the page open counts as
  // having seen it, same as the recruiter bell doesn't require a per-item
  // click here.
  useEffect(() => {
    if (unreadCount === 0) return;
    const timer = setTimeout(() => markViewed.mutate(), 3000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadCount > 0]);

  async function onLogout() {
    await logout();
    navigate("/candidate/login");
  }

  const [showNotifications, setShowNotifications] = useState(false);

  function toggleNotifications() {
    setShowNotifications((v) => {
      const next = !v;
      // Clicking to open is a much clearer "I've seen this" signal than
      // waiting on the passive timer below - fire it immediately rather
      // than making the person who actually engaged with the bell wait for
      // the same 3 seconds someone who never clicks it gets.
      if (next && unreadCount > 0) markViewed.mutate();
      return next;
    });
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-10 border-b border-slate-200/80 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-gradient text-white shadow-soft">
              <LayoutGrid className="h-4 w-4" />
            </span>
            <span className="text-base font-semibold tracking-tight text-slate-900">ATS</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <button
                onClick={toggleNotifications}
                className="relative rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
                title="Updates"
              >
                <Bell className="h-4 w-4" />
                {unreadCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white ring-2 ring-white">
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </span>
                )}
              </button>
              {showNotifications && <NotificationDropdown onClose={() => setShowNotifications(false)} />}
            </div>
            <button onClick={onLogout} className="flex items-center gap-1.5 rounded-lg p-2 text-sm text-slate-500 hover:bg-slate-100">
              <LogOut className="h-4 w-4" /> Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="page-title">Welcome back, {account?.fullName}</h1>
        <p className="mt-1 text-sm text-slate-500">Every application you've submitted, and where it stands.</p>

        <div className="mt-6 space-y-4">
          {isLoading && (
            <div className="space-y-3">
              {[0, 1].map((i) => (
                <div key={i} className="card-pad h-20 animate-pulse bg-slate-100" />
              ))}
            </div>
          )}
          {isError && <p className="rounded-lg bg-red-50 px-4 py-3 text-red-700">Couldn't load your applications.</p>}
          {data?.items.map((app) => (
            <ApplicationCard key={app.id} app={app} />
          ))}
          {data && data.items.length === 0 && (
            <div className="card-pad flex flex-col items-center gap-2 py-10 text-center text-slate-500">
              <PartyPopper className="h-6 w-6 text-slate-300" />
              <p>No applications yet — once you apply to a role, it'll show up here.</p>
            </div>
          )}
        </div>

        <div className="mt-10">
          <h2 className="section-title">Open roles</h2>
          <p className="mt-1 text-sm text-slate-500">Apply right here — we already know who you are.</p>
          <div className="mt-4 space-y-4">
            {openRolesLoading && (
              <div className="space-y-3">
                {[0, 1].map((i) => (
                  <div key={i} className="card-pad h-16 animate-pulse bg-slate-100" />
                ))}
              </div>
            )}
            {account &&
              openRoles?.items.map((role) => <OpenRoleCard key={role.id} role={role} account={account} onApplied={onApplied} />)}
            {openRoles && openRoles.items.length === 0 && (
              <p className="card-pad text-center text-slate-400">No open roles right now — check back soon.</p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
