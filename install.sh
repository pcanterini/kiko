#!/bin/sh
# Installs Kiko: curl -fsSL https://kiko.sh | sh
# (An invite's install link, kiko.sh/i/<token>, is this same script with its token written in below:
# the token is optional, kept for invites sent during the private beta.)
#
# What it does, all in your home folder (nothing needs sudo, nor Homebrew):
#   1. checks first for what Kiko needs that isn't Kiko's: a coding agent (Claude Code, Codex,
#      OpenCode or T3 Code). With none, it offers to install Claude Code with its own installer, and
#      says how to get one when you'd rather not. (tmux comes with Kiko.)
#   2. downloads the latest release for your Mac's chip, checks its SHA-256, and checks that it's
#      Kiko's developer's: every executable signed with their Developer ID (Apple's codesign,
#      part of macOS), and the signed kiko vouching for every other file and for its version
#   3. unpacks it into ~/.local/share/kiko/versions/<version>/ and points
#      ~/.local/share/kiko/current at it (the one before: previous), and
#      ~/.local/bin/kiko at current/kiko
#   4. puts ~/.local/bin on your PATH when it isn't: one line at the end of your shell's startup
#      file (~/.zshrc; ~/.bash_profile; fish's conf.d/kiko.fish), marked as Kiko's, added once
#   5. starts downloading Pocket, Kiko's free voice (about 1 GB, into ~/.local/share/kiko), in
#      the background, so it's ready by the time setup says hello (`kiko _run pocket`: nothing
#      when another voice is chosen)
#   6. runs `kiko setup`, which asks before changing anything
# `kiko uninstall` takes it all out again, that PATH line included.
#
# KIKO_RELEASES_URL: where the releases are (https://kiko.sh/releases).
# KIKO_INSTALL_TOKEN: an invite's install token, when the script didn't come with one.
# KIKO_NO_SETUP=1: stop after installing (also when there's no terminal to ask in).
# KIKO_CLAUDE_INSTALLER: Claude Code's installer (https://claude.ai/install.sh).
# KIKO_INSTALL_ADHOC=1: the tests' (and a build tried on this Mac's) releases, signed ad hoc, are
#   taken too: each executable still needs its identifier, and the files and version their kiko's.
set -eu

# All of it in one function, called on the last line: a download cut short (curl | sh runs what has
# come so far) ends inside it, and runs nothing.
main() {

# The app's names (src/core/name.ts NAME, SLUG, RELEASES_URL), repeated here: this script runs on
# its own. Everything else it names is made from them. tests/unit/core/name.test.ts checks they match.
NAME=Kiko
SLUG=kiko
RELEASES=${KIKO_RELEASES_URL:-https://kiko.sh/releases}
CLAUDE_INSTALLER=${KIKO_CLAUDE_INSTALLER:-https://claude.ai/install.sh}
SHARE="$HOME/.local/share/$SLUG"
BIN="$HOME/.local/bin"
# The invite: the install link's token (kiko.sh/i/<token> writes it in on the next line), else
# KIKO_INSTALL_TOKEN, else the one kept from an install before. Sent with each request for the
# release, beside this Mac's install id (random, made once). Both are kept in ~/.local/share/kiko,
# readable by you only, where `kiko update` finds them (src/core/updates/invite.ts reads the same
# files). Neither says anything about you or this Mac.
INVITE=${KIKO_INSTALL_TOKEN:-}
TOKEN_FILE="$SHARE/install-token"
ID_FILE="$SHARE/install-id"
# What marks the PATH line as Kiko's: `kiko uninstall` (src/uninstall.ts PATH_MARK) takes out that line, no other.
MARK="# added by the $NAME installer ($SLUG uninstall removes this line)"
# Who signs Kiko (src/core/name.ts TEAM and IDENTIFIER, repeated here: this script runs on its own).
TEAM=YU89X2P36Z
IDS=sh.kiko

say() { printf '%s\n' "$@"; }
die() { printf '%s install: %s\n' "$SLUG" "$*" >&2; exit 1; }
# A path with your home folder as ~.
short() { case "$1" in "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;; *) printf '%s' "$1" ;; esac; }

[ "$(uname -s)" = Darwin ] || die "$NAME runs on macOS only, for now."
case "$(uname -m)" in
  arm64) arch=arm64 ;;
  # An Apple silicon Mac in a Rosetta terminal says x86_64: it gets the arm64 build all the same.
  x86_64) if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then arch=arm64; else arch=x64; fi ;;
  *) die "unknown chip: $(uname -m)" ;;
esac

# The terminal, to ask in (curl | sh has the script on its input, so questions are read from the
# terminal itself), by its own name (/dev/ttys003): Kiko (Bun) reads no keys from /dev/tty,
# which macOS's kqueue can't watch. None (no terminal at all): nothing is asked.
term=$(ps -o tty= -p $$ 2>/dev/null | tr -d ' ' || true)
case "$term" in '' | '?'* | -*) term=/dev/tty ;; *) term=/dev/$term ;; esac
(: <"$term") 2>/dev/null || term=""

