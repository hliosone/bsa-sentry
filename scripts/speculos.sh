#!/usr/bin/env bash
# Starts / stops the Speculos Flex emulator running the BSA Sentry app.
#
#   scripts/speculos.sh start [--fresh]   --fresh wipes the emulated NVM first
#   scripts/speculos.sh stop
#   scripts/speculos.sh restart
#
# The seed comes from .env (SPECULOS_SEED), never Speculos' public default one: that seed is
# shared by everyone, so anything signed under it is worthless.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

NAME=bsa-speculos
API_PORT=${SPECULOS_API_PORT:-5000}
APDU_PORT=${SPECULOS_APDU_PORT:-9999}
ELF_DIR="$PWD/device-app/app/target/flex/release"
NVM_DIR="$PWD/.run/speculos-nvm"

stop() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }

start() {
  [ -f "$ELF_DIR/bsa-sentry" ] || { echo "build it first: make device" >&2; exit 1; }
  [ -n "${SPECULOS_SEED:-}" ] || { echo "SPECULOS_SEED missing from .env" >&2; exit 1; }
  stop
  [ "${1:-}" = "--fresh" ] && rm -rf "$NVM_DIR"
  mkdir -p "$NVM_DIR" .run

  docker run -d --name "$NAME" \
    -p "$API_PORT:5000" -p "$APDU_PORT:9999" \
    -v "$ELF_DIR":/apps:ro \
    -v "$NVM_DIR":/speculos/nvm \
    ghcr.io/ledgerhq/speculos:latest \
    --model flex --seed "$SPECULOS_SEED" --display headless \
    --api-port 5000 --apdu-port 9999 \
    /apps/bsa-sentry >/dev/null

  # Wait for the REST API rather than sleeping a fixed amount.
  for _ in $(seq 1 50); do
    if curl -fsS --max-time 1 "http://localhost:$API_PORT/events" >/dev/null 2>&1; then
      echo "speculos up on :$API_PORT (apdu :$APDU_PORT)"
      exit 0
    fi
    sleep 0.2
  done
  echo "speculos did not come up; logs:" >&2
  docker logs "$NAME" >&2
  exit 1
}

case "${1:-start}" in
  start) shift || true; start "${1:-}" ;;
  stop) stop; echo "speculos stopped" ;;
  restart) shift || true; start "${1:-}" ;;
  *) echo "usage: $0 {start|stop|restart} [--fresh]" >&2; exit 1 ;;
esac
