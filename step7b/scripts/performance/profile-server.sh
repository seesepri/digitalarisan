#!/usr/bin/env bash
set -euo pipefail
# Local/staging profiling helper. Never run against production without an approved window.
PORT="${PORT:-3100}"
PROFILE_DIR="${PROFILE_DIR:-./profiles}"
mkdir -p "$PROFILE_DIR"
export PORT
export NODE_OPTIONS="${NODE_OPTIONS:-} --cpu-prof --cpu-prof-dir=$PROFILE_DIR"
trap 'kill "$APP_PID" 2>/dev/null || true' EXIT INT TERM
npm start &
APP_PID=$!
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
LOAD_TEST_URL="http://127.0.0.1:${PORT}/api/health" LOAD_TEST_DURATION_MS="${LOAD_TEST_DURATION_MS:-30000}" LOAD_TEST_CONCURRENCY="${LOAD_TEST_CONCURRENCY:-20}" node scripts/runtime/load-stress.mjs
kill -TERM "$APP_PID" 2>/dev/null || true
wait "$APP_PID" || true
printf 'CPU profile files are in %s\n' "$PROFILE_DIR"
