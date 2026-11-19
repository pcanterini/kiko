#!/bin/bash
# Runs test-app.ts (the cases in cases/, over driver.ts) with the stubbed modules (loader.mjs; no real socket,
# mic, speech or models). Everything it
# writes goes to tests/harness/out/ (git-ignored, cleared at each start), which is also the working directory; the repo's .env isn't
# loaded (KIKO_ENV_FILE empty): settings-test.json, state.json and the dictionary next to it, and the app's logs in out/logs/
# (KIKO_LOG_DIR; HARNESS_LOG_DIR overrides). logs/latest.jsonl is left alone. Claude Code's config file is a fixture
# there too (KIKO_CLAUDE_CONFIG: out/claude.json, which a case writes), never ~/.claude.json; so is its settings file
# (KIKO_CLAUDE_SETTINGS: out/claude-home/settings.json), never ~/.claude/settings.json. The phone server,
# when a case turns it on, listens on 127.0.0.1 only, on a port the system picks. T3 Code is never the real one: its home is
# out/t3home (a fake CLI there), and its port nothing (1) until driver.ts starts the fake T3 (tests/support/fake-t3.ts).
# Codex is never the real one either: its home is out/codex-home and its hook's records out/codex-sessions. Nor is OpenCode:
# its service file and state folder are out/opencode-state (a fake service there once a case starts one). Nor is the
# Keychain (KIKO_KEYCHAIN=off): keys come only from this command line. Nor the account server (KIKO_ACCOUNT_URL: a port
# nothing listens on), and accounts are as a release has them unless a case turns them on. Nor the helper app (KIKO_HELPER_APP=off).
# A permission prompt unanswered in its window is let go there, as the cases expect (KIKO_TEST_STAND=off: none stands;
# standing ones are tested in tests/unit, core/standing.test.ts and app/standing-phone.test.ts).
set -o pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/out"
# Cleared first: what a crashed or stopped run left isn't this run's. Its files (a fake service's, a state, a socket),
# and the fake agents that outlived it (each runs as node linked into out/node-as/: a fake OpenCode TUI left there is
# listed as this run's).
pkill -KILL -f "$OUT/node-as/" 2>/dev/null
rm -rf "$OUT"
mkdir -p "$OUT"
cd "$OUT" || exit 1
# A clean environment (env -i): nothing of the shell it's run from reaches the app: no REX_* (a shell in Rex), KIKO_*,
# TMUX/TMUX_PANE, CLAUDE_*, API keys or .env names, only PATH and the locale. HOME is out/home, so whatever the app
# would find under ~ (~/.claude, ~/.config/kiko*, Rex's socket and CLI under ~/Library) is this run's, empty. Rex
# never: its socket and CLI (KIKO_REX_SOCKET, KIKO_REX_BIN) are paths with nothing there. Claude Code's background
# jobs, task output and process records (KIKO_CLAUDE_JOBS, KIKO_CLAUDE_TASKS, KIKO_CLAUDE_SESSIONS) are fixtures in out/ too, and a helper signed is signed
# ad hoc (KIKO_SIGN_IDENTITY=-: the Keychain's identities are never listed), and no update feed is read (KIKO_UPDATES=off).
mkdir -p "$OUT/home"
# The real programs the app could reach for (claude, rex, tmux, osascript, the Keychain's security, `open` (a
# browser), the other agents' CLIs, the clipboard's) are never run: out/refused-bin comes first on PATH, where each one only writes its name to out/refused and fails
# as a missing program would. test-app.ts ends by checking that file isn't there: every one is stubbed or faked.
mkdir -p "$OUT/refused-bin"
for p in claude rex tmux osascript security open codex opencode t3 pbcopy pbpaste; do
  printf '#!/bin/sh\necho %s >> "%s/refused"\nexit 127\n' "$p" "$OUT" > "$OUT/refused-bin/$p"
  chmod +x "$OUT/refused-bin/$p"
done
env -i PATH="$OUT/refused-bin:$PATH" HOME="$OUT/home" USER="${USER:-}" LOGNAME="${LOGNAME:-}" LANG="${LANG:-en_US.UTF-8}" TMPDIR="${TMPDIR:-/tmp}" SHELL=/bin/zsh \
  KIKO_REX_SOCKET="$OUT/no-rex/server.sock" KIKO_REX_BIN="$OUT/no-rex/rex" KIKO_CLAUDE_JOBS="$OUT/claude-jobs" KIKO_CLAUDE_TASKS="$OUT/claude-tasks" KIKO_CLAUDE_SESSIONS="$OUT/claude-sessions" KIKO_SIGN_IDENTITY=- KIKO_TMUX_BIN="$OUT/refused-bin/tmux" KIKO_TMUX_SERVER=kiko-harness KIKO_UPDATES=off \
  KIKO_ACCOUNT_URL=http://127.0.0.1:1 KIKO_PRO=0 KIKO_RELAY_URL=off KIKO_KEYCHAIN=off KIKO_HELPER_APP=off KIKO_ENV_FILE= KIKO_TEST_TAIL_MS=0 KIKO_TEST_HOLD_MS=100 KIKO_TEST_HOLD_ANSWER_MS=1000 KIKO_TTS=say KIKO_STT=apple KIKO_LLM=haiku ANTHROPIC_API_KEY=test-not-real KIKO_PTT_MODE=hold KIKO_ANNOUNCE=all KIKO_REPLY_WINDOW_MS=1500 KIKO_FYI_REPLY_WINDOW_MS=600 KIKO_TEST_GIVE_WAY_MS=200 KIKO_TEST_UNHEARD_MS=150 KIKO_PERMISSION_WINDOW_MS=1000 KIKO_TEST_STAND=off KIKO_TEST_LISTEN_SILENCE_MS=200 KIKO_TEST_LISTEN_NAME_WAIT_MS=500 KIKO_TEST_MIC_TEST_MS=300 KIKO_VOICE_PERMISSIONS=true KIKO_SOUNDS=true KIKO_CLASSIFIER_MIN_CONFIDENCE=0.75 KIKO_SETTINGS="$OUT/settings-test.json" KIKO_STATE="$OUT/state.json" KIKO_SOCKET="$OUT/voice.sock" KIKO_LOG_DIR="${HARNESS_LOG_DIR:-$OUT/logs}" KIKO_APP_FOLDER=claude-code-speech KIKO_PROJECTS_ROOT="$OUT/projects-root" KIKO_SCRATCH_FOLDER="$OUT/scratch" KIKO_STARTING_WAIT_MS=600000 KIKO_CLAUDE_CONFIG="$OUT/claude.json" KIKO_CLAUDE_SETTINGS="$OUT/claude-home/settings.json" KIKO_CLAUDE_PROJECTS="$OUT/claude-projects" KIKO_PHONE_PORT=0 KIKO_PHONE_HOST=127.0.0.1 KIKO_T3_HOME="$OUT/t3home" KIKO_T3_PORT=1 CODEX_HOME="$OUT/codex-home" KIKO_CODEX_SESSIONS="$OUT/codex-sessions" KIKO_OPENCODE_SERVICE="$OUT/opencode-state/service.json" KIKO_OPENCODE_STATE="$OUT/opencode-state" \
  node --no-warnings --import "$HERE/register.mjs" "$HERE/test-app.ts" --plain 2>&1 | grep -v "^\s*$"
