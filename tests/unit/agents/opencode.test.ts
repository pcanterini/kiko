// The OpenCode adapter's parts (src/agents/opencode/): its background service's file read (loopback
// only), its client against a fake service of this test's (tests/support/fake-opencode.ts: never
// the real OpenCode), what's open read from its TUIs' processes and tabs, its permissions, questions
// and turns as Kiko holds them, its setup (Kiko's own settings, nothing of OpenCode's), the
// agent adapter that sends it words, and "start an OpenCode session" picking it only when it's said.
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { agentOf, agents, starters } from "../../../src/agents/index.ts";
import { atOpenCodePrompt, opencode } from "../../../src/agents/opencode/index.ts";
import { tuisOf, type Tui } from "../../../src/agents/opencode/processes.ts";
import { lstartMs, parsePs, stillRuns } from "../../../src/agents/processes.ts";
import {
  BATCH_MS,
  endedBy,
  formAnswer,
  OpenCodeHeld,
  OpenCodeTurn,
  permissionOf,
  questionsOf,
  repliedHow,
  repliedOf,
  RuleBlocks,
  toolOf,
  turnOf,
  type Reply,
} from "../../../src/agents/opencode/requests.ts";
import { blockedLine } from "../../../src/core/permission-mode.ts";
import { loopback, messageOf, OpenCodeService, readService, sessionOf, type OpenCodeEvent, type OpenCodeSession } from "../../../src/agents/opencode/service.ts";
import { describe as describeOpen, openSessions, readTabs } from "../../../src/agents/opencode/sessions.ts";
import { opencodeSetup } from "../../../src/agents/opencode/setup.ts";
import { cardRows, outcomeMessage, connectOne, SETUPS, statusOf } from "../../../src/agents/setup.ts";
import { agentMessages } from "../../../src/terminals/agent/index.ts";
import { terminals } from "../../../src/terminals/index.ts";
import { opencodeOneShot } from "../../../src/cli-args.ts";
import { namedAgent } from "../../../src/core/decide.ts";
import { ASKED_FOR_NEW } from "../../../src/core/routing-rules.ts";
import { agentChoices } from "../../../src/core/settings-options.ts";
import { linkAgent, loadSettings } from "../../../src/core/settings.ts";
import type { History } from "../../../src/core/history.ts";
import { FakeOpenCode } from "../../support/fake-opencode.ts";
import { checkWaits } from "../../support/until.ts";

const serviceFile = process.env.KIKO_OPENCODE_SERVICE!;
const until = checkWaits(3000, 20);

describe("OpenCode's service file", () => {
  test("a loopback url only: the password is never sent elsewhere", () => {
    assert.equal(loopback("http://127.0.0.1:49374"), "http://127.0.0.1:49374");
    assert.equal(loopback("http://localhost:4096/"), "http://localhost:4096");
    assert.equal(loopback("http://0.0.0.0:4096"), "http://127.0.0.1:4096", "a wildcard bind is reached on loopback");
    assert.equal(loopback("http://example.com:4096"), null);
    assert.equal(loopback("https://127.0.0.1:4096"), null);
    assert.equal(loopback("not a url"), null);
  });

  test("read as the service writes it; none, broken or remote: null; the password never prints", () => {
    const file = join(process.cwd(), "svc", "service.json");
    mkdirSync(join(process.cwd(), "svc"), { recursive: true });
    assert.equal(readService(file), null, "no file: not running");
    writeFileSync(file, JSON.stringify({ id: "x", version: "2.0.32", url: "http://127.0.0.1:5", pid: 42, password: "hunter2-secret" }));
    const info = readService(file)!;
    assert.deepEqual({ url: info.url, pid: info.pid, version: info.version }, { url: "http://127.0.0.1:5", pid: 42, version: "2.0.32" });
    assert.equal(info.password.reveal(), "hunter2-secret");
    assert.ok(!JSON.stringify(info).includes("hunter2"), "redacted in JSON");
    assert.ok(!String(info.password).includes("hunter2"));
    writeFileSync(file, JSON.stringify({ url: "http://10.0.0.2:5", password: "p" }));
    assert.equal(readService(file), null, "not this Mac's");
    writeFileSync(file, "{nope");
    assert.equal(readService(file), null);
  });
});

