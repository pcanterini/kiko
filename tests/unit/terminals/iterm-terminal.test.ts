// iTerm2's and Terminal.app's adapters (src/terminals/iterm/, src/terminals/terminal-app/, on
// src/terminals/tty/) on fakes: a session's tab found by its process's tty, never by a title;
// Codex's by its program in front and that process's folder; its process looked at again before
// every send, and the send's own script finding the tab by its tty again; listed only while a
// session may be in that app and it runs (no AppleScript otherwise); nothing in the type, key, find
// or screen scripts that brings the app forward. No osascript, ps, lsof or pgrep runs here: the
// real apps are in tests/live/terminals/iterm-terminal-live.test.ts.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canDo } from "../../../src/core/can.ts";
import type { Session } from "../../../src/core/sessions.ts";
import { openers, terminals } from "../../../src/terminals/index.ts";
import * as it from "../../../src/terminals/iterm/index.ts";
import * as tm from "../../../src/terminals/terminal-app/index.ts";
import { bracketed, frontOn, matchTabs, notReady, ttyNeeded, ttyTerminal, type Proc, type Sent, type Tab, type TtyApp, type TtyDeps } from "../../../src/terminals/tty/index.ts";
import { devOf, parseProcs, parseTtys } from "../../../src/terminals/tty/procs.ts";
import type { Findable, Place, Terminal } from "../../../src/terminals/types.ts";

const ITERM = it.ITERM;
const TERMINAL = tm.TERMINAL_APP;
const T1 = "/dev/ttys001";
const T2 = "/dev/ttys002";
const S1 = "6E1B0F2A-0C4D-4E5F-9A8B-1C2D3E4F5A6B";
const S2 = "7F2C1A3B-1D5E-4F60-8B9C-2D3E4F5A6B7C";

const tab = (fields: Partial<Tab> = {}): Tab => ({ id: S1, tty: T1, title: "✳ Upload bug", ...fields });
const proc = (fields: Partial<Proc> = {}): Proc => ({ pid: 200, pgid: 200, tpgid: 200, stat: "S+", tty: T1, comm: "/Users/x/.local/bin/claude", ...fields });
const session = (fields: Partial<Findable> = {}): Findable => ({
  sessionId: "s1",
  cwd: "/code/pixie",
  kind: "interactive",
  desktop: false,
  titles: ["Upload bug"],
  pid: 200,
  terminal: "iterm",
  ...fields,
});
const at = (app: TtyApp, id: string, tty: string, pid: number, more: Partial<Place> = {}): Place => ({ via: app.id, id, keys: app.keys, pid, tty, ...more });

/** An adapter for `app` on fakes: what it asked of the app and the computer, and what it sent. */
function fake(
  app: TtyApp,
  o: {
    tabs?: Tab[];
    ttys?: Record<number, string>;
    proc?: (pid: number, n: number) => Proc | null;
    onTtys?: Proc[];
    cwds?: Record<number, string>;
    sent?: (n: number) => Sent;
    running?: boolean;
    installed?: boolean;
    look?: Tab | null;
    listFails?: boolean;
  } = {},
) {
  const calls = { list: 0, ttysOf: 0, proc: 0, onTtys: 0, cwds: 0, running: 0, look: 0 };
  const sends: Array<{ tab: Tab; data: string }> = [];
  const opens: Array<{ cwd: string; line: string }> = [];
  const waits: number[] = [];
  const d: TtyDeps = {
    list: async () => {
      calls.list++;
      if (o.listFails) throw new Error("Not authorised to send Apple events");
      return o.tabs ?? [tab({ id: app === TERMINAL ? T1 : S1, title: app === TERMINAL ? "" : "✳ Upload bug" })];
    },
    look: async () => {
      calls.look++;
      return o.look === undefined ? tab() : o.look;
    },
    send: async (t, data) => {
      sends.push({ tab: t, data });
      return o.sent ? o.sent(sends.length) : { status: "sent" };
    },
    screen: async () => "the screen",
    open: async (cwd, line) => {
      opens.push({ cwd, line });
      return app === TERMINAL ? T2 : S2;
    },
    ttysOf: async (pids) => {
      calls.ttysOf++;
      const all = o.ttys ?? { 200: T1 };
      return new Map(pids.filter((p) => all[p]).map((p) => [p, all[p]]));
    },
    proc: async (pid) => {
      calls.proc++;
      return o.proc ? o.proc(pid, calls.proc) : proc({ pid });
    },
    onTtys: async () => {
      calls.onTtys++;
      return o.onTtys ?? [proc()];
    },
    cwds: async (pids) => {
      calls.cwds++;
      const all = o.cwds ?? {};
      return new Map(pids.filter((p) => all[p]).map((p) => [p, all[p]]));
    },
    installed: () => o.installed ?? true,
    running: async () => {
      calls.running++;
      return o.running ?? true;
    },
    wait: async (ms) => void waits.push(ms),
  };
  return { terminal: ttyTerminal(app, d), calls, sends, opens, waits };
}

