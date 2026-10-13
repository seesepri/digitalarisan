#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups/postgres}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
mkdir -p "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/digital-arisan-$STAMP.dump"
MANIFEST="$OUT.sha256"

umask 077
printf '%s\n' "Starting PostgreSQL logical backup: $OUT"
pg_dump "$DATABASE_URL" \
  --format=custom \
  --compress=6 \
  --no-owner \
  --no-acl \
  --file="$OUT"

sha256sum "$OUT" > "$MANIFEST"
pg_restore --list "$OUT" > "$OUT.list"

find "$BACKUP_DIR" -type f -mtime +"$RETENTION_DAYS" -delete
printf '%s\n' "Backup complete: $OUT"
printf '%s\n' "Checksum: $MANIFEST"
