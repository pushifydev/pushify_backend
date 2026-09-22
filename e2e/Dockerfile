# End-to-end test box: the "customer server" and the control plane in one privileged container.
# Pushify deploys to root@127.0.0.1 over SSH exactly as it would to a VPS — git clone, Docker
# build, nginx vhost, certbot — with Postgres for its database and Pebble (Let's Encrypt's test
# CA) instead of Let's Encrypt, so real certificates are issued without public DNS.
# Run with `npm run test:e2e` (locally and in CI); see e2e/boot.sh for what starts inside.
FROM node:20-bookworm

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      nginx certbot python3-certbot-nginx openssh-server postgresql git curl openssl ca-certificates iptables \
 && curl -fsSL https://get.docker.com | sh \
 && rm -rf /var/lib/apt/lists/*

COPY boot.sh /usr/local/bin/pushify-e2e-boot
RUN chmod +x /usr/local/bin/pushify-e2e-boot

WORKDIR /app
ENTRYPOINT ["/usr/local/bin/pushify-e2e-boot"]
