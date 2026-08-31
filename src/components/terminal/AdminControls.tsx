import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The console's controls.
 *
 * One idea runs through all of them: an action that cannot be undone is
 * *disarmed* until the officer says so twice. A void replays somebody's whole
 * season and a reset deletes it, and both sit one row away from a button that
 * merely renames a season — so the dangerous ones announce themselves in the
 * only vocabulary this interface has, which is a second deliberate press.
 *
 * There are no modals. A dialog that covers the screen hides the row being
 * acted on, which is the one thing an officer wants to keep looking at while
 * they decide.
 */

/** A labelled input, in the terminal's field idiom. */
export function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  prefix,
  hint,
  numeric = false,
  disabled = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** A leading glyph inside the box, e.g. `$`. */
  prefix?: string;
  hint?: ReactNode;
  /** Restricts input to digits and a decimal point. */
  numeric?: boolean;
  disabled?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="label mb-1 block">
        {label}
      </label>
      <div className="flex items-center border border-line bg-canvas focus-within:border-accent">
        {prefix && <span className="num pl-2 text-ink-faint">{prefix}</span>}
        <input
          id={id}
          value={value}
          onChange={(event) =>
            onChange(numeric ? event.target.value.replace(/[^0-9.]/g, "") : event.target.value)
          }
          inputMode={numeric ? "decimal" : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          disabled={disabled}
          className={`w-full bg-transparent px-2 py-1.5 text-ink placeholder:text-ink-faint focus:outline-none disabled:text-ink-faint ${
            numeric ? "num" : ""
          }`}
        />
      </div>
      {hint ? <p className="mt-1 text-[0.6875rem] text-ink-faint">{hint}</p> : null}
    </div>
  );
}

/** An ordinary, reversible action. Locking trading, renaming a season. */
export function ActionButton({
  children,
  onClick,
  disabled = false,
  pending = false,
  tone = "default",
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  pending?: boolean;
  tone?: "default" | "accent";
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || pending}
      title={title}
      className={`row inline-flex cursor-pointer items-center justify-center gap-2 border px-3 font-medium uppercase tracking-[0.12em] transition-colors disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-ink-faint ${
        tone === "accent"
          ? "border-accent-dim bg-accent-wash text-accent hover:border-accent hover:bg-accent hover:text-black"
          : "border-line bg-panel-hi text-ink hover:border-accent hover:text-accent"
      }`}
    >
      <span className="text-[0.625rem]">{pending ? "Working" : children}</span>
    </button>
  );
}

/**
 * An action that cannot be undone.
 *
 * The first press arms it and nothing has happened yet; the second one runs.
 * It disarms itself after eight seconds, so an officer who walked away does not
 * leave a loaded button behind on a shared laptop.
 */
export function ArmedButton({
  label,
  armedLabel,
  onConfirm,
  disabled = false,
  pending = false,
}: {
  label: string;
  /** What the button says once it is armed. Name the consequence, not "OK". */
  armedLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  pending?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!armed) return;
    timer.current = setTimeout(() => setArmed(false), 8_000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [armed]);

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        disabled={disabled || pending}
        className="row inline-flex cursor-pointer items-center justify-center border border-line bg-panel-hi px-3 text-[0.625rem] font-medium uppercase tracking-[0.12em] text-ink-dim transition-colors hover:border-loss hover:text-loss disabled:cursor-not-allowed disabled:border-line disabled:text-ink-faint"
      >
        {pending ? "Working" : label}
      </button>
    );
  }

  return (
    <span className="inline-flex items-stretch gap-1">
      <button
        type="button"
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
        disabled={pending}
        className="row inline-flex cursor-pointer items-center justify-center border border-loss bg-loss px-3 text-[0.625rem] font-medium uppercase tracking-[0.12em] text-black transition-colors hover:brightness-110 disabled:cursor-not-allowed"
      >
        {armedLabel}
      </button>
      <button
        type="button"
        onClick={() => setArmed(false)}
        className="row inline-flex cursor-pointer items-center justify-center border border-line px-2 text-[0.625rem] uppercase tracking-[0.12em] text-ink-dim hover:border-accent hover:text-accent"
      >
        Keep
      </button>
    </span>
  );
}

export interface Outcome {
  tone: "ok" | "error";
  text: string;
}

/**
 * What just happened, in one line under the control that did it.
 *
 * Success says what changed and by how much, because "Saved" leaves an officer
 * checking the members list to find out whether it worked. A failure is the
 * server's own sentence: those are written for a person to read and are more
 * specific than anything this component could substitute.
 */
export function Feedback({ outcome }: { outcome: Outcome | null }) {
  if (!outcome) return null;

  return (
    <p
      role="status"
      className={`text-[0.6875rem] ${outcome.tone === "error" ? "text-loss" : "text-gain"}`}
    >
      {outcome.text}
    </p>
  );
}

/** A label/value line, for the read-only facts above a panel's controls. */
export function Readout({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/60 py-1 last:border-b-0">
      <span className="label">{label}</span>
      <span className="min-w-0 truncate text-right text-ink">{children}</span>
    </div>
  );
}
