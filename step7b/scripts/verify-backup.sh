#!/usr/bin/env bash
set -euo pipefail

BACKUP_FILE="${1:?Usage: verify-backup.sh <backup.dump> [sha256-file] }"
CHECKSUM_FILE="${2:-$BACKUP_FILE.sha256}"

[[ -f "$BACKUP_FILE" ]] || { echo "Backup not found: $BACKUP_FILE" >&2; exit 1; }
[[ -f "$CHECKSUM_FILE" ]] || { echo "Checksum not found: $CHECKSUM_FILE" >&2; exit 1; }
sha256sum --check "$CHECKSUM_FILE"
pg_restore --list "$BACKUP_FILE" >/dev/null
printf '%s\n' "Backup archive and checksum verified: $BACKUP_FILE"
