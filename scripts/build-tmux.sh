#!/bin/sh
# Builds the tmux each release ships (RELEASING.md), for one Mac chip, from source:
#   sh scripts/build-tmux.sh <arm64|x64> <out folder>
# puts in <out folder>:
#   tmux                    the executable: libevent, utf8proc and jemalloc linked in (static), only
#                           macOS's own libraries beside it (its ncurses among them)
#   THIRD-PARTY-NOTICES.txt their licenses (tmux ISC, libevent BSD, utf8proc MIT, jemalloc BSD); release.sh
#                           puts them in the release's THIRD_PARTY_NOTICES.md (scripts/notices/notices.ts)
# Unsigned: scripts/release.sh signs it with the helpers.
#
# The versions are pinned and each source tarball is checked by its SHA-256 before it's used. The
# result is cached in .cache/tmux/ (git-ignored) by those versions, the chip and BUILD_REV, so a
# release build only compiles tmux the first time (about a minute a chip). Bump BUILD_REV when the
# flags below change.
#
# jemalloc: tmux 3.7c and later build with it on macOS by default (its configure insists), because
# macOS's calloc crashed tmux's server (tmux issue 5385). It's force-loaded: what makes it macOS's
# malloc is a constructor nothing else refers to, which a static link would otherwise leave out.
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
# The app's name (src/core/name.ts NAME), for the notices.
PRODUCT=$(node -e 'import("./src/core/name.ts").then((m) => console.log(m.NAME))')

TMUX_VERSION=3.8
TMUX_SHA=e79c699c7e949dccd0a4a125e17b8d1261e311b16979dbc8eb34542f3966d82e
LIBEVENT_VERSION=2.1.13-stable
LIBEVENT_SHA=f7e9383b8c0baa81b687e5b5eecc01beefaf1b19b64151d95ed61647fe7a315c
UTF8PROC_VERSION=2.12.0
UTF8PROC_SHA=a393fbef160835fb315bc3e91ba8d86f7a73a7cec9e6198b6c60b848b498bfeb
JEMALLOC_VERSION=5.4.0
JEMALLOC_SHA=200776fac271093e7c2f21edd6d62657ecd2be578d9328633f2a86bfa6ef4f1d
MIN_MACOS=13.0
BUILD_REV=1

arch=${1:?usage: build-tmux.sh <arm64|x64> <out folder>}
out=${2:?usage: build-tmux.sh <arm64|x64> <out folder>}
case "$arch" in
  # lg_page: the page size jemalloc is built for (16 KB on Apple silicon, 4 KB on Intel and under Rosetta).
  arm64) cpu=arm64 host=aarch64-apple-darwin lg_page=14 ;;
  x64) cpu=x86_64 host=x86_64-apple-darwin lg_page=12 ;;
  *) echo "build-tmux: unknown chip $arch" >&2; exit 1 ;;
esac

CACHE=${KIKO_BUILD_CACHE:-$ROOT/.cache}/tmux
key="tmux-$TMUX_VERSION-libevent-$LIBEVENT_VERSION-utf8proc-$UTF8PROC_VERSION-jemalloc-$JEMALLOC_VERSION-macos$MIN_MACOS-r$BUILD_REV"
built="$CACHE/$key/$arch"

