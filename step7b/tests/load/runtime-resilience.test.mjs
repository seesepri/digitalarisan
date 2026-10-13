import assert from 'node:assert/strict';
import test from 'node:test';

const target = process.env.LOAD_TEST_URL || 'http://127.0.0.1:3000/api/health';
const concurrency = Math.max(1, Number(process.env.LOAD_TEST_CONCURRENCY || 20));
const requests = Math.max(concurrency, Number(process.env.LOAD_TEST_REQUESTS || 200));
const maxErrorRate = Number(process.env.LOAD_TEST_MAX_ERROR_RATE || 0.01);

test('runtime smoke/load: health endpoint remains available under concurrent reads', async () => {
  const started = Date.now();
  let completed = 0;
  let errors = 0;
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= requests) return;
      try {
        const response = await fetch(target, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) errors += 1;
      } catch { errors += 1; }
      completed += 1;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const durationMs = Date.now() - started;
  const errorRate = errors / Math.max(1, completed);
  console.log(JSON.stringify({ target, requests: completed, concurrency, errors, errorRate, durationMs, requestsPerSecond: completed / Math.max(durationMs / 1000, 0.001) }));
  assert.ok(errorRate <= maxErrorRate, `error rate ${errorRate} exceeded ${maxErrorRate}`);
});
