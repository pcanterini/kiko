#!/bin/sh
# Builds a release of Kiko into dist/ (RELEASING.md): for each Mac chip, the `kiko` executable
# (Bun's --compile of src/main.ts), the helper app (scripts/build-helper-app.sh: the helpers that
# need a macOS permission, in an app of Kiko's own), the other Swift helpers and tmux (scripts/build-tmux.sh, cached in
# .cache/ after the first build), prebuilt, signed with the Developer ID identity and notarized by
# Apple, packed with what they need as
#   dist/kiko-<version>-darwin-<arch>.tar.gz    unpacks to kiko-<version>/
#   dist/kiko-<version>-darwin-<arch>.tar.gz.sha256
#   dist/latest.json                                the feed install.sh and `kiko update` read
# Nothing is uploaded. `pnpm release:build`.
#
#   KIKO_RELEASES_URL   where the files will be served (the URLs in latest.json): https://kiko.sh/releases
#   KIKO_RELEASE_NOTES  latest.json's one or two short lines
#   KIKO_ARCHS          the chips: "arm64 x64" (x64 is skipped, with a warning, if it can't be built)
#   KIKO_DIST           the output folder: dist
#   KIKO_VERSION        another version than package.json's (only to try an update)
#   KIKO_SIGN_IDENTITY  who signs: "Developer ID Application: Bald Cactus, LLC (YU89X2P36Z)" (its
#                          name or its SHA-1, as `security find-identity -v -p codesigning` lists it);
#                          "-" signs ad hoc and notarizes nothing: a build to try on this Mac, and the
#                          tests' (no Apple account, nothing sent to Apple, seconds instead of minutes)
#   KIKO_NOTARY_PROFILE the notarytool keychain profile it's notarized with: kiko-notary (made once
#                          with `xcrun notarytool store-credentials kiko-notary`, or set this to a
#                          profile you already have); "off" signs without notarizing
#   KIKO_GATEKEEPER_TIMEOUT how long, in seconds, to wait after notarizing for this Mac's Gatekeeper
#                          to accept a quarantined copy of each executable: 600
#   KIKO_NOTARIZE       now (before packing, waited for: the full path) or later: signed and packed
#                          without notarizing, for `pnpm ship`'s fast path, which notarizes the
#                          tarballs after publishing them (scripts/ship/ship.ts). The profile is
#                          still checked, so the notarizing after can't fail on it
#   KIKO_BUILD_CACHE    where the tmux build is cached (scripts/build-tmux.sh): .cache
# Both chips are built at once (each logs to its own file, shown when it's done), then packed at once.
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
# The app's names, from src/core/name.ts, the one place they're kept: what it's called (NAME), its
# executable, folders and tarballs (SLUG), where its releases are served (RELEASES_URL).
PRODUCT=$(node -e 'import("./src/core/name.ts").then((m) => console.log(m.NAME))')
SLUG=$(node -e 'import("./src/core/name.ts").then((m) => console.log(m.SLUG))')
RELEASES=$(node -e 'import("./src/core/name.ts").then((m) => console.log(m.RELEASES_URL))')
[ -n "$PRODUCT" ] && [ -n "$SLUG" ] && [ -n "$RELEASES" ] || { echo "release: couldn't read the names from src/core/name.ts" >&2; exit 1; }

VERSION=${KIKO_VERSION:-$(node -p 'require("./package.json").version')}
BASE=${KIKO_RELEASES_URL:-$RELEASES}
NOTES=${KIKO_RELEASE_NOTES:-"$PRODUCT $VERSION"}
ARCHS=${KIKO_ARCHS:-arm64 x64}
DIST=${KIKO_DIST:-$ROOT/dist}
IDENTITY=${KIKO_SIGN_IDENTITY:-"Developer ID Application: Bald Cactus, LLC (YU89X2P36Z)"}
PROFILE=${KIKO_NOTARY_PROFILE:-kiko-notary}
WHEN=${KIKO_NOTARIZE:-now}
case $WHEN in now | later) ;; *) echo "release: KIKO_NOTARIZE is now or later, not $WHEN" >&2; exit 1 ;; esac
MIN_MACOS=13.0 # Bun's own minimum; speech needs macOS 26 (SpeechAnalyzer) and says so on older ones
export KIKO_VERSION=$VERSION

