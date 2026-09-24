/**
 * Last-resort guard around the explorer panel (ui-1, ui-2). A single
 * malformed event (an out-of-range `ts`, SPEC.md §2 `validateEvent` only
 * requires it be a finite number) or a projection bug (two flows collapsing
 * onto one namespaced node id in trace/ancestors scope) used to throw from
 * deep inside `@atriarch-systems/tracery-react`/`@atriarch-systems/tracery-visualizer`. Both
 * are now defended at their source (`Inspector.formatTs`, the visualizer's
 * `reconcile`), but this boundary is the backstop: without it, any throw in
 * the explorer subtree unmounts `main.tsx`'s whole `createRoot` and blanks
 * the page for every viewer, not just the one flow/node that triggered it.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

export class ExplorerErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console -- last-resort diagnostics; there is no telemetry sink from this static app.
    console.error('[tracery] the explorer panel crashed and was contained by ExplorerErrorBoundary', error, info.componentStack);
  }

  private readonly reset = (): void => this.setState({ error: null });

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          role="alert"
          data-testid="explorer-crashed"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: 8,
            padding: 16,
            color: '#e7e9f2',
            fontFamily: 'system-ui, sans-serif',
            fontSize: 13,
          }}
        >
          <strong style={{ color: '#ff6b6b' }}>Something went wrong rendering this view.</strong>
          <span style={{ opacity: 0.8 }}>{this.state.error.message}</span>
          <button
            type="button"
            data-testid="explorer-crashed-retry"
            onClick={this.reset}
            style={{ background: 'transparent', color: 'inherit', border: '1px solid #262a3a', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
