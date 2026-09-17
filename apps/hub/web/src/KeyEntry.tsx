import { useState } from 'react';
import type { HubSession } from './session.js';

export interface KeyEntryProps {
  readonly onReady: (session: HubSession) => void;
}

/** SPEC.md §6: "First load asks for a read key ... then shows the workspace's flows." */
export function KeyEntry({ onReady }: KeyEntryProps) {
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