# Ad hoc ("-"): no Apple identity, so no secure timestamp and nothing to notarize.
NOTARIZE=1
STAMP=--timestamp
if [ "$IDENTITY" = - ]; then
  NOTARIZE=0
  STAMP=--timestamp=none
elif [ "$PROFILE" = off ]; then
  NOTARIZE=0
fi
# Later: after it's published (pnpm ship's fast path), from the tarballs: nothing here sends to Apple.
LATER=0
[ "$NOTARIZE" = 1 ] && [ "$WHEN" = later ] && LATER=1

command -v bun >/dev/null || { echo "release: needs bun (https://bun.sh) to build the executable" >&2; exit 1; }
# Bun 1.3.3 is the first whose --compile takes --no-compile-autoload-dotenv/-bunfig (build_arch):
# without them the executable reads a .env and a bunfig.toml from whatever folder it's started in.
BUN_MIN=1.3.3
BUN_HAS=$(bun --version)
node -e 'const [a, b] = process.argv.slice(1).map((v) => v.split("-")[0].split(".").map(Number));
  process.exit((a.map((n, i) => n - b[i]).find((d) => d !== 0) ?? 0) < 0 ? 1 : 0)' "$BUN_HAS" "$BUN_MIN" ||
  { echo "release: needs Bun $BUN_MIN or newer (this is $BUN_HAS) to keep the executable from reading a .env where it's started; run: bun upgrade" >&2; exit 1; }
command -v swiftc >/dev/null || { echo "release: needs swiftc (Xcode or its Command Line Tools)" >&2; exit 1; }

# Every code-signing identifier is sh.kiko.<file> (sh.kiko.keychain is what the Keychain
# trusts with the keys: native/macos/keychain.swift), from src/core/name.ts, the one place it's kept.
IDS=$(node -e 'import("./src/core/name.ts").then((m) => console.log(m.IDENTIFIER))')
[ -n "$IDS" ] || { echo "release: couldn't read IDENTIFIER from src/core/name.ts" >&2; exit 1; }
# The team an installed copy takes updates from (name.ts TEAM): a build signed by another stops here,
# rather than being refused by every Mac it's sent to.
TEAM=$(node -e 'import("./src/core/name.ts").then((m) => console.log(m.TEAM))')
[ -n "$TEAM" ] || { echo "release: couldn't read TEAM from src/core/name.ts" >&2; exit 1; }
# The helper app (ARCHITECTURE.md, "The helper app"): "<NAME>.app", IDENTIFIER.helper, and the
# helpers it holds (src/platform/macos/native.ts BROKERED), which aren't in native/ any more.
APP_NAME=$(node -e 'import("./src/core/name.ts").then((m) => console.log(m.flavourNames("release").helperApp))')
APP_ID=$(node -e 'import("./src/core/name.ts").then((m) => console.log(m.flavourNames("release").helperAppId))')
[ "$APP_ID" = "$IDS.helper" ] || { echo "release: the helper app's id ($APP_ID) isn't $IDS.helper, which updates check it as" >&2; exit 1; }
IN_APP="mic hotkey speech permissions"
in_app() { case " $IN_APP " in *" $1 "*) return 0 ;; esac; return 1; }
ADHOC=0; [ "$IDENTITY" = - ] && ADHOC=1

BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
mkdir -p "$DIST"

