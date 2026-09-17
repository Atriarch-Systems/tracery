/**
 * Default inspector panel (SPEC.md §4 "an inspector panel showing the
 * selected node's ops newest-first with status, timing, merged context
 * (pretty JSON, collapsible) and the annotate timeline"). Overridable via
 * `ActivityExplorer`'s `renderInspector` prop.
 */
import type { ActivityNode, NodeData, OpRecord, TimelineEntry } from '@atriarch/tracery-core';
import { styles } from './style.js';

export type InspectorSelection = ActivityNode<NodeData>;

function formatTs(ts: number | undefined): string {
  if (ts === undefined) return '—';
  const date = new Date(ts);
  // `validateEvent` (packages/core/src/validate.ts) only requires `ts` to be
  // a finite number, so a value outside JS's ±8.64e15 date range can reach
  // here from any producer holding an ingest key. `toISOString()` throws
  // `RangeError` for such a value; render the raw number instead of letting
  // one malformed event blank the whole inspector panel.
  if (Number.isNaN(date.getTime())) return String(ts);
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

function opsNewestFirst(ops: readonly OpRecord[]): OpRecord[] {
  return [...ops].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || b.id.localeCompare(a.id));
}

function annotations(timeline: readonly TimelineEntry[]): TimelineEntry[] {
  return timeline.filter((entry) => entry.type === 'annotate');
}

function OpCard({ op }: { op: OpRecord }) {
  const notes = annotations(op.timeline);
  return (
    <div style={styles.opRow(op.status)} data-testid="inspector-op" data-op-id={op.id} data-op-status={op.status}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <strong>{op.name}</strong>
        <span style={styles.muted}>{op.status}</span>
      </div>
      <div style={styles.muted}>
        {formatTs(op.startedAt)}
        {op.endedAt !== undefined ? ` → ${formatTs(op.endedAt)}` : ' (running)'}
        {op.durationMs !== undefined ? ` · ${op.durationMs}ms` : ''}
      </div>
      {op.tags.length > 0 && (
        <div>
          {op.tags.map((tag) => (
            <span key={tag} style={styles.tag}>
              {tag}
            </span>
          ))}
        </div>
      )}
      {Object.keys(op.context).length > 0 && (
        <details data-testid="inspector-op-context" open>
          <summary>Context</summary>
          <pre style={styles.pre}>{JSON.stringify(op.context, null, 2)}</pre>
        </details>
      )}
      {notes.length > 0 && (
        <details data-testid="inspector-op-timeline" open>
          <summary>Timeline ({notes.length})</summary>
          {notes.map((entry) => (
            <div key={entry.eventId} style={{ marginTop: 4 }}>
              <div style={styles.muted}>{formatTs(entry.ts)}</div>
              {entry.context && <pre style={styles.pre}>{JSON.stringify(entry.context, null, 2)}</pre>}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

export function Inspector({ selection }: { readonly selection: InspectorSelection | null }) {
  if (!selection) {
    return (
      <div data-testid="inspector" style={styles.muted}>
        Select a node to inspect its history.
      </div>
    );
  }
  const node = selection.data?.node;
  const ops = selection.data?.ops ?? [];
  return (
    <div data-testid="inspector">
      <h3 style={{ margin: '0 0 4px' }}>{selection.label}</h3>
      <div style={styles.muted}>
        {node?.kind ?? 'node'} · {node?.status ?? selection.status} · {ops.length} ops
      </div>
      <div style={{ marginTop: 12 }}>
        {opsNewestFirst(ops).map((op) => (
          <OpCard key={op.id} op={op} />
        ))}
        {ops.length === 0 && <div style={styles.muted}>No ops recorded.</div>}
      </div>
    </div>
  );
}
