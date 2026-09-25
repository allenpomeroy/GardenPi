#!/bin/bash
#
# gen-tmp-cert.sh
#
# generate temporary certificate to ensure gardenpi-webui and -api can start
#
# Usage:
#   ./gen-tmp-cert.sh [output-dir]
#
# Writes node.pem (certificate) and node.key (private key) into output-dir
# (default /opt/gardenpi/webui/certs), creating it if needed. Self-signed,
# valid 365 days. Browsers will warn that it isn't trusted until it's
# replaced with a real certificate; the web UI accepts it for its own calls
# to the API by default.
#
# setup-tls.sh (run by install-gardenpi.sh) calls this with a temporary
# output-dir and then moves the pair to garden.json's config.tls_cert_file /
# config.tls_key_file.
#
# v1.1 2026/09/25
# - optional output-dir argument; the directory is created if missing (the
#   default one doesn't exist on a fresh install, so openssl failed)
# - subjectAltName also lists this host's name, FQDN and IP addresses, so
#   browsers opening https://<hostname>:<port> only warn that it's
#   self-signed, not that it's for the wrong host
# - stops on the first error
# v1.0 - initial version

set -euo pipefail

certdir="${1:-/opt/gardenpi/webui/certs}"
mkdir -p "${certdir}"

# localhost + 127.0.0.1 as before, then short hostname, FQDN and every
# address this host currently has (duplicates removed).
san="DNS:localhost,IP:127.0.0.1"
for name in "$(hostname 2>/dev/null || true)" "$(hostname -f 2>/dev/null || true)"; do
  [ -n "$name" ] && [ "$name" != "localhost" ] && case ",$san," in *",DNS:$name,"*) ;; *) san="$san,DNS:$name" ;; esac
done
for ip in $(hostname -I 2>/dev/null || true); do
  case ",$san," in *",IP:$ip,"*) ;; *) san="$san,IP:$ip" ;; esac
done
cn="$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo localhost)"

openssl req -x509 -newkey rsa:4096 -keyout "${certdir}/node.key" \
  -out "${certdir}/node.pem" -days 365 -noenc \
  -subj "/C=US/ST=State/L=City/O=Organization/CN=${cn}" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" \
  -addext "subjectAltName=${san}"
