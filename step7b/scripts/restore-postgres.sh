#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_FILE="${1:?Usage: restore-postgres.sh <backup.dump>}"
: "${RESTORE_ISOLATED_TARGET_CONFIRMED:?Restore ONLY into a separately provisioned empty, isolated database; set RESTORE_ISOLATED_TARGET_CONFIRMED=YES}"
[[ "$RESTORE_ISOLATED_TARGET_CONFIRMED" == YES ]] || { echo 'Isolated-target consent is required' >&2; exit 1; }
: "${RESTORE_TARGET_DATABASE:?RESTORE_TARGET_DATABASE must exactly name the isolated target}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "$ROOT/scripts/verify-backup.sh" "$BACKUP_FILE"
EXPECTED_DB="$(psql "$DATABASE_URL" -Atqc 'SELECT current_database()')"
[[ "$EXPECTED_DB" == "$RESTORE_TARGET_DATABASE" ]] || { echo 'Target database confirmation mismatch' >&2; exit 1; }
TABLES="$(psql "$DATABASE_URL" -Atqc "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE'")"
[[ "$TABLES" == 0 ]] || { echo 'BLOCKED: target is not empty; restore must never drop/overwrite a live or previously restored database' >&2; exit 1; }
# All archive objects, including the Drizzle journal, restore or roll back together.
pg_restore "$BACKUP_FILE" --dbname="$DATABASE_URL" --no-owner --no-acl --exit-on-error --single-transaction
printf '%s\n' 'Restore completed in an isolated target. KEEP payout workers and financial traffic disabled until preserved-data/journal/hash and external-provider reconciliation are reviewed.'