if [ ! -x "$built/tmux" ] || [ ! -f "$built/THIRD-PARTY-NOTICES.txt" ]; then
  # A tarball, downloaded once into the cache, and checked every time it's used.
  fetch() { # <file> <url> <sha256>
    mkdir -p "$CACHE/downloads"
    at="$CACHE/downloads/$1"
    if [ ! -f "$at" ]; then
      # A name of this build's own while it downloads: both chips can be built at once (release.sh),
      # each fetching into the same cache; the rename is atomic, so neither reads half a file.
      curl -fsSL "$2" -o "$at.$$.part" || { rm -f "$at.$$.part"; echo "build-tmux: couldn't download $2" >&2; return 1; }
      mv "$at.$$.part" "$at"
    fi
    got=$(shasum -a 256 "$at" | cut -d' ' -f1)
    if [ "$got" != "$3" ]; then
      rm -f "$at"
      echo "build-tmux: $1's checksum is wrong (expected $3, got $got): deleted, nothing built" >&2
      return 1
    fi
  }
  fetch "tmux-$TMUX_VERSION.tar.gz" "https://github.com/tmux/tmux/releases/download/$TMUX_VERSION/tmux-$TMUX_VERSION.tar.gz" "$TMUX_SHA"
  fetch "libevent-$LIBEVENT_VERSION.tar.gz" "https://github.com/libevent/libevent/releases/download/release-$LIBEVENT_VERSION/libevent-$LIBEVENT_VERSION.tar.gz" "$LIBEVENT_SHA"
  fetch "utf8proc-$UTF8PROC_VERSION.tar.gz" "https://github.com/JuliaStrings/utf8proc/releases/download/v$UTF8PROC_VERSION/utf8proc-$UTF8PROC_VERSION.tar.gz" "$UTF8PROC_SHA"
  fetch "jemalloc-$JEMALLOC_VERSION.tar.bz2" "https://github.com/jemalloc/jemalloc/releases/download/$JEMALLOC_VERSION/jemalloc-$JEMALLOC_VERSION.tar.bz2" "$JEMALLOC_SHA"

  echo "[$arch] tmux $TMUX_VERSION from source (once; cached in ${CACHE#"$ROOT"/})…"
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  prefix="$work/prefix"
  log="$work/build.log"
  mkdir -p "$prefix/include" "$prefix/lib"
  for f in "$CACHE/downloads"/tmux-$TMUX_VERSION.tar.gz "$CACHE/downloads"/libevent-$LIBEVENT_VERSION.tar.gz "$CACHE/downloads"/utf8proc-$UTF8PROC_VERSION.tar.gz; do
    tar -xzf "$f" -C "$work"
  done
  tar -xjf "$CACHE/downloads/jemalloc-$JEMALLOC_VERSION.tar.bz2" -C "$work"

  # Only the SDK's headers and libraries: nothing of Homebrew's (or anything else a shell set up)
  # may end up linked in.
  unset CPATH C_INCLUDE_PATH LIBRARY_PATH PKG_CONFIG_PATH CFLAGS LDFLAGS CPPFLAGS 2>/dev/null || true
  export PKG_CONFIG=/usr/bin/false
  export CC="cc -arch $cpu -mmacosx-version-min=$MIN_MACOS"
  export CFLAGS=-O2
  # The other chip's build is a cross-compile (--host); this Mac's own is a plain one.
  cross=""
  [ "$(uname -m)" = "$cpu" ] || cross="--host=$host --build=$(uname -m | sed s/arm64/aarch64/)-apple-darwin"
  step() { # <what> <command…>: quiet, its output shown only when it fails
    what=$1
    shift
    if ! "$@" >>"$log" 2>&1; then
      tail -40 "$log" >&2
      echo "build-tmux: [$arch] $what failed" >&2
      return 1
    fi
  }

  (
    cd "$work/libevent-$LIBEVENT_VERSION"
    step "libevent's configure" ./configure $cross --prefix="$prefix" --disable-shared --enable-static \
      --disable-openssl --disable-samples --disable-libevent-regress --disable-debug-mode
    step "libevent" make -j4
    step "libevent's install" make install
  )
  (
    cd "$work/utf8proc-$UTF8PROC_VERSION"
    step "utf8proc" $CC $CFLAGS -DUTF8PROC_STATIC -c utf8proc.c -o utf8proc.o
    step "utf8proc's library" ar rcs "$prefix/lib/libutf8proc.a" utf8proc.o
    cp utf8proc.h "$prefix/include/"
  )
  (
    cd "$work/jemalloc-$JEMALLOC_VERSION"
    step "jemalloc's configure" ./configure $cross --prefix="$prefix" --disable-cxx --disable-debug --with-lg-page="$lg_page"
    step "jemalloc" make -j4 build_lib_static
    step "jemalloc's install" make install_lib_static install_include
  )
  (
    cd "$work/tmux-$TMUX_VERSION"
    step "tmux's configure" ./configure $cross --prefix="$prefix" --enable-utf8proc --enable-jemalloc \
      CPPFLAGS="-I$prefix/include -DUTF8PROC_STATIC" \
      LIBEVENT_CORE_CFLAGS="-I$prefix/include" LIBEVENT_CORE_LIBS="$prefix/lib/libevent_core.a" \
      LIBEVENT_CFLAGS="-I$prefix/include" LIBEVENT_LIBS="$prefix/lib/libevent_core.a" \
      LIBUTF8PROC_CFLAGS="-I$prefix/include -DUTF8PROC_STATIC" LIBUTF8PROC_LIBS="$prefix/lib/libutf8proc.a" \
      JEMALLOC_CFLAGS="-I$prefix/include" JEMALLOC_LIBS="-Wl,-force_load,$prefix/lib/libjemalloc.a"
    step "tmux" make -j4
  )

  bin="$work/tmux-$TMUX_VERSION/tmux"
  # Checked: the chip asked for, and nothing linked but macOS's own (/usr/lib, /System).
  lipo -archs "$bin" | grep -qx "$cpu" || { echo "build-tmux: [$arch] tmux was built for $(lipo -archs "$bin")" >&2; exit 1; }
  if otool -L "$bin" | tail -n +2 | awk '{print $1}' | grep -v -e '^/usr/lib/' -e '^/System/' >&2; then
    echo "build-tmux: [$arch] tmux links the libraries above, which aren't macOS's own" >&2
    exit 1
  fi
  strip -x "$bin"

  notices="$work/THIRD-PARTY-NOTICES.txt"
  {
    echo "$PRODUCT's release includes tmux, built from source with these libraries linked into it,"
    echo "and a terminfo entry for tmux-256color. Their licenses follow."
    for part in "tmux $TMUX_VERSION|tmux-$TMUX_VERSION/COPYING" "libevent $LIBEVENT_VERSION|libevent-$LIBEVENT_VERSION/LICENSE" \
      "utf8proc $UTF8PROC_VERSION|utf8proc-$UTF8PROC_VERSION/LICENSE.md" "jemalloc $JEMALLOC_VERSION|jemalloc-$JEMALLOC_VERSION/COPYING"; do
      printf '\n\n==== %s ====\n\n' "${part%%|*}"
      cat "$work/${part#*|}"
    done
    printf '\n\n==== ncurses terminfo (tmux-256color) ====\n\n'
    cat "$ROOT/src/terminals/tmux/terminfo/NOTICE"
  } >"$notices"

  mkdir -p "$built.part"
  cp "$bin" "$built.part/tmux"
  cp "$notices" "$built.part/"
  rm -rf "$built"
  mv "$built.part" "$built"
fi

mkdir -p "$out"
cp "$built/tmux" "$built/THIRD-PARTY-NOTICES.txt" "$out/"
