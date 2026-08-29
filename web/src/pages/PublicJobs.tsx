import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Briefcase, MapPin } from "lucide-react";
import { api } from "../lib/api";

interface PublicJob {
  id: string;
  title: string;
  description: string;
  department: string | null;
  location: string | null;
  employmentType: string;
  publicSlug: string;
  publishedAt: string;
}

export default function PublicJobs() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ["public-jobs", orgSlug],
    queryFn: () => api.get<{ items: PublicJob[] }>(`/public/orgs/${orgSlug}/jobs`),
  });

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="relative overflow-hidden border-b border-slate-200 bg-white">
        <div className="pointer-events-none absolute inset-0 bg-brand-mesh" />
        <div className="relative mx-auto max-w-3xl px-6 py-16 text-center">
          <span className="badge-brand">Careers</span>
          <h1 className="mt-4 text-3xl font-bold tracking-tight text-slate-900">Open roles at {orgSlug}</h1>
          <p className="mt-2 text-slate-500">Find where you fit — every role below is actively hiring.</p>
        </div>
      </div>

      <div className="mx-auto max-w-3xl px-6 py-12">
        {isLoading && (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="card-pad h-24 animate-pulse bg-slate-100" />
            ))}
          </div>
        )}
        {error && (
          <p className="rounded-lg bg-red-50 px-4 py-3 text-red-700">Couldn't load jobs for this organization.</p>
        )}

        <div className="space-y-3">
          {data?.items.map((job) => (
            <Link
              key={job.id}
              to={`/public/${orgSlug}/${job.publicSlug}`}
              className="card-pad card-hover group flex items-center justify-between gap-4"
            >
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-semibold text-slate-900 group-hover:text-brand-700">{job.title}</h2>
                  <span className="badge-slate">{job.employmentType.replace("_", " ")}</span>
                </div>
                <p className="mt-1.5 flex items-center gap-3 text-sm text-slate-500">
                  {job.department && (
                    <span className="flex items-center gap-1">
                      <Briefcase className="h-3.5 w-3.5" />
                      {job.department}
                    </span>
                  )}
                  {job.location && (
                    <span className="flex items-center gap-1">
                      <MapPin className="h-3.5 w-3.5" />
                      {job.location}
                    </span>
                  )}
                </p>
              </div>
              <ArrowRight className="h-4 w-4 shrink-0 text-slate-300 transition-all group-hover:translate-x-0.5 group-hover:text-brand-500" />
            </Link>
          ))}
          {data && data.items.length === 0 && (
            <p className="card-pad text-center text-slate-500">No open roles right now — check back soon.</p>
          )}
        </div>
      </div>
    </div>
  );
}
