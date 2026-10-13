#!/usr/bin/env bash
set -euo pipefail
: "${E2E_BASE_URL:?E2E_BASE_URL is required}"
npx tsx --test tests/e2e/http-smoke.test.ts
