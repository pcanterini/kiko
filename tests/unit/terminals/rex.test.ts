// The Rex adapter (src/terminals/rex/) on fakes: a session's block found by its process (the block
// its hook said first, while its process is in it; then the block whose front process or one
// under it is the session's), never by a title; Codex's by its program and folder; everything
// checked again before a word or key, and the send itself guarded by the process checked; listed
// only while a session may be in Rex and its server runs (no `rex` started otherwise); what Rex
// answers read whatever fields it has. The real Rex is in tests/live/terminals/rex-live.test.ts.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { terminalEnv } from "../../../hooks/lib.mjs";
import { noteTerminal, paneOf, terminalOf } from "../../../src/agents/claude-code/terminals.ts";
import { launchTerminal, sessionTerminal } from "../../../src/core/terminal-apps.ts";
import { matchBlocks, notReady, rexNeeded, rexTerminal, type RexDeps, type Sending } from "../../../src/terminals/rex/index.ts";
import {
  BLOCK_ID,
  INSPECT,
  LIST,
  parseCreated,
  parseInspect,
  parseList,
  parseScreen,
  parseSent,
  parseSessions,
  rexRunning,
  SEND,
  tabSession,
  type Block,
  type Inspected,
  type Sent,
} from "../../../src/terminals/rex/rex.ts";
import type { Findable, Place } from "../../../src/terminals/types.ts";

const S1 = "session:01a1ae00-b1c7-7cec-9baf-9cb5300d11b4";
const S2 = "session:01a1ae00-b1c7-7cec-9baf-9cb5300d11b5";
const id = (n: number) => `block:01a1ae00-e4c4-7864-9b47-${String(n).padStart(12, "0")}`;
const B1 = id(1);
const B2 = id(2);
const B3 = id(3);

const block = (fields: Partial<Block> = {}): Block => ({ session: S1, block: B1, pid: 200, name: "claude", cwd: "/code/pixie", up: [100, 90], title: "✳ Upload bug", exited: false, ...fields });
const inspected = (fields: Partial<Inspected> = {}): Inspected => ({ ...block(), paste: true, ...fields });
const session = (fields: Partial<Findable> = {}): Findable => ({
  sessionId: "s1",
  cwd: "/code/pixie",
  kind: "interactive",
  desktop: false,
  titles: ["Upload bug"],
  pid: 200,
  terminal: "rex",
  ...fields,
});
const at = (b: string, pid: number, more: Partial<Place> = {}): Place => ({ via: "rex", id: b, keys: true, pid, ...more });

/** A Rex adapter on fakes: what it asked of Rex, and what it sent. */
function fakeRex(
  o: {
    blocks?: Block[];
    listFails?: boolean;
    inspect?: (b: string, n: number) => Inspected | null;
    sent?: (n: number) => Sent;
    running?: boolean;
    installed?: boolean;
    sessions?: string[];
    own?: string | null;
  } = {},
) {
  const calls = { list: 0, inspect: 0, sessions: 0 };
  const sends: Array<{ block: string; what: Sending; pid: number }> = [];
  const runs: Array<{ session: string | null; cwd: string; argv: string[] }> = [];
  const waits: number[] = [];
  const d: RexDeps = {
    list: async () => {
      calls.list++;
      if (o.listFails) throw new Error("no server");
      return o.blocks ?? [block()];
    },
    inspect: async (b) => {
      calls.inspect++;
      return o.inspect ? o.inspect(b, calls.inspect) : inspected({ block: b });
    },
    send: async (b, what, pid) => {
      sends.push({ block: b, what, pid });
      return o.sent ? o.sent(sends.length) : { status: "sent" };
    },
    screen: async () => "the screen",
    sessions: async () => {
      calls.sessions++;
      return o.sessions ?? [S1, S2];
    },
    own: () => (o.own === undefined ? null : o.own),
    run: async (s, cwd, argv) => {
      runs.push({ session: s, cwd, argv });
      return B3;
    },
    installed: () => o.installed ?? true,
    running: () => o.running ?? true,
    wait: async (ms) => void waits.push(ms),
    shell: "/bin/zsh",
  };
  return { rex: rexTerminal(d), calls, sends, runs, waits };
}

