import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { isConfigured, missingConfig } from "@/lib/supabase";

type Mode = "signin" | "signup";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="label flex items-baseline justify-between">
        {label}
        {hint ? <span className="label-ink normal-case tracking-normal">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

const inputClass =
  "num mt-1 w-full border border-line bg-canvas px-2 py-1.5 text-ink " +
  "placeholder:text-ink-faint focus:border-accent focus:outline-none";

const legalLink = "text-accent-dim underline underline-offset-2 hover:text-accent";

/**
 * The gate. Nothing else in the app renders until this passes.
 *
 * Sign-up asks for an invite code rather than an email confirmation: the club
 * hands the code out at a meeting, so a member is trading within seconds of
 * arriving and never waits on an inbox.
 */
export function Login() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<Mode>("signin");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [inviteCode, setInviteCode] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "signin") {
        await signIn(email, password);
      } else {
        await signUp({ email, password, displayName, inviteCode });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (!isConfigured) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas p-6">
        <div className="w-full max-w-lg border border-loss bg-panel">
          <div className="row flex items-center border-b border-loss px-3">
            <h1 className="label text-loss">Not configured</h1>
          </div>
          <div className="space-y-3 p-4">
            <p className="text-ink">
              The app cannot reach Supabase because{" "}
              {missingConfig.length === 1 ? "this variable is" : "these variables are"} missing
              from the build:
            </p>
            <ul className="num space-y-1 text-accent">
              {missingConfig.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
            <p className="text-ink-dim">
              Locally, set them in <span className="num text-ink">.env</span> and restart the dev
              server. On Cloudflare they must be <strong className="text-ink">build</strong>{" "}
              variables under Settings → Build, not runtime secrets — Vite reads them while
              bundling, so a runtime secret arrives too late to help.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-sm">
        <div className="mb-4">
          <h1 className="text-[0.6875rem] font-semibold tracking-[0.18em] text-accent uppercase">
            Finance Club Terminal
          </h1>
          <p className="mt-1 text-ink-dim">
            {mode === "signin"
              ? "Sign in to your portfolio."
              : "Create your portfolio. You will need the club invite code."}
          </p>
        </div>

        <div className="border border-line bg-panel">
          <div className="flex border-b border-line">
            {(["signin", "signup"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode(m);
                  setError(null);
                }}
                className={`row flex-1 border-r border-line last:border-r-0 ${
                  mode === m
                    ? "bg-accent-wash text-accent"
                    : "text-ink-dim hover:bg-panel-hi hover:text-ink"
                }`}
              >
                <span className="label" style={{ color: "inherit" }}>
                  {m === "signin" ? "Sign in" : "New member"}
                </span>
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="space-y-3 p-4">
            {mode === "signup" && (
              <Field label="Display name" hint="shown on the leaderboard">
                <input
                  className={inputClass}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={40}
                  required
                  autoComplete="name"
                  placeholder="Sunny A."
                />
              </Field>
            )}

            <Field label="Email">
              <input
                className={inputClass}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                placeholder="you@school.edu"
              />
            </Field>

            <Field
              label="Password"
              hint={mode === "signup" ? "8 characters minimum" : undefined}
            >
              <input
                className={inputClass}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={mode === "signup" ? 8 : undefined}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                placeholder="••••••••"
              />
            </Field>

            {mode === "signup" && (
              <Field label="Invite code" hint="from a club officer">
                <input
                  className={`${inputClass} uppercase`}
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  required
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="BULLS-2026"
                />
              </Field>
            )}

            {error && (
              <p role="alert" className="border border-loss bg-panel px-2 py-1.5 text-loss">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="row flex w-full items-center justify-center gap-2 border border-accent-dim bg-accent-wash text-accent transition-colors hover:bg-accent hover:text-black disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="label" style={{ color: "inherit" }}>
                {busy
                  ? "Working"
                  : mode === "signin"
                    ? "Sign in"
                    : "Create portfolio"}
              </span>
            </button>

            {/*
              Consent sits against the button that gives it, not in a footer
              under the panel. The second sentence is the one thing a new
              member would otherwise find out by being surprised.
            */}
            {mode === "signup" && (
              <p className="text-ink-faint">
                Creating a portfolio accepts the{" "}
                <Link to="/legal/terms" className={legalLink}>
                  terms of use
                </Link>{" "}
                and the{" "}
                <Link to="/legal/privacy" className={legalLink}>
                  privacy policy
                </Link>
                . Your display name and everything you trade are visible to the rest of the
                club.
              </p>
            )}
          </form>
        </div>

        <p className="mt-3 text-ink-faint">
          {mode === "signin" ? (
            <>
              No account yet? Choose <span className="text-ink-dim">New member</span> above.{" "}
              <Link to="/legal/terms" className={legalLink}>
                Terms
              </Link>{" "}
              and{" "}
              <Link to="/legal/privacy" className={legalLink}>
                privacy
              </Link>
              .
            </>
          ) : (
            <>Your starting cash is set by the club officer who opened the season.</>
          )}
        </p>
      </div>
    </div>
  );
}
