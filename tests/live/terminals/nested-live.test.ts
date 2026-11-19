// The Kiko window inside your own tmux, for real: three throwaway tmux servers, never `-L
// kiko` nor the default one, all killed afterwards whatever happens.
//
//   your terminal ("term", no prefix)  →  your tmux ("user": prefix C-b, or C-Space)  →  `kiko`
//   run in one of its panes, attached to the window ("win", Kiko's server)
//
// Keys are typed into the terminal's pane, so they go through your tmux's key tables as yours
// would, and only what it lets through reaches the window. `kiko` (bin/kiko) runs there as
// you'd run it, with the outer TMUX set: it checks your tmux's prefixes and root table, and picks
// another key when Ctrl+Space is taken. The window's list runs the stand-in app with the real glue
// (tests/support/window-app.ts), which tells you about a clash on the bottom line and "says" it
// into its log. `claude` is a stand-in that writes every byte it gets to a file, so a key passed
// on (the menu key twice) can be read back. Nothing real starts.
import "../../setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { CONFIG, cleanEnv, tmuxPath, tmuxRunner } from "../../../src/terminals/tmux/tmux.ts";
import { describe as layoutOf, KEY_BY_OPTION, KEY_OPTION, NOTES_OPTION } from "../../../src/terminals/tmux/window.ts";
import { killServers, throwawayServer } from "../../support/tmux-servers.ts";
import { valueWaits } from "../../support/until.ts";

const TMUX = tmuxPath();
const CLI = fileURLToPath(new URL("../../../bin/kiko", import.meta.url));
const APP = fileURLToPath(new URL("../../support/window-app.ts", import.meta.url));
const COLS = 120;
const ROWS = 40;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = valueWaits(10_000, 60);

/**
 * One nesting: the window's server, your tmux started with `userConf` (its lines), your terminal
 * attached to it, and `kiko` run in your tmux's pane. A pixie session is in the window's server
 * before `kiko` runs. `cli`: how `kiko` is run there (a shell command).
 */
