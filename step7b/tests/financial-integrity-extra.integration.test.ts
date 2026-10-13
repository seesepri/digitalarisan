import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { configureTestDatabase } from "../scripts/test-database-guard.mjs";
import { eq } from "drizzle-orm";
const url = await configureTestDatabase(); if (!url) throw new Error("Explicit isolated test database required");
const { db, pool } = await import("@/db");
const schema = await import("@/db/schema");
const { runAccountingReconciliation } = await import("@/server/services/reconciliation");
const { acquireJobLease, renewJobLease, completeJob, failJob, manuallyRetryJob } = await import("@/server/services/job-lock");
after(async () => { await pool.end(); });
beforeEach(async () => {
  await pool.query(`DO $$ DECLARE item record; BEGIN FOR item IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP EXECUTE format('TRUNCATE TABLE %I RESTART IDENTITY CASCADE', item.tablename); END LOOP; END $$`);
});

test("an older transaction's timestamp cannot reorder causally later wallet ledger entries", async () => {
  const [user] = await db.insert(schema.users).values({ name: "Synthetic ledger clock fixture", phone: "+6281100011111", passwordHash: "test-only" }).returning();
  const [wallet] = await db.insert(schema.wallets).values({ userId: user.id }).returning();
  const a = await pool.connect(); const b = await pool.connect();
  const credit = async (client: typeof a, amount: number) => {
    const { rows: rows } = await client.query('SELECT available_balance FROM wallets WHERE id=$1 FOR UPDATE', [wallet.id]); const before = Number(rows[0].available_balance); const after = before + amount;
    const { rows: topups } = await client.query("INSERT INTO topups(user_id,wallet_id,amount,provider,provider_reference,idempotency_key,status,expires_at,paid_at) VALUES ($1,$2,$3,'synthetic',$4,$4,'SUCCESS',now()+interval '1 hour',now()) RETURNING id", [user.id, wallet.id, amount, `SYNTHETIC-${randomUUID()}`]);
    await client.query('UPDATE wallets SET available_balance=$2 WHERE id=$1', [wallet.id, after]);
    const { rows: ledger } = await client.query("INSERT INTO wallet_transactions(user_id,wallet_id,type,direction,amount,available_before,available_after,locked_before,locked_after,pending_before,pending_after,reference_type,reference_id,description,idempotency_key) VALUES ($1,$2,'TOPUP','CREDIT',$3,$4,$5,0,0,0,0,'topup',$6,'Synthetic timestamp inversion fixture',$7) RETURNING id,ledger_sequence", [user.id, wallet.id, amount, before, after, topups[0].id, `SYNTHETIC-LEDGER-${randomUUID()}`]);
    return ledger[0];
  };
  try {
    await a.query('BEGIN'); await a.query('SELECT now()');
    await b.query('BEGIN'); const first = await credit(b, 10_000); await b.query('COMMIT');
    const second = await credit(a, 20_000); await a.query('COMMIT');
    assert.ok(Number(first.ledger_sequence) < Number(second.ledger_sequence));
    const { rows } = await pool.query('SELECT old.created_at < newer.created_at AS timestamps_inverted FROM wallet_transactions old CROSS JOIN wallet_transactions newer WHERE old.id=$1 AND newer.id=$2', [second.id, first.id]);
    assert.equal(rows[0].timestamps_inverted, true);
    const result = await runAccountingReconciliation(); assert.equal(result.status, 'PASS', JSON.stringify(result.issues));
  } finally { await a.query('ROLLBACK'); await b.query('ROLLBACK'); a.release(); b.release(); }
});

