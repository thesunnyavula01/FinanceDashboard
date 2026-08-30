/**
 * Typed client for the Worker API.
 *
 * Everything the browser needs comes through /api/*. The client never talks to
 * Alpaca, Finnhub, or the database directly — those need secrets, and secrets
 * stay in the Worker.
 */

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `Request failed (${response.status})`, response.status);
  }

  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<HealthResponse>("/health"),
};
