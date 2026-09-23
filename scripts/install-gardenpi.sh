#!/bin/bash
#
# install-gardenpi.sh
#
# Install all GardenPi components. Run from anywhere:
#   sudo /opt/gardenpi/scripts/install-gardenpi.sh
#
# v2.0 2026/09/23
# - fixed: every step used a ./relative path, so the script only worked
#   when run from inside scripts/ (the README runs it by absolute path from
#   /opt/gardenpi, where every step failed). Now changes to its own
#   directory first.
# - fixed: add-remove-logs-crontab.sh was called but did not exist; it is
#   now included, and run as root (it edits the pi user's crontab).
# - added setup-sudoers.sh, so the web UI can restart gardenpi-* services
#   and reboot / shut down the Pi from Configuration > Services.
# - stops at the first failing step instead of carrying on.

set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

if [ "$(id -u)" -ne 0 ]; then
  echo "This script needs to run as root. Try: sudo $0" >&2
  exit 1
fi

./fix-perms.sh

./setup-venv.sh
./setup-api.sh
./setup-webui.sh

./setup-sudoers.sh

./add-services.sh

./add-remove-logs-crontab.sh

echo
echo "GardenPi install complete."
