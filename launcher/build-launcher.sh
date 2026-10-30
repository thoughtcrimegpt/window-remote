#!/bin/zsh
# Builds the background helper app:
#   ~/Library/Application Support/Window Remote/Window Remote Helper.app
# macOS ties Screen Recording and Accessibility permission to this exact build, so it is built
# once and then left alone (rebuilding it means granting both permissions again). The parts that
# change (bin/wr-core and server/) live outside it and are rebuilt with core/build-core.sh.
# Pass --force to rebuild it anyway. It is named "Window Remote Helper" (in System Settings too), so
# it is easy to tell from the Window Remote app, which needs no permissions. Helpers built before
# that name was added keep the plain "Window Remote" name, since renaming them would reset the
# permissions.
set -e
# Compiler output is shown only when the build fails.
build() { local out; out=$("$@" 2>&1) || { print -r -- "$out"; print -P "%F{red}Build failed.%f"; exit 1; }; }
HERE="${0:A:h}"
SUPPORT="$HOME/Library/Application Support/Window Remote"
DEST="$SUPPORT/Window Remote Helper.app"
BUILD="$HERE/build"
if [[ -d "$DEST" && "$1" != "--force" ]]; then
  echo "Helper already installed (kept, so its permissions stay): $DEST"
  exit 0
fi
mkdir -p "$BUILD" "$SUPPORT"

build swiftc -O -swift-version 5 -target "$(uname -m)-apple-macosx14.0" "$HERE/main.swift" -o "$BUILD/WindowRemote"

ICONSET="$BUILD/AppIcon.iconset"
rm -rf "$ICONSET"   # build scratch only
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$HERE/icon-1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); sips -z $d $d "$HERE/icon-1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$BUILD/AppIcon.icns"

NEW="$BUILD/Window Remote Helper.app"
rm -rf "$NEW"   # build scratch only
mkdir -p "$NEW/Contents/MacOS" "$NEW/Contents/Resources"
cp "$BUILD/WindowRemote" "$NEW/Contents/MacOS/WindowRemote"
cp "$HERE/Info.plist" "$NEW/Contents/Info.plist"
cp "$BUILD/AppIcon.icns" "$NEW/Contents/Resources/AppIcon.icns"
build codesign --force --sign - --identifier local.window-remote "$NEW"

rm -rf "$DEST"
mv "$NEW" "$DEST"
echo "Installed: $DEST"
