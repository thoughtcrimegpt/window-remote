#!/bin/zsh
# Builds "Window Remote.app" (the Mac window: status, pairing, permissions) into ~/Applications.
# Safe to rebuild any time. The background helper that holds the Screen Recording and
# Accessibility permissions is NOT inside this app (see launcher/build-launcher.sh).
set -e
HERE="${0:A:h}"
ROOT="${HERE:h}"
DEST="$HOME/Applications/Window Remote.app"
BUILD="$HERE/build"
mkdir -p "$BUILD" "$HOME/Applications"

swiftc -parse-as-library -O -swift-version 5 -target "$(uname -m)-apple-macosx14.0" -framework SwiftUI -framework AppKit -framework CoreImage \
  "$HERE/WindowRemoteApp.swift" -o "$BUILD/WindowRemoteApp"

NEW="$BUILD/Window Remote.app"
rm -rf "$NEW"   # build scratch only
mkdir -p "$NEW/Contents/MacOS" "$NEW/Contents/Resources"
cp "$BUILD/WindowRemoteApp" "$NEW/Contents/MacOS/WindowRemoteApp"
cp "$HERE/Info.plist" "$NEW/Contents/Info.plist"
cp "$ROOT/launcher/build/AppIcon.icns" "$NEW/Contents/Resources/AppIcon.icns" 2>/dev/null || true
codesign --force --sign - --identifier local.window-remote.app "$NEW"

rm -rf "$DEST"
mv "$NEW" "$DEST"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST" >/dev/null 2>&1 || true
echo "Installed: $DEST"
