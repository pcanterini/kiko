#!/bin/sh
# Installs Kyutai Pocket TTS into a venv of its own (never the system Python): POCKET_VENV, else
# pocket/.venv beside this script (a checkout). An installed copy passes
# ~/.local/share/kiko/pocket-venv, outside its version folders, so an update keeps it.
#
# It needs nothing installed beforehand. What it uses, the first there:
#   1. a uv on the PATH (yours: used, never changed);
#   2. the uv this script fetched before (pocket-uv/bin/uv beside the venv);
#   3. a Python 3.10 or later (pip, into the venv);
#   4. else it fetches uv itself: the release pinned below, from GitHub, its SHA-256 checked against
#      the pin before anything is unpacked (a failed download or a wrong checksum stops here, and
#      nothing is run), into pocket-uv/; that uv then fetches its own Python 3.12.
# Whichever uv runs, its Python and its download cache go in pocket-uv/ too (UV_PYTHON_INSTALL_DIR,
# UV_CACHE_DIR), so nothing lands in ~/.local/share/uv or ~/.cache/uv for Pocket, and `kiko
# uninstall` takes it all with the rest of ~/.local/share/kiko. Pocket's model (about 1 GB)
# downloads on the server's first start into pocket-hf/ beside the venv (HF_HOME:
# src/core/pocket-tts.ts, src/core/pocket-prep.ts), not the shared ~/.cache/huggingface.
#
# KIKO_UV_URL: fetch uv's archive from there instead (a mirror, or a file:// URL in the tests):
# its checksum must still match the pin.
set -e
cd "$(dirname "$0")"
VENV="${POCKET_VENV:-$(pwd)/.venv}"
VERSION="${POCKET_TTS_VERSION:-4.0.1}"
HERE="$(dirname "$VENV")"
UV_HOME="$HERE/pocket-uv"
OWN_UV="$UV_HOME/bin/uv"
mkdir -p "$HERE"

# uv's standalone release, pinned. The SHA-256s are the ones the release publishes beside each
# archive (uv-<arch>-apple-darwin.tar.gz.sha256). To move to a newer uv, change all three.
UV_VERSION=0.13.1
UV_SHA256_aarch64=cfe454573412ff7380d15fc7dae5997ab53ffce72fce0a78e91ddbc84001acd2
UV_SHA256_x86_64=bb7b805bdcf3d0bc8c74ceb94569e6b3e8aa35bd492acdbb9d46bf46d9d4ff6b

# uv's Python (only uv's own, never one of yours that could be upgraded away under the venv) and
# its cache, in Kiko's folder.
export UV_PYTHON_INSTALL_DIR="$UV_HOME/python" UV_PYTHON_BIN_DIR="$UV_HOME/python/bin" UV_CACHE_DIR="$UV_HOME/cache"
export UV_PYTHON_PREFERENCE=only-managed UV_PYTHON_DOWNLOADS=automatic

# A python3 of 3.10 or later. macOS's /usr/bin/python3 without the Command Line Tools only opens
# their installer, so it isn't run then.
has_python() {
  command -v python3 >/dev/null 2>&1 || return 1
  [ "$(command -v python3)" != /usr/bin/python3 ] || xcode-select -p >/dev/null 2>&1 || return 1
  python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null
}

# Fetches the pinned uv into $OWN_UV: downloaded and unpacked in a folder of its own beside it,
# checked before it's unpacked, moved into place only when it all worked.
fetch_uv() {
  case "$(uname -m)" in
    arm64) arch=aarch64 ;;
    # An Apple silicon Mac in a Rosetta terminal says x86_64: it gets the arm64 uv all the same.
    x86_64) if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then arch=aarch64; else arch=x86_64; fi ;;
    *) echo "Pocket TTS: there's no uv for this chip ($(uname -m))" >&2; return 1 ;;
  esac
  if [ "$arch" = aarch64 ]; then sha=$UV_SHA256_aarch64; else sha=$UV_SHA256_x86_64; fi
  name="uv-$arch-apple-darwin"
  url="${KIKO_UV_URL:-https://github.com/astral-sh/uv/releases/download/$UV_VERSION/$name.tar.gz}"
  tmp="$(mktemp -d "$HERE/pocket-uv-download.XXXXXX")" || return 1
  echo "Pocket TTS needs uv (no uv or Python 3.10+ here): fetching uv $UV_VERSION ($arch) from $url"
  if ! curl -fsSL --retry 2 "$url" -o "$tmp/uv.tar.gz"; then
    rm -rf "$tmp"
    echo "Pocket TTS: couldn't download uv from $url (offline?)" >&2
    return 1
  fi
  got="$(shasum -a 256 "$tmp/uv.tar.gz" | cut -d' ' -f1)"
  if [ "$got" != "$sha" ]; then
    rm -rf "$tmp"
    echo "Pocket TTS: the uv download's checksum is wrong (expected $sha, got $got): it was deleted, not run" >&2
    return 1
  fi
  if ! tar -xzf "$tmp/uv.tar.gz" -C "$tmp" || [ ! -f "$tmp/$name/uv" ]; then
    rm -rf "$tmp"
    echo "Pocket TTS: the uv download doesn't hold $name/uv" >&2
    return 1
  fi
  if ! { mkdir -p "$UV_HOME/bin" && chmod 755 "$tmp/$name/uv" && mv -f "$tmp/$name/uv" "$OWN_UV"; }; then
    rm -rf "$tmp"
    echo "Pocket TTS: couldn't put uv in $UV_HOME" >&2
    return 1
  fi
  rm -rf "$tmp"
  echo "uv $UV_VERSION is in $UV_HOME"
}

UV=""
if command -v uv >/dev/null 2>&1; then
  UV=uv
elif [ -x "$OWN_UV" ]; then
  UV="$OWN_UV"
elif ! [ -x "$VENV/bin/pip" ] && ! has_python; then
  fetch_uv || exit 1
  UV="$OWN_UV"
fi

# Not ready until the end: the app takes a venv with this file in it as not installed yet
# (src/core/pocket-tts.ts), so a half-done or failed install is never used.
INSTALLING="$VENV/.installing"
if [ -n "$UV" ]; then
  [ -x "$VENV/bin/python" ] || "$UV" venv --python 3.12 "$VENV"
  touch "$INSTALLING"
  "$UV" pip install --python "$VENV/bin/python" "pocket-tts==$VERSION"
else
  [ -x "$VENV/bin/pip" ] || python3 -m venv "$VENV"
  touch "$INSTALLING"
  # No download cache kept: nothing of Pocket's left in ~/Library/Caches/pip.
  "$VENV/bin/pip" install --no-cache-dir "pocket-tts==$VERSION"
fi
rm -f "$INSTALLING"
echo "pocket-tts $VERSION installed in $VENV"
