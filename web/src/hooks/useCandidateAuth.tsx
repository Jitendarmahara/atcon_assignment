import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { candidateApi } from "../lib/candidateApi";

export interface CandidateAccount {
  id: string;
  email: string;
  fullName: string;
  createdAt: string;
}

interface CandidateAuthState {
  account: CandidateAccount | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (fullName: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const CandidateAuthContext = createContext<CandidateAuthState | null>(null);

export function CandidateAuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<CandidateAccount | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!candidateApi.getTokens()) {
      setLoading(false);
      return;
    }
    candidateApi
      .get<CandidateAccount>("/candidate-auth/me")
      .then(setAccount)
      .catch(() => candidateApi.setTokens(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(email: string, password: string) {
    const result = await candidateApi.post<{ account: CandidateAccount; accessToken: string; refreshToken: string }>(
      "/candidate-auth/login",
      { email, password },
    );
    candidateApi.setTokens({ accessToken: result.accessToken, refreshToken: result.refreshToken });
    setAccount(result.account);
  }

  async function register(fullName: string, email: string, password: string) {
    const result = await candidateApi.post<{ account: CandidateAccount; accessToken: string; refreshToken: string }>(
      "/candidate-auth/register",
      { fullName, email, password },
    );
    candidateApi.setTokens({ accessToken: result.accessToken, refreshToken: result.refreshToken });
    setAccount(result.account);
  }

  async function logout() {
    try {
      await candidateApi.post("/candidate-auth/logout");
    } catch {
      /* ignore - clearing local tokens below is what actually logs the user out client-side */
    }
    candidateApi.setTokens(null);
    setAccount(null);
  }

  return (
    <CandidateAuthContext.Provider value={{ account, loading, login, register, logout }}>
      {children}
    </CandidateAuthContext.Provider>
  );
}

export function useCandidateAuth(): CandidateAuthState {
  const ctx = useContext(CandidateAuthContext);
  if (!ctx) throw new Error("useCandidateAuth must be used within a CandidateAuthProvider");
  return ctx;
}
