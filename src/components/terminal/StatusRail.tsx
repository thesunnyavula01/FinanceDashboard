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

  /*
    On a phone this rail has one job and it is the session state. The app name
    is on the tab, the member knows who they are, and the ET clock is a second
    clock next to the one in the status bar an inch above it — so those three
    give up their width in that order as the screen narrows, and the amber dot
    and its label keep theirs at every size. A member about to be told "market
    closed" has to be able to see it before they type, and that is as true at
    390px as at 1440.
  */
  return (
    <div className="row pad-safe-top pad-safe-x flex shrink-0 items-center justify-between gap-2 border-b border-line bg-panel px-3">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-[0.6875rem] font-semibold tracking-[0.18em] text-accent uppercase">
          {appName}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-2 sm:gap-4">
        {!connected && (
          <span className="label text-loss">
            {/* Two words on a phone, the sentence on a desktop: the fact that
                matters is "offline", and "reconnecting" is the reassurance. */}
            Offline<span className="hidden sm:inline"> — reconnecting</span>
          </span>
        )}

        <span className="flex items-center gap-1.5">
          <span
            className={`inline-block size-1.5 shrink-0 rounded-full ${style.dot} ${
              session === "OPEN" ? "pulse-dot" : ""
            }`}
            aria-hidden="true"
          />
          <span className={`label ${style.text}`}>{sessionLabel}</span>
          {!authoritative && (
            <span
              // Hidden below sm rather than shortened. Abbreviating a caveat
              // is how a caveat stops being read, and the dot beside it is
              // still telling the truth about the session either way.
              className="label label-ink hidden sm:inline"
              // Not "(est)": sitting beside an ET clock, that reads as a
              // timezone rather than as "this status is a guess".
              title="The exchange calendar is unreachable, so this is estimated from New York trading hours and does not know about holidays."
            >
              Estimated
            </span>
          )}
        </span>

        <span className="num hidden text-[0.6875rem] text-ink-dim sm:inline">
          {now} <span className="text-ink-faint">ET</span>
        </span>

        {displayName && (
          <span className="flex items-center gap-2 border-line pl-0 sm:border-l sm:pl-4">
            <span className="hidden max-w-[10rem] truncate text-ink-dim md:inline">
              {displayName}
              {role === "admin" && <span className="label ml-1.5 text-accent">Admin</span>}
            </span>
            {onSignOut && (
              <button
                type="button"
                onClick={onSignOut}
                className="label cursor-pointer whitespace-nowrap hover:text-accent"
              >
                {/* "Sign out" is two words wide and the rail is the one strip
                    that cannot wrap. On a phone the verb carries it. */}
                <span className="sm:hidden">Exit</span>
                <span className="hidden sm:inline">Sign out</span>
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
