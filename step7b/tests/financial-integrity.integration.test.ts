import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomInt, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { configureTestDatabase } from "../scripts/test-database-guard.mjs";
import { and, eq, sql } from "drizzle-orm";

const databaseUrl = await configureTestDatabase();
if (!databaseUrl) throw new Error("Explicit isolated TEST_DATABASE_URL is required");
const { db, pool } = await import("@/db");
const schema = await import("@/db/schema");
const { createWithdrawal, createTopup, reconcileTopupPayment } = await import("@/server/services/wallet");
const { processWithdrawal, executeWithdrawal } = await import("@/server/services/payout-withdrawal");
const { approveWithdrawal } = await import("@/server/services/compliance");
const { stablePayoutReference } = await import("@/server/services/payout-provider");
const { runAccountingReconciliation } = await import("@/server/services/reconciliation");
const { joinPeriod, cancelParticipation } = await import("@/server/services/arisan");
const { POST: webhook } = await import("@/app/api/v1/webhooks/payment/route");
const { POST: refresh } = await import("@/app/api/v1/auth/refresh/route");
const { createRefreshToken, hashToken } = await import("@/server/auth");
const { enforceRateLimit } = await import("@/server/http");

after(async () => { await pool.end(); });
beforeEach(async () => {
  await pool.query(`DO $$ DECLARE item record; BEGIN FOR item IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP EXECUTE format('TRUNCATE TABLE %I RESTART IDENTITY CASCADE', item.tablename); END LOOP; END $$`);
  process.env.PAYOUT_PROVIDER = "lab";
  process.env.PAYOUT_PROVIDER_BASE_URL = "https://provider.example";
  process.env.PAYOUT_PROVIDER_API_KEY = "lab-only-key";
  process.env.PAYMENT_PROVIDER = "lab-payment";
  process.env.PAYMENT_PROVIDER_BASE_URL = "https://payment.example";
  process.env.PAYMENT_PROVIDER_API_KEY = "lab-only-key";
  process.env.PAYMENT_WEBHOOK_SECRET = "lab-only-webhook-secret";
  delete process.env.PAYOUT_PROVIDER_STATUS_PATH;
  delete process.env.PAYOUT_PROVIDER_CREATE_PATH;
  delete process.env.PAYMENT_PROVIDER_STATUS_PATH;
  delete process.env.PAYMENT_PROVIDER_CREATE_PATH;
  process.env.TRUST_PROXY = "false";
});

