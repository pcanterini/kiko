// The tmux adapter (src/terminals/tmux/) on a fake tmux: a session's pane found by its process,
// never its title; everything checked again before a word or key goes in; copy mode left first;
// text sent literally, several lines as one bracketed paste, Enter on its own; new sessions in
// their own tmux session, shown in a window. The real tmux is in tests/live/terminals/tmux-live.test.ts.
import "../../setup.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { afterProgram, FORMAT, formatText, literal, notReady, pasteCheck, paneOf, parsePanes, tmuxTerminal, type Pane, type Runner } from "../../../src/terminals/tmux/index.ts";
import {
  attachCommand,
  BACK_TMUX,
  cleanEnv,
  inKiko,
  LEAVE_TMUX,
  NO_ANSWER,
  realServersRefused,
  tmuxRunner,
  tmuxArg,
  tmuxEnv,
  tmuxPath,
  tmuxFormatArg,
  userTmux,
  freeName,
  insideServer,
  envLaunch,
  parsePs,
  sessionEnv,
  sessionNameFor,
  sweepLaunches,
  whereInKiko,
  withoutTerminal,
  type Proc,
} from "../../../src/terminals/tmux/tmux.ts";
import { COMMAND } from "../../../src/core/name.ts";
import { shellWord } from "../../../src/core/shell.ts";
import { openers, reachableStart } from "../../../src/terminals/index.ts";
import type { Findable, Place, Terminal } from "../../../src/terminals/types.ts";

const pane = (fields: Partial<Pane> = {}): Pane => ({
  id: "%1",
  pid: 100,
  tty: "/dev/ttys001",
  inMode: false,
  dead: false,
  paste: true,
  role: "",
  session: "pixie",
  command: "claude",
  title: "✳ Upload bug",
  cwd: "/code/pixie",
  ...fields,
});
const proc = (pid: number, ppid: number, fields: Partial<Proc> = {}): Proc => ({ pid, ppid, pgid: pid, tpgid: pid, stat: "S+", tty: "ttys001", ...fields });
// A pane whose shell (100) started Claude Code (200): the usual one.
const SHELL = proc(100, 1, { tpgid: 200, stat: "Ss" });
const CLAUDE = proc(200, 100);

type State = {
  panes: Pane[];
  procs: Proc[];
  installed?: boolean;
  stuck?: boolean;
  noServer?: boolean;
  onWait?: () => void;
  showFails?: string;
  taken?: string[];
  /** Just before tmux checks the pane for the paste (if-shell): the pane changing at that moment. */
  onPaste?: () => void;
  /** What each pane shows (capture-pane). */
  screens?: Record<string, string>;
};

