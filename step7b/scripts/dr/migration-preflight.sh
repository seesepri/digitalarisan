#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
node scripts/deploy/verify-migrations.mjs
node scripts/deploy/migration-state-check.mjs
printf '%s\n' 'Read-only migration file/journal preflight PASS.'