async function makeUser(balance = 100_000, role: "USER" | "ADMIN" | "SUPER_ADMIN" = "USER") {
  const id = randomUUID();
  const [user] = await db.insert(schema.users).values({ id, name: "Isolated fixture", phone: `+6281${randomInt(1_000_000_000, 9_999_999_999)}`, passwordHash: "test-only", role, status: "ACTIVE", phoneVerifiedAt: new Date(), kycStatus: "VERIFIED", kycReviewedBy: id }).returning();
  const [wallet] = await db.insert(schema.wallets).values({ userId: id, availableBalance: balance }).returning();
  if (balance) {
    const [topup] = await db.insert(schema.topups).values({ userId: id, walletId: wallet.id, amount: balance, provider: "fixture", providerReference: `FIXTURE-${id}`, idempotencyKey: `FIXTURE-${id}`, status: "SUCCESS", expiresAt: new Date(Date.now() + 60_000), paidAt: new Date() }).returning();
    await db.insert(schema.walletTransactions).values({ userId: id, walletId: wallet.id, type: "TOPUP", direction: "CREDIT", amount: balance, availableBefore: 0, availableAfter: balance, lockedBefore: 0, lockedAfter: 0, pendingBefore: 0, pendingAfter: 0, referenceType: "topup", referenceId: topup.id, description: "Synthetic fixture funding; not a real payment", idempotencyKey: `FIXTURE-LEDGER-${id}` });
  }
  return { user, wallet };
}
async function prepared(start = true) {
  const owner = await makeUser(); const maker = await makeUser(0, "ADMIN"); const checker = await makeUser(0, "ADMIN");
  const input = { userId: owner.user.id, amount: 25_000, bankName: "LAB BANK", accountName: "Synthetic fixture", accountNumber: "1234567890", idempotencyKey: `WD-${randomUUID()}` };
  const created = await createWithdrawal(input);
  await approveWithdrawal({ withdrawalId: created.withdrawal.id, adminId: maker.user.id, reason: "Isolated fixture approval" });
  if (start) await processWithdrawal({ withdrawalId: created.withdrawal.id, decision: "PROCESSING", adminId: checker.user.id, adminRole: "ADMIN" });
  return { ...owner, id: created.withdrawal.id, maker, checker, input };
}
function evidence(id: string, status: "SUCCESS" | "FAILED_RETRYABLE" | "FAILED_FINAL" = "SUCCESS", overrides: Record<string, unknown> = {}) {
  return { provider: "lab", reference: stablePayoutReference(id), providerReference: `EXTERNAL-${id}`, amount: 25_000, currency: "IDR" as const, status, failureConfirmed: status !== "SUCCESS", checkedAt: new Date().toISOString(), ...overrides };
}
async function snapshot(id: string) {
  const [withdrawal] = await db.select().from(schema.withdrawals).where(eq(schema.withdrawals.id, id));
  const [wallet] = await db.select().from(schema.wallets).where(eq(schema.wallets.id, withdrawal.walletId));
  const ledger = await db.select().from(schema.walletTransactions).where(and(eq(schema.walletTransactions.referenceType, "withdrawal"), eq(schema.walletTransactions.referenceId, id))).orderBy(schema.walletTransactions.ledgerSequence);
  return { withdrawal, wallet, ledger };
}
async function withFetch<T>(fn: typeof fetch, work: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch; globalThis.fetch = fn;
  try { return await work(); } finally { globalThis.fetch = original; }
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const hasCode = (code: string) => (error: unknown) => error !== null && typeof error === "object" && "code" in error && error.code === code;

test("a provider source flag without verified evidence cannot finalize or move money", async () => {
  const w = await prepared();
  await assert.rejects(() => processWithdrawal({ withdrawalId: w.id, decision: "SUCCESS", source: "PROVIDER", adminRole: "SYSTEM", expectedAttemptCount: 1 }), hasCode("PAYOUT_PROVIDER_EVIDENCE_REQUIRED"));
  const after = await snapshot(w.id); assert.equal(after.withdrawal.status, "PROCESSING"); assert.equal(after.wallet.pendingBalance, 25_000); assert.equal(after.ledger.length, 1);
});

test("20 concurrent confirmed completions preserve external reference and debit pending exactly once", async () => {
  const w = await prepared(); const proof = evidence(w.id);
  const results = await Promise.all(Array.from({ length: 20 }, () => processWithdrawal({ withdrawalId: w.id, decision: "SUCCESS", source: "PROVIDER", adminRole: "SYSTEM", providerEvidence: proof, expectedAttemptCount: 1 })));
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  const after = await snapshot(w.id); assert.equal(after.withdrawal.providerReference, proof.providerReference); assert.equal(after.wallet.pendingBalance, 0); assert.equal(after.wallet.availableBalance, 75_000); assert.equal(after.ledger.length, 2);
  const attempts = await db.select().from(schema.withdrawalAttempts).where(eq(schema.withdrawalAttempts.withdrawalId, w.id));
  assert.equal(attempts.filter((attempt) => attempt.toStatus === "SUCCESS" && attempt.providerReference === proof.providerReference).length, 1);
});

test("20 concurrent confirmed failures refund exactly once with terminal metadata", async () => {
  const w = await prepared(); const proof = evidence(w.id, "FAILED_FINAL");
  const results = await Promise.all(Array.from({ length: 20 }, () => processWithdrawal({ withdrawalId: w.id, decision: "FAILED_FINAL", source: "PROVIDER", adminRole: "SYSTEM", providerEvidence: proof, expectedAttemptCount: 1 })));
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  const after = await snapshot(w.id); assert.equal(after.wallet.availableBalance, 100_000); assert.equal(after.wallet.pendingBalance, 0); assert.equal(after.ledger.filter((entry) => entry.type === "REFUND").length, 1); assert.equal(after.withdrawal.lastErrorCode, "PROVIDER_FINAL_FAILURE"); assert.equal(after.withdrawal.nextRetryAt, null);
});

test("unconfirmed failure followed by 404 holds funds and does not pretend FAILED_FINAL", async () => {
  const w = await prepared(false); let posts = 0;
  await withFetch(async (_url, init) => {
    if (init?.method === "POST") { posts++; return response(evidence(w.id, "FAILED_FINAL", { failureConfirmed: false })); }
    return response({}, 404);
  }, async () => {
    await assert.rejects(() => executeWithdrawal({ withdrawalId: w.id, adminId: w.checker.user.id, adminRole: "ADMIN" }), hasCode("PAYOUT_AMBIGUOUS"));
  });
  const after = await snapshot(w.id); assert.equal(posts, 1); assert.equal(after.withdrawal.status, "PROCESSING"); assert.equal(after.wallet.pendingBalance, 25_000); assert.equal(after.wallet.availableBalance, 75_000); assert.equal(after.ledger.length, 1);
});

test("in-flight duplicate executors seeing 404 never re-submit another payout", async (t) => {
  const w = await prepared(false); let posts = 0; let signalStarted!: () => void; let release!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; }); t.after(() => release());
  await withFetch(async (_url, init) => {
    if (init?.method === "POST") { posts++; signalStarted(); await gate; return response(evidence(w.id)); }
    return response({}, 404);
  }, async () => {
    const first = executeWithdrawal({ withdrawalId: w.id, adminId: w.checker.user.id, adminRole: "ADMIN" });
    await started;
    const duplicates = await Promise.all(Array.from({ length: 10 }, () => executeWithdrawal({ withdrawalId: w.id, adminId: w.checker.user.id, adminRole: "ADMIN" })));
    assert.equal(posts, 1); assert.ok(duplicates.every((result) => result.status === "PROCESSING"));
    release(); assert.equal((await first).status, "SUCCESS");
  });
  assert.equal((await snapshot(w.id)).ledger.length, 2);
});