test("job leases serialize workers, manual retry cannot override an active owner, and stale owners are fenced", async () => {
  const [operator] = await db.insert(schema.users).values({ name: "Synthetic operator", phone: "+6281100022222", passwordHash: "test-only", role: "SUPER_ADMIN", status: "ACTIVE" }).returning();
  const key = `LAB-JOB-${randomUUID()}`;
  const leases = await Promise.all(Array.from({ length: 20 }, () => acquireJobLease({ jobKey: key, maxAttempts: 5, leaseMs: 60_000 })));
  const winners = leases.filter((lease) => lease !== null); assert.equal(winners.length, 1); const original = winners[0]!;
  await assert.rejects(() => manuallyRetryJob(key, operator.id), /lease aktif/);
  await db.update(schema.jobExecutions).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(schema.jobExecutions.id, original.id));
  assert.equal(await renewJobLease(original), false);
  await assert.rejects(() => completeJob(original), /hilang atau kedaluwarsa/);
  const replacement = await acquireJobLease({ jobKey: key, maxAttempts: 5, leaseMs: 60_000 }); assert.ok(replacement);
  assert.notEqual(replacement.leaseToken, original.leaseToken);
  await assert.rejects(() => failJob(original, { errorCode: "STALE", errorMessage: "Synthetic stale worker" }), /hilang atau kedaluwarsa/);
  await failJob(replacement, { errorCode: "FIXTURE", errorMessage: "Synthetic failure" });
  await manuallyRetryJob(key, operator.id);
  const [job] = await db.select().from(schema.jobExecutions).where(eq(schema.jobExecutions.id, original.id)); assert.equal(job.attemptCount, 0);
  const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "JOB_MANUALLY_RETRIED")); assert.equal(logs.length, 1); assert.equal(logs[0].actorId, operator.id);
});

test("generic correction requires a real super-admin, refuses reserved money and binds replay to the original entry", async () => {
  const {createWithdrawal}=await import("@/server/services/wallet");const {reverseWalletTransaction}=await import("@/server/services/ledger");
  const ids=[randomUUID(),randomUUID(),randomUUID()];
  await db.insert(schema.users).values([{id:ids[0],name:"Synthetic operator",phone:"+6281100044001",passwordHash:"test-only",role:"SUPER_ADMIN"},{id:ids[1],name:"Synthetic owner",phone:"+6281100044002",passwordHash:"test-only",kycStatus:"VERIFIED",kycReviewedBy:ids[0]},{id:ids[2],name:"Synthetic other owner",phone:"+6281100044003",passwordHash:"test-only",kycStatus:"VERIFIED",kycReviewedBy:ids[0]}]);
  const seed=async(userId:string,amount:number)=>{
    const [wallet]=await db.insert(schema.wallets).values({userId,availableBalance:amount}).returning();
    const [topup]=await db.insert(schema.topups).values({userId,walletId:wallet.id,amount,provider:"synthetic",providerReference:`SYNTHETIC-${randomUUID()}`,status:"SUCCESS",expiresAt:new Date(),idempotencyKey:`SEED-${randomUUID()}`}).returning();
    const [entry]=await db.insert(schema.walletTransactions).values({userId,walletId:wallet.id,type:"TOPUP",direction:"CREDIT",amount,availableBefore:0,availableAfter:amount,lockedBefore:0,lockedAfter:0,pendingBefore:0,pendingAfter:0,referenceType:"topup",referenceId:topup.id,description:"Synthetic correction fixture",idempotencyKey:`SEED-LEDGER-${randomUUID()}`}).returning();return {wallet,entry};
  };
  const a=await seed(ids[1],50_000);const b=await seed(ids[2],60_000);
  await assert.rejects(()=>reverseWalletTransaction({actorId:ids[1],transactionId:a.entry.id,idempotencyKey:`DENIED-${randomUUID()}`,reason:"Synthetic denied correction"}),/super administrator/);
  const key=`CORRECTION-${randomUUID()}`;await reverseWalletTransaction({actorId:ids[0],transactionId:a.entry.id,idempotencyKey:key,reason:"Synthetic correction"});
  await assert.rejects(()=>reverseWalletTransaction({actorId:ids[0],transactionId:b.entry.id,idempotencyKey:key,reason:"Different synthetic correction"}),/transaksi lain/);
  const wd=await createWithdrawal({userId:ids[2],amount:10_000,bankName:"SYNTHETIC BANK",accountName:"SYNTHETIC",accountNumber:"1234567890",idempotencyKey:`WD-${randomUUID()}`});
  const [reservation]=await db.select().from(schema.walletTransactions).where(eq(schema.walletTransactions.referenceId,wd.withdrawal.id));
  await assert.rejects(()=>reverseWalletTransaction({actorId:ids[0],transactionId:reservation.id,idempotencyKey:`NO-BLIND-REFUND-${randomUUID()}`,reason:"Synthetic forbidden reservation reversal"}),/state machine domain/);
  const [wallet]=await db.select().from(schema.wallets).where(eq(schema.wallets.id,b.wallet.id));assert.equal(wallet.availableBalance,50_000);assert.equal(wallet.pendingBalance,10_000);
});
