/**
 * Cursor/limit query-param parsing shared by `routes/flows.ts` and `live.ts`
 * (hub-5). SPEC.md §6's reconnect protocol is entirely cursor-driven, so a
 * cursor that doesn't parse must fail loudly (400 / WS close) rather than
 * silently degrade into a delta that has -- and always will have -- zero
 * events, which looks indistinguishable from "you're fully caught up".
 */
export class InvalidQueryError extends Error {}

/** `after`/`before`: absent or `""` -> `undefined`; anything else must be a non-negative safe integer cursor. */
export function parseCursor(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidQueryError(`${name} must be a non-negative integer cursor, got "${raw}"`);
  }
  return value;
}

/** `limit`: absent or `""` -> `fallback`; anything else must be an integer in `[1, max]`. */
export function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new InvalidQueryError(`limit must be an integer between 1 and ${max}, got "${raw}"`);
  }
  return value;
}
