#!/bin/zsh
# Removes Window Remote from this Mac:  ./uninstall.sh
# Stops the remote, quits both apps, removes the login item, the Window Remote app, the helper and
# its data (paired phones, settings), the logs, and the Screen Recording and Accessibility entries.
# It asks first, and never touches this folder (the download itself): delete that yourself if you
# like.
#   --dry-run   only list what would be done
#   --yes       do not ask
DRY=0; YES=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --yes) YES=1 ;;
    *) print "Unknown option: $a (use --dry-run or --yes)"; exit 2 ;;
  esac
done

UID_NUM=$(id -u)
AGENT="$HOME/Library/LaunchAgents/local.window-remote.plist"
REMOVE=(
  "$AGENT"
  "$HOME/Applications/Window Remote.app"
  "$HOME/Library/Application Support/Window Remote"
  "$HOME/Library/Logs/Window Remote"
)
# Bundle IDs that macOS keeps permissions for: the helper (holds them), the app and the capture program.
BUNDLE_IDS=(local.window-remote local.window-remote.app local.window-remote.core)

print "This removes Window Remote from this Mac:"
print "  - stops the remote and quits the Window Remote app"
for p in "${REMOVE[@]}"; do [[ -e "$p" ]] && print "  - deletes $p"; done
print "  - removes Window Remote from Screen Recording and Accessibility in System Settings"
print "It keeps this folder: ${0:A:h}"
print "Your iPhone's Home Screen icon stays; remove it there (touch and hold, Remove App)."

if (( DRY )); then print "\nDry run: nothing was changed."; exit 0; fi
if (( ! YES )); then
  read -q "?Remove Window Remote now? (y/n) " || { print "\nNothing was changed."; exit 0; }
  print ""
fi

launchctl bootout "gui/$UID_NUM/local.window-remote" 2>/dev/null || true
osascript -e 'quit app id "local.window-remote.app"' >/dev/null 2>&1 || true
pkill -x WindowRemoteApp 2>/dev/null || true
pkill -x WindowRemote 2>/dev/null || true
pkill -x wr-core 2>/dev/null || true

for p in "${REMOVE[@]}"; do
  # Only the known Window Remote paths under this user's home folder, never anything else.
  [[ -n "$p" && "$p" == "$HOME"/Library/* || "$p" == "$HOME/Applications/Window Remote.app" ]] || continue
  [[ -e "$p" ]] && rm -rf "$p" && print "Deleted $p"
done
for id in "${BUNDLE_IDS[@]}"; do
  tccutil reset ScreenCapture "$id" >/dev/null 2>&1 || true
  tccutil reset Accessibility "$id" >/dev/null 2>&1 || true
done
print "Window Remote is removed."
