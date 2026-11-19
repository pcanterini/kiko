// The window with no model key, for real (src/start.ts, src/app.ts, src/onboard.ts --need-key): the
// release test on 2026-11-01 ended setup on "Open Kiko" with no key, the app stopped on its first
// line, and the window went with it, the line unread. Here the Kiko window is opened on a
// throwaway tmux server (`tmux -L kiko-test-<random>-nokey`, never Kiko's nor the default one)
// with its list running start.ts from this checkout, as `kiko` runs it: the real app finds no key
// and stops, and the window stays, the list's pane the whole window, asking for the key right there;
// Esc says exactly what to do and waits for a key; a key closes the window. Then again, the key
// pasted this time (OpenRouter offline: saved anyway), and the app goes on to start.
//
// Everything is this test's own: HOME, the settings (there already, so setup's first run is skipped),
// the app's socket, state and logs, and a throwaway keychain file (never the login one). The helpers
// it builds are signed ad hoc. No network: HTTPS_PROXY to a closed port. Skipped without tmux or swiftc.
import "../../setup.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { startedAt } from "../../../src/core/running.ts";
import { CONFIG, cleanEnv, envLaunch, tmuxPath, tmuxRunner, WINDOW } from "../../../src/terminals/tmux/tmux.ts";
import { describe as layoutOf, openWindow } from "../../../src/terminals/tmux/window.ts";
import { killServers, throwawayServer } from "../../support/tmux-servers.ts";
import { valueWaits } from "../../support/until.ts";

const TMUX = tmuxPath();
const has = (program: string) => spawnSync("/bin/sh", ["-c", `command -v ${program}`]).status === 0;
const skip = process.platform !== "darwin" ? "macOS only" : !TMUX ? "needs tmux" : !has("swiftc") ? "needs swiftc" : false;
const SERVER = throwawayServer("nokey");
// The terminal a test attaches from: a server of its own too.
const DRIVE = throwawayServer("nokeyterm");
assert.notEqual(SERVER, "kiko");
const START = fileURLToPath(new URL("../../../src/start.ts", import.meta.url));
// Short (the app's socket is made in it): tests/setup.ts's temp folder is.
const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "nk-")));
const keychain = join(dir, "kc", "nokey.keychain-db");
const logs = join(dir, "logs");

/** What the list's pane runs with: none of this process's keys, the window's server this test's. */
const env: NodeJS.ProcessEnv = {
  ...cleanEnv(),
  // The test runner's own overrides (tests/setup.ts: Claude Code's, Codex's, OpenCode's, T3 Code's files), then this test's.
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("KIKO_") || k === "CODEX_HOME")),
  HOME: join(dir, "home"),
  TERM: "xterm-256color",
  KIKO_TMUX_SERVER: SERVER,
  KIKO_SETTINGS: join(dir, "settings.json"),
  KIKO_STATE: join(dir, "state.json"),
  KIKO_SOCKET: join(dir, "a.sock"),
  KIKO_LOG_DIR: logs,
  KIKO_ENV_FILE: "",
  KIKO_HELPER_APP: "off", // never the real helper app (its permissions are the user's)
  KIKO_SPLASH: "off", // the app at once, not after the logo (ui/splash.ts): the test reads the list
  KIKO_KEYCHAIN: keychain,
  KIKO_SIGN_IDENTITY: "-",
  HTTPS_PROXY: "http://127.0.0.1:9",
  https_proxy: "http://127.0.0.1:9",
  // Node's fetch goes through HTTPS_PROXY only when told to (Bun's always does).
  NODE_USE_ENV_PROXY: "1",
};
const tmux = tmuxRunner(SERVER, CONFIG, cleanEnv());

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = valueWaits(60_000, 100);

/** The list's pane, by the window's layout. */
const listPane = async () => (await layoutOf(tmux)).view?.list ?? null;
/** What the list's pane shows. */
const screen = async () => {
  const list = await listPane();
  return list ? await tmux(["capture-pane", "-p", "-t", list.id]).catch(() => "") : "";
};
const key = async (...keys: string[]) => {
  const list = await listPane();
  if (list) await tmux(["send-keys", "-t", list.id, ...keys]);
};
/** tmux on the terminal's server. */
const drive = (...args: string[]) => execFileSync(TMUX!, ["-L", DRIVE, "-f", "/dev/null", ...args], { env: { ...cleanEnv(), TERM: "xterm-256color" }, encoding: "utf8" });
/** What that terminal shows. */
const seen = () => {
  try {
    return drive("capture-pane", "-p", "-t", "=user:");
  } catch {
    return "";
  }
};
const windowOpen = async () => (await tmux(["list-sessions", "-F", "#{session_name}"]).catch(() => "")).split("\n").includes(WINDOW);
const logged = () =>
  existsSync(logs)
    ? readdirSync(logs)
        .filter((f) => f.endsWith(".jsonl") && f !== "latest.jsonl")
        .map((f) => readFileSync(join(logs, f), "utf8"))
        .join("")
    : "";
