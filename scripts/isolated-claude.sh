#!/bin/sh
# A real `claude` for a live check (a test, or an agent trying something out), kept out of your own:
# never listed by Kiko or `claude agents`, no folder left in ~/.claude/projects, no Kiko hooks.
#
#   scripts/isolated-claude.sh [claude's own arguments…]
#
# On 2026-11-05 an agent's throwaway `claude` (run in its own tmux server to look at permission
# dialogs, then killed) showed on your phone as an outside session that needed you: it ran with your
# config, so its process record went in ~/.claude/sessions, `claude agents` listed it "waiting", and its
# transcript stayed in ~/.claude/projects. Run through here, it gets a config folder of its own:
# - CLAUDE_CONFIG_DIR: Claude Code keeps everything there (settings, session history, process records,
#   projects, jobs) instead of ~/.claude (code.claude.com/docs/en/env-vars), so the `claude agents` you
#   and Kiko run never sees it. Its settings.json, written when there's none, has "disableAllHooks":
#   none of Kiko's hooks (they're in your ~/.claude/settings.json anyway, which it doesn't read).
# - Its login: Claude Code keys its macOS Keychain entry to the config folder
#   (code.claude.com/docs/en/authentication, "Credential management"), so a fresh folder starts
#   logged out, at its first-run screens. For checks that need a model, keep one folder and log in
#   there once (same account, a login of its own; nothing of yours changes):
#   KIKO_TEST_CLAUDE_HOME=~/.config/kiko-test-claude scripts/isolated-claude.sh, then /login.
#   With KIKO_TEST_CLAUDE_HOME set, that folder is used and kept, all but what a run leaves (below).
# - Not set: a fresh folder under $TMPDIR, removed when claude ends.
# - When it ends (exits, is interrupted, or its tmux server is killed: HUP), what the run left is
#   removed: the whole temporary folder, or KIKO_TEST_CLAUDE_HOME's projects, sessions, jobs and the
#   like (its login and settings stay). A kill -9 of this script leaves them: they're never yours.
# - KIKO_* and REX_* (an app's or Rex's own), CLAUDECODE and CLAUDE_CODE_ENTRYPOINT (the Claude Code
#   it may run under) aren't passed on.
# Refuses a KIKO_TEST_CLAUDE_HOME that is your home or your own ~/.claude (or inside it).
set -eu

dir="${KIKO_TEST_CLAUDE_HOME:-}"
temp=""
if [ -z "$dir" ]; then
  temp=$(mktemp -d "${TMPDIR:-/tmp}/kiko-claude.XXXXXX")
  dir="$temp"
fi
mkdir -p "$dir"
real=$(cd "$dir" && pwd -P)
home=$(cd "$HOME" && pwd -P)
case "$real/" in
  "$home/" | "$home/.claude/"*)
    echo "isolated-claude: $dir is your own Claude Code config, not a test's: not running" >&2
    exit 2
    ;;
esac
[ -f "$real/settings.json" ] || printf '{ "disableAllHooks": true }\n' >"$real/settings.json"

cleanup() {
  trap - EXIT HUP INT TERM
  if [ -n "$temp" ]; then
    rm -rf "$temp"
  else
    for left in projects sessions jobs todos shell-snapshots file-history session-env tasks debug; do
      rm -rf "${real:?}/$left"
    done
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 129' HUP
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# Names only (never values): every KIKO_* and REX_* variable, unset for claude.
for name in $(env | sed -nE 's/^((KIKO|REX)_[A-Za-z0-9_]*)=.*/\1/p'); do
  unset "$name"
done
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT
CLAUDE_CONFIG_DIR="$real" claude "$@"
