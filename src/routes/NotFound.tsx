import { Link } from "react-router-dom";
import { Panel } from "@/components/terminal/Panel";

export function NotFound() {
  return (
    <div className="p-2.5">
      <Panel title="No such screen" meta="404">
        <p className="text-ink-dim">
          That address does not match a screen. Press{" "}
          <span className="keycap">F1</span> for positions, or{" "}
          <span className="text-accent-dim num">/</span> to open the command bar.
        </p>
        <Link to="/" className="mt-3 inline-block text-accent underline underline-offset-2">
          Back to positions
        </Link>
      </Panel>
    </div>
  );
}
