/**
 * Exponentially Weighted Moving Average with time-based decay.
 *
 * We use time-constant decay (τ, in ms): w = exp(-dt/τ)
 *
 * For latency we use a “Peak EWMA” variant that reacts faster to spikes:
 *   ewma = max(prev, sample) * w + sample * (1 - w)
 */

export class EWMA {
  private v: number;
  private lastTs: number;
  private init: boolean;

  constructor(private readonly decayMs: number, initial: number) {
    this.v = initial;
    this.lastTs = 0;
    this.init = false;
  }

  get(now: number): number {
    if (!this.init) return this.v;
    const dt = now - this.lastTs;
    if (dt <= 0) return this.v;
    const w = Math.exp(-dt / this.decayMs);
    return this.v * w;
  }

  observe(sample: number, now: number): number {
    if (!this.init) {
      this.init = true;
      this.v = sample;
      this.lastTs = now;
      return this.v;
    }
    const dt = now - this.lastTs;
    const w = dt <= 0 ? 0 : Math.exp(-dt / this.decayMs);
    this.v = this.v * w + sample * (1 - w);
    this.lastTs = now;
    return this.v;
  }
}

export class PeakEWMA {
  private v: number;
  private lastTs: number;
  private init: boolean;

  constructor(private readonly decayMs: number, initial: number, private readonly floor: number) {
    this.v = initial;
    this.lastTs = 0;
    this.init = false;
  }

  get(now: number): number {
    if (!this.init) return Math.max(this.floor, this.v);
    const dt = now - this.lastTs;
    if (dt <= 0) return Math.max(this.floor, this.v);
    const w = Math.exp(-dt / this.decayMs);
    return Math.max(this.floor, this.v * w);
  }

  observe(sample: number, now: number): number {
    const s = Math.max(this.floor, sample);
    if (!this.init) {
      this.init = true;
      this.v = s;
      this.lastTs = now;
      return this.v;
    }
    const dt = now - this.lastTs;
    const w = dt <= 0 ? 0 : Math.exp(-dt / this.decayMs);
    const peak = Math.max(this.v, s);
    this.v = peak * w + s * (1 - w);
    this.lastTs = now;
    return this.v;
  }
}
