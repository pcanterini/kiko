#!/bin/sh
# Builds and signs the helper app (ARCHITECTURE.md, "The helper app"): "<NAME>.app" for the release,
# "<NAME> Dev.app" for a checkout (names and bundle ids from src/core/name.ts flavourNames, never
# written here), a background-only app (LSUIElement) whose executable, named after the app so
# System Settings' rows say its name (native/macos/app/host.swift), starts the helpers that need a
# macOS permission (native/macos/{mic,hotkey,speech,permissions}.swift, unchanged) from
# Contents/Helpers/, so macOS asks for and keeps those permissions for the app, not the terminal.
#
#   sh scripts/build-helper-app.sh --out <folder> [--flavour release|dev] [--arch arm64|x64]
#      [--identity <name or SHA-1, or - for ad hoc>] [--timestamp] [--version <v>] [--build <b>]
#      [--name <app name>] [--id <bundle id>] [--command <the command that runs it>]
#      [--app-socket <path>]
#
# --out: the folder the .app goes in (replacing one there). --flavour: whose names (dev). --arch:
# the chip (this Mac's). --identity: who signs (ad hoc, "-", by default); always with the hardened
# runtime, inside out (each helper as <bundle id>.<helper>, then the bundle), mic and permissions
# with com.apple.security.device.audio-input, the bundle with that and
# com.apple.security.automation.apple-events (scripts/signing/helper-app.entitlements: the
# AppleScripts it runs for `kiko`, host.swift's op osascript). --timestamp: a secure timestamp (a release:
# notarizing needs one; not with ad hoc). --version: CFBundleShortVersionString. --build: what
# `kiko` compares with the running app's (Info.plist BrokerBuild): the release's version, or a
# checkout's hash of these sources (src/platform/macos/helper-app.ts). --name, --id, --command: the
# tests' own, never the real app's. --app-socket: `kiko`'s hooks socket (name.ts flavourNames
# socket, /tmp/<command>.sock by default), which tells the app a `kiko` of its flavour is running
# (Info.plist BrokerAppSocket: it says nothing when brought to the front then). Prints the app's path last.
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
SRC=$ROOT/native/macos

OUT="" FLAVOUR=dev ARCH="" IDENTITY=- STAMP=--timestamp=none VERSION=0.0.0 BUILD_NO="" NAME="" ID="" COMMAND="" APP_SOCKET=""
while [ $# -gt 0 ]; do
  case $1 in
    --out) OUT=$2; shift 2 ;;
    --flavour) FLAVOUR=$2; shift 2 ;;
    --arch) ARCH=$2; shift 2 ;;
    --identity) IDENTITY=$2; shift 2 ;;
    --timestamp) STAMP=--timestamp; shift ;;
    --version) VERSION=$2; shift 2 ;;
    --build) BUILD_NO=$2; shift 2 ;;
    --name) NAME=$2; shift 2 ;;
    --id) ID=$2; shift 2 ;;
    --command) COMMAND=$2; shift 2 ;;
    --app-socket) APP_SOCKET=$2; shift 2 ;;
    *) echo "build-helper-app: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$OUT" ] || { echo "build-helper-app: --out <folder> is needed" >&2; exit 2; }
case $FLAVOUR in release | dev) ;; *) echo "build-helper-app: --flavour is release or dev" >&2; exit 2 ;; esac
[ "$IDENTITY" = - ] && STAMP=--timestamp=none

if [ -z "$NAME" ] || [ -z "$ID" ] || [ -z "$COMMAND" ]; then
  names=$(node -e 'import("./src/core/name.ts").then((m) => { const n = m.flavourNames(process.argv[1]); console.log([n.helperApp, n.helperAppId, n.command].join("\n")) })' "$FLAVOUR")
  [ -n "$NAME" ] || NAME=$(printf '%s\n' "$names" | sed -n 1p)
  [ -n "$ID" ] || ID=$(printf '%s\n' "$names" | sed -n 2p)
  [ -n "$COMMAND" ] || COMMAND=$(printf '%s\n' "$names" | sed -n 3p)
fi
[ -n "$NAME" ] && [ -n "$ID" ] && [ -n "$COMMAND" ] || { echo "build-helper-app: couldn't read the names from src/core/name.ts" >&2; exit 1; }
[ -n "$BUILD_NO" ] || BUILD_NO=$VERSION
[ -n "$APP_SOCKET" ] || APP_SOCKET=/tmp/$COMMAND.sock
case ${ARCH:-$(uname -m)} in arm64) SWIFT_ARCH=arm64 ;; x64 | x86_64) SWIFT_ARCH=x86_64 ;; *) echo "build-helper-app: unknown chip $ARCH" >&2; exit 2 ;; esac
ENT=$ROOT/scripts/signing/audio-input.entitlements
APP_ENT=$ROOT/scripts/signing/helper-app.entitlements

mkdir -p "$OUT"
WORK=$(mktemp -d "$OUT/.helper-app-XXXXXX")
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/$NAME.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Helpers" "$APP/Contents/Resources"

