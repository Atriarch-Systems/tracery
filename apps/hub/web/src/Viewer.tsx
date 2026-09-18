/**
 * The standalone `.html` export (docs/SHARING.md "HTML export"): renders
 * `ActivityExplorer` in share mode from a `<script id="tracery-data"
 * type="application/json">` block embedded by the hub's export routes
 * (`GET /v1/flows/:id/export.html`, `GET /v1/traces/:id/export.html`) --
 * no network request of any kind, so it works opened straight from disk
 * (`file://`), which is the whole point: local mode has no share links
 * worth sending anyone.
 */
import { useMemo } from 'react';
import { ActivityExplorer, type LockedTarget } from '@atriarch/tracery-react';
import { Journal, buildFlows, type StoredEvent } from '@atriarch/tracery-core';
import { Footer } from './Footer.js';

interface EmbeddedMeta {
  readonly target: LockedTarget;
  readonly mode: 'snapshot' | 'live';
  readonly includeContext: boolean;
  readonly createdAt: number;
  readonly label: string;
}

interface EmbeddedData {
  readonly meta: EmbeddedMeta | null;
  readonly events: readonly StoredEvent[];
}

function readEmbeddedData(): EmbeddedData {
  const el = document.getElementById('tracery-data');
  if (!el?.textContent) return { meta: null, events: [] };
  try {
    const parsed = JSON.parse(el.textContent) as Partial<EmbeddedData>;
    return { meta: parsed.meta ?? null, events: Array.isArray(parsed.events) ? parsed.events : [] };
  } catch {
    return { meta: null, events: [] };
  }
}

export function Viewer() {
  const data = useMemo(readEmbeddedData, []);

  const flows = useMemo(() => {
    const journal = new Journal({ maxEvents: Math.max(50_000, data.events.length) });
    journal.append(data.events);
    return buildFlows(journal.events());
  }, [data.events]);

  const cursor = useMemo(() => data.events.reduce((max, e) => Math.max(max, e.cursor ?? 0), 0), [data.events]);

  const source = { flows, status: 'live' as const, cursor, partial: false };

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
        <span data-testid="share-label">{data.meta?.label ?? 'Offline export'}</span>
        <span data-testid="export-notice" style={{ color: '#8892a6' }}>
          exported {data.meta ? new Date(data.meta.createdAt).toISOString().slice(0, 10) : ''} — no live updates
        </span>
        {data.meta?.includeContext === false && (
          <span data-testid="context-hidden-badge" style={{ color: '#8892a6' }}>
            context hidden by the sharer
          </span>
        )}
      </header>
      <div style={{ flex: '1 1 auto', minHeight: 0 }}>
        <ActivityExplorer source={source} readOnly lockedTarget={data.meta?.target} ariaLabel="Tracery offline export" />
      </div>
      <Footer />
    </div>
  );
}