describe("its shapes, as OpenCode 2.0.32 gives them", () => {
  test("a session: its folder, title (not the placeholder), parent and times", () => {
    const s = sessionOf({ id: "ses_1", title: "Fix login", location: { directory: "/x/pixie" }, time: { created: 1, updated: 5, viewed: 3 } })!;
    assert.deepEqual(s, { id: "ses_1", title: "Fix login", cwd: "/x/pixie", parentId: null, created: 1, updated: 5, viewed: 3, archived: false });
    assert.equal(sessionOf({ id: "ses_2", title: "New session - 2026-10-30T07:59:32.123Z", location: { directory: "/x" }, time: {} })!.title, "", "the placeholder isn't a name");
    assert.equal(sessionOf({ id: "ses_3", parentID: "ses_1", location: { directory: "/x" }, time: {} })!.parentId, "ses_1");
    assert.equal(sessionOf({ id: "ses_4" }), null, "no folder");
  });

  test("messages: users' words, an assistant's text parts together (not its reasoning or tools), the idle marker", () => {
    assert.deepEqual(messageOf({ id: "m1", type: "user", text: " hi ", time: { created: 2 } }), { id: "m1", role: "user", text: "hi", at: 2 });
    const a = messageOf({
      id: "m2",
      type: "assistant",
      content: [
        { type: "reasoning", text: "hmm" },
        { type: "text", text: "Done." },
        { type: "tool", name: "shell" },
        { type: "text", text: "Tests pass." },
      ],
      time: { created: 3 },
    })!;
    assert.equal(a.text, "Done.\n\nTests pass.");
    assert.equal(a.writing, true, "no completed time, finish or error: still being written");
    assert.equal(messageOf({ id: "m4", type: "assistant", content: [{ type: "text", text: "Done." }], time: { created: 3, completed: 9 } })!.writing, undefined);
    assert.equal(messageOf({ id: "m5", type: "assistant", content: [], finish: "stop", time: { created: 3 } })!.writing, undefined);
    assert.equal(messageOf({ id: "m3", type: "idle", outcome: "succeeded", time: { created: 4 } })!.role, "idle");
  });

  test("a turn's words, newest first: its last reply, what you asked, all you said since the turn before", () => {
    const t = turnOf([
      { role: "idle", text: "" },
      { role: "assistant", text: "" },
      { role: "assistant", text: "All green." },
      { role: "user", text: "and the docs" },
      { role: "assistant", text: "Working…" },
      { role: "user", text: "run the tests" },
      { role: "idle", text: "" },
      { role: "user", text: "an older turn" },
    ]);
    assert.deepEqual(t, { said: "All green.", asked: "and the docs", turn: ["run the tests", "and the docs"] });
  });
});

describe("its TUIs, from ps and lsof", () => {
  test("ps lines read; lstart in ms", () => {
    const rows = parsePs("  901 ttys003  Thu Oct 30 00:45:12 2026     /Users/me/.opencode/bin/opencode\n  77 ??       Fri Oct  2 09:01:02 2026     /Users/me/.opencode/bin/opencode\n");
    assert.deepEqual(rows[0], { pid: 901, tty: "ttys003", lstart: "Thu Oct 30 00:45:12 2026", comm: "/Users/me/.opencode/bin/opencode" });
    assert.equal(rows[1].lstart, "Fri Oct 2 09:01:02 2026");
    assert.equal(lstartMs("Thu Oct 30 00:45:12 2026"), Date.UTC(2026, 9, 30, 0, 45, 12));
    assert.equal(lstartMs("nonsense"), 0);
  });

  test("a TUI has a terminal, is opencode, isn't the service, and has a folder", () => {
    const rows = parsePs(
      [
        "10 ttys001 Thu Oct 30 00:45:12 2026 /bin/opencode",
        "11 ?? Thu Oct 30 00:45:12 2026 /bin/opencode",
        "12 ttys002 Thu Oct 30 00:45:12 2026 /bin/opencode",
        "13 ttys003 Thu Oct 30 00:45:12 2026 /bin/node",
        "14 ttys004 Thu Oct 30 00:45:12 2026 opencode",
      ].join("\n"),
    );
    const tuis = tuisOf(
      rows,
      new Map([
        [10, "/x/a"],
        [11, "/Users/me"],
        [12, "/x/b"],
        [13, "/x/c"],
      ]),
      12,
    );
    assert.deepEqual(
      tuis.map((t) => [t.pid, t.cwd]),
      [[10, "/x/a"]],
      "11 has no terminal (the service runs detached), 12 is the service, 13 isn't opencode, 14 has no folder",
    );
  });
});