# What Kiko needs that isn't Kiko's to install, said (and offered) before anything is downloaded.
has_claude() { command -v claude >/dev/null 2>&1 || [ -x "$BIN/claude" ] || [ -x "$HOME/.claude/local/claude" ]; }
# Found as setup finds them (src/agents/opencode/setup.ts openCodeOnPath, t3code/setup.ts installed).
has_opencode() { command -v opencode >/dev/null 2>&1 || [ -e "$HOME/.opencode/bin/opencode" ]; }
has_t3() { [ -e "${KIKO_T3_HOME:-$HOME/.t3}/bin/t3" ]; }
if ! has_claude && ! command -v codex >/dev/null 2>&1 && ! has_opencode && ! has_t3; then
  say "$NAME talks to Claude Code, Codex, OpenCode or T3 Code, and none is installed."
  answer=n
  if [ -n "$term" ]; then
    printf 'Install Claude Code now? [Y/n] '
    read -r answer <"$term" || answer=n
  fi
  case "$answer" in
    '' | [Yy] | [Yy][Ee][Ss])
      say "Installing Claude Code (its own installer: $CLAUDE_INSTALLER)…"
      if curl -fsSL "$CLAUDE_INSTALLER" | bash && has_claude; then
        say "Claude Code is installed." ""
      else
        say "" "Claude Code's installer didn't finish. $NAME installs anyway; get it later with:" \
          "  curl -fsSL https://claude.ai/install.sh | bash" ""
      fi
      ;;
    *)
      say "$NAME installs anyway; get one later, for example:" \
        "  Claude Code:  curl -fsSL https://claude.ai/install.sh | bash" \
        "  Codex:        npm install -g @openai/codex  (or: brew install codex)" ""
      ;;
  esac
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# A file of ours in ~/.local/share/kiko, readable by you only, written whole.
keep() { mkdir -p "$SHARE" && (umask 077 && printf '%s\n' "$2" >"$1.new" && mv -f "$1.new" "$1"); }
# The headers sent for the release, from a file (curl -H @file), so the token isn't on a command line.
headers="$tmp/headers"
printf 'Kiko-Client: install\n' >"$headers"
[ -n "$INVITE" ] || INVITE=$(cat "$TOKEN_FILE" 2>/dev/null || true)
if [ -n "$INVITE" ]; then
  case "$INVITE" in *[!A-Za-z0-9_-]*) die "that install token isn't one (it's letters, digits, - and _): copy the whole command from your invite" ;; esac
  install_id=$(cat "$ID_FILE" 2>/dev/null || true)
  case "$install_id" in '' | *[!A-Za-z0-9-]*) install_id=$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z' || true) ;; esac
  [ -n "$install_id" ] || install_id=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  keep "$ID_FILE" "$install_id"
  printf 'Kiko-Install-Token: %s\nKiko-Install-Id: %s\n' "$INVITE" "$install_id" >>"$headers"
fi

# The feed: latest.json names the version and each chip's file and checksum (macOS's plutil reads JSON).
# Refused (no invite, a link turned off, too many Macs): kiko.sh says why, in a line, and that's said.
code=$(curl -sSL -H "@$headers" -w '%{http_code}' -o "$tmp/latest.json" "$RELEASES/latest.json") || die "couldn't fetch $RELEASES/latest.json"
case "$code" in
  200 | 000) ;; # 000: a file:// feed (the tests')
  400 | 401 | 403 | 503) die "$(LC_ALL=C tr -cd ' -~\n' <"$tmp/latest.json" | head -c 400)" ;;
  *) die "couldn't fetch $RELEASES/latest.json ($code)" ;;
