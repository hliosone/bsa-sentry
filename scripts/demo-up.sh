#!/usr/bin/env bash
# One command before a live demo or a recording: a fresh public tunnel, the server and the shops
# reconfigured for it, and the links to use. The only manual step left is re-adding the Claude
# connector with the printed MCP URL (a quick tunnel's address changes on every restart).
#
#   pnpm demo:up
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .run

# Stop any previous tunnel to the server (its address is dead once Cloudflare drops it).
for pid in $(pgrep -f "cloudflared tunnel .*localhost:8787" || true); do kill "$pid" 2>/dev/null || true; done

# Same flags as scripts/tunnel.ts: http2 + IPv4 (QUIC and IPv6 dropped on this network).
: > .run/tunnel-demo.log
setsid nohup cloudflared tunnel --no-autoupdate --protocol http2 --edge-ip-version 4 \
  --url http://localhost:8787 >> .run/tunnel-demo.log 2>&1 < /dev/null &

URL=""
for _ in $(seq 1 45); do
  URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' .run/tunnel-demo.log | head -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || { echo "cloudflared printed no URL; see .run/tunnel-demo.log" >&2; exit 1; }

# The server and the shops read their public addresses from .env.
sed -i "s|^PUBLIC_API_URL=.*|PUBLIC_API_URL=$URL|; s|^MERCHANT_URL=.*|MERCHANT_URL=$URL/shops|" .env
grep -q '^PUBLIC_API_URL=' .env || echo "PUBLIC_API_URL=$URL" >> .env
grep -q '^MERCHANT_URL=' .env || echo "MERCHANT_URL=$URL/shops" >> .env
docker compose up -d --build --force-recreate >/dev/null

# Wait until the whole path answers through the tunnel: site, then a shop asking for payment.
for _ in $(seq 1 90); do
  code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$URL/shops/cafe" || true)
  [ "$code" = "402" ] && break
  sleep 2
done
[ "$code" = "402" ] || { echo "the tunnel or the shops did not come up (last answer $code)" >&2; exit 1; }

cat <<MSG

  Ready.
  Website (Chrome, keep it open):  $URL
  Claude connector URL:            $URL/mcp
     claude.ai > Settings > Connectors: remove BSA Sentry, add it again with this URL.
  Shops:  $URL/shops/cafe · /shops/bakery · /shops/restaurant · /shops/wine · /shops/promo

MSG
