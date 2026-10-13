#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
./scripts/dr/migration-preflight.sh
if command -v psql >/dev/null 2>&1; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atqc 'select current_database(), current_user, version();'
fi
# v15 policy: migrations are forward-only; destructive statements require an explicit operator review.
if grep -RniE '^\s*(drop\s+(table|column|schema)|truncate\s+)' drizzle/*.sql; then
  echo 'ERROR: destructive migration detected. Require explicit reviewed exception before promotion.' >&2
  exit 1
fi
npm run build
printf '%s\n' 'Migration file/journal/build preflight PASS. NOT a financial production-readiness or zero-downtime certificate.'
