#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
node scripts/deploy/verify-migrations.mjs
node scripts/deploy/apply-migrations.mjs
printf '%s\n' 'Reviewed additive migration phase complete. Production lock/downtime behavior is NOT PROVEN by this command; do not resume financial workers until external-evidence and integrity gates pass.'
