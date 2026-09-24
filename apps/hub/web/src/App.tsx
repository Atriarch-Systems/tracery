import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityExplorer, useHubSource } from '@atriarch-systems/tracery-react';
import type { ActivityGraphHandle } from '@atriarch-systems/tracery-react';
import type { Scope } from '@atriarch-systems/tracery-core';
import { ShareDialog, type ShareTargetRef } from './ShareDialog.js';
import { useRoute, type Route } from './router.js';
import { KeyEntry } from './KeyEntry.js';
import { ExplorerErrorBoundary } from './ErrorBoundary.js';
import { Footer } from './Footer.js';
import { SharePage } from './SharePage.js';
import { loadSession, saveSession, clearSession, type HubSession } from './session.js';
import { fetchAuthMe, logout } from './sso.js';
import { fetchHubInfo } from './info.js';
import { ThemeSettings } from './ThemeSettings.js';
import { loadThemeChoice, saveThemeChoice, resolveActivityTheme, type ThemeChoice } from './theme-storage.js';

declare global {
  interface Window {
    /** Set only by Playwright specs via `page.addInitScript`, never by this app itself -- an
     * optional test observability hook for node/group drags. See explorer.mocked.spec.ts. */
    __traceryTestOnNodeMove?: (move: { id: string; x: number; y: number }) => void;
    __traceryTestOnGroupMove?: (move: { groupId: string; positions: readonly { id: string; x: number; y: number }[] }) => void;
  }
}

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

  const route = useRoute();

  useEffect(() => {
    // A share-page visit (docs/SHARING.md) needs no key/session at all --
    // `SharePage` reads straight from the token via `useShareSource`. Skip
    // the info/SSO probe entirely so a public share viewer's browser never
    // makes an authenticated-flavoured request on the hub's behalf.
    if (session || route.type === 'share') return; // an existing (API-key, local-mode, or already-detected SSO) session skips the check entirely
    let cancelled = false;

    // Task ("local mode"): check GET /v1/info first. A hub reporting
    // `auth: 'none'` needs no key at all -- connect straight away and never
    // touch the SSO check or show KeyEntry. Anything else (auth: 'keys', or
    // /v1/info itself failing -- e.g. a hub old enough not to have the
    // route, or this mocked-preview test harness) falls through to the
    // pre-existing SSO-then-KeyEntry flow, unchanged.
    void fetchHubInfo()
      .then((info) => {
        if (cancelled) return;
        if (info?.auth === 'none') {
          const next: HubSession = { baseUrl: window.location.origin, apiKey: '', workspace: info.workspace ?? 'default', local: true };
          saveSession(next);
          setSession(next);
          return undefined;
        }
        return fetchAuthMe().then((me) => {
          if (cancelled) return;
          if (!me) {
            setSsoAvailable(false);
            return;
          }
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
        });
      })
      .catch(() => {
        if (!cancelled) setSsoAvailable(false);
      });

    return () => {
      cancelled = true;
    };
  }, [session, route.type]);

  if (route.type === 'share') return <SharePage token={route.token} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: '1 1 auto', minHeight: 0 }}>
        {!session ? (
          <KeyEntry
            ssoAvailable={ssoAvailable}
            onReady={(next) => {
              saveSession(next);
              setSession(next);
            }}
          />
        ) : (
          <Explorer
            session={session}
            route={route}
            onSignOut={() => {
              clearSession();
              setSession(null);
              void logout(); // best-effort: clears the SSO session cookie server-side too, if there is one
            }}
          />
        )}
      </div>
      <Footer />
    </div>
  );
}