describe("Rex: a session's block, by its process", () => {
  test("the block whose front process is the session's", () => {
    const found = matchBlocks([session()], [block({ block: B2, pid: 300, up: [] }), block()]);
    assert.deepEqual(found.get("s1"), { place: at(B1, 200), mapping: "process" });
  });

  test("the block where it's under what's in front (a process it started is in front): found, not typed into (notReady)", () => {
    const found = matchBlocks([session()], [block({ pid: 250, name: "vim", up: [200, 100, 90] })]);
    assert.deepEqual(found.get("s1"), { place: at(B1, 200), mapping: "process" });
    assert.equal(notReady(200, inspected({ pid: 250, up: [200, 100] })), "something else is in front of it in its pane");
  });

  test("the hinted block (its hook's REX_BLOCK) first, while its process is in it", () => {
    // Its process is in B2 only: B1, hinted, has another process now (the session moved, or the hint is stale).
    const blocks = [block({ pid: 999, up: [] }), block({ block: B2, pid: 200 })];
    assert.deepEqual(matchBlocks([session({ pane: B1 })], blocks).get("s1"), { place: at(B2, 200), mapping: "process" });
    assert.deepEqual(matchBlocks([session({ pane: B2 })], blocks).get("s1"), { place: at(B2, 200), mapping: "process" });
    // A hint that isn't a block id is passed over.
    assert.deepEqual(matchBlocks([session({ pane: "%12" })], blocks).get("s1"), { place: at(B2, 200), mapping: "process" });
  });

  test("gone: no block has its process, nothing found (and never a title guess, though a block has its title)", () => {
    const found = matchBlocks([session()], [block({ pid: 999, up: [998] })]);
    assert.equal(found.has("s1"), false);
  });

  test("two sessions in one block (one started inside the other): ambiguous, keys could reach either", () => {
    const found = matchBlocks([session(), session({ sessionId: "s2", pid: 250 })], [block({ pid: 250, up: [200, 100] })]);
    assert.deepEqual(found.get("s1"), { place: null, mapping: "ambiguous" });
    assert.deepEqual(found.get("s2"), { place: null, mapping: "ambiguous" });
  });

  test("its process in two blocks at once (Rex's answer stale): ambiguous", () => {
    const found = matchBlocks([session()], [block(), block({ block: B2 })]);
    assert.deepEqual(found.get("s1"), { place: null, mapping: "ambiguous" });
  });

  test("a block on Claude Code's agents list (parked with ←): agents, nothing typed there", () => {
    const found = matchBlocks([session()], [block({ title: "1 awaiting input · claude agents" })]);
    assert.deepEqual(found.get("s1"), { place: null, mapping: "agents" });
  });

  test("Codex's words as a bracketed paste: the place says so", () => {
    const found = matchBlocks([session({ bracketed: true })], [block()]);
    assert.deepEqual(found.get("s1")?.place, at(B1, 200, { bracketed: true }));
  });

  test("sessions known to be elsewhere, the desktop app's, background ones, T3 Code's: never matched", () => {
    const blocks = [block()];
    for (const s of [session({ terminal: "ghostty" }), session({ terminal: "kiko-tmux" }), session({ desktop: true }), session({ kind: "background" }), session({ agent: "t3code" })]) {
      assert.equal(matchBlocks([s], blocks).size, 0, JSON.stringify(s));
    }
    // Not known yet: looked for.
    assert.equal(matchBlocks([session({ terminal: undefined })], blocks).get("s1")?.mapping, "process");
  });
});

