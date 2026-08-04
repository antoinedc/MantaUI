// ===== ErrorBoundary =====
//
// React 18 unmounts the ENTIRE root on any uncaught render/commit throw, so a
// single card that throws whites out the whole window with no visible error
// (see testHarness.tsx's note about a preload gap blanking the app on first
// launch). The renderer had NO error boundary anywhere — this is the safety
// net.
//
// On error it logs the real error (`console.error("[error-boundary]", …)`) so
// the cause surfaces instead of a silent white screen, and renders a SMALL
// inline fallback (not a full-screen takeover) with a "Reload" button that
// clears the boundary's error state so a transient failure can recover.
//
// Chrome is built from existing design tokens (bg-danger-bg / border-danger /
// text-meta) — no new colors, no off-grid values.

import { Component, type ErrorInfo, type ReactNode } from "react";

type ErrorBoundaryProps = {
  /** Custom fallback. Receives the caught error and a `reset` to clear state. */
  fallback?: (err: Error, reset: () => void) => ReactNode;
  children: ReactNode;
};

type ErrorBoundaryState = { error: Error | null };

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface the real error — today a render throw is a silent white screen.
    console.error("[error-boundary]", error, info);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) return this.props.fallback(error, this.reset);
      return (
        <div className="bg-danger-bg border border-danger rounded-md px-4 py-3 text-meta">
          <div className="text-text mb-2 break-words">
            {error.message || "Something went wrong."}
          </div>
          <button
            type="button"
            onClick={this.reset}
            className="text-accent hover:underline"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