describe("iTerm and Terminal: a session's tab, by its process's tty", () => {
  test("the tab on its process's tty, whatever the titles say", () => {
    const tabs = [tab({ id: S2, tty: T2, title: "✳ Upload bug" }), tab({ title: "zsh" })];
    assert.deepEqual(matchTabs(ITERM, [session()], tabs, new Map([[200, T1]])).get("s1"), { place: at(ITERM, S1, T1, 200), mapping: "process" });
  });

  test("its process on no tab's tty (a tmux of your own inside iTerm, another app): not found, never a title guess", () => {
    const found = matchTabs(ITERM, [session()], [tab({ tty: T2 })], new Map([[200, "/dev/ttys009"]]));
    assert.equal(found.has("s1"), false);
    // Its process gone (no tty from ps): not found either.
    assert.equal(matchTabs(ITERM, [session()], [tab()], new Map()).has("s1"), false);
  });

  test("two sessions on one tty (one started inside the other): ambiguous, keys could reach either", () => {
    const found = matchTabs(
      ITERM,
      [session(), session({ sessionId: "s2", pid: 250 })],
      [tab()],
      new Map([
        [200, T1],
        [250, T1],
      ]),
    );
    assert.deepEqual(found.get("s1"), { place: null, mapping: "ambiguous" });
    assert.deepEqual(found.get("s2"), { place: null, mapping: "ambiguous" });
  });

  test("a tab titled as Claude Code's agents list (iTerm says titles; its job's name after it too): agents", () => {
    for (const title of ["claude agents", "1 awaiting input · claude agents", "claude agents (claude)"]) {
      assert.deepEqual(matchTabs(ITERM, [session()], [tab({ title })], new Map([[200, T1]])).get("s1"), { place: null, mapping: "agents" }, title);
    }
  });

  test("Terminal: its tab is its tty, and its place takes no keys", () => {
    const found = matchTabs(TERMINAL, [session({ terminal: "terminal" })], [tab({ id: T1, title: "" })], new Map([[200, T1]]));
    assert.deepEqual(found.get("s1"), { place: at(TERMINAL, T1, T1, 200), mapping: "process" });
    assert.equal(found.get("s1")?.place?.keys, false);
  });

  test("sessions known to be elsewhere, the desktop app's, background ones, T3 Code's: never matched", () => {
    const ttys = new Map([[200, T1]]);
    for (const s of [
      session({ terminal: "ghostty" }),
      session({ terminal: "terminal" }),
      session({ terminal: "kiko-tmux" }),
      session({ desktop: true }),
      session({ kind: "background" }),
      session({ agent: "t3code" }),
    ]) {
      assert.equal(matchTabs(ITERM, [s], [tab()], ttys).size, 0, JSON.stringify(s));
    }
    // Not known yet: looked for, and found by its tty.
    assert.equal(matchTabs(ITERM, [session({ terminal: undefined })], [tab()], ttys).get("s1")?.mapping, "process");
  });

  test("Codex's words as a bracketed paste: the place says so", () => {
    assert.equal(matchTabs(ITERM, [session({ bracketed: true })], [tab()], new Map([[200, T1]])).get("s1")?.place?.bracketed, true);
  });
});