# A release's checks, before anything is built (a release build takes minutes and the notarizing
# more): the identity is in the keychain and its key signs (that also reaches Apple's timestamp
# server), the notary profile is there and Apple takes it, and the tools are found.
if [ "$IDENTITY" != - ]; then
  for tool in codesign ditto security; do
    command -v "$tool" >/dev/null || { echo "release: needs $tool (part of macOS)" >&2; exit 1; }
  done
  if [ "$NOTARIZE" = 1 ]; then
    xcrun --find notarytool >/dev/null 2>&1 || { echo "release: needs notarytool (Xcode 13 or newer: xcode-select --install, or Xcode itself)" >&2; exit 1; }
  fi
  security find-identity -v -p codesigning | grep -qF -e "\"$IDENTITY\"" -e ") $IDENTITY " ||
    { echo "release: the signing identity isn't in your keychain, or isn't valid: $IDENTITY (security find-identity -v -p codesigning lists yours; KIKO_SIGN_IDENTITY=- builds one signed ad hoc)" >&2; exit 1; }
  cp /usr/bin/true "$BUILD/sign-check"
  said=$(codesign --force --sign "$IDENTITY" --options runtime --timestamp "$BUILD/sign-check" 2>&1) ||
    { echo "release: couldn't sign with $IDENTITY (its key refused, or Apple's timestamp server didn't answer): $said" >&2; exit 1; }
  if [ "$NOTARIZE" = 1 ]; then
    # Only whether it works: notarytool's own messages could say more about the account than a build log should,
    # so they're never printed, only looked at for a profile that isn't in the keychain.
    if ! said=$(xcrun notarytool history --keychain-profile "$PROFILE" --output-format json 2>&1); then
      case $said in
        *"No Keychain password item found"*)
          echo "release: no notary profile \"$PROFILE\" in your keychain: make it with xcrun notarytool store-credentials $PROFILE, or set KIKO_NOTARY_PROFILE to the one you have (KIKO_NOTARY_PROFILE=off signs without notarizing)" >&2 ;;
        *)
          echo "release: the notary profile \"$PROFILE\" didn't work (xcrun notarytool store-credentials $PROFILE makes it; offline, Apple can't be asked; KIKO_NOTARY_PROFILE=off signs without notarizing)" >&2 ;;
      esac
      exit 1
    fi
  else
    echo "release: KIKO_NOTARY_PROFILE=off: signed, not notarized (not for uploading)" >&2
  fi
fi

# codesign, quiet unless it fails ("replacing existing signature" is every time). Always the
# hardened runtime, ad hoc too, so a build tried on this Mac runs as a release does (Bun's JIT and
# the mic only work with their entitlements under it).
sign() { # <file> <identifier> [entitlements]
  if [ -n "${3:-}" ]; then
    said=$(codesign --force --sign "$IDENTITY" --options runtime $STAMP --identifier "$2" --entitlements "$3" "$1" 2>&1) || { echo "$said" >&2; return 1; }
  else
    said=$(codesign --force --sign "$IDENTITY" --options runtime $STAMP --identifier "$2" "$1" 2>&1) || { echo "$said" >&2; return 1; }
  fi
}

# Each signed file as signing should have left it: valid (strict), the hardened runtime, the
# entitlements asked for, and with the identity, a secure timestamp. Stops the whole build (exit 2:
# a chip's build that fails this way isn't left out, as one that can't be built is).
checked_signed() { # <file> <identifier> [entitlements]
  said=$(codesign --verify --strict --deep "$1" 2>&1) || { echo "release: ${1#"$BUILD"/}'s signature doesn't verify: $said" >&2; exit 2; }
  info=$(codesign -dvv "$1" 2>&1)
  case $info in *"Identifier=$2
"*) ;; *) echo "release: ${1#"$BUILD"/} isn't signed as $2" >&2; exit 2 ;; esac
  case $info in *"flags=0x"*"runtime"*) ;; *) echo "release: ${1#"$BUILD"/} isn't signed with the hardened runtime" >&2; exit 2 ;; esac
  if [ "$IDENTITY" != - ]; then
    case $info in *"Authority=Developer ID Application: "*) ;; *) echo "release: ${1#"$BUILD"/} isn't signed with a Developer ID Application identity" >&2; exit 2 ;; esac
    case $info in *"Timestamp="*) ;; *) echo "release: ${1#"$BUILD"/} has no secure timestamp (notarization needs one)" >&2; exit 2 ;; esac
  fi
  # The very requirement an installed copy checks an update's files against (core/updates/verify.ts
  # requirement): our team's Developer ID and this identifier; ad hoc, the identifier.
  req=$(node -e 'import("./src/core/updates/verify.ts").then((m) => console.log(m.requirement(process.argv[1], process.argv[2] === "1" ? { adHoc: true } : { team: process.argv[3] })))' "${2#"$IDS".}" "$ADHOC" "$TEAM")
  said=$(codesign --verify --strict "-R=$req" "$1" 2>&1) || { echo "release: ${1#"$BUILD"/} doesn't meet the requirement updates are checked with ($req): $said" >&2; exit 2; }
  if [ -n "${3:-}" ]; then
    has=$(codesign -d --entitlements - --xml "$1" 2>/dev/null)
    for key in $(grep -o 'com\.apple\.security\.[a-z.-]*' "$3"); do
      case $has in *"<key>$key</key>"*) ;; *) echo "release: ${1#"$BUILD"/} was signed without $key" >&2; exit 2 ;; esac
    done
  fi
}