describe("Rex: a session whose process isn't known, by its program (Codex)", () => {
  const codex = (fields: Partial<Findable> = {}) => session({ pid: undefined, program: "codex", terminal: undefined, bracketed: true, ...fields });
  const codexBlock = (fields: Partial<Block> = {}) => block({ pid: 500, name: "codex", up: [100], ...fields });

  test("the only block in its folder running it, when it's the only such session there: only, its front process the place's", () => {
    const found = matchBlocks([codex()], [codexBlock(), codexBlock({ block: B2, cwd: "/code/other", pid: 501 })]);
    assert.deepEqual(found.get("s1"), { place: at(B1, 500, { bracketed: true }), mapping: "only" });
  });

  test("the hinted block (where it was opened or last found) while it runs it", () => {
    const blocks = [codexBlock(), codexBlock({ block: B2, pid: 501 })];
    assert.deepEqual(matchBlocks([codex({ pane: B2 })], blocks).get("s1"), { place: at(B2, 501, { bracketed: true }), mapping: "process" });
    // Without the hint: two blocks in its folder run it.
    assert.deepEqual(matchBlocks([codex()], blocks).get("s1"), { place: null, mapping: "ambiguous" });
  });

  test("two sessions in one folder, one block: ambiguous for both; a shell in front: not found", () => {
    const two = matchBlocks([codex(), codex({ sessionId: "s2" })], [codexBlock()]);
    assert.equal(two.get("s1")?.mapping, "ambiguous");
    assert.equal(two.get("s2")?.mapping, "ambiguous");
    assert.equal(matchBlocks([codex()], [codexBlock({ name: "zsh" })]).size, 0);
  });

  test("a block a session was found in by its process isn't another's by program", () => {
    const found = matchBlocks([session({ pid: 500, terminal: undefined }), codex({ sessionId: "s2" })], [codexBlock()]);
    assert.equal(found.get("s1")?.mapping, "process");
    assert.equal(found.has("s2"), false);
  });
});

describe("Rex, only when a session may be there (no `rex` started otherwise)", () => {
  test("every session known to be elsewhere: Rex never asked, again and again", async () => {
    const { rex, calls } = fakeRex();
    for (let i = 0; i < 3; i++) {
      const found = await rex.find(Promise.resolve([session({ terminal: "ghostty" }), session({ sessionId: "s2", terminal: "iterm" }), session({ sessionId: "s3", terminal: "kiko-tmux" })]));
      assert.equal(found.size, 0);
    }
    assert.deepEqual(calls, { list: 0, inspect: 0, sessions: 0 });
  });

  test("no sessions, or only the desktop app's, background ones and ones with nothing to find them by: nothing asked", async () => {
    const { rex, calls } = fakeRex();
    await rex.find(Promise.resolve([]));
    await rex.find(Promise.resolve([session({ desktop: true }), session({ kind: "background" }), session({ pid: undefined })]));
    assert.equal(calls.list, 0);
  });

  test("its server not running, or rex not installed: never asked, whatever the hooks said", async () => {
    for (const o of [{ running: false }, { installed: false }]) {
      const { rex, calls } = fakeRex(o);
      assert.equal((await rex.find(Promise.resolve([session(), session({ sessionId: "s2", terminal: undefined })]))).size, 0);
      assert.equal(calls.list, 0, JSON.stringify(o));
      assert.equal(rex.ready?.(), false);
    }
    assert.equal(rexNeeded([session()], { running: () => false, installed: () => true }), false);
  });

  test("a session its hook says is in Rex, or one not known yet while the server runs: one listing, found", async () => {
    const { rex, calls } = fakeRex();
    assert.equal((await rex.find(Promise.resolve([session()]))).get("s1")?.place?.id, B1);
    assert.equal((await rex.find(Promise.resolve([session({ terminal: undefined })]))).get("s1")?.place?.id, B1);
    assert.equal(calls.list, 2);
    assert.equal(calls.inspect, 0, "finding looks at no block on its own");
  });

  test("Rex not answering: nothing found, nothing thrown", async () => {
    const { rex, calls } = fakeRex({ listFails: true });
    assert.equal((await rex.find(Promise.resolve([session()]))).size, 0);
    assert.equal(calls.list, 1);
  });

  test("the real one never finds a server in the tests (KIKO_REX_SOCKET points nowhere)", () => {
    assert.equal(rexRunning(), false);
  });
});

