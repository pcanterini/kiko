// Imported first by every unit test: a hermetic, offline environment for src/ modules.
// - No .env, no saved settings: config.ts sees only what's set here.
// - A throwaway folder of this test process's own, as its working directory (src/core/log.ts
//   writes its log file in logs/ there, KIKO_LOG_DIR, never the repo's, so it never touches
//   logs/latest.jsonl, which only the real app moves) and as its temp folder (TMPDIR: every mkdtemp in a test, and everything a
//   program it starts puts in the temp folder, launch files included). Deleted when the process
//   exits, Ctrl+C included, so a test run leaves nothing in the real temp folder. Its name is short:
//   Unix sockets made inside it have to fit in 103 bytes, so it's in /tmp when the temp folder's
//   own path is long (macOS's /var/folders/…/T/: a tmux socket under it, …/tmux-501/kiko-test-<run>-<label>,
//   passed the limit, "File name too long").
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/** The longest temp folder the run's own goes in; past it, /tmp. */
const SHORT_TMP = 24;
const root = mkdtempSync(join(tmpdir().length > SHORT_TMP ? "/tmp" : tmpdir(), "cbt-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
// Killed (Ctrl+C, the runner giving up on it): exit, so the line above (and tests/support's own
// cleanups, such as throwaway tmux servers) still run.
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const)
  process.once(signal, () => process.exit(code));
process.env.TMPDIR = root;
// Every tmux server a test reaches, Kiko's own `-L kiko-dev` included, has its socket here, never in
// /tmp with your own. The folder is there already: tmux takes a
// TMUX_TMPDIR that isn't for none, and uses /tmp. Without one, src/terminals/tmux/tmux.ts refuses to
// run tmux under the test runner (realServersRefused).
// A program a test started that imports this too (tests/support/window-app.ts, the window's stand-in
// app, run in a pane of the test's tmux) keeps the test's folder: the servers it has to reach (the
// window's, KIKO_TMUX_SERVER) are the test's, there. A fresh one of its own made them unreachable
// ("error connecting to …/cbt-…/cbt-…/tmux-501/…: No such file or directory").
const inherited = process.env.TMUX_TMPDIR;
process.env.TMUX_TMPDIR = inherited && basename(inherited).startsWith("cbt-") && existsSync(inherited) ? inherited : root;
process.chdir(root);
// Not the repo's .env, nor its logs/ (both are the repo's wherever the app runs from: src/core/app-root.ts).
process.env.KIKO_ENV_FILE = "";
process.env.KIKO_LOG_DIR = join(root, "logs");
process.env.KIKO_SETTINGS = join(process.cwd(), "no-settings.json");
// Rex is never the real one: no server socket, so its adapter never starts `rex` (tests/live has the real one).
process.env.KIKO_REX_SOCKET = join(root, "no-rex.sock");
// T3 Code is never the real one: no home of its own, and a port nothing listens on.
process.env.KIKO_T3_HOME = join(root, "t3home");
process.env.KIKO_T3_PORT = "1";
// Codex is never the real one's: its home (hooks.json, session names, writer locks) and the records
// its hook keeps for Kiko are this process's own, never ~/.codex or ~/.config/kiko.
process.env.CODEX_HOME = join(root, "codex-home");
process.env.KIKO_CODEX_SESSIONS = join(root, "codex-sessions");
// OpenCode is never the real one: its background service's file (where its url and password are)
// and its TUI's state folder (its tabs) are this process's own, never ~/.local/state/opencode. It's
// only listened to once connected anyway, which the tests' own settings say.
process.env.KIKO_OPENCODE_SERVICE = join(root, "opencode-state", "service.json");
process.env.KIKO_OPENCODE_STATE = join(root, "opencode-state");
// Claude Code's settings file (where Kiko's hooks go when you connect it) is this process's own,
// never ~/.claude/settings.json; nor is CLAUDE_CONFIG_DIR's. (Writing under the real ~/.claude,
// ~/.codex or ~/.config/kiko is refused under the test runner anyway: agents/hooks-file.ts.)
process.env.KIKO_CLAUDE_SETTINGS = join(root, "claude-home", "settings.json");
delete process.env.CLAUDE_CONFIG_DIR;
// Nor are its transcripts, its background jobs' files (~/.claude/jobs) or its tasks' output
// (/tmp/claude-<uid>): a session's status and background work are read from these
// (src/agents/claude-code/turns.ts, background.ts). A test that wants some writes them here.
process.env.KIKO_CLAUDE_PROJECTS = join(root, "claude-projects");
process.env.KIKO_CLAUDE_JOBS = join(root, "claude-jobs");
process.env.KIKO_CLAUDE_TASKS = join(root, "claude-tasks");
// Nor its running processes' records (~/.claude/sessions/<pid>.json), whose status a held prompt's
// watch reads (src/agents/claude-code/answered-there.ts).
process.env.KIKO_CLAUDE_SESSIONS = join(root, "claude-sessions");
// Accounts as the release has them (core/name.ts ACCOUNTS_LIVE), and never the real account server:
// a test that wants them sets KIKO_ACCOUNTS=1 and a fake server of its own (KIKO_ACCOUNT_URL).
delete process.env.KIKO_ACCOUNTS;
// Kiko Pro's sale: off unless a test sets KIKO_PRO=1, whatever the release has (core/name.ts
// PRO_ON_SALE, on since 2026-11-17), so the tests of "nothing about buying" stay as they were.
process.env.KIKO_PRO = "0";
// The phone as Kiko Dev has it (core/env.ts phoneLive: on in a checkout, whatever name.ts PHONE_LIVE
// says): the phone's tests run with it on; a test of it off (as the release has it) sets KIKO_PHONE_LIVE=0.
delete process.env.KIKO_PHONE_LIVE;
// Never the real phone relay (core/config.ts relayUrlOf: name.ts RELAY_URL unless this says): a
// test of the relay runs its own and names it.
process.env.KIKO_RELAY_URL = "off";
process.env.KIKO_ACCOUNT_URL = "http://127.0.0.1:1";
// The menu key: the default (terminals/tmux/keys.ts), unless a test says.
delete process.env.KIKO_KEY;
// Never herdr's, even run in a herdr pane: a `kiko` a test starts would ask the real herdr to
// change how that pane takes right-clicks (terminals/tmux/herdr.ts). The herdr test fakes its own.
for (const k of Object.keys(process.env)) if (k.startsWith("HERDR_")) delete process.env[k];
if (process.env.TERM_PROGRAM === "herdr") delete process.env.TERM_PROGRAM;
// Nor a terminal app's own keys, run in Warp: a `kiko` a test starts would find Warp takes
// Ctrl+Space (terminals/tmux/clash.ts TERMINAL_KEYS). The clash tests set it themselves.
if (process.env.TERM_PROGRAM === "WarpTerminal") delete process.env.TERM_PROGRAM;
// The checkout's own flavour, Kiko Dev (src/core/name.ts), whatever the shell says: its names in
// what's checked, and its hook entries the ones counted as ours (`node <a checkout>/hooks/…`).
delete process.env.KIKO_FLAVOUR;
// The fixtures' sessions on the app's own code are in claude-code-speech, wherever the repo is now.
process.env.KIKO_APP_FOLDER = "claude-code-speech";
process.env.KIKO_STT = "apple";
process.env.KIKO_TTS = "say";
process.env.KIKO_LLM = "haiku";
process.env.KIKO_VOICE_CAN = "messages";
// Never the Keychain (platform/keys.ts: off under the test runner anyway): keys only from here. A
// test of the real helper points it at a throwaway keychain file of its own; a helper a test builds
// is signed ad hoc, without looking for your developer identity (platform/macos/native.ts).
// Pocket's model is never looked for in the real Hugging Face caches nor the other flavour's folder
// (core/pocket-tts.ts pocketModelSources, sharedHfHubs): only here, where nothing is. A test that
// wants a "shared cache" makes one in a temp folder and passes it.
process.env.KIKO_POCKET_MODEL_FROM = join(root, "no-shared-hf-hub");
// Nor is Pocket itself the Mac's: its venv (core/app-root.ts pocketPaths) is one that isn't there,
// never ~/.local/share/kiko-dev/pocket-venv or a checkout's pocket/.venv. The path choice is tested
// with a fake home (pocket-shared.test.ts).
process.env.KIKO_POCKET_VENV = join(root, "no-pocket", "pocket-venv");
process.env.KIKO_KEYCHAIN = "off";
process.env.KIKO_SIGN_IDENTITY = "-";
// Never the real helper app (platform/macos/helper-app.ts): a helper a test starts is its own child.
// The helper app's tests make their own, with a bundle id and socket of their own.
process.env.KIKO_HELPER_APP = "off";
process.env.ANTHROPIC_API_KEY = "unit-test-no-network";
delete process.env.OPENROUTER_API_KEY;
process.env.KIKO_DEV_SHADOW = "0"; // tests that want the shadow model (shadow.ts) set config.shadowModel
delete process.env.KIKO_PROJECTS_ROOT;
delete process.env.KIKO_SCRATCH_FOLDER;
// Nor the settings these name.
for (const name of ["CLASSIFIER_MIN_CONFIDENCE", "CLASSIFIER_MODEL", "REPLY_WINDOW_MS", "FYI_REPLY_WINDOW_MS"]) delete process.env[`KIKO_${name}`];