# A release never reads a .env (ARCHITECTURE.md, "Two flavours"): the executable just built, started
# in a folder with a bunfig.toml whose preload would say so, must not run it (the -bunfig flag; the
# -dotenv one is beside it on the same line, and no .env is ever made here). Run with a home, socket
# and state of its own and no Keychain, as --version needs nothing else. Stops the whole build. It's
# also the signed executable starting under the hardened runtime.
HOST_ARCH=$(uname -m); [ "$HOST_ARCH" = x86_64 ] && HOST_ARCH=x64
reads_nothing_where_started() {
  probe="$BUILD/probe"
  mkdir -p "$probe/home"
  printf 'preload = ["./preload.js"]\n' > "$probe/bunfig.toml"
  echo 'console.log("READ THE FOLDER IT WAS STARTED IN")' > "$probe/preload.js"
  said=$(cd "$probe" && env -i PATH=/usr/bin:/bin HOME="$probe/home" TMPDIR="$probe" TMUX_TMPDIR="$probe" KIKO_KEYCHAIN=off \
    KIKO_SOCKET="$probe/app.sock" KIKO_STATE="$probe/state.json" "$1" --version 2>&1)
  rm -rf "$probe"
  case $said in
    *"READ THE FOLDER"*) echo "release: the executable read a bunfig.toml from the folder it was started in (built without --no-compile-autoload-bunfig/-dotenv?)" >&2; exit 2 ;;
    "$VERSION") ;;
    *) echo "release: the executable's --version said: $said" >&2; exit 2 ;;
  esac
}

# The relay's tunnel on the Bun that builds the executable: its vectors byte for byte. Tests run on
# Node; 0.2.0 shipped with a tunnel Bun's node:crypto couldn't run (no ChaCha20-Poly1305), refusing
# every phone through the relay.
bun scripts/relay-vectors.ts --check || { echo "release: the relay's tunnel doesn't run on this Bun ($(bun --version))" >&2; exit 1; }

echo "Bundling the app (src/main.ts)…"
bun scripts/bundle.ts "$BUILD/js" >/dev/null
# Every package the bundle drew from must have its licence text, and Bun's licence must be this
# Bun's, for THIRD_PARTY_NOTICES.md (written in each chip's folder below): checked now, before
# minutes of building. It also says what needs care (a GPL family or unknown licence).
node scripts/notices/notices.ts --meta "$BUILD/js/meta.json" --bun "$BUN_HAS" || { echo "release: the third-party notices can't be made (above)" >&2; exit 1; }