describe("iTerm and Terminal: a session whose process isn't known, by its program in front and that process's folder (Codex)", () => {
  const codex = (fields: Partial<Findable> = {}) => session({ pid: undefined, program: "codex", terminal: undefined, bracketed: true, ...fields });
  const front = (pid: number, cwd = "/code/pixie", program = "codex") => ({ pid, program, cwd });

  test("the only tab in its folder running it, when it's the only such session there: only, its front process the place's", () => {
    const tabs = [tab(), tab({ id: S2, tty: T2 })];
    const fronts = new Map([
      [S1, front(500)],
      [S2, front(501, "/code/other")],
    ]);
    assert.deepEqual(matchTabs(ITERM, [codex()], tabs, new Map(), fronts).get("s1"), { place: at(ITERM, S1, T1, 500, { bracketed: true }), mapping: "only" });
  });

  test("the tab it was opened in (Findable.pane) while it runs there; else two in its folder: ambiguous", () => {
    const tabs = [tab(), tab({ id: S2, tty: T2 })];
    const fronts = new Map([
      [S1, front(500)],
      [S2, front(501)],
    ]);
    assert.deepEqual(matchTabs(ITERM, [codex({ pane: S2 })], tabs, new Map(), fronts).get("s1"), { place: at(ITERM, S2, T2, 501, { bracketed: true }), mapping: "process" });
    assert.deepEqual(matchTabs(ITERM, [codex()], tabs, new Map(), fronts).get("s1"), { place: null, mapping: "ambiguous" });
  });

  test("no folder known for what's in front (lsof didn't say): not found, not guessed", () => {
    const fronts = new Map([[S1, { pid: 500, program: "codex" }]]);
    assert.equal(matchTabs(ITERM, [codex()], [tab()], new Map(), fronts).has("s1"), false);
  });

  test("two sessions in one folder, one tab: ambiguous; a shell in front: not found; a tab a session was found in by its tty isn't another's", () => {
    const fronts = new Map([[S1, front(500)]]);
    const two = matchTabs(ITERM, [codex(), codex({ sessionId: "s2" })], [tab()], new Map(), fronts);
    assert.equal(two.get("s1")?.mapping, "ambiguous");
    assert.equal(two.get("s2")?.mapping, "ambiguous");
    assert.equal(matchTabs(ITERM, [codex()], [tab()], new Map(), new Map([[S1, front(500, "/code/pixie", "zsh")]])).size, 0);
    const both = matchTabs(ITERM, [session({ pid: 500, terminal: undefined }), codex({ sessionId: "s2" })], [tab()], new Map([[500, T1]]), fronts);
    assert.equal(both.get("s1")?.mapping, "process");
    assert.equal(both.has("s2"), false);
  });

  test("find: ps on the tabs' ttys, lsof only for the fronts running a program a session names", async () => {
    const { terminal, calls } = fake(ITERM, {
      tabs: [tab(), tab({ id: S2, tty: T2 })],
      onTtys: [
        proc({ pid: 100, pgid: 100, tpgid: 500, comm: "-zsh" }),
        proc({ pid: 500, pgid: 500, tpgid: 500, comm: "/opt/homebrew/bin/codex" }),
        proc({ pid: 600, pgid: 600, tpgid: 600, tty: T2, comm: "/bin/zsh" }),
      ],
      cwds: { 500: "/code/pixie" },
    });
    const found = await terminal.find(Promise.resolve([codex()]));
    assert.deepEqual(found.get("s1"), { place: at(ITERM, S1, T1, 500, { bracketed: true }), mapping: "only" });
    assert.deepEqual({ onTtys: calls.onTtys, cwds: calls.cwds, ttysOf: calls.ttysOf }, { onTtys: 1, cwds: 1, ttysOf: 0 });
  });
});

