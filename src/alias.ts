/**
 * Vose alias method for O(1) weighted sampling.
 *
 * Build: O(n)
 * Sample: O(1)
 */
export class AliasSampler {
  private prob: Float64Array;
  private alias: Uint32Array;
  private n: number;

  constructor(weights: readonly number[]) {
    const n = weights.length;
    this.n = n;
    this.prob = new Float64Array(n);
    this.alias = new Uint32Array(n);

    if (n === 0) return;

    // Normalize to mean 1.
    let sum = 0;
    for (const w of weights) sum += w;
    if (!(sum > 0)) {
      // All zero/invalid -> uniform.
      for (let i = 0; i < n; i++) {
        this.prob[i] = 1;
        this.alias[i] = i;
      }
      return;
    }

    const scaled = new Array<number>(n);
    for (let i = 0; i < n; i++) scaled[i] = (weights[i]! * n) / sum;

    const small: number[] = [];
    const large: number[] = [];

    for (let i = 0; i < n; i++) {
      if (scaled[i]! < 1) small.push(i);
      else large.push(i);
    }

    while (small.length && large.length) {
      const s = small.pop()!;
      const l = large.pop()!;

      this.prob[s] = scaled[s]!;
      this.alias[s] = l;

      scaled[l] = (scaled[l]! + scaled[s]!) - 1;
      if (scaled[l]! < 1) small.push(l);
      else large.push(l);
    }

    // Remaining probabilities.
    while (large.length) {
      const l = large.pop()!;
      this.prob[l] = 1;
      this.alias[l] = l;
    }
    while (small.length) {
      const s = small.pop()!;
      this.prob[s] = 1;
      this.alias[s] = s;
    }
  }

  sample(rnd: () => number): number {
    const n = this.n;
    if (n <= 1) return 0;
    const i = Math.floor(rnd() * n);
    const r = rnd();
    return r < this.prob[i]! ? i : this.alias[i]!;
  }

  size(): number {
    return this.n;
  }
}
