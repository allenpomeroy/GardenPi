#!/bin/bash
#
# setup-tls.sh
#
# Makes sure the TLS certificate and key configured in garden.json exist, so
# gardenpi-api and gardenpi-webui can start. Run by install-gardenpi.sh.
#
#   config.tls_cert_file     e.g. /etc/pki/tls/certs/node.pem
#   config.tls_key_file      e.g. /etc/pki/tls/private/node.key
#   config.application_user  owner of the generated files (e.g. pi)
#   config.application_group group of the generated files (e.g. pi)
#
# If either file is missing (including when its directory doesn't exist),
# a new temporary self-signed pair is generated with gen-tmp-cert.sh and
# moved into place, owned by application_user:application_group:
#   certificate  0644
#   private key  0640
# A cert and key have to match, so if only one of the two exists it is
# replaced too; the old file is kept as <name>.bak.<timestamp>.
#
# Existing certificates are never replaced or re-owned: they may be real
# ones managed by something else (certbot, a shared /etc/pki). For those the
# script only checks that the application user can read both files and
# that they belong together, and warns if not.
#
# Usage:
#   sudo ./setup-tls.sh [path/to/garden.json]   (default /opt/gardenpi/config/garden.json)
#
# Safe to re-run: does nothing when both files are already in place.
#
# v1.0 2026/09/25 - initial version

set -euo pipefail

CONFIG="${1:-/opt/gardenpi/config/garden.json}"
SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"

if [ "$(id -u)" -ne 0 ]; then
  echo "This script needs to run as root. Try: sudo $0" >&2
  exit 1
fi
if [ ! -r "$CONFIG" ]; then
  echo "Cannot read $CONFIG" >&2
  exit 1
fi

# One python3 call reads all four values, separated by the ASCII unit
# separator (0x1f): a whitespace separator such as tab would let bash's
# `read` merge an empty value into its neighbour. System python3 only needs
# its standard library here.
if ! IFS=$'\x1f' read -r CERT KEY APP_USER APP_GROUP < <(python3 - "$CONFIG" <<'PY'
import json, sys
c = json.load(open(sys.argv[1])).get("config", {})
print("\x1f".join(str(c.get(k, "") or "") for k in
      ("tls_cert_file", "tls_key_file", "application_user", "application_group")))
PY
); then
  echo "Could not read the TLS settings from $CONFIG (is it valid JSON?)" >&2
  exit 1
fi

missing=()
[ -n "$CERT" ] || missing+=("config.tls_cert_file")
[ -n "$KEY" ] || missing+=("config.tls_key_file")
[ -n "$APP_USER" ] || missing+=("config.application_user")
[ -n "$APP_GROUP" ] || missing+=("config.application_group")
if [ ${#missing[@]} -gt 0 ]; then
  echo "garden.json is missing: ${missing[*]}" >&2
  exit 1
fi
if ! id "$APP_USER" >/dev/null 2>&1; then
  echo "config.application_user '$APP_USER' does not exist on this system." >&2
  exit 1
fi
if ! getent group "$APP_GROUP" >/dev/null 2>&1; then
  echo "config.application_group '$APP_GROUP' does not exist on this system." >&2
  exit 1
fi

echo "==> TLS certificate: $CERT"
echo "    TLS private key: $KEY"

# ---- Both present: leave them alone, just check them ----
if [ -f "$CERT" ] && [ -f "$KEY" ]; then
  echo "==> Both files exist; leaving them as they are."
  ok=1
  for f in "$CERT" "$KEY"; do
    if ! sudo -u "$APP_USER" test -r "$f"; then
      ok=0
      echo "WARNING: $APP_USER cannot read $f, so gardenpi-api / gardenpi-webui will fail to start."
      echo "         Fix with, e.g.:  sudo setfacl -m u:$APP_USER:r $f"
      echo "         (and make sure $APP_USER can enter every directory above it)"
    fi
  done
  if command -v openssl >/dev/null 2>&1; then
    cert_pub="$(openssl x509 -in "$CERT" -noout -pubkey 2>/dev/null || true)"
    key_pub="$(openssl pkey -in "$KEY" -pubout 2>/dev/null || true)"
    if [ -z "$cert_pub" ] || [ -z "$key_pub" ] || [ "$cert_pub" != "$key_pub" ]; then
      ok=0
      echo "WARNING: $CERT and $KEY don't look like a matching certificate/key pair."
    fi
  fi
  [ "$ok" -eq 1 ] && echo "==> $APP_USER can read both, and they match."
  exit 0
fi

# ---- One or both missing: generate a new pair ----
if ! command -v openssl >/dev/null 2>&1; then
  echo "==> Installing openssl..."
  apt-get install -y openssl
fi

stamp="$(date +%Y%m%d%H%M%S)"
for f in "$CERT" "$KEY"; do
  if [ -e "$f" ]; then
    echo "==> Keeping the existing $f as $f.bak.$stamp (its partner is missing, so both are replaced)."
    mv "$f" "$f.bak.$stamp"
  fi
done

# Directories: create what's missing. The key's directory gets 0750
# root:<application_group> so only that group can reach into it; the
# certificate's gets the usual 0755. Existing directories are not changed.
make_dir() {  # $1 = dir, $2 = mode, $3 = group
  if [ ! -d "$1" ]; then
    echo "==> Creating $1"
    mkdir -p "$1"
    chown "root:$3" "$1"
    chmod "$2" "$1"
  fi
}
make_dir "$(dirname "$CERT")" 0755 root
make_dir "$(dirname "$KEY")" 0750 "$APP_GROUP"

TMPDIR_CERT="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_CERT"' EXIT
echo "==> Generating a temporary self-signed certificate..."
"$SCRIPT_DIR/gen-tmp-cert.sh" "$TMPDIR_CERT" >/dev/null 2>&1 || {
  echo "gen-tmp-cert.sh failed; rerun it by hand to see why: $SCRIPT_DIR/gen-tmp-cert.sh /tmp/certtest" >&2
  exit 1
}

install -m 0644 -o "$APP_USER" -g "$APP_GROUP" "$TMPDIR_CERT/node.pem" "$CERT"
install -m 0640 -o "$APP_USER" -g "$APP_GROUP" "$TMPDIR_CERT/node.key" "$KEY"
echo "==> Installed $CERT (0644) and $KEY (0640), owned by $APP_USER:$APP_GROUP"
openssl x509 -in "$CERT" -noout -subject -enddate -ext subjectAltName 2>/dev/null | sed 's/^/    /'

# A directory that already existed may still block the application user
# (e.g. a root-only private-key directory).
for f in "$CERT" "$KEY"; do
  if ! sudo -u "$APP_USER" test -r "$f"; then
    echo "WARNING: $APP_USER still cannot read $f: a directory above it doesn't let $APP_USER in."
    echo "         Fix with, e.g.:  sudo chgrp $APP_GROUP $(dirname "$f") && sudo chmod 0750 $(dirname "$f")"
  fi
done

echo
echo "NOTE: this is a temporary self-signed certificate (valid 365 days). Browsers will"
echo "      warn until it is replaced with a real one at the same paths."
