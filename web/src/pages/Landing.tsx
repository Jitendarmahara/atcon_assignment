import { Link } from "react-router-dom";
import { BarChart3, CalendarCheck2, GitBranch, ScanSearch, Sparkles } from "lucide-react";

const features = [
  {
    icon: GitBranch,
    title: "Configurable pipeline",
    description: "Drag candidates through recruiter-defined stages with audited, concurrency-safe transitions.",
  },
  {
    icon: ScanSearch,
    title: "Smart deduplication",
    description: "Layered signal scoring catches repeat applicants across email, phone, and resume content.",
  },
  {
    icon: CalendarCheck2,
    title: "Interviews & scorecards",
    description: "Schedule panels, collect structured feedback, and keep every rating in one place.",
  },
  {
    icon: BarChart3,
    title: "Live pipeline analytics",
    description: "Time-to-hire, funnel conversion, and stale-candidate alerts computed straight from the data.",
  },
];

export default function Landing() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-slate-50">
      <div className="pointer-events-none absolute inset-0 bg-brand-mesh" />

      <div className="relative mx-auto flex max-w-5xl flex-col items-center px-6 pb-20 pt-24 text-center sm:pt-32">
        <span className="badge-brand animate-fade-up">
          <Sparkles className="h-3.5 w-3.5" />
          Applicant tracking, built for hiring teams that move fast
        </span>

        <h1 className="mt-6 animate-fade-up text-4xl font-bold tracking-tight text-slate-900 [animation-delay:80ms] sm:text-5xl">
          Hire the right people,
          <br />
          <span className="bg-brand-gradient bg-clip-text text-transparent">without the spreadsheet chaos</span>
        </h1>

        <p className="mt-5 max-w-xl animate-fade-up text-balance text-base text-slate-600 [animation-delay:160ms] sm:text-lg">
          Publish job openings, parse resumes automatically, move candidates through a pipeline your team controls,
          and see exactly where hiring is stalling.
        </p>

        <div className="mt-8 flex animate-fade-up flex-wrap items-center justify-center gap-3 [animation-delay:240ms]">
          <Link to="/login" className="btn-primary btn-md shadow-glow">
            Recruiter login
          </Link>
          <Link to="/candidate/login" className="btn-secondary btn-md">
            Browse jobs & track applications
          </Link>
        </div>

        <p className="mt-4 animate-fade-up text-xs text-slate-400 [animation-delay:320ms]">
          Seed login: <code className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">admin@acme-recruiting.test</code> /{" "}
          <code className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">password123</code>
        </p>

        <div className="mt-20 grid w-full animate-fade-up grid-cols-1 gap-4 [animation-delay:400ms] sm:grid-cols-2 lg:grid-cols-4">
          {features.map(({ icon: Icon, title, description }) => (
            <div key={title} className="card-pad card-hover text-left">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                <Icon className="h-5 w-5" />
              </div>
              <h3 className="mt-3 text-sm font-semibold text-slate-900">{title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-slate-500">{description}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
