# Phase C — guided acceptance on the real hardware

**For the human, with Claude walking you through it one step at a time.**
Ordered so the risky hardware checks come first. Every step says: what you do · what you should
see (with the Speculos screenshot of the same screen) · what Claude checks · the fallback.

If you are Claude starting a Phase C session: read `CLAUDE.md`, `docs/PROGRESS.md` and this file
first, run the test suites, then walk the human through from step 1. A bug found on hardware
**first becomes a failing test**, then gets fixed.

> Status: skeleton. Each milestone in Phase B appends its real-hardware checks here.

## 0. Before anything

| | |
|---|---|
| **You do** | Plug the Flex. On the device: **Settings → Security → Auto-lock → Off**. Close Ledger Live / Ledger Wallet and any other tab or script talking to the Flex (only one program at a time). Make sure the laptop is on AC and set never to sleep. |
| **You see** | The Flex dashboard, unlocked. |
| **Claude checks** | `lsusb \| grep 2c97` → `Ledger Flex`; `stat -c '%a' /dev/hidraw*` → `666` on the Ledger nodes. |
| **Fallback** | No device on USB → replug, try another cable/port. Wrong permissions → `sudo udevadm control --reload-rules && sudo udevadm trigger`, then replug. |
| **Why** | Without this, the device returns `0x5515` after ~2 minutes and every later step fails for a reason that looks like a code bug. |

<!-- Phase B appends milestone steps below this line -->
