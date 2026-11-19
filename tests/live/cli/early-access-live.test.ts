// The whole early-access path, as a new user goes through it, for real: two
// releases built here (this Mac's chip only: package.json's version, then the next one with a
// note), served from file:// URLs (no server); `curl -fsSL file://…/install.sh | sh` typed into a
// terminal (a pane of a throwaway tmux server), which installs and opens first-run setup there,
// driven with keys and read back with capture-pane; the installed `kiko` opening its window and
// quitting; a session opened in it; the background update check finding the next version (the
// once-a-day timer run down in update.json), the header and Settings → Updates saying so, Restart
// now starting it in the same pane with the session kept; the hooks set up under the first version
// still reaching the app after the switch; `kiko update --rollback` and back to the first one
// the same way; a key saved anyway when OpenRouter can't be reached (a throwaway keychain file);
// then `kiko uninstall`, and what's left.
//
// The new user's Mac has no tmux of its own (no Homebrew on its PATH): Kiko's server runs the
// tmux the release ships, which the test checks by the server's executable.
//
// Everything in a folder of this test's own: HOME (never the real ~/.local, ~/.config, ~/.claude),
// TMUX_TMPDIR (so even Kiko's own `-L kiko` server is this test's, never yours), the app's
// socket and state file. No network (HTTPS_PROXY to a closed port: the key check is "offline",
// Pocket's download fails), no sound (a silent `say`, KIKO_SOUNDS=false), no Keychain but the
// throwaway file, and `claude` a stand-in that only echoes. It starts the real app (the installed
// executable): its helpers ask macOS about the mic and the talk key, as on any start.
//
// Slow (two release builds, then a few minutes of driving), so the normal suite skips it:
// KIKO_E2E=1 runs it (pnpm test:e2e). Needs bun, swiftc and tmux; take the test lock first.
import "../../setup.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { tmuxPath } from "../../../src/terminals/tmux/tmux.ts";
import { killServers, throwawayServer } from "../../support/tmux-servers.ts";
import { valueWaits } from "../../support/until.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const VERSION: string = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
const NEXT = VERSION.replace(/\d+$/, (n) => String(Number(n) + 1));
const NOTES = "Faster replies, and a note to read";
const ARCH = process.arch === "arm64" ? "arm64" : "x64";
const TMUX = tmuxPath();
const has = (program: string) => spawnSync("/bin/sh", ["-c", `command -v ${program}`]).status === 0;
const skip =
  process.env.KIKO_E2E !== "1"
    ? "slow: KIKO_E2E=1 runs it (pnpm test:e2e)"
    : process.platform !== "darwin"
      ? "macOS only"
      : !has("bun")
        ? "needs bun"
        : !has("swiftc")
          ? "needs swiftc"
          : !TMUX
            ? "needs tmux"
            : false;

// In /tmp, not the test's temporary folder: Unix sockets (tmux's, the app's) are made under it, and
// their paths have to fit in 103 bytes. Removed at the end, whatever happens (KIKO_E2E_KEEP=1:
// kept, to read the app's logs after a failure).
const dir = realpathSync(mkdtempSync("/tmp/kiko-ea-"));
const KEEP = process.env.KIKO_E2E_KEEP === "1";
if (!KEEP) process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const dist = join(dir, "dist"); // the feed: install.sh, latest.json and the tarballs
const distNext = join(dir, "dist-next"); // the next version, built ahead, published into dist later
const home = join(dir, "home");
const bin = join(dir, "bin"); // the stand-ins: claude, say
const share = join(home, ".local", "share", "kiko");
const logs = join(home, ".local", "state", "kiko", "logs");
const keychain = join(dir, "kc", "e2e.keychain-db");
// Every tmux server here (yours stand-in, and Kiko's own `-L kiko`) lives under this folder.
process.env.TMUX_TMPDIR = join(dir, "t");
// Made now: tmux skips a TMUX_TMPDIR that isn't there and uses /tmp, where your own `-L kiko` is.
mkdirSync(process.env.TMUX_TMPDIR, { recursive: true });
const DRIVE = throwawayServer("ea");
const COLS = 120;
const ROWS = 40;

