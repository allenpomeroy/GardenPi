#!/bin/bash
#
# add-services.sh
#
# Installs, enables and starts the gardenpi-* systemd units, and the
# PiJuice charge limiter (pijuice-charge-limiter.service) when the PiJuice
# Python module is installed.
#
# Usage:
#   sudo ./add-services.sh
#   sudo ./add-services.sh --no-charge-limiter   # leave the limiter out
#                                                # (and disable it if present)
#
# v3.1 2026/10/02
# - installs, enables and starts pijuice-charge-limiter.service, which runs
#   bin/pijuice-charge-limiter.py to hold the PiJuice battery at 45-50%.
#   Skipped, with a message, if the system python3 can't import pijuice
#   (install pijuice-base first); without it the service would only
#   restart-loop. Like the gardenpi-* units, it gets User=/Group= from
#   garden.json (the account needs the i2c group). --no-charge-limiter
#   skips it and disables an already installed one.
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

CHARGE_LIMITER=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-charge-limiter) CHARGE_LIMITER=0; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
done

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
# install_unit NAME: copy scripts/NAME.service to /etc/systemd/system with
# User=/Group= replaced (unless the unit deliberately runs as root). Adds
# NAME to $changed if the installed file is new or different.
install_unit() {
  local service="$1"
  local src="$SCRIPT_DIR/${service}.service"
  local dst="$UNIT_DIR/${service}.service"
  local tmp
  tmp="$(mktemp)"
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
}

for service in $services; do
  install_unit "$service"
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

# ---- PiJuice charge limiter (optional) ----
LIMITER=pijuice-charge-limiter
LIMITER_DST="$UNIT_DIR/${LIMITER}.service"
if [ "$CHARGE_LIMITER" -eq 0 ]; then
  if [ -f "$LIMITER_DST" ]; then
    echo "==> --no-charge-limiter: disabling and stopping $LIMITER"
    systemctl disable --now "$LIMITER" || true
  else
    echo "==> --no-charge-limiter: $LIMITER not installed"
  fi
elif ! /usr/bin/python3 -c 'import pijuice' >/dev/null 2>&1; then
  echo "==> Skipping $LIMITER: the system python3 can't import 'pijuice'."
  echo "    Install it (sudo apt install pijuice-base), then re-run this script."
else
  if ! id -nG "$GARDENPI_USER" | tr ' ' '\n' | grep -qx i2c; then
    echo "WARNING: $GARDENPI_USER is not in the i2c group; $LIMITER won't be able to"
    echo "         reach the PiJuice. Fix: sudo usermod -aG i2c $GARDENPI_USER"
  fi
  install_unit "$LIMITER"
  systemctl daemon-reload
  if [[ " $changed " == *" $LIMITER "* ]] && systemctl is-active --quiet "$LIMITER"; then
    echo "==> Restarting $LIMITER (unit changed)"
    systemctl restart "$LIMITER"
  fi
  echo "==> Enabling and starting $LIMITER"
  systemctl enable "$LIMITER" --now
fi