test("timeout after provider accepted payout is recovered by inquiry, not another create", async () => {
  const w = await prepared(false); let posts = 0; let gets = 0;
  await withFetch(async (_url, init) => {
    if (init?.method === "POST") { posts++; throw new Error("simulated lost response after external acceptance"); }
    gets++; return response(evidence(w.id));
  }, async () => { assert.equal((await executeWithdrawal({ withdrawalId: w.id, adminId: w.checker.user.id, adminRole: "ADMIN" })).status, "SUCCESS"); });
  const after = await snapshot(w.id); assert.equal(posts, 1); assert.equal(gets, 1); assert.equal(after.wallet.pendingBalance, 0); assert.equal(after.ledger.length, 2);
});

test("retry deadline is enforced by both service and PostgreSQL; stale attempt evidence is rejected", async () => {
  const w = await prepared();
  await processWithdrawal({ withdrawalId: w.id, decision: "FAILED_RETRYABLE", source: "PROVIDER", adminRole: "SYSTEM", providerEvidence: evidence(w.id, "FAILED_RETRYABLE"), expectedAttemptCount: 1 });
  await assert.rejects(() => processWithdrawal({ withdrawalId: w.id, decision: "PROCESSING", adminId: w.checker.user.id, adminRole: "ADMIN" }), hasCode("WITHDRAWAL_RETRY_NOT_DUE"));
  await assert.rejects(() => pool.query("UPDATE withdrawals SET status='PROCESSING',attempt_count=2,next_retry_at=NULL,last_error_code=NULL,last_error_message=NULL WHERE id=$1", [w.id]), /WITHDRAWAL_RETRY_NOT_DUE/);
  // Advance ONLY this synthetic fixture's recorded deadline; never touch a real transaction.
  await db.update(schema.withdrawals).set({ nextRetryAt: new Date(Date.now() - 1000) }).where(eq(schema.withdrawals.id, w.id));
  await processWithdrawal({ withdrawalId: w.id, decision: "PROCESSING", adminId: w.checker.user.id, adminRole: "ADMIN" });
  await assert.rejects(() => processWithdrawal({ withdrawalId: w.id, decision: "SUCCESS", source: "PROVIDER", adminRole: "SYSTEM", providerEvidence: evidence(w.id), expectedAttemptCount: 1 }), hasCode("WITHDRAWAL_STALE_ATTEMPT"));
  assert.equal((await snapshot(w.id)).wallet.pendingBalance, 25_000);
});

