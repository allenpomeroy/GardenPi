#!/bin/bash
#
# fix-perms.sh
#
# Gives the GardenPi service account ownership of /opt/gardenpi.
#
# v2.0 2026/09/25
# - owner is garden.json's config.application_user:config.application_group
#   (via gardenpi-env.sh) instead of a hard-coded pi:pi
# - added the #!/bin/bash line and strict error handling

set -euo pipefail

. "$(dirname "$(readlink -f "$0")")/gardenpi-env.sh"

if [ "$(id -u)" -ne 0 ]; then
  echo "This script needs to run as root. Try: sudo $0" >&2
  exit 1
fi
gardenpi_require_account

echo "==> Setting ownership of /opt/gardenpi to $GARDENPI_USER:$GARDENPI_GROUP"
chown -R "$GARDENPI_USER:$GARDENPI_GROUP" /opt/gardenpi
