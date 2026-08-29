import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import type { CurrentUser } from "../lib/types";

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!api.getTokens()) {
      setLoading(false);
      return;
    }
    api
      .get<CurrentUser>("/auth/me")
      .then(setUser)
      .catch(() => api.setTokens(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(email: string, password: string) {
    const result = await api.post<{ user: CurrentUser; accessToken: string; refreshToken: string }>("/auth/login", {
      email,
      password,
    });
    api.setTokens({ accessToken: result.accessToken, refreshToken: result.refreshToken });
    setUser(result.user);
  }

  async function logout() {
    // Best-effort: revoke the refresh token server-side (so it can't be
    // replayed even if it leaked), but always clear local state regardless -
    // a network hiccup shouldn't strand the user in a logged-in-looking UI.
    try {
      await api.post("/auth/logout");
    } catch {
      /* ignore - clearing local tokens below is what actually logs the user out client-side */
    }
    api.setTokens(null);
    setUser(null);
  }

  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