describe("Rex: typing, checked again first, the send guarded by the process checked", () => {
  test("one line into Claude Code: typed (not a paste), then Enter on its own after a moment, both guarded by its process", async () => {
    const { rex, sends, waits, calls } = fakeRex();
    assert.deepEqual(await rex.type(at(B1, 200), "fix the upload bug"), { sent: true });
    assert.deepEqual(sends, [
      { block: B1, what: { text: "fix the upload bug", paste: false }, pid: 200 },
      { block: B1, what: { key: { key: "enter", text: "\r" } }, pid: 200 },
    ]);
    assert.deepEqual(waits, [150]);
    assert.equal(calls.inspect, 2, "looked at before the words and again before Enter");
  });

  test("several lines: one bracketed paste, while its program asks for one", async () => {
    const { rex, sends } = fakeRex();
    await rex.type(at(B1, 200), "first\r\nsecond\tthird\u0007");
    assert.deepEqual(sends[0].what, { text: "first\nsecond third", paste: true });
  });

  test("several lines where its program doesn't ask for bracketed paste: one line, never a newline that would send early", async () => {
    const { rex, sends } = fakeRex({ inspect: (b) => inspected({ block: b, paste: false }) });
    await rex.type(at(B1, 200), "first\n  second");
    assert.deepEqual(sends[0].what, { text: "first second", paste: false });
  });

  test("a session that wants a bracketed paste (Codex): one line too, as one, when its program asks for it", async () => {
    const asks = fakeRex();
    await asks.rex.type(at(B1, 200, { bracketed: true }), "hello");
    assert.deepEqual(asks.sends[0].what, { text: "hello", paste: true });
    const doesnt = fakeRex({ inspect: (b) => inspected({ block: b, paste: false }) });
    await doesnt.rex.type(at(B1, 200, { bracketed: true }), "hello");
    assert.deepEqual(doesnt.sends[0].what, { text: "hello", paste: false });
  });

  test("one long line (a dictation over 512 bytes): Rex's paste event while its program asks for one, typed where it doesn't", async () => {
    const long = "word ".repeat(220).trim();
    const asks = fakeRex();
    await asks.rex.type(at(B1, 200), long);
    assert.deepEqual(asks.sends[0].what, { text: long, paste: true });
    assert.deepEqual(asks.sends[1].what, { key: { key: "enter", text: "\r" } });
    const doesnt = fakeRex({ inspect: (b) => inspected({ block: b, paste: false }) });
    await doesnt.rex.type(at(B1, 200), long);
    assert.deepEqual(doesnt.sends[0].what, { text: long, paste: false });
    // Counted in bytes: 200 characters of three bytes each are 600.
    const wide = fakeRex();
    await wide.rex.type(at(B1, 200), "語".repeat(200));
    assert.equal((wide.sends[0].what as { paste: boolean }).paste, true);
  });

  test("its process moved out of the block (or another one is in front): refused, nothing sent", async () => {
    for (const [now, why] of [
      [inspected({ pid: 999, up: [998] }), "it isn't running in that Rex pane any more"],
      [inspected({ pid: 250, up: [200] }), "something else is in front of it in its pane"],
      [null, "its Rex pane has closed"],
      [inspected({ title: "claude agents" }), "its pane is showing Claude Code's agents list"],
    ] as const) {
      const { rex, sends } = fakeRex({ inspect: () => now });
      assert.deepEqual(await rex.type(at(B1, 200), "hi"), { sent: false, why });
      assert.deepEqual(sends, []);
    }
  });

  test("no process to check, or not a block id: refused without asking Rex", async () => {
    const { rex, calls, sends } = fakeRex();
    assert.deepEqual(await rex.type({ via: "rex", id: B1, keys: true }, "hi"), { sent: false, why: "I don't know its process" });
    assert.deepEqual(await rex.type(at("%12", 200), "hi"), { sent: false, why: "its Rex pane isn't one I know" });
    assert.equal(calls.inspect, 0);
    assert.deepEqual(sends, []);
  });

  test("Rex finds a different process in front as it sends (its guard): nothing went in, said so", async () => {
    const { rex } = fakeRex({ sent: () => ({ status: "changed" }) });
    assert.deepEqual(await rex.type(at(B1, 200), "hi"), { sent: false, why: "its pane changed just as I typed, so nothing went in" });
  });

  test("it changed before Enter: typed, not sent, and said so; no Enter pressed", async () => {
    const { rex, sends } = fakeRex({ inspect: (b, n) => (n === 1 ? inspected({ block: b }) : inspected({ block: b, pid: 999, up: [] })) });
    assert.deepEqual(await rex.type(at(B1, 200), "hi"), { sent: false, why: "it isn't running in that Rex pane any more, so I typed it but didn't send it" });
    assert.equal(sends.length, 1);
  });

  test("Rex refused the Enter: typed, not sent, its error kept", async () => {
    const { rex } = fakeRex({ sent: (n) => (n === 1 ? { status: "sent" } : { status: "failed", error: "bad_request" }) });
    assert.deepEqual(await rex.type(at(B1, 200), "hi"), { sent: false, why: "Rex didn't take it, so I typed it but didn't send it", error: "bad_request" });
  });

  test("Rex not answering the look: refused", async () => {
    const { rex, sends } = fakeRex({
      inspect: () => {
        throw new Error("timeout");
      },
    });
    assert.deepEqual(await rex.type(at(B1, 200), "hi"), { sent: false, why: "Rex didn't answer" });
    assert.deepEqual(sends, []);
  });
});

