/**
 * The "Share" dialog (docs/SHARING.md): create a share link for the flow or
 * trace currently open (`/ui/flows/:id` or `/ui/traces/:id` -- the Share
 * button only appears on one of those deep links, never on the root
 * "pick a flow" view, since that is the one place this component can learn
 * a specific target without reaching into `ActivityExplorer`'s own picker
 * state), download the current view as a PNG, export a self-contained
 * `.html` file (first when the hub is in local mode, where a link is
 * useless), and manage/revoke this key's existing shares.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { HubClient, type CreateShareOptions, type ShareSummary } from '@atriarch-systems/tracery-client';
import type { ActivityGraphHandle } from '@atriarch-systems/tracery-react';
import type { HubSession } from './session.js';

export interface ShareTargetRef {
  readonly type: 'flow' | 'trace';
  readonly id: string;
}

export interface ShareDialogProps {
  readonly session: HubSession;
  readonly target: ShareTargetRef;
  readonly graphRef: RefObject<ActivityGraphHandle | null>;
  readonly onClose: () => void;
}

type ExpiryChoice = '7' | '30' | '90' | 'never';

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function filenameFromContentDisposition(header: string | null, fallback: string): string {
  const match = header ? /filename="?([^"; ]+)"?/i.exec(header) : null;
  return match?.[1] ?? fallback;
}

const inputStyle = { display: 'block', width: '100%', marginTop: 4, padding: 6 } as const;
const buttonStyle = {
  padding: '6px 10px',
  cursor: 'pointer',
  background: 'transparent',
  color: 'inherit',
  border: '1px solid #262a3a',
  borderRadius: 6,
  fontSize: 12,
} as const;

export function ShareDialog({ session, target, graphRef, onClose }: ShareDialogProps) {
  const client = useMemo(
    () => new HubClient({ baseUrl: session.baseUrl, apiKey: session.apiKey, workspace: session.workspace }),
    [session.baseUrl, session.apiKey, session.workspace],
  );

  const [mode, setMode] = useState<'snapshot' | 'live'>('snapshot');
  const [includeContext, setIncludeContext] = useState(false);
  const [expiry, setExpiry] = useState<ExpiryChoice>('30');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<{ readonly id: string; readonly token: string; readonly url: string } | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [shares, setShares] = useState<readonly ShareSummary[]>([]);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    // Default mode heuristic (docs/SHARING.md "Web"): snapshot when the
    // target looks complete, live when it's still running. A failure here
    // (a transient network hiccup) just keeps the safe "snapshot" default.
    void (async () => {
      try {
        if (target.type === 'flow') {
          const flow = await client.getFlow(target.id);
          if (!cancelledRef.current) setMode(flow.status === 'running' ? 'live' : 'snapshot');
        } else {
          const trace = await client.getTrace(target.id);
          if (!cancelledRef.current) setMode(trace.flows.some((f) => f.status === 'running') ? 'live' : 'snapshot');
        }
      } catch {
        // keep the snapshot default
      }
    })();
    return () => {
      cancelledRef.current = true;
    };
  }, [client, target.type, target.id]);

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const options: CreateShareOptions = {
        target,
        mode,
        includeContext,
        expiresInDays: expiry === 'never' ? 'never' : Number(expiry),
      };
      const created = await client.shares.create(options);
      setResult(created);
      // Best-effort: render the current canvas and upload it as the share's
      // preview image. A failure here must never block having created the
      // share itself.
      try {
        const blob = await graphRef.current?.toImage({ background: '#12141c' });
        if (blob) await client.shares.uploadPreview(created.id, new Uint8Array(await blob.arrayBuffer()));
      } catch {
        // preview is a nice-to-have, not required for the share to work
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const downloadImage = async (): Promise<void> => {
    setError(undefined);
    try {
      const blob = await graphRef.current?.toImage({ background: '#12141c' });
      if (!blob) throw new Error('nothing to capture yet');
      downloadBlob(blob, `tracery-${target.type}-${target.id}.png`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const exportHtml = async (): Promise<void> => {
    setError(undefined);
    try {
      const path = target.type === 'flow' ? `/v1/flows/${encodeURIComponent(target.id)}/export.html` : `/v1/traces/${encodeURIComponent(target.id)}/export.html`;
      const url = new URL(`${session.baseUrl}${path}`);
      if (session.workspace) url.searchParams.set('workspace', session.workspace);
      if (!includeContext) url.searchParams.set('context', 'false');
      const headers: Record<string, string> = session.apiKey ? { authorization: `Bearer ${session.apiKey}` } : {};
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`export failed: ${res.status} ${res.statusText}`);
      const blob = await res.blob();
      downloadBlob(blob, filenameFromContentDisposition(res.headers.get('content-disposition'), `tracery-${target.id}.html`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const loadShares = async (): Promise<void> => {
    try {
      setShares(await client.shares.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleManage = (): void => {
    const next = !manageOpen;
    setManageOpen(next);
    if (next) void loadShares();
  };

  const revoke = async (id: string): Promise<void> => {
    await client.shares.revoke(id);
    void loadShares();
  };

  // Always available (the export route only needs `read`, in any auth mode)
  // -- but positioned FIRST, above the link-creation form, specifically in
  // local mode, since a link is useless there (nothing outside the machine
  // can reach it) and a downloadable file is the whole point.
  const exportHtmlButton = (
    <button type="button" data-testid="export-html-button" onClick={() => void exportHtml()} style={buttonStyle}>
      {session.local ? "Export .html (local mode — links aren't reachable elsewhere)" : 'Export .html'}
    </button>
  );

  return (
    <div
      role="dialog"
      aria-label="Share"
      data-testid="share-dialog"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        fontFamily: 'system-ui, sans-serif',
        fontSize: 13,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 360,
          maxHeight: '85vh',
          overflowY: 'auto',
          padding: 20,
          borderRadius: 8,
          background: '#181b26',
          color: '#e7e9f2',
          border: '1px solid #262a3a',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>
            Share {target.type} <span style={{ color: '#8892a6', fontWeight: 'normal' }}>{target.id}</span>
          </h2>
          <button type="button" data-testid="close-share-dialog" onClick={onClose} style={{ ...buttonStyle, padding: '2px 8px' }}>
            ✕
          </button>
        </div>

        {session.local && exportHtmlButton}

        {!result ? (
          <>
            <label style={{ fontSize: 12 }}>
              Mode
              <select data-testid="share-mode-select" value={mode} onChange={(e) => setMode(e.target.value as 'snapshot' | 'live')} style={inputStyle}>
                <option value="snapshot">Snapshot (frozen at creation)</option>
                <option value="live">Live (updates as it runs)</option>
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                data-testid="share-include-context"
                checked={includeContext}
                onChange={(e) => setIncludeContext(e.target.checked)}
              />
              Include context (off hides op/event context from the viewer)
            </label>
            <label style={{ fontSize: 12 }}>
              Expires
              <select data-testid="share-expiry-select" value={expiry} onChange={(e) => setExpiry(e.target.value as ExpiryChoice)} style={inputStyle}>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="never">Never</option>
              </select>
            </label>
            <button type="button" data-testid="create-share-button" onClick={() => void create()} disabled={busy} style={{ ...buttonStyle, background: '#3b82f6', color: '#fff', border: 'none' }}>
              {busy ? 'Creating…' : 'Create share link'}
            </button>
          </>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ fontSize: 12 }}>
              Share URL
              <input data-testid="share-url" readOnly value={result.url} style={inputStyle} onFocus={(e) => e.currentTarget.select()} />
            </label>
            <button
              type="button"
              data-testid="copy-share-url"
              style={buttonStyle}
              onClick={() => {
                void navigator.clipboard?.writeText(result.url).then(() => setCopied(true));
              }}
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        )}

        {error && (
          <div role="alert" style={{ color: '#ff6b6b', fontSize: 12 }}>
            {error}
          </div>
        )}

        <button type="button" data-testid="download-image-button" onClick={() => void downloadImage()} style={buttonStyle}>
          Download image
        </button>

        {!session.local && exportHtmlButton}

        <button type="button" data-testid="manage-shares-button" onClick={toggleManage} style={buttonStyle}>
          {manageOpen ? 'Hide shares' : 'Manage shares'}
        </button>

        {manageOpen && (
          <ul data-testid="manage-shares-list" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {shares.length === 0 && <li style={{ color: '#8892a6' }}>No shares yet.</li>}
            {shares.map((share) => (
              <li
                key={share.id}
                data-testid="manage-shares-item"
                data-share-id={share.id}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12 }}
              >
                <span>
                  {share.target.type}:{share.target.id} · {share.mode}
                  {share.revokedAt ? ' · revoked' : share.expiresAt !== null && share.expiresAt < Date.now() ? ' · expired' : ''}
                </span>
                {!share.revokedAt && (
                  <button type="button" data-testid="revoke-share-button" onClick={() => void revoke(share.id)} style={{ ...buttonStyle, padding: '2px 8px' }}>
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
