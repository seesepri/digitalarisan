#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
: "${TEST_DATABASE_URL:?TEST_DATABASE_URL is required}"
node scripts/test-database.mjs
