#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_FILE="${1:?Usage: restore-postgres.sh <backup.dump> }"
: "${ALLOW_DESTRUCTIVE_RESTORE:?Set ALLOW_DESTRUCTIVE_RESTORE=true to restore over an existing database}"
[[ "$ALLOW_DESTRUCTIVE_RESTORE" == "true" ]] || { echo "Destructive restore is disabled." >&2; exit 1; }
[[ -f "$BACKUP_FILE" ]] || { echo "Backup not found: $BACKUP_FILE" >&2; exit 1; }

EXPECTED_DB="$(psql "$DATABASE_URL" -Atqc 'select current_database()')"
EXPECTED_DB="${EXPECTED_DB//[^a-zA-Z0-9_-]/}"
[[ -n "$EXPECTED_DB" ]] || { echo "Unable to determine target database" >&2; exit 1; }

printf '%s\n' "WARNING: restoring backup into database '$EXPECTED_DB'."
read -r -p "Type the database name to continue: " CONFIRM
[[ "$CONFIRM" == "$EXPECTED_DB" ]] || { echo "Restore cancelled."; exit 1; }

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"
pg_restore "$BACKUP_FILE" \
  --dbname="$DATABASE_URL" \
  --no-owner \
  --no-acl \
  --exit-on-error
printf '%s\n' "Restore completed. Run migrations and the full DR verification suite before reopening traffic."
