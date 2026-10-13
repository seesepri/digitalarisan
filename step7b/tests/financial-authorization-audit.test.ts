import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

test("financial mutation routes require authenticated ownership or privileged authorization", () => {
  const userOwned = [
    "src/app/api/v1/wallet/topups/route.ts",
    "src/app/api/v1/wallet/withdrawals/route.ts",
    "src/app/api/v1/arisan/periods/[id]/join/route.ts",
    "src/app/api/v1/arisan/participants/[id]/cancel/route.ts",
  ];
  for (const file of userOwned) {
    const source = read(file);
    assert.match(source, /requireUser/);
    assert.match(source, /assertSameOrigin/);
    assert.match(source, /getIdempotencyKey/);
  }

  const adminMutations = [
    "src/app/api/v1/admin/withdrawals/[id]/approve/route.ts",
    "src/app/api/v1/admin/withdrawals/[id]/execute/route.ts",
    "src/app/api/v1/admin/withdrawals/[id]/process/route.ts",
    "src/app/api/v1/admin/withdrawals/[id]/retry/route.ts",
    "src/app/api/v1/admin/compliance/flags/[id]/route.ts",
    "src/app/api/v1/admin/arisan/periods/[id]/draw/route.ts",
  ];
  for (const file of adminMutations) {
    const source = read(file);
    assert.match(source, /requireAdmin/);
    assert.match(source, /assertSameOrigin/);
  }
});

test("monetary configuration endpoints are restricted to SUPER_ADMIN", () => {
  for (const file of [
    "src/app/api/v1/admin/arisan/types/route.ts",
    "src/app/api/v1/admin/arisan/periods/route.ts",
  ]) {
    const source = read(file);
    assert.match(source, /requireSuperAdmin/);
    assert.doesNotMatch(source, /const admin = await requireAdmin\(request\)/);
    assert.match(source, /assertSameOrigin/);
  }
});

test("provider-originated money mutations are authenticated by provider verification", () => {
  const webhook = read("src/app/api/v1/webhooks/payment/route.ts");
  assert.match(webhook, /provider\.verifyWebhook/);
  assert.match(webhook, /event\.amount/);
  assert.match(webhook, /event\.currency/);
  assert.match(webhook, /provider_reference/);

  const scheduler = read("src/app/api/v1/jobs/run/route.ts");
  assert.match(scheduler, /CRON_SECRET/);
  assert.match(scheduler, /timingSafeEqual/);
  assert.match(scheduler, /authorization/i);
});

test("refresh-token reuse revocation and audit commit before the request is rejected", () => {
  const refresh = read("src/app/api/v1/auth/refresh/route.ts");
  const reuseBranch = refresh.match(/if \(record\.revokedAt\) \{([\s\S]*?)\n      \}/)?.[1] ?? "";
  assert.match(reuseBranch, /return \{ reuseDetected: true as const \}/);
  assert.doesNotMatch(reuseBranch, /throw new ApiError/);
  assert.match(refresh, /if \(rotated\.reuseDetected\)[\s\S]*?throw new ApiError\("Sesi refresh tidak valid atau telah digunakan kembali\.", "REFRESH_TOKEN_REUSE_DETECTED", 401\)/);
});

test("withdrawal payout has maker-checker enforcement at provider execution", () => {
  const service = read("src/server/services/payout-withdrawal.ts");
  assert.match(service, /approvalStatus !== "APPROVED"/);
  assert.match(service, /approvedBy === input\.adminId/);
  assert.match(service, /MAKER_CHECKER_SEPARATION_REQUIRED/);
  assert.match(service, /source === "PROVIDER"/);
});

test("an administrator cannot mark their own KYC as verified", () => {
  const route = read("src/app/api/v1/admin/users/[id]/kyc/route.ts");
  assert.match(route, /status === "VERIFIED" && id === admin\.id/);
  assert.match(route, /KYC_SELF_APPROVAL_BLOCKED/);
});


test("manual arisan drawing uses maker-checker and scheduler is the only SYSTEM bypass", () => {
  const route = read("src/app/api/v1/admin/arisan/periods/[id]/draw/route.ts");
  const service = read("src/server/services/arisan.ts");
  assert.match(route, /action === "REQUEST"/);
  assert.match(route, /requireAdmin\(request\)/);
  assert.match(route, /requireSuperAdmin\(request\)/);
  assert.match(route, /approveDrawAuthorization/);
  assert.match(route, /drawAndSettle/);
  assert.match(service, /DRAW_AUTHORIZATION_REQUIRED/);
  assert.match(service, /MAKER_CHECKER_SEPARATION_REQUIRED/);
  assert.match(service, /input\.actorType !== "SYSTEM"/);
  assert.match(service, /authorization\.approvedBy !== input\.actorId/);
});

test("high-risk compliance flags cannot be cleared by ADMIN", () => {
  const route = read("src/app/api/v1/admin/compliance/flags/[id]/route.ts");
  assert.match(route, /requireAdmin/);
  assert.match(route, /HIGH|CRITICAL/);
  assert.match(route, /flag\.score >= 100/);
  assert.match(route, /withdrawalRiskStatus === "BLOCKED"/);
  assert.match(route, /admin\.role !== "SUPER_ADMIN"/);
  assert.match(route, /HIGH_RISK_COMPLIANCE_OVERRIDE_REQUIRED/);
});

test("provider topup reconciliation is monotonic and permits PAID recovery after EXPIRED/FAILED", () => {
  const webhook = read("src/app/api/v1/webhooks/payment/route.ts");
  assert.match(webhook, /topup\.status === "SUCCESS"/);
  assert.match(webhook, /event\.status === "PROCESSING"/);
  assert.match(webhook, /\["FAILED", "EXPIRED"\]\.includes\(topup\.status\)/);
  assert.match(webhook, /event\.status === "EXPIRED"/);
  assert.match(webhook, /event\.status === "FAILED"/);
});
