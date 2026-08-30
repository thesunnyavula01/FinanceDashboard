import { Panel } from "./Panel";

interface PhaseStubProps {
  title: string;
  phase: number;
  /** What this screen will do once it is built. */
  summary: string;
  /** The concrete pieces, so the placeholder doubles as the spec. */
  items: string[];
}

/**
 * Placeholder for a screen the build has not reached yet.
 *
 * It states the phase and lists what will land there, so an unfinished screen
 * still tells the reader something true instead of showing an apology.
 */
export function PhaseStub({ title, phase, summary, items }: PhaseStubProps) {
  return (
    <div className="p-2.5">
      <Panel title={title} meta={`Phase ${phase}`}>
        <p className="max-w-prose text-ink-dim">{summary}</p>
        <ul className="mt-3 space-y-1.5">
          {items.map((item) => (
            <li key={item} className="flex gap-2">
              <span className="num text-accent-dim" aria-hidden="true">
                —
              </span>
              <span className="text-ink">{item}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