function Explorer({ session, route, onSignOut }: { readonly session: HubSession; readonly route: Route; readonly onSignOut: () => void }) {
  const flow = route.type === 'flow' ? route.id : undefined;
  const trace = route.type === 'trace' ? route.id : undefined;

  const source = useHubSource({ baseUrl: session.baseUrl, apiKey: session.apiKey, workspace: session.workspace, flow, trace });
  const initialScope = useMemo(() => scopeForRoute(route), [route.type, flow, trace]);
  const graphRef = useRef<ActivityGraphHandle>(null);
  const [shareOpen, setShareOpen] = useState(false);
  // Loaded synchronously in the useState initializer (runs before first
  // paint) so the stored theme choice applies on first render with no flash
  // of the default theme.
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() => loadThemeChoice());
  const theme = useMemo(() => resolveActivityTheme(themeChoice), [themeChoice]);
  const updateThemeChoice = (next: ThemeChoice): void => {
    setThemeChoice(next);
    saveThemeChoice(next);
  };

  // The Share button targets exactly the flow/trace named by a deep link
  // (docs/SHARING.md "Web"): `ActivityExplorer` owns its own flow-picker/
  // scope state internally and does not expose it, so a specific-enough
  // target to share is only ever known here from the route itself -- not
  // from whatever the picker happens to be showing on the root "/ui/" view.
  const shareTarget: ShareTargetRef | undefined = flow ? { type: 'flow', id: flow } : trace ? { type: 'trace', id: trace } : undefined;

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
        <strong>Tracery Graph</strong>
        <span>
          workspace: <span data-testid="workspace-name">{session.workspace ?? 'default'}</span>
        </span>
        <span>
          status: <span data-testid="header-connection-status">{source.status}</span>
        </span>
        {session.local && (
          <span data-testid="local-mode-badge" title="No TRACERY_API_KEYS configured; every request is full access on this hub." style={{ color: '#8892a6' }}>
            local mode
          </span>
        )}
        {route.type === 'not-found' && <span style={{ color: '#ff6b6b' }}>Unknown route: {route.path}</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <ThemeSettings choice={themeChoice} onChange={updateThemeChoice} />
          {shareTarget && (
            <button
              type="button"
              data-testid="share-button"
              onClick={() => setShareOpen(true)}
              style={{ background: 'transparent', color: 'inherit', border: '1px solid #262a3a', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}
            >
              Share
            </button>
          )}
          <button
            type="button"
            data-testid="header-download-image"
            onClick={() => {
              void graphRef.current?.toImage({ background: '#12141c' }).then((blob) => {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `tracery-${flow ?? trace ?? 'view'}.png`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
              });
            }}
            style={{ background: 'transparent', color: 'inherit', border: '1px solid #262a3a', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}
          >
            Download image
          </button>
          <button
            type="button"
            data-testid="sign-out"
            onClick={onSignOut}
            style={{ background: 'transparent', color: 'inherit', border: '1px solid #262a3a', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}
          >
            Sign out
          </button>
        </div>
      </header>
      <div style={{ flex: '1 1 auto', minHeight: 0 }}>
        {/* Backstop only (ui-1, ui-2 are fixed at their source): one bad
            event or projection must degrade this panel, not the whole page. */}
        <ExplorerErrorBoundary>
          <ActivityExplorer
            source={source}
            initialScope={initialScope}
            ariaLabel="Tracery Graph hosted explorer"
            graphRef={graphRef}
            theme={theme}
            // No persistence logic lives here today for either callback to plug into. Rather
            // than unconditionally publishing drag state to `window` for every real user (a
            // prior version of this did exactly that), call an optional hook ONLY if a test
            // harness has already defined one via `page.addInitScript` -- a no-op `typeof` check
            // in production that never itself writes to the global scope. See
            // apps/hub/web/tests/explorer.mocked.spec.ts's "group drag" tests.
            onNodeMove={(node, position) => {
              window.__traceryTestOnNodeMove?.({ id: node.id, ...position });
            }}
            onGroupMove={(group, positions) => {
              window.__traceryTestOnGroupMove?.({ groupId: group.id, positions });
            }}
          />
        </ExplorerErrorBoundary>
      </div>
      {shareOpen && shareTarget && <ShareDialog session={session} target={shareTarget} graphRef={graphRef} onClose={() => setShareOpen(false)} />}
    </div>
  );
}