/** The new user's environment: nothing of this process's but what a terminal on a Mac has. */
const ENV: Record<string, string> = {
  HOME: home,
  USER: process.env.USER ?? "user",
  LOGNAME: process.env.USER ?? "user",
  SHELL: "/bin/sh",
  TERM: "xterm-256color",
  LANG: "en_US.UTF-8",
  TMPDIR: join(dir, "tmp"),
  TMUX_TMPDIR: join(dir, "t"),
  // No Homebrew: no tmux but the one Kiko brings.
  PATH: [join(home, ".local", "bin"), bin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
  KIKO_HELPER_APP: "off", // never the real helper app (its permissions are the user's)
  KIKO_SPLASH: "off", // the app at once, not after the logo (ui/splash.ts): the test reads and types into the list
  KIKO_KEYCHAIN: "off",
  KIKO_SOCKET: join(dir, "s", "app.sock"),
  KIKO_STATE: join(dir, "s", "state.json"),
  KIKO_RELEASES_URL: `file://${dist}`,
  // Both releases here are signed ad hoc: install.sh takes them only when told to. The installed
  // app's own updater needs nothing: an ad hoc build takes ad hoc updates (core/updates/verify.ts trustOf).
  KIKO_INSTALL_ADHOC: "1",
  HTTPS_PROXY: "http://127.0.0.1:9",
  https_proxy: "http://127.0.0.1:9",
  KIKO_SOUNDS: "false",
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = valueWaits(20_000, 150);

/** tmux on the stand-in terminal's server. */
const drive = (...args: string[]) => execFileSync(TMUX!, ["-L", DRIVE, "-f", "/dev/null", ...args], { env: ENV, encoding: "utf8" });
/** The installed copy's own tmux (by the `current` link). */
const ownTmux = join(share, "current", "bin", "tmux");
/** tmux on Kiko's own server (this test's: TMUX_TMPDIR), by its own tmux while it's installed; "" when it isn't running. */
const kikoTmux = (...args: string[]) => {
  const r = spawnSync(existsSync(ownTmux) ? ownTmux : TMUX!, ["-L", "kiko", ...args], { env: ENV, encoding: "utf8" });
  return r.status === 0 ? r.stdout : "";
};
/** What a terminal (a session of the stand-in server) shows. */
const screen = (term = "user") => drive("capture-pane", "-p", "-t", `=${term}:`);
const key = (term: string, ...keys: string[]) => drive("send-keys", "-t", `=${term}:`, ...keys);
/** A command line typed into a terminal, and Enter. */
const type = (term: string, line: string) => (drive("send-keys", "-t", `=${term}:`, "-l", line), key(term, "Enter"));
/** A terminal of its own: a shell, waiting. */
const terminal = (term: string, command = "exec /bin/sh") => drive("new-session", "-d", "-s", term, "-x", String(COLS), "-y", String(ROWS), "-c", home, "--", "/bin/sh", "-c", command);

/** The app's log, every run of it (each start makes a file). */
const logged = () =>
  existsSync(logs)
    ? readdirSync(logs)
        .filter((f) => f.endsWith(".jsonl") && f !== "latest.jsonl")
        .map((f) => readFileSync(join(logs, f), "utf8"))
        .join("")
    : "";
/** The executables running from a version's folder (ps's command names only: never their arguments). */
const runningFrom = (version: string) =>
  execFileSync("ps", ["-A", "-o", "comm="], { encoding: "utf8" })
    .split("\n")
    .filter((c) => c.trim() === join(share, "versions", version, "kiko")).length;
/** The installed `kiko --version`. */
const installedVersion = () => execFileSync(join(home, ".local", "bin", "kiko"), ["--version"], { env: ENV, encoding: "utf8" }).trim();

// Kiko Dev's hooks there already, as on a Mac that ran this checkout before installing the
// release (the release test on 2026-11-01): `node <this checkout>/hooks/claude-code-hook.mjs` on
// every event. The release offers Claude Code as not connected anyway, adds its own beside them, and
// its uninstall takes out only its own: Claude Code's settings end as they began.
const DEV_HOOK = `node ${join(REPO, "hooks", "claude-code-hook.mjs")}`;
const DEV_SETTINGS = {
  hooks: Object.fromEntries(
    Object.entries({ Stop: 300, PermissionRequest: 120, SessionStart: 5, SessionEnd: 5, UserPromptSubmit: 5, PermissionDenied: 5 }).map(([event, timeout]) => [
      event,
      [{ hooks: [{ type: "command", command: DEV_HOOK, timeout }] }],
    ]),
  ),
};
/** The commands Claude Code's settings run on `event`, in order. */
const claudeCommands = (event: string): string[] =>
  (JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).hooks?.[event] ?? []).flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));

