#!/bin/bash
#
# setup-webui.sh
#
# Installs Node.js (if needed) and the web UI's npm dependencies into
# /opt/gardenpi/webui/node_modules.
#
# Usage:
#   sudo ./setup-webui.sh
#
# Safe to re-run: installs nothing that's already present, and `npm install`
# only fetches what's missing or changed.
#
# v2.0 2026/09/24
# - installs nodejs + npm from the OS repositories when node/npm are missing
#   (a fresh Raspberry Pi OS / Debian trixie image has neither, so the
#   install used to stop at "npm: command not found"). Debian trixie ships
#   Node 20; bookworm ships Node 18. gardenpi-webui.service runs
#   /usr/bin/node, which is where the OS package puts it.
# - refuses to continue on Node older than 18: older releases are past
#   end-of-life, and 18 is the oldest any supported Raspberry Pi OS ships.
# - added the #!/bin/bash line and strict error handling, so a failed step
#   stops the install instead of being skipped silently.
# - --omit=dev: production install only.

set -euo pipefail

WEBUI_DIR="/opt/gardenpi/webui"
RUN_AS_USER="pi"
MIN_NODE_MAJOR=18

if [ "$(id -u)" -ne 0 ]; then
  echo "This script needs to run as root. Try: sudo $0" >&2
  exit 1
fi

if [ ! -d "$WEBUI_DIR" ]; then
  echo "$WEBUI_DIR does not exist; unpack the GardenPi files into /opt/gardenpi first." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "==> Installing Node.js and npm from the OS repositories..."
  apt-get update
  apt-get install -y nodejs npm
fi

NODE_VERSION="$(node --version)"          # e.g. v20.19.2
NODE_MAJOR="${NODE_VERSION#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  echo "Node.js $NODE_VERSION is too old; the web UI needs Node $MIN_NODE_MAJOR or newer." >&2
  exit 1
fi
if [ "$(command -v node)" != "/usr/bin/node" ]; then
  echo "Note: node is at $(command -v node), but gardenpi-webui.service runs /usr/bin/node." >&2
  echo "      Adjust ExecStart in gardenpi-webui.service if /usr/bin/node doesn't exist." >&2
fi
echo "==> Using Node.js $NODE_VERSION, npm $(npm --version)"

chown -R "$RUN_AS_USER:$RUN_AS_USER" "$WEBUI_DIR"

echo "==> Installing web UI dependencies..."
/bin/su - "$RUN_AS_USER" -c "cd '$WEBUI_DIR' && npm install --omit=dev --no-audit --no-fund"

echo "Done. Web UI dependencies installed in $WEBUI_DIR/node_modules"
