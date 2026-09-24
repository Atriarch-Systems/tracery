/**
 * `/s/:token` (docs/SHARING.md "Share page"): the SPA route the server-side
 * `GET /s/:token` (`apps/hub/src/routes/share-page.ts`) hands off to once
 * `index.html` (with its injected OG tags) loads in the browser. No key
 * entry, no session -- `useShareSource` needs only the token.
 */
import { ActivityExplorer, useShareSource, type ConnectionStatus } from '@atriarch-systems/tracery-react';
import { ExplorerErrorBoundary } from './ErrorBoundary.js';
import { Footer } from './Footer.js';

// The header shows two different things next to each other: the share's
// MODE ("snapshot"/"live", `data-testid="share-mode"`) and the feed's
// CONNECTION state (this badge). Both used to render as bare words ("live"
// for either one), which reads as the same fact stated twice. Renaming the
// connection badge to describe the connection itself -- and never the
// stream direction ("live" is a mode, not a connection state) -- keeps the
// two apart; a "feed connection" tooltip disambiguates further.
const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  connecting: 'connecting',
  live: 'connected',
  polling: 'connected',
  reconnecting: 'reconnecting',
  offline: 'offline',
};

export function SharePage({ token }: { readonly token: string }) {
  const source = useShareSource(window.location.origin, token);

  if (source.notFound) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          gap: 8,
          color: '#e7e9f2',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <h1 style={{ fontSize: 18, margin: 0 }}>This share link isn't available</h1>
        <p style={{ color: '#8892a6', fontSize: 13, margin: 0 }}>It may have been revoked, expired, or never existed.</p>
      </div>
    );
  }

  const lockedTarget = source.target;
  // A snapshot share never changes after creation (docs/SHARING.md) -- once
  // it has loaded, nothing is streaming, so a connection badge would be
  // pure noise (or worse, read as if it might still update). Keep it while
  // still loading (so a failed fetch's `offline` state is visible), hide it
  // the moment the snapshot resolves.
  const showConnectionBadge = source.mode !== 'snapshot' || source.status === 'connecting';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '8px 16px',
          borderBottom: '1px solid #262a3a',
          background: '#181b26',
          color: '#e7e9f2',
          fontFamily: 'system-ui, sans-serif',
          fontSize: 13,
        }}
      >
        <strong>Tracery</strong>
        <span data-testid="share-label">{source.label ?? 'Shared view'}</span>
        <span data-testid="share-mode" style={{ color: '#8892a6' }}>
          {source.mode ?? '…'}
        </span>
        {showConnectionBadge && (
          <span data-testid="header-connection-status" title="feed connection">
            {CONNECTION_LABELS[source.status]}
          </span>
        )}
        {source.includeContext === false && (
          <span data-testid="context-hidden-badge" style={{ color: '#8892a6' }} title="The sharer chose not to include producer context.">
            context hidden by the sharer
          </span>
        )}
      </header>
      <div style={{ flex: '1 1 auto', minHeight: 0 }}>
        <ExplorerErrorBoundary>
          <ActivityExplorer source={source} readOnly lockedTarget={lockedTarget} ariaLabel="Shared Tracery view" />
        </ExplorerErrorBoundary>
      </div>
      <Footer />
    </div>
  );
}
