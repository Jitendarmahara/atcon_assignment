// Deliberately separate from lib/api.ts, not a config flag on it: a
// candidate session and a recruiter session are two different identities
// that can coexist in the same browser (a hiring manager checking their own
// application status, say) - different localStorage key, different token
// endpoints, different redirect-on-expired-session target. Mirrors
// lib/api.ts's shape exactly otherwise, so the two stay easy to compare.
const API_BASE = "/api/v1";

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const STORAGE_KEY = "ats_candidate_tokens";

function getTokens(): TokenPair | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TokenPair;
  } catch {
    return null;
  }
}

function setTokens(tokens: TokenPair | null) {
  if (tokens) localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
  else localStorage.removeItem(STORAGE_KEY);
}

export class ApiError extends Error {
  status: number;
  detail?: string;
  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function tryRefresh(refreshToken: string): Promise<TokenPair | null> {
  try {
    const res = await fetch(`${API_BASE}/candidate-auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    return (await res.json()) as TokenPair;
  } catch {
    return null;
  }
}

async function request<T>(path: string, options: RequestInit = {}, allowRefresh = true): Promise<T> {
  const tokens = getTokens();
  const headers = new Headers(options.headers);
  const isFormData = options.body instanceof FormData;
  if (!isFormData && options.body) headers.set("Content-Type", "application/json");
  if (tokens?.accessToken) headers.set("Authorization", `Bearer ${tokens.accessToken}`);

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401 && tokens?.refreshToken && allowRefresh) {
    const refreshed = await tryRefresh(tokens.refreshToken);
    if (refreshed) {
      setTokens(refreshed);
      return request<T>(path, options, false);
    }
    setTokens(null);
    window.location.assign("/candidate/login");
    throw new ApiError(401, "Session expired");
  }

  if (!res.ok) {
    let body: { title?: string; detail?: string } = {};
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, body.title ?? res.statusText, body.detail);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const candidateApi = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined }),
  getTokens,
  setTokens,
};