# One chip's folder, kiko-<version>/, in $BUILD/<arch>/, signed.
build_arch() {
  arch=$1
  swift_arch=$arch; [ "$arch" = x64 ] && swift_arch=x86_64
  dir="$BUILD/$arch/$SLUG-$VERSION"
  mkdir -p "$dir/native" "$dir/hooks/guard" "$dir/statusline" "$dir/pocket" "$dir/tmux" "$dir/bin" || return 1

  for source in native/macos/*.swift; do
    name=$(basename "$source" .swift)
    # Those that need a permission go in the helper app (below).
    in_app "$name" && continue
    echo "[$arch] $name helper…"
    swiftc -O -target "$swift_arch-apple-macos$MIN_MACOS" "$source" -o "$dir/native/$name" || return 1
    # The keychain helper's identifier is what its Keychain items trust (keychain.swift).
    sign "$dir/native/$name" "$IDS.$name" || return 1
    checked_signed "$dir/native/$name" "$IDS.$name"
  done

  # The helper app: mic, hotkey, speech and permissions in "<NAME>.app", built and signed inside out
  # (the same identity, the hardened runtime, a secure timestamp; mic and permissions with audio-input,
  # the bundle with that and apple-events: helper-app.entitlements), so macOS asks for and keeps their
  # permissions for it, not the terminal, and its control of Ghostty, iTerm or Terminal too.
  echo "[$arch] $APP_NAME.app…"
  stamp=""; [ "$IDENTITY" != - ] && stamp=--timestamp
  sh scripts/build-helper-app.sh --out "$dir" --flavour release --arch "$arch" --identity "$IDENTITY" $stamp --version "$VERSION" --build "$VERSION" >/dev/null || return 1
  app="$dir/$APP_NAME.app"
  checked_signed "$app" "$APP_ID" scripts/signing/helper-app.entitlements
  for h in $IN_APP; do
    entitlements=""
    case $h in mic | permissions) entitlements=scripts/signing/audio-input.entitlements ;; esac
    checked_signed "$app/Contents/Helpers/$h" "$APP_ID.$h" $entitlements
  done

  # tmux, for Kiko's own server (src/terminals/tmux/tmux.ts tmuxPath): built from source, its
  # licenses in the notices below, and the tmux-256color entry its panes' programs need (macOS 13
  # has none), compiled by macOS's own tic so macOS's ncurses reads it.
  sh scripts/build-tmux.sh "$arch" "$BUILD/$arch/tmux-build" || return 1
  cp "$BUILD/$arch/tmux-build/tmux" "$dir/bin/tmux" || return 1
  # THIRD_PARTY_NOTICES.md: Bun's licence, every bundled package's, and tmux's (scripts/notices/notices.ts).
  # Quiet (the check above said it all) unless it fails.
  said=$(node scripts/notices/notices.ts --meta "$BUILD/js/meta.json" --bun "$BUN_HAS" --tmux "$BUILD/$arch/tmux-build/THIRD-PARTY-NOTICES.txt" \
    --out "$dir/THIRD_PARTY_NOTICES.md" 2>&1) || { echo "$said" >&2; return 1; }
  sign "$dir/bin/tmux" "$IDS.tmux" || return 1
  checked_signed "$dir/bin/tmux" "$IDS.tmux"
  /usr/bin/tic -x -o "$dir/terminfo" src/terminals/tmux/terminfo/tmux-256color.terminfo || return 1

  # (Behind `build_arch … ||`, sh ignores set -e: each step returns on failure itself.)
  cp hooks/claude-code-hook.mjs hooks/codex-hook.mjs hooks/quick-permission.mjs hooks/quick-guard.mjs hooks/lib.mjs hooks/guard.mjs "$dir/hooks/" || return 1
  cp hooks/guard/*.mjs "$dir/hooks/guard/" || return 1
  cp "statusline/$SLUG-status.mjs" "$dir/statusline/" || return 1
  cp pocket/serve.py pocket/setup.sh pocket/requirements.txt "$dir/pocket/" || return 1
  cp src/terminals/tmux/tmux.conf src/terminals/tmux/placeholder.sh "$dir/tmux/" || return 1
  if [ -f LICENSE.md ]; then cp LICENSE.md "$dir/" || return 1; fi

  # The executable last: everything else is in place and signed, so its list of their SHA-256s
  # (core/release-files.ts) is baked into it, and its signature covers them. That's how an update
  # (or install.sh) knows the hooks and scripts beside it are ours: codesign can't sign those.
  # The helper app isn't in the list: it's checked as a whole by its own signature, against this
  # requirement (core/release-files.ts checkBundle), baked in beside the list.
  app_req=$(node -e 'import("./src/core/updates/verify.ts").then((m) => console.log(m.requirement("helper", process.argv[1] === "1" ? { adHoc: true } : { team: process.argv[2] })))' "$ADHOC" "$TEAM")
  files=$(node scripts/signing/release-files.ts "$dir" "$ADHOC" "$APP_NAME.app" "$app_req") || return 1
  echo "[$arch] the executable…"
  # Never a .env or bunfig.toml from the folder it's started in (Bun's executables read both by
  # default): an installed copy started in someone's project would take that project's API keys and
  # any KIKO_*/TTS=… in it. Only a checkout reads a .env, its own (src/core/app-root.ts ENV_FILE).
  bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --target="bun-darwin-$arch" --define "__KIKO_RELEASE__=$files" "$BUILD/js/main.js" --outfile "$dir/$SLUG" >/dev/null || return 1
  # Bun's own signature doesn't cover what --compile appends, and macOS kills an arm64 binary whose
  # signature doesn't check out: signed again, with Bun's JIT allowed (scripts/signing/kiko.entitlements).
  sign "$dir/$SLUG" "$IDS.$SLUG" "scripts/signing/$SLUG.entitlements" || return 1
  checked_signed "$dir/$SLUG" "$IDS.$SLUG" "scripts/signing/$SLUG.entitlements"
  if [ "$arch" = "$HOST_ARCH" ]; then
    reads_nothing_where_started "$dir/$SLUG"
    # Its own check passes on its own folder, as an update's will (the list baked in, nothing added after).
    said=$("$dir/$SLUG" _verify-files 2>&1) || { echo "release: [$arch] the executable's check of its own folder failed: $said" >&2; exit 2; }
    [ "$said" = "$VERSION" ] || { echo "release: [$arch] the executable's check of its own folder said $said, not $VERSION" >&2; exit 2; }
  fi
}