function nesting(label: string, userConf: string, cli = `'${CLI}'`) {
  const WIN = throwawayServer(`${label}win`);
  const USER = throwawayServer(`${label}user`);
  const TERM = throwawayServer(`${label}term`);
  const dir = mkdtempSync(join(tmpdir(), `kiko-${label}-`));
  const bin = join(dir, "bin");
  const PATH = [bin, dirname(process.execPath), "/usr/bin", "/bin"];
  const win = tmuxRunner(WIN, CONFIG, { ...cleanEnv(), PATH: PATH.join(":") });
  const term = tmuxRunner(TERM, CONFIG, cleanEnv());
  const userConfFile = join(dir, "user.conf");
  const user = tmuxRunner(USER, userConfFile, cleanEnv());
  const screen = () => term(["capture-pane", "-p", "-t", "=term:"]);
  const acts = () =>
    existsSync(join(dir, "acts.log"))
      ? readFileSync(join(dir, "acts.log"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  const typed = (name: string) => (existsSync(join(dir, `${name}.typed`)) ? readFileSync(join(dir, `${name}.typed`)) : Buffer.alloc(0));
  /** A key typed into your terminal (tmux's names: C-Space, C-\, 1…). */
  const key = (...keys: string[]) => term(["send-keys", "-t", "=term:", ...keys]);
  const option = async (name: string) => (await win(["show-options", "-gqv", name])).trim();

  async function setUp() {
    mkdirSync(bin);
    if (PATH.slice(1).some((d) => existsSync(join(d, "claude")))) throw new Error("a real claude sits next to node: not running these");
    // Claude Code: every byte it gets, as it gets them (raw: Ctrl+\ would be SIGQUIT, Ctrl+Space held back to the end of a line).
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf 'FAKE CLAUDE in %s\\n' "\${PWD##*/}"\nstty raw -echo\nexec cat > '${dir}/'"\${PWD##*/}"'.typed'\n`, { mode: 0o755 });
    // The window's app, as `kiko` starts it (KIKO_WINDOW_APP takes no arguments).
    writeFileSync(join(bin, "window-app"), `#!/bin/sh\nexec '${process.execPath}' --no-warnings '${APP}' '${dir}'\n`, { mode: 0o755 });
    mkdirSync(join(dir, "pixie"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ server: WIN, projects: [join(dir, "pixie")], claude: join(bin, "claude"), outside: false }));
    await win(["new-session", "-d", "-s", "pixie", "-c", join(dir, "pixie"), "-x", "90", "-y", "39", "--", join(bin, "claude")]);
    // Your tmux, as you set it up; its one window waits for `kiko` to run in it.
    writeFileSync(userConfFile, `${userConf}\nset -g status off\n`);
    const env = [
      "-e",
      `PATH=${PATH.join(":")}`,
      "-e",
      `KIKO_TMUX_SERVER=${WIN}`,
      "-e",
      `KIKO_WINDOW_APP=${join(bin, "window-app")}`,
      "-e",
      `KIKO_SOCKET=${join(dir, "no-app.sock")}`,
      "-e",
      `KIKO_SETTINGS=${join(dir, "no-settings.json")}`,
      "-e",
      `NODE_TEST_CONTEXT=${process.env.NODE_TEST_CONTEXT || "child"}`,
      "-e",
      "TERM=xterm-256color",
    ];
    await user(["new-session", "-d", "-s", "user", "-x", String(COLS), "-y", String(ROWS + 1), ...env, "-c", dir, "--", "/bin/sh", "-c", `${cli}; echo "exit $?"; sleep 600`]);
    // Your terminal: its pane runs your tmux's client.
    await term([
      "new-session",
      "-d",
      "-s",
      "term",
      "-x",
      String(COLS),
      "-y",
      String(ROWS + 1),
      "--",
      "/bin/sh",
      "-c",
      `env -u TMUX '${TMUX}' -u -L ${USER} -f '${userConfFile}' attach -t =user; sleep 600`,
    ]);
    await until(acts, (a) => a.some((x) => x.started), "the stand-in app").catch(async (err) => {
      throw new Error(`${err.message}\nyour terminal:\n${await screen().catch(String)}`);
    });
  }
  function tearDown() {
    killServers();
    rmSync(dir, { recursive: true, force: true });
  }
  return { win, user, term, screen, acts, typed, key, option, setUp, tearDown, dir };
}

describe("the window inside your own tmux (prefix C-b)", { skip: !TMUX && "tmux isn't installed" }, () => {
  const n = nesting("nestb", "set -g prefix C-b");
  before(() => n.setUp());
  after(() => n.tearDown());

  test("no clash: the key is Ctrl+Space, nothing to tell", async () => {
    assert.equal(await n.option(KEY_OPTION), "C-Space");
    assert.equal(await n.option(KEY_BY_OPTION), "default");
    assert.equal(await n.option(NOTES_OPTION), "");
    const s = await until(n.screen, (t) => /⌃Space menu/.test(t), "the bottom line");
    assert.ok(!s.includes("Your tmux uses"), s);
  });

  test("Ctrl+Space typed in your terminal goes through your tmux and opens Kiko's menu; a number shows that session", async () => {
    await n.key("C-Space");
    await until(n.screen, (t) => t.includes("Previous session") && t.includes("Quit Kiko…"), "the menu, through your tmux");
    await n.key("1");
    await until(n.screen, (t) => t.includes("FAKE CLAUDE in pixie") && !t.includes("Previous session"), "pixie shown, the menu gone");
  });

  test("Ctrl+Space twice: the menu closes and Ctrl+Space goes to the session shown (checked, as everything Kiko types)", async () => {
    const before = n.typed("pixie").length;
    await n.key("C-Space");
    await until(n.screen, (t) => t.includes("Previous session"), "the menu");
    await n.key("C-Space");
    await until(n.screen, (t) => !t.includes("Previous session"), "the menu closed");
    const got = await until(
      () => n.typed("pixie").subarray(before),
      (b) => b.length > 0,
      "the key in pixie",
    );
    // NUL, or Ctrl+Space as CSI u when the program asked for extended keys.
    assert.ok(got.equals(Buffer.from([0])) || got.toString() === "\x1b[32;5u", JSON.stringify(got.toString()));
    const passed = n.acts().find((a) => a.passed);
    assert.deepEqual(passed, { passed: { sent: true }, key: "C-Space" });
    assert.ok(
      n.acts().some((a) => a.action === "passKey" && a.sessionId === "pixie"),
      "asked for pixie",
    );
  });

  test("your tmux's own prefix still works (Ctrl+B is yours, not Kiko's)", async () => {
    const windows = async () => (await n.user(["list-windows", "-t", "=user", "-F", "#{window_id}"])).trim().split("\n");
    const was = await windows();
    await n.key("C-b", "c");
    const now = await until(windows, (w) => w.length === was.length + 1, "a new window in your tmux (Ctrl+B c)");
    await n.user(["kill-window", "-t", now.find((w) => !was.includes(w))!]);
  });
});

describe("the window inside your own tmux with Ctrl+Space as its prefix", { skip: !TMUX && "tmux isn't installed" }, () => {
  const n = nesting("nestsp", "set -g prefix C-Space\nunbind C-b");
  before(() => n.setUp());
  after(() => n.tearDown());

  const QUESTION = "Use Ctrl+\\ from now on";
  const SPOKEN = "Your tmux uses Control-Space, so the menu key is Control-Backslash this time. Keep it, or pick your own? It's asked in the window.";
  const settings = () => (existsSync(join(n.dir, "no-settings.json")) ? JSON.parse(readFileSync(join(n.dir, "no-settings.json"), "utf8")) : {});
  /** One more `kiko` in a new window of your tmux, shown in your terminal (a second view of the window). */
  async function another(views: number) {
    await n.user(["new-window", "-t", "=user:", "-c", n.dir, "--", "/bin/sh", "-c", `'${CLI}'; sleep 600`]);
    await until(
      async () => (await layoutOf(n.win)).view?.clients ?? 0,
      (c) => c >= views,
      `view ${views}`,
    );
  }

  test("the clash is found: Ctrl+\\ is the key this time, warned once (bottom line, out loud), then asked in a popup", async () => {
    assert.equal(await n.option(KEY_OPTION), "C-\\");
    assert.equal(await n.option(KEY_BY_OPTION), "clash");
    const notes = JSON.parse(await n.option(NOTES_OPTION));
    assert.deepEqual(notes[0].log, { event: "key_clash", fields: { by: "tmux", key: "C-Space", fallback: "C-\\", asked: true } });
    assert.equal(notes[0].text, "Your tmux uses Ctrl+Space, so the menu key is Ctrl+\\ this time. Keep it, or pick your own?");
    const s = await until(n.screen, (t) => t.includes(QUESTION) && t.includes("Your tmux uses Ctrl+Space, so the menu key is Ctrl+\\"), "the question, and the notice on the bottom line");
    assert.match(s, /Your tmux uses Ctrl\+Space,\s/, "the question says which program takes the key");
    assert.match(s, /Set my own key in settings…/);
    assert.match(s, /⌃\\ menu/, "the hints name the key in use");
    const spoken = await until(
      () => n.acts().filter((a) => a.said),
      (a) => a.length > 0,
      "said out loud",
    );
    assert.deepEqual(spoken, [{ said: SPOKEN }]);
    // Told once: marked as said on the server, and not again on the next look.
    assert.equal(await n.option("@kiko-notes-said"), notes[0].id);
    // Escape: no answer; Ctrl+\ stays this run.
    await n.key("Escape");
    await until(n.screen, (t) => !t.includes(QUESTION), "the question gone");
    await wait(1500);
    assert.equal(n.acts().filter((a) => a.said).length, 1);
    assert.equal(settings().keyClashAnswers, undefined, "nothing remembered");
    assert.equal(await n.option(KEY_OPTION), "C-\\");
  });

  test("Ctrl+\\ typed in your terminal opens Kiko's menu (Ctrl+Space stays your tmux's prefix)", async () => {
    await n.key("C-\\");
    await until(n.screen, (t) => t.includes("Previous session") && t.includes("Quit Kiko…"), "the menu on Ctrl+\\");
    await n.key("1");
    await until(n.screen, (t) => t.includes("FAKE CLAUDE in pixie") && !t.includes("Previous session"), "pixie shown");
    // Ctrl+\ twice: Ctrl+\ to pixie.
    const before = n.typed("pixie").length;
    await n.key("C-\\");
    await until(n.screen, (t) => t.includes("Previous session"), "the menu");
    await n.key("C-\\");
    const got = await until(
      () => n.typed("pixie").subarray(before),
      (b) => b.length > 0,
      "Ctrl+\\ in pixie",
    );
    assert.ok(got.equals(Buffer.from([0x1c])) || got.toString() === "\x1b[92;5u", JSON.stringify(got.toString()));
  });

  test("let go, the next kiko asks again; y keeps Ctrl+\\ and remembers it", async () => {
    await n.user(["new-window", "-d", "-t", "=user:", "--", "/bin/sh", "-c", `'${CLI}' ls; sleep 5`]);
    // `ls` doesn't open the window; a second `kiko` view does, and finds the same clash, not answered.
    await another(2);
    await until(n.screen, (t) => t.includes(QUESTION), "asked again");
    await until(
      () => n.acts().filter((a) => a.said),
      (a) => a.length === 2,
      "warned again",
    );
    await n.key("y");
    await until(n.screen, (t) => !t.includes(QUESTION), "the question gone");
    const kept = await until(settings, (s) => Boolean(s.keyClashAnswers), "the answer in the settings");
    assert.deepEqual(kept.keyClashAnswers, { "tmux:C-Space:C-\\": "fallback" });
    // Under the list, wrapped to its width.
    // (In the classic look the list is a box: its rows are what's between its borders.)
    const list = (t: string) =>
      t
        .split("\n")
        .map((r) => (r.startsWith("│") ? r.split("│")[1] : r))
        .join(" ")
        .replace(/\s+/g, " ");
    await until(n.screen, (t) => list(t).includes("The menu key is Ctrl+\\ from now on when your tmux takes Ctrl+Space."), "said under the list");
    assert.equal(await n.option(KEY_OPTION), "C-\\");
  });

  test("answered: the next kiko with the same clash doesn't ask or say it, only shows it once", async () => {
    await another(3);
    await until(n.screen, (t) => t.includes("Your tmux uses Ctrl+Space. The menu key is Ctrl+\\ then, as you chose."), "the remembered answer on the bottom line");
    await wait(1500);
    assert.ok(!(await n.screen()).includes(QUESTION), "not asked");
    assert.equal(n.acts().filter((a) => a.said).length, 2, "nothing said");
    assert.equal(await n.option(KEY_OPTION), "C-\\");
    assert.equal(await n.option(KEY_BY_OPTION), "clash");
  });
});

// Warp takes Ctrl+Space itself (clash.ts TERMINAL_KEYS): a stand-in for running `kiko` in Warp,
// TERM_PROGRAM=WarpTerminal given to it alone (in a real tmux pane TERM_PROGRAM is tmux's), inside a
// tmux whose prefix is Ctrl+B, so only Warp clashes.
describe("kiko in Warp (TERM_PROGRAM=WarpTerminal, a stand-in)", { skip: !TMUX && "tmux isn't installed" }, () => {
  const n = nesting("warp", "set -g prefix C-b", `env TERM_PROGRAM=WarpTerminal '${CLI}'`);
  before(() => n.setUp());
  after(() => n.tearDown());
  const settings = () => (existsSync(join(n.dir, "no-settings.json")) ? JSON.parse(readFileSync(join(n.dir, "no-settings.json"), "utf8")) : {});

  test("warned and asked, saying it's Warp; s opens settings on the menu key and remembers it", async () => {
    assert.equal(await n.option(KEY_OPTION), "C-\\");
    const notes = JSON.parse(await n.option(NOTES_OPTION));
    assert.deepEqual(notes[0].log, { event: "key_clash", fields: { by: "terminal", app: "Warp", key: "C-Space", fallback: "C-\\", asked: true } });
    await until(n.screen, (t) => t.includes("Warp uses Ctrl+Space for a new pane,") && t.includes("Use Ctrl+\\ from now on"), "the question, naming Warp");
    const spoken = await until(
      () => n.acts().filter((a) => a.said),
      (a) => a.length > 0,
      "said out loud",
    );
    assert.match(spoken[0].said, /^Warp uses Control-Space for a new pane, so the menu key is Control-Backslash this time\./);
    await n.key("s");
    const opened = await until<{ at?: string } | undefined>(() => n.acts().find((a) => a.action === "settings"), Boolean, "settings opened");
    assert.equal(opened?.at, "menuKey", "on the menu key");
    assert.deepEqual((await until(settings, (s) => Boolean(s.keyClashAnswers), "the answer kept")).keyClashAnswers, { "terminal:Warp:C-Space:C-\\": "own" });
    // Ctrl+\ is still the key this run.
    assert.equal(await n.option(KEY_OPTION), "C-\\");
  });
});
