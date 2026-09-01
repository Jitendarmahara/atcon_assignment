import { Navigate } from "react-router-dom";
import { useCandidateAuth } from "../hooks/useCandidateAuth";

export default function CandidateProtectedRoute({ children }: { children: React.ReactNode }) {
  const { account, loading } = useCandidateAuth();
  if (loading) return <div className="p-8 text-slate-500">Loading…</div>;
  if (!account) return <Navigate to="/candidate/login" replace />;
  return <>{children}</>;
}
