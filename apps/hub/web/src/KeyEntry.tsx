import { useState } from 'react';
import type { HubSession } from './session.js';

export interface KeyEntryProps {
  readonly onReady: (session: HubSession) => void;
  /** True once `App`'s `GET /v1/auth/me` check reports `sso.configured && sso.licensed` -- shows the "Sign in with SSO" button (SPEC.md §7's hosted-UI requirement). `undefined` while that check is still in flight. */
  readonly ssoAvailable: boolean | undefined;
}

/** SPEC.md §6: "First load asks for a read key ... then shows the workspace's flows." SPEC.md §7 "Extensions and Tracery Cloud": a hub whose extensions module reports SSO configured and licensed also offers a "Sign in with SSO" redirect above the key form. */
export function KeyEntry({ onReady, ssoAvailable }: KeyEntryProps) {
  const [baseUrl, setBaseUrl] = useState(() => window.location.origin);
  const [apiKey, setApiKey] = useState('');
  const [workspace, setWorkspace] = useState('');

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        background: '#12141c',
        color: '#e7e9f2',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <form
        data-testid="key-entry-form"
        style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 320, padding: 24, border: '1px solid #262a3a', borderRadius: 8 }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!apiKey.trim()) return;
          onReady({ baseUrl: baseUrl.trim() || window.location.origin, apiKey: apiKey.trim(), workspace: workspace.trim() || undefined });
        }}
      >
        <h1 style={{ fontSize: 16, margin: 0 }}>Tracery</h1>
        <p style={{ fontSize: 12, color: '#8892a6', margin: 0 }}>Enter a read key to view this hub's flows.</p>

        {ssoAvailable && (
          <>
            <a
              data-testid="sso-login-button"
              href={`/v1/auth/oidc/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`}
              style={{
                display: 'block',
                textAlign: 'center',
                padding: '8px 12px',
                background: '#3b82f6',
                color: '#fff',
                borderRadius: 6,
                textDecoration: 'none',
                fontSize: 13,
              }}
            >
              Sign in with SSO
            </a>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#8892a6', fontSize: 11 }}>
              <span style={{ flex: 1, height: 1, background: '#262a3a' }} />
              or
              <span style={{ flex: 1, height: 1, background: '#262a3a' }} />
            </div>
          </>
        )}

        <label style={{ fontSize: 12 }}>
          Hub URL
          <input
            data-testid="baseurl-input"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            style={{ display: 'block', width: '100%', marginTop: 4, padding: 6 }}
          />
        </label>

        <label style={{ fontSize: 12 }}>
          API key
          <input
            data-testid="key-input"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoFocus
            style={{ display: 'block', width: '100%', marginTop: 4, padding: 6 }}
          />
        </label>

        <label style={{ fontSize: 12 }}>
          Workspace (optional; only needed for an operator key)
          <input
            data-testid="workspace-input"
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            style={{ display: 'block', width: '100%', marginTop: 4, padding: 6 }}
          />
        </label>

        <button data-testid="key-submit" type="submit" style={{ padding: '8px 12px', cursor: 'pointer' }}>
          Connect
        </button>
      </form>
    </div>
  );
}