# Both chips in one submission to Apple's notary service (a zip of the folders as they'll ship),
# waited for, then the checks Gatekeeper's online lookup needs, by scripts/signing/notarize.ts (the
# same steps `pnpm ship` runs on the tarballs after publishing, on its fast path). On anything but
# Accepted, Apple's log is saved as $DIST/notary-log.json and the build stops. A bare executable
# can't have its ticket stapled: Gatekeeper looks it up online by the code's hash when a downloaded
# copy first runs. So after Accepted, each signed file must be in the ticket (Apple's log of it) and
# Apple must serve the ticket for it (scripts/signing/notarized.ts); then this Mac's Gatekeeper must
# accept a quarantined copy of each, as it would a browser download, asked again until it does:
# Apple's ticket service can take a few minutes after Accepted to answer the same everywhere
# (scripts/signing/gatekeeper.ts; KIKO_GATEKEEPER_TIMEOUT, 600 s). Nothing is packed before. No
# check here ever starts a quarantined copy (Gatekeeper's dialog would wait on it). Its progress is
# in $DIST/notary.json (scripts/ship/status.ts).
notarize() { # <arch>…
  mkdir -p "$BUILD/notary"
  for arch in "$@"; do ditto "$BUILD/$arch/$SLUG-$VERSION" "$BUILD/notary/$arch/$SLUG-$VERSION"; done
  mode=build; [ "${KIKO_RELEASE:-}" = full ] && mode=full
  KIKO_NOTARY_PROFILE=$PROFILE node scripts/signing/notarize.ts --version "$VERSION" --mode "$mode" \
    --status "$DIST/notary.json" --log-out "$DIST/notary-log.json" "$BUILD/notary" ||
    { echo "release: not notarized (above; $DIST/notary.json); nothing packed" >&2; exit 1; }
}

