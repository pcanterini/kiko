// The Kiko window against a real tmux, end to end: `kiko` and `kiko claude` (bin/kiko)
// run in panes of a throwaway "outer" tmux that stands in for your terminal, so they really attach
// and what they draw can be read back (`capture-pane` on the outer pane: the bottom line, the
// borders, the placeholder). Kiko's tmux is another throwaway server (KIKO_TMUX_SERVER), never
// `-L kiko` nor the default one; both are killed afterwards whatever happens.
//
// Nothing real starts: the window's app is a stand-in (KIKO_WINDOW_APP, a shell script), and
// `claude` is a stand-in on a PATH that has no real one (the test stops if it would). Each stand-in
// session ends in `cat`, so words typed into it are read back exactly.
//
// The window here has the tiled look (KIKO_LOOK=tiled): the one tmux older than 3.8 keeps,
// unchanged, its bottom line in the status line. On tmux 3.8 and later the window has the classic
// look by default: classic-live.test.ts.
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { tmuxTerminal } from "../../../src/terminals/tmux/index.ts";
import { TITLE } from "../../../src/core/name.ts";
import { CONFIG, cleanEnv, processes, tmuxPath, tmuxRunner, WINDOW } from "../../../src/terminals/tmux/tmux.ts";
import { closeWindow, describe as layoutOf, listWidth, NEW_AGENT_OPTION, setBar, show, zoom } from "../../../src/terminals/tmux/window.ts";
import { literal } from "../../../src/ui/bar.ts";
import { killServers, throwawayServer } from "../../support/tmux-servers.ts";
import { valueWaits } from "../../support/until.ts";

const TMUX = tmuxPath();
// This process opens sessions into the window too (the tmux adapter): the same look, never made over.
process.env.KIKO_LOOK = "tiled";
const WIN = throwawayServer("win");
const OUTER = throwawayServer("outer");
const ID = WIN.split("-")[2];
const CLI = fileURLToPath(new URL("../../../bin/kiko", import.meta.url));
const CLI_TS = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "kiko-window-"));
const bin = join(dir, "bin");
const PATH = [bin, dirname(process.execPath), "/usr/bin", "/bin"];
const SECRET = `not-a-real-secret-${ID}`;
const win = tmuxRunner(WIN, CONFIG, cleanEnv());
/** What every `kiko` here runs with: the stand-in app, a socket no app listens on, and the test runner's mark (cli.ts refuses the real app under it). */
const STANDINS = [
  "-e",
  `KIKO_WINDOW_APP=${join(bin, "standin-app")}`,
  "-e",
  `KIKO_SOCKET=${join(dir, "no-app.sock")}`,
  // The tiled look, as on tmux older than 3.8 (src/terminals/tmux/classic.ts).
  "-e",
  "KIKO_LOOK=tiled",
  // No saved settings (the scratch folder, the menu key): never yours.
  "-e",
  `KIKO_SETTINGS=${join(dir, "no-settings.json")}`,
  "-e",
  `NODE_TEST_CONTEXT=${process.env.NODE_TEST_CONTEXT || "child"}`,
];
const outer = tmuxRunner(OUTER, CONFIG, { ...cleanEnv(), PATH: PATH.join(":") });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = valueWaits(6000, 50);
const read = (file: string) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : "");
/** What the terminal running `kiko` in outer window `w` shows. */
const screen = (w: string) => outer(["capture-pane", "-p", "-t", `=outer:${w}`]);
const layout = () => layoutOf(win);
const stage = async () => (await layout()).view?.stage ?? null;

/** Runs bin/kiko in a new window of the outer tmux (as if typed in a terminal there), in `cwd`. */
async function run(name: string, cwd: string, ...args: string[]) {
  await outer(["new-window", "-d", "-t", "=outer:", "-n", name, "-c", cwd, "--", "/bin/sh", "-c", '"$@"; echo "exit $?"; sleep 60', "sh", CLI, ...args]);
}

