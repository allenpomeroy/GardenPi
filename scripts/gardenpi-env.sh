#!/bin/bash
#
# gardenpi-env.sh
#
# Sourced (not run) by the install scripts, so they all use the same service
# account instead of a hard-coded "pi":
#
#   . "$(dirname "$(readlink -f "$0")")/gardenpi-env.sh"
#
# Sets, from garden.json (GARDENPI_CONFIG, default
# /opt/gardenpi/config/garden.json):
#   GARDENPI_USER   config.application_user   (default pi)
#   GARDENPI_GROUP  config.application_group  (default: GARDENPI_USER)
#
# Either can be overridden by exporting it before running a script, e.g.
#   sudo GARDENPI_USER=bob ./setup-venv.sh
#
# gardenpi_require_account exits with a clear message if the user or group
# doesn't exist on this system.
#
# v1.0 2026/09/25 - initial version

GARDENPI_CONFIG="${GARDENPI_CONFIG:-/opt/gardenpi/config/garden.json}"

_gardenpi_cfg() {  # $1 = key under "config"; prints "" if unavailable
  [ -r "$GARDENPI_CONFIG" ] || return 0
  python3 - "$GARDENPI_CONFIG" "$1" 2>/dev/null <<'PY' || true
import json, sys
v = (json.load(open(sys.argv[1])).get("config") or {}).get(sys.argv[2])
print(v if isinstance(v, str) else "")
PY
}

GARDENPI_USER="${GARDENPI_USER:-$(_gardenpi_cfg application_user)}"
GARDENPI_USER="${GARDENPI_USER:-pi}"
GARDENPI_GROUP="${GARDENPI_GROUP:-$(_gardenpi_cfg application_group)}"
GARDENPI_GROUP="${GARDENPI_GROUP:-$GARDENPI_USER}"
export GARDENPI_USER GARDENPI_GROUP GARDENPI_CONFIG

gardenpi_require_account() {
  if ! id "$GARDENPI_USER" >/dev/null 2>&1; then
    echo "Service user '$GARDENPI_USER' (config.application_user) does not exist on this system." >&2
    echo "Create it first, e.g.: sudo useradd -m -G gpio,i2c,spi $GARDENPI_USER" >&2
    exit 1
  fi
  if ! getent group "$GARDENPI_GROUP" >/dev/null 2>&1; then
    echo "Service group '$GARDENPI_GROUP' (config.application_group) does not exist on this system." >&2
    exit 1
  fi
}
