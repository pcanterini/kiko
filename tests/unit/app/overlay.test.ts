// The Mac overlay prototype's client side (src/app/overlay.ts): whether it's on and why, where
// Kiko's window is (tmux's list-clients, a fixture's lines: no tmux runs), which terminal app it's
// in (every terminal app Kiko knows, and every terminal adapter, has a mapping), the helper app's
// own log lines reaching `kiko`'s log, and `_overlay-test`'s connection to a running app of another
// build (a fake app of the test's own, tests/support/fake-broker.ts): used as it is, never quit.
// Nothing here starts the real app, runs tmux or draws anything.
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  CLIENTS_FORMAT,
  type FocusHook,
  focusHooks,
  focusOf,
  kikoFocus,
  NOT_WINDOW_APPS,
  overlayDecision,
  overlayState,
  type OverlayState,
  overlayWanted,
  SAY_LEVEL,
  SAY_WORD_MS,
  type Saying,
  sayingNow,
  terminalBundleId,
} from "../../../src/app/overlay.ts";
import type { Heard } from "../../../src/core/spoken-lines.ts";
import { ui } from "../../../src/core/ui-store.ts";
import { APPS, serverApps, windowApp } from "../../../src/core/terminal-apps.ts";
import { Broker, BrokerConn, connectTo, helperAppConn } from "../../../src/platform/macos/helper-app.ts";
import { terminals } from "../../../src/terminals/index.ts";
import { withoutTerminal } from "../../../src/terminals/tmux/tmux.ts";
import { FakeBroker } from "../../support/fake-broker.ts";

const dir = mkdtempSync(join(tmpdir(), "ov-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("the overlay: on or off", () => {
  test("Kiko Dev on a Mac: on, unless KIKO_OVERLAY says off", () => {
    assert.deepEqual(overlayDecision(undefined, true, "darwin", false), { on: true, why: "Kiko Dev" });
    assert.deepEqual(overlayDecision("1", true, "darwin", false), { on: true, why: "Kiko Dev, KIKO_OVERLAY=1" });
    for (const off of ["0", "off", "false", "no", " OFF "]) assert.equal(overlayDecision(off, true, "darwin", false).on, false, off);
  });
  test("each reason it's off is said", () => {
    assert.deepEqual(overlayDecision(undefined, false, "darwin", false), { on: false, why: "not Kiko Dev" });
    assert.deepEqual(overlayDecision(undefined, true, "linux", false), { on: false, why: "not a Mac (linux)" });
    assert.deepEqual(overlayDecision(undefined, true, "darwin", true), { on: false, why: "under the test runner" });
    assert.deepEqual(overlayDecision("0", true, "darwin", false), { on: false, why: "KIKO_OVERLAY=0" });
  });
  test("never under the test runner by default", () => assert.equal(overlayWanted(), false));
});

