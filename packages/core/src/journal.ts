/**
 * A bounded, deduplicating, ordered event log (SPEC.md §1 "Ordering").
 * Pure in-memory bookkeeping; no I/O. The hub and the React source hooks build
 * on this, but it works standalone for the library-only path.
 */
import type { ActivityEvent } from './contract.js';

export interface JournalOptions {
  /** Oldest events are evicted once this many events are held. Default 50,000. */
  readonly maxEvents?: number;
}

interface Entry {
  readonly event: ActivityEvent;
  readonly arrival: number;
}

const DEFAULT_MAX_EVENTS = 50_000;

function compare(a: Entry, b: Entry): number {
  if (a.event.ts !== b.event.ts) return a.event.ts - b.event.ts;
  const aSeq = a.event.seq ?? 0;
  const bSeq = b.event.seq ?? 0;
  if (aSeq !== bSeq) return aSeq - bSeq;
  return a.arrival - b.arrival;
}

/** Index of the first position whose entry sorts after `target`. */
function upperBound(entries: readonly Entry[], target: Entry): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compare(entries[mid]!, target) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class Journal {
  readonly #maxEvents: number;
  readonly #entries: Entry[] = [];
  readonly #ids = new Set<string>();
  #arrivalCounter = 0;
  #evicted = false;

  constructor(opts?: JournalOptions) {
    this.#maxEvents = opts?.maxEvents ?? DEFAULT_MAX_EVENTS;
    if (!Number.isFinite(this.#maxEvents) || this.#maxEvents < 1) {
      throw new Error('Journal: maxEvents must be a finite number >= 1');
    }
  }

  /** Appends events, deduplicating by id. Returns what was newly added and how many were duplicates. */
  append(events: readonly ActivityEvent[]): { added: ActivityEvent[]; duplicates: number } {
    const added: ActivityEvent[] = [];
    let duplicates = 0;
    for (const event of events) {
      if (this.#ids.has(event.id)) {
        duplicates++;
        continue;
      }
      const entry: Entry = { event, arrival: this.#arrivalCounter++ };
      const index = upperBound(this.#entries, entry);
      this.#entries.splice(index, 0, entry);
      this.#ids.add(event.id);
      added.push(event);
    }
    while (this.#entries.length > this.#maxEvents) {
      const removed = this.#entries.shift();
      if (removed) {
        this.#ids.delete(removed.event.id);
        this.#evicted = true;
      }
    }
    return { added, duplicates };
  }

  /** All retained events, ordered by (ts, seq ?? 0, arrival). */
  events(): readonly ActivityEvent[] {
    return this.#entries.map((entry) => entry.event);
  }

  /** Flow ids present in the journal, in order of first appearance among retained events. */
  flowIds(): readonly string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const entry of this.#entries) {
      if (!seen.has(entry.event.flow)) {
        seen.add(entry.event.flow);
        order.push(entry.event.flow);
      }
    }
    return order;
  }

  eventsForFlow(flow: string): readonly ActivityEvent[] {
    const result: ActivityEvent[] = [];
    for (const entry of this.#entries) if (entry.event.flow === flow) result.push(entry.event);
    return result;
  }

  /** True once eviction has dropped events; sticky for the life of the journal. */
  get partial(): boolean {
    return this.#evicted;
  }
}
