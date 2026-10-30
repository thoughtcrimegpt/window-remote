#!/bin/zsh
# Turns off "Start when I log in". The running remote keeps running until you log out or restart.
DEST="$HOME/Library/LaunchAgents/local.window-remote.plist"
[[ -f "$DEST" ]] && rm "$DEST"
echo "Window Remote will no longer start by itself when you log in."
