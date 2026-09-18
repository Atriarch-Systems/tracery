/**
 * A tiny in-memory token bucket, per key (per-IP for the public share routes,
 * docs/SHARING.md "Rate limits"). Not shared across replicas -- fine for the
 * single-writer `memory`/`sqlite` stores; a `postgres`-backed multi-replica
 * deployment gets independent per-replica limits, which is a looser bound
 * than a shared one but still stops any single instance from being hammered.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; last: number }>();

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
  ) {}

  private refillPerMs(): number {
    return this.capacity / this.windowMs;
  }

  /** Consumes one token for `key` if available. Returns whether the request is allowed. */
  allow(key: string, now = Date.now()): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, last: now };
      this.buckets.set(key, bucket);
    }
    const elapsedMs = Math.max(0, now - bucket.last);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedMs * this.refillPerMs());
    bucket.last = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Drops buckets untouched for a while, so a long-running process serving many distinct IPs does not grow this map forever. */
  sweep(now = Date.now(), idleMs = this.windowMs * 10): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.last > idleMs) this.buckets.delete(key);
    }
  }

  size(): number {
    return this.buckets.size;
  }
}