describe("iTerm and Terminal, only when a session may be there (no AppleScript otherwise)", () => {
  for (const app of [ITERM, TERMINAL]) {
    test(`${app.name}: every session known to be elsewhere: the app is never asked anything, again and again`, async () => {
      const { terminal, calls } = fake(app);
      for (let i = 0; i < 3; i++) {
        const elsewhere = [
          session({ terminal: "ghostty" }),
          session({ sessionId: "s2", terminal: "rex" }),
          session({ sessionId: "s3", terminal: "kiko-tmux" }),
          session({ sessionId: "s4", terminal: app === ITERM ? "terminal" : "iterm" }),
        ];
        assert.equal((await terminal.find(Promise.resolve(elsewhere))).size, 0);
      }
      assert.deepEqual([calls.list, calls.running, calls.ttysOf], [0, 0, 0]);
    });

    test(`${app.name}: no sessions, or only the desktop app's, background ones and ones with nothing to find them by: nothing asked`, async () => {
      const { terminal, calls } = fake(app);
      await terminal.find(Promise.resolve([]));
      await terminal.find(Promise.resolve([session({ desktop: true }), session({ kind: "background" }), session({ pid: undefined, terminal: app.id })]));
      assert.deepEqual([calls.list, calls.running], [0, 0]);
    });

    test(`${app.name}: not running: never told anything, even for a session its hook said is there (telling it would start it)`, async () => {
      const { terminal, calls } = fake(app, { running: false });
      assert.equal((await terminal.find(Promise.resolve([session({ terminal: app.id }), session({ sessionId: "s2", terminal: undefined })]))).size, 0);
      assert.equal(calls.list, 0);
      assert.equal(calls.running, 1);
    });

    test(`${app.name}: a session its hook says is there, or one not known while it runs: one listing, found by its tty`, async () => {
      const { terminal, calls } = fake(app);
      assert.equal((await terminal.find(Promise.resolve([session({ terminal: app.id })]))).get("s1")?.mapping, "process");
      assert.equal((await terminal.find(Promise.resolve([session({ terminal: undefined })]))).get("s1")?.mapping, "process");
      assert.equal(calls.list, 2);
      assert.equal(calls.proc, 0, "finding checks no process on its own");
    });

    test(`${app.name}: the listing failing (not allowed to control it): nothing found, nothing thrown`, async () => {
      const { terminal, calls } = fake(app, { listFails: true });
      assert.equal((await terminal.find(Promise.resolve([session({ terminal: app.id })]))).size, 0);
      assert.equal(calls.list, 1);
    });
  }

  test("iTerm not installed: never asked; Terminal always is (it's macOS's)", async () => {
    const { terminal, calls } = fake(ITERM, { installed: false });
    assert.equal((await terminal.find(Promise.resolve([session()]))).size, 0);
    assert.deepEqual([calls.list, calls.running], [0, 0]);
    assert.equal(tm.terminalDeps(async () => "").installed(), true);
    assert.equal(await ttyNeeded(ITERM, [session()], { installed: () => true, running: async () => false }), false);
  });
});

