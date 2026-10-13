#!/usr/bin/env bash
set -euo pipefail
: "${PGBACKREST_STANZA:?PGBACKREST_STANZA is required}"
: "${PITR_TARGET_TIME:?PITR_TARGET_TIME with explicit timezone is required}"
: "${PITR_TARGET_PGDATA:?PITR_TARGET_PGDATA is required}"
: "${PITR_ISOLATED_TARGET_CONFIRMED:?Set PITR_ISOLATED_TARGET_CONFIRMED=YES only for a fresh, isolated recovery instance}"
[[ "$PITR_ISOLATED_TARGET_CONFIRMED" == YES ]] || { echo 'Isolated-target confirmation required' >&2; exit 1; }
[[ ! -L "$PITR_TARGET_PGDATA" ]] || { echo 'Symlink targets are forbidden' >&2; exit 1; }
TARGET="$(realpath -m "$PITR_TARGET_PGDATA")"
[[ "$TARGET" != / ]] || { echo 'Root PGDATA is forbidden' >&2; exit 1; }
[[ ! -e "$TARGET" || -d "$TARGET" ]] || { echo 'PGDATA must be a fresh directory' >&2; exit 1; }
[[ ! -d "$TARGET" || -z "$(find "$TARGET" -mindepth 1 -maxdepth 1 -print -quit)" ]] || { echo 'BLOCKED: target is not empty; never use delta overwrite of a live cluster' >&2; exit 1; }
umask 077
mkdir -p "$TARGET"
pgbackrest --stanza="$PGBACKREST_STANZA" restore --type=time --target="$PITR_TARGET_TIME" --target-action=pause --pg1-path="$TARGET"
printf '%s\n' 'Isolated PITR files prepared. Recovery pauses at the target; do not promote or enable financial traffic until WAL/LSN, keys, migration journal, preserved ledger and external settlement are reviewed.'
