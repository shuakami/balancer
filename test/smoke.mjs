import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { LoadBalancer } from '../dist/index.js';

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    (async () => {
      await delay(timeoutMs);
      throw new Error(`Smoke test timeout after ${timeoutMs}ms`);
    })(),
  ]);
}

const balancer = new LoadBalancer([{ id: 'a' }, { id: 'b' }]);

for (let i = 0; i < 20; i++) {
  const id = await withTimeout(
    balancer.run(
      { key: `user-${i}` },
      async (backend) => backend.id,
      { maxAttempts: 1, timeoutMs: 1000 }
    ),
    2000
  );
  assert.ok(id === 'a' || id === 'b', `unexpected backend id: ${String(id)}`);
}

console.log('smoke test passed');
