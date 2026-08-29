import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Bell, Briefcase, Copy, LayoutDashboard, LayoutGrid, LogOut, UserSearch, Users } from "lucide-react";
import { useAuth } from "../hooks/useAuth";
import { useRealtime } from "../hooks/useRealtime";
import { api } from "../lib/api";
import { canManage, type Notification, type Page } from "../lib/types";

const navItems = [
  { to: "/app/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/app/jobs", label: "Jobs", icon: Briefcase },
  { to: "/app/candidates", label: "Candidates", icon: UserSearch },
  // GET /api/v1/duplicates requires ADMIN/RECRUITER/HIRING_MANAGER
  // (server/src/modules/duplicates/routes.ts) - hidden below for an
  // INTERVIEWER rather than linking to a page that 403s on load.
  { to: "/app/duplicates", label: "Duplicates", icon: Copy, managersOnly: true },
  { to: "/app/interviews", label: "Interviews", icon: Users },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  useRealtime(!!user);
  const visibleNavItems = navItems.filter((item) => !item.managersOnly || canManage(user?.role));

  const { data: notifications } = useQuery({
    queryKey: ["notifications", "unread"],
    queryFn: () => api.get<Page<Notification>>("/notifications?unreadOnly=true&limit=10"),
    // A reconciliation safety net, not the primary update path anymore -
    // useRealtime() above invalidates this the moment a notification.created
    // event arrives. Kept at a long interval in case a push was ever missed
    // (a brief SSE disconnect, a dropped Redis message) rather than trusting
    // push alone to never lose one.
    refetchInterval: 120_000,
  });
  const unreadCount = notifications?.items.length ?? 0;

  const initials = (user?.name ?? "?")
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-10 border-b border-slate-200/80 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-8">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-gradient text-white shadow-soft">
                <LayoutGrid className="h-4 w-4" />
              </span>
              <span className="text-base font-semibold tracking-tight text-slate-900">ATS</span>
            </div>
            <nav className="flex gap-1">
              {visibleNavItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                      isActive ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                    }`
                  }
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate("/app/notifications")}
              className="relative rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
              title="Notifications"
            >
              <Bell className="h-4 w-4" />
              {unreadCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white ring-2 ring-white">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </button>
            <div className="mx-1 h-6 w-px bg-slate-200" />
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">
                {initials}
              </span>
              <div className="hidden text-sm leading-tight sm:block">
                <p className="font-medium text-slate-800">{user?.name}</p>
                <p className="text-xs capitalize text-slate-400">{user?.role.toLowerCase().replace("_", " ")}</p>
              </div>
            </div>
            <button
              onClick={logout}
              className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-900"
              title="Log out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
