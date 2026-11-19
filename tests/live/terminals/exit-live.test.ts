// A session Kiko opened that quits by itself, for real (once, /exit typed in
// a session opened from the window left its shell in the stage after the session had left the
// list). A throwaway tmux server (`-L kiko-test-<random>-exit`, never Kiko's nor the default
// one) with the Kiko window open, its list running the stand-in app (tests/support/window-app.ts:
// the real glue, page and viewer), and sessions opened as the app opens them (the tmux adapter's
// `open`: the agent in the login shell, `/bin/sh` here, then index.ts afterProgram). The agents are
// stand-ins: Claude Code a shell script that quits on /exit; Codex the fake TUI (tests/support/
// fake-codex.mjs, 0.153.0: no daemon, no hooks) through a hard link named codex, quitting on /exit;
// OpenCode the fake TUI (tests/support/fake-opencode-tui.mjs) through a link named opencode, ended
// by a signal (a crash). A second throwaway server with no window is where a session is shown in a
// terminal of its own; one more stand-in stops itself (as Ctrl+Z would), run by sh and by zsh -f
// (never your rc files). Signals go only to processes this test started. Skipped when tmux isn't installed.
import "../../setup.ts";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { afterProgram, tmuxTerminal } from "../../../src/terminals/tmux/index.ts";
import { CONFIG, cleanEnv, LEAVE_TMUX, processes, tmuxPath, tmuxRunner } from "../../../src/terminals/tmux/tmux.ts";
import { describe as layoutOf, openWindow, PAGE_ID, show } from "../../../src/terminals/tmux/window.ts";
import { killServers, throwawayServer } from "../../support/tmux-servers.ts";
import { valueWaits } from "../../support/until.ts";

const TMUX = tmuxPath();
const WIN = throwawayServer("exit");
const BARE = throwawayServer("exitbare");
const APP = fileURLToPath(new URL("../../support/window-app.ts", import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL("../../support/fake-codex.mjs", import.meta.url));
const FAKE_OPENCODE = fileURLToPath(new URL("../../support/fake-opencode-tui.mjs", import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), "cbe-")));
const bin = join(dir, "bin");
const env = {
  ...cleanEnv(),
  // No folder a real agent may be in (node's often has codex or opencode next to it): the stand-ins name node by its path.
  PATH: [bin, "/usr/bin", "/bin"].join(":"),
  CODEX_HOME: join(dir, "codex-home"),
  FAKE_CODEX_VERSION: "0.153.0",
  FAKE_OPENCODE_LOG: join(dir, "opencode.log"),
};
const win = tmuxRunner(WIN, CONFIG, env);
const bare = tmuxRunner(BARE, CONFIG, env);
const adapter = (tmux: typeof win) => tmuxTerminal({ tmux, ps: processes, show: async () => {}, wait: (ms) => new Promise((r) => setTimeout(r, ms)), installed: () => true, shell: "/bin/sh" });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = valueWaits(8000, 50);
const stage = async () => (await layoutOf(win)).view?.stage ?? null;
const sessionsOf = async (tmux: typeof win) => (await tmux(["list-sessions", "-F", "#{session_name}"]).catch(() => "")).split("\n").filter(Boolean);
const front = async (tmux: typeof win, pane: string) => (await tmux(["display", "-p", "-t", pane, "#{pane_current_command}"]).catch(() => "")).trim();
/** The stand-in app's log lines of `event` (src/core/log.ts, in its folder's logs/). */
const logged = (event: string) =>
  existsSync(join(dir, "logs"))
    ? readdirSync(join(dir, "logs"))
        .filter((f) => f.endsWith(".jsonl"))
        .flatMap((f) =>
          readFileSync(join(dir, "logs", f), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l)),
        )
        .filter((l) => l.event === event)
    : [];
const exited = () => logged("session_closed").filter((l) => l.how === "exited");
/** Words typed into a pane as you would: the keys, then Enter a moment after (the fake Codex takes keys all at once as a paste). */
async function typeIn(tmux: typeof win, pane: string, words: string) {
  await tmux(["send-keys", "-t", pane, "-l", words]);
  await wait(250);
  await tmux(["send-keys", "-t", pane, "Enter"]);
}