/** A hook as Claude Code runs it (the command `kiko setup` wrote, beside Kiko Dev's), with `event`. */
function hook(event: object) {
  const command = claudeCommands("UserPromptSubmit").find((c) => c !== DEV_HOOK) ?? "";
  assert.ok(command.includes(join(share, "current")), `the hook runs through the current link: ${command}`);
  return spawnSync("/bin/sh", ["-c", command], { env: ENV, input: JSON.stringify(event), encoding: "utf8", timeout: 20_000 });
}

/** One release built into `out`, its URLs there. */
function build(version: string, out: string) {
  const built = spawnSync("/bin/sh", [join(REPO, "scripts", "release.sh")], {
    env: {
      ...process.env,
      // Ad hoc: nothing sent to Apple (a signed and notarized one: install-live's KIKO_TEST_DIST).
      KIKO_SIGN_IDENTITY: "-",
      KIKO_VERSION: version,
      KIKO_ARCHS: ARCH,
      KIKO_DIST: out,
      KIKO_RELEASES_URL: `file://${out}`,
      KIKO_RELEASE_NOTES: version === NEXT ? NOTES : "First early access",
    },
    encoding: "utf8",
  });
  assert.equal(built.status, 0, built.stderr);
}

/** How many times the app has come up in the window (its frame's socket made: once a start). */
const ups = () => (logged().match(/"event":"window_frame"/g) ?? []).length;
/** The app up in the window (once more than `before`), its menu its own. */
const appUp = (before: number) => until(ups, (n) => n > before, "the app up in the window", 30_000);

/** A terminal's whole history (setup's steps scroll up as they stay on screen). */
const history = (term = "user") => drive("capture-pane", "-p", "-S", "-", "-t", `=${term}:`);
/** How many steps were skipped so far: each leaves a ■ line. */
const skipped = (term = "user") => (history(term).match(/■/g) ?? []).length;

/** Every step of setup after this one skipped with Esc (they depend on this Mac's permissions), to `end` (the last one's question). */
async function throughSetup(end: string, term = "user") {
  for (let i = 0; i < 12 && !screen(term).includes(end); i++) {
    const before = skipped(term);
    key(term, "Escape");
    await until(
      () => screen(term).includes(end) || skipped(term) > before,
      (next) => next,
      "the next step",
    );
  }
  return until(
    () => screen(term),
    (s) => s.includes(end),
    end,
  );
}

/** Settings opened (Ctrl+Space s), on its Version row: the last but one. */
async function settingsVersion(term = "user") {
  // Open already, on that row (just read): as it is.
  const now = screen(term);
  if (now.includes("▸ Version") && now.includes("UPDATES")) return now;
  await until(
    () => screen(term),
    (s) => !s.includes("⏎ pick"),
    "no menu open",
  );
  key(term, "C-Space");
  await until(
    () => screen(term),
    (s) => s.includes("Quit Kiko…"),
    "the menu",
  );
  key(term, "s");
  await until(
    () => screen(term),
    (s) => s.includes("Settings") && s.includes("AGENTS"),
    "Settings",
  );
  for (let i = 0; i < 80; i++) key(term, "Down");
  await until(
    () => screen(term),
    (s) => s.includes("▸ Automatic updates"),
    "the last row",
  );
  key(term, "Up");
  return until(
    () => screen(term),
    (s) => s.includes("▸ Version"),
    "the Version row",
  );
}