describe("iTerm: typing, its process looked at again first, the send's script finding the session by its tty", () => {
  test("one line into Claude Code: written as is, then Enter on its own after a moment, its process checked before each", async () => {
    const { terminal, sends, waits, calls } = fake(ITERM);
    assert.deepEqual(await terminal.type(at(ITERM, S1, T1, 200), "fix the upload bug"), { sent: true });
    assert.deepEqual(
      sends.map((s) => [s.tab.id, s.tab.tty, s.data]),
      [
        [S1, T1, "fix the upload bug"],
        [S1, T1, "\r"],
      ],
    );
    assert.deepEqual(waits, [150]);
    assert.equal(calls.proc, 2);
  });

  test("several lines: one bracketed paste, lines split by Return; control characters dropped", async () => {
    const { terminal, sends } = fake(ITERM);
    await terminal.type(at(ITERM, S1, T1, 200), "first\r\nsecond\tthird\u0007\u001b[31m");
    assert.equal(sends[0].data, "\u001b[200~first\rsecond third[31m\u001b[201~");
    assert.equal(bracketed("a\nb"), "\u001b[200~a\rb\u001b[201~");
  });

  test("a session that wants a bracketed paste (Codex): one line too, as one", async () => {
    const { terminal, sends } = fake(ITERM);
    await terminal.type(at(ITERM, S1, T1, 200, { bracketed: true }), "hello");
    assert.equal(sends[0].data, "\u001b[200~hello\u001b[201~");
  });

  test("its process ended, moved to another tty, stopped, or behind something else: refused, nothing sent", async () => {
    for (const [now, why] of [
      [null, "its process has ended"],
      [proc({ tty: T2 }), "it isn't running in that iTerm tab any more"],
      [proc({ stat: "T+" }), "it's suspended in its tab"],
      [proc({ tpgid: 250 }), "something else is in front of it in its tab"],
    ] as const) {
      const { terminal, sends } = fake(ITERM, { proc: () => now });
      assert.deepEqual(await terminal.type(at(ITERM, S1, T1, 200), "hi"), { sent: false, why });
      assert.deepEqual(sends, []);
    }
  });

  test("no process or tty to check: refused without asking anything", async () => {
    const { terminal, sends, calls } = fake(ITERM);
    assert.deepEqual(await terminal.type({ via: "iterm", id: S1, keys: true, tty: T1 }, "hi"), { sent: false, why: "I don't know its process" });
    assert.deepEqual(await terminal.type({ via: "iterm", id: S1, keys: true, pid: 200 }, "hi"), { sent: false, why: "its iTerm tab isn't one I know" });
    assert.deepEqual(await terminal.type(at(ITERM, S1, "/dev/null", 200), "hi"), { sent: false, why: "its iTerm tab isn't one I know" });
    assert.equal(calls.proc, 0);
    assert.deepEqual(sends, []);
  });

  test("the send's script finds another tty on the session, or its title is the agents list: nothing went in, said so", async () => {
    const changed = fake(ITERM, { sent: () => ({ status: "changed" }) });
    assert.deepEqual(await changed.terminal.type(at(ITERM, S1, T1, 200), "hi"), { sent: false, why: "its tab changed just as I typed, so nothing went in" });
    const view = fake(ITERM, { sent: () => it.parseSent("view\n") });
    assert.deepEqual(await view.terminal.type(at(ITERM, S1, T1, 200), "hi"), { sent: false, why: "its tab is showing Claude Code's agents list" });
    const gone = fake(ITERM, { sent: () => ({ status: "gone" }) });
    assert.deepEqual(await gone.terminal.type(at(ITERM, S1, T1, 200), "hi"), { sent: false, why: "its iTerm tab has closed" });
  });

  test("it changed before Enter: typed, not sent, and said so; no Enter", async () => {
    const { terminal, sends } = fake(ITERM, { proc: (pid, n) => (n === 1 ? proc({ pid }) : proc({ pid, tpgid: 999 })) });
    assert.deepEqual(await terminal.type(at(ITERM, S1, T1, 200), "hi"), { sent: false, why: "something else is in front of it in its tab, so I typed it but didn't send it" });
    assert.equal(sends.length, 1);
  });

  test("iTerm refused the Enter: typed, not sent, its error kept", async () => {
    const { terminal } = fake(ITERM, { sent: (n) => (n === 1 ? { status: "sent" } : { status: "failed", error: "-1743" }) });
    assert.deepEqual(await terminal.type(at(ITERM, S1, T1, 200), "hi"), { sent: false, why: "iTerm didn't take it, so I typed it but didn't send it", error: "-1743" });
  });
});

