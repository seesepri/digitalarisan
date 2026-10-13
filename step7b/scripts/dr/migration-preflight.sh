#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

sha256sum --check drizzle/MIGRATION_CHECKSUMS.sha256

python3 - <<'PY'
from pathlib import Path
import re, sys
files = sorted(Path('drizzle').glob('[0-9][0-9][0-9][0-9]_*.sql'))
nums = [int(re.match(r'^(\d+)_', p.name).group(1)) for p in files]
first_expected = 0 if files and files[0].name == '0000_baseline.sql' else 1
expected = list(range(first_expected, first_expected + len(nums)))
if nums != expected:
    print(f'Migration numbering is not contiguous: {nums}', file=sys.stderr)
    sys.exit(1)
print(f'Migration files OK: {len(files)} sequential migrations')
PY

if psql "$DATABASE_URL" -Atqc "select to_regclass('drizzle.__drizzle_migrations')" | grep -q .; then
  psql "$DATABASE_URL" -Atqc "select id, hash, created_at from drizzle.__drizzle_migrations order by created_at" || true
elif psql "$DATABASE_URL" -Atqc "select to_regclass('public.__drizzle_migrations')" | grep -q .; then
  psql "$DATABASE_URL" -Atqc "select id, hash, created_at from public.__drizzle_migrations order by created_at" || true
else
  echo "WARNING: Drizzle migration journal table is not present. Run the migration bootstrap before production cutover." >&2
fi

printf '%s\n' "Migration preflight complete."
