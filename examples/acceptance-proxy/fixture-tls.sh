#!/bin/sh
set -eu
# Generate afresh on every container start; image-cache age must not expire TLS.
mkdir -p /etc/nginx/fixture
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
    -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
    -keyout /etc/nginx/fixture/key.pem -out /etc/nginx/fixture/cert.pem 2>/dev/null
chmod 600 /etc/nginx/fixture/key.pem
printf 'fixture:%s\n' "$(openssl passwd -apr1 fixture-password)" > /etc/nginx/fixture/passwords