describe("which sessions are open", () => {
  const tui = (pid: number, cwd: string, startedAt: number): Tui => ({ pid, cwd, procStart: "T", startedAt });
  const ses = (id: string, cwd: string, at: number, o: Partial<OpenCodeSession> = {}): OpenCodeSession => ({
    id,
    title: "",
    cwd,
    parentId: null,
    created: at,
    updated: at,
    viewed: 0,
    archived: false,
    ...o,
  });

  test("touched since its TUI started; the newest is in front and gets the TUI's process; a tab from before isn't open by itself", () => {
    const open = openSessions(
      [tui(10, "/x/a", 100_000)],
      new Map([["/x/a", [ses("old", "/x/a", 1000), ses("tab", "/x/a", 2000), ses("new", "/x/a", 150_000), ses("looked", "/x/a", 3000, { viewed: 120_000 })]]]),
      new Map([["/x/a", new Set(["tab"])]]),
      200_000,
    );
    assert.deepEqual(
      open.map((o) => [o.session.id, o.tui?.pid ?? null]),
      [
        ["new", 10],
        ["looked", null],
      ],
    );
    assert.deepEqual(
      open[0].tuis.map((t) => t.pid),
      [10],
      "open while that TUI runs",
    );
  });

  test('its TUI quit, so "Greeting" isn\'t open; a new TUI there (its old tab shown again) lists only the session it makes, also titled "Greeting"', () => {
    // At the start: a TUI in lacy-platform, its first message making "Greeting".
    const t0 = Date.UTC(2026, 9, 30, 17, 46, 0);
    const first = tui(501, "/x/lacy-platform", t0);
    const old = ses("ses_e7214c279ffe3xu3KscUyHT6x8", "/x/lacy-platform", t0 + 6000, { title: "Greeting", updated: t0 + 118_000, viewed: t0 + 118_000 });
    const inFolder = new Map([["/x/lacy-platform", [old]]]);
    const tabs = new Map([["/x/lacy-platform", new Set([old.id])]]);
    assert.deepEqual(
      openSessions([first], inFolder, tabs, t0 + 120_000).map((o) => [o.session.id, o.tui?.pid]),
      [[old.id, 501]],
    );
    // Quit: the service keeps it, but no TUI runs there.
    assert.deepEqual(openSessions([], inFolder, tabs, t0 + 200_000), []);
    // Six minutes on: a new TUI there shows its tabs again (OpenCode keeps them from one run to the next); nothing typed yet.
    const second = tui(98962, "/x/lacy-platform", t0 + 368_000);
    assert.deepEqual(openSessions([second], inFolder, tabs, t0 + 474_000), [], "not open: the phone's words then have nowhere to go");
    // Two minutes later: its first message makes another, which OpenCode titles "Greeting" too; both are tabs now.
    const made = ses("ses_e720d3716ffeEn2YIzCBeOLrj4", "/x/lacy-platform", t0 + 501_000, { title: "Greeting" });
    const both = new Map([["/x/lacy-platform", [made, old]]]);
    const bothTabs = new Map([["/x/lacy-platform", new Set([old.id, made.id])]]);
    assert.deepEqual(
      openSessions([second], both, bothTabs, t0 + 502_000).map((o) => [o.session.id, o.session.title, o.tui?.pid]),
      [[made.id, "Greeting", 98962]],
      'only the open "Greeting"',
    );
  });

  test("tabs on there: one used since that's no longer a tab (closed there, another client's) isn't open, unless it was made a moment ago", () => {
    const open = openSessions(
      [tui(10, "/x/a", 100_000)],
      new Map([["/x/a", [ses("tabbed", "/x/a", 150_000), ses("closed", "/x/a", 110_000, { updated: 160_000 }), ses("just-made", "/x/a", 195_000)]]]),
      new Map([["/x/a", new Set(["tabbed"])]]),
      200_000,
    );
    assert.deepEqual(
      open.map((o) => o.session.id),
      ["just-made", "tabbed"],
    );
    const off = openSessions([tui(10, "/x/a", 100_000)], new Map([["/x/a", [ses("s1", "/x/a", 150_000), ses("s2", "/x/a", 160_000)]]]), new Map([["/x/a", new Set(["older"])]]), 400_000);
    assert.deepEqual(
      off.map((o) => o.session.id),
      ["s2", "s1"],
      "none used this run is a tab (tabs off there): all it used",
    );
  });

  test("a TUI whose start couldn't be read: nothing in its folder listed (unsure)", () => {
    assert.deepEqual(openSessions([tui(10, "/x/a", 0)], new Map([["/x/a", [ses("s1", "/x/a", 150_000)]]]), new Map(), 200_000), []);
    assert.deepEqual(openSessions([tui(10, "/x/a", 0), tui(11, "/x/a", 100_000)], new Map([["/x/a", [ses("s1", "/x/a", 150_000)]]]), new Map(), 200_000), []);
  });

  test("two TUIs in one folder: listed, neither with a process (no guessing which), open while either runs; no TUI: nothing", () => {
    const open = openSessions(
      [tui(10, "/x/a", 100_000), tui(11, "/x/a", 110_000)],
      new Map([
        ["/x/a", [ses("s1", "/x/a", 120_000)]],
        ["/x/b", [ses("s2", "/x/b", 200_000)]],
      ]),
      new Map(),
    );
    assert.deepEqual(
      open.map((o) => [o.session.id, o.tui, o.tuis.map((t) => t.pid)]),
      [["s1", null, [10, 11]]],
    );
  });

  test("a TUI still runs (signal 0, nothing run); one that's gone doesn't", async () => {
    assert.equal(stillRuns(process.pid), true);
    const child = spawn(process.execPath, ["-e", ""]);
    await new Promise((r) => child.on("exit", r));
    assert.equal(stillRuns(child.pid!), false);
  });

  test("a tab kept for every folder counts in each; tabs.json read from each channel, never written", () => {
    const dir = process.env.KIKO_OPENCODE_STATE!;
    mkdirSync(join(dir, "latest", "tui"), { recursive: true });
    const file = join(dir, "latest", "tui", "tabs.json");
    const text = JSON.stringify({ global: { tabs: [{ sessionID: "g1" }], unread: {} }, cwd: { "/x/a": { tabs: [{ sessionID: "a1", title: "A" }], unread: {} } } });
    writeFileSync(file, text);
    const tabs = readTabs();
    assert.deepEqual([...tabs.get("")!], ["g1"]);
    assert.deepEqual([...tabs.get("/x/a")!], ["a1"]);
    assert.equal(readFileSync(file, "utf8"), text);
  });

  test("described: its title as given name, OpenCode's terminal title, its TUI's process for the one in front", () => {
    const s = describeOpen({ session: ses("ses_9", "/x/pixie", 5, { title: "Login fix" }), tui: tui(10, "/x/pixie", 1), tuis: [tui(10, "/x/pixie", 1)] }, "busy");
    assert.equal(s.name, "pixie");
    assert.equal(s.givenName, "Login fix");
    assert.deepEqual(s.titles, ["OC | Login fix"]);
    assert.equal(s.pid, 10);
    assert.equal(s.agent, "opencode");
    assert.equal(s.status, "busy");
    assert.equal(describeOpen({ session: ses("ses_9", "/x/pixie", 5), tui: null, tuis: [] }, "idle").pid, undefined);
  });
});

