import { ACTIVITY_CONTRACT_VERSION } from '../dist/contract.js';

/** Fills in `v` so test fixtures stay terse. */
export function evt(partial) {
  return { v: ACTIVITY_CONTRACT_VERSION, ...partial };
}