test("same withdrawal key cannot change recipient and maker/checker cannot be the beneficiary", async () => {
  const w = await prepared(false);
  await assert.rejects(() => createWithdrawal({ ...w.input, accountNumber: "9999999999" }), hasCode("IDEMPOTENCY_CONFLICT"));
  await assert.rejects(() => executeWithdrawal({ withdrawalId: w.id, adminId: w.maker.user.id, adminRole: "ADMIN" }), hasCode("MAKER_CHECKER_SEPARATION_REQUIRED"));
  await assert.rejects(() => approveWithdrawal({ withdrawalId: w.id, adminId: w.user.id }), hasCode("FORBIDDEN"));
  await assert.rejects(() => createWithdrawal({ ...w.input, idempotencyKey: `NEW-${randomUUID()}`, accountName: "enc:v1:invalid" }), hasCode("VALIDATION_ERROR"));
  await assert.rejects(() => pool.query("UPDATE withdrawals SET account_number='9999999999' WHERE id=$1", [w.id]), /WITHDRAWAL_FINANCIAL_IDENTITY_IMMUTABLE/);
  const after = await snapshot(w.id); assert.equal(after.wallet.pendingBalance, 25_000); assert.equal(after.ledger.length, 1);
});

test("deferred reservation invariants, cross-owner FK and safe money constraints fail closed", async () => {
  const a = await makeUser(); const b = await makeUser();
  await assert.rejects(() => pool.query('UPDATE wallets SET pending_balance=1 WHERE id=$1', [a.wallet.id]), /WALLET_PENDING_WITHDRAWAL_MISMATCH/);
  await assert.rejects(() => pool.query('UPDATE wallets SET locked_balance=1 WHERE id=$1', [a.wallet.id]), /WALLET_LOCKED_RESERVATION_MISMATCH/);
  await assert.rejects(() => db.insert(schema.topups).values({ userId: b.user.id, walletId: a.wallet.id, amount: 10_000, provider: "fixture", idempotencyKey: `OWNER-${randomUUID()}`, expiresAt: new Date() }), (error: unknown) => error instanceof Error && error.cause !== undefined && hasCode("23503")(error.cause));
  await assert.rejects(() => pool.query("UPDATE wallets SET available_balance=9007199254740992 WHERE id=$1", [a.wallet.id]), /safe_money/);
  await assert.rejects(() => db.update(schema.wallets).set({ availableBalance: Number.MAX_SAFE_INTEGER + 1 }).where(eq(schema.wallets.id, a.wallet.id)), /UNSAFE_MONEY_VALUE/);
  const [wallet] = await db.select().from(schema.wallets).where(eq(schema.wallets.id, a.wallet.id)); assert.equal(wallet.availableBalance, 100_000); assert.equal(wallet.pendingBalance, 0);
});

async function period() {
  const now = Date.now();
  const [type] = await db.insert(schema.arisanTypes).values({ name: `Lab ${randomUUID()}`, contributionAmount: 10_000, minimumParticipants: 2, maximumParticipants: 5, cancellationDeadlineDays: 1 }).returning();
  const [row] = await db.insert(schema.arisanPeriods).values({ typeId: type.id, code: `LAB-${randomUUID()}`, contributionAmount: 10_000, minimumParticipants: 2, maximumParticipants: 5, registrationStartsAt: new Date(now - 60_000), registrationEndsAt: new Date(now + 60_000), drawingAt: new Date(now + 180_000), cancellationDeadlineAt: new Date(now + 120_000), status: "OPEN" }).returning(); return row;
}
test("join and cancellation replay keys bind to the exact period and participant", async () => {
  const u = await makeUser(); const a = await period(); const b = await period(); const key = `JOIN-${randomUUID()}`;
  const first = await joinPeriod({ userId: u.user.id, periodId: a.id, idempotencyKey: key });
  await assert.rejects(() => joinPeriod({ userId: u.user.id, periodId: b.id, idempotencyKey: key }), hasCode("IDEMPOTENCY_CONFLICT"));
  const second = await joinPeriod({ userId: u.user.id, periodId: b.id, idempotencyKey: `JOIN-${randomUUID()}` });
  const cancelKey = `CANCEL-${randomUUID()}`;
  await cancelParticipation({ userId: u.user.id, participantId: first.participantId!, idempotencyKey: cancelKey });
  await assert.rejects(() => cancelParticipation({ userId: u.user.id, participantId: second.participantId!, idempotencyKey: cancelKey }), hasCode("IDEMPOTENCY_CONFLICT"));
});

