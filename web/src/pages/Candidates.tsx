import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Mail, Phone, Search } from "lucide-react";
import { api } from "../lib/api";
import type { Candidate, Page } from "../lib/types";

export default function Candidates() {
  const [q, setQ] = useState("");
  const [submittedQ, setSubmittedQ] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["candidates", submittedQ],
    queryFn: () =>
      api.get<Page<Candidate>>(`/candidates?limit=50${submittedQ ? `&q=${encodeURIComponent(submittedQ)}` : ""}`),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Candidates</h1>
        <p className="mt-1 text-sm text-slate-500">Search across every candidate in your org by name or email.</p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSubmittedQ(q.trim());
        }}
        className="flex max-w-md items-center gap-2"
      >
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name or email…"
            className="input pl-9"
          />
        </div>
        <button type="submit" className="btn-secondary btn-sm">
          Search
        </button>
      </form>

      <div className="card divide-y divide-slate-100">
        {isLoading && <p className="p-4 text-slate-400">Loading…</p>}
        {data?.items.map((candidate) => (
          <Link
            key={candidate.id}
            to={`/app/candidates/${candidate.id}`}
            className="flex items-center justify-between p-4 hover:bg-slate-50"
          >
            <div>
              <p className="font-medium text-slate-900">{candidate.fullName}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                <span className="flex items-center gap-1">
                  <Mail className="h-3 w-3" /> {candidate.email}
                </span>
                {candidate.phone && (
                  <span className="flex items-center gap-1">
                    <Phone className="h-3 w-3" /> {candidate.phone}
                  </span>
                )}
              </p>
            </div>
          </Link>
        ))}
        {data && data.items.length === 0 && (
          <p className="p-4 text-slate-500">
            {submittedQ ? `No candidates match "${submittedQ}".` : "No candidates yet."}
          </p>
        )}
      </div>
    </div>
  );
}