describe("a session Kiko opened quits by itself, for real", { skip: !TMUX && "tmux isn't installed" }, () => {
  before(async () => {
    mkdirSync(bin);
    if (["/usr/bin", "/bin"].some((d) => existsSync(join(d, "claude")) || existsSync(join(d, "codex")) || existsSync(join(d, "opencode")))) {
      throw new Error("a real agent sits next to node: not running these");
    }
    // Claude Code: quits on /exit (as `/exit` or Ctrl+D would end the real one). Node, so tmux says "node" is in front, not a shell.
    writeFileSync(
      join(bin, "claude"),
      `#!${process.execPath}\nprocess.stdout.write("FAKE CLAUDE in " + process.cwd().split("/").pop() + "\\n");\nrequire("node:readline").createInterface({ input: process.stdin }).on("line", (l) => l === "/exit" && process.exit(0));\n`,
      { mode: 0o755 },
    );
    // One that stops itself a moment after it starts (as Ctrl+Z would): its process stays, stopped.
    writeFileSync(
      join(bin, "stopper"),
      `#!${process.execPath}\nprocess.stdout.write("FAKE AGENT, stopping\\n");\nsetTimeout(() => process.kill(process.pid, "SIGTSTP"), 1500);\nsetInterval(() => {}, 1000);\n`,
      { mode: 0o755 },
    );
    // Codex and OpenCode: their fake TUIs, through links named for them (tmux and ps name a pane's program by its file).
    for (const [name, script] of [
      ["codex", FAKE_CODEX],
      ["opencode", FAKE_OPENCODE],
    ]) {
      const as = join(dir, "node-as", name);
      mkdirSync(dirname(as), { recursive: true });
      try {
        linkSync(process.execPath, as);
      } catch {
        symlinkSync(process.execPath, as);
      }
      writeFileSync(join(bin, name), `#!/bin/sh\nexec ${JSON.stringify(as)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
    }
    for (const p of ["pixie", "lacy", "dot", "oc", "mine", "loose", "paused", "zpaused"]) mkdirSync(join(dir, p));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ server: WIN, projects: [], claude: join(bin, "claude"), outside: false }));
    await openWindow(win, () => ({ argv: [process.execPath, "--no-warnings", APP, dir], discard() {} }), dir, { width: 120, height: 40 });
    await until(
      () => (existsSync(join(dir, "acts.log")) ? readFileSync(join(dir, "acts.log"), "utf8") : ""),
      (a) => a.includes('"started":true'),
      "the stand-in app",
    );
    await until(stage, (s) => s?.viewing === PAGE_ID, "Kiko's page in the stage");
  });
  after(() => {
    killServers();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A session opened as the app opens one (shown in the window, when it's open): its pane, once its program is in front. */
  async function open(tmux: typeof win, name: string, program: string): Promise<string> {
    let pane = "";
    await adapter(tmux).open!(join(dir, name), { program, args: [] }, (h) => (pane = h));
    assert.match(pane, /^%\d+$/);
    await until(
      () => front(tmux, pane),
      (f) => f === (program === "codex" || program === "opencode" ? program : "node"),
      `${name}'s ${program} in front`,
    );
    // Listed by the stand-in app (it looks every second), so its glue has seen it.
    await wait(1300);
    return pane;
  }

  test("Claude Code quits with /exit in the stage: its pane and tmux session gone (no shell left), Kiko's page in the stage, logged as exited", async () => {
    const pixie = await open(win, "pixie", "claude");
    assert.equal((await stage())?.id, pixie, "shown in the stage");
    await typeIn(win, pixie, "/exit");
    await until(stage, (s) => s?.viewing === PAGE_ID, "Kiko's page back in the stage", 5000);
    const layout = await layoutOf(win);
    assert.ok(!layout.panes.some((p) => p.id === pixie), "its pane gone");
    assert.ok(!(await sessionsOf(win)).includes("pixie"), "its tmux session gone");
    assert.ok(!layout.panes.some((p) => p.cwd.endsWith("/pixie")), "no shell left anywhere");
    await until(exited, (e) => e.some((l) => l.pane === pixie), "logged");
    assert.deepEqual(
      exited()
        .filter((l) => l.pane === pixie)
        .map((l) => [l.sessionId, l.how, l.shown]),
      [["pixie", "exited", true]],
      "once",
    );
  });

  test("Codex quits with /exit at home (another session shown): its tmux session closed quietly, the stage stays on the one shown", async () => {
    const lacy = await open(win, "lacy", "codex");
    const dot = await open(win, "dot", "claude");
    assert.equal((await stage())?.id, dot, "dot shown, lacy at home");
    await typeIn(win, lacy, "/exit");
    await until(
      () => sessionsOf(win),
      (s) => !s.includes("lacy"),
      "lacy's tmux session closed",
    );
    await wait(1500); // the stand-in's next look
    assert.equal((await stage())?.id, dot, "the stage as it was");
    assert.equal(await front(win, dot), "node", "dot runs on");
    await until(exited, (e) => e.some((l) => l.pane === lacy), "logged");
    assert.deepEqual(
      exited()
        .filter((l) => l.pane === lacy)
        .map((l) => [l.sessionId, l.shown]),
      [["lacy", false]],
    );
  });

  test("OpenCode ends on a signal in the stage (as a crash would): the same, Kiko's page in its place", async () => {
    const oc = await open(win, "oc", "opencode");
    assert.equal((await stage())?.id, oc);
    const shell = Number((await win(["display", "-p", "-t", oc, "#{pane_pid}"])).trim());
    const tui = (await processes()).find((p) => p.ppid === shell)?.pid;
    assert.ok(tui, "its TUI, a child of the pane's shell");
    process.kill(tui!, "SIGTERM");
    await until(stage, (s) => s?.viewing === PAGE_ID, "Kiko's page back in the stage", 5000);
    assert.ok(!(await sessionsOf(win)).includes("oc"));
    assert.ok(readFileSync(env.FAKE_OPENCODE_LOG, "utf8").includes("sigterm"));
  });

  test("a pane Kiko didn't open (a shell of yours, shown in the stage): claude quitting in it leaves the shell, and a command you start there, alone", async () => {
    const mine = (await win(["new-session", "-d", "-s", "mine", "-c", join(dir, "mine"), "-P", "-F", "#{pane_id}", "--", "/bin/sh"])).trim();
    assert.equal(await show(win, mine), "shown");
    await typeIn(win, mine, "claude");
    await until(
      () => front(win, mine),
      (f) => f === "node",
      "claude in front",
    );
    await wait(1300);
    await typeIn(win, mine, "/exit");
    await until(
      () => front(win, mine),
      (f) => /^-?(ba)?sh$/.test(f),
      "your shell back in front",
    );
    await typeIn(win, mine, "sleep 30");
    await until(
      () => front(win, mine),
      (f) => f === "sleep",
      "your command running",
    );
    await wait(2500); // two of the stand-in's looks
    assert.equal((await stage())?.id, mine, "still in the stage");
    assert.equal(await front(win, mine), "sleep", "your command runs on");
    assert.ok(!exited().some((l) => l.pane === mine), "nothing logged for it");
    await win(["kill-session", "-t", "=mine"]);
  });

  // Its program stopped, not ended: the login shell as before this change, never the pane ended
  // (bash's exec then ends a stopped job itself, as it always did; zsh's leaves it stopped).
  test("an agent only stopped in the stage (Ctrl+Z), in sh and in zsh: its pane and the login shell stay, the stage too", async () => {
    const paused = await open(win, "paused", "stopper");
    // zsh (without your rc files), as the app runs a zsh user's sessions: the same line after the program.
    const zpaused = (
      await win([
        "new-session",
        "-d",
        "-s",
        "zpaused",
        "-c",
        join(dir, "zpaused"),
        "-P",
        "-F",
        "#{pane_id}",
        "--",
        "/bin/zsh",
        "-f",
        "-i",
        "-c",
        `${LEAVE_TMUX}; stopper; ${afterProgram("/bin/zsh", TMUX!)}`,
      ])
    ).trim();
    assert.equal(await show(win, zpaused), "shown");
    const screen = (pane: string) => win(["capture-pane", "-p", "-t", pane]).catch(() => "");
    for (const pane of [paused, zpaused])
      await until(
        () => screen(pane),
        (s) => /stopped|suspended/i.test(s),
        `${pane}'s agent stopped`,
      );
    for (const pane of [paused, zpaused])
      await until(
        () => front(win, pane),
        (f) => /^-?(ba|z)?sh$/.test(f),
        `${pane}: the login shell in front`,
      );
    await wait(2500); // the stand-in's looks, and time for a wrong end
    const layout = await layoutOf(win);
    for (const pane of [paused, zpaused])
      assert.ok(
        layout.panes.some((p) => p.id === pane && !p.dead),
        `${pane} still there`,
      );
    assert.equal(layout.view?.stage?.id, zpaused, "still in the stage");
    assert.ok(!exited().some((l) => l.pane === paused || l.pane === zpaused));
    for (const name of ["paused", "zpaused"]) await win(["kill-session", "-t", `=${name}`]);
  });

  test("shown in a terminal of its own (no Kiko window): it's left in the login shell when the agent quits, as a terminal is, and what you type there runs", async () => {
    await bare(["new-session", "-d", "-s", "keep", "--", "/bin/sh", "-c", "exec sleep 600"]); // the server up
    const loose = await open(bare, "loose", "claude");
    await typeIn(bare, loose, "/exit");
    await until(
      () => front(bare, loose),
      (f) => /^-?(ba)?sh$/.test(f),
      "the login shell in front (macOS /bin/sh is bash)",
    );
    await typeIn(bare, loose, "sleep 30");
    await until(
      () => front(bare, loose),
      (f) => f === "sleep",
      "your command running",
    );
    assert.ok((await sessionsOf(bare)).includes("loose"), "its tmux session still there");
  });
});