const open = () => openWindow(tmux, () => envLaunch(env, dir, process.execPath, [START, "--window"]), dir, { width: 120, height: 40 });

describe("the window with no model key: it stays, asks for the key, and never just goes", { skip }, () => {
  before(() => {
    for (const d of [join(dir, "home"), join(dir, "kc")]) mkdirSync(d, { recursive: true });
    // Settings there already: not the first start (that's setup's own last step: tests/unit/ui/onboarding.test.ts).
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ setupDone: ["mic", "talkKey", "name", "hello"] }));
    execFileSync("security", ["create-keychain", "-p", `nokey-${process.pid}-${Date.now()}`, keychain], { stdio: "ignore" });
  });
  after(() => {
    killServers();
    if (existsSync(keychain)) spawnSync("security", ["delete-keychain", keychain], { stdio: "ignore" });
    rmSync(dir, { recursive: true, force: true });
  });

  test("no key: the app says so, the key is asked for in the window; Esc says what to do, and it waits for a key to close", async () => {
    await open();
    const asked = await until(screen, (s) => s.includes("Paste your OpenRouter key"), "the key asked for in the window");
    assert.match(asked, /Kiko needs an OpenRouter key to answer\./);
    assert.match(logged(), /"event":"no_model_key"/);
    assert.match(logged(), /"event":"setup_start","steps":\["try"\].*"needKey":true/);
    // The whole window: zoomed, so the line can be read.
    const list = await listPane();
    assert.equal((await tmux(["display", "-p", "-t", list!.id, "#{window_zoomed_flag}"])).trim(), "1");
    await key("Escape");
    const said = await until(screen, (s) => s.includes("Press Enter to close."), "kept open");
    assert.match(said.replace(/\s+/g, " "), /Run `kiko-dev keys set openrouter`, paste your key, then run `kiko-dev`\./);
    assert.match(logged(), /"event":"setup_key","at":"end","ended":"skipped"/);
    await wait(1500);
    assert.ok(await windowOpen(), "still there: it waits for a key");
    await key("Enter");
    await until(windowOpen, (o) => !o, "the window closed");
  });

  test("the key pasted there (OpenRouter offline: saved anyway): the app starts again, gets past the key, and what stops it next stays on screen", async () => {
    // Its lock held by a live process (this test): the app, once past the key, stops on that
    // (SAID_EXIT) before it starts anything (no mic, no talk key), and the window stays on it.
    writeFileSync(join(dir, "a.sock.lock"), `${process.pid}\n${(await startedAt(process.pid)) ?? ""}\n`);
    await open();
    await until(screen, (s) => s.includes("Paste your OpenRouter key"), "the key asked for again");
    const list = await listPane();
    await tmux(["send-keys", "-t", list!.id, "-l", "sk-or-v1-fake-nokey-not-a-key"]);
    await key("Enter");
    await until(screen, (s) => s.includes("Save it anyway?"), "save it anyway?");
    await key("y");
    await until(screen, (s) => s.includes("Start Kiko Dev now?"), "the last step's choice");
    assert.equal(spawnSync("security", ["find-generic-password", "-a", "OPENROUTER_API_KEY", keychain], { stdio: "ignore" }).status, 0, "in the throwaway keychain");
    const before = (logged().match(/"event":"no_model_key"/g) ?? []).length;
    await key("Enter");
    const said = await until(screen, (s) => s.includes("Press Enter to close."), "kept open on why it stopped");
    assert.match(said.replace(/\s+/g, " "), new RegExp(`already running \\(process ${process.pid}\\)`));
    assert.equal((logged().match(/"event":"no_model_key"/g) ?? []).length, before, "the key found this time");
    assert.ok(!logged().includes("fake-nokey"), "the key is never logged");
    await wait(1500);
    assert.ok(await windowOpen(), "still there: it waits for a key");
    await key("Enter");
    await until(windowOpen, (o) => !o, "the window closed");
  });

  test("with a terminal attached as it opens (as `kiko` attaches): the ask is drawn the window's whole width", async () => {
    rmSync(join(dir, "a.sock.lock"), { force: true });
    rmSync(keychain, { force: true });
    execFileSync("security", ["create-keychain", "-p", `nokey-${process.pid}-${Date.now()}`, keychain], { stdio: "ignore" });
    await open();
    // A terminal of 120 columns attached at once, from a server of its own (never the default one).
    drive("new-session", "-d", "-s", "user", "-x", "120", "-y", "40", "--", TMUX!, "-L", SERVER, "-f", CONFIG, "attach-session", "-t", `=${WINDOW}`);
    const asked = await until(seen, (s) => s.includes("Paste your OpenRouter key"), "the key asked for, seen in the terminal");
    assert.match(asked, /Kiko needs an OpenRouter key to answer\./, "on one line: drawn at the window's width");
    await key("Escape");
    await until(seen, (s) => s.includes("Press Enter to close."), "kept open");
    await key("Enter");
    await until(windowOpen, (o) => !o, "the window closed");
  });
});
