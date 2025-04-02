#!/bin/bash
set -e

mkdir -p /app/ca /app/certs

if [ ! -f "/app/ca/ca.key" ]; then
  openssl genrsa -out /app/ca/ca.key 2048
  openssl req -new -x509 -days 3650 \
    -key /app/ca/ca.key \
    -out /app/ca/ca.crt \
    -subj "/CN=Proxy Root CA"
fi

if [ ! -f "/app/certs/cert.key" ]; then
  openssl genrsa -out /app/certs/cert.key 2048
fi
