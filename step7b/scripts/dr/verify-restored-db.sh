#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
# Never reset a restored historical database with integration test fixtures.
node scripts/deploy/migration-state-check.mjs
node scripts/security/verify-audit-integrity.mjs
node scripts/security/verify-database-integrity.mjs
printf '%s\n' 'Local preserved-data integrity checks passed. This is NOT proof of external settlement, production readiness, RPO/RTO, or actual bank-key recovery; keep financial traffic/workers paused until those gates are reviewed.'
