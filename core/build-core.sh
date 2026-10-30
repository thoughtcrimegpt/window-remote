#!/bin/zsh
# Builds the capture helper (bin/wr-core). Safe to rebuild any time: macOS permissions belong to
# the Window Remote Helper app, not to this program. A running helper restarts it afterwards.
set -e
HERE="${0:A:h}"
ROOT="${HERE:h}"
mkdir -p "$ROOT/bin" "$HERE/build"
swiftc -O -swift-version 5 -target "$(uname -m)-apple-macosx14.0" \
  -framework AppKit -framework ScreenCaptureKit -framework VideoToolbox -framework CoreMedia -framework Vision -framework IOKit \
  "$HERE"/*.swift -o "$HERE/build/wr-core"
codesign --force --sign - --identifier local.window-remote.core "$HERE/build/wr-core"
mv -f "$HERE/build/wr-core" "$ROOT/bin/wr-core"
echo "Built: $ROOT/bin/wr-core"
# Restart the helper inside the running launcher, if any.
pkill -HUP -x WindowRemote 2>/dev/null && echo "Restarted the running helper." || true
