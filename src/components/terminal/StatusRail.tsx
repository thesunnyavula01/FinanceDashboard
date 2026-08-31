import { useEffect, useState } from "react";
import { clockET } from "@/lib/format";
import type { SessionState } from "@/lib/api";

const SESSION_STYLE: Record<SessionState, { dot: string; text: string }> = {
  OPEN: { dot: "bg-gain", text: "text-gain" },
  PRE: { dot: "bg-accent", text: "text-accent" },
  POST: { dot: "bg-accent", text: "text-accent" },
  CLOSED: { dot: "bg-ink-faint", text: "text-ink-dim" },
};

interface StatusRailProps {
  appName: string;
  session: SessionState;
  sessionLabel: string;
  /**
   * False when Alpaca's exchange calendar could not be reached and the state
   * is a guess from New York clock hours.
   */
  authoritative: boolean;
  connected: boolean;
  displayName?: string;
  role?: "member" | "admin";
  onSignOut?: () => void;
}

/**
 * Top rail: who we are, whether the market is open, and what time it is in New
 * York. Session state lives here permanently because this app refuses orders
 * outside market hours — a member who is about to be told "market closed"
 * should be able to see that before they type, not after.
 */
export function StatusRail({
  appName,
  session,
  sessionLabel,
  authoritative,
  connected,
  displayName,
  role,
  onSignOut,
}: StatusRailProps) {
  const [now, setNow] = useState(() => clockET());

  useEffect(() => {
    const id = setInterval(() => setNow(clockET()), 1000);
    return () => clearInterval(id);
  }, []);

  const style = SESSION_STYLE[session];

  return (
    <div className="row flex shrink-0 items-center justify-between border-b border-line bg-panel px-3">
      <div className="flex items-baseline gap-2">
        <span className="text-[0.6875rem] font-semibold tracking-[0.18em] text-accent uppercase">
          {appName}
        </span>
      </div>

      <div className="flex items-center gap-4">
        {!connected && (
          <span className="label text-loss">Offline — reconnecting</span>
        )}

        <span className="flex items-center gap-1.5">
          <span
            className={`inline-block size-1.5 rounded-full ${style.dot} ${
              session === "OPEN" ? "pulse-dot" : ""
            }`}
            aria-hidden="true"
          />
          <span className={`label ${style.text}`}>{sessionLabel}</span>
          {!authoritative && (
            <span
              className="label label-ink"
              // Not "(est)": sitting beside an ET clock, that reads as a
              // timezone rather than as "this status is a guess".
              title="The exchange calendar is unreachable, so this is estimated from New York trading hours and does not know about holidays."
            >
              Estimated
            </span>
          )}
        </span>

        <span className="num text-ink-dim text-[0.6875rem]">
          {now} <span className="text-ink-faint">ET</span>
        </span>

        {displayName && (
          <span className="flex items-center gap-2 border-l border-line pl-4">
            <span className="text-ink-dim">
              {displayName}
              {role === "admin" && <span className="label ml-1.5 text-accent">Admin</span>}
            </span>
            {onSignOut && (
              <button
                type="button"
                onClick={onSignOut}
                className="label cursor-pointer hover:text-accent"
              >
                Sign out
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
