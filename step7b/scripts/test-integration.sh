#!/usr/bin/env bash
set -euo pipefail
: "${TEST_DATABASE_URL:?TEST_DATABASE_URL is required}"
export DATABASE_URL="$TEST_DATABASE_URL"
export NODE_ENV=test
export PAYMENT_PROVIDER=unconfigured
npx drizzle-kit migrate
npx tsx --test tests/integration-financial.test.ts
