import { readFile } from "node:fs/promises";

const file = process.argv[2] || process.env.LOAD_TEST_OUTPUT_FILE;
if (!file) throw new Error("Usage: node scripts/performance/check-budget.mjs <load-result.json>");
const result = JSON.parse(await readFile(file, "utf8"));
const p95 = Number(result.p95Ms);
const errorRate = Number(result.errorRate);
const rps = Number(result.requestsPerSecond);
const maxP95 = Number(process.env.PERF_P95_HEALTH_MS || 300);
const maxErrors = Number(process.env.PERF_MAX_ERROR_RATE || 0.01);
const minRps = Number(process.env.PERF_MIN_RPS || 20);
const failures = [];
if (!(p95 <= maxP95)) failures.push(`p95 ${p95}ms > ${maxP95}ms`);
if (!(errorRate <= maxErrors)) failures.push(`error rate ${errorRate} > ${maxErrors}`);
if (!(rps >= minRps)) failures.push(`RPS ${rps} < ${minRps}`);
console.log(JSON.stringify({ pass: failures.length === 0, budgets: { maxP95, maxErrors, minRps }, observed: { p95, errorRate, rps }, failures }, null, 2));
if (failures.length) process.exit(1);
