#!/usr/bin/env bash
set -euo pipefail

: "${PGBACKREST_STANZA:?PGBACKREST_STANZA is required}"
: "${PITR_TARGET_TIME:?PITR_TARGET_TIME is required, e.g. 2026-10-06 11:30:00+00}"
: "${PITR_TARGET_PGDATA:?PITR_TARGET_PGDATA is required}"

[[ -d "$PITR_TARGET_PGDATA" ]] || mkdir -p "$PITR_TARGET_PGDATA"
[[ "$PITR_TARGET_PGDATA" != "/" ]] || { echo "Refusing to use / as PGDATA" >&2; exit 1; }

pgbackrest --stanza="$PGBACKREST_STANZA" restore \
  --type=time \
  --target="$PITR_TARGET_TIME" \
  --target-action=promote \
  --pg1-path="$PITR_TARGET_PGDATA" \
  --delta

printf '%s\n' "PITR restore prepared at $PITR_TARGET_PGDATA for target $PITR_TARGET_TIME"
printf '%s\n' "Start the isolated PostgreSQL instance, run scripts/dr/verify-restored-db.sh, then switch traffic only after validation."