describe("Rex: keys", () => {
  test("Escape, Shift+Tab and the arrows as Rex's key events, guarded by its process", async () => {
    const { rex, sends } = fakeRex();
    for (const key of ["escape", "shift+tab", "down", "Enter"]) assert.deepEqual(await rex.key!(at(B1, 200), key), { sent: true });
    assert.deepEqual(
      sends.map((s) => s.what),
      [{ key: { key: "escape" } }, { key: { key: "tab", mods: "shift" } }, { key: { key: "arrow_down" } }, { key: { key: "enter", text: "\r" } }],
    );
    assert.ok(sends.every((s) => s.pid === 200 && s.block === B1));
  });

  test("refused when its process has moved: no key sent", async () => {
    const { rex, sends } = fakeRex({ inspect: () => inspected({ pid: 300, up: [] }) });
    assert.deepEqual(await rex.key!(at(B1, 200), "escape"), { sent: false, why: "it isn't running in that Rex pane any more" });
    assert.deepEqual(sends, []);
  });

  test("a key it doesn't know: refused", async () => {
    const { rex, sends } = fakeRex();
    assert.deepEqual(await rex.key!(at(B1, 200), "C-x"), { sent: false, why: "I don't know the key C-x" });
    assert.deepEqual(sends, []);
  });
});

