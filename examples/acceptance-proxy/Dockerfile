# Disposable synthetic acceptance only. Never use these credentials in production.
FROM nginx:alpine
RUN apk add --no-cache openssl
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY fixture-tls.sh /docker-entrypoint.d/15-fixture-tls.sh
RUN chmod +x /docker-entrypoint.d/15-fixture-tls.sh
