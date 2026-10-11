#!/bin/sh
# Restores a Growthdesk dump into a database (docs/DEPLOYMENT.md → Backups).
#
#   pg-restore.sh <dump-file> <target-database>
#
# Refuses to touch a database that already has tables unless FORCE=1, checks
# the dump's .sha256 when present, and prints row counts of key tables after
# restoring so a drill has something to compare. Connection: PGHOST, PGUSER,
# PGPASSWORD (the target database is created when missing).
set -eu

dump="${1:?usage: pg-restore.sh <dump-file> <target-database>}"
target="${2:?usage: pg-restore.sh <dump-file> <target-database>}"
[ -f "$dump" ] || { echo "no such file: $dump" >&2; exit 1; }

if [ -f "$dump.sha256" ]; then
  (cd "$(dirname "$dump")" && sha256sum -c "$(basename "$dump").sha256")
fi

if ! psql -d postgres -Atc "select 1 from pg_database where datname = '$target'" | grep -q 1; then
  createdb "$target"
fi
tables=$(psql -d "$target" -Atc "select count(*) from pg_tables where schemaname = 'public'")
if [ "$tables" != "0" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "$target already has $tables tables. Restore into a new database, or set FORCE=1 to restore over it." >&2
  exit 1
fi

pg_restore --no-owner --no-privileges --exit-on-error --dbname="$target" "$dump"

echo "restored $dump into $target:"
psql -d "$target" -Atc "select 'workspaces', count(*) from \"Workspace\" union all select 'users', count(*) from \"User\" union all select 'contacts', count(*) from \"Contact\" union all select 'messages', count(*) from \"Message\" union all select 'migrations', count(*) from \"_prisma_migrations\"" | sed 's/|/: /'
