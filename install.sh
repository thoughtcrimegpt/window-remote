#!/bin/zsh
# Window Remote installer. Run it from this folder:  ./install.sh
# Safe to run again (after pulling updates, or after moving this folder): permissions and paired
# phones are kept.
#
# What the background helper runs (the web server and the capture program) is copied into
# ~/Library/Application Support/Window Remote/runtime, so it never reads this folder. That matters
# when this folder is in Documents, Desktop, Downloads or iCloud Drive: macOS would otherwise stop
# the helper on a hidden "access files in your Documents folder" prompt.
set -e
ROOT="${0:A:h}"
SUPPORT="$HOME/Library/Application Support/Window Remote"
RUNTIME="$SUPPORT/runtime"
say() { print -P "%B==>%b $1"; }
fail() { print -P "%F{red}$1%f"; exit 1; }

say "Checking this Mac"
major=$(sw_vers -productVersion | cut -d. -f1)
(( major >= 14 )) || fail "Window Remote needs macOS 14 (Sonoma) or newer."
xcode-select -p >/dev/null 2>&1 && command -v swiftc >/dev/null || fail "Apple's command line tools are missing. Run:  xcode-select --install  then run ./install.sh again."
NODE=$(command -v node || true)
[[ -n "$NODE" ]] || fail "Node.js is missing. Install it from https://nodejs.org, then run ./install.sh again."
"$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || fail "Node.js 20 or newer is needed (found $("$NODE" -v)). Get the current version from https://nodejs.org."

# Tailscale: installed, signed in and connected? (The install goes on either way; the problem is
# repeated in a box at the end, where it cannot be missed.)
TS=$(for p in /usr/local/bin/tailscale /opt/homebrew/bin/tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do [[ -x "$p" ]] && { echo "$p"; break; }; done)
TS_PROBLEM=""
if [[ -z "$TS" ]]; then
  TS_PROBLEM="Tailscale is not installed on this Mac.|Install it from https://tailscale.com/download (Mac and iPhone)|and sign in to the same account on both."
else
  TS_STATE=$("$TS" status --json 2>/dev/null | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).BackendState||"")}catch{console.log("")}})' || true)
  case "$TS_STATE" in
    Running) ;;
    NeedsLogin|NoState|"") TS_PROBLEM="Tailscale is installed but not signed in.|Open Tailscale from the menu bar and sign in, using the same|account as on your iPhone." ;;
    *) TS_PROBLEM="Tailscale is installed but not connected ($TS_STATE).|Open Tailscale from the menu bar and turn it on (Connect)." ;;
  esac
fi

say "Installing the web server's parts"
(cd "$ROOT/server" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

say "Building the capture helper"
"$ROOT/core/build-core.sh"

say "Building the background helper app (once)"
"$ROOT/launcher/build-launcher.sh"

say "Building the Window Remote app"
"$ROOT/mac-app/build-app.sh"

say "Copying the remote into Application Support"
mkdir -p "$RUNTIME/bin"
rsync -a --delete "$ROOT/server/" "$RUNTIME/server/"
rsync -a --delete "$ROOT/launchd/" "$RUNTIME/launchd/"
cp -f "$ROOT/bin/wr-core" "$RUNTIME/bin/wr-core"
"$NODE" -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ remoteDir: process.argv[2], node: process.argv[3] }, null, 2) + "\n")' "$SUPPORT/launcher.json" "$RUNTIME" "$NODE"

say "Starting it, now and at every login"
launchctl bootout "gui/$(id -u)/local.window-remote" 2>/dev/null || true
"$RUNTIME/launchd/install.sh"

open "$HOME/Applications/Window Remote.app"

HELPER_NAME=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$SUPPORT/Window Remote Helper.app/Contents/Info.plist" 2>/dev/null || echo "Window Remote Helper")
print ""
print -P "%F{green}%BDone.%b%f The Window Remote window is open on your Mac. Next:"
print "  1. macOS asks for Screen Recording and Accessibility. In System Settings, Privacy & Security,"
print "     turn on the switch next to \"$HELPER_NAME\" in both lists. If macOS offers \"Quit & Reopen\", choose it."
print "  2. On your iPhone: turn Tailscale on, scan the QR code in the Window Remote window, open it in Safari."
print "  3. In Safari: Share, Add to Home Screen. Open \"Remote\" from the Home Screen and pair with the code your Mac shows."

if [[ -n "$TS_PROBLEM" ]]; then
  print ""
  print -P "%F{red}%B+------------------------------------------------------------------+%b%f"
  print -P "%F{red}%B|  WAIT: your iPhone cannot reach this Mac yet.                    |%b%f"
  for line in "${(@s:|:)TS_PROBLEM}"; do
    print -P "%F{red}%B|%b%f  ${(r:64:)line}%F{red}%B|%b%f"
  done
  print -P "%F{red}%B+------------------------------------------------------------------+%b%f"
fi
