#!/bin/zsh
# Turns on "Start when I log in" (the switch in the Window Remote app runs this too).
# Writes the login item into ~/Library/LaunchAgents and loads it. A copy that is already running
# keeps running (the second one steps aside), so nothing is interrupted. To undo: ./uninstall.sh
set -e
HERE="${0:A:h}"
DEST="$HOME/Library/LaunchAgents/local.window-remote.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/Window Remote"
sed "s|__HOME__|$HOME|g" "$HERE/local.window-remote.plist" > "$DEST.tmp"
plutil -lint "$DEST.tmp" >/dev/null
mv "$DEST.tmp" "$DEST"
launchctl bootstrap "gui/$(id -u)" "$DEST" 2>/dev/null || true
echo "Window Remote now starts when you log in."