/** Restart now (Settings → Version → Restart now to use `version`), then the new app up, in the same pane. */
async function restartInto(version: string, term = "user") {
  await settingsVersion(term);
  // The row's options load a moment after it's highlighted (ui/settings.ts choicesFor): waited for.
  await until(
    () => screen(term),
    (t) => t.includes(`Restart now to use ${version}`),
    `Restart now to use ${version}`,
  );
  key(term, "Enter");
  await until(
    () => screen(term),
    (t) => /▸ +Restart now/.test(t),
    "Restart now picked",
  );
  const before = ups();
  key(term, "Enter");
  await appUp(before);
  await until(
    () => runningFrom(version),
    (n) => n >= 2,
    `${version}'s start and app running`,
    30_000,
  );
}

describe("early access, end to end: install, setup, the window, an update and back, uninstall", { skip }, () => {
  before(() => {
    for (const d of [bin, home, join(dir, "tmp"), join(dir, "t"), join(dir, "s"), join(dir, "kc"), join(home, "code", "pixie")]) mkdirSync(d, { recursive: true });
    // Claude Code, a stand-in: `claude agents --json` lists none; a session says where it is and echoes what it's typed.
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh\ncase "$1" in\n  agents) echo '[]'; exit 0 ;;\n  -p | --print | -v | --version | -h | --help | stop | mcp | config) exit 0 ;;\nesac\nprintf 'FAKE CLAUDE in %s\\n' "\${PWD##*/}"\nexec cat\n`,
      { mode: 0o755 },
    );
    // macOS's voice, silent: Kiko's hello (and anything said in the macOS voice) plays nothing.
    writeFileSync(join(bin, "say"), "#!/bin/sh\ncat >/dev/null 2>&1 &\nexit 0\n", { mode: 0o755 });
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(DEV_SETTINGS, null, 2));
    build(VERSION, dist);
    build(NEXT, distNext);
    copyFileSync(join(REPO, "install.sh"), join(dist, "install.sh"));
  });
  after(() => {
    // Only once tmux says the server's socket is under this test's folder (as install-live.test.ts's ownServer): never yours.
    if (kikoTmux("display-message", "-p", "#{socket_path}").trim().startsWith(`${ENV.TMUX_TMPDIR}/`)) spawnSync(TMUX!, ["-L", "kiko", "kill-server"], { env: ENV, stdio: "ignore" });
    killServers();
    if (existsSync(keychain)) spawnSync("security", ["delete-keychain", keychain], { stdio: "ignore" });
    if (KEEP) console.log(`kept: ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
  });

  test("curl … | sh installs it and opens first-run setup in that terminal; its steps answered, Esc on the last (no key: asked again, then what to do)", async () => {
    // A throwaway keychain (never the login one), so setup's key step asks as on a real Mac: it stays empty.
    execFileSync("security", ["create-keychain", "-p", `e2e-${process.pid}-${Date.now()}`, keychain], { stdio: "ignore" });
    terminal("user", `curl -fsSL file://${dist}/install.sh | KIKO_KEYCHAIN=${keychain} sh; echo "INSTALL-EXIT $?"; exec /bin/sh`);
    const first = await until(screen, (s) => s.includes("Which coding agents should Kiko talk to?"), "setup's first step", 30_000);
    assert.match(first, new RegExp(`Installed Kiko ${VERSION.replace(/\./g, "\\.")}`));
    // Still asking a moment later (it once drew its first step and ended: /dev/tty).
    await wait(1500);
    assert.ok(!screen().includes("Setup didn't finish"), screen());
    // Kiko Dev's hooks aren't the release's: Claude Code is offered, ticked.
    assert.match(screen(), /◼ Claude Code/);
    key("user", "Enter");
    await until(screen, (s) => s.includes("Connected Claude Code"), "Claude Code connected");
    // The key step skipped too (the release test on 2026-11-01): no "Open Kiko", the key asked for on the last step.
    const last = await throughSetup("Kiko needs an OpenRouter key to answer.");
    assert.ok(!last.includes("Open Kiko now?"), last);
    key("user", "Escape");
    const done = await until(screen, (s) => s.includes("INSTALL-EXIT 0"), "install.sh done");
    assert.match(done, /Run `kiko keys set openrouter`, paste your key, then run `kiko`\./);
    assert.ok(!done.includes("Open Kiko…"), done);
    assert.match(logged(), /"event":"setup_key","at":"step","ended":"skipped"/);
    assert.match(logged(), /"event":"setup_key","at":"end","ended":"skipped"/);
    assert.match(logged(), /"event":"setup_end","ended":"no-key"/);
    assert.equal(readlinkSync(join(share, "current")), `versions/${VERSION}`);
    assert.equal(installedVersion(), VERSION);
    const settings = readFileSync(join(home, ".claude", "settings.json"), "utf8");
    assert.match(settings, /current\/kiko hook .*current\/hooks\/claude-code-hook\.mjs/);
    // Its own after Kiko Dev's, on every event; Kiko Dev's as they were.
    for (const event of Object.keys(DEV_SETTINGS.hooks)) {
      const [dev, own, ...more] = claudeCommands(event);
      assert.equal(dev, DEV_HOOK, event);
      assert.match(own ?? "", /current\/kiko hook .*current\/hooks\/claude-code-hook\.mjs/, event);
      assert.deepEqual(more, [], event);
    }
    const logged0 = logged();
    assert.match(logged0, /"event":"setup_agents".*"agent":"claude-code","did":"connected"/);
  });

  test("kiko with no key: the window stays, asks for the key right there; Esc says what to do, Enter closes it", async () => {
    type("user", `clear; unset TMUX TMUX_PANE OPENROUTER_API_KEY; KIKO_KEYCHAIN=${keychain} kiko; echo "KIKO-EXIT $?"`);
    const asked = await until(screen, (s) => s.includes("Paste your OpenRouter key"), "the key asked for in the window", 30_000);
    // On one line: drawn at the window's width, not the list's (the pane's new size waited for: start.ts whole).
    assert.match(asked, /Kiko needs an OpenRouter key to answer\./);
    assert.match(logged(), /"event":"no_model_key"/);
    key("user", "Escape");
    const said = await until(screen, (s) => s.includes("Press Enter to close."), "kept open");
    assert.match(said, /Run `kiko keys set openrouter`, paste your key, then run `kiko`\./);
    // Still there a moment later: it waits for the key.
    await wait(1500);
    assert.ok(screen().includes("Press Enter to close."), screen());
    key("user", "Enter");
    await until(screen, (s) => s.includes("KIKO-EXIT"), "the window closed");
    assert.doesNotMatch(kikoTmux("list-sessions", "-F", "#{session_name}"), /^_kiko$/m, "the window's gone");
  });

  test("a key OpenRouter can't be checked with (offline) is saved anyway when you say so", async () => {
    type("user", `clear; KIKO_KEYCHAIN=${keychain} kiko setup; echo "SETUP-EXIT $?"`);
    await until(screen, (s) => s.includes("Paste your OpenRouter key"), "the key step");
    drive("send-keys", "-t", "=user:", "-l", "sk-or-v1-fake-e2e-not-a-key");
    key("user", "Enter");
    await until(screen, (s) => s.includes("Save it anyway?"), "save it anyway?");
    key("user", "y");
    await until(screen, (s) => s.includes("Saved in the Keychain (unchecked)"), "saved");
    assert.equal(spawnSync("security", ["find-generic-password", "-s", "sh.kiko.keys", "-a", "OPENROUTER_API_KEY", keychain], { stdio: "ignore" }).status, 0, "in the throwaway keychain");
    await throughSetup("Open Kiko now?");
    key("user", "Escape");
    await until(screen, (s) => s.includes("SETUP-EXIT 0"), "setup done");
    execFileSync("security", ["delete-keychain", keychain], { stdio: "ignore" });
  });

  test("the installed kiko opens its window, a session opens in it, a hook reaches it, and it quits cleanly", async () => {
    type("user", `clear; unset TMUX TMUX_PANE; export OPENROUTER_API_KEY=sk-or-v1-fake-e2e; kiko; echo "KIKO-EXIT $?"`);
    await appUp(0);
    await until(screen, (s) => s.includes("┌── Sessions"), "the window");
    key("user", "C-Space");
    await until(screen, (s) => s.includes("New session…"), "the menu");
    key("user", "c");
    await until(screen, (s) => s.includes("NEW SESSION IN") && /pixie +~\/code/.test(s), "the project picker, pixie in it");
    drive("send-keys", "-t", "=user:", "-l", "pixie");
    await until(screen, (s) => s.includes("› pixie"), "pixie typed");
    key("user", "Enter");
    await until(screen, (s) => s.includes("FAKE CLAUDE in pixie"), "pixie open");
    // A hook as Claude Code runs it: through the installed kiko, to the running app.
    const ran = hook({ hook_event_name: "UserPromptSubmit", session_id: "e2e-first", cwd: join(home, "code", "pixie"), prompt: "hi" });
    assert.equal(ran.status, 0, ran.stderr);
    await until(logged, (l) => l.includes('"sessionId":"e2e-first"'), "the hook in the app's log");
    key("user", "C-Space");
    await until(screen, (s) => s.includes("Quit Kiko…"), "the menu");
    key("user", "q");
    await until(screen, (s) => s.includes("Press q again to quit"), "asked");
    key("user", "q");
    await until(screen, (s) => s.includes("KIKO-EXIT 0"), "quit");
    await until(
      () => runningFrom(VERSION),
      (n) => n === 0,
      "nothing of Kiko's running",
    );
    assert.match(kikoTmux("list-sessions", "-F", "#{session_name}"), /^pixie$/m, "the session kept");
    // Its server is the tmux the release ships (ps's command name only, never arguments), its
    // terminfo on the panes' TERMINFO_DIRS; and this new user's PATH has no tmux.
    const pid = kikoTmux("display-message", "-p", "#{pid}").trim();
    assert.equal(realpathSync(execFileSync("ps", ["-o", "comm=", "-p", pid], { encoding: "utf8" }).trim()), realpathSync(ownTmux));
    assert.match(kikoTmux("show-environment", "-g", "TERMINFO_DIRS"), /current\/terminfo/);
    assert.equal(spawnSync("/bin/sh", ["-c", "command -v tmux"], { env: ENV }).status, 1, "no tmux on the new user's PATH");
  });

  test("the background check finds the next version and installs it; the header and Settings say so; Restart now starts it in the same pane, the session kept, the hooks working", async () => {
    // The release published (the tarball first, latest.json last), and the once-a-day look due.
    for (const f of readdirSync(distNext)) if (f !== "latest.json") copyFileSync(join(distNext, f), join(dist, f));
    copyFileSync(join(distNext, "latest.json"), join(dist, "latest.json"));
    const stateFile = join(home, ".local", "state", "kiko", "update.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    writeFileSync(stateFile, JSON.stringify({ ...state, checkedAt: Date.now() - 2 * 24 * 60 * 60 * 1000 }));
    const before = ups();
    type("user", `clear; kiko; echo "KIKO-EXIT $?"`);
    await appUp(before);
    const s = await until(screen, (t) => t.includes(`Update ${NEXT} ready · restart to use it`), "the header's update line", 30_000);
    assert.ok(s.includes("pixie"), s);
    assert.equal(readlinkSync(join(share, "current")), `versions/${NEXT}`);
    assert.equal(readlinkSync(join(share, "previous")), `versions/${VERSION}`);
    assert.equal(installedVersion(), NEXT);
    const pane = kikoTmux("list-panes", "-a", "-F", "#{pane_pid} #{pane_current_command}").match(/^(\d+) cat$/m)?.[1];
    assert.ok(pane, "pixie's pane");
    const settings = await settingsVersion();
    // The right side of Settings (the row's words, wrapped), as one line.
    const words = settings
      .split("\n")
      .map((l) => l.split("│").at(-2) ?? "")
      .join(" ")
      .replace(/\s+/g, " ");
    assert.ok(words.includes(`What's new in ${NEXT}: ${NOTES}`), settings);
    await restartInto(NEXT);
    assert.equal(kikoTmux("list-panes", "-a", "-F", "#{pane_pid} #{pane_current_command}").match(/^(\d+) cat$/m)?.[1], pane, "pixie's pane, the same");
    const ran = hook({ hook_event_name: "UserPromptSubmit", session_id: "e2e-after-update", cwd: join(home, "code", "pixie"), prompt: "hi" });
    assert.equal(ran.status, 0, ran.stderr);
    await until(logged, (l) => l.includes('"sessionId":"e2e-after-update"'), "the hook, after the update");
  });

  test("kiko update --rollback goes back; Settings shows it at once; Restart now starts it", async () => {
    terminal("sh2");
    await until(
      () => screen("sh2"),
      (s) => s.includes("$"),
      "the shell's prompt",
    );
    type("sh2", `kiko update --rollback; echo "ROLLBACK-EXIT $?"`);
    const said = await until(
      () => screen("sh2"),
      (s) => /ROLLBACK-EXIT \d/.test(s),
      "the rollback",
    );
    assert.match(said, new RegExp(`Back to Kiko ${VERSION.replace(/\./g, "\\.")}`));
    assert.match(said, /ROLLBACK-EXIT 0/);
    assert.equal(installedVersion(), VERSION);
    await restartInto(VERSION);
    key("user", "C-Space");
    await until(screen, (s) => s.includes("Quit Kiko…"), "the menu");
    key("user", "q");
    await until(screen, (s) => s.includes("Press q again to quit"), "asked");
    key("user", "q");
    await until(screen, (s) => s.includes("KIKO-EXIT 0"), "quit");
    await until(
      () => runningFrom(VERSION) + runningFrom(NEXT),
      (n) => n === 0,
      "nothing of Kiko's running",
    );
  });

  test("kiko uninstall leaves nothing of Kiko's behind, and says what it leaves", async () => {
    // A key in a throwaway keychain of its own (never the login one: the
    // shell has KIKO_KEYCHAIN off; setup's was deleted after its test).
    execFileSync("security", ["create-keychain", "-p", `e2e-${process.pid}-${Date.now()}`, keychain], { stdio: "ignore" });
    // Saved by the installed copy's own helper, as setup does (the Keychain lets the app that saved an item remove it).
    execFileSync(join(share, "current", "native", "keychain"), ["--keychain", keychain, "--service", "sh.kiko.keys", "set", "OPENROUTER_API_KEY"], {
      input: "sk-or-v1-fake-e2e-not-a-key\n",
      stdio: ["pipe", "ignore", "ignore"],
    });
    type("sh2", `clear; KIKO_KEYCHAIN=${keychain} kiko uninstall; echo "UNINSTALL-EXIT $?"`);
    await until(
      () => screen("sh2"),
      (s) => s.includes("Uninstall Kiko? [y/N]"),
      "asked",
    );
    assert.match(screen("sh2"), /Kiko's hooks in ~\/\.claude\/settings\.json/, "its own hooks listed (Kiko Dev's beside them aren't)");
    assert.match(screen("sh2"), /your API keys in the Keychain \(OPENROUTER_API_KEY\)/, "the key saved in setup, listed with the rest");
    type("sh2", "y");
    await until(
      () => screen("sh2"),
      (s) => s.includes("Delete the logs too"),
      "asked about the logs",
    );
    type("sh2", "y");
    const said = await until(
      () => screen("sh2"),
      (s) => /UNINSTALL-EXIT \d/.test(s),
      "uninstalled",
    );
    assert.match(said, /Kiko is uninstalled\./);
    assert.match(said, /a session still open in Kiko's tmux/);
    assert.match(said, /UNINSTALL-EXIT 0/);
    assert.notEqual(spawnSync("security", ["find-generic-password", "-s", "sh.kiko.keys", "-a", "OPENROUTER_API_KEY", keychain], { stdio: "ignore" }).status, 0, "the key went with it, unasked");
    for (const gone of [share, join(home, ".local", "bin", "kiko"), join(home, ".config", "kiko"), join(home, ".local", "state", "kiko")]) assert.equal(existsSync(gone), false, gone);
    // Only its own hooks out: Kiko Dev's left, exactly as they were before the install.
    assert.deepEqual(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")), DEV_SETTINGS);
    // Nothing named for Kiko left in the home folder, but the backup of Claude Code's settings
    // (said as it's made) and the scratch folder (your sessions' work, said), when there is one.
    const left = execFileSync("find", [".", "-mindepth", "1", "-maxdepth", "4"], { cwd: home, encoding: "utf8" }).split("\n").filter(Boolean);
    const ours = left.filter((p) => /kiko/i.test(p) && !/^\.\/\.claude\/settings\.json\.kiko-backup-[\w-]+$/.test(p) && !/^\.\/Kiko(\/|$)/.test(p));
    assert.deepEqual(ours, [], `left in the home folder:\n${left.join("\n")}`);
  });
});
