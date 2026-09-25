#!/bin/bash
#
# setup-api.sh
#
# Makes sure the API's Python packages (Flask, gunicorn, sdnotify) are in the
# GardenPi virtual environment. setup-venv.sh already installs them from
# requirements.txt; this is a quick check that can also be run on its own.
#
# v2.0 2026/09/25
# - runs pip as garden.json's config.application_user (via gardenpi-env.sh)
#   instead of a hard-coded pi
# - added the #!/bin/bash line and strict error handling

set -euo pipefail

. "$(dirname "$(readlink -f "$0")")/gardenpi-env.sh"
VENV_DIR="/opt/gardenpi/python3"

if [ "$(id -u)" -ne 0 ]; then
  echo "This script needs to run as root. Try: sudo $0" >&2
  exit 1
fi
gardenpi_require_account

if [ ! -d "$VENV_DIR" ]; then
  echo "$VENV_DIR venv does not exist; run setup-venv.sh first." >&2
  exit 1
fi
chown -R "$GARDENPI_USER:$GARDENPI_GROUP" "$VENV_DIR"
sudo -u "$GARDENPI_USER" "$VENV_DIR/bin/pip" install flask gunicorn sdnotify
