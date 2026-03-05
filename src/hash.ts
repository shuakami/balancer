const FNV_OFFSET_64 = 14695981039346656037n;
const FNV_PRIME_64 = 1099511628211n;
const MASK_64 = 0xffff_ffff_ffff_ffffn;

export function fnv1a64(input: string): bigint {
  let h = FNV_OFFSET_64;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * FNV_PRIME_64) & MASK_64;
  }
  return h;
}

/**
 * Jump Consistent Hash (Lamping & Veach).
 * O(log N) with tiny constants, minimal remapping when bucket count changes.
 */
export function jumpConsistentHash(key: bigint, buckets: number): number {
  if (buckets <= 1) return 0;
  let k = key & MASK_64;
  let b = -1n;
  let j = 0n;
  const numBuckets = BigInt(buckets);
  while (j < numBuckets) {
    b = j;
    // Keep k in uint64 space; otherwise BigInt grows unbounded and may never converge.
    k = (k * 2862933555777941757n + 1n) & MASK_64;
    // (k >> 33) yields 31 bits; safe to cast to Number.
    const r = Number((k >> 33n) + 1n);
    j = BigInt(Math.floor((Number(b + 1n) * 2147483648) / r));
  }
  return Number(b);
}

export function joinUrl(base: string, pathOrUrl: string): string {
  // If already absolute URL, return as-is.
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  if (!base) return pathOrUrl;
  if (base.endsWith('/') && pathOrUrl.startsWith('/')) return base + pathOrUrl.slice(1);
  if (!base.endsWith('/') && !pathOrUrl.startsWith('/')) return `${base}/${pathOrUrl}`;
  return base + pathOrUrl;
}
