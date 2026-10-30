#!/bin/zsh
# Builds the capture helper (bin/wr-core). Safe to rebuild any time: macOS permissions belong to
# the Window Remote Helper app, not to this program. ./install.sh copies it to where the helper
# runs it and restarts the helper.
set -e
# Compiler output is shown only when the build fails.
build() { local out; out=$("$@" 2>&1) || { print -r -- "$out"; print -P "%F{red}Build failed.%f"; exit 1; }; }
HERE="${0:A:h}"
ROOT="${HERE:h}"
mkdir -p "$ROOT/bin" "$HERE/build"
build swiftc -O -swift-version 5 -target "$(uname -m)-apple-macosx14.0" \
  -framework AppKit -framework ScreenCaptureKit -framework VideoToolbox -framework CoreMedia -framework Vision -framework IOKit \
  "$HERE"/*.swift -o "$HERE/build/wr-core"
build codesign --force --sign - --identifier local.window-remote.core "$HERE/build/wr-core"
mv -f "$HERE/build/wr-core" "$ROOT/bin/wr-core"
echo "Built: $ROOT/bin/wr-core"
