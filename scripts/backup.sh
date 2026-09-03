#!/bin/sh
# Postgres backup for the commission portal.
#   sh scripts/backup.sh            # one dump now  → $BACKUP_DIR/greystone-YYYY-MM-DDTHHMM.sql.gz
#   sh scripts/backup.sh loop       # dump once a day at $BACKUP_HOUR_UTC, prune after $BACKUP_KEEP_DAYS
#   sh scripts/backup.sh restore FILE.sql.gz   # restore into $PGDATABASE (drops and recreates the schema objects in the dump)
# Uses the usual libpq variables (PGHOST, PGUSER, PGPASSWORD, PGDATABASE) or DATABASE_URL.
set -eu
BACKUP_DIR="${BACKUP_DIR:-/backups}"
KEEP="${BACKUP_KEEP_DAYS:-30}"
HOUR="${BACKUP_HOUR_UTC:-7}"
TARGET="${DATABASE_URL:-}"
mkdir -p "$BACKUP_DIR"

dump() {
  stamp="$(date -u +%Y-%m-%dT%H%M)"
  out="$BACKUP_DIR/greystone-$stamp.sql.gz"
  if [ -n "$TARGET" ]; then pg_dump --no-owner --no-privileges "$TARGET" | gzip -9 > "$out.part"
  else pg_dump --no-owner --no-privileges | gzip -9 > "$out.part"; fi
  mv "$out.part" "$out"
  echo "backup: wrote $out ($(du -h "$out" | cut -f1))"
  find "$BACKUP_DIR" -name 'greystone-*.sql.gz' -mtime "+$KEEP" -print -delete | sed 's/^/backup: pruned /'
}

case "${1:-once}" in
  loop)
    echo "backup: daily at ${HOUR}:00 UTC, keeping $KEEP days in $BACKUP_DIR"
    last=""
    while true; do
      now_h="$(date -u +%H)"; today="$(date -u +%F)"
      if [ "$now_h" -ge "$HOUR" ] && [ "$last" != "$today" ]; then dump && last="$today"; fi
      sleep 600
    done ;;
  restore)
    [ -n "${2:-}" ] || { echo "usage: backup.sh restore FILE.sql.gz" >&2; exit 2; }
    echo "backup: restoring $2 — this overwrites the database"
    if [ -n "$TARGET" ]; then gunzip -c "$2" | psql -v ON_ERROR_STOP=1 "$TARGET"
    else gunzip -c "$2" | psql -v ON_ERROR_STOP=1; fi ;;
  *) dump ;;
esac
