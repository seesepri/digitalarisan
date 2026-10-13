#!/usr/bin/env bash
set -euo pipefail
BACKUP_FILE="${1:?Usage: verify-backup.sh <backup.dump> [sha256-file]}"
CHECKSUM_FILE="${2:-$BACKUP_FILE.sha256}"
[[ -f "$BACKUP_FILE" && -f "$CHECKSUM_FILE" ]] || { echo 'Backup archive/checksum missing' >&2; exit 1; }
# Verify the actual requested archive, not a different path embedded in an untrusted manifest.
[[ "$(wc -l < "$CHECKSUM_FILE")" -eq 1 ]] || { echo 'Checksum manifest must contain exactly one digest' >&2; exit 1; }
read -r EXPECTED _ < "$CHECKSUM_FILE"
[[ "$EXPECTED" =~ ^[0-9a-f]{64}$ ]] || { echo 'Invalid SHA-256 digest' >&2; exit 1; }
ACTUAL="$(sha256sum "$BACKUP_FILE" | cut -d' ' -f1)"
[[ "$ACTUAL" == "$EXPECTED" ]] || { echo 'Backup checksum mismatch' >&2; exit 1; }
pg_restore --list "$BACKUP_FILE" >/dev/null
printf '%s\n' "Backup archive and checksum verified: $BACKUP_FILE"