function signedWebhook(reference: string, eventId: string, status = "PAID", amount = 25_000) {
  const raw = JSON.stringify({ reference, eventId, status, amount, currency: "IDR" }); const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", process.env.PAYMENT_WEBHOOK_SECRET!).update(`${timestamp}.${raw}`).digest("hex");
  return new Request("https://app.example/api/v1/webhooks/payment", { method: "POST", body: raw, headers: { "x-payment-signature": signature, "x-payment-timestamp": timestamp } });
}
test("early signed webhook before checkout persistence credits once and stale events cannot downgrade", async () => {
  const u = await makeUser(0); let posts = 0; let reference = "";
  await withFetch(async (_url, init) => {
    posts++; const body = JSON.parse(String(init?.body)); reference = body.reference;
    const result = await webhook(signedWebhook(reference, "EARLY-PAID")); assert.equal(result.status, 200);
    return response({ providerReference: `PAY-${reference}`, checkoutUrl: "https://payment.example/checkout" });
  }, async () => { const result = await createTopup({ userId: u.user.id, amount: 25_000, idempotencyKey: `TOPUP-${randomUUID()}`, callbackUrl: "https://app.example/return" }); assert.equal(result.topup.status, "SUCCESS"); });
  assert.equal(posts, 1);
  assert.equal((await webhook(signedWebhook(reference, "EARLY-PAID"))).status, 200);
  assert.equal((await webhook(signedWebhook(reference, "STALE-PROCESSING", "PROCESSING"))).status, 200);
  const [wallet] = await db.select().from(schema.wallets).where(eq(schema.wallets.id, u.wallet.id)); assert.equal(wallet.availableBalance, 25_000);
  assert.equal((await db.select().from(schema.walletTransactions).where(eq(schema.walletTransactions.walletId, u.wallet.id))).length, 1);
});

