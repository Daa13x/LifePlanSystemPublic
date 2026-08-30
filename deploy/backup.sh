#!/usr/bin/env bash
# Nightly SQLite backup for the hosted LPS Closed Beta database.
# Uses sqlite3's own `.backup` (safe against a live WAL-mode database --
# it does NOT require stopping the service), then prunes backups older
# than 14 days. Install: apt-get install -y sqlite3
#
# Suggested cron (as the lps user): crontab -e
#   0 3 * * * /opt/lps/deploy/backup.sh >> /opt/lps/data/backup.log 2>&1

set -euo pipefail

# Read the real configured database path rather than hard-coding it, so a
# changed LIFE_PLANNER_DB in the env file can never cause this script to
# silently "back up" a stale or nonexistent path.
ENV_FILE="/opt/lps/lps-beta.env"
DB_PATH="/opt/lps/data/life-planner.sqlite"
if [ -f "$ENV_FILE" ]; then
  configured="$(grep -E '^LIFE_PLANNER_DB=' "$ENV_FILE" | tail -n1 | cut -d= -f2-)"
  [ -n "$configured" ] && DB_PATH="$configured"
fi
if [ ! -f "$DB_PATH" ]; then
  echo "Backup aborted: database not found at $DB_PATH" >&2
  exit 1
fi

BACKUP_DIR="/opt/lps/backups"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP_DIR"
sqlite3 "$DB_PATH" ".backup '$BACKUP_DIR/life-planner-$STAMP.sqlite'"

# Keep 14 days of nightly backups; disk is cheap, a beta tester's data isn't.
find "$BACKUP_DIR" -name 'life-planner-*.sqlite' -mtime +14 -delete

echo "Backup complete: $BACKUP_DIR/life-planner-$STAMP.sqlite"