describe("Rex: a block it opened, while its session starts", () => {
  test("program: its command, the shell again, or gone", async () => {
    const states = [inspected({ name: "claude" }), inspected({ name: "zsh" }), inspected({ name: "-zsh" }), null, inspected({ pid: undefined, exited: true })];
    const got: string[] = [];
    for (const s of states) got.push(await fakeRex({ inspect: () => s }).rex.program!(B1));
    assert.deepEqual(got, ["running", "shell", "shell", "gone", "gone"]);
    assert.equal(await fakeRex().rex.program!("%1"), "gone");
  });

  test("placeIn: what's in front there, as a place type checks", async () => {
    assert.deepEqual(await fakeRex({ inspect: () => inspected({ pid: 321 }) }).rex.placeIn!(B1), at(B1, 321));
    assert.equal(await fakeRex({ inspect: () => null }).rex.placeIn!(B1), null);
    assert.equal(await fakeRex().rex.placeIn!("nope"), null);
  });

  test("press: only while its program (not the shell) is in front, guarded by that process", async () => {
    const running = fakeRex({ inspect: () => inspected({ pid: 321, name: "2.1.318" }) });
    assert.deepEqual(await running.rex.press!(B1, "down"), { sent: true });
    assert.deepEqual(running.sends, [{ block: B1, what: { key: { key: "arrow_down" } }, pid: 321 }]);
    const shell = fakeRex({ inspect: () => inspected({ name: "zsh" }) });
    assert.deepEqual(await shell.rex.press!(B1, "enter"), { sent: false, why: "its program has ended" });
    assert.deepEqual(shell.sends, []);
    assert.deepEqual(await fakeRex({ inspect: () => null }).rex.press!(B1, "enter"), { sent: false, why: "its Rex pane has closed" });
  });

  test("screen: read only for a block id", async () => {
    assert.equal(await fakeRex().rex.screen!(B1), "the screen");
    assert.equal(await fakeRex().rex.screen!("%1"), null);
  });

  test("open: a new tab in the session Kiko was started from, in the login shell, left in it after; its block told", async () => {
    const { rex, runs } = fakeRex({ own: S2 });
    const opened: string[] = [];
    assert.equal(await rex.open!("/code/pixie", { program: "claude", args: ["--name", "pixie one"] }, (h) => opened.push(h)), undefined);
    assert.deepEqual(opened, [B3]);
    assert.deepEqual(runs, [{ session: S2, cwd: "/code/pixie", argv: ["/bin/zsh", "-l", "-i", "-c", "claude --name 'pixie one'; exec /bin/zsh -l"] }]);
  });

  test("open: else the first session; with none, a new one, said", async () => {
    const first = fakeRex({ own: "session:gone" });
    await first.rex.open!("/c", { program: "claude", args: [] });
    assert.equal(first.runs[0].session, S1);
    const none = fakeRex({ sessions: [] });
    assert.match(String(await none.rex.open!("/c", { program: "claude", args: [] })), /new Rex session/);
    assert.equal(none.runs[0].session, null);
    assert.equal(tabSession([S1, S2], S2), S2);
    assert.equal(tabSession([S1], S2), S1);
    assert.equal(tabSession([], null), null);
  });
});

