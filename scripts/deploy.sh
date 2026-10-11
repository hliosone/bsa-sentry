#!/usr/bin/env bash
# Deploys BSA Sentry (server + website + merchants, HTTPS via Caddy) to any Linux host with
# Docker, over SSH. No cloud account needed: a small VPS is enough.
#
#   DEPLOY_HOST=user@203.0.113.7 DOMAIN=sentry.example.org scripts/deploy.sh
#
# The .env (secrets) is copied separately with mode 600 and never into the image.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DEPLOY_HOST:?set DEPLOY_HOST=user@host}"
: "${DOMAIN:?set DOMAIN=your.domain (DOMAIN and merchants.DOMAIN must resolve to the host)}"
DIR=${DEPLOY_DIR:-bsa-sentry}

echo "== syncing code to $DEPLOY_HOST:$DIR"
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude .run --exclude '**/target' --exclude 'apps/web/dist' \
  --exclude .env --exclude 'test-results' --exclude 'docs/screens' \
  ./ "$DEPLOY_HOST:$DIR/"

echo "== copying .env (secrets) with mode 600"
scp -q .env "$DEPLOY_HOST:$DIR/.env"
ssh "$DEPLOY_HOST" "chmod 600 $DIR/.env"

echo "== building and starting (server first, merchants wait for its healthcheck)"
ssh "$DEPLOY_HOST" "cd $DIR && DOMAIN=$DOMAIN docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build"

echo "== waiting for https://$DOMAIN/health"
for _ in $(seq 1 60); do
  if curl -fsS "https://$DOMAIN/health" >/dev/null 2>&1; then
    echo "up: https://$DOMAIN   MCP: https://$DOMAIN/mcp   merchants: https://merchants.$DOMAIN"
    exit 0
  fi
  sleep 5
done
echo "not healthy yet; check: ssh $DEPLOY_HOST 'cd $DIR && docker compose logs --tail 50'" >&2
exit 1
