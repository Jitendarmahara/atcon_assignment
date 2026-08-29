import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LayoutGrid, Lock, Mail } from "lucide-react";
import { useAuth } from "../hooks/useAuth";
import { ApiError } from "../lib/api";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("admin@acme-recruiting.test");
  const [password, setPassword] = useState("password123");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate("/app/dashboard");
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.message) : "Login failed");
    } finally {
      setSubmitting(false);
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

        <form onSubmit={onSubmit} className="card space-y-4 p-8">
          <div className="text-center">
            <h1 className="text-xl font-semibold text-slate-900">Welcome back</h1>
            <p className="mt-1 text-sm text-slate-500">Sign in to your recruiting workspace</p>
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
          <div>
            <label className="field-label">Password</label>
            <div className="relative mt-1">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input pl-9"
              />
            </div>
          </div>
          <button type="submit" disabled={submitting} className="btn-primary btn-md w-full">
            {submitting ? "Signing in…" : "Sign in"}
          </button>
          <p className="text-center text-xs text-slate-400">Seed demo: admin@acme-recruiting.test / password123</p>
        </form>
      </div>
    </div>
  );
}
