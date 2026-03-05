# @sdjz/balacer

A **Vercel Edge / Vercel Serverless / Node 18+** compatible load balancer library.

Core strategy:

- **P2C (Power of Two Choices)**: O(1) selection with near-optimal distribution quality.
- **Peak EWMA** latency: reacts quickly to tail latency spikes.
- **inflight (least-loaded)**: avoids pushing traffic to already-queued instances.
- **Error EWMA + Circuit Breaker**: penalize unhealthy instances and open circuits with exponential backoff.
- **Soft stickiness (Jump Consistent Hash)**: session affinity that still escapes slow/unhealthy nodes.

## Install

```bash
npm i @sdjz/balacer
```

## Usage (HTTP / fetch)

```ts
import { LoadBalancer } from '@sdjz/balacer';

const balancer = new LoadBalancer([
  { id: 'a', url: 'https://a.example.com', weight: 2, maxInflight: 64, pools: ['chat'] },
  { id: 'b', url: 'https://b.example.com', weight: 1, maxInflight: 32, pools: ['chat'] },
]);

export default async function handler(req: Request): Promise<Response> {
  const userId = req.headers.get('x-user-id') ?? 'anon';
  const body = await req.text();

  return balancer.fetch(
    { key: userId, pool: 'chat' },
    '/v1/infer',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body },
    { timeoutMs: 20_000, retries: 1, hedgeAfterMs: 400 }
  );
}
```

## Usage (custom task)

```ts
const out = await balancer.run(
  { key: 'user-123' },
  async (backend, { signal }) => {
    return myRpcCall(backend.meta?.endpoint as string, { signal });
  },
  { maxAttempts: 2, timeoutMs: 10_000 }
);
```

## Build

```bash
npm run build
```

## Test

```bash
npm test
```

MIT License.
