#!/usr/bin/env bash
# Generates a self-signed TLS certificate for local development/testing, written
# to ./certs/. By default this app expects a certificate/key already installed at
# /etc/pki/tls/certs/node.pem and /etc/pki/tls/private/node.key (the standard
# location used by the GardenAPI's own production Gunicorn setup) -- use this
# script only if you don't have those and want to test locally instead. If you
# use it, set server.tlsCertPath to ./certs/server.crt and server.tlsKeyPath to
# ./certs/server.key in garden.json.
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/certs"
mkdir -p "$DIR"
openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout "$DIR/server.key" \
  -out "$DIR/server.crt" \
  -days 825 \
  -subj "/CN=gardenpi.local" \
  -addext "subjectAltName=DNS:gardenpi.local,DNS:localhost,IP:127.0.0.1"
echo "Wrote $DIR/server.crt and $DIR/server.key"
