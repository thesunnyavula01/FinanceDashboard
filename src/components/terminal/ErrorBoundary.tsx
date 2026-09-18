import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The screen that fails instead of the terminal.
 *
 * React unmounts the entire tree when a render throws and nothing catches it,
 * so before this existed one bad field in one API payload took the status rail,
 * the function keys and the command bar down with the panel that read it — a
 * black page with no way back. That is the worst possible shape for this
 * failure: a member cannot tell it from the app being down, cannot navigate to
 * a screen that still works, and has nothing to report but "it crashed".
 *
 * So the boundary sits *inside* the shell rather than around it. The chrome
 * survives, the other function keys still work, and the broken screen says so
 * in the app's own voice. `RETRY` re-mounts the subtree, which is enough
 * whenever the cause was a single bad poll; the navigation keys are the way out
 * when it is not.
 *
 * It is keyed on the route in `App`, so walking to another screen clears the
 * error rather than carrying it — a boundary that stayed tripped after the
 * member navigated away would look exactly like the crash it replaced.
 */
interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is the only reporting this app has, and the component stack
    // is the half of the story the message does not carry.
    console.error("Screen failed to render:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md">
          <div className="label text-loss">This screen stopped drawing</div>
          <p className="mt-2 text-ink-dim">
            Something in the data behind this screen was not what it expected. The rest of the
            terminal is unaffected — the function keys above still work.
          </p>
          <p className="num mt-2 text-ink-faint">{error.message}</p>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="keycap mt-3 cursor-pointer transition-colors hover:border-accent hover:bg-accent hover:text-black"
          >
            RETRY
          </button>
        </div>
      </div>
    );
  }
}
