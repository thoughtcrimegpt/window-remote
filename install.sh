#!/bin/zsh
# Window Remote installer. Run it from this folder:  ./install.sh
# Safe to run again (after pulling updates, or after moving this folder).
set -e
ROOT="${0:A:h}"
SUPPORT="$HOME/Library/Application Support/Window Remote"
say() { print -P "%B==>%b $1"; }
fail() { print -P "%F{red}$1%f"; exit 1; }

say "Checking this Mac"
major=$(sw_vers -productVersion | cut -d. -f1)
(( major >= 14 )) || fail "Window Remote needs macOS 14 (Sonoma) or newer."
xcode-select -p >/dev/null 2>&1 && command -v swiftc >/dev/null || fail "Apple's command line tools are missing. Run:  xcode-select --install  then run ./install.sh again."
NODE=$(command -v node || true)
[[ -n "$NODE" ]] || fail "Node.js is missing. Install it from https://nodejs.org (or: brew install node), then run ./install.sh again."
"$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || fail "Node.js 20 or newer is needed (found $("$NODE" -v))."
TS=$(for p in /usr/local/bin/tailscale /opt/homebrew/bin/tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do [[ -x "$p" ]] && { echo "$p"; break; }; done)
[[ -n "$TS" ]] || print -P "%F{yellow}Tailscale is not installed yet. Get it from https://tailscale.com/download (Mac and iPhone), sign in to the same account on both.%f"

say "Installing the web server's parts"
(cd "$ROOT/server" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

say "Building the capture helper"
"$ROOT/core/build-core.sh"

say "Building the background helper app (once)"
"$ROOT/launcher/build-launcher.sh"

say "Building the Window Remote app"
"$ROOT/mac-app/build-app.sh"

say "Pointing the helper at this folder"
mkdir -p "$SUPPORT"
"$NODE" -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ remoteDir: process.argv[2], node: process.argv[3] }, null, 2) + "\n")' "$SUPPORT/launcher.json" "$ROOT" "$NODE"

say "Starting it, now and at every login"
launchctl bootout "gui/$(id -u)/local.window-remote" 2>/dev/null || true
"$ROOT/launchd/install.sh"

open "$HOME/Applications/Window Remote.app"
cat <<'MSG'

Done. The Window Remote window is open on your Mac. Next:
  1. Grant Screen Recording and Accessibility when the window asks (System Settings, Privacy & Security).
  2. On your iPhone: turn Tailscale on, scan the QR code in the Window Remote window, and open it in Safari.
  3. In Safari: Share, Add to Home Screen. Open "Remote" from the Home Screen and pair with the code your Mac shows.
MSG
