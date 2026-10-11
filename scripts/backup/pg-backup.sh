#!/bin/sh
# Nightly logical backups of the Growthdesk database (docs/DEPLOYMENT.md → Backups).
# Runs in the postgres image (pg_dump/pg_restore of the same major version).
#
#   pg-backup.sh          loop: one backup a day at BACKUP_HOUR_UTC, forever
#   pg-backup.sh --once   one backup now, then exit (manual runs, restore drills)
#
# Each dump is written to a temporary name, checked with `pg_restore --list`
# (a truncated or corrupt archive fails here, not on the day you need it),
# then renamed and given a .sha256. Dumps older than BACKUP_RETAIN_DAYS are
# removed. Connection: PGHOST, PGUSER, PGPASSWORD, PGDATABASE.
set -eu

DIR="${BACKUP_DIR:-/backups}"
RETAIN="${BACKUP_RETAIN_DAYS:-14}"
HOUR="${BACKUP_HOUR_UTC:-3}"
STAMP_FILE="$DIR/.last-backup-date"
mkdir -p "$DIR"

backup() {
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  tmp="$DIR/.growthdesk-$ts.dump.partial"
  out="$DIR/growthdesk-$ts.dump"
  trap 'rm -f "$tmp"' EXIT
  pg_dump --format=custom --compress=9 --no-owner --no-privileges --file="$tmp"
  pg_restore --list "$tmp" >/dev/null
  mv "$tmp" "$out"
  trap - EXIT
  (cd "$DIR" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256")
  find "$DIR" -maxdepth 1 -name 'growthdesk-*.dump*' -mtime +"$RETAIN" -exec rm -f {} +
  date -u +%Y-%m-%d > "$STAMP_FILE"
  echo "$(date -u +%FT%TZ) backup ok: $out ($(du -h "$out" | cut -f1))"
}

if [ "${1:-}" = "--once" ]; then
  backup
  exit 0
fi

echo "$(date -u +%FT%TZ) backups daily at ${HOUR}:00 UTC into $DIR, keeping ${RETAIN} days"
while true; do
  today=$(date -u +%Y-%m-%d)
  hour=$(date -u +%H | sed 's/^0//')
  last=$(cat "$STAMP_FILE" 2>/dev/null || true)
  if [ "${hour:-0}" -ge "$HOUR" ] && [ "$last" != "$today" ]; then
    backup || echo "$(date -u +%FT%TZ) BACKUP FAILED" >&2
  fi
  sleep 600
done
