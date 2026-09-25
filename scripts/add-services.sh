#!/bin/bash
#
# add-services.sh
#
# Installs, enables and starts the gardenpi-* systemd units.
#
# Usage:
#   sudo ./add-services.sh
#
# v3.0 2026/09/25
# - units are installed with User=/Group= taken from garden.json
#   (config.application_user / config.application_group, via
#   gardenpi-env.sh) instead of the "pi" written in the repo's unit files.
#   Lines set to root (gardenpi-init) are left as they are.
# - a service that is already running is restarted when its installed unit
#   file changed (e.g. a new user), since systemd only applies that on the
#   next start. Unchanged, running services are left alone.
# - added the #!/bin/bash line and strict error handling; runs from any
#   directory.
#
# v2.0 2026/08/27
# - fixed: the install/enable loops referenced $services, which was never
#   defined (only $start_services was) - this silently did nothing on
#   every run. Renamed the loops to use $services and made it the
#   authoritative list.
# - added gardenpi-init to the list - it was previously never installed
#   or enabled by this script at all, even though gardenpi-leds/adc/
#   irrigation/weather all Require= it.
# - order matches restart-services.sh's mandatory startup sequence:
#   init -> leds -> adc -> irrigation -> weather -> api -> webui.

set -euo pipefail

SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
. "$SCRIPT_DIR/gardenpi-env.sh"

if [ "$(id -u)" -ne 0 ]; then
  echo "This script needs to run as root. Try: sudo $0" >&2
  exit 1
fi
gardenpi_require_account

services="gardenpi-init gardenpi-leds gardenpi-adc gardenpi-irrigation gardenpi-weather gardenpi-api gardenpi-webui"
UNIT_DIR="/etc/systemd/system"

echo "==> Installing units to run as $GARDENPI_USER:$GARDENPI_GROUP"
changed=""
for service in $services; do
  src="$SCRIPT_DIR/${service}.service"
  dst="$UNIT_DIR/${service}.service"
  tmp="$(mktemp)"
  # Replace User=/Group= unless the unit deliberately runs as root.
  sed -E \
    -e "/^User=root\$/! s/^User=.*/User=${GARDENPI_USER}/" \
    -e "/^Group=root\$/! s/^Group=.*/Group=${GARDENPI_GROUP}/" \
    "$src" > "$tmp"
  if [ -f "$dst" ] && cmp -s "$tmp" "$dst"; then
    rm -f "$tmp"
    echo "    $service: unchanged"
  else
    install -m 0644 -o root -g root "$tmp" "$dst"
    rm -f "$tmp"
    changed="$changed $service"
    echo "    $service: installed"
  fi
done

systemctl daemon-reload

for service in $services; do
  if [[ " $changed " == *" $service "* ]] && systemctl is-active --quiet "$service"; then
    echo "==> Restarting $service (unit changed)"
    systemctl restart "$service"
  fi
  echo "==> Enabling and starting $service"
  systemctl enable "$service" --now
  sleep 1
done