esac
if [ -n "$INVITE" ]; then keep "$TOKEN_FILE" "$INVITE"; fi
field() { plutil -extract "$1" raw -o - "$tmp/latest.json" 2>/dev/null; }
version=$(field version) || die "latest.json has no version"
url=$(field "assets.darwin-$arch.url") || die "there's no release for this Mac (darwin-$arch) yet"
sha=$(field "assets.darwin-$arch.sha256") || die "latest.json has no checksum for darwin-$arch"
case "$url" in *://*) ;; *) url="$RELEASES/$url" ;; esac

say "Downloading $NAME $version ($arch)…"
# The invite's headers go only to kiko.sh's own releases, never to a file the feed names elsewhere.
set --
case "$url" in "$RELEASES"/*) set -- -H "@$headers" ;; esac
curl -fSL --progress-bar "$@" "$url" -o "$tmp/$SLUG.tar.gz" || die "the download failed: $url"
got=$(shasum -a 256 "$tmp/$SLUG.tar.gz" | cut -d' ' -f1)
[ "$got" = "$sha" ] || die "the download's checksum is wrong (expected $sha, got $got): nothing was installed"

# A kiko of yours already there: a link (a checkout's bin/kiko) is replaced, and said; a file isn't.
was=$(readlink "$BIN/$SLUG" 2>/dev/null || true)
[ -e "$BIN/$SLUG" ] && [ -z "$was" ] && die "$BIN/$SLUG is a file of yours: move it away and run this again"

tar -xzf "$tmp/$SLUG.tar.gz" -C "$tmp"
new="$tmp/$SLUG-$version"
[ -x "$new/$SLUG" ] || die "the download doesn't hold $SLUG-$version/$SLUG"

# The checksum comes from the same server as the download, so it only catches a broken one. What
# says it's Kiko's is Apple's code signature, checked as `kiko update` does (src/core/updates/verify.ts
# requirement, verifyRelease): each executable (kiko, the helpers in native/, bin/tmux) signed
# with the Developer ID of Kiko's team, as sh.kiko.<file>, and the helper app as sh.kiko.helper; then the signed kiko checks
# every other file against the list signed into it, and says its version. Before anything is linked.
[ -x /usr/bin/codesign ] || die "macOS's codesign isn't in /usr/bin, so the download can't be checked: nothing was installed"
requirement() { # <file name>
  if [ "${KIKO_INSTALL_ADHOC:-}" = 1 ]; then
    printf 'identifier "%s.%s"' "$IDS" "$1"
  else
    printf 'anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "%s" and identifier "%s.%s"' "$TEAM" "$IDS" "$1"
  fi
}
unsigned() { die "the download isn't signed by $NAME's developer ($*): nothing was installed"; }
[ -d "$new/native" ] || unsigned "it has no native/ helpers"
for file in "$new/$SLUG" "$new"/native/* "$new/bin/tmux"; do
  name=${file##*/}
  # Only plain names go into the requirement (no quotes or anything else it would read).
  case $name in '' | *[!A-Za-z0-9_-]*) unsigned "an odd file name in it: ${file#"$new"/}" ;; esac
  { [ -f "$file" ] && [ ! -L "$file" ]; } || unsigned "${file#"$new"/} is missing, or isn't a plain file"
  /usr/bin/codesign --verify --strict "-R=$(requirement "$name")" "$file" 2>/dev/null || unsigned "${file#"$new"/}"
