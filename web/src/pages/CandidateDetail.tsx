import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, CalendarPlus, CheckCircle2, Mail, Phone, UploadCloud } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { canManage, type Application, type Candidate, type DuplicateLink, type OrgUser, type Resume, type StageEvent } from "../lib/types";

interface CandidateDetailDto extends Candidate {
  resumes: Resume[];
  applications: Application[];
  duplicateLinksA: DuplicateLink[];
  duplicateLinksB: DuplicateLink[];
}

const RESUME_BADGE: Record<Resume["parseStatus"], string> = {
  PARSED: "badge-green",
  FAILED: "badge-red",
  PARSING: "badge-amber",
  PENDING: "badge-amber",
};

function Timeline({ applicationId }: { applicationId: string }) {
  const { data } = useQuery({
    queryKey: ["application-events", applicationId],
    queryFn: () => api.get<{ items: StageEvent[] }>(`/applications/${applicationId}/events`),
  });
  return (
    <ol className="mt-2 space-y-1.5 border-l-2 border-slate-200 pl-4">
      {data?.items.map((e) => (
        <li key={e.id} className="text-xs text-slate-500">
          <span className="font-medium text-slate-700">{e.fromStage ? `${e.fromStage.name} → ${e.toStage.name}` : `Applied (${e.toStage.name})`}</span>
          {e.isBackwardMove && <span className="ml-1 text-amber-600">(moved back)</span>}
          {e.reason && <span className="ml-1 italic">— {e.reason}</span>}
          <span className="ml-2">{new Date(e.createdAt).toLocaleString()}</span>
          {e.durationInPrevStageSec != null && (
            <span className="ml-2 text-slate-400">({(e.durationInPrevStageSec / 86400).toFixed(1)}d in previous stage)</span>
          )}
        </li>
      ))}
    </ol>
  );
}