/**
 * As `run`, with a TMUX and TMUX_PANE naming the window's server (`pane` there) though this terminal
 * is no client of it: a terminal app opened from one of its panes passes them to every shell in it.
 */
async function runStale(name: string, cwd: string, pane: string, ...args: string[]) {
  const socket = (await win(["display", "-p", "#{socket_path}"])).trim();
  const script = 'export TMUX="$1" TMUX_PANE="$2"; shift 2; "$@"; echo "exit $?"; sleep 60';
  await outer(["new-window", "-d", "-t", "=outer:", "-n", name, "-c", cwd, "--", "/bin/sh", "-c", script, "sh", `${socket},1,0`, pane, CLI, ...args]);
}

describe("the Kiko window, for real", { skip: !TMUX && "tmux isn't installed" }, () => {
  before(async () => {
    mkdirSync(bin);
    if (PATH.slice(1).some((d) => existsSync(join(d, "claude")))) throw new Error("a real claude sits next to node: not running these");
    // The window's app: says it started (with an environment value it should get, not on its
    // command line), then takes keys typed into the list.
    writeFileSync(join(bin, "standin-app"), `#!/bin/sh\necho "started MYVAR=$MYVAR" >> '${dir}/app.log'\nprintf 'STAND-IN APP\\n'\nexec cat > '${dir}/app.keys'\n`, { mode: 0o755 });
    // Claude Code: a line on screen, then what's typed into it goes to a file named for its folder.
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf 'FAKE CLAUDE in %s\\n' "\${PWD##*/}"\nexec cat > '${dir}/'"\${PWD##*/}"'.typed'\n`, { mode: 0o755 });
    for (const p of ["pixie", "lacy"]) mkdirSync(join(dir, p));
    await outer([
      "new-session",
      "-d",
      "-s",
      "outer",
      "-x",
      "120",
      "-y",
      "40",
      "-e",
      `PATH=${PATH.join(":")}`,
      "-e",
      `KIKO_TMUX_SERVER=${WIN}`,
      ...STANDINS,
      "-e",
      `MYVAR=${SECRET}`,
      "--",
      "/bin/sh",
      "-c",
      "sleep 600",
    ]);
  });
  after(() => {
    killServers();
    rmSync(dir, { recursive: true, force: true });
  });

  test("kiko: the window, attached, its app started once with your environment (never on a command line)", async () => {
    await run("one", dir);
    const view = await until(
      async () => (await layout()).view,
      (v) => Boolean(v?.list && v.clients === 1),
      "the window, attached",
    );
    await until(
      () => read("app.log"),
      (s) => s.includes("started"),
      "the stand-in app",
    );
    assert.equal(read("app.log"), `started MYVAR=${SECRET}\n`);
    const started = await win(["display", "-p", "-t", view!.list!.id, "#{pane_start_command}"]);
    assert.ok(!started.includes(SECRET), "the value isn't in the pane's command");
    // `kiko` started the server: with what a new terminal has, not your shell's (sessions opened later get the server's).
    const serverEnv = await win(["show-environment", "-g"]);
    assert.ok(!serverEnv.includes(SECRET) && !/^MYVAR=/m.test(serverEnv), "your environment isn't the server's");
    // Made with the list the whole window, for the splash or first-run setup (ui/splash.ts wholeFirst):
    // the app gives the list its own size back as it starts (ui/window-zoom.ts start), the stand-in
    // can't, so here, as it would.
    assert.equal(view!.zoomed, true, "made whole");
    await zoom(win, view!.list!.id, false);
    const shown = await until(
      () => screen("one"),
      // The bar, and the placeholder (a new window's says the app is starting, until it's ready: the stand-in never is).
      (s) => s.split(`${TITLE} is starting…`).length >= 3,
      "the bar and the placeholder",
    );
    assert.match(shown, /STAND-IN APP/);
    // A second `kiko`: one more view of the same window, and still one app.
    await run("two", dir);
    await until(
      async () => (await layout()).view?.clients,
      (n) => n === 2,
      "a second view",
    );
    await wait(300);
    assert.equal(read("app.log").split("\n").filter(Boolean).length, 1);
  });

  test("kiko claude: the session in the window's stage, focused, its own process; then another, and back", async () => {
    await run("pixie", join(dir, "pixie"), "claude");
    const pixie = await until(stage, (p) => p?.cwd.endsWith("/pixie") === true, "pixie in the stage");
    assert.equal(pixie!.active, true);
    const started = await win(["display", "-p", "-t", pixie!.id, "#{pane_start_command}"]);
    assert.ok(!started.includes(SECRET), "your environment isn't on its command line either");
    await until(
      () => screen("pixie"),
      (s) => s.includes("FAKE CLAUDE in pixie") && /─ pixie ─|pixie/.test(s),
      "pixie on screen",
    );
    await run("lacy", join(dir, "lacy"), "claude");
    const lacy = await until(stage, (p) => p?.cwd.endsWith("/lacy") === true, "lacy in the stage");
    // pixie went home, to its own tmux session, still running.
    const all = await layout();
    assert.equal(all.panes.find((p) => p.id === pixie!.id)?.session, "pixie");
    assert.equal(all.panes.find((p) => p.session === "lacy")?.role, "placeholder");
    assert.equal(await show(win, pixie!.id), "shown");
    assert.equal((await stage())?.id, pixie!.id);
    assert.equal((await layout()).panes.find((p) => p.id === lacy!.id)?.session, "lacy");
  });

  test("kiko claude preselects Claude Code for new sessions this run (a server option) and keeps it as the last used; a plain kiko takes the run's out", async () => {
    const runAgent = async () => (await win(["show-options", "-gqv", NEW_AGENT_OPTION])).trim();
    assert.equal(await runAgent(), "claude-code");
    assert.equal(JSON.parse(read("no-settings.json")).lastNewSessionAgent, "claude-code");
    await run("three", dir);
    await until(runAgent, (v) => v === "", "the run's agent taken out");
    assert.equal(JSON.parse(read("no-settings.json")).lastNewSessionAgent, "claude-code", "the last used stays");
  });

  test("typing: found by its process and typed into wherever its pane is, shown or at home", async () => {
    const terminal = tmuxTerminal({ tmux: win, ps: processes, show: async () => {}, wait: async (ms) => void (await wait(ms)), installed: () => true, shell: "/bin/sh" });
    const panes = (await layout()).panes.filter((p) => !p.role);
    const pids = await Promise.all(panes.map(async (p) => Number((await win(["display", "-p", "-t", p.id, "#{pane_pid}"])).trim())));
    const found = await terminal.find(
      Promise.resolve(panes.map((p, i) => ({ sessionId: p.cwd.split("/").pop()!, cwd: p.cwd, kind: "interactive" as const, desktop: false, titles: [], pid: pids[i] }))),
    );
    for (const name of ["pixie", "lacy"]) {
      const place = found.get(name)?.place;
      assert.ok(place, `${name} found by its process`);
      assert.deepEqual(await terminal.type(place, `hello ${name}`), { sent: true });
      await until(
        () => read(`${name}.typed`),
        (s) => s === `hello ${name}\n`,
        `${name}'s words`,
      );
    }
    assert.equal(read("app.keys"), "", "nothing in the list");
  });

  test("kiko ls: names and folders as plain text, a name's escape sequences never reach the terminal", async () => {
    const pixie = (await layout()).panes.find((p) => !p.role && p.cwd.endsWith("/pixie"))!;
    await win(["set-option", "-p", "-t", pixie.id, "@kiko-name", "ro\u001b]52;c;aGk=\u0007\u001b[8mcky"]);
    const ls = spawnSync(process.execPath, [CLI_TS, "ls"], {
      env: { ...cleanEnv(), KIKO_TMUX_SERVER: WIN, KIKO_SOCKET: join(dir, "no-app.sock"), KIKO_SETTINGS: join(dir, "no-settings.json") },
      encoding: "utf8",
    });
    await win(["set-option", "-p", "-t", pixie.id, "@kiko-name", "pixie"]);
    assert.equal(ls.status, 0, ls.stderr);
    assert.match(ls.stdout, /ro \]52;c;aGk= {2}\[8mcky/);
    assert.ok(!/[\u0000-\u0009\u000b-\u001f]/.test(ls.stdout), JSON.stringify(ls.stdout));
  });

  test("Ctrl+Space, then Tab, moves between the list and the session (the menu tmux shows before the app makes its own); F1 is the session's", async () => {
    const before = await stage();
    assert.equal(before!.active, true);
    // Tab's words say where it goes from the side that has the keyboard (`words`).
    const tab = async (words: string) => {
      await outer(["send-keys", "-t", "=outer:pixie", "C-Space"]);
      await until(
        () => screen("pixie"),
        (s) => s.includes(`${TITLE} is starting…`) && s.includes(words),
        "the starting menu",
      );
      await outer(["send-keys", "-t", "=outer:pixie", "Tab"]);
      await until(
        () => screen("pixie"),
        (s) => !s.includes(words),
        "the menu closed",
      );
    };
    await tab("Go to the list ←");
    await until(
      async () => (await layout()).view?.list?.active,
      (a) => a === true,
      "the list focused",
    );
    await outer(["send-keys", "-t", "=outer:pixie", "-l", "x"]);
    await outer(["send-keys", "-t", "=outer:pixie", "Enter"]);
    await until(
      () => read("app.keys"),
      (s) => s === "x\n",
      "keys in the list",
    );
    await tab("Go to the session →");
    await until(stage, (p) => p?.active === true, "the session focused again");
    // F1 isn't taken any more: it reaches the program in the pane.
    assert.equal(
      (await win(["list-keys", "-T", "root"])).split("\n").some((l) => /\sF1\s/.test(l)),
      false,
    );
  });

  test("the bottom line: the app's text, drawn as is (# included)", async () => {
    await setBar(win, `#[fg=green]●#[default] Kiko is ready · you: “${literal("fix #42 [now]")}”`);
    await until(
      () => screen("pixie"),
      (s) => s.includes("Kiko is ready · you: “fix #42 [now]”"),
      "the bar",
    );
  });

  test("the borders: one quiet bar, no lines or corners; the focused pane's name bold in the accent colour, the other a readable grey", async () => {
    const view = (await layout()).view!;
    for (const focus of [view.list!, view.stage!]) {
      await win(["select-pane", "-t", focus.id]);
      await wait(200);
      const rows = (await outer(["capture-pane", "-p", "-e", "-t", "=outer:pixie"])).split("\n");
      const top = rows[0];
      const text = top.replace(/\u001b\[[0-9;]*m/g, "");
      assert.ok(!/[─┬┼│]/.test(text), `no line-drawing on the top row: ${JSON.stringify(text)}`);
      assert.match(text, new RegExp(`^ {2}${TITLE} {2,}\\S`), "the list's name two columns in, then the session's");
      // The focused name: bold, colour 110; the other: colour 248 (over 5:1 on the bar's colour 236).
      const name = focus === view.list ? "Kiko" : "pixie";
      const other = focus === view.list ? "pixie" : "Kiko";
      assert.match(top, new RegExp(`\\u001b\\[1m\\u001b\\[38;5;110m${name}`), JSON.stringify(top));
      assert.match(top, new RegExp(`\\u001b\\[38;5;248m(?:\\u001b\\[48;5;236m)?[^\\u001b]*${other}`), JSON.stringify(top));
      // The bar between the panes: the same colour all the way down, whichever pane has focus.
      const between = rows.slice(1, -2).map((r) => /\u001b\[38;5;(\d+)m\u001b\[48;5;(\d+)m \u001b\[39m\u001b\[49m/.exec(r)?.slice(1).join("/") ?? "none");
      assert.deepEqual([...new Set(between)], ["248/236"], JSON.stringify(between));
    }
  });

  test("the bottom line: what you said stays text, whatever's in it; nothing runs", async () => {
    const pwned = `/tmp/${WIN}-pwned`; // short: the whole line fits the screen
    const said = `it's $HOME; #(touch ${pwned}) #[fg=red]red? ##[x] #{pane_id} \\ ~ "q"`;
    await setBar(win, `you: “${literal(said, 200)}”`);
    const shown = await until(
      () => screen("pixie"),
      (s) => s.includes("you: “it's"),
      "the bar",
    );
    assert.ok(shown.includes(`you: “${said}”`), shown);
    // Drawn as text, not as a style: no red in the bottom line.
    const styled = (await outer(["capture-pane", "-p", "-e", "-t", "=outer:pixie"])).split("\n").filter((l) => l.includes("you: “it's"));
    assert.ok(styled.length && !styled[0].includes("\u001b[31m"), JSON.stringify(styled));
    await wait(300);
    assert.equal(existsSync(pwned), false, "#( ran nothing");
  });

  test("resized, wider and narrower: both panes still there, the session still shown; tmux puts the list back to its width", async () => {
    const shown = (await stage())!.id;
    await outer(["resize-window", "-t", "=outer:pixie", "-x", "160", "-y", "45"]);
    const view = await until(
      async () => (await layout()).view,
      (v) => v?.width === 160,
      "the window wider",
    );
    assert.equal(view!.stage!.id, shown);
    const after = await until(
      async () => (await layout()).view,
      (v) => v?.list?.width === listWidth(160),
      "the list's width",
    );
    assert.equal(after!.list!.width + 1 + after!.stage!.width, 160);
    await outer(["resize-window", "-t", "=outer:pixie", "-x", "80", "-y", "24"]);
    const narrow = await until(
      async () => (await layout()).view,
      (v) => v?.width === 80 && v.list?.width === listWidth(80),
      "narrower, the list's width",
    );
    assert.equal(narrow!.stage!.id, shown);
    // Zoomed (settings), a resize leaves it zoomed: resizing the list would unzoom it.
    await zoom(win, narrow!.list!.id, true);
    await outer(["resize-window", "-t", "=outer:pixie", "-x", "120", "-y", "40"]);
    await until(
      async () => (await layout()).view?.width,
      (w) => w === 120,
      "back to 120",
    );
    await wait(200);
    assert.equal((await layout()).view!.zoomed, true);
    await zoom(win, narrow!.list!.id, false);
  });

  test("zoomed (settings, the full screen) and back", async () => {
    const list = (await layout()).view!.list!.id;
    await zoom(win, list, true);
    assert.equal((await layout()).view!.zoomed, true);
    await zoom(win, list, true);
    assert.equal((await layout()).view!.zoomed, true, "asking twice doesn't undo it");
    await zoom(win, list, false);
    assert.equal((await layout()).view!.zoomed, false);
  });

  test("Ctrl+Space Tab while the list is zoomed (settings open): back to the window, the keyboard in the session", async () => {
    const list = (await layout()).view!.list!.id;
    await win(["select-pane", "-t", list]);
    await zoom(win, list, true);
    await outer(["send-keys", "-t", "=outer:pixie", "C-Space"]);
    // The list has the keyboard: Tab's words say it goes to the session.
    await until(
      () => screen("pixie"),
      (s) => s.includes("Go to the session →"),
      "the menu",
    );
    await outer(["send-keys", "-t", "=outer:pixie", "Tab"]);
    const view = await until(
      async () => (await layout()).view,
      (v) => v?.zoomed === false,
      "unzoomed",
    );
    assert.equal(view!.stage!.active, true);
  });

  test("a session ends whose home holds another live session (a mix-up): tmux's hook never respawns that one", async () => {
    const before = (await stage())!;
    const a = (await win(["new-session", "-d", "-s", "hooka", "-P", "-F", "#{pane_id}", "--", "/bin/sh", "-c", "exec sleep 600"])).trim();
    const b = (await win(["new-session", "-d", "-s", "hookb", "-P", "-F", "#{pane_id}", "--", "/bin/sh", "-c", "exec sleep 600"])).trim();
    assert.equal(await show(win, a), "shown");
    // b swapped into a's home, in place of the placeholder there.
    const home = (await win(["show-options", "-p", "-v", "-t", a, "@kiko-home"])).trim();
    const placeholder = (await win(["list-panes", "-t", home, "-F", "#{pane_id}"])).trim();
    await win(["swap-pane", "-d", "-s", b, "-t", placeholder]);
    const pidOf = async (p: string) => Number((await win(["display", "-p", "-t", p, "#{pane_pid}"])).trim());
    const bPid = await pidOf(b);
    process.kill(await pidOf(a));
    await until(stage, (p) => p?.id === a && p.dead, "a ended, kept in the stage");
    await wait(400);
    assert.equal(await pidOf(b), bPid, "b not respawned");
    assert.equal((await win(["display", "-p", "-t", b, "#{pane_dead}"])).trim(), "0");
    // Shown again: tidy closes the ended one and leaves b be.
    assert.equal(await show(win, before.id), "shown");
    assert.ok(!(await layout()).panes.some((p) => p.id === a), "a closed");
    assert.equal(await pidOf(b), bPid);
    await win(["kill-session", "-t", "=hooka"]);
    await win(["kill-session", "-t", "=hookb"]);
  });

  test("kiko run inside Kiko's tmux (a session's shell): that terminal moves to the window", async () => {
    const before = (await layout()).view!.clients;
    // Its own stand-ins, given here: never left to what the server happens to have (were the window
    // gone, kiko would start the app named here, never the real one).
    await win(["new-session", "-d", "-s", "shell", "-e", `PATH=${PATH.join(":")}`, "-e", `KIKO_TMUX_SERVER=${WIN}`, ...STANDINS, "--", "/bin/sh", "-c", `sleep 1; '${CLI}'; sleep 60`]);
    await outer(["new-window", "-d", "-t", "=outer:", "-n", "inside", "--", TMUX!, "-L", WIN, "attach-session", "-t", "=shell"]);
    await until(
      async () => (await layout()).view?.clients,
      (n) => n === before + 1,
      "one more view of the window",
    );
    await win(["kill-session", "-t", "=shell"]);
  });

  test("a stale TMUX naming Kiko's server (a terminal app opened from one of its panes, no client of it): kiko attaches as from any terminal", async () => {
    const list = (await layout()).view!.list!.id;
    // The pane it names gone (Ghostty relaunched from a shell since closed), or one that's there, in another terminal.
    for (const [name, pane] of [
      ["stale-gone", "%99999"],
      ["stale-list", list],
    ]) {
      const before = (await layout()).view!.clients;
      await runStale(name, dir, pane);
      await until(
        async () => (await layout()).view?.clients,
        (n) => n === before + 1,
        `one more view of the window (${name})`,
      ).catch(async (err) => {
        throw new Error(`${err.message}\n${await screen(name)}`);
      });
      const shown = await until(
        () => screen(name),
        (s) => s.includes("STAND-IN APP"),
        `the window in ${name}`,
      );
      assert.doesNotMatch(shown, /no current client/);
    }
  });

  test('kiko with its terminal opened read-only (install.sh\'s `kiko setup <"$term"`): the terminal opened again for it, and the window drawn there', async () => {
    // 2026-11-02: tmux attached to a read-only stdin and drew nothing; the screen stayed as it was.
    const before = (await layout()).view!.clients;
    const script = 'exec 0<"$(tty)"; "$@"; echo "exit $?"; sleep 60';
    await outer(["new-window", "-d", "-t", "=outer:", "-n", "readonly", "-c", dir, "--", "/bin/sh", "-c", script, "sh", CLI]);
    await until(
      async () => (await layout()).view?.clients,
      (n) => n === before + 1,
      "one more view of the window",
    );
    await until(
      () => screen("readonly"),
      (s) => s.includes("STAND-IN APP"),
      "the window drawn in that terminal",
    );
  });

  test("kiko with no terminal at all: no client attached, and it says to run kiko in a terminal", async () => {
    const before = (await layout()).view!.clients;
    // A session of its own (detached): no controlling terminal, nothing to find by name.
    const child = spawn(CLI, [], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: dir,
      env: { ...cleanEnv(), PATH: PATH.join(":"), KIKO_TMUX_SERVER: WIN, ...Object.fromEntries(STANDINS.filter((_, i) => i % 2).map((kv) => [kv.split("=")[0], kv.slice(kv.indexOf("=") + 1)])) },
    });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    assert.equal(code, 1);
    assert.match(err, /there's no terminal here to show its window in\. Run kiko(-dev)? in a terminal to see it\./);
    assert.equal((await layout()).view!.clients, before);
  });

  test("kiko claude with a stale TMUX: claude in Kiko's tmux, shown in the window (never plain claude, as in one of its panes)", async () => {
    const before = (await stage())!;
    mkdirSync(join(dir, "stale"));
    await runStale("stale-claude", join(dir, "stale"), "%99999", "claude");
    const started = await until(stage, (p) => p?.cwd.endsWith("/stale") === true, "stale in the stage").catch(async (err) => {
      throw new Error(`${err.message}\n${await screen("stale-claude")}`);
    });
    await until(
      () => screen("stale-claude"),
      (s) => s.includes("FAKE CLAUDE in stale"),
      "stale on screen",
    );
    // As it was for the tests after: pixie shown, two sessions. stale goes home, to its own tmux session.
    assert.equal(await show(win, before.id), "shown");
    assert.equal((await layout()).panes.find((p) => p.id === started!.id)?.session, "stale");
    await win(["kill-session", "-t", "=stale"]);
  });

  test("the session shown quits: tmux puts the placeholder back and ends its tmux session (no app needed)", async () => {
    const shown = (await stage())!;
    const name = shown.cwd.split("/").pop()!;
    const pid = Number((await win(["display", "-p", "-t", shown.id, "#{pane_pid}"])).trim());
    process.kill(pid);
    const now = await until(stage, (p) => p?.role === "placeholder", "the placeholder back");
    assert.ok(now);
    const sessions = (await win(["list-sessions", "-F", "#{session_name}"])).split("\n").filter(Boolean);
    assert.ok(!sessions.includes(name), `${name}'s tmux session is gone: ${sessions.join(", ")}`);
    // The placeholder back in the stage, drawn: it says the app is starting (the stand-in app is never ready; the bar says what an earlier test set).
    await until(
      () => screen("pixie"),
      (s) => s.includes(`${TITLE} is starting…`),
      "the placeholder on screen",
    );
  });

  test("closed: every view goes back to its shell, the other session runs on", async () => {
    await closeWindow(win);
    await until(
      () => screen("one"),
      (s) => /exit 0/.test(s),
      "kiko returned",
    );
    const sessions = (await win(["list-sessions", "-F", "#{session_name}"])).split("\n").filter(Boolean);
    assert.ok(!sessions.includes(WINDOW));
    assert.equal(sessions.length, 1);
    assert.ok(
      (await layout()).panes.some((p) => !p.role && !p.dead),
      "still running",
    );
  });
});
