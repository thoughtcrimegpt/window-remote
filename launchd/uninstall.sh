#!/bin/zsh
# Turns off "Start when I log in" (the switch in the Window Remote app runs this). The running
# remote keeps running until you log out or restart. To remove Window Remote completely, run
# ./uninstall.sh in the main folder instead.
DEST="$HOME/Library/LaunchAgents/local.window-remote.plist"
[[ -f "$DEST" ]] && rm "$DEST"
echo "Window Remote will no longer start by itself when you log in."