describe("iTerm: keys", () => {
  test("Escape, Shift+Tab, the arrows and Enter as the bytes a terminal sends, each after its process is checked", async () => {
    const { terminal, sends, calls } = fake(ITERM);
    for (const key of ["escape", "shift+tab", "down", "Enter"]) assert.deepEqual(await terminal.key!(at(ITERM, S1, T1, 200), key), { sent: true });
    assert.deepEqual(
      sends.map((s) => s.data),
      ["\u001b", "\u001b[Z", "\u001b[B", "\r"],
    );
    assert.equal(calls.proc, 4);
  });

  test("refused when its process has moved, or the key isn't one it knows: nothing sent", async () => {
    const moved = fake(ITERM, { proc: () => proc({ tty: T2 }) });
    assert.deepEqual(await moved.terminal.key!(at(ITERM, S1, T1, 200), "escape"), { sent: false, why: "it isn't running in that iTerm tab any more" });
    assert.deepEqual(moved.sends, []);
    const unknown = fake(ITERM);
    assert.deepEqual(await unknown.terminal.key!(at(ITERM, S1, T1, 200), "C-x"), { sent: false, why: "I don't know the key C-x" });
    assert.deepEqual(unknown.sends, []);
  });
});

describe("Terminal: words with `do script`, no keys", () => {
  test("one send: the words as one bracketed paste (even one line), Terminal's own Return after them sends them", async () => {
    const { terminal, sends, waits, calls } = fake(TERMINAL);
    assert.deepEqual(await terminal.type(at(TERMINAL, T1, T1, 200), "fix the upload bug"), { sent: true });
    assert.deepEqual(sends, [{ tab: { id: T1, tty: T1, title: "" }, data: "\u001b[200~fix the upload bug\u001b[201~" }]);
    assert.deepEqual(waits, []);
    assert.equal(calls.proc, 1);
  });

  test("several lines: still one paste, one send", async () => {
    const { terminal, sends } = fake(TERMINAL);
    await terminal.type(at(TERMINAL, T1, T1, 200), "one\ntwo");
    assert.deepEqual(
      sends.map((s) => s.data),
      ["\u001b[200~one\rtwo\u001b[201~"],
    );
  });

  test("its process moved: refused, nothing sent; its tab gone as it sent: said", async () => {
    const moved = fake(TERMINAL, { proc: () => proc({ tty: T2 }) });
    assert.deepEqual(await moved.terminal.type(at(TERMINAL, T1, T1, 200), "hi"), { sent: false, why: "it isn't running in that Terminal tab any more" });
    assert.deepEqual(moved.sends, []);
    const gone = fake(TERMINAL, { sent: () => ({ status: "gone" }) });
    assert.deepEqual(await gone.terminal.type(at(TERMINAL, T1, T1, 200), "hi"), { sent: false, why: "its Terminal tab has closed" });
  });

  test("no key and no press: Interrupt isn't offered for a session found there", () => {
    const { terminal } = fake(TERMINAL);
    assert.equal(terminal.key, undefined);
    assert.equal(terminal.press, undefined);
    assert.equal(tm.terminalApp.key, undefined);
    assert.equal(typeof it.iterm.key, "function");
  });
});

describe("iTerm and Terminal: a window opened for a new session", () => {
  test("open: cd to its folder and the command, typed into a new window's shell; its handle told", async () => {
    for (const app of [ITERM, TERMINAL]) {
      const { terminal, opens } = fake(app);
      const handles: string[] = [];
      await terminal.open!("/code/my pixie", { program: "claude", args: ["--name", "pixie one"] }, (h) => handles.push(h));
      assert.deepEqual(opens, [{ cwd: "/code/my pixie", line: "cd '/code/my pixie' && claude --name 'pixie one'" }]);
      assert.deepEqual(handles, [app === TERMINAL ? T2 : S2]);
    }
  });

  test("program, placeIn, press: by what's in front on its tty (its program, the shell again, or gone)", async () => {
    const running = fake(ITERM, { onTtys: [proc({ pid: 321, pgid: 321, tpgid: 321, comm: "/x/2.1.318" })] });
    assert.equal(await running.terminal.program!(S1), "running");
    assert.deepEqual(await running.terminal.placeIn!(S1), at(ITERM, S1, T1, 321));
    assert.deepEqual(await running.terminal.press!(S1, "down"), { sent: true });
    assert.equal(running.sends[0].data, "\u001b[B");
    const shell = fake(ITERM, { onTtys: [proc({ comm: "-zsh" })] });
    assert.equal(await shell.terminal.program!(S1), "shell");
    assert.equal(await shell.terminal.placeIn!(S1), null);
    assert.deepEqual(await shell.terminal.press!(S1, "enter"), { sent: false, why: "its program has ended" });
    assert.deepEqual(shell.sends, []);
    const gone = fake(ITERM, { look: null });
    assert.equal(await gone.terminal.program!(S1), "gone");
    assert.deepEqual(await gone.terminal.press!(S1, "enter"), { sent: false, why: "its iTerm tab has closed" });
  });

  test("screen: what its own script read", async () => {
    assert.equal(await fake(ITERM).terminal.screen!(S1), "the screen");
    assert.equal(await fake(TERMINAL).terminal.screen!(T1), "the screen");
  });
});

