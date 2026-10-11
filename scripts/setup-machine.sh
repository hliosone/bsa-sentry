#!/usr/bin/env bash
# BSA Sentry - machine setup (the only part that needs sudo).
# Run once:  sudo bash scripts/setup-machine.sh
# Idempotent: every step checks first and skips if already done.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run me with sudo:  sudo bash scripts/setup-machine.sh" >&2
  exit 1
fi

ok()   { printf '  \033[32m[ok]\033[0m   %s\n' "$1"; }
skip() { printf '  \033[90m[skip]\033[0m %s\n' "$1"; }
act()  { printf '  \033[33m[do]\033[0m   %s\n' "$1"; }

echo "== 1. apt packages =="
MISSING=()
for p in git curl build-essential pkg-config python3-venv libudev-dev libusb-1.0-0-dev; do
  if dpkg -s "$p" >/dev/null 2>&1; then skip "$p"; else MISSING+=("$p"); fi
done
if [ ${#MISSING[@]} -gt 0 ]; then
  act "apt-get install ${MISSING[*]}"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${MISSING[@]}"
  ok "installed: ${MISSING[*]}"
fi

echo "== 2. Ledger udev rules (needed for Chrome WebHID + ledgerblue) =="
if grep -qril '2c97' /etc/udev/rules.d/ 2>/dev/null; then
  skip "Ledger udev rules already present"
else
  act "fetching LedgerHQ/udev-rules/add_udev_rules.sh"
  curl -fsSL https://raw.githubusercontent.com/LedgerHQ/udev-rules/master/add_udev_rules.sh | bash
  ok "udev rules installed"
fi
act "reloading udev rules"
udevadm control --reload-rules
udevadm trigger
ok "udev reloaded (replug the Flex if it was already plugged in)"

echo "== 3. cloudflared =="
if command -v cloudflared >/dev/null 2>&1; then
  skip "cloudflared $(cloudflared --version 2>&1 | head -1)"
else
  act "downloading cloudflared-linux-amd64.deb"
  TMPD=$(mktemp -d)
  curl -fsSL -o "$TMPD/cloudflared.deb" \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  DEBIAN_FRONTEND=noninteractive dpkg -i "$TMPD/cloudflared.deb" >/dev/null
  rm -rf "$TMPD"
  ok "cloudflared $(cloudflared --version 2>&1 | head -1)"
fi

echo "== 4. already fine on this machine, nothing to do =="
skip "Docker Engine $(docker --version 2>/dev/null | sed 's/Docker version //') + compose plugin"
skip "user '${SUDO_USER:-?}' already in the docker group"
skip "Google Chrome (.deb) at /opt/google/chrome/chrome"
skip "Node $(su - "${SUDO_USER:-root}" -c 'node --version' 2>/dev/null || echo '22') + pnpm, rustup: user-level, installed without sudo"

echo
echo "Setup done. Tell Claude: it will verify every item itself."