describe("its permissions and questions, as Kiko holds them", () => {
  test("a permission's tool in Claude Code's shape", () => {
    assert.deepEqual(toolOf("shell", ["npm test", "git status"], {}), { name: "Bash", input: { command: "npm test; git status" } });
    assert.deepEqual(toolOf("edit", ["src/login.ts"], {}), { name: "Edit", input: { file_path: "src/login.ts" } });
    assert.deepEqual(toolOf("webfetch", ["https://x.dev"], {}), { name: "WebFetch", input: { url: "https://x.dev" } });
    assert.deepEqual(toolOf("github_create_issue", ["*"], { input: { title: "x" } }), { name: "github_create_issue", input: { title: "x" } });
    const p = permissionOf({ id: "per_1", sessionID: "ses_1", action: "shell", resources: ["rm -rf dist"], save: ["rm *"] })!;
    assert.equal(p.canAlways, true);
    assert.equal(permissionOf({ id: "per_2", sessionID: "ses_1", action: "edit", resources: ["a.ts"] })!.canAlways, false, "nothing to save: no always");
    assert.equal(permissionOf({ id: "per_3" }), null);
  });

  test("a call your deny rules stopped (no prompt; permission.rejected) is a block, with its tool; one you rejected at a prompt, or a failure of another kind, isn't", () => {
    const blocks = new RuleBlocks();
    const call = (id: string, name: string, input: Record<string, unknown>) => {
      assert.equal(blocks.seen("session.tool.input.started", { sessionID: "ses_1", assistantMessageID: "msg_1", id, name }), null);
      assert.equal(blocks.seen("session.tool.called", { sessionID: "ses_1", assistantMessageID: "msg_1", id, input, executed: false }), null);
    };
    const failed = (id: string, error: Record<string, unknown>) => blocks.seen("session.tool.failed", { sessionID: "ses_1", assistantMessageID: "msg_1", id, error, executed: false });
    // A deny rule: OpenCode's BlockedError, "Permission denied: <action>".
    call("call_1", "shell", { command: "rm -rf build" });
    assert.deepEqual(failed("call_1", { type: "permission.rejected", message: "Permission denied: shell" }), {
      sessionId: "ses_1",
      callId: "call_1",
      tool: { name: "Bash", input: { command: "rm -rf build" } },
      reason: "Permission denied: shell",
    });
    // Asked, and rejected with words there (CorrectedError): the same failure, but not a block.
    call("call_2", "shell", { command: "git push --force" });
    assert.equal(
      blocks.seen("permission.asked", { id: "per_1", sessionID: "ses_1", action: "shell", resources: ["git push --force"], source: { type: "tool", messageID: "msg_1", id: "call_2" } }),
      null,
    );
    assert.equal(failed("call_2", { type: "permission.rejected", message: "not on main" }), null);
    // Another failure; a success; a write and a fetch in Claude Code's shape.
    call("call_3", "shell", { command: "npm test" });
    assert.equal(failed("call_3", { type: "tool.execution", message: "exit 1" }), null);
    call("call_4", "write", { path: "/x/.env.production", content: "…" });
    assert.deepEqual(failed("call_4", { type: "permission.rejected", message: "Permission denied: write" })?.tool, { name: "Write", input: { file_path: "/x/.env.production" } });
    call("call_5", "webfetch", { url: "https://api.cloudflare.com" });
    assert.deepEqual(failed("call_5", { type: "permission.rejected", message: "Permission denied: webfetch" })?.tool, { name: "WebFetch", input: { url: "https://api.cloudflare.com" } });
    call("call_6", "read", { path: "a.ts" });
    assert.equal(blocks.seen("session.tool.success", { sessionID: "ses_1", id: "call_6", content: [{ type: "text", text: "x" }], executed: false }), null);
    // A call it never saw begin: still a block, its tool unknown.
    assert.deepEqual(failed("call_7", { type: "permission.rejected", message: "Permission denied: github_create_issue" })?.tool, { name: "a tool", input: {} });
    // Said, plainly, with why it isn't offered.
    assert.equal(blockedLine("Lacy", { tool: { name: "Bash", input: { command: "rm -rf build" } }, reason: "", by: "rule" }), "Your OpenCode permissions blocked Lacy from running rm -rf build.");
  });

  test("allowed once, always where it offers it, rejected with why; let go, left asking in its TUI; settled there, closed here", () => {
    const sent: Reply[] = [];
    const held = (canAllowAlways: boolean) =>
      new OpenCodeHeld({ sessionId: "ses_1", cwd: "/x", requestId: "per_1", tool: { name: "Bash", input: { command: "npm test" } }, canAllowAlways, questions: null }, (r) => (sent.push(r), true));
    assert.ok(held(true).allow(true));
    assert.ok(held(false).allow(true));
    assert.ok(held(true).deny("not now"));
    assert.deepEqual(sent, [{ decision: "always" }, { decision: "once" }, { decision: "reject", message: "not now" }]);
    const h = held(false);
    assert.ok(h.release());
    assert.equal(h.open, false);
    assert.equal(h.allow(false), false, "let go: nothing sent");
    const other = held(false);
    let closed = false;
    other.onClosed = () => (closed = true);
    other.resolved();
    assert.ok(closed && !other.open);
    assert.equal(other.closedHow, undefined, "gone, not said to be answered there");
  });

  test("answered in its TUI (permission.replied, 2.0.32: sessionID, requestID, reply): closed as answered there, with its reply", () => {
    assert.deepEqual(repliedOf({ sessionID: "ses_1", requestID: "per_1", reply: "always" }), { requestId: "per_1", sessionId: "ses_1", reply: "always" });
    assert.deepEqual(repliedOf({ sessionID: "ses_1", requestID: "per_1", reply: "maybe" }), { requestId: "per_1", sessionId: "ses_1", reply: null }, "a reply it doesn't know");
    assert.equal(repliedOf({ sessionID: "ses_1" }), null);
    assert.equal(repliedOf(null), null);
    for (const reply of ["once", "always", "reject"] as const) {
      const h = new OpenCodeHeld({ sessionId: "ses_1", cwd: "/x", requestId: "per_1", tool: { name: "Bash", input: { command: "npm test" } }, canAllowAlways: true, questions: null }, () => true);
      let closed = 0;
      h.onClosed = () => void closed++;
      h.resolved({ reply });
      h.resolved({ reply: "once" });
      assert.deepEqual([closed, h.closedHow, h.repliedThere, h.open], [1, "terminal", reply, false]);
    }
    // A reject OpenCode sends for the rest of a session's asks with one Kiko just rejected: not answered there.
    assert.deepEqual(repliedHow("once", undefined), { reply: "once" });
    assert.deepEqual(repliedHow("reject", undefined), { reply: "reject" }, "rejected in its TUI");
    assert.equal(repliedHow("reject", 10_000, 12_000), null, "Kiko's reject's batch");
    assert.deepEqual(repliedHow("reject", 10_000, 10_000 + BATCH_MS + 1), { reply: "reject" }, "long after Kiko's");
    assert.deepEqual(repliedHow("always", 10_000, 12_000), { reply: "always" });
    // Answered here first: its own reply's event changes nothing.
    const h = new OpenCodeHeld({ sessionId: "ses_1", cwd: "/x", requestId: "per_2", tool: { name: "Bash", input: {} }, canAllowAlways: false, questions: null }, () => true);
    let closed = false;
    h.onClosed = () => (closed = true);
    h.allow(false);
    h.resolved({ reply: "once" });
    assert.deepEqual([closed, h.closedHow], [false, undefined]);
  });

  test("Esc in its TUI (session.execution.interrupted, no permission.replied) or the session idle: what it asked is over, a subagent's under its session too", () => {
    const mk = (requestId: string, sessionId: string, askedIn?: string) =>
      new OpenCodeHeld({ sessionId, cwd: "/x", requestId, tool: { name: "Bash", input: {} }, canAllowAlways: false, questions: null, ...(askedIn ? { askedIn } : {}) }, () => true);
    const own = mk("per_1", "ses_root");
    const sub = mk("per_2", "ses_root", "ses_child");
    const other = mk("per_3", "ses_other");
    const answered = mk("per_4", "ses_root");
    answered.allow(false);
    const held = [own, sub, other, answered];
    assert.equal(sub.askedIn, "ses_child");
    assert.equal(own.askedIn, "ses_root", "its own session's, by default");
    assert.deepEqual(
      endedBy(held, "ses_root").map((h) => h.requestId),
      ["per_1", "per_2"],
      "its own and its subagent's, not another's or one answered",
    );
    assert.deepEqual(
      endedBy(held, "ses_child").map((h) => h.requestId),
      ["per_2"],
      "a subagent stopped: only what it asked",
    );
    assert.deepEqual(endedBy(held, ""), []);
  });

  test("its question tool's form as questions, answered by label or your words, an array for several", () => {
    const q = questionsOf({
      id: "frm_1",
      sessionID: "ses_1",
      title: "Questions",
      metadata: { kind: "question" },
      fields: [
        {
          key: "q0",
          title: "Database",
          description: "Which database?",
          type: "string",
          options: [
            { value: "Postgres", label: "Postgres" },
            { value: "SQLite", label: "SQLite" },
          ],
          custom: true,
        },
        {
          key: "q1",
          title: "Extras",
          description: "Add which?",
          type: "multiselect",
          options: [
            { value: "Auth", label: "Auth" },
            { value: "Billing", label: "Billing" },
          ],
        },
      ],
    })!;
    assert.equal(q.questions.length, 2);
    assert.deepEqual(
      q.questions[0].options.map((o) => o.label),
      ["Postgres", "SQLite"],
    );
    assert.equal(q.questions[1].multiSelect, true);
    assert.deepEqual(
      formAnswer(q.questions, [
        { labels: ["SQLite"], text: "" },
        { labels: ["Auth"], text: "and logs" },
      ]),
      { q0: "SQLite", q1: ["Auth", "and logs"] },
    );
    assert.deepEqual(formAnswer(q.questions, [{ labels: [], text: "MySQL" }]), { q0: "MySQL" });
    assert.equal(questionsOf({ id: "frm_2", sessionID: "global", metadata: { kind: "mcp" }, fields: [{ key: "x", type: "string" }] }), null, "an MCP server's form: said, not asked");
  });

  test("a turn: read out with a reply window whose answer is a new message; moot once it works again", () => {
    const sent: string[] = [];
    const t = new OpenCodeTurn({ sessionId: "ses_1", cwd: "/x", turn: { said: "Done.", asked: "fix it", turn: ["fix it"] }, continued: false }, (text) => (sent.push(text), true));
    assert.equal(t.text, "Done.");
    assert.equal(t.open, true);
    assert.deepEqual(t.saidThisTurn(), ["fix it"]);
    assert.ok(t.answer("now the docs"));
    assert.deepEqual(sent, ["now the docs"]);
    assert.equal(t.answer("again"), false, "once");
    const u = new OpenCodeTurn({ sessionId: "ses_1", cwd: "/x", turn: { said: "x", asked: "", turn: [] }, continued: true }, () => true);
    let closed = false;
    u.onClosed = () => (closed = true);
    u.close();
    assert.ok(closed && !u.open && u.continued);
  });
});

