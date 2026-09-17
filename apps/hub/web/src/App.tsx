import { useEffect, useMemo, useState } from 'react';
import { ActivityExplorer, useHubSource } from '@atriarch/tracery-react';
import type { Scope } from '@atriarch/tracery-core';
import { useRoute, type Route } from './router.js';
import { KeyEntry } from './KeyEntry.js';
import { ExplorerErrorBoundary } from './ErrorBoundary.js';
import { loadSession, saveSession, clearSession, type HubSession } from './session.js';
import { fetchAuthMe, logout } from './sso.js';

function scopeForRoute(route: Route): Scope | undefined {
  if (route.type === 'flow') return { mode: 'flow', flow: route.id };
  if (route.type === 'trace') return { mode: 'trace', trace: route.id };
  return undefined;
}

export function App() {
  const [session, setSession] = useState<HubSession | null>(() => loadSession());
  // Whether the SSO button should be offered on the key-entry screen (SPEC.md
  // §7: "the key-entry screen shows a 'Sign in with SSO' button when GET
  // /v1/auth/me reports sso is configured"). `undefined` while the check --
  // which also detects an already-established SSO session cookie, e.g. right
  // after the OIDC callback redirects back here -- is in flight.
  const [ssoAvailable, setSsoAvailable] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (session) return; // an existing (API-key or already-detected SSO) session skips the check entirely
    let cancelled = false;

    void fetchAuthMe()
      .then((me) => {
        if (cancelled || !me) return;
        if (me.authenticated) {
          // A valid session cookie already exists (most commonly: the OIDC
          // callback just redirected the browser back here). No API key is
          // stored -- `apiKey: ''` makes `useHubSource`'s `HubClient` send an
          // empty `Authorization`/`?token=` credential, which `apps/hub/src/
          // auth.ts`'s `authenticate()` treats as "no key presented" and
          // falls through to this same cookie.
          const next: HubSession = { baseUrl: window.location.origin, apiKey: '', workspace: me.user?.workspace };
          saveSession(next);
          setSession(next);
          return;
        }
        setSsoAvailable(me.sso.configured && me.sso.licensed);
      })
      .catch(() => {
        if (!cancelled) setSsoAvailable(false);
      });

    return () => {
      cancelled = true;
    };
  }, [session]);

  const route = useRoute();

  if (!session) {
    return (
      <KeyEntry
        ssoAvailable={ssoAvailable}
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
        void logout(); // best-effort: clears the SSO session cookie server-side too, if there is one
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
        <strong>Tracery</strong>
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
        {/* Backstop only (ui-1, ui-2 are fixed at their source): one bad
            event or projection must degrade this panel, not the whole page. */}
        <ExplorerErrorBoundary>
          <ActivityExplorer source={source} initialScope={initialScope} ariaLabel="Tracery hosted explorer" />
        </ExplorerErrorBoundary>
      </div>
    </div>
  );
}
