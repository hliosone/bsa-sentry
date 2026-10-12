#!/usr/bin/env bash
# Builds the Flex ELF in Ledger's Docker image.
#
# Two things that cost hours if forgotten:
#  - `flex` is mandatory: the default cargo-ledger target is apex_p.
#  - `cargo clean -p ledger_device_sdk` after any change to path/curve in Cargo.toml, or the
#    old install params are reused and the app crashes the moment it derives a key.
# The mount is the whole device-app/ directory, not just app/, because app/ has a path
# dependency on ../core and the container must be able to see it.
#
# FEATURES=diag scripts/device-build.sh   builds the hardware-diagnosis variant (never ship it).
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE=ghcr.io/ledgerhq/ledger-app-builder/ledger-app-dev-tools:latest

docker run --rm \
  -v "$PWD/device-app":/work \
  -v ledger-cargo-registry:/opt/.cargo/registry \
  -w /work/app \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" -e FEATURES="${FEATURES:-}" \
  "$IMAGE" \
  sh -c 'cargo clean -p ledger_device_sdk --target flex --release 2>/dev/null; \
         cargo ledger build flex ${FEATURES:+-- --features $FEATURES}; \
         rc=$?; \
         chown -R "$HOST_UID:$HOST_GID" /work/app/target /work/core/target 2>/dev/null || true; \
         exit $rc'

echo
ls -l device-app/app/target/flex/release/bsa-sentry*
