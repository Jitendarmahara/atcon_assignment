import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LayoutGrid, Lock, Mail, User } from "lucide-react";
import { useCandidateAuth } from "../hooks/useCandidateAuth";
import { ApiError } from "../lib/candidateApi";

export default function CandidateRegister() {
  const { register } = useCandidateAuth();
  const navigate = useNavigate();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await register(fullName, email, password);
      navigate("/candidate/dashboard");
    } catch (err) {
      setError(err instanceof ApiError ? (err.detail ?? err.message) : "Registration failed");
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
            <h1 className="text-xl font-semibold text-slate-900">Create your account</h1>
            <p className="mt-1 text-sm text-slate-500">
              Use the same email you applied with to see your existing applications too
            </p>
          </div>

          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          <div>
            <label className="field-label">Full name</label>
            <div className="relative mt-1">
              <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input required value={fullName} onChange={(e) => setFullName(e.target.value)} className="input pl-9" />
            </div>
          </div>
          <div>
            <label className="field-label">Email</label>
            <div className="relative mt-1">
              <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="input pl-9" />
            </div>
          </div>
          <div>
            <label className="field-label">Password</label>
            <div className="relative mt-1">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input pl-9"
              />
            </div>
            <p className="mt-1 text-xs text-slate-400">At least 8 characters</p>
          </div>
          <button type="submit" disabled={submitting} className="btn-primary btn-md w-full">
            {submitting ? "Creating account…" : "Create account"}
          </button>
          <p className="text-center text-xs text-slate-400">
            Already have an account?{" "}
            <Link to="/candidate/login" className="link-muted font-medium">
              Sign in
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