function fake(state: State, shell = "/bin/zsh") {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const buffers = new Map<string, string>();
  /** What reached each pane, as tmux pasted it. */
  const pasted: Array<{ pane: string; text: string; bracketed: boolean }> = [];
  const shown: Array<{ cwd: string; session: string }> = [];
  /** Keys tmux sent into a pane, once its check held (press). */
  const pressed: Array<{ pane: string; key: string }> = [];
  const runner: Runner = {
    async tmux(args, input) {
      calls.push({ args, input });
      if (state.noServer) throw new Error("no server running on /private/tmp/tmux-501/kiko");
      const target = args.includes("-t") ? args[args.indexOf("-t") + 1] : "";
      switch (args[0]) {
        case "list-panes":
          assert.deepEqual(args, ["list-panes", "-a", "-F", FORMAT]);
          return state.panes.map((p) => [p.id, p.pid, p.tty, p.inMode ? 1 : 0, p.dead ? 1 : 0, p.paste ? 1 : 0, p.role, p.session, p.command, p.title, p.cwd].join("\t")).join("\n");
        case "list-sessions":
          // `taken`: names another takes meanwhile, between listing and starting: not listed yet.
          return state.panes.map((p) => p.session).join("\n");
        case "load-buffer":
          buffers.set(args[args.indexOf("-b") + 1], input ?? "");
          return "";
        case "delete-buffer": {
          const name = args[args.indexOf("-b") + 1];
          if (!buffers.delete(name)) throw new Error(`unknown buffer: ${name}`);
          return "";
        }
        case "if-shell": {
          // As tmux does it: the pane's fields filled into the condition, then the paste or nothing.
          assert.deepEqual(args.slice(0, 4), ["if-shell", "-F", "-t", target]);
          state.onPaste?.();
          const p = state.panes.find((x) => x.id === target);
          const [cond, command] = args.slice(4);
          const pid = /#\{==:#\{pane_pid\},(\d+)\}/.exec(cond)?.[1];
          const front = /#\{==:#\{pane_current_command\},((?:[^#}]|#.)*)\}/.exec(cond)?.[1]?.replace(/#(.)/g, "$1");
          // An agent's list of sessions in front (its title): tmux's own regular expression, read as JavaScript's.
          const views = [...cond.matchAll(/#\{m\/ri:([^,]+),#\{pane_title\}\}/g)].map((m) => new RegExp(m[1], "i"));
          const ok = p && !p.dead && String(p.pid) === pid && p.command === front && (!cond.includes("bracket_paste_flag") || p.paste) && !views.some((re) => re.test(p.title ?? ""));
          const key = /^send-keys -t (%\d+) (\w+)$/.exec(command);
          if (key) {
            assert.equal(key[1], target);
            if (ok) pressed.push({ pane: target, key: key[2] });
            return "";
          }
          const m = /^paste-buffer (-p )?-d -b (kiko-[0-9a-f]{8}) -t (%\d+)$/.exec(command);
          assert.ok(m && m[3] === target, command);
          if (ok) {
            pasted.push({ pane: target, text: buffers.get(m[2])!, bracketed: Boolean(m[1]) });
            buffers.delete(m[2]);
          }
          return "";
        }
        case "capture-pane":
          assert.deepEqual(args, ["capture-pane", "-p", "-t", target]);
          return state.screens?.[target] ?? "";
        case "copy-mode":
          if (!state.stuck) for (const p of state.panes) if (p.id === target) p.inMode = false;
          return "";
        case "new-session": {
          const name = args[args.indexOf("-s") + 1];
          if (state.taken?.includes(name)) {
            state.taken = state.taken.filter((t) => t !== name);
            state.panes.push(pane({ id: "%9", session: name }));
            throw new Error(`duplicate session: ${name}`);
          }
          return "";
        }
        default:
          return "";
      }
    },
    ps: async () => state.procs,
    show: async (cwd, session) => {
      if (state.showFails) throw new Error(state.showFails);
      shown.push({ cwd, session });
    },
    wait: async () => state.onWait?.(),
    installed: () => state.installed ?? true,
    shell,
  };
  // What was sent into panes: everything but looking.
  const sent = () => calls.filter((c) => !["list-panes", "list-sessions", "capture-pane"].includes(c.args[0]));
  return { terminal: tmuxTerminal(runner), calls, sent, shown, pasted, buffers, pressed };
}

const session = (fields: Partial<Findable> = {}): Findable => ({ sessionId: "s1", cwd: "/code/pixie", kind: "interactive", desktop: false, titles: ["Upload bug"], pid: 200, ...fields });
const PLACE: Place = { via: "tmux", id: "%1", keys: true, pid: 200 };
// The part of tmux's paste check that keeps words out of a pane on Claude Code's agents list (src/terminals/views.ts).
const NOT_LIST = "#{?#{m/ri:^ *([0-9]+ awaiting input *· *)?claude agents *$,#{pane_title}},0,1}";

describe("which tmux: Kiko's own server, and yours", () => {
  test("a checkout runs yours (on PATH, else where Homebrew puts it) for its server; KIKO_TMUX_BIN names another; the environment as it is", () => {
    const dir = mkdtempSync(join(tmpdir(), "which-"));
    const other = join(dir, "tmux");
    writeFileSync(other, "#!/bin/sh\n", { mode: 0o755 });
    const was = process.env.KIKO_TMUX_BIN;
    try {
      delete process.env.KIKO_TMUX_BIN;
      assert.equal(tmuxPath(), userTmux());
      process.env.KIKO_TMUX_BIN = other;
      assert.equal(tmuxPath(), other);
      process.env.KIKO_TMUX_BIN = join(dir, "none");
      assert.equal(tmuxPath(), null, "named but not there: none, not yours instead");
      // TERMINFO_DIRS is only an installed copy's (its own tmux's terminfo).
      const env = { PATH: "/usr/bin", TERMINFO_DIRS: "/mine" };
      assert.equal(tmuxEnv(env), env);
    } finally {
      if (was === undefined) delete process.env.KIKO_TMUX_BIN;
      else process.env.KIKO_TMUX_BIN = was;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("under the test runner, never your own tmux servers (A3)", () => {
  test("this run's tmux sockets are in a folder of its own (tests/setup.ts), which is there", () => {
    assert.ok(process.env.TMUX_TMPDIR && existsSync(process.env.TMUX_TMPDIR));
    assert.notEqual(process.env.TMUX_TMPDIR, "/tmp");
    assert.equal(realServersRefused(cleanEnv()), null);
  });

  test("no TMUX_TMPDIR, or one that isn't there (tmux would use /tmp): refused, tmux never started", async () => {
    assert.match(realServersRefused({ PATH: "/usr/bin" }) ?? "", /no TMUX_TMPDIR/);
    assert.match(realServersRefused({ TMUX_TMPDIR: "/no/such/folder" }) ?? "", /isn't there/);
    assert.equal(realServersRefused({ PATH: "/usr/bin" }, false), null, "the app, not under a test: as ever");
    // A server name nobody uses, so even were it run, nothing of yours is touched.
    const run = tmuxRunner("kiko-a3-never", undefined, { PATH: "/usr/bin:/bin" });
    await assert.rejects(run(["list-sessions"]), /not running tmux/);
  });
});

describe("reading tmux and ps", () => {
  test("list-panes: each pane's id, first process, terminal, mode, paste and folder (a tab in it kept)", () => {
    const out = "%1\t100\t/dev/ttys001\t0\t0\t1\t\tpixie\tclaude\t✳ Upload bug\t/code/pixie\n%12\t300\t/dev/ttys004\t1\t0\t0\tlist\tweird\t2.1.312\t\t/code/a\tb\nnot a pane\n";
    assert.deepEqual(parsePanes(out), [
      pane(),
      pane({ id: "%12", pid: 300, tty: "/dev/ttys004", inMode: true, paste: false, role: "list", session: "weird", command: "2.1.312", title: "", cwd: "/code/a\tb" }),
    ]);
  });
  test("ps: pid, parent, group, the terminal's foreground group, state, terminal", () => {
    const out = "    1     0     1     0 Ss   ??\n  200   100   200   200 S+   ttys001\n\n";
    assert.deepEqual(parsePs(out), [proc(1, 0, { tpgid: 0, stat: "Ss", tty: "??" }), CLAUDE]);
  });
});

describe("paneOf: the pane a process runs in", () => {
  const panes = [pane(), pane({ id: "%2", pid: 400, tty: "/dev/ttys002", session: "lacy" })];
  test("the pane's first process itself (`kiko claude` runs Claude Code directly)", () => {
    assert.equal(paneOf(100, panes, [SHELL])?.id, "%1");
  });
  test("a descendant: the shell's child, or further down (sh -c around it)", () => {
    const procs = [SHELL, proc(150, 100), proc(200, 150), proc(400, 1), proc(500, 400)];
    assert.equal(paneOf(200, panes, procs)?.id, "%1");
    assert.equal(paneOf(500, panes, procs)?.id, "%2");
  });
  test("in no pane: a terminal outside tmux, or one of the user's own tmux servers", () => {
    assert.equal(paneOf(700, panes, [proc(650, 1), proc(700, 650)]), null);
  });
  test("a dead pane doesn't count, and a loop in the parents ends", () => {
    assert.equal(paneOf(200, [pane({ dead: true })], [SHELL, CLAUDE]), null);
    assert.equal(paneOf(5, panes, [proc(5, 6), proc(6, 5)]), null);
  });
});

describe("notReady: the session's process can take keys in its pane", () => {
  test("alive, in the pane, on its terminal, in front: ready", () => {
    assert.equal(notReady(200, pane(), [SHELL, CLAUDE]), null);
  });
  test("every way it can't, with why", () => {
    assert.equal(notReady(undefined, pane(), [SHELL, CLAUDE]), "I don't know its process");
    assert.equal(notReady(200, pane(), [SHELL]), "its process has ended");
    assert.equal(notReady(200, pane({ pid: 999 }), [SHELL, CLAUDE]), "it isn't running in that tmux pane any more");
    assert.equal(notReady(200, pane({ tty: "/dev/ttys009" }), [SHELL, CLAUDE]), "it isn't on that pane's terminal");
    assert.equal(notReady(200, pane(), [SHELL, proc(200, 100, { stat: "T", tpgid: 100 })]), "it's suspended in its pane");
    assert.equal(notReady(200, pane(), [SHELL, proc(200, 100, { tpgid: 300 })]), "something else is in front of it in its pane");
  });
});

describe("find: by process, never by title", () => {
  test("a session whose process runs in a pane gets that pane, whatever its title", async () => {
    const { terminal } = fake({ panes: [pane()], procs: [SHELL, CLAUDE] });
    const found = await terminal.find(Promise.resolve([session({ titles: ["nothing like the pane"] })]));
    assert.deepEqual(found.get("s1"), { place: PLACE, mapping: "process" });
  });
  test("no process, a desktop or background session, or one in no pane: not found here (Ghostty may)", async () => {
    const { terminal } = fake({ panes: [pane()], procs: [SHELL, CLAUDE, proc(800, 1)] });
    const found = await terminal.find(
      Promise.resolve([
        session({ sessionId: "nopid", pid: undefined }),
        session({ sessionId: "desk", desktop: true }),
        session({ sessionId: "bg", kind: "background" }),
        session({ sessionId: "outside", pid: 800 }),
      ]),
    );
    assert.equal(found.size, 0);
  });
  test("never Kiko's own panes: a claude whose ancestry reaches the window's list isn't found there, nor typed into", async () => {
    // The list pane's first process (the app, 100) started a claude (200): it's in no session's pane.
    const { terminal, sent } = fake({ panes: [pane({ role: "list", session: "_kiko" })], procs: [SHELL, CLAUDE] });
    assert.equal((await terminal.find(Promise.resolve([session()]))).size, 0);
    assert.deepEqual(await terminal.type(PLACE, "hello"), { sent: false, why: "that's Kiko's own pane, not a session's" });
    assert.deepEqual(await terminal.key!(PLACE, "escape"), { sent: false, why: "that's Kiko's own pane, not a session's" });
    assert.deepEqual(sent(), []);
  });
  test("two sessions in one pane (one started inside the other): ambiguous, no place", async () => {
    const { terminal } = fake({ panes: [pane()], procs: [SHELL, CLAUDE, proc(300, 200)] });
    const found = await terminal.find(Promise.resolve([session(), session({ sessionId: "s2", pid: 300 })]));
    assert.deepEqual(found.get("s1"), { place: null, mapping: "ambiguous" });
    assert.deepEqual(found.get("s2"), { place: null, mapping: "ambiguous" });
  });
  test("tmux not installed, or its server not running: nothing, and no error", async () => {
    for (const state of [{ installed: false }, { noServer: true }]) {
      const { terminal } = fake({ panes: [pane()], procs: [SHELL, CLAUDE], ...state });
      assert.equal((await terminal.find(Promise.resolve([session()]))).size, 0);
    }
  });
});

describe("type: checked, then literally, then Enter", () => {
  test("one line: through a buffer of its own (stdin, never argv), pasted only if the pane is as checked, a moment, then Enter", async () => {
    let waited = false;
    const { terminal, sent, pasted, buffers } = fake({ panes: [pane()], procs: [SHELL, CLAUDE], onWait: () => (waited = true) });
    const text = "-n fix the 'login' bug; rm -rf $HOME #{pane_id} #(touch x)";
    assert.deepEqual(await terminal.type(PLACE, text), { sent: true });
    assert.ok(waited);
    const [load, check, cleanup, enter] = sent();
    assert.equal(load.args[0], "load-buffer");
    assert.equal(load.input, text);
    const buffer = load.args[load.args.indexOf("-b") + 1];
    assert.deepEqual(check.args, ["if-shell", "-F", "-t", "%1", `#{&&:#{&&:#{==:#{pane_pid},100},#{==:#{pane_current_command},claude}},${NOT_LIST}}`, `paste-buffer -d -b ${buffer} -t %1`]);
    assert.deepEqual(cleanup.args, ["delete-buffer", "-b", buffer], "gone already: it was pasted");
    assert.deepEqual(enter.args, ["send-keys", "-t", "%1", "Enter"]);
    assert.deepEqual(pasted, [{ pane: "%1", text, bracketed: false }]);
    assert.equal(buffers.size, 0);
    for (const c of sent()) assert.ok(!c.args.join(" ").includes("login"), `the words on a command line: ${c.args.join(" ")}`);
  });
  test("several lines: one bracketed paste, only while the pane still asks for one, then Enter", async () => {
    const { terminal, sent, pasted } = fake({ panes: [pane()], procs: [SHELL, CLAUDE] });
    assert.deepEqual(await terminal.type(PLACE, "first line\r\nsecond line"), { sent: true });
    const [load, check, , enter] = sent();
    assert.equal(load.input, "first line\nsecond line");
    const buffer = load.args[load.args.indexOf("-b") + 1];
    assert.match(buffer, /^kiko-/);
    assert.deepEqual(check.args, [
      "if-shell",
      "-F",
      "-t",
      "%1",
      `#{&&:#{bracket_paste_flag},#{&&:#{&&:#{==:#{pane_pid},100},#{==:#{pane_current_command},claude}},${NOT_LIST}}}`,
      `paste-buffer -p -d -b ${buffer} -t %1`,
    ]);
    assert.deepEqual(enter.args, ["send-keys", "-t", "%1", "Enter"]);
    assert.deepEqual(pasted, [{ pane: "%1", text: "first line\nsecond line", bracketed: true }]);
  });
  test("Claude Code quits between the check and the paste (a shell in front, no bracketed paste): nothing goes in, no Enter", async () => {
    const state: State = { panes: [pane()], procs: [SHELL, CLAUDE] };
    state.onPaste = () => (state.panes = [pane({ paste: false })]);
    const { terminal, sent, pasted, buffers } = fake(state);
    const typed = await terminal.type(PLACE, "make clean\nmake");
    assert.deepEqual(typed, { sent: false, why: "its pane changed just as I typed, so nothing went in" });
    assert.deepEqual(pasted, []);
    assert.equal(buffers.size, 0, "the buffer deleted");
    assert.ok(!sent().some((c) => c.args[0] === "send-keys"));
  });
  test("Claude Code quits between the check and the paste in a voice-opened pane (claude; exec $SHELL: the first process the same, the shell in front): nothing goes in", async () => {
    const state: State = { panes: [pane({ command: "2.1.312" })], procs: [SHELL, CLAUDE] };
    state.onPaste = () => (state.panes[0].command = "zsh");
    const { terminal, pasted } = fake(state);
    const typed = await terminal.type(PLACE, "hello");
    assert.deepEqual(typed, { sent: false, why: "its pane changed just as I typed, so nothing went in" });
    assert.deepEqual(pasted, []);
  });
  test("a program's name is itself inside tmux's check: # , } escaped", () => {
    assert.equal(formatText("a#b,c}d"), "a##b#,c#}d");
    assert.equal(pasteCheck(pane({ command: "x,y" }), false), `#{&&:#{&&:#{==:#{pane_pid},100},#{==:#{pane_current_command},x#,y}},${NOT_LIST}}`);
  });
  test("the pane's program replaced between the check and the paste: nothing goes in", async () => {
    const state: State = { panes: [pane()], procs: [SHELL, CLAUDE] };
    state.onPaste = () => (state.panes = [pane({ pid: 555 })]);
    const { terminal, pasted } = fake(state);
    assert.equal((await terminal.type(PLACE, "hello")).sent, false);
    assert.deepEqual(pasted, []);
  });
  test("several lines where nothing asked for bracketed paste: one line, so no line break sends early", async () => {
    const { terminal, pasted } = fake({ panes: [pane({ paste: false })], procs: [SHELL, CLAUDE] });
    await terminal.type(PLACE, "first\n  second");
    assert.deepEqual(pasted, [{ pane: "%1", text: "first second", bracketed: false }]);
  });
  test("one long line (a dictation over 512 bytes): one bracketed paste while the pane asks for one, typed where it doesn't", async () => {
    const long = "word ".repeat(220).trim();
    const asks = fake({ panes: [pane()], procs: [SHELL, CLAUDE] });
    await asks.terminal.type(PLACE, long);
    assert.deepEqual(asks.pasted, [{ pane: "%1", text: long, bracketed: true }]);
    const doesnt = fake({ panes: [pane({ paste: false })], procs: [SHELL, CLAUDE] });
    await doesnt.terminal.type(PLACE, long);
    assert.deepEqual(doesnt.pasted, [{ pane: "%1", text: long, bracketed: false }]);
    const short = fake({ panes: [pane()], procs: [SHELL, CLAUDE] });
    await short.terminal.type(PLACE, "word ".repeat(100).trim());
    assert.equal(short.pasted[0].bracketed, false);
  });
  test("control characters never go in: no Escape sequences smuggled in the words", () => {
    assert.equal(literal("hi\u001b[2J there\u0007\ttab\r\nnext"), "hi[2J there tab\nnext");
  });
  test("scrolled back (copy mode): brought back to the bottom first, then typed", async () => {
    const { terminal, sent } = fake({ panes: [pane({ inMode: true })], procs: [SHELL, CLAUDE] });
    assert.deepEqual(await terminal.type(PLACE, "hello"), { sent: true });
    assert.deepEqual(
      sent().map((c) => c.args[0]),
      ["copy-mode", "load-buffer", "if-shell", "delete-buffer", "send-keys"],
    );
    assert.deepEqual(sent()[0].args, ["copy-mode", "-q", "-t", "%1"]);
  });
  test("a mode that won't leave: refused, nothing typed", async () => {
    const { terminal, sent } = fake({ panes: [pane({ inMode: true })], procs: [SHELL, CLAUDE], stuck: true });
    const typed = await terminal.type(PLACE, "hello");
    assert.equal(typed.sent, false);
    assert.deepEqual(
      sent().map((c) => c.args[0]),
      ["copy-mode"],
    );
  });
  test("the pane changed since it was found: refused with why, nothing typed", async () => {
    const cases: Array<[State, string]> = [
      [{ panes: [], procs: [SHELL, CLAUDE] }, "its tmux pane has closed"],
      [{ panes: [pane({ dead: true })], procs: [SHELL, CLAUDE] }, "its tmux pane has closed"],
      [{ panes: [pane({ pid: 555 })], procs: [proc(555, 1), CLAUDE] }, "it isn't running in that tmux pane any more"],
      [{ panes: [pane()], procs: [SHELL] }, "its process has ended"],
      [{ panes: [pane()], procs: [SHELL, proc(200, 100, { stat: "T", tpgid: 100 })] }, "it's suspended in its pane"],
      [{ panes: [pane()], procs: [proc(100, 1), proc(200, 100, { tpgid: 100 })] }, "something else is in front of it in its pane"],
    ];
    for (const [state, why] of cases) {
      const { terminal, sent } = fake(state);
      assert.deepEqual(await terminal.type(PLACE, "hello"), { sent: false, why });
      assert.deepEqual(sent(), [], why);
    }
  });
  test("tmux refusing the keys themselves: not sent, with what it said, never an error thrown", async () => {
    const failing = tmuxTerminal({
      tmux: async (args) => {
        if (args[0] === "send-keys" || args[0] === "if-shell") throw new Error("can't find pane: %1");
        return args[0] === "list-panes" ? "%1\t100\t/dev/ttys001\t0\t0\t1\t\tpixie\tclaude\t✳ Upload bug\t/code/pixie" : "";
      },
      ps: async () => [SHELL, CLAUDE],
      show: async () => {},
      wait: async () => {},
      installed: () => true,
      shell: "/bin/zsh",
    });
    assert.deepEqual(await failing.type(PLACE, "hello"), { sent: false, why: "tmux didn't take it", error: "can't find pane: %1" });
    assert.deepEqual(await failing.key!(PLACE, "escape"), { sent: false, why: "tmux didn't take it", error: "can't find pane: %1" });
  });
  test("tmux not answering: refused", async () => {
    const { terminal } = fake({ panes: [pane()], procs: [SHELL, CLAUDE], noServer: true });
    assert.deepEqual(await terminal.type(PLACE, "hello"), { sent: false, why: "its tmux pane has closed" });
  });
  test("tmux hanging (killed after a while, tmuxRunner): every step refused with why, never left waiting", async () => {
    for (const hangs of ["list-panes", "load-buffer", "if-shell", "send-keys"]) {
      const slow = tmuxTerminal({
        tmux: async (args) => {
          if (args[0] === hangs) throw new Error(NO_ANSWER);
          if (args[0] === "delete-buffer") throw new Error("unknown buffer");
          return args[0] === "list-panes" ? "%1\t100\t/dev/ttys001\t0\t0\t1\t\tpixie\tclaude\t✳ Upload bug\t/code/pixie" : "";
        },
        ps: async () => [SHELL, CLAUDE],
        show: async () => {},
        wait: async () => {},
        installed: () => true,
        shell: "/bin/zsh",
      });
      assert.deepEqual(await slow.type(PLACE, "hello"), { sent: false, why: "tmux didn't answer" }, hangs);
    }
  });
  test("it changed between the words and Enter: no Enter, and why", async () => {
    const state: State = { panes: [pane()], procs: [SHELL, CLAUDE] };
    state.onWait = () => (state.procs = [SHELL]);
    const { terminal, sent } = fake(state);
    const typed = await terminal.type(PLACE, "hello");
    assert.deepEqual(typed, { sent: false, why: "its process has ended, so I typed it but didn't send it" });
    assert.deepEqual(
      sent().map((c) => c.args[0]),
      ["load-buffer", "if-shell", "delete-buffer"],
    );
  });
});

// A session parked with ← (Claude Code 2.1.312+): its turns move into a background job, and its
// terminal, the same process in the same pane, shows Claude Code's agents list, titled "claude
// agents" (or "1 awaiting input · claude agents"). Found by its process, its pane looked right, but
// what's typed there starts a new session or replies to whichever job is picked. Ghostty refused
// such a window since the routing fixes (terminals.test.ts); tmux reads the pane's title the same way.
describe("a parked session: its pane on Claude Code's agents list is never typed into", () => {
  const LISTS = ["claude agents", "1 awaiting input · claude agents", "3 awaiting input · claude agents", "  Claude Agents "];
  test("found by its process, but its pane shows the agents list: 'agents', nothing to type into", async () => {
    for (const title of LISTS) {
      const { terminal } = fake({ panes: [pane({ title })], procs: [SHELL, CLAUDE] });
      assert.deepEqual((await terminal.find(Promise.resolve([session()]))).get("s1"), { place: null, mapping: "agents" }, title);
    }
  });
  test("opened there again (its title its name), or a name that only looks like it: found by its process", async () => {
    for (const title of ["◑ Upload bug", "✳ claude agents rework", "claude agents list notes", ""]) {
      const { terminal } = fake({ panes: [pane({ title })], procs: [SHELL, CLAUDE] });
      assert.deepEqual((await terminal.find(Promise.resolve([session()]))).get("s1"), { place: PLACE, mapping: "process" }, title);
    }
  });
  test("parked since it was found: words and keys refused with why, nothing sent", async () => {
    const { terminal, sent, pasted } = fake({ panes: [pane({ title: "1 awaiting input · claude agents" })], procs: [SHELL, CLAUDE] });
    const why = "its pane is showing Claude Code's agents list";
    assert.deepEqual(await terminal.type(PLACE, "run the tests"), { sent: false, why });
    assert.deepEqual(await terminal.key!(PLACE, "escape"), { sent: false, why });
    assert.deepEqual(sent(), []);
    assert.deepEqual(pasted, []);
    assert.equal(notReady(200, pane({ title: "claude agents" }), [SHELL, CLAUDE]), why);
  });
  test("parked between the check and the paste: tmux's own check holds it back, no Enter", async () => {
    const state: State = { panes: [pane()], procs: [SHELL, CLAUDE] };
    state.onPaste = () => (state.panes[0].title = "claude agents");
    const { terminal, sent, pasted, buffers } = fake(state);
    assert.deepEqual(await terminal.type(PLACE, "run the tests"), { sent: false, why: "its pane changed just as I typed, so nothing went in" });
    assert.deepEqual(pasted, []);
    assert.equal(buffers.size, 0);
    assert.ok(!sent().some((c) => c.args[0] === "send-keys"));
  });
  test("parked between the words and Enter: typed, but not sent", async () => {
    const state: State = { panes: [pane()], procs: [SHELL, CLAUDE] };
    state.onWait = () => (state.panes[0].title = "claude agents");
    const { terminal, sent } = fake(state);
    assert.deepEqual(await terminal.type(PLACE, "run the tests"), { sent: false, why: "its pane is showing Claude Code's agents list, so I typed it but didn't send it" });
    assert.ok(!sent().some((c) => c.args[0] === "send-keys"));
  });
  test("a Codex session found by its program in a pane titled so: no place either (whichever agent)", async () => {
    const CODEX = proc(300, 100);
    const { terminal } = fake({ panes: [pane({ command: "codex", title: "claude agents" })], procs: [proc(100, 1, { tpgid: 300, stat: "Ss" }), CODEX] });
    const found = await terminal.find(Promise.resolve([session({ pid: undefined, program: "codex" })]));
    assert.deepEqual(found.get("s1"), { place: null, mapping: "agents" });
  });
});

describe("key", () => {
  test("Escape by tmux's name for it, checked first", async () => {
    const { terminal, sent } = fake({ panes: [pane({ inMode: true })], procs: [SHELL, CLAUDE] });
    assert.deepEqual(await terminal.key!(PLACE, "escape"), { sent: true });
    assert.deepEqual(
      sent().map((c) => c.args),
      [
        ["copy-mode", "-q", "-t", "%1"],
        ["send-keys", "-t", "%1", "Escape"],
      ],
    );
  });
  test("a key it doesn't know, or a pane that changed: not pressed", async () => {
    const { terminal, sent } = fake({ panes: [pane()], procs: [SHELL] });
    assert.equal((await terminal.key!(PLACE, "f13")).sent, false);
    assert.deepEqual(await terminal.key!(PLACE, "escape"), { sent: false, why: "its process has ended" });
    assert.deepEqual(sent(), []);
  });
  test("Shift+Tab (Claude Code's next permission mode: core/block-override.ts) as tmux's BTab, with the same checks", async () => {
    const { terminal, sent } = fake({ panes: [pane()], procs: [SHELL, CLAUDE] });
    assert.deepEqual(await terminal.key!(PLACE, "shift+tab"), { sent: true });
    assert.deepEqual(
      sent().map((c) => c.args),
      [["send-keys", "-t", "%1", "BTab"]],
    );
    const gone = fake({ panes: [pane()], procs: [SHELL] });
    assert.deepEqual(await gone.terminal.key!(PLACE, "shift+tab"), { sent: false, why: "its process has ended" });
    assert.deepEqual(gone.sent(), [], "never into a pane whose program isn't the session's");
    const suspended = fake({ panes: [pane()], procs: [SHELL, proc(200, 100, { stat: "T", tpgid: 100 })] });
    assert.deepEqual(await suspended.terminal.key!(PLACE, "shift+tab"), { sent: false, why: "it's suspended in its pane" }, "nor one suspended");
    assert.deepEqual(suspended.sent(), []);
  });
});

describe("screen and press: a pane it opened, still starting (Claude Code's trust question)", () => {
  // The pane Kiko opened: its login shell (100) running claude, which has no session yet.
  const OPENED = pane({ id: "%7", pid: 100, command: "2.1.312", session: "dozer" });
  test("screen: what the pane shows; null for a pane that's gone, dead, or the window's own", async () => {
    const { terminal } = fake({ panes: [OPENED, pane({ id: "%8", dead: true }), pane({ id: "%9", role: "list" })], procs: [], screens: { "%7": "Accessing workspace:", "%8": "x", "%9": "y" } });
    assert.equal(await terminal.screen!("%7"), "Accessing workspace:");
    assert.equal(await terminal.screen!("%8"), null);
    assert.equal(await terminal.screen!("%9"), null);
    assert.equal(await terminal.screen!("%5"), null);
    assert.equal(await terminal.screen!("pixie; kill-server"), null, "only a pane's id");
  });
  test("press: by tmux's name, only while that pane's first process and program are the ones checked", async () => {
    const { terminal, pressed, sent } = fake({ panes: [OPENED], procs: [] });
    assert.deepEqual(await terminal.press!("%7", "down"), { sent: true });
    assert.deepEqual(await terminal.press!("%7", "enter"), { sent: true });
    assert.deepEqual(pressed, [
      { pane: "%7", key: "Down" },
      { pane: "%7", key: "Enter" },
    ]);
    assert.ok(
      sent().every((c) => c.args[0] === "if-shell" && c.args[3] === "%7"),
      "never a bare send-keys",
    );
  });
  test("press: never into the shell (the program ended), a dead pane, the window's own, or a key it doesn't know", async () => {
    const shell = fake({ panes: [{ ...OPENED, command: "zsh" }], procs: [] });
    assert.deepEqual(await shell.terminal.press!("%7", "enter"), { sent: false, why: "its program has ended" });
    const dead = fake({ panes: [{ ...OPENED, dead: true }], procs: [] });
    assert.deepEqual(await dead.terminal.press!("%7", "enter"), { sent: false, why: "its tmux pane has closed" });
    const gone = fake({ panes: [], procs: [] });
    assert.equal((await gone.terminal.press!("%7", "enter")).sent, false);
    const list = fake({ panes: [{ ...OPENED, role: "list" }], procs: [] });
    assert.equal((await list.terminal.press!("%7", "enter")).sent, false);
    assert.equal((await list.terminal.press!("%7", "f13")).sent, false);
    for (const f of [shell, dead, gone, list]) assert.deepEqual(f.pressed, []);
  });
  test("press: the pane's program changes as the key goes: tmux's check holds it back", async () => {
    const state = { panes: [{ ...OPENED }], procs: [], onPaste: () => (state.panes[0].command = "zsh") };
    const { terminal, pressed } = fake(state);
    await terminal.press!("%7", "enter");
    assert.deepEqual(pressed, []);
  });
  test("press: scrolled back, brought to the bottom first", async () => {
    const { terminal, pressed, sent } = fake({ panes: [{ ...OPENED, inMode: true }], procs: [] });
    assert.deepEqual(await terminal.press!("%7", "down"), { sent: true });
    assert.deepEqual(sent()[0].args, ["copy-mode", "-q", "-t", "%7"]);
    assert.deepEqual(pressed, [{ pane: "%7", key: "Down" }]);
  });
});

describe("open: a tmux session of its own, shown in a window", () => {
  const COMMAND = { program: "claude", args: ["--name", "Bug hunt", "Fix the login bug."] };
  test("named for its folder, in it, the command in the user's login shell (left in it after, unless it has been in the Kiko window), then shown", async () => {
    const { terminal, sent, shown } = fake({ panes: [], procs: [] });
    assert.equal(await terminal.open!("/code/pixie", COMMAND), undefined);
    assert.deepEqual(sent()[0].args, [
      "new-session",
      "-d",
      "-s",
      "pixie",
      "-c",
      "/code/pixie",
      "-P",
      "-F",
      "#{pane_id}",
      "--",
      "/bin/zsh",
      "-l",
      "-i",
      "-c",
      `${LEAVE_TMUX}; claude --name 'Bug hunt' 'Fix the login bug.'; ${afterProgram("/bin/zsh", tmuxPath() ?? "tmux")}`,
    ]);
    assert.deepEqual(shown, [{ cwd: "/code/pixie", session: "pixie" }]);
  });
  test("after its program: TMUX back, then the shell only for a pane never in the Kiko window (asked of the pane's own server, by the socket in TMUX) or a program only stopped", () => {
    const line = afterProgram("/opt/homebrew/bin/fish", "/opt/homebrew/bin/tmux");
    assert.equal(
      line,
      `program_status=$?; ${BACK_TMUX}; case "$(kill -l "$program_status" 2>/dev/null)" in TSTP|STOP|TTIN|TTOU) exec /opt/homebrew/bin/fish -l;; esac; ` +
        `[ -n "$(/opt/homebrew/bin/tmux -S "\${TMUX%%,*}" display -p -t "$TMUX_PANE" '#{@kiko-home}' 2>/dev/null)" ] || exec /opt/homebrew/bin/fish -l`,
    );
    // What sh and zsh make of it after a program's status, with a stand-in tmux saying what the pane's home is (or failing): the shell only when there's none.
    const dir = mkdtempSync(join(tmpdir(), "after-"));
    const fakeTmux = join(dir, "tmux");
    writeFileSync(fakeTmux, `#!/bin/sh\necho "$*" >> ${shellWord(join(dir, "args"))}\n[ -n "$HOME_IS" ] && echo "$HOME_IS"\nexit $FAIL\n`, { mode: 0o755 });
    const tstp = 128 + osConstants.signals.SIGTSTP;
    for (const sh of [["/bin/sh"], ["/bin/zsh", "-f"]]) {
      const run = (status: number, env: Record<string, string>) =>
        execFileSync(sh[0], [...sh.slice(1), "-c", `(exit ${status}); ${afterProgram("/bin/echo", fakeTmux).replace(/exec \/bin\/echo -l/g, "exec /bin/echo kept")}`], {
          env: { PATH: "/usr/bin:/bin", KIKO_KEPT_TMUX: "/tmp/tmux-501/kiko,123,0", KIKO_KEPT_TMUX_PANE: "%7", FAIL: "0", ...env },
        }).toString();
      assert.equal(run(0, { HOME_IS: "@3" }), "", `${sh[0]}: been in the window, quit: the shell ends`);
      assert.equal(run(143, { HOME_IS: "@3" }), "", `${sh[0]}: been in the window, killed (a crash): the shell ends`);
      assert.equal(run(tstp, { HOME_IS: "@3" }), "kept\n", `${sh[0]}: only stopped (Ctrl+Z, ${tstp}): its process is there, the login shell`);
      assert.equal(run(0, { HOME_IS: "" }), "kept\n", `${sh[0]}: never in it: the login shell`);
      assert.equal(run(0, { HOME_IS: "", FAIL: "1" }), "kept\n", `${sh[0]}: tmux failing: the login shell`);
    }
    assert.match(execFileSync("/bin/cat", [join(dir, "args")]).toString(), /^-S \/tmp\/tmux-501\/kiko display -p -t %7 #\{@kiko-home\}$/m);
    rmSync(dir, { recursive: true, force: true });
  });
  test("a login shell that doesn't read POSIX quotes (fish): zsh runs the line, then becomes theirs", async () => {
    const prompt = "it's done'; rm -rf ~; echo '";
    for (const [shell, runner] of [
      ["/opt/homebrew/bin/fish", "/bin/zsh"],
      ["/usr/local/bin/nu", "/bin/zsh"],
      ["/bin/bash", "/bin/bash"],
      ["/bin/zsh", "/bin/zsh"],
    ]) {
      const { terminal, sent } = fake({ panes: [], procs: [] }, shell);
      await terminal.open!("/code/pixie", { program: "claude", args: ["--name", prompt] });
      const argv = sent()[0].args;
      assert.deepEqual(argv.slice(argv.indexOf("--") + 1, -1), [runner, "-l", "-i", "-c"], shell);
      assert.equal(argv.at(-1), `${LEAVE_TMUX}; claude --name ${shellWord(prompt)}; ${afterProgram(shell, tmuxPath() ?? "tmux")}`);
      // What the POSIX shell makes of it: the prompt, one word, as said.
      const words = execFileSync("/bin/sh", ["-c", `printf '%s\\n' ${shellWord(prompt)}`]).toString();
      assert.equal(words, `${prompt}\n`);
    }
  });
  test("a name taken (here, or meanwhile by another): the next free one", async () => {
    const { terminal, sent, shown } = fake({ panes: [pane({ session: "pixie" })], procs: [], taken: ["pixie-2"] });
    await terminal.open!("/code/pixie", COMMAND);
    assert.deepEqual(
      sent()
        .filter((c) => c.args[0] === "new-session")
        .map((c) => c.args[3]),
      ["pixie-2", "pixie-3"],
    );
    assert.deepEqual(shown, [{ cwd: "/code/pixie", session: "pixie-3" }]);
  });
  test("started but not shown: a note to say, not an error (it runs, and can be typed into)", async () => {
    const { terminal } = fake({ panes: [], procs: [], showFails: "osascript: no Ghostty" });
    assert.equal(await terminal.open!("/code/pixie", COMMAND), "I couldn't show its window: it's running in Kiko's tmux as pixie");
  });
});

describe("names, words and the environment", () => {
  test("a session's name from its folder: only letters, digits, - and _", () => {
    assert.equal(sessionNameFor("/Users/me/git/pixie"), "pixie");
    assert.equal(sessionNameFor("/x/my.app: v2"), "my-app-v2");
    assert.equal(sessionNameFor("/"), "claude");
    assert.equal(freeName("pixie", ["pixie", "pixie-2"]), "pixie-3");
  });
  test('a word ending in ";" kept for tmux (else the end of a command): "\\;", which tmux reads back as ";"', () => {
    assert.deepEqual(["fix x;", ";", "a\\;", "plain", "a;b"].map(tmuxArg), ["fix x\\;", "\\;", "a\\\\;", "plain", "a;b"]);
  });
  test('a folder for -c, which tmux reads as a format: every "#" doubled, and a final ";" kept', () => {
    assert.deepEqual(["/code/C#Samples", "/a/#(touch x)", "/semi#;", "/plain"].map(tmuxFormatArg), ["/code/C##Samples", "/a/##(touch x)", "/semi##\\;", "/plain"]);
  });
  test("quoted for the shell only when needed; attaching by the exact name", () => {
    assert.equal(shellWord("--name"), "--name");
    assert.equal(shellWord("it's"), `'it'\\''s'`);
    assert.deepEqual(["=pixie", "~", "%1", "a=b", ""].map(shellWord), ["'=pixie'", "'~'", "'%1'", "a=b", "''"]);
    // zsh (the Mac's login shell) would make =pixie a command's path, or fail: quoted, it's the word.
    const words = ["-t", "=pixie", "=_kiko", "~x", "%1"].map(shellWord).join(" ");
    assert.equal(execFileSync("/bin/zsh", ["-f", "-c", `printf '%s\\n' ${words}`]).toString(), "-t\n=pixie\n=_kiko\n~x\n%1\n");
    assert.match(attachCommand("pixie"), / -L kiko-dev attach-session -t '=pixie'$/);
  });
  test("inside Kiko's own tmux, or another one", () => {
    assert.equal(insideServer("/private/tmp/tmux-501/kiko-dev,123,0"), true, "a checkout's: Kiko Dev's server");
    assert.equal(insideServer("/private/tmp/tmux-501/kiko,123,0"), false, "the release's is another");
    assert.equal(insideServer("/private/tmp/tmux-501/default,123,0"), false);
    assert.equal(insideServer(undefined), false);
    // A session's own program has no TMUX (LEAVE_TMUX), only what it said, in KIKO_KEPT_TMUX.
    assert.equal(inKiko({ TMUX: "/private/tmp/tmux-501/kiko,123,0" }, "kiko"), "pane");
    assert.equal(inKiko({ KIKO_KEPT_TMUX: "/private/tmp/tmux-501/kiko,123,0" }, "kiko"), "session");
    assert.equal(inKiko({ TMUX: "/private/tmp/tmux-501/default,1,0", KIKO_KEPT_TMUX: "/private/tmp/tmux-501/kiko,123,0" }, "kiko"), null, "in another tmux started from it: that one's");
    assert.equal(inKiko({}, "kiko"), null);
  });
  test("inside only when one of the server's panes is this terminal: a TMUX passed on to a terminal app opened from a pane is stale", async () => {
    const PANE = { TMUX: "/private/tmp/tmux-501/kiko,123,0", TMUX_PANE: "%86" };
    const SESSION = { KIKO_KEPT_TMUX: "/private/tmp/tmux-501/kiko,123,0" };
    const asked: string[][] = [];
    const panes = (out: string | Error) => async (args: string[]) => {
      asked.push(args);
      if (out instanceof Error) throw out;
      return out;
    };
    const ttys = "/dev/ttys001\n/dev/ttys004\n";
    const here = (tty: string) => (t: string) => t === tty;
    // A shell in one of its panes, a session's program: their terminal is a pane's.
    assert.equal(await whereInKiko(panes(ttys), PANE, "kiko", here("/dev/ttys004")), "pane");
    assert.deepEqual(asked, [["list-panes", "-a", "-F", "#{pane_tty}"]], "one tmux call");
    assert.equal(await whereInKiko(panes(ttys), SESSION, "kiko", here("/dev/ttys001")), "session");
    // Ghostty relaunched from a pane: its shells have that TMUX, their own terminal (2026-10-30, "no current client").
    assert.equal(await whereInKiko(panes(ttys), PANE, "kiko", here("/dev/ttys009")), null);
    assert.equal(await whereInKiko(panes(ttys), SESSION, "kiko", here("/dev/ttys009")), null, "nor from a session's program");
    // The pane it names is gone, and the server too.
    assert.equal(await whereInKiko(panes(""), PANE, "kiko", here("/dev/ttys004")), null);
    assert.equal(await whereInKiko(panes(new Error("no server running on /private/tmp/tmux-501/kiko")), PANE, "kiko", here("/dev/ttys004")), null);
    // Can't tell: no terminal to compare (a command a session's program runs, through pipes), or tmux not answering.
    asked.length = 0;
    assert.equal(await whereInKiko(panes(ttys), SESSION, "kiko", null), "session");
    assert.deepEqual(asked, [], "nothing asked");
    assert.equal(await whereInKiko(panes(new Error(NO_ANSWER)), PANE, "kiko", here("/dev/ttys009")), "pane");
    // Outside, as the environment says: tmux isn't asked.
    asked.length = 0;
    assert.equal(await whereInKiko(panes(ttys), { TMUX: "/private/tmp/tmux-501/default,1,0" }, "kiko", here("/dev/ttys004")), null);
    assert.equal(await whereInKiko(panes(ttys), {}, "kiko", here("/dev/ttys004")), null);
    assert.deepEqual(asked, []);
  });
  test("this process's terminal: none when stdin, stdout and stderr are pipes or files (a terminal's own: tests/live/terminals/tmux-live.test.ts)", () => {
    const tmuxTs = new URL("../../../src/terminals/tmux/tmux.ts", import.meta.url).href;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", `import { ownTerminal } from ${JSON.stringify(tmuxTs)}; console.log(String(ownTerminal()))`], {
      env: cleanEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
    assert.equal(out, "null\n");
  });
  test("a session's program gets no TMUX: what it runs can't reach Kiko's server; what TMUX said kept in KIKO_KEPT_TMUX", (t) => {
    // A stale kept TMUX isn't passed on.
    const launch = envLaunch({ MYVAR: "kept", KIKO_KEPT_TMUX: "/stale,1,0" }, "/code/pixie", "/bin/claude", [], true);
    t.after(() => launch.discard());
    const { argv } = launch;
    const out = execFileSync(argv[0]!, [...argv.slice(1, -1), "/bin/sh", "-c", 'printf "%s|%s|%s|%s" "${TMUX-unset}" "${TMUX_PANE-unset}" "$KIKO_KEPT_TMUX" "$MYVAR"'], {
      env: { PATH: "/usr/bin:/bin", TMUX: "/private/tmp/tmux-501/kiko,123,0", TMUX_PANE: "%3" },
    }).toString();
    assert.equal(out, "unset|unset|/private/tmp/tmux-501/kiko,123,0|kept");
    // The window's own panes (the app's list) keep it.
    const app = envLaunch({}, "/code/kiko", "/bin/app", []);
    t.after(() => app.discard());
    const kept = execFileSync(app.argv[0]!, [...app.argv.slice(1, -1), "/bin/sh", "-c", 'printf "%s" "${TMUX-unset}"'], { env: { PATH: "/usr/bin:/bin", TMUX: "/t,1,0" } }).toString();
    assert.equal(kept, "/t,1,0");
  });
  test("tmux never gets the app's keys or settings: only what a new terminal window has", () => {
    const env = cleanEnv({ HOME: "/h", PATH: "/bin", SHELL: "/bin/zsh", LC_ALL: "C", ANTHROPIC_API_KEY: "k", KIKO_SETTINGS: "x", TMUX: "/tmp/t,1,0", DEEPGRAM_API_KEY: "d" });
    assert.deepEqual(env, { HOME: "/h", PATH: "/bin", SHELL: "/bin/zsh", LC_ALL: "C" });
  });
  test("`kiko claude` passes the shell's environment on, but for the terminal's own", () => {
    const env = { PATH: "/bin", MYVAR: "x", TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty", GHOSTTY_RESOURCES_DIR: "/g", TMUX: "/t,1,0", PWD: "/old", COLORTERM: "truecolor" };
    assert.deepEqual(withoutTerminal(env), { PATH: "/bin", MYVAR: "x" });
    assert.equal(
      sessionEnv({ ...env, UID: "501", SHELLOPTS: "x" }, "/code/pixie"),
      "command export PATH='/bin' 2>/dev/null\ncommand export MYVAR='x' 2>/dev/null\ncommand export PWD='/code/pixie' 2>/dev/null\n",
    );
  });
  test("the environment never goes on a command line: a private file sh opens, deletes, reads, then becomes claude", (t) => {
    const launch = envLaunch({ SECRET_TOKEN: "s3cr3t 'quoted' $HOME", "BAD-NAME": "x" }, "/code/pixie", "/bin/claude", ["--name", "R"]);
    t.after(() => launch.discard());
    const { argv } = launch;
    assert.ok(!argv.join(" ").includes("s3cr3t"), "the value isn't in the arguments");
    assert.deepEqual(argv.slice(0, 2), ["/bin/sh", "-c"]);
    assert.deepEqual(argv.slice(-3), ["/bin/claude", "--name", "R"]);
    const [file, dir] = [argv[4]!, argv[5]!];
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    // Run it: the value arrives exactly, the bad name is left out, and the file is gone.
    const out = execFileSync(argv[0]!, [...argv.slice(1, -3), "/bin/sh", "-c", 'printf "%s|%s" "$SECRET_TOKEN" "${BAD_NAME-unset}"']).toString();
    assert.equal(out, "s3cr3t 'quoted' $HOME|unset");
    assert.equal(existsSync(dir), false);
  });
  test("a name sh keeps read-only (UID, SHELLOPTS…) still starts the program, and leaves no file", (t) => {
    const launch = envLaunch({ UID: "0", EUID: "0", SHELLOPTS: "x", BASHOPTS: "y", PPID: "1", MYVAR: "kept" }, "/code/pixie", "/bin/claude", []);
    t.after(() => launch.discard());
    const { argv } = launch;
    // One that isn't left out by name: `command export` fails on its own line, and sh goes on.
    // Which names sh keeps read-only depends on which sh it is: UID in bash (the Mac's /bin/sh),
    // none in dash (Ubuntu's). So one read-only on any sh too (`readonly`), whose value stays.
    appendFileSync(argv[4]!, "readonly KEPT='mine'\ncommand export KEPT='theirs' 2>/dev/null\nexport KEPT\ncommand export UID='0' 2>/dev/null\ncommand export LATER='after it' 2>/dev/null\n");
    const out = execFileSync(argv[0]!, [...argv.slice(1, -1), "/bin/sh", "-c", 'printf "%s|%s|%s|%s" "$MYVAR" "$LATER" "$KEPT" "$UID"']).toString();
    // Where sh keeps UID read-only (an assignment to it ends sh), it's still the real one.
    const shKeepsUid = spawnSync("/bin/sh", ["-c", "UID=1"], { stdio: "ignore" }).status !== 0;
    const [myvar, later, kept, uid] = out.split("|");
    assert.deepEqual([myvar, later, kept], ["kept", "after it", "mine"]);
    if (shKeepsUid) assert.equal(uid, String(process.getuid!()));
    assert.equal(existsSync(argv[5]!), false);
  });
});

describe("which adapter opens new sessions", () => {
  const opens = (id: string, ready?: boolean): Terminal => ({
    id,
    label: null,
    find: async () => new Map(),
    type: async () => ({ sent: true }),
    open: async () => {},
    ...(ready === undefined ? {} : { ready: () => ready }),
  });
  test("tmux first when it's installed; else Ghostty, as before", () => {
    assert.deepEqual(
      openers([opens("tmux", true), opens("ghostty")]).map((t) => t.id),
      ["tmux", "ghostty"],
    );
    assert.deepEqual(
      openers([opens("tmux", false), opens("ghostty")]).map((t) => t.id),
      ["ghostty"],
    );
  });
  test("`kiko claude` is suggested only when tmux is installed", () => {
    assert.equal(reachableStart([opens("tmux", true)]), `${COMMAND} claude`);
    assert.equal(reachableStart([opens("tmux", false), opens("ghostty")]), null);
  });
});

describe("launch files left behind", () => {
  test("swept when the app or the CLI starts: only our own folders, only old ones", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "sweep-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const old = new Date(Date.now() - 5 * 60_000);
    const make = (name: string) => {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "env"), "export A='made up'\n");
      utimesSync(join(dir, name), old, old);
    };
    // A checkout's: Kiko Dev's (kiko-dev-env-…); the release's own (kiko-env-…) are its to sweep.
    make("kiko-dev-env-old");
    make("kiko-env-old"); // the release's
    make("someone-env-old"); // not ours
    mkdirSync(join(dir, "kiko-dev-env-new")); // a pane about to read it
    writeFileSync(join(dir, "kiko-dev-env-file"), ""); // not a folder
    utimesSync(join(dir, "kiko-dev-env-file"), old, old);
    mkdirSync(join(dir, "elsewhere"));
    symlinkSync(join(dir, "elsewhere"), join(dir, "kiko-dev-env-link")); // a link: never followed
    assert.equal(sweepLaunches(dir), 1);
    assert.deepEqual(readdirSync(dir).sort(), ["elsewhere", "kiko-dev-env-file", "kiko-dev-env-link", "kiko-dev-env-new", "kiko-env-old", "someone-env-old"]);
    assert.equal(sweepLaunches(join(dir, "no-such-folder")), 0);
  });
});
