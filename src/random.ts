/** Secure-ish random for both Edge and Node, with Math.random fallback. */
export function defaultRandom(): number {
  // Edge + modern Node expose Web Crypto as global crypto.
  const c = (globalThis as any).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const a = new Uint32Array(1);
    c.getRandomValues(a);
    // 0 <= x < 2^32
    return a[0]! / 2 ** 32;
  }
  return Math.random();
}
