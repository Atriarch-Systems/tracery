/**
 * Posts a batch of pre-built wire events to a running hub's ingest endpoint
 * (SPEC.md §6 `POST /v1/events`). This uses a raw fetch rather than
 * @atriarch-systems/tracery-client's ActivityTracer/Flow/Op builder API on purpose:
 * this generator already has complete, pre-built ActivityEvent objects (the
 * same shape scripts/demo.mjs and scripts/capture-hero.mjs push), not a
 * live call to build incrementally, so replaying them verbatim is both
 * simpler and a more honest illustration of the wire contract itself.
 */
import type { ActivityEvent } from '@atriarch-systems/tracery-core';

export interface SendResult {
  readonly ok: boolean;
  readonly detail: string;
}

export async function sendToHub(hubUrl: string, apiKey: string, workspace: string, events: readonly ActivityEvent[]): Promise<SendResult> {
  const url = `${hubUrl.replace(/\/+$/, '')}/v1/events`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey.trim()) headers.authorization = `Bearer ${apiKey.trim()}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ v: 1, workspace: workspace.trim() || undefined, events }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, detail: `${res.status} ${body?.error?.message ?? res.statusText}` };
    }
    return { ok: true, detail: `accepted ${body?.accepted ?? events.length}, cursor ${body?.cursor ?? '?'}` };
  } catch (err) {
    // A failed fetch here is very often CORS or a wrong URL/port, not a
    // server-side rejection -- the browser gives no useful detail for a
    // blocked cross-origin request, so say so plainly rather than just
    // surfacing "TypeError: Failed to fetch".
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `request failed (${message}) -- check the hub URL is reachable and the hub is running Tracery Graph with CORS enabled (any hub built after this example was added has it; see apps/hub/README.md)` };
  }
}
