# Audit delivery — 13 October 2026

**Release status: BLOCKED / NOT PRODUCTION-READY.** Read `AUDIT_REPORT_2026-10-13.md` first. Local checks do not certify the nine real withdrawals or external bank settlement. Working-copy changes have not been committed/pushed.

## Contents

- Patched source + additive migrations 0002–0005.
- Guarded unit/database runners and financial/authorization regression suites.
- Read-only withdrawal investigator and database/audit integrity checks.
- Isolated migration/backup/restore/HTTP rehearsals.
- The delivery ZIP also contains the full Git patch, `changed-files.tsv`, and baseline/final evidence logs.

## Safe local reproduction

Prerequisites: Node 20.20.2 (tested), **npm 10.9.2**, PostgreSQL 17.11 (tested), `psql`, `pg_dump`, `pg_restore`, POSIX shell. Use a dedicated LOCAL cluster and a fixture owner able to create temporary databases/roles. No production credentials or tunnels.

```bash
cd step7b
npm install --global npm@10.9.2
npm ci --ignore-scripts --no-audit --no-fund

# Adjust local host/port/user to your OWN isolated cluster.
createdb -h 127.0.0.1 -p 5432 -U postgres arisan_local_test
psql 'postgresql://postgres@127.0.0.1:5432/arisan_local_test' \
  -c "COMMENT ON DATABASE arisan_local_test IS 'digitalarisan:disposable-test'"

export NODE_ENV=test
export TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:5432/arisan_local_test'
export TEST_DB_ALLOW_RESET=YES
npm run test:all
npm run test:migrations
npm run test:dr

# Build solely against that disposable database. These generated secrets are TEST ONLY.
export DATABASE_URL="$TEST_DATABASE_URL"
export AUTH_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
export BANK_PII_ENCRYPTION_KEY="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")"
export APP_URL='https://local-http-test.invalid'
export PAYMENT_PROVIDER=unconfigured
export PAYOUT_PROVIDER=unconfigured
export NEXT_TELEMETRY_DISABLED=1
npm run build
npm run test:http:local
```

The database runner **truncates public fixture tables**, but only after explicit loopback `_test` URL, production-env rejection, no URL override parameters, reset consent and server-side database comment checks. It NEVER falls back to application `DATABASE_URL`. Do not mark a real/restored dataset disposable to force tests. Preserve restored historical data; use the read-only integrity verifiers instead.

Migration/DR rehearsals create their own marked temporary databases, use synthetic data and remove those temporary copies. HTTP harness starts a bounded-lifetime Next standalone production-build test server with providers disabled and a least-privilege role, runs GET/security/load checks, verifies wallet balances unchanged and shuts the server down. Test-only key constants in fixture helpers are public test material, never production secrets.

## Read-only investigation of the actual withdrawals

Run `scripts/security/audit-withdrawals.mjs` with `READ_ONLY_AUDIT_DATABASE_URL` supplied securely on your host and the actual UUIDs. It uses a read-only repeatable snapshot and makes no provider/financial operations. Export no credentials or plaintext bank PII. Its verdict remains BLOCKED until receipt/settlement/reference/amount/IDR/recipient evidence is reviewed externally.

## Important changed operational semantics

- **Schema apply:** `MIGRATION_DATABASE_URL` is the owner URL; explicit `ALLOW_SCHEMA_MIGRATION_APPLY=YES` and `FINANCIAL_WORKERS_PAUSED=YES` are required. A reviewed bank plaintext-encryption plan, if needed, must run BEFORE immutable recipient guard 0002 and needs its own approval. Production migrations were NOT executed in this audit.
- **Promotion:** full dependency gate must pass, migration prefix must be fully applied, preserved-data/audit gates must pass, and an out-of-band `PRODUCTION_APPROVAL_REFERENCE` is required. Health only proves liveness/connection, not bank correctness.
- **Restore:** a verified archive, `RESTORE_ISOLATED_TARGET_CONFIRMED=YES` and exact `RESTORE_TARGET_DATABASE` are required; target must be empty. There is no DROP-public/overwrite-live mode.
- **PITR:** fresh empty isolated PGDATA and `PITR_ISOLATED_TARGET_CONFIRMED=YES`; no delta overwrite, pause rather than automatic promotion. WAL recovery was NOT tested.
- **Bank key:** do NOT replace/revoke the `enc:v1` bank key as if it were an API credential. Versioned keyring/re-encryption and historical backup recovery are BLOCKED until implemented/rehearsed. Original keys must be preserved with retained ciphertext/backups.
- **Proxy:** restrict backend ingress to approved proxies; overwrite X-Forwarded-For and configure exact `TRUST_PROXY_HOPS`. The application no longer trusts attacker-prepended first IPs.
- **Raw SQL metadata:** reviewed migrations own triggers/custom constraints; ORM snapshot no-drift only covers declared ORM structure. Do not `drizzle push` a production database.

## Known failed / blocked gates

`npm run security:check` is expected to FAIL while the five HIGH braces-chain vulnerability entries remain. Do not suppress them, force breaking downgrades, disable tests, fabricate provider receipts or auto-refund/retry unknown transfers.

Provider sandbox, the actual nine withdrawals, existing production history, production secrets/roles/network/TLS, actual PITR/RPO/RTO, key rotation, financial stress, CI promotion/rollback and alert delivery are not certified. Read the detailed release checklist in the report.
