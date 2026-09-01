import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { LayoutGrid, Mail } from "lucide-react";
import { candidateApi, ApiError } from "../lib/candidateApi";

export default function CandidateForgotPassword() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus("submitting");
    try {
      await candidateApi.post("/candidate-auth/forgot-password", { email });
      setStatus("done");
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
          {status === "done" ? (
            <div className="animate-fade-up py-2 text-center">
              <h1 className="text-xl font-semibold text-slate-900">Check your email</h1>
              <p className="mt-2 text-sm text-slate-500">
                If an account exists for that email, we've sent a link to reset your password. It expires in 30
                minutes.
              </p>
              <Link to="/candidate/login" className="btn-secondary btn-md mt-6 inline-flex">
                Back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="text-center">
                <h1 className="text-xl font-semibold text-slate-900">Reset your password</h1>
                <p className="mt-1 text-sm text-slate-500">We'll email you a link to set a new one</p>
              </div>

              {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

              <div>
                <label className="field-label">Email</label>
                <div className="relative mt-1">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="input pl-9"
                  />
                </div>
              </div>
              <button type="submit" disabled={status === "submitting"} className="btn-primary btn-md w-full">
                {status === "submitting" ? "Sending…" : "Send reset link"}
              </button>
              <p className="text-center text-xs text-slate-400">
                <Link to="/candidate/login" className="link-muted font-medium">
                  Back to sign in
                </Link>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
