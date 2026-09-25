#!/bin/bash
#
# gen-tmp-cert.sh 
#
# generate temporary certificate to ensure gardenpi-webui and -api can start
#

certdir="/opt/gardenpi/webui/certs"

openssl req -x509 -newkey rsa:4096 -keyout ${certdir}/node.key \
  -out ${certdir}/node.pem -days 365 -noenc \
  -subj "/C=US/ST=State/L=City/O=Organization/CN=localhost" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

