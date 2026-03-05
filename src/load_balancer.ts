import { AliasSampler } from './alias.js';
import { EWMA, PeakEWMA } from './ewma.js';
import { fnv1a64, joinUrl, jumpConsistentHash } from './hash.js';
import { defaultRandom } from './random.js';
import type {
  Backend,
  BalancerEvent,
  BalancerOptions,
  FetchOptions,
  Outcome,
  Pick,
  RequestContext,
  RunOptions,
  Task,
} from './types.js';

export class NoBackendsError extends Error {
  constructor(message = 'No backends configured') {
    super(message);
    this.name = 'NoBackendsError';
  }
}

export class AllBackendsUnavailableError extends Error {
  constructor(message = 'All backends are unavailable (circuit open / maxInflight / avoided)') {
    super(message);
    this.name = 'AllBackendsUnavailableError';
  }
}

type BackendRuntime = {
  inflight: number;
  latency: PeakEWMA;
  error: EWMA;
  consecutiveFailures: number;
  circuitOpenUntil: number;
  nextBackoffMs: number;
};

type Pool = {
  name: string | null;
  indices: number[]; // indices into backends/states
  sampler: AliasSampler;
};

function clampPositive(n: number | undefined, fallback: number): number {
  if (typeof n !== 'number') return fallback;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function isFailureStatus(status: number, failureStatus: readonly number[] | undefined): boolean {
  if (failureStatus?.includes(status)) return true;
  // Default heuristic: 429 + 5xx are “backend not OK”.
  return status === 429 || (status >= 500 && status <= 599);
}

function createTimeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number | undefined,
  now: () => number
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();

  let timeout: any = null;
  const onAbort = () => {
    try {
      controller.abort((parent as any).reason);
    } catch {
      controller.abort();
    }
  };

  if (parent) {
    if (parent.aborted) onAbort();
    else parent.addEventListener('abort', onAbort, { once: true });
  }

  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    const start = now();
    timeout = setTimeout(() => {
      const elapsed = now() - start;
      const err = new Error(`Timeout after ${elapsed}ms`);
      (err as any).name = 'TimeoutError';
      controller.abort(err);
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    cancel: () => {
      if (parent) parent.removeEventListener('abort', onAbort);
      if (timeout !== null) clearTimeout(timeout);
    },
  };
}

function wrapResponseBody(res: Response, onDone: () => void): Response {
  const body = res.body;
  if (!body) {
    onDone();
    return res;
  }

  const reader = body.getReader();
  let doneCalled = false;
  const callDone = () => {
    if (doneCalled) return;
    doneCalled = true;
    try {
      onDone();
    } catch {
      // ignore
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      return reader
        .read()
        .then(({ done, value }) => {
          if (done) {
            controller.close();
            callDone();
            return;
          }
          if (value) controller.enqueue(value);
        })
        .catch((err) => {
          controller.error(err);
          callDone();
        });
    },
    cancel(reason) {
      return reader
        .cancel(reason)
        .catch(() => undefined)
        .finally(() => callDone());
    },
  });

  const headers = new Headers(res.headers);
  // NOTE: ResponseInit doesn't carry over the final URL; most callers don't rely on it.
  return new Response(stream, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * P2C + Peak EWMA + inflight + error EWMA + circuit breaker.
 *
 * Designed to run in:
 * - Vercel Edge (Web APIs only)
 * - Vercel/Node serverless
 * - Any modern Node (18+) or browser runtime.
 */
export class LoadBalancer {
  private backends: Backend[];
  private states: BackendRuntime[];
  private pools: Map<string, Pool>;
  private allPool: Pool;

  private readonly latencyDecayMs: number;
  private readonly errorDecayMs: number;
  private readonly errorPenalty: number;
  private readonly failureThreshold: number;
  private readonly openBackoffBaseMs: number;
  private readonly openBackoffMaxMs: number;
  private readonly stickiness: 'none' | 'soft';
  private readonly rnd: () => number;
  private readonly now: () => number;
  private readonly onEvent?: (e: BalancerEvent) => void;

  constructor(backends: readonly Backend[], opts: BalancerOptions = {}) {
    this.latencyDecayMs = clampPositive(opts.latencyDecayMs, 10_000);
    this.errorDecayMs = clampPositive(opts.errorDecayMs, 60_000);
    this.errorPenalty = clampPositive(opts.errorPenalty, 10);
    this.failureThreshold = Math.max(1, Math.floor(clampPositive(opts.failureThreshold, 5)));
    this.openBackoffBaseMs = Math.max(10, Math.floor(clampPositive(opts.openBackoffBaseMs, 1_000)));
    this.openBackoffMaxMs = Math.max(
      this.openBackoffBaseMs,
      Math.floor(clampPositive(opts.openBackoffMaxMs, 30_000))
    );
    this.stickiness = opts.stickiness ?? 'soft';
    this.rnd = opts.random ?? defaultRandom;
    this.now = opts.now ?? Date.now;
    this.onEvent = opts.onEvent;

    this.backends = [];
    this.states = [];
    this.pools = new Map();
    this.allPool = { name: null, indices: [], sampler: new AliasSampler([]) };

    this.updateBackends(backends);
  }

  /** Replace backends (preserves stats for unchanged ids). */
  updateBackends(backends: readonly Backend[]): void {
    const prevById = new Map<string, { backend: Backend; state: BackendRuntime }>();
    for (let i = 0; i < this.backends.length; i++) {
      prevById.set(this.backends[i]!.id, { backend: this.backends[i]!, state: this.states[i]! });
    }

    const nextBackends: Backend[] = [];
    const nextStates: BackendRuntime[] = [];

    for (const b of backends) {
      if (!b || !b.id) continue;
      const prev = prevById.get(b.id);
      if (prev) {
        nextBackends.push(b);
        nextStates.push(prev.state);
      } else {
        nextBackends.push(b);
        nextStates.push({
          inflight: 0,
          // Initial latency: 100ms floor 1ms (will converge quickly).
          latency: new PeakEWMA(this.latencyDecayMs, 100, 1),
          error: new EWMA(this.errorDecayMs, 0),
          consecutiveFailures: 0,
          circuitOpenUntil: 0,
          nextBackoffMs: this.openBackoffBaseMs,
        });
      }
    }

    this.backends = nextBackends;
    this.states = nextStates;

    this.rebuildPools();
  }

  listBackends(): readonly Backend[] {
    return this.backends;
  }

  private emit(e: BalancerEvent): void {
    try {
      this.onEvent?.(e);
    } catch {
      // swallow
    }
  }

  private rebuildPools(): void {
    const pools = new Map<string, number[]>();

    for (let i = 0; i < this.backends.length; i++) {
      const b = this.backends[i]!;
      const ps = b.pools;
      if (ps && ps.length) {
        for (const p of ps) {
          if (!p) continue;
          const arr = pools.get(p) ?? [];
          arr.push(i);
          pools.set(p, arr);
        }
      }
    }

    // Build concrete Pool objects (with AliasSampler).
    const poolObjs = new Map<string, Pool>();
    for (const [name, indices] of pools.entries()) {
      const weights = indices.map((idx) => clampPositive(this.backends[idx]!.weight, 1));
      poolObjs.set(name, {
        name,
        indices,
        sampler: new AliasSampler(weights),
      });
    }

    // “all backends” pool.
    const allIndices = this.backends.map((_, i) => i);
    const allWeights = allIndices.map((idx) => clampPositive(this.backends[idx]!.weight, 1));
    this.allPool = {
      name: null,
      indices: allIndices,
      sampler: new AliasSampler(allWeights),
    };

    this.pools = poolObjs;
  }

  private getPool(name: string | undefined): Pool {
    if (!name) return this.allPool;
    return this.pools.get(name) ?? { name, indices: [], sampler: new AliasSampler([]) };
  }

  private score(idx: number, now: number, avoidIds?: ReadonlySet<string>): number {
    const b = this.backends[idx]!;
    if (avoidIds?.has(b.id)) return Number.POSITIVE_INFINITY;

    const st = this.states[idx]!;
    if (st.circuitOpenUntil > now) return Number.POSITIVE_INFINITY;

    const maxInflight = b.maxInflight ?? Number.POSITIVE_INFINITY;
    if (st.inflight >= maxInflight) return Number.POSITIVE_INFINITY;

    const weight = clampPositive(b.weight, 1);
    const latency = st.latency.get(now);
    const err = st.error.get(now);
    const penalty = 1 + err * this.errorPenalty;

    // “Least loaded” cost function.
    return (latency * (st.inflight + 1) * penalty) / weight;
  }

  private pickTwo(pool: Pool, ctx: RequestContext | undefined): [number, number] {
    const size = pool.indices.length;
    if (size === 0) throw new NoBackendsError(`No backends for pool: ${pool.name ?? '(all)'}`);

    // Candidate A: stickiness preferred bucket (soft).
    let a: number;
    if (this.stickiness === 'soft' && ctx?.key) {
      const bucket = jumpConsistentHash(fnv1a64(ctx.key), size);
      a = pool.indices[bucket]!;
    } else {
      a = pool.indices[pool.sampler.sample(this.rnd)]!;
    }

    // Candidate B: weighted random (different if possible).
    let b = a;
    if (size > 1) {
      for (let tries = 0; tries < 3 && b === a; tries++) {
        b = pool.indices[pool.sampler.sample(this.rnd)]!;
      }
      if (b === a) {
        // still same: just use neighbor by position (O(n) only in pathological edge-case)
        const pos = pool.indices.indexOf(a);
        if (pos >= 0) b = pool.indices[(pos + 1) % size]!;
      }
    }

    return [a, b];
  }

  private scanBest(pool: Pool, now: number, avoidIds?: ReadonlySet<string>): { idx: number; score: number } {
    let bestIdx = -1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const idx of pool.indices) {
      const s = this.score(idx, now, avoidIds);
      if (s < bestScore) {
        bestScore = s;
        bestIdx = idx;
      }
    }

    if (bestIdx < 0 || !Number.isFinite(bestScore)) {
      throw new AllBackendsUnavailableError(
        `All backends unavailable for pool ${pool.name ?? '(all)'} (open circuit / maxInflight / avoided)`
      );
    }

    return { idx: bestIdx, score: bestScore };
  }

  /**
   * Acquire a backend selection + stats handle.
   * Usually you will call balancer.run() or balancer.fetch(), which calls this for you.
   */
  pick(ctx?: RequestContext, avoidIds?: ReadonlySet<string>): Pick {
    if (this.backends.length === 0) throw new NoBackendsError();

    const pool = this.getPool(ctx?.pool);
    const now = this.now();

    const [a, b] = this.pickTwo(pool, ctx);
    const scoreA = this.score(a, now, avoidIds);
    const scoreB = this.score(b, now, avoidIds);

    let chosenIdx: number;
    let chosenScore: number;
    if (scoreA <= scoreB) {
      chosenIdx = a;
      chosenScore = scoreA;
    } else {
      chosenIdx = b;
      chosenScore = scoreB;
    }

    if (!Number.isFinite(chosenScore)) {
      // Both sampled candidates unavailable -> fallback to scan.
      const best = this.scanBest(pool, now, avoidIds);
      chosenIdx = best.idx;
      chosenScore = best.score;
    }

    const backend = this.backends[chosenIdx]!;
    const st = this.states[chosenIdx]!;

    st.inflight++;

    this.emit({
      type: 'pick',
      backendId: backend.id,
      pool: ctx?.pool ?? null,
      score: chosenScore,
      inflight: st.inflight,
    });

    let recorded = false;
    let finished = false;

    const record = (outcome: Outcome) => {
      if (recorded) return;
      recorded = true;

      const t = this.now();
      this.emit({ type: 'record', backendId: backend.id, outcome: outcome.type, latencyMs: outcome.latencyMs });

      if (outcome.type === 'canceled') return;

      // Always update latency on success/failure.
      st.latency.observe(outcome.latencyMs, t);

      if (outcome.type === 'success') {
        st.error.observe(0, t);
        st.consecutiveFailures = 0;
        if (st.circuitOpenUntil !== 0) {
          st.circuitOpenUntil = 0;
          st.nextBackoffMs = this.openBackoffBaseMs;
          this.emit({ type: 'circuit_close', backendId: backend.id });
        }
        return;
      }

      // failure
      st.error.observe(1, t);
      st.consecutiveFailures++;

      if (st.consecutiveFailures >= this.failureThreshold) {
        // Open circuit with exponential backoff + jitter.
        const jitter = 0.9 + this.rnd() * 0.2; // ±10%
        const openFor = Math.min(this.openBackoffMaxMs, Math.floor(st.nextBackoffMs * jitter));
        st.circuitOpenUntil = t + openFor;
        st.nextBackoffMs = Math.min(this.openBackoffMaxMs, st.nextBackoffMs * 2);
        st.consecutiveFailures = 0;

        this.emit({ type: 'circuit_open', backendId: backend.id, openUntil: st.circuitOpenUntil });
      }
    };

    const done = () => {
      if (finished) return;
      finished = true;
      st.inflight = Math.max(0, st.inflight - 1);
    };

    return { backend, record, done };
  }

  /**
   * Run arbitrary async work against a selected backend.
   *
   * Example:
   *   await balancer.run({key:userId}, async (b,{signal}) => {
   *     return myRpcCall(b.url!, {signal});
   *   })
   */
  async run<T>(ctx: RequestContext | undefined, task: Task<T>, opts: RunOptions = {}): Promise<T> {
    const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? 1));
    const hedgeAfterMs = opts.hedgeAfterMs;

    if (typeof hedgeAfterMs === 'number' && hedgeAfterMs > 0 && maxAttempts >= 2) {
      return this.runHedged(ctx, task, { ...opts, maxAttempts });
    }

    const avoid = new Set<string>();
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const pick = this.pick(ctx, avoid);
      avoid.add(pick.backend.id);

      const start = this.now();
      const { signal, cancel } = createTimeoutSignal(undefined, opts.timeoutMs, this.now);

      try {
        const res = await task(pick.backend, { attempt, signal });
        const latencyMs = this.now() - start;
        pick.record({ type: 'success', latencyMs });
        pick.done();
        cancel();
        return res;
      } catch (err) {
        const latencyMs = this.now() - start;
        pick.record({ type: 'failure', latencyMs, error: err });
        pick.done();
        cancel();
        lastErr = err;

        const shouldRetry = opts.shouldRetry?.(err, attempt) ?? attempt < maxAttempts;
        if (!shouldRetry) break;
      }
    }

    throw lastErr;
  }

  private async runHedged<T>(ctx: RequestContext | undefined, task: Task<T>, opts: RunOptions): Promise<T> {
    const maxAttempts = Math.max(2, Math.floor(opts.maxAttempts ?? 2));
    const hedgeAfterMs = Math.max(1, Math.floor(opts.hedgeAfterMs ?? 0));

    const avoid = new Set<string>();

    type Attempt = {
      attempt: number;
      pick: Pick;
      start: number;
      timeout: { signal: AbortSignal; cancel: () => void };
      controller: AbortController;
      promise: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>;
    };

    const attempts: Attempt[] = [];

    const startAttempt = (attemptNo: number): Attempt => {
      const pick = this.pick(ctx, avoid);
      avoid.add(pick.backend.id);

      const start = this.now();
      const controller = new AbortController();
      const timeout = createTimeoutSignal(controller.signal, opts.timeoutMs, this.now);

      const promise = (async () => {
        try {
          const v = await task(pick.backend, { attempt: attemptNo, signal: timeout.signal });
          return { ok: true as const, value: v };
        } catch (e) {
          return { ok: false as const, error: e };
        }
      })();

      return { attempt: attemptNo, pick, start, controller, timeout, promise };
    };

    const mark = (a: Attempt, outcome: Outcome) => {
      const latencyMs = this.now() - a.start;
      a.pick.record({ ...outcome, latencyMs } as Outcome);
    };

    attempts.push(startAttempt(1));

    // schedule additional attempts as hedges
    let nextToStart = 2;
    let hedgeTimer: any = null;

    const schedule = () => {
      if (nextToStart > maxAttempts) return;
      hedgeTimer = setTimeout(() => {
        try {
          attempts.push(startAttempt(nextToStart++));
        } catch {
          // ignore
        }
        schedule();
      }, hedgeAfterMs);
    };
    schedule();

    let lastErr: unknown;

    while (attempts.length) {
      const { a, r } = await Promise.race(
        attempts.map((a) => a.promise.then((r) => ({ a, r })))
      );

      // remove settled attempt from list
      const idx = attempts.indexOf(a);
      if (idx >= 0) attempts.splice(idx, 1);
      a.timeout.cancel();

      if (r.ok) {
        mark(a, { type: 'success', latencyMs: 0 });
        a.pick.done();

        // cancel others
        for (const other of attempts) {
          try {
            other.controller.abort(new Error('Hedged request canceled'));
          } catch {}
          other.pick.record({ type: 'canceled', latencyMs: this.now() - other.start });
          other.pick.done();
          other.timeout.cancel();
        }

        if (hedgeTimer !== null) clearTimeout(hedgeTimer);
        return r.value;
      }

      lastErr = r.error;
      mark(a, { type: 'failure', latencyMs: 0, error: r.error });
      a.pick.done();

      if (attempts.length === 0 && nextToStart <= maxAttempts) {
        try {
          attempts.push(startAttempt(nextToStart++));
        } catch {
          break;
        }
      }
    }

    if (hedgeTimer !== null) clearTimeout(hedgeTimer);
    throw lastErr;
  }

  /**
   * Convenience: fetch() with balancing.
   *
   * - input should usually be a path like "/v1/chat/completions".
   * - base URL comes from backend.url.
   */
  async fetch(
    ctx: RequestContext | undefined,
    input: string,
    init: RequestInit = {},
    opts: FetchOptions = {}
  ): Promise<Response> {
    const failureStatus = opts.failureStatus;
    const retries = Math.max(0, Math.floor(opts.retries ?? 0));
    const maxAttempts = 1 + retries;

    // If caller wants inflight to track whole body, implement single-attempt path.
    if (opts.inflightUntilBodyDone) {
      if (retries > 0 || (typeof opts.hedgeAfterMs === 'number' && opts.hedgeAfterMs > 0)) {
        throw new Error(
          'fetch({inflightUntilBodyDone:true}) does not support retries/hedging in this helper. ' +
            'Use balancer.pick() + custom buffering if you need both.'
        );
      }

      const pick = this.pick(ctx);
      const start = this.now();
      const timeout = createTimeoutSignal(undefined, opts.timeoutMs, this.now);

      try {
        if (!pick.backend.url) throw new Error(`Backend ${pick.backend.id} has no url; cannot use balancer.fetch()`);
        const url = joinUrl(pick.backend.url, input);
        const res = await fetch(url, { ...init, signal: timeout.signal });
        const ttfbMs = this.now() - start;

        const okForBalancing = !isFailureStatus(res.status, failureStatus);
        pick.record(okForBalancing ? { type: 'success', latencyMs: ttfbMs } : { type: 'failure', latencyMs: ttfbMs });

        const wrapped = wrapResponseBody(res, () => pick.done());
        timeout.cancel();
        return wrapped;
      } catch (err) {
        const latencyMs = this.now() - start;
        pick.record({ type: 'failure', latencyMs, error: err });
        pick.done();
        timeout.cancel();
        throw err;
      }
    }

    // Default path: retries/hedging supported (inflight ends at headers).
    const runOpts: RunOptions = {
      maxAttempts,
      timeoutMs: opts.timeoutMs,
      hedgeAfterMs: opts.hedgeAfterMs,
      shouldRetry: (_err, attempt) => attempt < maxAttempts,
    };

    return this.run<Response>(
      ctx,
      async (backend, { signal }) => {
        if (!backend.url) throw new Error(`Backend ${backend.id} has no url; cannot use balancer.fetch()`);
        const url = joinUrl(backend.url, input);
        const res = await fetch(url, { ...init, signal });

        if (isFailureStatus(res.status, failureStatus)) {
          const err = new Error(`Upstream returned ${res.status}`);
          (err as any).name = 'UpstreamStatusError';
          (err as any).status = res.status;
          (err as any).response = res;
          throw err;
        }
        return res;
      },
      runOpts
    ).catch((err) => {
      // If status-based failure and no more retries, return the response for caller handling.
      const resp = (err as any)?.response;
      if (resp && typeof resp.status === 'number') return resp as Response;
      throw err;
    });
  }

  /**
   * Forward an incoming Request to a selected backend, preserving method/headers/body.
   *
   * IMPORTANT: If you enable retries/hedging, the request body must be replayable.
   * The safest approach is to buffer the body (ArrayBuffer) yourself.
   */
  async forward(ctx: RequestContext | undefined, req: Request, opts: FetchOptions = {}): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname + url.search;
    const init: RequestInit = {
      method: req.method,
      headers: req.headers,
      body: req.body as any,
    };
    return this.fetch(ctx, path, init, opts);
  }
}
