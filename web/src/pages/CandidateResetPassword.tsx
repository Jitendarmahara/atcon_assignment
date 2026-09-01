import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { LayoutGrid, Lock } from "lucide-react";
import { candidateApi, ApiError } from "../lib/candidateApi";

export default function CandidateResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const [newPassword, setNewPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus("submitting");
    try {
      await candidateApi.post("/candidate-auth/reset-password", { token, newPassword });
      setStatus("done");
      setTimeout(() => navigate("/candidate/login"), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.message) : "Something went wrong");
      setStatus("idle");
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-50 px-4">
      <div className="pointer-events-none absolute inset-0 bg-brand-mesh" />

      <div className="relative w-full max-w-sm animate-fade-up">
        <Link to="/" className="mb-6 flex items-center justify-center gap-2 text-slate-900">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-gradient text-white shadow-glow">
            <LayoutGrid className="h-5 w-5" />
          </span>
          <span className="text-lg font-semibold tracking-tight">ATS</span>
        </Link>

        <div className="card space-y-4 p-8">
          {!token ? (
            <p className="text-center text-sm text-red-700">
              This link is missing its reset token. Request a new one from the{" "}
              <Link to="/candidate/forgot-password" className="link-muted font-medium">
                forgot password
              </Link>{" "}
              page.
            </p>
          ) : status === "done" ? (
            <div className="animate-fade-up py-2 text-center">
              <h1 className="text-xl font-semibold text-slate-900">Password updated</h1>
              <p className="mt-2 text-sm text-slate-500">Redirecting you to sign in…</p>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="text-center">
                <h1 className="text-xl font-semibold text-slate-900">Set a new password</h1>
              </div>

              {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

              <div>
                <label className="field-label">New password</label>
                <div className="relative mt-1">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="input pl-9"
                  />
                </div>
                <p className="mt-1 text-xs text-slate-400">At least 8 characters</p>
              </div>
              <button type="submit" disabled={status === "submitting"} className="btn-primary btn-md w-full">
                {status === "submitting" ? "Updating…" : "Update password"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
