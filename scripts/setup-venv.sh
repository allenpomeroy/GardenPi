#!/bin/bash
#
# setup-venv.sh
#
# Creates the GardenPi Python virtual environment at /opt/gardenpi/python3
# and installs everything from requirements.txt into it.
#
# Usage:
#   sudo ./setup-venv.sh
#
# Run once during setup, and again any time requirements.txt changes.
#
# v2.1 2026/09/24
# - added swig and liblgpio-dev: pip has no prebuilt lgpio wheel for newer
#   Pythons (e.g. 3.13 on Debian/Raspberry Pi OS trixie), so it builds
#   lgpio from source, which needs swig to generate the Python wrapper and
#   the lgpio C library headers to link against (liblgpio-dev, which also
#   pulls in the liblgpio1 runtime library the built module loads). Without
#   them the install stops at "command 'swig' failed", then at
#   "cannot find -llgpio". liblgpio-dev comes from the Raspberry Pi archive
#   (archive.raspberrypi.com), present on Raspberry Pi OS.
#
# v2.0 2026/08/27
# - added build-essential: the lgpio pip package (replacing RPi.GPIO for
#   raw GPIO pin access - see garden_gpio.py and requirements.txt) compiles
#   a small C extension from source on install and needs a compiler
#   present to do that.
# - dropped libgpiod2: it was never actually used by anything in this
#   codebase (Adafruit-Blinka's I2C/SPI bus access doesn't go through
#   libgpiod), and lgpio talks to the gpiochip character device directly
#   without it.

set -euo pipefail

VENV_DIR="/opt/gardenpi/python3"
REQUIREMENTS="$(dirname "$0")/requirements.txt"
RUN_AS_USER="pi"

if [ "$(id -u)" -ne 0 ]; then
    echo "This script needs to run as root (it creates /opt/gardenpi and chowns it to $RUN_AS_USER)." >&2
    echo "Try: sudo $0" >&2
    exit 1
fi

echo "==> Installing system packages needed for the venv and hardware libraries..."
apt-get update
apt-get install -y python3-venv python3-dev python3-pip build-essential swig liblgpio-dev i2c-tools

echo "==> Creating $VENV_DIR ..."
mkdir -p /opt/gardenpi
python3 -m venv "$VENV_DIR"

echo "==> Setting ownership to $RUN_AS_USER..."
chown -R "$RUN_AS_USER:$RUN_AS_USER" /opt/gardenpi

echo "==> Upgrading pip..."
sudo -u "$RUN_AS_USER" "$VENV_DIR/bin/pip" install --upgrade pip

echo "==> Installing requirements from $REQUIREMENTS ..."
sudo -u "$RUN_AS_USER" "$VENV_DIR/bin/pip" install -r "$REQUIREMENTS"

echo
echo "Done. Virtual environment ready at $VENV_DIR"
echo "Run scripts with, e.g.:"
echo "  $VENV_DIR/bin/python3 /opt/gardenpi/bin/adc-handler.py --hwversion 7.1"
echo
echo "Reminder: enable I2C and SPI if you haven't already (raspi-config > Interface"
echo "Options), then reboot before running anything that talks to the MCP23017/MCP3008."
echo
echo "If you uncommented pigpio in requirements.txt instead of using the default"
echo "lgpio backend, also install and enable the pigpio daemon:"
echo "  sudo apt-get install -y pigpio && sudo systemctl enable --now pigpiod"
