import { Client } from "pg";

if (process.env.PERF_BENCHMARK_ALLOW !== "true") {
  console.error("Refusing benchmark: set PERF_BENCHMARK_ALLOW=true and point DATABASE_URL to staging/test.");
  process.exit(2);
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const repeats = Number(process.env.PERF_BENCHMARK_REPEATS || 7);
if (!Number.isInteger(repeats) || repeats < 3 || repeats > 50) throw new Error("PERF_BENCHMARK_REPEATS must be an integer between 3 and 50");
const statementTimeout = Number(process.env.PERF_STATEMENT_TIMEOUT_MS || 5000);
const client = new Client({ connectionString: process.env.DATABASE_URL, statement_timeout: statementTimeout });
await client.connect();

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
};

function summarizePlan(node, totals = { rowsExaminedEstimate: 0, scans: {}, sorts: 0, tempReadBlocks: 0, tempWrittenBlocks: 0 }) {
  const loops = Number(node["Actual Loops"] ?? 1);
  const actualRows = Number(node["Actual Rows"] ?? 0) * loops;
  const removedRows = Number(node["Rows Removed by Filter"] ?? 0) * loops;
  if (node["Node Type"]?.includes("Scan")) totals.rowsExaminedEstimate += actualRows + removedRows;
  totals.scans[node["Node Type"]] = (totals.scans[node["Node Type"]] ?? 0) + 1;
  if (node["Node Type"]?.includes("Sort")) totals.sorts++;
  totals.tempReadBlocks += Number(node["Temp Read Blocks"] ?? 0);
  totals.tempWrittenBlocks += Number(node["Temp Written Blocks"] ?? 0);
  for (const child of node.Plans ?? []) summarizePlan(child, totals);
  return totals;
}

function rootBuffers(node) {
  return {
    sharedHitBlocks: Number(node["Shared Hit Blocks"] ?? 0),
    sharedReadBlocks: Number(node["Shared Read Blocks"] ?? 0),
    sharedDirtiedBlocks: Number(node["Shared Dirtied Blocks"] ?? 0),
    sharedWrittenBlocks: Number(node["Shared Written Blocks"] ?? 0),
  };
}

try {
  await client.query("BEGIN READ ONLY");
  const { rows: users } = await client.query("SELECT id FROM users ORDER BY created_at DESC, id DESC LIMIT 1");
  const { rows: periods } = await client.query("SELECT id FROM arisan_periods ORDER BY drawing_at ASC, id ASC LIMIT 1");
  const { rows: wallets } = await client.query("SELECT id FROM wallets ORDER BY created_at ASC, id ASC LIMIT 1");
  const userId = users[0]?.id ?? null;
  const periodId = periods[0]?.id ?? null;
  const walletId = wallets[0]?.id ?? null;
  const cases = [
    ["dashboard_wallet", `SELECT available_balance, locked_balance, pending_balance FROM wallets WHERE user_id = $1 LIMIT 1`, [userId]],
    ["dashboard_memberships", `SELECT ap.id, ap.period_id, p.drawing_at FROM arisan_participants ap JOIN arisan_periods p ON p.id=ap.period_id WHERE ap.user_id=$1 AND ap.status IN ('ACTIVE','WINNER','COMPLETED') ORDER BY p.drawing_at DESC LIMIT 10`, [userId]],
    ["dashboard_recent_transactions", `SELECT id, created_at FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 5`, [userId]],
    ["dashboard_transactions_tab", `SELECT id, created_at FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 31`, [userId]],
    ["dashboard_unread_notifications", `SELECT count(*)::int FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [userId]],
    ["catalog_period_listing", `SELECT p.id, p.drawing_at, count(ap.id)::int AS participant_count FROM arisan_periods p JOIN arisan_types t ON t.id=p.type_id AND t.active=true LEFT JOIN arisan_participants ap ON ap.period_id=p.id AND ap.status='ACTIVE' WHERE p.status <> 'CANCELLED' GROUP BY p.id ORDER BY p.drawing_at ASC, p.id ASC LIMIT 21`, []],
    ["settlement_active_participants", `SELECT id, user_id, contribution_amount, joined_at FROM arisan_participants WHERE period_id=$1 AND status='ACTIVE' AND eligible_for_drawing=true ORDER BY joined_at, id`, [periodId]],
    ["settlement_wallet_reservations", `SELECT id, wallet_id, participant_id, amount FROM wallet_reservations WHERE period_id=$1 AND status='ACTIVE' ORDER BY participant_id`, [periodId]],
    ["settlement_active_reservations_by_wallet", `SELECT wallet_id, sum(amount)::bigint AS locked_total FROM wallet_reservations WHERE wallet_id=$1 AND status='ACTIVE' GROUP BY wallet_id`, [walletId]],
    ["reconciliation_wallet_ledger", `SELECT id, created_at, available_before, available_after, locked_before, locked_after, pending_before, pending_after FROM wallet_transactions WHERE wallet_id=$1 ORDER BY created_at, id`, [walletId]],
    ["reconciliation_active_reservations", `SELECT wallet_id, sum(amount)::bigint FROM wallet_reservations WHERE status='ACTIVE' GROUP BY wallet_id`, []],
    ["reconciliation_financial_ledger", `SELECT account_id, id, created_at, balance_before, balance_after FROM financial_transactions ORDER BY account_id, created_at, id`, []],
    ["retry_withdrawals", `SELECT id FROM withdrawals WHERE status='FAILED_RETRYABLE' AND next_retry_at <= now() ORDER BY next_retry_at ASC LIMIT 100`, []],
  ];
  const results = [];
  const unavailableCases = [];
  for (const [name, query, params] of cases) {
    if (params.some((value) => value === null)) {
      unavailableCases.push({ name, reason: "No representative user, period, or wallet row exists." });
      continue;
    }
    const samples = [];
    let representativePlan;
    for (let sample = 0; sample < repeats + 1; sample++) {
      const started = performance.now();
      const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, params);
      const transactionElapsedMs = performance.now() - started;
      const explain = rows[0]["QUERY PLAN"][0];
      if (sample === 0) { representativePlan = explain; continue; } // warm-up
      samples.push({
        executionTimeMs: Number(explain["Execution Time"]),
        planningTimeMs: Number(explain["Planning Time"]),
        wallElapsedMs: transactionElapsedMs,
        ...rootBuffers(explain.Plan),
        ...summarizePlan(explain.Plan),
      });
    }
    results.push({
      name,
      repetitions: repeats,
      statementsPerSample: 1,
      executionTimeMs: { p50: percentile(samples.map((s) => s.executionTimeMs), 0.50), p95: percentile(samples.map((s) => s.executionTimeMs), 0.95) },
      planningTimeMs: { p50: percentile(samples.map((s) => s.planningTimeMs), 0.50), p95: percentile(samples.map((s) => s.planningTimeMs), 0.95) },
      isolatedStatementWallMs: { p50: percentile(samples.map((s) => s.wallElapsedMs), 0.50), p95: percentile(samples.map((s) => s.wallElapsedMs), 0.95) },
      planMetrics: samples.at(-1),
      plan: representativePlan.Plan,
    });
  }
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    database: "staging-or-test",
    safety: "Read-only transaction; EXPLAIN ANALYZE executes each SELECT. Use only a staging/test database with representative data.",
    repeats,
    queryCountScope: "One measured SQL statement per sample. This is not an HTTP request query count or write-transaction duration.",
    unavailableCases,
    results,
  }, null, 2));
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await client.end();
}