describe("the scripts: in the background, arguments as argv, never telling an app that isn't running", () => {
  const background: Array<[string, string]> = [
    ["iTerm LIST", it.LIST],
    ["iTerm LOOK", it.LOOK],
    ["iTerm SEND", it.SEND],
    ["iTerm SCREEN", it.SCREEN],
    ["Terminal LIST", tm.LIST],
    ["Terminal SEND", tm.SEND],
    ["Terminal SCREEN", tm.SCREEN],
  ];

  test("the type, key, find and screen scripts never bring the app forward, select a tab or switch windows", () => {
    for (const [name, code] of background) {
      assert.doesNotMatch(code, /\bactivate\b|\bselect\b|\bfrontmost\b|\breopen\b|\bselected\b|\bindex of\b|System Events|keystroke|key code/i, name);
    }
    // Only a new window brings the app forward.
    assert.match(it.OPEN, /\bactivate\b/);
    assert.match(tm.OPEN, /\bactivate\b/);
  });

  test("each checks the app runs before it tells it anything (telling it would start it)", () => {
    for (const [name, code] of background) {
      const check = code.indexOf("is not running");
      assert.ok(check > 0 && check < code.indexOf("tell application"), name);
    }
  });

  test("what's typed and which tab come as argv, never in the script's source; no shell run from it", () => {
    for (const [name, code] of [...background, ["iTerm OPEN", it.OPEN], ["Terminal OPEN", tm.OPEN]]) {
      assert.match(code, /on run argv/, name);
      assert.doesNotMatch(code, /do shell script/, name);
    }
    assert.match(it.SEND, /write text \(item 3 of argv\) newline false/);
    assert.match(tm.SEND, /do script \(item 2 of argv\) in t/);
  });

  test("the real ones pass arguments through the runner: iTerm's send with the session, its tty, the bytes and the agents lists' words", async () => {
    const ran: Array<{ script: string; args: string[] }> = [];
    const run = async (script: string, args: string[] = []) => {
      ran.push({ script, args });
      return script === it.SEND ? "sent\n" : "";
    };
    const d = it.itermDeps(run);
    assert.deepEqual(await d.send(tab(), "\u001b"), { status: "sent" });
    assert.deepEqual(ran[0].args, [S1, T1, "\u001b", "claude agents"]);
    // Not a session id or a tty: nothing run.
    assert.deepEqual(await d.send(tab({ id: 'x" & do shell script "rm' }), "hi"), { status: "gone" });
    assert.equal(await d.look("bad id!"), null);
    assert.equal(ran.length, 1);
    const t = tm.terminalDeps(async (script, args = []) => {
      ran.push({ script, args });
      return "sent";
    });
    assert.deepEqual(await t.send(tab({ id: T1 }), "words"), { status: "sent" });
    assert.deepEqual(ran.at(-1)!.args, [T1, "words"]);
  });
});

