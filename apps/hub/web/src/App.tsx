import { useMemo, useState } from 'react';
import { ActivityExplorer, useHubSource } from '@atriarch/activity-react';
import type { Scope } from '@atriarch/activity-core';
import { useRoute, type Route } from './router.js';
import { KeyEntry } from './KeyEntry.js';
import { loadSession, saveSession, clearSession, type HubSession } from './session.js';

function scopeForRoute(route: Route): Scope | undefined {
  if (route.type === 'flow') return { mode: 'flow', flow: route.id };
  if (route.type === 'trace') return { mode: 'trace', trace: route.id };
  return undefined;
}

export function App() {
  const [session, setSession] = useState<HubSession | null>(() => loadSession());
  const route = useRoute();

  if (!session) {
    return (
      <KeyEntry
        onReady={(next) => {
          saveSession(next);
          setSession(next);
        }}
      />
    );
  }

  return (
    <Explorer
      session={session}
      route={route}
      onSignOut={() => {
        clearSession();
        setSession(null);
      }}
    />
  );
}

function Explorer({ session, route, onSignOut }: { readonly session: HubSession; readonly route: Route; readonly onSignOut: () => void }) {
  const flow = route.type === 'flow' ? route.id : undefined;
  const trace = route.type === 'trace' ? route.id : undefined;

  const source = useHubSource({ baseUrl: session.baseUrl, apiKey: session.apiKey, workspace: session.workspace, flow, trace });
  const initialScope = useMemo(() => scopeForRoute(route), [route.type, flow, trace]);

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
        <strong>Atriarch Activity</strong>
        <span>
          workspace: <span data-testid="workspace-name">{session.workspace ?? 'default'}</span>
        </span>
        <span>
          status: <span data-testid="header-connection-status">{source.status}</span>
        </span>
        {route.type === 'not-found' && <span style={{ color: '#ff6b6b' }}>Unknown route: {route.path}</span>}
        <button
          type="button"
          data-testid="sign-out"
          onClick={onSignOut}
          style={{ marginLeft: 'auto', background: 'transparent', color: 'inherit', border: '1px solid #262a3a', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}
        >
          Sign out
        </button>
      </header>
      <div style={{ flex: '1 1 auto', minHeight: 0 }}>
        <ActivityExplorer source={source} initialScope={initialScope} ariaLabel="Atriarch Activity hosted explorer" />
      </div>
    </div>
  );
}
