/**
 * Context redaction for a share whose `includeContext` is `false`
 * (docs/SHARING.md "Redaction rules"). One function, `redactContext`, decides
 * what a redacted context looks like; every other helper here just applies
 * it in the right place (an event's `context`, an op's `context` and its
 * `timeline[].context`, and every op inside a `FlowSummary`/`TraceSummary`)
 * so a public share viewer never receives producer-supplied context, only
 * its shape.
 */
import type { ActivityContext, ActivityFrame, StoredEvent } from '@atriarch-systems/tracery-core/contract';
import type { OpRecord, TimelineEntry } from '@atriarch-systems/tracery-core';
import type { FlowSummary, TraceSummary } from '../store/types.js';

/** `extends ActivityContext` (which is `{ readonly [key: string]: ActivityJson }`) so a `RedactedContext` value type-checks anywhere an `ActivityContext` is expected -- every field here (`true`, a `string[]`, a `number`) is itself valid `ActivityJson`. */
export interface RedactedContext extends ActivityContext {
  readonly _redacted: true;
  readonly keys: readonly string[];
  readonly bytes: number;
}

/** The one place that decides what a redacted context looks like: its key names (sorted, for a stable diff-friendly shape) and its serialised byte size -- never its values. */
export function redactContext(context: ActivityContext | undefined): RedactedContext | undefined {
  if (context === undefined) return undefined;
  return {
    _redacted: true,
    keys: Object.keys(context).sort(),
    bytes: Buffer.byteLength(JSON.stringify(context), 'utf8'),
  };
}

function redactTimelineEntry(entry: TimelineEntry): TimelineEntry {
  if (entry.context === undefined) return entry;
  return { ...entry, context: redactContext(entry.context) };
}

export function redactOp(op: OpRecord): OpRecord {
  return {
    ...op,
    context: redactContext(op.context) ?? op.context,
    timeline: op.timeline.map(redactTimelineEntry),
  };
}

export function redactFlowSummary(flow: FlowSummary): FlowSummary {
  const ops: Record<string, OpRecord> = {};
  for (const [id, op] of Object.entries(flow.ops)) ops[id] = redactOp(op);
  return { ...flow, ops };
}

export function redactTraceSummary(trace: TraceSummary): TraceSummary {
  return { ...trace, flows: trace.flows.map(redactFlowSummary) };
}

export function redactEvent(event: StoredEvent): StoredEvent {
  if (event.context === undefined) return event;
  return { ...event, context: redactContext(event.context) };
}

export function redactFrame(frame: ActivityFrame): ActivityFrame {
  if (frame.type === 'heartbeat') return frame;
  return { ...frame, events: frame.events.map(redactEvent) };
}
