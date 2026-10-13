#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups/postgres}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
[[ "$RETENTION_DAYS" =~ ^[1-9][0-9]{0,3}$ ]] || { echo 'Invalid retention days' >&2; exit 1; }
umask 077
mkdir -p "$BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PARTIAL="$(mktemp "$BACKUP_DIR/.partial-digital-arisan-$STAMP-XXXXXX")"
OUT="$BACKUP_DIR/digital-arisan-$STAMP-${PARTIAL##*-}.dump"
trap 'rm -f "$PARTIAL"' EXIT
printf '%s\n' "Starting PostgreSQL logical backup: $OUT"
pg_dump "$DATABASE_URL" --format=custom --compress=6 --no-owner --no-acl --file="$PARTIAL"
pg_restore --list "$PARTIAL" >/dev/null
mv "$PARTIAL" "$OUT"
(cd "$BACKUP_DIR" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256")
pg_restore --list "$OUT" > "$OUT.list"
# Never remove arbitrary files/subdirectories if BACKUP_DIR was misconfigured.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'digital-arisan-*.dump*' -mtime +"$RETENTION_DAYS" -delete
printf '%s\n' "Backup complete: $OUT"
printf '%s\n' "Checksum: $OUT.sha256"