# One chip's folder packed, with its checksum, once it's signed and notarized.
pack_arch() { # <arch>
  tarball="$SLUG-$VERSION-darwin-$1.tar.gz"
  COPYFILE_DISABLE=1 tar -C "$BUILD/$1" -czf "$DIST/$tarball" "$SLUG-$VERSION"
  (cd "$DIST" && shasum -a 256 "$tarball" > "$tarball.sha256")
  echo "[$1] $DIST/$tarball ($(du -h "$DIST/$tarball" | cut -f1 | tr -d ' '))"
}

# Every chip at once, each in a subshell of its own logging to $BUILD/<arch>.log (shown when they're
# done, in order, so the build's output reads as before). Nothing they write is shared: each its own
# folder and Info.plists; tmux's cache takes two builds at once (build-tmux.sh). A build that can't
# be made returns 1 (x64 is then left out); one whose result is wrong exits 2, which stops everything.
echo "Building $ARCHS at once…"
pids=""
for arch in $ARCHS; do
  mkdir -p "$BUILD/$arch"
  # (Behind ||, as it was behind if before: set -e off inside it; each step returns on failure itself.)
  (build_arch "$arch" || exit 1) >"$BUILD/$arch.log" 2>&1 &
  pids="$pids $!"
done
built=""
stop=0
# $pids is the processes, one number each.
# shellcheck disable=SC2086
set -- $pids
for arch in $ARCHS; do
  pid=$1
  shift
  code=0
  wait "$pid" || code=$?
  cat "$BUILD/$arch.log"
  if [ "$code" = 0 ]; then
    built="${built:+$built }$arch"
  elif [ "$code" = 1 ] && [ "$arch" = x64 ]; then
    echo "release: couldn't build for x64 (Bun downloads its x64 runtime for that; tmux is cross-compiled); left out" >&2
  else
    echo "release: the $arch build failed" >&2
    stop=1
  fi
done
[ "$stop" = 0 ] || exit 1
[ -n "$built" ] || { echo "release: nothing was built" >&2; exit 1; }

if [ "$NOTARIZE" = 1 ] && [ "$LATER" = 0 ]; then
  # $built is the chips, one word each.
  # shellcheck disable=SC2086
  notarize $built
fi

# Packed at once too (gzip is most of it).
pids=""
for arch in $built; do
  pack_arch "$arch" >"$BUILD/$arch-pack.log" 2>&1 &
  pids="$pids $!"
done
packed=1
for pid in $pids; do wait "$pid" || packed=0; done
for arch in $built; do cat "$BUILD/$arch-pack.log"; done
[ "$packed" = 1 ] || { echo "release: packing failed" >&2; exit 1; }

assets=""
for arch in $built; do
  sha=$(cut -d' ' -f1 "$DIST/$SLUG-$VERSION-darwin-$arch.tar.gz.sha256")
  entry="\"darwin-$arch\": { \"url\": \"$BASE/$SLUG-$VERSION-darwin-$arch.tar.gz\", \"sha256\": \"$sha\" }"
  assets="${assets:+$assets,
    }$entry"
done

# The feed (the shared contract: install.sh, `kiko update`). JSON by hand, the notes escaped.
notes=$(printf '%s' "$NOTES" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0, "utf8")))')
cat > "$DIST/latest.json" <<EOF
{
  "version": "$VERSION",
  "date": "$(date -u +%Y-%m-%d)",
  "notes": $notes,
  "assets": {
    $assets
  }
}
EOF
case $IDENTITY:$NOTARIZE:$LATER in
  -:*) signed="signed ad hoc, not notarized: for this Mac and tests, not for uploading" ;;
  *:0:*) signed="signed with $IDENTITY, not notarized: not for uploading" ;;
  *:1:1) signed="signed with $IDENTITY; notarized after it's published (KIKO_NOTARIZE=later: pnpm ship)" ;;
  *) signed="signed with $IDENTITY and notarized" ;;
esac
echo "Done: $DIST/latest.json ($VERSION; $signed). Nothing is uploaded: RELEASING.md says how."
