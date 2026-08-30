/**
 * Typed client for the Worker API.
 *
 * Everything the browser needs comes through /api/*. The client never talks to
 * Alpaca, Finnhub, or the database directly — those need secrets, and secrets
 * stay in the Worker.
 */

import { accessToken } from "./supabase";

export type SessionState = "OPEN" | "CLOSED" | "PRE" | "POST";

export interface HealthResponse {
  ok: boolean;
  app: string;
  phase: number;
  serverTime: string;
  session: {
    state: SessionState;
    label: string;
    /**
     * False while the session is estimated from New York clock hours. Phase 3
     * swaps in Alpaca's market clock, which knows holidays and half-days, and
     * flips this to true.
     */
    authoritative: boolean;
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface MeResponse {
  id: string;
  email: string | null;
  displayName: string;
  role: "member" | "admin";
  portfolio: {
    id: string;
    cash: string;
    season_id: string;
    seasons: {
      name: string;
      starting_cash: string;
      trading_locked: boolean;
      is_active: boolean;
    } | null;
  } | null;
}

interface RequestOptions extends RequestInit {
  /** Attach the current session token. Required by every route behind auth. */
  authed?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { authed, ...init } = options;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };

  if (authed) {
    const token = await accessToken();
    if (!token) throw new ApiError("Sign in to continue.", 401);
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`/api${path}`, { ...init, headers });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `Request failed (${response.status})`, response.status);
  }

  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<HealthResponse>("/health"),
  me: () => request<MeResponse>("/auth/me", { authed: true }),
};