describe("Rex's answers, read whatever fields they have", () => {
  test("a listing: rows without ids, with odd fields, or missing ones are passed over or defaulted", () => {
    const out = JSON.stringify({
      blocks: [
        { session: S1, block: B1, pid: 200, name: "claude", cwd: "/x", up: [100, "x", -1, 3.5], title: "t", exited: false, extra: { a: 1 } },
        { session: S1, block: B2 },
        { session: S1, block: "block:nope", pid: 1 },
        { block: B3, pid: 1 },
        "junk",
        null,
        { session: S2, block: B3, pid: "300", up: {}, title: 7 },
      ],
    });
    assert.deepEqual(parseList(out), [
      { session: S1, block: B1, pid: 200, name: "claude", cwd: "/x", up: [100], title: "t", exited: false },
      { session: S1, block: B2, up: [], title: "", exited: false },
      { session: S2, block: B3, up: [], title: "", exited: false },
    ]);
    // An empty Lua table comes back as {}; not JSON at all; nothing.
    assert.deepEqual(parseList('{"blocks":{}}'), []);
    assert.deepEqual(parseList("Error: no server"), []);
    assert.deepEqual(parseList(""), []);
  });

  test("a block looked at: its bracketed paste, or gone", () => {
    assert.deepEqual(parseInspect(JSON.stringify({ block: { session: S1, block: B1, pid: 5, paste: true } })), { session: S1, block: B1, pid: 5, up: [], title: "", exited: false, paste: true });
    assert.equal(parseInspect(JSON.stringify({ block: { session: S1, block: B1, paste: "yes" } }))?.paste, false);
    assert.equal(parseInspect('{"gone":true}'), null);
    assert.equal(parseInspect("[]"), null);
  });

  test("a send's answer: anything but sent, changed or gone is a failure, with what was said", () => {
    assert.deepEqual(parseSent('{"status":"sent"}'), { status: "sent" });
    assert.deepEqual(parseSent('{"status":"changed"}'), { status: "changed" });
    assert.deepEqual(parseSent('{"status":"failed","error":"bad_request"}'), { status: "failed", error: "bad_request" });
    assert.equal(parseSent('{"status":"maybe"}').status, "failed");
    assert.equal(parseSent("garbage").status, "failed");
  });

  test("a screen: its own rows only, trailing spaces gone; gone is null", () => {
    const content = `${Array.from({ length: 30 }, (_, i) => `line ${i}   `).join("\n")}\n`;
    const screen = parseScreen(JSON.stringify({ content, rows: 24 }))!;
    assert.equal(screen.split("\n").length, 24);
    assert.equal(screen.split("\n")[0], "line 6");
    assert.equal(parseScreen(JSON.stringify({ content: "a  \nb" })), "a\nb");
    assert.equal(parseScreen('{"gone":true}'), null);
  });

  test("sessions, and a new block from `rex run` or `rex new`", () => {
    assert.deepEqual(parseSessions(JSON.stringify({ sessions: [S1, "nope", 3] })), [S1]);
    assert.deepEqual(parseSessions('{"sessions":{}}'), []);
    assert.equal(parseCreated(JSON.stringify({ window_id: "window:x", block_ids: [B1] })), B1);
    assert.equal(parseCreated(JSON.stringify({ session_id: S1, initial_windows: [{ block_ids: [B2] }] })), B2);
    assert.equal(parseCreated(JSON.stringify({ block_ids: ["block:../etc"] })), null);
    assert.equal(parseCreated("nope"), null);
  });

  test("the scripts give back only what Kiko reads: never a process's argv0, script or command line", () => {
    for (const code of [LIST, INSPECT, SEND]) {
      assert.doesNotMatch(code, /argv0|\.script\b|invoked_path|\.argv\b/);
      // Never a server started for it, nor the user's own block assumed: every block named.
      assert.doesNotMatch(code, /rex\.block_id|rex\.session_id/);
    }
  });
});

describe("Rex in the hooks: the block a session runs in", () => {
  const block = "block:01a1ae00-e4c4-7864-9b47-fab3c6caa635";

  test("REX_BLOCK is passed on only when it's a block id, cut to its length", () => {
    assert.deepEqual(terminalEnv({ TERM_PROGRAM: "rex", REX_BLOCK: block }), { program: "rex", rex: block });
    for (const bad of ["block:nope", `${block}x`, `${block};rm -rf`, "", "%12", `block:${"a".repeat(200)}`]) {
      assert.equal(terminalEnv({ TERM_PROGRAM: "rex", REX_BLOCK: bad }).rex, undefined, bad);
    }
  });

  test("kept for a session in Rex, as its pane; ignored for one elsewhere (a tmux of your own started in Rex)", () => {
    assert.equal(noteTerminal("rex-a", { program: "rex", rex: block }), true);
    assert.equal(terminalOf("rex-a"), "rex");
    assert.equal(paneOf("rex-a"), block);
    assert.equal(noteTerminal("rex-a", { program: "rex", rex: block }), false, "the same again changes nothing");
    assert.equal(noteTerminal("rex-b", { program: "tmux", rex: block }), true);
    assert.equal(paneOf("rex-b"), undefined);
    noteTerminal("rex-c", { program: "rex", rex: "block:bogus" });
    assert.equal(paneOf("rex-c"), undefined);
    assert.ok(BLOCK_ID.test(block));
  });

  test("Rex is a terminal app: by TERM_PROGRAM (its shells have no bundle id), or its bundle id", () => {
    assert.equal(sessionTerminal({ program: "rex" }), "rex");
    assert.equal(sessionTerminal({ bundle: "com.superlogical.rex" }), "rex");
    assert.equal(sessionTerminal({ program: "rex", kiko: true }), "kiko-tmux");
    assert.equal(launchTerminal({ TERM_PROGRAM: "rex" }), "rex");
  });
});
