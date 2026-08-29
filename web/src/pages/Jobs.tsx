import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Plus, X } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { canManage, type Job, type Page } from "../lib/types";

const STATUS_BADGE: Record<Job["status"], string> = {
  PUBLISHED: "badge-green",
  CLOSED: "badge-slate",
  DRAFT: "badge-amber",
};

export default function Jobs() {
  const { user } = useAuth();
  const isManager = canManage(user?.role);
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["jobs"], queryFn: () => api.get<Page<Job>>("/jobs?limit=50") });
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [department, setDepartment] = useState("");
  const [location, setLocation] = useState("");

  const createJob = useMutation({
    mutationFn: () => api.post<Job>("/jobs", { title, description, department: department || undefined, location: location || undefined }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      setShowForm(false);
      setTitle("");
      setDescription("");
      setDepartment("");
      setLocation("");
    },
  });

  const publishJob = useMutation({
    mutationFn: (jobId: string) => api.post(`/jobs/${jobId}/publish`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    createJob.mutate();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="page-title">Jobs</h1>
          {user?.orgSlug && (
            <a
              href={`/public/${user.orgSlug}`}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-sm text-brand-600 hover:underline"
            >
              View your public careers page <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        {isManager && (
          <button onClick={() => setShowForm((v) => !v)} className={showForm ? "btn-secondary btn-sm" : "btn-primary btn-sm"}>
            {showForm ? (
              <>
                <X className="h-3.5 w-3.5" /> Cancel
              </>
            ) : (
              <>
                <Plus className="h-3.5 w-3.5" /> New job
              </>
            )}
          </button>
        )}
      </div>

      {isManager && showForm && (
        <form onSubmit={onSubmit} className="card-pad animate-fade-up space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="field-label">Title</label>
              <input required value={title} onChange={(e) => setTitle(e.target.value)} className="input mt-1" />
            </div>
            <div>
              <label className="field-label">Department</label>
              <input value={department} onChange={(e) => setDepartment(e.target.value)} className="input mt-1" />
            </div>
            <div>
              <label className="field-label">Location</label>
              <input value={location} onChange={(e) => setLocation(e.target.value)} className="input mt-1" />
            </div>
          </div>
          <div>
            <label className="field-label">Description</label>
            <textarea required value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="input mt-1" />
          </div>
          <button type="submit" disabled={createJob.isPending} className="btn-primary btn-md">
            {createJob.isPending ? "Creating…" : "Create job (seeds default pipeline)"}
          </button>
        </form>
      )}

      <div className="card divide-y divide-slate-100">
        {data?.items.map((job) => (
          <div key={job.id} className="flex items-center justify-between p-4">
            <div>
              <Link to={`/app/jobs/${job.id}`} className="font-medium text-slate-900 hover:text-brand-600">
                {job.title}
              </Link>
              <p className="text-sm text-slate-500">{[job.department, job.location].filter(Boolean).join(" · ")}</p>
            </div>
            <div className="flex items-center gap-3">
              <span className={STATUS_BADGE[job.status]}>{job.status}</span>
              {isManager && job.status === "DRAFT" && (
                <button onClick={() => publishJob.mutate(job.id)} className="link-muted font-medium">
                  Publish
                </button>
              )}
            </div>
          </div>
        ))}
        {data?.items.length === 0 && <p className="p-4 text-slate-500">No jobs yet.</p>}
      </div>
    </div>
  );
}
