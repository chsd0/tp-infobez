#!/bin/bash
set -e

CN=$1
CA_DIR=${CA_DIR:-./ca}
CERT_DIR=${CERT_DIR:-./certs}

# Генерация CSR
openssl req -new -key ${CERT_DIR}/cert.key -subj "/CN=${CN}" -sha256 -out ${CERT_DIR}/${CN}.csr

# Подпись сертификата
openssl x509 -req -days 365 \
  -CA ${CA_DIR}/ca.crt \
  -CAkey ${CA_DIR}/ca.key \
  -CAcreateserial \
  -in ${CERT_DIR}/${CN}.csr \
  -out ${CERT_DIR}/${CN}.crt

rm ${CERT_DIR}/${CN}.csr