describe("its service, against a fake one", () => {
  let fake: FakeOpenCode;
  let service: OpenCodeService;
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const events: OpenCodeEvent[] = [];

  before(async () => {
    fake = await new FakeOpenCode({ password: "s3cret-word-for-tests" }).start(join(process.cwd(), "svc2", "service.json"));
    service = new OpenCodeService(() => ({ file: join(process.cwd(), "svc2", "service.json"), log: (event, data) => logs.push({ event, data }) }));
    service.onEvent = (e) => events.push(e);
    await service.start();
  });
  after(async () => {
    service.stop();
    await fake.stop();
  });

  test("connected with its password (Basic, user opencode), listening", async () => {
    assert.equal(service.connected, true);
    assert.equal(service.pid, process.pid);
    await until(() => fake.listeners === 1, 2000, "its stream open");
    assert.ok(logs.some((l) => l.event === "opencode_service" && l.data.ok === true));
  });

  test("its events, and what it's asked: sessions in a folder (top-level only), one session, its messages, what it waits on", async () => {
    const s = fake.addSession({ cwd: "/x/pixie", title: "Login" });
    fake.addSession({ cwd: "/x/pixie", parentID: s.id });
    fake.addSession({ cwd: "/x/other" });
    await until(() => events.some((e) => e.type === "session.created" && e.data.sessionID === s.id), 2000, "session.created");
    const listed = await service.sessionsIn("/x/pixie");
    assert.deepEqual(
      listed!.map((x) => x.id),
      [s.id],
    );
    assert.equal((await service.session(s.id))!.title, "Login");
    fake.turn(s.id, "fix the login bug", "Fixed it.");
    await until(() => events.some((e) => e.type === "session.execution.succeeded"), 2000, "the turn's end");
    const msgs = await service.messages(s.id);
    assert.deepEqual(turnOf(msgs!), { said: "Fixed it.", asked: "fix the login bug", turn: ["fix the login bug"] });
    const p = fake.askPermission(s.id);
    fake.askQuestions(s.id, [{ header: "DB", question: "Which?", options: ["a", "b"] }]);
    const pending = await service.pending(s.id);
    assert.equal(pending.permissions[0].id, p.id);
    assert.equal(pending.forms.length, 1);
  });

  test("done through it: a permission answered, a form answered, renamed, a message, interrupted (or said it isn't running)", async () => {
    const s = fake.addSession({ cwd: "/x/pixie" });
    const p = fake.askPermission(s.id);
    assert.deepEqual(await service.replyPermission(s.id, p.id, "reject", "not that"), { done: true });
    assert.deepEqual(fake.calls.at(-1), { method: "POST", path: `/api/session/${s.id}/permission/${p.id}/reply`, body: { decision: "reject", message: "not that" } });
    const f = fake.askQuestions(s.id, [{ header: "DB", question: "Which?", options: ["a", "b"] }]);
    assert.deepEqual(await service.replyForm(s.id, f.id, { q0: "b" }), { done: true });
    assert.deepEqual(fake.calls.at(-1)!.body, { answer: { q0: "b" } });
    assert.deepEqual(await service.rename(s.id, "Docs"), { done: true });
    assert.equal(fake.sessions.get(s.id)!.title, "Docs");
    assert.deepEqual(await service.prompt(s.id, "and add a test"), { done: true });
    assert.deepEqual(fake.calls.at(-1)!.body, { text: "and add a test" });
    assert.deepEqual(await service.interrupt(s.id), { done: false, why: "it isn't running anything" });
    fake.busy.add(s.id);
    assert.deepEqual(await service.interrupt(s.id), { done: true });
    assert.deepEqual(await service.replyPermission(s.id, "per_gone", "once"), { done: false, why: "OpenCode doesn't have it any more" });
    assert.ok(logs.some((l) => l.event === "opencode_command" && l.data.method === "session.prompt" && l.data.ok === true));
  });

  test("busy as it says (session.status), and from /api/session/active as it connects", async () => {
    const s = fake.addSession({ cwd: "/x/pixie" });
    fake.emit("session.status", { sessionID: s.id, status: { type: "busy" } });
    await until(() => service.isBusy(s.id), 2000, "busy");
    fake.emit("session.status", { sessionID: s.id, status: { type: "idle" } });
    await until(() => !service.isBusy(s.id), 2000, "idle");
  });

  test("its password never in a log line", () => {
    assert.ok(!JSON.stringify(logs).includes("s3cret-word-for-tests"));
  });

  test("the service gone: dropped, said once, and found again when it's back", async () => {
    await fake.stop();
    await until(() => !service.connected, 3000, "dropped");
    assert.ok(logs.some((l) => l.event === "opencode_service" && l.data.ok === false));
    await fake.start(join(process.cwd(), "svc2", "service.json"));
    await until(() => service.connected, 8000, "back");
  });

  test("a password it doesn't take: not connected, and why (never the password)", async () => {
    const other = await new FakeOpenCode({ password: "right-one" }).start(join(process.cwd(), "svc3", "service.json"));
    other.refuse = true;
    const s = new OpenCodeService(() => ({ file: join(process.cwd(), "svc3", "service.json") }));
    await s.start();
    assert.equal(s.connected, false);
    assert.match(s.why, /didn't take its own password/);
    s.stop();
    await other.stop();
  });
});

describe("its setup: Kiko's own settings, nothing of OpenCode's", () => {
  test("listed among the agents (and their setups), after Codex; starts sessions", () => {
    assert.deepEqual(
      agents.map((a) => a.id),
      ["claude-code", "codex", "opencode", "t3code"],
    );
    assert.equal(SETUPS[2], opencode.setup, "the adapter's setup is the list's");
    assert.ok(starters().includes(opencode));
  });

  test("not connected, connected (your yes kept in the settings), disconnected; said without hooks", () => {
    if (!opencodeSetup.installed()) return; // opencode isn't on this Mac's PATH: status says so, nothing else to check
    assert.equal(statusOf(opencodeSetup).state, "not connected");
    const row = cardRows({})?.find((r) => r.id === "opencode");
    assert.deepEqual(row && { ask: row.ask, detail: row.detail }, { ask: true, detail: "lets Kiko listen to its background service" }, "offered on the first-run card");
    assert.deepEqual(opencodeSetup.plan!(), { command: "", events: ["listen"], repoint: 0 });
    const o = connectOne(opencodeSetup);
    assert.equal(o.did, "connected");
    assert.deepEqual(loadSettings().linkedAgents, ["opencode"]);
    assert.equal(outcomeMessage(o), "Connected OpenCode: Kiko listens to OpenCode's background service. Open any OpenCode session and it's listed; nothing to restart.");
    assert.equal(statusOf(opencodeSetup).state, "connected");
    assert.equal(outcomeMessage(connectOne(opencodeSetup)).startsWith("OpenCode was connected already."), true);
    assert.deepEqual(opencodeSetup.disconnect!().events, ["stop listening"]);
    assert.equal(loadSettings().linkedAgents, undefined);
    assert.equal(statusOf(opencodeSetup).state, "not connected");
  });

  test("the settings row's choices say what connecting means, not hooks", () => {
    const connect = agentChoices({ state: "not connected", detail: "", file: "", link: "Kiko listens to OpenCode's background service" })[0];
    assert.equal(connect.hint, "nothing of its own changes", "what it listens to is in its about");
    const disconnect = agentChoices({ state: "connected", detail: "", file: "", link: "x" }).find((c) => c.value === "disconnect")!;
    assert.match(disconnect.hint!, /stops listening/);
  });

  test("an OpenCode before 2.0 (no background service) needs updating", () => {
    const file = process.env.KIKO_OPENCODE_SERVICE!;
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: "1.4.7", url: "http://127.0.0.1:9", pid: 1, password: "x" }));
    assert.match(opencodeSetup.health!()!, /1\.4\.7 has no background service/);
    writeFileSync(file, JSON.stringify({ version: "2.0.32", url: "http://127.0.0.1:9", pid: 1, password: "x" }));
    assert.equal(opencodeSetup.health!(), null);
  });
});

