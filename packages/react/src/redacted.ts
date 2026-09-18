/**
 * Recognises a redacted context (docs/SHARING.md "Redaction rules": the hub
 * replaces `context` with `{ _redacted: true, keys, bytes }` on a share
 * whose `includeContext` is `false`). `Inspector.tsx` uses this to show a
 * "Context hidden by the sharer" notice instead of the raw (already
 * redacted, so harmless, but uninformative) JSON blob.
 */
import type { ActivityContext } from '@atriarch/tracery-core';

export interface RedactedContextShape {
  readonly _redacted: true;
  readonly keys: readonly string[];
  readonly bytes: number;
}

export function isRedactedContext(context: ActivityContext | undefined): context is ActivityContext & RedactedContextShape {
  if (!context || typeof context !== 'object') return false;
  const value = context as Record<string, unknown>;
  return value._redacted === true && Array.isArray(value.keys) && typeof value.bytes === 'number';
}
