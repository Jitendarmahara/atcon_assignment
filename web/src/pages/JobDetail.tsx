import { useState, type DragEvent, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { canManage, type Application, type Job, type JobStage, type Page } from "../lib/types";

export default function JobDetail() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isManager = canManage(user?.role);
  const [showStageForm, setShowStageForm] = useState(false);

  const {
    data: job,
    isLoading: jobLoading,
    isError: jobErrored,
  } = useQuery({ queryKey: ["job", jobId], queryFn: () => api.get<Job>(`/jobs/${jobId}`) });
  const { data: appsPage } = useQuery({
    queryKey: ["applications", jobId],
    // 100 is the API's pagination cap (lib/pagination.ts) - a job with more
    // active applicants than that would need real pagination/virtualized
    // columns in the board, called out as a "with more time" item.
    queryFn: () => api.get<Page<Application>>(`/applications?jobId=${jobId}&limit=100`),
    enabled: !!jobId,
    // useRealtime() (mounted in Layout.tsx) invalidates this the moment an
    // application.created/application.stage_changed event arrives for this
    // job - this interval is just a reconciliation safety net in case a push
    // was ever missed, not the primary update path.
    refetchInterval: 120_000,
  });

  const transition = useMutation({
    mutationFn: ({ applicationId, toStageId, reason }: { applicationId: string; toStageId: string; reason?: string }) =>
      api.post(`/applications/${applicationId}/transition`, { toStageId, reason }),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ["applications", jobId] });
      const previous = queryClient.getQueryData<Page<Application>>(["applications", jobId]);
      queryClient.setQueryData<Page<Application>>(["applications", jobId], (old) =>
        old ? { ...old, items: old.items.map((a) => (a.id === vars.applicationId ? { ...a, currentStageId: vars.toStageId } : a)) } : old,
      );
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(["applications", jobId], context.previous);
      alert(err instanceof ApiError ? (err.detail ?? "That move isn't allowed.") : "That move isn't allowed.");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["applications", jobId] }),
  });

  const addStage = useMutation({
    mutationFn: (input: { name: string; kind: string; order: number; slaDays?: number }) => api.post(`/jobs/${jobId}/stages`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job", jobId] });
      setShowStageForm(false);
    },
  });

  // ASSUMPTIONS.md documented this as already built ("stages can be added
  // and their kind/name/SLA edited from the UI") - it wasn't; only adding a
  // stage was wired up, and even that form had no SLA field. PATCH
  // /jobs/:jobId/stages/:stageId already existed on the API with nothing in
  // the UI ever calling it.
  const updateStage = useMutation({
    mutationFn: ({ stageId, input }: { stageId: string; input: { name: string; kind: string; slaDays: number | null } }) =>
      api.patch(`/jobs/${jobId}/stages/${stageId}`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["job", jobId] }),
  });

  if (jobLoading) return <div className="text-slate-500">Loading…</div>;
  if (jobErrored || !job) {
    return (
      <div className="space-y-3">
        <button onClick={() => navigate("/app/jobs")} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-brand-600">
          <ArrowLeft className="h-3.5 w-3.5" /> All jobs
        </button>
        <p className="text-slate-500">This job couldn't be found.</p>
      </div>
    );
  }

  const appsByStage = new Map<string, Application[]>();
  for (const app of appsPage?.items ?? []) {
    const list = appsByStage.get(app.currentStageId) ?? [];
    list.push(app);
    appsByStage.set(app.currentStageId, list);
  }

  function onDrop(e: DragEvent, stage: JobStage) {
    e.preventDefault();
    const applicationId = e.dataTransfer.getData("text/plain");
    const app = appsPage?.items.find((a) => a.id === applicationId);
    if (!app || app.currentStageId === stage.id) return;

    let reason: string | undefined;
    if (stage.kind === "REJECTED") {
      reason = window.prompt("Reason for rejecting this candidate?") ?? undefined;
      if (!reason) return;
    }
    transition.mutate(
      { applicationId, toStageId: stage.id, reason },
      {
        // Reaching an INTERVIEW-kind stage and having an actual Interview
        // record scheduled are two separate things in this system - the
        // stage move alone puts nothing on the Interviews page, since
        // scheduling needs a real date/panelists a drag-and-drop can't
        // supply. Previously that gap was silent: nothing prompted for the
        // second step, so a candidate could sit in "Interview" indefinitely
        // with nothing to actually interview them against. This closes it
        // in one extra click instead of requiring a recruiter to remember
        // to separately visit the candidate's page.
        onSuccess: () => {
          if (stage.kind !== "INTERVIEW") return;
          const wantsToSchedule = window.confirm(
            `${app.candidate?.fullName ?? "This candidate"} is now in ${stage.name}. Schedule their interview now?`,
          );
          if (wantsToSchedule) navigate(`/app/candidates/${app.candidateId}?scheduleFor=${applicationId}`);
        },
      },
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <button onClick={() => navigate("/app/jobs")} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-brand-600">
          <ArrowLeft className="h-3.5 w-3.5" /> All jobs
        </button>
        <h1 className="mt-2 page-title">{job.title}</h1>
        <p className="text-sm text-slate-500">
          {[job.department, job.location].filter(Boolean).join(" · ")} · {job.status}
        </p>
      </div>

      <div className="overflow-x-auto pb-4">
        <div className="flex gap-4" style={{ minWidth: `${job.stages.length * 260}px` }}>
          {job.stages.map((stage) => (
            <div
              key={stage.id}
              onDragOver={isManager ? (e) => e.preventDefault() : undefined}
              onDrop={isManager ? (e) => onDrop(e, stage) : undefined}
              className="flex w-64 shrink-0 flex-col rounded-xl bg-slate-100/70 p-3"
            >
              <div className="mb-2 flex items-center justify-between px-1">
                <h3 className="text-sm font-semibold text-slate-700">{stage.name}</h3>
                <span className="badge-slate">{appsByStage.get(stage.id)?.length ?? 0}</span>
              </div>
              <div className="flex-1 space-y-2">
                {(appsByStage.get(stage.id) ?? []).map((app) => (
                  <div
                    key={app.id}
                    draggable={isManager}
                    onDragStart={isManager ? (e) => e.dataTransfer.setData("text/plain", app.id) : undefined}
                    onClick={() => navigate(`/app/candidates/${app.candidateId}`)}
                    className={`card p-3 text-sm transition-all hover:border-brand-300 hover:shadow-card ${isManager ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}`}
                  >
                    <p className="font-medium text-slate-900">{app.candidate?.fullName}</p>
                    <p className="text-xs text-slate-400">{app.source}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <StageEditor
        job={job}
        canEdit={isManager}
        onAdd={() => setShowStageForm((v) => !v)}
        showForm={showStageForm}
        onSubmit={(input) => addStage.mutate(input)}
        onUpdate={(stageId, input) => updateStage.mutate({ stageId, input })}
      />
    </div>
  );
}

const STAGE_KINDS = ["APPLIED", "SCREEN", "INTERVIEW", "OFFER", "HIRED", "REJECTED"];

function StageEditor({
  job,
  canEdit,
  showForm,
  onAdd,
  onSubmit,
  onUpdate,
}: {
  job: Job;
  canEdit: boolean;
  showForm: boolean;
  onAdd: () => void;
  onSubmit: (input: { name: string; kind: string; order: number; slaDays?: number }) => void;
  onUpdate: (stageId: string, input: { name: string; kind: string; slaDays: number | null }) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("INTERVIEW");
  const [slaDays, setSlaDays] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit({ name, kind, order: job.stages.length, slaDays: slaDays ? Number(slaDays) : undefined });
    setName("");
    setSlaDays("");
  }

  return (
    <div className="card-pad">
      <div className="flex items-center justify-between">
        <h2 className="section-title">Pipeline stages</h2>
        {canEdit && (
          <button onClick={onAdd} className="link-muted flex items-center gap-1 font-medium">
            {showForm ? "Cancel" : (
              <>
                <Plus className="h-3.5 w-3.5" /> Add stage
              </>
            )}
          </button>
        )}
      </div>
      {canEdit && showForm && (
        <form onSubmit={submit} className="mt-3 flex animate-fade-up flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-slate-500">Name</label>
            <input required value={name} onChange={(e) => setName(e.target.value)} className="input mt-1" />
          </div>
          <div>
            <label className="block text-xs text-slate-500">Kind</label>
            <select value={kind} onChange={(e) => setKind(e.target.value)} className="input mt-1">
              {STAGE_KINDS.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500">SLA days (optional)</label>
            <input
              type="number"
              min={1}
              max={365}
              value={slaDays}
              onChange={(e) => setSlaDays(e.target.value)}
              className="input mt-1 w-28"
            />
          </div>
          <button type="submit" className="btn-primary btn-sm">
            Add
          </button>
        </form>
      )}
      <ol className="mt-4 space-y-2 text-sm">
        {job.stages.map((s) =>
          canEdit && editingId === s.id ? (
            <li key={s.id} className="rounded-lg bg-slate-50 px-3 py-2">
              <StageEditForm
                stage={s}
                onCancel={() => setEditingId(null)}
                onSave={(input) => {
                  onUpdate(s.id, input);
                  setEditingId(null);
                }}
              />
            </li>
          ) : (
            <li key={s.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
              <span>
                <span className="font-medium text-slate-700">{s.order + 1}. {s.name}</span>
                <span className="ml-1 text-xs text-slate-400">({s.kind}{s.slaDays ? `, SLA ${s.slaDays}d` : ""})</span>
              </span>
              {canEdit && (
                <button onClick={() => setEditingId(s.id)} className="link-muted text-xs font-medium">
                  Edit
                </button>
              )}
            </li>
          ),
        )}
      </ol>
    </div>
  );
}

function StageEditForm({
  stage,
  onCancel,
  onSave,
}: {
  stage: JobStage;
  onCancel: () => void;
  onSave: (input: { name: string; kind: string; slaDays: number | null }) => void;
}) {
  const [name, setName] = useState(stage.name);
  const [kind, setKind] = useState<string>(stage.kind);
  const [slaDays, setSlaDays] = useState(stage.slaDays != null ? String(stage.slaDays) : "");

  function submit(e: FormEvent) {
    e.preventDefault();
    onSave({ name, kind, slaDays: slaDays ? Number(slaDays) : null });
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <input required value={name} onChange={(e) => setName(e.target.value)} className="input" />
      <select value={kind} onChange={(e) => setKind(e.target.value)} className="input w-auto">
        {STAGE_KINDS.map((k) => (
          <option key={k} value={k}>{k}</option>
        ))}
      </select>
      <input
        type="number"
        min={1}
        max={365}
        placeholder="SLA days"
        value={slaDays}
        onChange={(e) => setSlaDays(e.target.value)}
        className="input w-24"
      />
      <button type="submit" className="btn-primary btn-sm">
        Save
      </button>
      <button type="button" onClick={onCancel} className="btn-secondary btn-sm">
        Cancel
      </button>
    </form>
  );
}