describe("what the apps and ps answer, read", () => {
  test("iTerm's listing: sessions with an id and a tty; a title with tabs in it kept", () => {
    const out = `${S1}\t${T1}\t✳ Upload bug\n${S2}\t\tno tty\nnope\t${T2}\tx\n${S2}\t${T2}\ta\tb\n\n`;
    assert.deepEqual(it.parseSessions(out), [
      { id: S1, tty: T1, title: "✳ Upload bug" },
      { id: S2, tty: T2, title: "a b" },
    ]);
    assert.deepEqual(it.parseSessions(""), []);
  });

  test("Terminal's listing: tabs by tty", () => {
    assert.deepEqual(tm.parseTabs(`${T1}\n\n/dev/null\n${T2}\r\n`), [
      { id: T1, tty: T1, title: "" },
      { id: T2, tty: T2, title: "" },
    ]);
  });

  test("a send's answer: anything but what the script says is a failure", () => {
    assert.deepEqual(it.parseSent("sent\n"), { status: "sent" });
    assert.deepEqual(it.parseSent("changed"), { status: "changed" });
    assert.deepEqual(it.parseSent("gone"), { status: "gone" });
    assert.equal(it.parseSent("maybe").status, "failed");
    assert.deepEqual(tm.parseSent("sent"), { status: "sent" });
    assert.equal(tm.parseSent("").status, "failed");
  });

  test("a screen: its text, trailing spaces and blank lines at the end gone; gone is null", () => {
    assert.equal(it.parseScreen("\tone  \rtwo\n\n\n"), "one\ntwo");
    assert.equal(it.parseScreen(""), null);
    assert.equal(tm.parseScreen("\ta\nb  \n"), "a\nb");
    assert.equal(tm.parseScreen(""), null);
  });

  test("ps: ttys as the apps say them, processes with their group, state and executable", () => {
    assert.deepEqual(
      [...parseTtys("  200 ttys001\n  300 ??\n  400 ttys012 \n")],
      [
        [200, T1],
        [400, "/dev/ttys012"],
      ],
    );
    assert.deepEqual(parseProcs("  500   500   500 S+   ttys001  /Applications/My Codex/codex\n  100   100   500 Ss   ttys001  -zsh\n"), [
      { pid: 500, pgid: 500, tpgid: 500, stat: "S+", tty: T1, comm: "/Applications/My Codex/codex" },
      { pid: 100, pgid: 100, tpgid: 500, stat: "Ss", tty: T1, comm: "-zsh" },
    ]);
    assert.equal(devOf("??"), "");
  });

  test("what's in front on a tty: the foreground group's leader, not a stopped one", () => {
    const procs = [proc({ pid: 100, pgid: 100, tpgid: 500, comm: "-zsh" }), proc({ pid: 500, pgid: 500, tpgid: 500 }), proc({ pid: 501, pgid: 500, tpgid: 500 })];
    assert.equal(frontOn(T1, procs)?.pid, 500);
    assert.equal(frontOn(T2, procs), null);
    assert.equal(frontOn(T1, [proc({ stat: "T+" })]), null);
    assert.equal(notReady(ITERM, 200, T1, proc()), null);
  });
});

describe("iTerm and Terminal in Kiko", () => {
  const listed = (place: Place) => ({ sessionId: "s1", cwd: "/code/pixie", kind: "interactive", desktop: false, pid: 200, place, mapping: "process" }) as unknown as Session;

  test("Interrupt and Rename where keys reach it: iTerm yes, Terminal no (no key there)", () => {
    assert.deepEqual(canDo(listed(at(ITERM, S1, T1, 200))), { reply: true, interrupt: true, rename: true, close: true });
    assert.deepEqual(canDo(listed(at(TERMINAL, T1, T1, 200))), { reply: true, interrupt: false, rename: false, close: true });
  });

  test("found before Ghostty's title guess, after Rex; new sessions open in them only after every other", () => {
    const ids = terminals.map((t) => t.id);
    if (process.platform === "darwin") {
      assert.ok(ids.indexOf("rex") < ids.indexOf("iterm") && ids.indexOf("iterm") < ids.indexOf("terminal") && ids.indexOf("terminal") < ids.indexOf("ghostty"), ids.join(","));
    }
    const opener = (id: string): Terminal => ({ id, label: null, find: async () => new Map(), type: async () => ({ sent: true }), open: async () => {} });
    assert.deepEqual(
      openers([opener("tmux"), opener("iterm"), opener("terminal"), opener("rex"), opener("ghostty")]).map((t) => t.id),
      ["tmux", "rex", "ghostty", "iterm", "terminal"],
    );
  });
});
