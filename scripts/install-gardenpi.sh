#!/bin/bash
#
# install-gardenpi.sh
#
# Install all GardenPi components. Run from anywhere:
#   sudo /opt/gardenpi/scripts/install-gardenpi.sh
#
# v2.1 2026/09/24
# - first steps are now automatic:
#   1. turn on NTP time sync (timedatectl set-ntp true) and wait up to 90s
#      for the clock to synchronize. A clock that's behind makes apt reject
#      every repository signature ("Not live until ...") and silently fall
#      back to stale package lists, and on this controller it would also
#      run watering schedules at the wrong times. If it doesn't sync in
#      time, the install continues with a warning.
#   2. apt-get update
#   3. install nodejs + npm from the OS repositories, unless node and npm
#      are both already present (so a Node.js installed some other way,
#      e.g. from NodeSource, is left alone -- Debian's npm package would
#      conflict with it).
# - added setup-tls.sh (after the web UI setup, before the services are
#   installed): if the TLS certificate/key configured in garden.json don't
#   exist, it generates a temporary self-signed pair with gen-tmp-cert.sh,
#   owned by config.application_user:config.application_group.
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

# ---- 0. Announce system requirements ----
echo
echo "These setup steps must be run prior to installing GardenPi:"
echo "1. sudo raspi-config  .. enable SPI and I2C interfaces"
echo "2. NTP configuration sudo nano /etc/systemd/timesyncd.conf"
echo "   Set NTP=<address or hostname of your NTP server>"
echo "   sudo systemctl daemon-reload"
echo
echo "If you proceed before these steps are complete, the"
echo "installation may fail."
echo
echo "Pausing for 10 seconds.  Press <ctrl-c> to stop and run requirements."
sleep 10

# ---- 1. Clock: turn on NTP sync and wait for it ----
NTP_WAIT_SECONDS=90
clock_synced() {
  [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = "yes" ]
}
if command -v timedatectl >/dev/null 2>&1; then
  echo "==> Enabling NTP time synchronization..."
  if ! timedatectl set-ntp true; then
    echo "WARNING: could not enable NTP (is systemd-timesyncd installed?)."
  fi
  if ! clock_synced; then
    echo "==> Waiting up to ${NTP_WAIT_SECONDS}s for the clock to synchronize (currently: $(date))..."
    for ((i = 0; i < NTP_WAIT_SECONDS; i += 5)); do
      clock_synced && break
      sleep 5
    done
  fi
  if clock_synced; then
    echo "==> Clock synchronized: $(date)"
  else
    echo "WARNING: the clock is still not synchronized (it reads: $(date))."
    echo "         Continuing, but apt may reject repository signatures and watering"
    echo "         schedules will run at the wrong times until it is. Check that the Pi"
    echo "         can reach the internet on UDP port 123, then run 'timedatectl'."
  fi
  echo
else
  echo "WARNING: timedatectl not found; make sure the system clock is correct."
  echo
fi

# ---- 2. Package lists ----
echo "==> Updating package lists..."
apt-get update
echo

# ---- 3. Node.js for the web UI ----
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  echo "==> Node.js $(node --version) and npm $(npm --version) already installed."
else
  echo "==> Installing Node.js and npm..."
  apt-get install -y nodejs npm
fi
echo

./fix-perms.sh

./setup-venv.sh
./setup-api.sh
./setup-webui.sh

# TLS certificate/key from garden.json: generates a temporary self-signed
# pair if they don't exist yet, so gardenpi-api and gardenpi-webui can start.
./setup-tls.sh

./setup-sudoers.sh

./add-services.sh

./add-remove-logs-crontab.sh

echo
echo "GardenPi install complete."