function ScheduleInterviewForm({ applicationId, onDone }: { applicationId: string; onDone: () => void }) {
  const [scheduledAt, setScheduledAt] = useState("");
  const [mode, setMode] = useState("VIDEO");
  const [panelistUserIds, setPanelistUserIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Who can be a panelist - needed here because submitScorecard() only
  // accepts a scorecard from a listed panelist (or a manage-role override),
  // and an INTERVIEWER's interview list is scoped to interviews they're a
  // panelist on. Without a way to pick panelists here, an interview
  // scheduled through the UI would never be assignable to anyone.
  const { data: orgUsers } = useQuery({
    queryKey: ["org-users"],
    queryFn: () => api.get<{ items: OrgUser[] }>("/auth/users"),
  });

  const schedule = useMutation({
    mutationFn: () =>
      api.post("/interviews", {
        applicationId,
        scheduledAt: new Date(scheduledAt).toISOString(),
        mode,
        panelistUserIds,
      }),
    onSuccess: onDone,
    onError: (err) => setError(err instanceof ApiError ? (err.detail ?? err.message) : "Failed to schedule"),
  });

  function togglePanelist(userId: string) {
    setPanelistUserIds((ids) => (ids.includes(userId) ? ids.filter((id) => id !== userId) : [...ids, userId]));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    schedule.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="mt-2 animate-fade-up space-y-3 rounded-lg bg-slate-50 p-3 text-sm">
      {error && <p className="rounded bg-red-50 px-2 py-1 text-red-700">{error}</p>}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-slate-500">Date &amp; time</label>
          <input
            type="datetime-local"
            required
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
            className="input mt-1"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-500">Mode</label>
          <select value={mode} onChange={(e) => setMode(e.target.value)} className="input mt-1">
            {["VIDEO", "ONSITE", "PHONE"].map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={schedule.isPending} className="btn-primary btn-sm">
          {schedule.isPending ? "Scheduling…" : "Schedule"}
        </button>
      </div>
      <div>
        <label className="block text-xs text-slate-500">Panelists (only listed panelists can submit a scorecard for this interview)</label>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {orgUsers?.items.map((u) => (
            <label
              key={u.id}
              className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                panelistUserIds.includes(u.id) ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-600"
              }`}
            >
              <input
                type="checkbox"
                checked={panelistUserIds.includes(u.id)}
                onChange={() => togglePanelist(u.id)}
                className="sr-only"
              />
              {u.name}
            </label>
          ))}
          {orgUsers && orgUsers.items.length === 0 && <span className="text-xs text-slate-400">No other org users to add.</span>}
        </div>
      </div>
    </form>
  );
}

function UploadResumeForm({ candidateId, onDone }: { candidateId: string; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.set("resume", file!);
      return api.post(`/candidates/${candidateId}/resumes`, form);
    },
    onSuccess: () => {
      setFile(null);
      onDone();
    },
    onError: (err) => setError(err instanceof ApiError ? (err.detail ?? err.message) : "Upload failed"),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (file) upload.mutate();
      }}
      className="mt-3 flex flex-wrap items-center gap-3 text-sm"
    >
      {error && <p className="w-full rounded bg-red-50 px-2 py-1 text-xs text-red-700">{error}</p>}
      <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-xs text-slate-500 transition-colors hover:border-brand-400 hover:bg-brand-50/40">
        {file ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" /> : <UploadCloud className="h-3.5 w-3.5 shrink-0 text-slate-400" />}
        <span className="max-w-[12rem] truncate">{file ? file.name : "Choose a PDF or DOCX"}</span>
        <input type="file" accept=".pdf,.docx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="hidden" />
      </label>
      <button type="submit" disabled={!file || upload.isPending} className="btn-secondary btn-sm">
        {upload.isPending ? "Uploading…" : "Upload"}
      </button>
    </form>
  );
}

export default function CandidateDetail() {
  const { candidateId } = useParams<{ candidateId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isManager = canManage(user?.role);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);

  const {
    data: candidate,
    isLoading: candidateLoading,
    isError: candidateErrored,
  } = useQuery({
    queryKey: ["candidate", candidateId],
    queryFn: () => api.get<CandidateDetailDto>(`/candidates/${candidateId}`),
  });

  if (candidateLoading) return <div className="text-slate-500">Loading…</div>;
  if (candidateErrored || !candidate) {
    return (
      <div className="space-y-3">
        <button onClick={() => navigate(-1)} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-brand-600">
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <p className="text-slate-500">This candidate couldn't be found.</p>
      </div>
    );
  }

  const duplicates = [...candidate.duplicateLinksA, ...candidate.duplicateLinksB];
  const resume = candidate.resumes[0];

  return (
    <div className="space-y-6">
      <button onClick={() => navigate(-1)} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-brand-600">
        <ArrowLeft className="h-3.5 w-3.5" /> Back
      </button>

      <div className="card-pad flex items-center gap-4">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-100 text-base font-semibold text-brand-700">
          {candidate.fullName
            .split(" ")
            .map((p) => p[0])
            .slice(0, 2)
            .join("")
            .toUpperCase()}
        </span>
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{candidate.fullName}</h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500">
            <span className="flex items-center gap-1">
              <Mail className="h-3.5 w-3.5" /> {candidate.email}
            </span>
            {candidate.phone && (
              <span className="flex items-center gap-1">
                <Phone className="h-3.5 w-3.5" /> {candidate.phone}
              </span>
            )}
          </p>
        </div>
      </div>

      {duplicates.length > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Possible duplicate detected ({duplicates.length}). Review in the{" "}
            <span className="cursor-pointer font-medium underline" onClick={() => navigate("/app/duplicates")}>
              duplicates queue
            </span>
            .
          </p>
        </div>
      )}

      <div className="card-pad">
        <div className="flex items-center justify-between">
          <h2 className="section-title">Resume</h2>
          <div className="flex items-center gap-3">
            {resume && <span className={RESUME_BADGE[resume.parseStatus]}>{resume.parseStatus}</span>}
            {isManager && (
              <button onClick={() => setShowUpload((v) => !v)} className="link-muted font-medium">
                {resume ? "Upload new" : "Upload resume"}
              </button>
            )}
          </div>
        </div>
        {isManager && showUpload && (
          <UploadResumeForm
            candidateId={candidateId!}
            onDone={() => {
              setShowUpload(false);
              queryClient.invalidateQueries({ queryKey: ["candidate", candidateId] });
            }}
          />
        )}
        {!resume && !showUpload && <p className="mt-2 text-sm text-slate-400">No resume on file yet.</p>}
        {resume && (
          <>
          {resume.parsedProfile && (
            <div className="mt-3 space-y-3 text-sm">
              {!!resume.parsedProfile.skills?.length && (
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Skills</p>
                  <p className="mt-0.5 text-slate-700">{resume.parsedProfile.skills.join(", ")}</p>
                </div>
              )}
              {!!resume.parsedProfile.experience?.length && (
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Experience</p>
                  {resume.parsedProfile.experience.map((exp, i) => (
                    <p key={i} className="text-slate-700">{[exp.title, exp.employer].filter(Boolean).join(" @ ")}</p>
                  ))}
                </div>
              )}
              {!!resume.parsedProfile.education?.length && (
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Education</p>
                  {resume.parsedProfile.education.map((ed, i) => (
                    <p key={i} className="text-slate-700">{[ed.degree, ed.school].filter(Boolean).join(" — ")}</p>
                  ))}
                </div>
              )}
            </div>
          )}
          </>
        )}
      </div>

      <div className="card-pad">
        <h2 className="section-title">Applications</h2>
        <div className="mt-3 divide-y divide-slate-100">
          {candidate.applications.map((app) => (
            <div key={app.id} className="py-3">
              <div className="flex items-center justify-between">
                <button className="flex-1 text-left" onClick={() => setExpanded(expanded === app.id ? null : app.id)}>
                  <p className="font-medium text-slate-900">{app.job?.title}</p>
                  <p className="text-xs text-slate-400">{app.currentStage?.name} · {app.status}</p>
                </button>
                <div className="flex items-center gap-3">
                  {isManager && app.status === "ACTIVE" && (
                    <button
                      onClick={() => setScheduling(scheduling === app.id ? null : app.id)}
                      className="link-muted flex items-center gap-1 font-medium"
                    >
                      <CalendarPlus className="h-3.5 w-3.5" /> Schedule interview
                    </button>
                  )}
                  <span className="text-xs text-slate-400">{expanded === app.id ? "hide timeline" : "show timeline"}</span>
                </div>
              </div>
              {isManager && scheduling === app.id && (
                <ScheduleInterviewForm
                  applicationId={app.id}
                  onDone={() => {
                    setScheduling(null);
                    queryClient.invalidateQueries({ queryKey: ["interviews"] });
                  }}
                />
              )}
              {expanded === app.id && <Timeline applicationId={app.id} />}
            </div>
          ))}
          {candidate.applications.length === 0 && <p className="text-slate-400">No applications yet.</p>}
        </div>
      </div>
    </div>
  );
}
