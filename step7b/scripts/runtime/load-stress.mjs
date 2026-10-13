const url = process.env.LOAD_TEST_URL || 'http://127.0.0.1:3000/api/health';
const concurrency = Math.max(1, Number(process.env.LOAD_TEST_CONCURRENCY || 50));
const durationMs = Math.max(1000, Number(process.env.LOAD_TEST_DURATION_MS || 30000));
const timeoutMs = Math.max(100, Number(process.env.LOAD_TEST_TIMEOUT_MS || 5000));
const latencies = [];
let total = 0, errors = 0, stop = false;
const deadline = Date.now() + durationMs;
setTimeout(() => { stop = true; }, durationMs).unref();
async function worker() {
  while (!stop && Date.now() < deadline) {
    const started = performance.now();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) errors++;
    } catch { errors++; }
    latencies.push(performance.now() - started);
    total++;
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
latencies.sort((a,b) => a-b);
const percentile = (p) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] : 0;
const result = { url, durationMs, concurrency, total, errors, errorRate: errors / Math.max(total, 1), requestsPerSecond: total / (durationMs / 1000), p50Ms: percentile(0.50), p95Ms: percentile(0.95), p99Ms: percentile(0.99) };
console.log(JSON.stringify(result, null, 2));
if (process.env.LOAD_TEST_OUTPUT_FILE) await import('node:fs/promises').then(({writeFile}) => writeFile(process.env.LOAD_TEST_OUTPUT_FILE, JSON.stringify(result, null, 2)));
if (total === 0 || errors / total > Number(process.env.LOAD_TEST_MAX_ERROR_RATE || 0.01)) process.exitCode = 1;