# What macOS shows when it asks. Input Monitoring has no reason of an app's own: macOS's prompt
# says what it is, and setup says why first.
MIC_WHY="$NAME listens while you hold the talk key (or all the time in hands-free mode), to hear what you tell your coding agents. Nothing is recorded."
SPEECH_WHY="$NAME turns what you say into text on this Mac, for your coding agents."
# Shown under macOS's "“<NAME>” wants access to control “Ghostty”" (or Terminal, iTerm).
EVENTS_WHY="$NAME types your words into the agent sessions running in Ghostty and opens its window in your terminal app."

plist_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
XNAME=$(plist_escape "$NAME")

# The helpers that ask for the mic or speech carry the reasons in an Info.plist linked into the
# binary too (a framework may look at the asking binary's own).
helper_info() { # <helper>
  cat > "$WORK/$1-Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$ID.$1</string>
  <key>CFBundleName</key><string>$XNAME</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>NSMicrophoneUsageDescription</key><string>$(plist_escape "$MIC_WHY")</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>$(plist_escape "$SPEECH_WHY")</string>
</dict>
</plist>
EOF
  echo "$WORK/$1-Info.plist"
}

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$ID</string>
  <key>CFBundleName</key><string>$XNAME</string>
  <key>CFBundleDisplayName</key><string>$XNAME</string>
  <key>CFBundleExecutable</key><string>$XNAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>$(plist_escape "$MIC_WHY")</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>$(plist_escape "$SPEECH_WHY")</string>
  <key>NSAppleEventsUsageDescription</key><string>$(plist_escape "$EVENTS_WHY")</string>
  <key>BrokerBuild</key><string>$(plist_escape "$BUILD_NO")</string>
  <key>BrokerCommand</key><string>$(plist_escape "$COMMAND")</string>
  <key>BrokerAppSocket</key><string>$(plist_escape "$APP_SOCKET")</string>
</dict>
</plist>
EOF

# Everything compiles at once; each logs to its own file, shown if it fails.
compile() { # <name> <source> <out> <min macOS> [plist]
  if [ -n "${5:-}" ]; then
    swiftc -O -target "$SWIFT_ARCH-apple-macos$4" "$2" -o "$3" -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$5" >"$WORK/$1.log" 2>&1
  else
    swiftc -O -target "$SWIFT_ARCH-apple-macos$4" "$2" -o "$3" >"$WORK/$1.log" 2>&1
  fi
}
pids=""
compile host "$SRC/app/host.swift" "$APP/Contents/MacOS/$NAME" 13.0 & pids="$pids $!"
compile hotkey "$SRC/hotkey.swift" "$APP/Contents/Helpers/hotkey" 13.0 & pids="$pids $!"
compile mic "$SRC/mic.swift" "$APP/Contents/Helpers/mic" 13.0 "$(helper_info mic)" & pids="$pids $!"
compile permissions "$SRC/permissions.swift" "$APP/Contents/Helpers/permissions" 13.0 "$(helper_info permissions)" & pids="$pids $!"
# SpeechAnalyzer: macOS 26 (on an older Mac it says so, and the app uses another engine).
compile speech "$SRC/speech.swift" "$APP/Contents/Helpers/speech" 26.0 "$(helper_info speech)" & pids="$pids $!"
# The icon's drawer runs here, so it's built for this Mac's chip.
swiftc -O "$SRC/app/icon.swift" -o "$WORK/icon" >"$WORK/icon.log" 2>&1 & pids="$pids $!"
failed=0
for pid in $pids; do wait "$pid" || failed=1; done
if [ "$failed" = 1 ]; then
  for f in "$WORK"/*.log; do grep -q error "$f" && { echo "── $(basename "$f" .log)"; cat "$f"; }; done >&2
  echo "build-helper-app: the build failed" >&2
  exit 1
fi

"$WORK/icon" "$NAME" "$WORK/AppIcon.iconset"
iconutil -c icns "$WORK/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$WORK/AppIcon.iconset"

sign() { # <path> [identifier] [entitlements]: a helper by its identifier, or the bundle (its own id)
  if [ -n "${2:-}" ] && [ -n "${3:-}" ]; then
    said=$(codesign --force --sign "$IDENTITY" --options runtime $STAMP --identifier "$2" --entitlements "$3" "$1" 2>&1) || { echo "$said" >&2; return 1; }
  elif [ -n "${2:-}" ]; then
    said=$(codesign --force --sign "$IDENTITY" --options runtime $STAMP --identifier "$2" "$1" 2>&1) || { echo "$said" >&2; return 1; }
  else
    said=$(codesign --force --sign "$IDENTITY" --options runtime $STAMP --entitlements "$APP_ENT" "$1" 2>&1) || { echo "$said" >&2; return 1; }
  fi
}
for h in hotkey speech; do sign "$APP/Contents/Helpers/$h" "$ID.$h"; done
for h in mic permissions; do sign "$APP/Contents/Helpers/$h" "$ID.$h" "$ENT"; done
sign "$APP"
said=$(codesign --verify --deep --strict "$APP" 2>&1) || { echo "build-helper-app: the bundle's signature doesn't verify: $said" >&2; exit 1; }

# In place: the old bundle out, the new one in (a running copy keeps its open files; `kiko` sees
# the new build and restarts it).
rm -rf "${OUT:?}/$NAME.app"
mv "$APP" "$OUT/$NAME.app"
echo "$OUT/$NAME.app"
