#!/bin/bash
#
# add-remove-logs-crontab.sh
#
# Adds a daily crontab entry (for the GardenPi service user) that runs
# remove-old-logs.py, which deletes files older than 7 days from
# webui.log_dir in garden.json.
#
# Usage:
#   sudo ./add-remove-logs-crontab.sh            # garden.json's application_user
#   sudo ./add-remove-logs-crontab.sh --user bob
#
# Idempotent: an existing entry for remove-old-logs.py is replaced, never
# duplicated.
#
# v1.1 2026/09/25 - installs cron if it's missing; default user is garden.json's config.application_user
#   (via gardenpi-env.sh) instead of a hard-coded pi
# v1.0 2026/09/23 - initial version (install-gardenpi.sh called this
#   script, but it did not exist, so the install always ended in an error)

set -euo pipefail

. "$(dirname "$(readlink -f "$0")")/gardenpi-env.sh"
RUN_AS_USER="$GARDENPI_USER"   # --user overrides
SCRIPT="/opt/gardenpi/scripts/remove-old-logs.py"
SCHEDULE="17 3 * * *"   # 03:17 daily

while [ $# -gt 0 ]; do
  case "$1" in
    --user) RUN_AS_USER="${2:?--user needs a name}"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "This script needs to run as root. Try: sudo $0" >&2
  exit 1
fi

# Minimal Debian installs may not include cron.
if ! command -v crontab >/dev/null 2>&1; then
  echo "==> Installing cron..."
  apt-get install -y cron
fi

ENTRY="$SCHEDULE /usr/bin/python3 $SCRIPT >/dev/null 2>&1"

# crontab -l exits 1 when the user has no crontab yet; treat that as empty.
EXISTING="$(crontab -u "$RUN_AS_USER" -l 2>/dev/null || true)"
{
  printf '%s\n' "$EXISTING" | grep -v -F "remove-old-logs.py" | sed '/^$/d' || true
  echo "$ENTRY"
} | crontab -u "$RUN_AS_USER" -

echo "Crontab for $RUN_AS_USER now contains:"
crontab -u "$RUN_AS_USER" -l
