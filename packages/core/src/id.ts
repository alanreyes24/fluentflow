/**
 * UUID v4 generation that works on Node, in the browser and under Hermes
 * (React Native), where `crypto.randomUUID` is not always present.
 */
/** The slice of WebCrypto this module needs, declared locally so the package
 *  does not have to pull in the DOM lib. */
interface WebCryptoLike {
  randomUUID?(): string;
  getRandomValues?<T extends ArrayBufferView>(array: T): T;
}

const HEX: string[] = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));

export function uuid(): string {
  const c = globalThis.crypto as WebCryptoLike | undefined;
  if (c?.randomUUID) return c.randomUUID();

  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10

  const h = (i: number) => HEX[bytes[i]!]!;
  return (
    h(0) + h(1) + h(2) + h(3) + '-' +
    h(4) + h(5) + '-' +
    h(6) + h(7) + '-' +
    h(8) + h(9) + '-' +
    h(10) + h(11) + h(12) + h(13) + h(14) + h(15)
  );
}

/**
 * Deterministic id derived from stable input, so re-importing the same Anki
 * deck maps onto the same cards instead of duplicating them.
 *
 * Not a cryptographic hash and not RFC-4122 v5 — it just has to be stable,
 * well-distributed across a single user's collection, and UUID-shaped.
 */
export function stableId(namespace: string, ...parts: (string | number)[]): string {
  const input = [namespace, ...parts].join(' ');
  // FNV-1a 32-bit, run over four offset seeds to fill 128 bits.
  const words = [0, 1, 2, 3].map((seed) => fnv1a(input, (0x811c9dc5 ^ Math.imul(seed, 0x9e3779b9)) >>> 0));
  const hex = words.map((w) => (w >>> 0).toString(16).padStart(8, '0')).join('');
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return (
    hex.slice(0, 8) + '-' +
    hex.slice(8, 12) + '-' +
    '5' + hex.slice(13, 16) + '-' +
    variant + hex.slice(17, 20) + '-' +
    hex.slice(20, 32)
  );
}

function fnv1a(input: string, seed: number): number {
  let hash = seed;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
