#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
./scripts/deploy/migration-preflight.sh
# Migrations must be additive/expand-first. Backward-incompatible cleanup belongs in a later release.
npx drizzle-kit migrate
printf '%s\n' 'Zero-downtime migration phase complete.'
