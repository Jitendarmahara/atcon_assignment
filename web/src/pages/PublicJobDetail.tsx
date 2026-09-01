import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, MapPin, PartyPopper, UploadCloud } from "lucide-react";
import { api, ApiError } from "../lib/api";

interface PublicJob {
  id: string;
  title: string;
  description: string;
  department: string | null;
  location: string | null;
  employmentType: string;
}

export default function PublicJobDetail() {
  const { orgSlug, jobSlug } = useParams<{ orgSlug: string; jobSlug: string }>();
  const { data: job, isLoading } = useQuery({
    queryKey: ["public-job", orgSlug, jobSlug],
    queryFn: () => api.get<PublicJob>(`/public/orgs/${orgSlug}/jobs/${jobSlug}`),
  });

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [resume, setResume] = useState<File | null>(null);
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus("submitting");
    setErrorMessage(null);
    try {
      const form = new FormData();
      form.set("fullName", fullName);
      form.set("email", email);
      if (phone) form.set("phone", phone);
      if (resume) form.set("resume", resume);
      await api.post(`/public/orgs/${orgSlug}/jobs/${jobSlug}/apply`, form);
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof ApiError ? (err.detail ?? err.message) : "Something went wrong");
    }
  }

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12">
        <div className="h-6 w-40 animate-pulse rounded bg-slate-200" />
        <div className="mt-4 h-8 w-72 animate-pulse rounded bg-slate-200" />
      </div>
    );
  }
  if (!job) return <div className="p-12 text-red-600">Job not found.</div>;

  return (
    <div className="min-h-screen bg-slate-50 pb-16">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <Link to={`/public/${orgSlug}`} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-brand-600">
          <ArrowLeft className="h-3.5 w-3.5" />
          All open roles
        </Link>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{job.title}</h1>
          <span className="badge-brand">{job.employmentType.replace("_", " ")}</span>
        </div>
        {(job.department || job.location) && (
          <p className="mt-2 flex items-center gap-1 text-sm text-slate-500">
            <MapPin className="h-3.5 w-3.5" />
            {[job.department, job.location].filter(Boolean).join(" · ")}
          </p>
        )}
        <p className="mt-6 whitespace-pre-line leading-relaxed text-slate-700">{job.description}</p>

        <div className="mt-10 card p-6">
          {status === "done" ? (
            <div className="animate-fade-up py-4 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                <PartyPopper className="h-6 w-6" />
              </div>
              <h2 className="mt-4 text-lg font-semibold text-slate-900">Application received!</h2>
              <p className="mt-1.5 text-sm text-slate-500">
                We'll parse your resume and be in touch soon. Check your email for a confirmation.
              </p>
              <Link to="/candidate/register" className="btn-secondary btn-sm mt-4 inline-flex">
                Create an account to track your status
              </Link>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <h2 className="section-title">Apply for this role</h2>
              {errorMessage && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</p>}
              <div>
                <label className="field-label">Full name</label>
                <input
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="input mt-1"
                />
              </div>
              <div>
                <label className="field-label">Email</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="input mt-1"
                />
              </div>
              <div>
                <label className="field-label">Phone (optional)</label>
                <input value={phone} onChange={(e) => setPhone(e.target.value)} className="input mt-1" />
              </div>
              <div>
                <label className="field-label">Resume (PDF or DOCX)</label>
                <label className="mt-1 flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-500 transition-colors hover:border-brand-400 hover:bg-brand-50/40">
                  {resume ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                  ) : (
                    <UploadCloud className="h-4 w-4 shrink-0 text-slate-400" />
                  )}
                  <span className="truncate">{resume ? resume.name : "Click to choose a file"}</span>
                  <input
                    type="file"
                    accept=".pdf,.docx"
                    onChange={(e) => setResume(e.target.files?.[0] ?? null)}
                    className="hidden"
                  />
                </label>
              </div>
              <button type="submit" disabled={status === "submitting"} className="btn-primary btn-md w-full">
                {status === "submitting" ? "Submitting…" : "Submit application"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