test("25 duplicate top-up intents serialize creation and make one external create", async () => {
  const u = await makeUser(0); const key = `TOPUP-${randomUUID()}`; let posts = 0;
  await withFetch(async (url, init) => {
    if (init?.method === "POST") { posts++; const body = JSON.parse(String(init.body)); return response({ providerReference: `PAY-${body.reference}`, checkoutUrl: "https://payment.example/checkout" }); }
    assert.match(String(url), /\/payments\//); return response({}, 404);
  }, async () => {
    const results = await Promise.all(Array.from({ length: 25 }, () => createTopup({ userId: u.user.id, amount: 25_000, idempotencyKey: key, callbackUrl: "https://app.example/return" })));
    assert.equal(new Set(results.map((result) => result.topup.id)).size, 1);
  });
  assert.equal(posts, 1); assert.equal((await db.select().from(schema.topups)).length, 1);
});

test("reconciliation rejects mismatched amount/currency and permits verified late PAID after expiry", async () => {
  const u = await makeUser(0); const [topup] = await db.insert(schema.topups).values({ userId: u.user.id, walletId: u.wallet.id, amount: 25_000, provider: "lab-payment", idempotencyKey: `LATE-${randomUUID()}`, status: "EXPIRED", expiresAt: new Date(Date.now() - 1000) }).returning();
  for (const invalid of [{ amount: 1, currency: "IDR" }, { amount: 25_000, currency: "USD" }]) {
    await withFetch(async () => response({ reference: topup.id, providerReference: `PAY-${topup.id}`, status: "PAID", ...invalid }), async () => { await assert.rejects(() => reconcileTopupPayment({ topupId: topup.id })); });
  }
  await withFetch(async () => response({ reference: topup.id, providerReference: `PAY-${topup.id}`, status: "PAID", amount: 25_000, currency: "IDR" }), async () => {
    assert.equal((await reconcileTopupPayment({ topupId: topup.id })).topup.status, "SUCCESS");
    assert.equal((await reconcileTopupPayment({ topupId: topup.id })).replayed, true);
  });
  const [wallet] = await db.select().from(schema.wallets).where(eq(schema.wallets.id, u.wallet.id)); assert.equal(wallet.availableBalance, 25_000);
});

test("audit sequence is allocated after the serialization lock, preserving the hash chain", async () => {
  const a = await pool.connect(); const b = await pool.connect();
  try {
    await a.query("BEGIN"); await a.query("SELECT pg_advisory_xact_lock(84721931)");
    const { rows } = await b.query("SELECT pg_backend_pid() AS pid");
    const waiting = b.query("INSERT INTO audit_logs(actor_type,action,entity_type) VALUES ('SYSTEM','WAITING_INSERT','fixture')");
    let blocked = false;
    for (let n = 0; n < 100 && !blocked; n++) {
      const status = await pool.query("SELECT wait_event FROM pg_stat_activity WHERE pid=$1", [rows[0].pid]); blocked = status.rows[0]?.wait_event === "advisory";
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(blocked, true, "second insertion must wait inside its integrity trigger");
    await a.query("INSERT INTO audit_logs(actor_type,action,entity_type) VALUES ('SYSTEM','LOCK_OWNER_INSERT','fixture')"); await a.query("COMMIT"); await waiting;
    const result = await pool.query("SELECT sequence_no, action, prev_hash, entry_hash FROM audit_logs ORDER BY sequence_no");
    assert.equal(result.rows[0].action, "LOCK_OWNER_INSERT"); assert.equal(result.rows[1].action, "WAITING_INSERT"); assert.equal(result.rows[1].prev_hash, result.rows[0].entry_hash);
    execFileSync(process.execPath, ["scripts/security/verify-audit-integrity.mjs"], { env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe" });
  } finally { await a.query("ROLLBACK"); a.release(); b.release(); }
});

test("subject rate limits cannot be bypassed by changing proxy IP", async () => {
  process.env.TRUST_PROXY = "true";
  const action = `IDENTIFIER-${randomUUID()}`;
  await enforceRateLimit(new Request("https://app.example", { headers: { "x-forwarded-for": "192.0.2.1" } }), action, 1, 60_000, "same-identifier");
  await assert.rejects(() => enforceRateLimit(new Request("https://app.example", { headers: { "x-forwarded-for": "192.0.2.2" } }), action, 1, 60_000, "same-identifier"), hasCode("RATE_LIMITED"));
});

test("parallel refresh rejects the losing request without revoking the new session; later reuse revokes its family", async () => {
  const u = await makeUser(0); const token = createRefreshToken(); const unrelated = createRefreshToken();
  const [old] = await db.insert(schema.userSessions).values({ userId: u.user.id, refreshTokenHash: hashToken(token), expiresAt: new Date(Date.now() + 60_000) }).returning();
  const [other] = await db.insert(schema.userSessions).values({ userId: u.user.id, refreshTokenHash: hashToken(unrelated), expiresAt: new Date(Date.now() + 60_000) }).returning();
  const request = () => new Request("https://app.example/api/v1/auth/refresh", { method: "POST", headers: { origin: "https://app.example", cookie: `refresh_token=${token}` } });
  const results = await Promise.all([refresh(request()), refresh(request())]); assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const [rotated] = await db.select().from(schema.userSessions).where(eq(schema.userSessions.id, old.id)); assert.ok(rotated.rotatedToSessionId);
  const [child] = await db.select().from(schema.userSessions).where(eq(schema.userSessions.id, rotated.rotatedToSessionId!)); assert.equal(child.revokedAt, null);
  await db.update(schema.userSessions).set({ revokedAt: new Date(Date.now() - 10_000) }).where(eq(schema.userSessions.id, old.id));
  assert.equal((await refresh(request())).status, 401);
  const [revokedChild] = await db.select().from(schema.userSessions).where(eq(schema.userSessions.id, child.id)); assert.ok(revokedChild.revokedAt);
  const [otherAfter] = await db.select().from(schema.userSessions).where(eq(schema.userSessions.id, other.id)); assert.equal(otherAfter.revokedAt, null);
  const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "REFRESH_TOKEN_REUSE_DETECTED")); assert.equal(logs.length, 1);
});

test("accounting audit never auto-finalizes money; explicit super-admin recovery is evidence-bound", async () => {
  const w = await prepared(); const operator = await makeUser(0, "SUPER_ADMIN");
  await withFetch(async () => response(evidence(w.id)), async () => {
    const audit = await runAccountingReconciliation(); assert.equal(audit.status, "FAIL"); assert.ok(audit.issues.some((issue) => issue.code === "PROVIDER_SUCCESS_DB_PROCESSING"));
    assert.equal((await snapshot(w.id)).withdrawal.status, "PROCESSING");
    await assert.rejects(() => runAccountingReconciliation({ recoverProviderSuccess: true, recoveryActorId: w.checker.user.id }), hasCode("FORBIDDEN"));
    await runAccountingReconciliation({ recoverProviderSuccess: true, recoveryActorId: operator.user.id }); assert.equal((await snapshot(w.id)).withdrawal.status, "SUCCESS");
    const clean = await runAccountingReconciliation(); assert.equal(clean.status, "PASS", JSON.stringify(clean.issues));
  });
});

test("application database role cannot mutate/truncate ledgers, disable triggers or own migration objects", async () => {
  execFileSync("psql", [databaseUrl!, "-v", "ON_ERROR_STOP=1", "-f", "scripts/deploy/db-role-setup.sql"], { stdio: "pipe" });
  const client = await pool.connect();
  try {
    await client.query("SET ROLE digital_arisan_app");
    await client.query("INSERT INTO audit_logs(actor_type,action,entity_type) VALUES ('SYSTEM','LEAST_PRIVILEGE_INSERT','fixture')");
    for (const statement of ["UPDATE audit_logs SET action='tamper'", "DELETE FROM wallet_transactions", "TRUNCATE financial_transactions", "ALTER TABLE audit_logs DISABLE TRIGGER ALL", "SET session_replication_role=replica", "CREATE TABLE public.app_should_not_create(id int)", "SELECT * FROM drizzle.__drizzle_migrations"]) {
      await assert.rejects(() => client.query(statement), (error: unknown) => hasCode("42501")(error));
    }
  } finally { await client.query("RESET ROLE"); client.release(); }
});

test("logout of an old rotated token also revokes its successor but preserves other device families", async () => {
  const { POST: logout } = await import("@/app/api/v1/auth/logout/route");
  const u = await makeUser(0); const token = createRefreshToken();
  const [old] = await db.insert(schema.userSessions).values({ userId: u.user.id, refreshTokenHash: hashToken(token), expiresAt: new Date(Date.now()+60_000) }).returning();
  const [other] = await db.insert(schema.userSessions).values({ userId: u.user.id, refreshTokenHash: hashToken(createRefreshToken()), expiresAt: new Date(Date.now()+60_000) }).returning();
  const request = (path: string) => new Request(`https://app.example${path}`, { method: "POST", headers: { origin: "https://app.example", cookie: `refresh_token=${token}` } });
  assert.equal((await refresh(request("/api/v1/auth/refresh"))).status, 200);
  const [rotated] = await db.select().from(schema.userSessions).where(eq(schema.userSessions.id, old.id));
  assert.equal((await logout(request("/api/v1/auth/logout"))).status, 200);
  const [child] = await db.select().from(schema.userSessions).where(eq(schema.userSessions.id, rotated.rotatedToSessionId!)); assert.ok(child.revokedAt); assert.equal(child.revocationReason,"LOGOUT");
  const [otherAfter] = await db.select().from(schema.userSessions).where(eq(schema.userSessions.id, other.id)); assert.equal(otherAfter.revokedAt,null);
});

test("an inactive or no-longer-verified beneficiary cannot initiate a new external payout", async () => {
  const w = await prepared(false); await db.update(schema.users).set({ status: "SUSPENDED" }).where(eq(schema.users.id,w.user.id)); let called = false;
  await withFetch(async () => { called=true; return response(evidence(w.id)); }, async () => { await assert.rejects(() => executeWithdrawal({ withdrawalId:w.id,adminId:w.checker.user.id,adminRole:"ADMIN" }),hasCode("WITHDRAWAL_BENEFICIARY_INELIGIBLE")); });
  assert.equal(called,false); assert.equal((await snapshot(w.id)).withdrawal.status,"PENDING"); assert.equal((await snapshot(w.id)).wallet.pendingBalance,25_000);
});
