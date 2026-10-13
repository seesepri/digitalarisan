import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { resolve } from "node:path";

const routePath = resolve(
  process.cwd(),
  "src/app/api/v1/admin/privacy/requests/route.ts",
);

async function readRoute() {
  return readFile(routePath, "utf8");
}

test("user privacy request check and insert are serialized and rate limited", async () => {
  const source = await readFile(resolve(process.cwd(), "src/app/api/v1/privacy/requests/route.ts"), "utf8");
  assert.match(source, /enforceRateLimit\(request, "privacy-request", 5, 60 \* 60_000, user\.id\)/);
  assert.match(source, /db\.transaction\(async \(tx\) => \{[\s\S]*?SELECT id FROM users WHERE id = \$\{user\.id\} FOR UPDATE[\s\S]*?privacyRequests\.status, \["PENDING", "IN_PROGRESS"\][\s\S]*?tx\.insert\(privacyRequests\)/);
});

test("privacy admin route implements explicit state-machine transitions", async () => {
  const source = await readRoute();

  assert.match(
    source,
    /current === "PENDING"[\s\S]*next === "IN_PROGRESS"/,
    "PENDING must only transition to IN_PROGRESS",
  );

  assert.match(
    source,
    /current === "IN_PROGRESS"[\s\S]*next === "COMPLETED"[\s\S]*next === "REJECTED"/,
    "IN_PROGRESS must transition only to COMPLETED or REJECTED",
  );

  assert.match(
    source,
    /if \(!isAllowedTransition\(currentStatus, decision\)\)/,
    "admin decision must be checked against the explicit state machine",
  );

  assert.match(
    source,
    /PRIVACY_REQUEST_INVALID_TRANSITION/,
    "invalid privacy transitions must be rejected",
  );
});

test("privacy admin route prevents transitions out of final states", async () => {
  const source = await readRoute();

  assert.match(
    source,
    /if \(current === "PENDING"\)[\s\S]*return next === "IN_PROGRESS"/,
  );

  assert.match(
    source,
    /if \(current === "IN_PROGRESS"\)[\s\S]*return next === "COMPLETED" \|\| next === "REJECTED"/,
  );

  assert.match(
    source,
    /return false;/,
    "COMPLETED and REJECTED must have no outgoing transitions",
  );

  assert.doesNotMatch(
    source,
    /current === "COMPLETED"[\s\S]*next === "IN_PROGRESS"/,
    "COMPLETED must not be reopened",
  );

  assert.doesNotMatch(
    source,
    /current === "REJECTED"[\s\S]*next === "IN_PROGRESS"/,
    "REJECTED must not be reopened",
  );
});

test("privacy admin route requires same-origin protection and admin authentication", async () => {
  const source = await readRoute();

  assert.match(
    source,
    /assertSameOrigin\(request\)/,
    "POST must enforce same-origin protection",
  );

  assert.match(
    source,
    /const admin = await requireAdmin\(request\)/,
    "POST must require admin authorization",
  );

  assert.match(
    source,
    /await requireAdmin\(request\)/,
    "GET must require admin authorization",
  );
});

test("privacy admin route validates request id and decision", async () => {
  const source = await readRoute();

  assert.match(
    source,
    /const id = typeof body\.id === "string" \? body\.id\.trim\(\) : ""/,
    "request id must be validated as a non-derived string",
  );

  assert.match(
    source,
    /const decision = body\.decision/,
    "decision must come from the request body",
  );

  assert.match(
    source,
    /!id \|\| !isPrivacyRequestStatus\(decision\)/,
    "missing or invalid request data must be rejected",
  );

  assert.match(
    source,
    /INVALID_PRIVACY_DECISION/,
    "invalid decision must return an explicit error code",
  );
});

test("privacy admin route does not allow direct completion from PENDING", async () => {
  const source = await readRoute();

  assert.match(
    source,
    /if \(current === "PENDING"\) \{[\s\S]*return next === "IN_PROGRESS";[\s\S]*\}/,
    "PENDING must not directly become COMPLETED or REJECTED",
  );
});

test("privacy admin route only performs erasure actions when completing ERASURE", async () => {
  const source = await readRoute();

  assert.match(
    source,
    /if \(decision === "COMPLETED" && requestRow\.type === "ERASURE"\)/,
    "erasure operations must be scoped to completed ERASURE requests",
  );

  assert.match(
    source,
    /update\(userSessions\)[\s\S]*revokedAt: now/,
    "ERASURE completion must revoke user sessions",
  );

  assert.match(
    source,
    /update\(users\)[\s\S]*passwordHash: "ERASED"/,
    "ERASURE completion must invalidate the user's password",
  );

  assert.match(
    source,
    /status: "SUSPENDED"/,
    "ERASURE completion must suspend the anonymized account",
  );
});

test("privacy admin route preserves financial-history references", async () => {
  const source = await readRoute();

  assert.doesNotMatch(
    source,
    /delete\(walletTransactions\)/,
    "privacy erasure must not delete wallet transactions",
  );

  assert.doesNotMatch(
    source,
    /delete\(financialTransactions\)/,
    "privacy erasure must not delete financial transactions",
  );

  assert.doesNotMatch(
    source,
    /delete\(withdrawals\)/,
    "privacy erasure must not delete withdrawals",
  );

  assert.doesNotMatch(
    source,
    /ON DELETE CASCADE/,
    "this route must not introduce cascading financial deletion",
  );
});

test("privacy admin route records an audit event for every accepted decision", async () => {
  const source = await readRoute();

  assert.match(
    source,
    /await tx\.insert\(auditLogs\)\.values\(/,
    "accepted privacy decisions must be audited",
  );

  assert.match(
    source,
    /action: `PRIVACY_REQUEST_\$\{decision\}`/,
    "audit action must identify the privacy decision",
  );

  assert.match(
    source,
    /entityType: "privacy_request"/,
    "audit entry must identify the privacy request entity",
  );

  assert.match(
    source,
    /entityId: id/,
    "audit entry must identify the privacy request",
  );
});

test("privacy admin route updates request and audit record in one transaction", async () => {
  const source = await readRoute();

  assert.match(
    source,
    /const result = await db\.transaction\(async \(tx\) =>/,
    "privacy state change must execute inside a database transaction",
  );

  assert.match(
    source,
    /await tx\s*\.update\(privacyRequests\)/,
    "privacy request status must be updated through the transaction",
  );

  assert.match(
    source,
    /await tx\s*\.insert\(auditLogs\)/,
    "privacy audit record must be created through the same transaction",
  );
});

test("privacy admin route records processedBy and processedAt", async () => {
  const source = await readRoute();

  assert.match(
    source,
    /processedBy: admin\.id/,
    "decision must record the admin who processed it",
  );

  assert.match(
    source,
    /processedAt: now/,
    "decision must record processing time",
  );
});

test("admin privacy decisions lock their request row before checking and applying transitions", async () => {
  const source = await readRoute();
  assert.match(source, /SELECT id FROM privacy_requests WHERE id = \$\{id\} FOR UPDATE[\s\S]*?\.select\(\)[\s\S]*?isAllowedTransition/);
});