describe("the agent: starting, picking, its words, its screen", () => {
  test("`opencode [--prompt <words>]`, named once listed; picked only when it's said", () => {
    assert.deepEqual(opencode.startCommand({ prompt: "", name: "" }), { program: "opencode", args: [] });
    assert.deepEqual(opencode.startCommand({ prompt: "fix the login bug", name: "docs" }), { program: "opencode", args: ["--prompt", "fix the login bug"] });
    assert.equal(opencode.namesLater, true);
    assert.equal(namedAgent("opencode", "start an OpenCode session in pixie"), "opencode");
    assert.equal(namedAgent("opencode", "start an open code session in pixie"), "opencode");
    assert.equal(namedAgent("opencode", "start a session in pixie"), "");
    assert.ok(ASKED_FOR_NEW.test("start an OpenCode session in pixie"));
    assert.ok(ASKED_FOR_NEW.test("open a new open code session"));
    assert.ok(!ASKED_FOR_NEW.test("open code review notes"));
  });

  test("its session IDs are its own; its pane is its TUI", () => {
    assert.equal(agentOf({ sessionId: "ses_ea938f1c6ffePQDb4GHqkeuAet" }), opencode);
    assert.notEqual(agentOf({ sessionId: "1d6b6c9e-0000-4000-8000-000000000000" }), opencode);
    assert.equal(opencode.runsAs!("opencode"), true);
    assert.equal(opencode.runsAs!("codex"), false);
  });

  test("its prompt ready for words: the composer, nothing running", () => {
    assert.equal(atOpenCodePrompt('┃\n┃  Ask anything… "Fix a TODO in the codebase"\n┃\n  Build  claude-sonnet\n'), true);
    assert.equal(atOpenCodePrompt("┃  Ask anything…\n  esc interrupt\n"), false);
    assert.equal(atOpenCodePrompt("Loading…"), false);
  });

  test("kiko opencode opens its TUI; its subcommands and flags that print are plain opencode", () => {
    assert.equal(opencodeOneShot([]), false);
    assert.equal(opencodeOneShot(["~/pixie"]), false);
    assert.equal(opencodeOneShot(["--prompt", "run", "-c"]), false, "an option's value isn't a subcommand");
    assert.equal(opencodeOneShot(["mini"]), false);
    assert.equal(opencodeOneShot(["run", "hello"]), true);
    assert.equal(opencodeOneShot(["--version"]), true);
    assert.equal(opencodeOneShot(["serve"]), true);
  });

  test("the agent adapter: asked after tmux and before Ghostty; finds a session only when its agent takes words itself", async () => {
    assert.deepEqual(
      terminals.map((t) => t.id),
      process.platform === "darwin" ? ["t3code", "tmux", "agent", "rex", "iterm", "terminal", "ghostty"] : ["t3code", "tmux", "agent", "rex", "ghostty"],
    );
    // Not connected: OpenCode can't take a message, so nothing is found for it.
    const found = await agentMessages.find(Promise.resolve([{ sessionId: "ses_1", cwd: "/x", kind: "interactive", desktop: false, titles: [], agent: "opencode" }]));
    assert.equal(found.size, 0);
    assert.deepEqual(await agentMessages.type({ via: "agent", id: "claude-code:abc", keys: false }, "hi"), { sent: false, why: "its agent doesn't take messages" });
  });

  // A session's first message and its reply were once never on the phone's chat. What the
  // phone and the window show of a session is its messages as a transcript (watchHistory), live.
  test("its conversation, for the phone's chat and the window: your message and its reply, then each reply once it's written in full, kept up while it's followed", async () => {
    process.env.KIKO_SOCKET = join(process.cwd(), "oc-history.sock");
    const fake = await new FakeOpenCode().start(serviceFile);
    linkAgent("opencode", true);
    let watching: { stop(): void } | null = null;
    try {
      await opencode.start();
      await until(() => fake.listeners > 0, 3000, "listening");
      const s = fake.addSession({ cwd: join(process.cwd(), "2026-10-12-maple") });
      fake.turn(s.id, "Hello world!", "Hello! What shall we build?");
      const got: History[] = [];
      watching = opencode.watchHistory({ sessionId: s.id, cwd: s.cwd }, (h) => got.push(h));
      const said = () => (got.at(-1)?.items ?? []).map((i) => (i.kind === "steps" ? ["steps", i.summary] : [i.kind, i.text]));
      await until(() => said().length === 2, 3000, "the first message and its reply");
      assert.deepEqual(said(), [
        ["you", "Hello world!"],
        ["claude", "Hello! What shall we build?"],
      ]);
      assert.equal(opencode.historyFile({ sessionId: s.id, cwd: s.cwd }).startsWith(process.cwd()), true, "the mirror is the test's own");

      // A reply as it's written: your words at once, its reply only once it's whole (a mirror line is written once).
      const reply = fake.startReply(s.id, "What can you help me with?", "Pretty much");
      await until(() => said().length === 3, 3000, "your next message");
      await new Promise((r) => setTimeout(r, 900));
      assert.deepEqual(said().at(-1), ["you", "What can you help me with?"], "nothing cut short");
      fake.finishReply(s.id, reply, "Pretty much anything code-related, here or wherever you point me.");
      await until(() => said().length === 4, 3000, "the reply, done");
      assert.deepEqual(said().at(-1), ["claude", "Pretty much anything code-related, here or wherever you point me."]);

      // A listing that misses it (no TUI of its seen here) doesn't stop a screen left open on it.
      await opencode.list();
      fake.turn(s.id, "Thanks", "Any time.");
      await until(() => said().length === 6, 3000, "the next turn, still followed");
    } finally {
      watching?.stop();
      linkAgent("opencode", false);
      opencode.stop();
      await fake.stop();
      delete process.env.KIKO_SOCKET;
    }
  });

  test("words for a session the service keeps but no TUI shows aren't sent (no turn nobody sees), and say why", async () => {
    const fake = await new FakeOpenCode().start(serviceFile);
    linkAgent("opencode", true);
    const onHeld = opencode.onHeld;
    const onBlocked = opencode.onBlocked;
    const held: unknown[] = [];
    opencode.onHeld = (h) => held.push(h);
    opencode.onBlocked = (b) => held.push(b);
    try {
      await opencode.start();
      await until(() => fake.listeners > 0, 3000, "listening");
      const greeting = fake.addSession({ id: "ses_e7214c279ffe3xu3KscUyHT6x8", cwd: join(process.cwd(), "lacy-platform"), title: "Greeting", at: Date.now() - 600_000 });
      assert.deepEqual(await opencode.list(), [], "no OpenCode TUI runs in its folder: not listed");
      const session = {
        sessionId: greeting.id,
        cwd: greeting.cwd,
        kind: "interactive" as const,
        desktop: false,
        titles: [],
        agent: "opencode",
        name: "",
        givenName: "Greeting",
        title: "",
        status: "idle",
        lastActiveAt: 0,
      };
      assert.equal(opencode.can!(session).reply, false, "nothing reaches it");
      assert.equal((await agentMessages.find(Promise.resolve([session]))).size, 0);
      const why = "its OpenCode window was closed";
      assert.deepEqual(await opencode.message!({ sessionId: greeting.id, cwd: "" }, "Hello, again."), { sent: false, why });
      assert.deepEqual(await agentMessages.type({ via: "agent", id: `opencode:${greeting.id}`, keys: false }, "Hello, again."), { sent: false, why }, "a place found a moment before: not sent either");
      // A turn the service runs in it anyway (another client's) isn't read out, nor its permission held.
      fake.turn(greeting.id, "hi", "Hello!");
      fake.askPermission(greeting.id);
      // Nor a call its deny rules stopped said.
      fake.emit("session.tool.input.started", { sessionID: greeting.id, assistantMessageID: "msg_1", id: "call_1", name: "shell" });
      fake.emit("session.tool.failed", {
        sessionID: greeting.id,
        assistantMessageID: "msg_1",
        id: "call_1",
        error: { type: "permission.rejected", message: "Permission denied: shell" },
        executed: false,
      });
      await new Promise((r) => setTimeout(r, 500));
      assert.deepEqual(held, [], "nothing held or said");
      assert.equal(fake.calls.filter((c) => c.path.endsWith("/prompt")).length, 0, "no prompt sent");
    } finally {
      opencode.onHeld = onHeld;
      opencode.onBlocked = onBlocked;
      linkAgent("opencode", false);
      opencode.stop();
      await fake.stop();
    }
  });
});