describe("where Kiko's window is (tmux list-clients)", () => {
  const out = ["101\tattached,focused,UTF-8\t%3", "202\tattached,UTF-8\t%3", "303\tattached,focused,UTF-8\t%7", "x\tattached\t%3", ""].join("\n");
  test("the clients showing Kiko's pane, and whether one has the focus", () => {
    assert.deepEqual(focusOf(out, "%3"), { hostPids: [101, 202], kikoFocused: true });
  });
  test("another window focused (a Claude session in the same terminal): not Kiko's", () => {
    assert.deepEqual(focusOf("202\tattached,UTF-8\t%3\n303\tattached,focused,UTF-8\t%7", "%3"), { hostPids: [202], kikoFocused: false });
  });
  test("Kiko's pane shown nowhere: not in front", () => {
    assert.deepEqual(focusOf("303\tattached,focused\t%7", "%3"), { hostPids: [], kikoFocused: false });
  });
  test("not in tmux: every client, focus not known (the overlay shows)", () => {
    assert.deepEqual(focusOf(out, undefined), { hostPids: [101, 202, 303], kikoFocused: null });
  });
  // CLIENTS_FORMAT's lines, as Kiko Dev's tmux had them (2026-11-06): Kiko's pane %2 in window @0 with %0 and %1.
  test("another pane of Kiko's window has the keyboard (the session beside the list): Kiko's pane still shown, the client's focus goes", () => {
    assert.deepEqual(focusOf("41259\tattached,focused,UTF-8\t%0\t0\t%0 %1 %2 ", "%2"), { hostPids: [41259], kikoFocused: true });
    assert.deepEqual(focusOf("41259\tattached,UTF-8\t%0\t0\t%0 %1 %2 ", "%2"), { hostPids: [41259], kikoFocused: false });
  });
  test("Kiko's window zoomed on another pane: Kiko's pane not shown; zoomed on Kiko's: shown", () => {
    assert.deepEqual(focusOf("41259\tattached,focused,UTF-8\t%0\t1\t%0 %1 %2 ", "%2"), { hostPids: [], kikoFocused: false });
    assert.deepEqual(focusOf("41259\tattached,focused,UTF-8\t%2\t1\t%0 %1 %2 ", "%2"), { hostPids: [41259], kikoFocused: true });
  });
  test("a client showing another window of the server: not Kiko's", () => {
    assert.deepEqual(focusOf("41259\tattached,focused,UTF-8\t%7\t0\t%7 %8 ", "%2"), { hostPids: [], kikoFocused: false });
  });
  test("the format asks for each of those fields, the window's panes by tmux's loop", () => {
    assert.equal(CLIENTS_FORMAT.split("\t").length, 5);
    assert.match(CLIENTS_FORMAT, /#\{P:#\{pane_id\} \}$/);
  });
});

describe("Kiko's window in front: tmux's flag (focused), or a terminal's own say (Rex: visible; its tab changes never reach tmux)", () => {
  // As the log had it (2026-11-06): Kiko Dev's tab in front in Rex, tmux's flag off all along.
  const off = async () => "26791\tattached,UTF-8\t%2\n";
  const on = async () => "26791\tattached,focused,UTF-8\t%2\n";
  const rex = (kikoFocused: boolean | null, why = "x"): [string, FocusHook] => ["rex", async () => ({ kikoFocused, why })];

  test("Kiko's block shown in Rex (another block focused), tmux's flag off: in front, by rex, the visible rule", async () => {
    const found = await kikoFocus("%2", off, [rex(true, "Kiko's block shown, another block focused")]);
    assert.deepEqual(found.focus, { hostPids: [26791], kikoFocused: true });
    assert.deepEqual([found.by, found.rule, found.tmux, found.why], ["rex", "visible", false, "Kiko's block shown, another block focused"]);
  });

  test("Kiko's block in another Rex tab, tmux's flag (stale) on: not in front, by rex", async () => {
    const found = await kikoFocus("%2", on, [rex(false, "Kiko's block not in the shown window")]);
    assert.deepEqual([found.focus.kikoFocused, found.by, found.rule, found.tmux], [false, "rex", "visible", true]);
  });

  test("Rex unreachable, or Kiko's client not in it: tmux's flag, by tmux, the focused rule", async () => {
    const failing: [string, FocusHook] = ["rex", async () => Promise.reject(new Error("no server"))];
    for (const hook of [failing, rex(null, "Kiko's tmux client isn't in Rex")]) {
      const found = await kikoFocus("%2", on, [hook]);
      assert.deepEqual([found.focus.kikoFocused, found.by, found.rule], [true, "tmux", "focused"]);
      assert.match(found.why ?? "", /^rex: /);
    }
  });

  test("no terminal with a say (Ghostty, iTerm, Terminal and the rest): tmux's flag, as before", async () => {
    assert.deepEqual((await kikoFocus("%2", on, [])).focus, { hostPids: [26791], kikoFocused: true });
    assert.deepEqual((await kikoFocus("%2", off, [])).focus, { hostPids: [26791], kikoFocused: false });
    assert.deepEqual([(await kikoFocus("%2", on, [])).by, (await kikoFocus("%2", on, [])).rule], ["tmux", "focused"]);
  });

  test("no client of Kiko's (not in tmux, its pane shown nowhere, tmux failing): no terminal asked", async () => {
    let asked = 0;
    const counting: [string, FocusHook] = ["rex", async () => (asked++, { kikoFocused: true, why: "x" })];
    assert.equal((await kikoFocus(undefined, on, [counting])).focus.kikoFocused, null);
    assert.equal((await kikoFocus("%9", on, [counting])).focus.kikoFocused, false);
    const broken = await kikoFocus("%2", async () => Promise.reject(new Error("no server on kiko-dev")), [counting]);
    assert.deepEqual([broken.focus, broken.by], [{ hostPids: [], kikoFocused: null }, "tmux"]);
    assert.equal(asked, 0);
  });

  test("Rex is the only terminal with a say", () => {
    assert.deepEqual(
      focusHooks().map(([id]) => id),
      ["rex"],
    );
  });
});

describe("which terminal app Kiko's window is in", () => {
  /** What Kiko's app has of a terminal's environment: what Kiko's tmux passes on (withoutTerminal), and tmux's own TERM_PROGRAM. */
  const throughTmux = (env: NodeJS.ProcessEnv) => ({ ...withoutTerminal(env), TERM_PROGRAM: "tmux", TMUX_PANE: "%2" });

  test("every terminal app Kiko knows is told apart from inside Kiko's tmux", () => {
    for (const [id, app] of Object.entries(APPS)) {
      // A terminal sets __CFBundleIdentifier for what it starts, unless it says another variable (envMark) is how it's known.
      const own: NodeJS.ProcessEnv = app.envMark ? { [app.envMark]: "x" } : { __CFBundleIdentifier: app.bundle };
      const env = throughTmux({ HOME: "/h", PATH: "/bin", ...(app.program ? { TERM_PROGRAM: app.program } : {}), ...own });
      assert.equal(terminalBundleId(env), app.bundle, id);
    }
  });

  test("every terminal adapter is a terminal app the overlay knows, or says why it's none", () => {
    for (const t of terminals) {
      const app = t.id in APPS;
      const none = t.id in NOT_WINDOW_APPS;
      assert.ok(app || none, `the ${t.id} adapter: add it to core/terminal-apps.ts APPS (or overlay.ts NOT_WINDOW_APPS, with why)`);
      assert.ok(!(app && none), `the ${t.id} adapter is in both APPS and NOT_WINDOW_APPS`);
    }
    for (const id of Object.keys(NOT_WINDOW_APPS))
      assert.ok(
        terminals.some((t) => t.id === id),
        `NOT_WINDOW_APPS names ${id}, no adapter`,
      );
  });

  test("Rex: no bundle id in its terminals, TERM_PROGRAM tmux's inside Kiko's: known by REX_SESSION", () => {
    const env = throughTmux({ HOME: "/h", TERM_PROGRAM: "rex", REX_SESSION: "session:1", REX_BLOCK: "block:2", REX_SERVER: "/s" });
    assert.deepEqual(windowApp(env), { bundle: "com.superlogical.rex", by: "REX_SESSION" });
    // Its server runs its terminals: the app responsible for Kiko's tmux client is it, not the Rex app.
    assert.equal(serverApps()["com.superlogical.rex.server"], "com.superlogical.rex");
  });

  test("the bundle id goes first, a server's taken for its app's, one Kiko doesn't know kept as it is", () => {
    assert.deepEqual(windowApp(throughTmux({ __CFBundleIdentifier: "com.mitchellh.ghostty", REX_SESSION: "s" })), { bundle: "com.mitchellh.ghostty", by: "__CFBundleIdentifier" });
    assert.equal(terminalBundleId({ __CFBundleIdentifier: "com.superlogical.rex.server" }), "com.superlogical.rex");
    assert.equal(terminalBundleId({ __CFBundleIdentifier: "dev.zed.Zed" }), "dev.zed.Zed");
    // Outside tmux (TERM_PROGRAM the terminal's own), as before.
    assert.equal(terminalBundleId({ TERM_PROGRAM: "iTerm.app" }), "com.googlecode.iterm2");
    assert.equal(terminalBundleId({ GHOSTTY_RESOURCES_DIR: "/g" }), "com.mitchellh.ghostty");
  });

  test("nothing says: none (the app responsible for Kiko's tmux client still can)", () => {
    assert.equal(terminalBundleId(throughTmux({ HOME: "/h", TERM_PROGRAM: "Unknown" })), null);
    assert.equal(windowApp({}), null);
  });
});

/** A server on a socket of the test's own that writes `lines` to whoever connects. */
async function saying(name: string, lines: object[]): Promise<{ path: string; close: () => void }> {
  const path = join(dir, `${name}.sock`);
  const conns: Socket[] = [];
  const server = createServer((s) => {
    conns.push(s);
    s.once("data", () => s.write(lines.map((l) => `${JSON.stringify(l)}\n`).join("")));
  });
  await new Promise<void>((r) => server.listen(path, r));
  return {
    path,
    close: () => {
      for (const c of conns) c.destroy();
      server.close();
    },
  };
}

describe("the app's own log lines", () => {
  test("are never taken for an answer, and come out as log events", async () => {
    const srv = await saying("log", [
      { op: "log", event: "overlay_app_shown", front: "com.example.app" },
      { op: "hello", pid: 7, build: "b" },
    ]);
    const conn = new BrokerConn((await connectTo(srv.path))!, srv.path);
    const logs: object[] = [];
    conn.on("log", (m) => logs.push(m));
    const hello = await conn.sayHello("b", 2000);
    assert.equal(hello?.pid, 7, "the hello, not the log line");
    assert.deepEqual(logs, [{ op: "log", event: "overlay_app_shown", front: "com.example.app" }]);
    conn.close();
    srv.close();
  });
});

describe("_overlay-test's connection", () => {
  test("a running app of another build is used as it is: never quit, no new one started", async () => {
    const path = join(dir, "Old.app");
    mkdirSync(join(path, "Contents"), { recursive: true });
    writeFileSync(join(path, "Contents", "Info.plist"), "<plist><dict><key>BrokerBuild</key><string>new</string></dict></plist>");
    const socket = join(dir, "old.sock");
    const fake = new FakeBroker({ socket, build: "old", bundlePath: path, helpers: {} });
    await fake.listen();
    const launches: string[] = [];
    const via = new Broker({
      wanted: () => true,
      spec: () => ({ name: "Old", id: "test.old", path, socket }),
      prepare: async () => null,
      launch: async (p) => void launches.push(p),
      log: () => {},
    });
    const got = await helperAppConn(via);
    assert.ok("conn" in got);
    assert.equal(got.hello?.build, "old");
    assert.equal(got.diskBuild, "new");
    got.conn.close();
    assert.deepEqual(launches, []);
    assert.equal(fake.quits, 0);
    assert.ok(!fake.ops.some((o) => o.op === "quit"));
    await fake.close();
  });
});

// Kiko speaking, shown as your own words are: the words said so far (the app keeps the newest in
// view), advancing as the sound plays, and the bars on the level of the sound being played.
describe("the overlay while Kiko speaks", () => {
  const said = { text: "Tests pass on main now.", name: "kiko-dev" };
  const speaking = { ...ui.state, speaking: true };
  const heard = (words: string[] | null, level = 0.7): Heard => ({ words, level });

  test("the words heard so far and the sound's level, as they advance: never the reply's start held for good", () => {
    const shown: OverlayState[] = [];
    let kept: Saying | null = null;
    const steps: Array<[string[], number]> = [
      [["Tests"], 0.71],
      [["Tests", "pass"], 0.12],
      [["Tests", "pass", "on", "main", "now."], 0.66],
    ];
    for (const [words, level] of steps) {
      kept = sayingNow(heard(words, level), said, 0, 0, kept);
      shown.push(overlayState(speaking, 0, said, 0, kept));
    }
    assert.deepEqual(shown, [
      { state: "speaking", session: "kiko-dev", text: "Tests", level: 0.7 },
      { state: "speaking", session: "kiko-dev", text: "Tests pass", level: 0.1 },
      { state: "speaking", session: "kiko-dev", text: "Tests pass on main now.", level: 0.65 },
    ]);
  });

  test("a long reply: all its words said so far go, newest last (the app cuts the head, as it does your words)", () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`);
    const text = overlayState(speaking, 0, said, 0, sayingNow(heard(words.slice(0, 45)), said, 0, 0, null)).text ?? "";
    assert.ok(text.startsWith("word0 ") && text.endsWith("word43 word44"), text);
    assert.ok(!text.includes("word45"), "nothing not yet said");
  });

  test("the level as listening sends it: to the nearest 0.05", () => {
    assert.equal(sayingNow(heard(["a"], 0.4321), said, 0, 0, null).level, 0.45);
    assert.equal(overlayState({ ...ui.state, listening: true, level: 0.4321 }, 0, null, 0).level, 0.45);
  });

  test("the mic still connecting (a Bluetooth one, 2026-11-12): said until your words come", () => {
    assert.equal(overlayState({ ...ui.state, listening: true, micConnecting: "AirPods" }, 0, null, 0).text, "Connecting to AirPods…");
    assert.equal(overlayState({ ...ui.state, listening: true, micConnecting: "AirPods", interim: "hello" }, 0, null, 0).text, "hello");
    assert.equal(overlayState({ ...ui.state, listening: true }, 0, null, 0).text, "");
  });

  test("the line played out (nothing heard): what was said stays, quiet", () => {
    const last = sayingNow(heard(["Tests", "pass"]), said, 0, 0, null);
    assert.deepEqual(sayingNow(null, said, 0, 5000, last), { text: "Tests pass", level: 0, fromSound: true });
  });

  test("the macOS voice (its sound isn't Kiko's to measure): its words at its pace, a steady level until they're said", () => {
    const at = (ms: number, kept: Saying | null = null) => sayingNow(null, said, 1000, 1000 + ms, kept);
    assert.deepEqual(at(0), { text: "Tests", level: SAY_LEVEL });
    assert.deepEqual(at(SAY_WORD_MS * 2 + 10), { text: "Tests pass on", level: SAY_LEVEL });
    // Timed, not from sound: it goes on advancing.
    assert.deepEqual(at(SAY_WORD_MS * 3 + 10, at(0)), { text: "Tests pass on main", level: SAY_LEVEL });
    assert.deepEqual(at(SAY_WORD_MS * 9), { text: "Tests pass on main now.", level: 0 });
  });

  test("sound but no words known (no read-along): its level, the words timed", () => {
    assert.deepEqual(sayingNow(heard(null, 0.33), said, 0, SAY_WORD_MS + 1, null), { text: "Tests pass", level: 0.35, fromSound: true });
  });

  test("nothing yet: the session alone, no words", () => {
    assert.deepEqual(overlayState(speaking, 0, said, 0), { state: "speaking", session: "kiko-dev", text: "", level: 0 });
  });
});
