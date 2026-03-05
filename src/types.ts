export type Backend = {
  /** Unique id for stats + logging. */
  id: string;

  /** Base URL for fetch() helper. Optional if you only use balancer.run(). */
  url?: string;

  /**
   * Relative capacity. 2 means “~2x throughput”.
   * Default: 1
   */
  weight?: number;

  /** Hard concurrency cap. If inflight >= maxInflight, backend is treated as unavailable. */
  maxInflight?: number;

  /**
   * Optional grouping (e.g. model name, region, service name).
   * You can route requests by ctx.pool.
   */
  pools?: readonly string[];

  /** Arbitrary metadata (region, model, version, etc.). */
  meta?: Record<string, unknown>;
};

export type RequestContext = {
  /**
   * Stickiness key (user id / session id / conversation id).
   * When provided, the balancer will try to keep the same backend,
   * while still allowing latency/error-aware escape.
   */
  key?: string;

  /**
   * Route within a pool (e.g. ctx.pool = "gpt-4o" or "embedding").
   * If omitted, all backends are eligible.
   */
  pool?: string;

  /** Additional app-defined info for custom filters. */
  [k: string]: unknown;
};

export type Outcome =
  | { type: 'success'; latencyMs: number }
  | { type: 'failure'; latencyMs: number; error?: unknown }
  | { type: 'canceled'; latencyMs: number };

export type Pick = {
  backend: Backend;

  /** Update EWMAs / circuit breaker once you know the outcome. Idempotent. */
  record: (outcome: Outcome) => void;

  /** Decrement inflight once this request is no longer “in flight”. Idempotent. */
  done: () => void;
};

export type BalancerEvent =
  | {
      type: 'pick';
      backendId: string;
      pool: string | null;
      score: number;
      inflight: number;
    }
  | {
      type: 'record';
      backendId: string;
      outcome: Outcome['type'];
      latencyMs: number;
    }
  | {
      type: 'circuit_open';
      backendId: string;
      openUntil: number;
    }
  | {
      type: 'circuit_close';
      backendId: string;
    };

export type RunOptions = {
  /**
   * Max attempts for retries. Default: 1.
   * Note: Only use retries for idempotent work.
   */
  maxAttempts?: number;

  /** Per-attempt timeout. Default: undefined (no timeout). */
  timeoutMs?: number;

  /** Optional hedging for tail latency (start 2nd attempt after delay). Default: undefined (disabled). */
  hedgeAfterMs?: number;

  /** Called to decide whether to retry after an error. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
};

export type Task<T> = (
  backend: Backend,
  helpers: {
    attempt: number;
    /** AbortSignal that triggers on timeout or external abort (if provided). */
    signal: AbortSignal;
  }
) => Promise<T>;

export type FetchOptions = {
  /**
   * If true, decrements inflight only after the response body is fully consumed/canceled.
   * If false, decrements inflight as soon as headers arrive.
   * Default: false (fast path).
   */
  inflightUntilBodyDone?: boolean;

  /** Per-attempt timeout. */
  timeoutMs?: number;

  /** Retry count for idempotent requests. Default: 0. */
  retries?: number;

  /** Hedge delay for tail latency. */
  hedgeAfterMs?: number;

  /** Treat these status codes as “failure” for balancing decisions. */
  failureStatus?: readonly number[];
};

export type BalancerOptions = {
  /**
   * Peak EWMA decay time constant (ms). Smaller reacts faster to spikes.
   * Default: 10_000
   */
  latencyDecayMs?: number;

  /** Error EWMA decay time constant (ms). Default: 60_000 */
  errorDecayMs?: number;

  /** Error EWMA multiplier (penalty factor). Default: 10 */
  errorPenalty?: number;

  /** Circuit breaker consecutive failures to open. Default: 5 */
  failureThreshold?: number;

  /** Circuit breaker base open duration. Default: 1_000 */
  openBackoffBaseMs?: number;

  /** Circuit breaker max open duration. Default: 30_000 */
  openBackoffMaxMs?: number;

  /**
   * Stickiness mode.
   * - 'none': pure P2C
   * - 'soft': key picks a preferred backend, but P2C can override if it’s slow/unhealthy
   * Default: 'soft'
   */
  stickiness?: 'none' | 'soft';

  /** Random source (for tests / determinism). Default: secure-ish random if available else Math.random */
  random?: () => number;

  /** Clock (for tests). Default: Date.now */
  now?: () => number;

  /** Optional event hook (metrics/logging). */
  onEvent?: (event: BalancerEvent) => void;
};
