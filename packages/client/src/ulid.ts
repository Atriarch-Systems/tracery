/**
 * ULID (Universally Unique Lexicographically Sortable Identifier) generation.
 *
 * 26-character Crockford base32: a 10-character 48-bit millisecond timestamp
 * followed by a 16-character 80-bit random component. Calls within the same
 * millisecond increment the random component (monotonic factory), so ids
 * produced back-to-back stay lexicographically sortable and never collide
 * under normal use. No external dependency; safe in Node and browsers.
 *
 * https://github.com/ulid/spec
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const RANDOM_BYTES = 10; // 80 bits = 16 base32 chars exactly
const RANDOM_BITS = 80n;
const RANDOM_MAX = (1n << RANDOM_BITS) - 1n;

let lastTime = -1;
let lastRandom = 0n;

function getRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const source = (globalThis as { crypto?: Crypto }).crypto;
  if (source && typeof source.getRandomValues === 'function') {
    source.getRandomValues(bytes);
    return bytes;
  }
  for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

function randomBigInt(): bigint {
  const bytes = getRandomBytes(RANDOM_BYTES);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function encodeTime(time: number): string {
  let str = '';
  let t = time;
  for (let i = 0; i < TIME_LEN; i++) {
    const mod = t % 32;
    str = ENCODING.charAt(mod) + str;
    t = Math.floor(t / 32);
  }
  return str;
}

function encodeRandom(value: bigint): string {
  let str = '';
  let v = value;
  for (let i = 0; i < RANDOM_LEN; i++) {
    str = ENCODING.charAt(Number(v & 31n)) + str;
    v >>= 5n;
  }
  return str;
}

/** Generate a new 26-character Crockford-base32 ULID, monotonic within a millisecond. */
export function ulid(): string {
  const time = Date.now();
  let random: bigint;
  if (time === lastTime) {
    random = lastRandom + 1n;
    if (random > RANDOM_MAX) {
      // 80 bits of randomness exhausted inside one millisecond: vanishingly
      // rare, but stay monotonic by borrowing the next millisecond.
      lastTime = time + 1;
      random = randomBigInt();
      lastRandom = random;
      return encodeTime(lastTime) + encodeRandom(random);
    }
  } else {
    random = randomBigInt();
  }
  lastTime = time;
  lastRandom = random;
  return encodeTime(time) + encodeRandom(random);
}
