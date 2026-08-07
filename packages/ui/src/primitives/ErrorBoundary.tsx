import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./Button.js";
import { Icon } from "./Icon.js";

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Shown instead of the default panel. Receives a reset callback. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Changing any value here clears the error — pass the current page id. */
  resetKeys?: unknown[];
  /** Hook for logging. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

/**
 * Stops one bad render from blanking the whole app.
 *
 * React unmounts the entire tree on an uncaught render error, so without a
 * boundary a single thrown exception anywhere in the page leaves a white
 * window and no way back except restarting the app. Wrapping the page body
 * (rather than the root) means the shell — sidebar, header, navigation —
 * survives, so you can simply click to another page.
 *
 * Must be a class: there is still no hook equivalent of componentDidCatch.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
    // Keep this — without it a render crash leaves no trace anywhere.
    console.error("Unhandled render error:", error, info.componentStack);
  }

  override componentDidUpdate(prev: ErrorBoundaryProps): void {
    // Navigating away should clear the error, otherwise the boundary keeps
    // showing a stale failure for a page you already left.
    if (!this.state.error) return;
    const a = prev.resetKeys ?? [];
    const b = this.props.resetKeys ?? [];
    if (a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))) {
      this.setState({ error: null });
    }
  }

  private reset = () => this.setState({ error: null });

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="panel" style={{ maxWidth: 560, margin: "var(--space-10) auto" }}>
        <div className="row" style={{ gap: "var(--space-3)", marginBottom: "var(--space-3)" }}>
          <span className="tile tile-negative">
            <Icon name="alert" size={18} />
          </span>
          <div>
            <div className="panel-title">This view hit an error</div>
            <div className="panel-sub">The rest of the app is still fine.</div>
          </div>
        </div>
        <p className="card-body">
          Something in this page failed to render. Your data is safe on the server — nothing here
          writes on load.
        </p>
        <pre
          className="sunken t-xs"
          style={{
            padding: "var(--space-3)",
            overflow: "auto",
            maxHeight: 160,
            margin: 0,
            color: "var(--content-secondary)",
            whiteSpace: "pre-wrap",
          }}
        >
          {error.message || String(error)}
        </pre>
        <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-4)" }}>
          <Button variant="primary" icon="refresh" onClick={this.reset}>
            Try again
          </Button>
          <Button variant="secondary" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        </div>
      </div>
    );
  }
}