done
# The helper app (Kiko.app: the helpers that need a macOS permission), signed as sh.kiko.helper,
# everything in it sealed by that signature (--deep). The signed kiko checks it's there, too.
for app in "$new"/*.app; do
  [ -e "$app" ] || continue
  { [ -d "$app" ] && [ ! -L "$app" ]; } || unsigned "${app#"$new"/} isn't a folder"
  /usr/bin/codesign --verify --deep --strict "-R=$(requirement helper)" "$app" 2>/dev/null || unsigned "${app#"$new"/}"
done
said=$(cd "$new" && env -i PATH=/usr/bin:/bin HOME="$HOME" "./$SLUG" _verify-files 2>&1) || unsigned "its files aren't the ones it was built with: $said"
[ "$said" = "$version" ] || unsigned "its $SLUG is version $said, not $version"

# Unpacked beside the other versions, then the links switched in one step each (a link made under
# a temporary name, then renamed over the old one), so a failure leaves the old version working.
mkdir -p "$SHARE/versions" "$BIN"
previous=$(readlink "$SHARE/current" 2>/dev/null || true)
rm -rf "$SHARE/versions/$version.old"
[ -e "$SHARE/versions/$version" ] && mv "$SHARE/versions/$version" "$SHARE/versions/$version.old"
mv "$new" "$SHARE/versions/$version"
rm -rf "$SHARE/versions/$version.old"
ln -sfn "versions/$version" "$SHARE/current.new" && mv -fh "$SHARE/current.new" "$SHARE/current"
# The one it replaced becomes `previous` (what `kiko update --rollback` goes back to).
if [ -n "$previous" ] && [ "$previous" != "versions/$version" ]; then
  ln -sfn "$previous" "$SHARE/previous.new" && mv -fh "$SHARE/previous.new" "$SHARE/previous"
fi
previous=$(readlink "$SHARE/previous" 2>/dev/null || true)
ln -sfn "$SHARE/current/$SLUG" "$BIN/$SLUG.new" && mv -fh "$BIN/$SLUG.new" "$BIN/$SLUG"
[ -n "$was" ] && [ "$was" != "$SHARE/current/$SLUG" ] && say "($BIN/$SLUG pointed at $was; it's the installed one now)"

# Kept: this version and `previous` (to go back to); older ones go.
for dir in "$SHARE/versions"/*; do
  name=${dir##*/}
  [ "$name" = "$version" ] || [ "versions/$name" = "$previous" ] || rm -rf "$dir"
done
say "Installed $NAME $version in $(short "$SHARE/versions/$version")"

# Pocket's download, in the background from now (it returns at once), so it overlaps setup's
# steps. Whatever comes of it, the install goes on: setup tries again, or the macOS voice speaks.
"$BIN/$SLUG" _run pocket </dev/null >/dev/null 2>&1 || true

# ~/.local/bin on the PATH, when it isn't: one line at the end of your shell's startup file (once:
# not again when it's there), marked as Kiko's. A shell this doesn't know: the line, said.
reopen=""
case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    rc=""
    line="export PATH=\"\$HOME/.local/bin:\$PATH\" $MARK"
    case "${SHELL##*/}" in
      zsh) rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
      # A login shell (Terminal's and iTerm's) reads the first of these there is.
      bash)
        for f in .bash_profile .bash_login .profile; do
          if [ -f "$HOME/$f" ]; then rc="$HOME/$f" && break; fi
        done
        rc=${rc:-$HOME/.bash_profile}
        ;;
      fish)
        rc="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/$SLUG.fish"
        line="contains -- \$HOME/.local/bin \$PATH; or set -gx PATH \$HOME/.local/bin \$PATH $MARK"
        ;;
    esac
    if [ -z "$rc" ]; then
      say "" "$BIN isn't on your PATH. Add this line to your shell's startup file:" "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    elif grep -qF "$MARK" "$rc" 2>/dev/null; then
      reopen=1
    else
      mkdir -p "$(dirname "$rc")"
      # On a line of its own, even when the file doesn't end with one.
      if [ -s "$rc" ] && [ -n "$(tail -c 1 "$rc")" ]; then printf '\n' >>"$rc"; fi
      printf '%s\n' "$line" >>"$rc"
      say "Added $(short "$BIN") to your PATH in $(short "$rc")."
      reopen=1
    fi
    ;;
esac

# Setup asks its questions in this terminal, by its full path and with ~/.local/bin on its PATH
# (whatever this shell's says: the agents' installers put theirs there too). No terminal, or
# KIKO_NO_SETUP: it's left for later. The terminal opened for reading and writing (<>): setup's
# "Open Kiko" attaches tmux to it, and tmux draws the window on its client's input, so one opened
# read-only showed nothing (2026-11-02: the screen stayed on "Open Kiko…" while Kiko ran unseen).
if [ -z "${KIKO_NO_SETUP:-}" ] && [ -n "$term" ]; then
  say ""
  PATH="$BIN:$PATH" "$BIN/$SLUG" setup <>"$term" || say "" "Setup didn't finish: run $BIN/$SLUG setup any time."
else
  case ":$PATH:" in *":$BIN:"*) say "" "Next: $SLUG setup" ;; *) say "" "Next: $BIN/$SLUG setup" ;; esac
fi
if [ -n "$reopen" ]; then
  say "" "Open a new terminal (or run: exec \$SHELL) to use $SLUG."
fi
}

main "$@"
