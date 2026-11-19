// T3 Code's adapter (src/agents/t3code/), against a fake T3 server (tests/support/fake-t3.ts): never
// the real one, never ~/.t3. Its shell as sessions (mapping.ts), the client's handshake, frames and
// reconnecting (client.ts, rpc.ts), its token (auth.ts: never in a log), and another protocol.
import "../../setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { after, describe, test } from "node:test";
import { cliMinter, parseIssued } from "../../../src/agents/t3code/auth.ts";
import { redact, Secret } from "../../../src/agents/secret.ts";
import { readHistory, type History } from "../../../src/core/history.ts";
import { MISMATCH, PROTOCOL, T3Client, type ClientOptions, type Completed, type Started } from "../../../src/agents/t3code/client.ts";
import { heldOf, promptOf, t3code, waitingOf } from "../../../src/agents/t3code/index.ts";
import { elsewhere, launchersIn, offeredStarters, starters } from "../../../src/agents/index.ts";
import { DRIVERS, launchInput, modelFor, runtimeModeFor, titleOf } from "../../../src/agents/t3code/launch.ts";
import { projectAmong } from "../../../src/core/projects.ts";
import { decide, type DecideDeps, type DecideState } from "../../../src/core/decide.ts";
import type { Action } from "../../../src/core/router.ts";
import { askedInRun, historyOf, lastReply, sessionOf, Shell, statusOf, type ShellThread } from "../../../src/agents/t3code/mapping.ts";
import { answersOf, pendingRequest, T3Held, type Decision, type Pending, type Response } from "../../../src/agents/t3code/requests.ts";
import { messageLines, Mirrors, watched } from "../../../src/agents/mirror.ts";
import { ASK_TOOL } from "../../../src/core/ask.ts";
import type { Held } from "../../../src/agents/types.ts";
import { FakeT3 } from "../../support/fake-t3.ts";
import { CAST, makeWorld, type VoiceCan } from "../../support/fixtures.ts";
import { checkWaits } from "../../support/until.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = checkWaits(4000, 5);

const thread = (fields: Partial<ShellThread> = {}): ShellThread => ({
  id: "th1",
  projectId: "p1",
  title: "Fix the login",
  worktreePath: null,
  lineage: { relationshipToParent: null },
  latestRunId: null,
  latestRunCompletedAt: null,
  status: "idle",
  pendingRuntimeRequest: null,
  updatedAt: "2026-10-29T10:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  settledOverride: null,
  ...fields,
});
const PROJECTS = new Map([["p1", { id: "p1", title: "pixie", workspaceRoot: "/code/pixie" }]]);

describe("T3's shell as sessions", () => {
  test("a thread: named by its title, in its project's folder (its worktree when it has one), T3's", () => {
    const s = sessionOf(thread(), PROJECTS)!;
    assert.equal(s.sessionId, "t3:th1");
    assert.equal(s.givenName, "Fix the login");
    assert.equal(s.cwd, "/code/pixie");
    assert.equal(s.agent, "t3code");
    assert.equal(sessionOf(thread({ worktreePath: "/code/pixie-wt" }), PROJECTS)!.cwd, "/code/pixie-wt");
  });

  test("left out: archived, deleted, settled, a subagent's child, a project not known", () => {
    for (const t of [
      thread({ archivedAt: "2026-10-29T10:00:00.000Z" }),
      thread({ deletedAt: "2026-10-29T10:00:00.000Z" }),
      thread({ settledOverride: "settled" }),
      thread({ lineage: { relationshipToParent: "subagent" } }),
      thread({ projectId: "nope" }),
    ]) {
      assert.equal(sessionOf(t, PROJECTS), null);
    }
  });

  test("status: busy while a run is live (waiting too), blocked on a permission, idle once it ended", () => {
    for (const status of ["preparing", "queued", "starting", "running", "waiting"]) assert.equal(statusOf(thread({ status })), "busy", status);
    for (const status of ["idle", "completed", "interrupted", "failed", "cancelled"]) assert.equal(statusOf(thread({ status })), "idle", status);
    const asking = { id: "r1", kind: "file-change" };
    assert.equal(statusOf(thread({ status: "running", pendingRuntimeRequest: asking })), "blocked");
    assert.equal(statusOf(thread({ status: "running", pendingRuntimeRequest: { ...asking, blocking: false } })), "busy", "a question the run works past");
  });

  test("the second, empty snapshot right after the first isn't every thread gone (nor every project); a later empty one is", () => {
    let now = 1000;
    const shell = new Shell(() => now);
    const snapshot = (threads: ShellThread[]) => ({ kind: "snapshot", snapshot: { threads, projects: [...PROJECTS.values()] } });
    shell.apply(snapshot([thread()]));
    now += 30;
    assert.deepEqual(shell.apply(snapshot([])), []);
    assert.equal(shell.sessions().length, 1);
    now += 5000;
    shell.apply(snapshot([]));
    assert.equal(shell.sessions().length, 0);
    // No threads yet: the quirk's empty snapshot (no projects either) doesn't lose the projects.
    const fresh = new Shell(() => now);
    fresh.apply(snapshot([]));
    now += 30;
    fresh.apply({ kind: "snapshot", snapshot: { threads: [], projects: [] } });
    fresh.apply({ kind: "thread.updated", location: "active", thread: thread() });
    assert.equal(fresh.sessions().length, 1);
  });

  test("a run completing is told once, when it's completed (not at the waiting before); one completed before is never told", () => {
    const shell = new Shell();
    shell.apply({ kind: "snapshot", snapshot: { threads: [thread({ id: "old", status: "completed", latestRunId: "r0" })], projects: [...PROJECTS.values()] } });
    const update = (t: ShellThread) => shell.apply({ kind: "thread.updated", location: "active", thread: t }).filter((c) => c.kind !== "listed");
    assert.deepEqual(update(thread({ id: "old", status: "completed", latestRunId: "r0", title: "renamed" })), []);
    assert.deepEqual(
      update(thread({ status: "running", latestRunId: "r1" })).map((c) => c.kind),
      ["started"],
    );
    assert.deepEqual(update(thread({ status: "waiting", latestRunId: "r1" })), []);
    assert.deepEqual(
      update(thread({ status: "completed", latestRunId: "r1" })).map((c) => c.kind),
      ["completed"],
    );
    assert.deepEqual(update(thread({ status: "completed", latestRunId: "r1" })), [], "once");
  });

  test("a run starting is told once, as it takes its message in (not while queued); one going before is never told", () => {
    const shell = new Shell();
    shell.apply({ kind: "snapshot", snapshot: { threads: [thread({ id: "busy", status: "running", latestRunId: "r0" })], projects: [...PROJECTS.values()] } });
    const update = (t: ShellThread) => shell.apply({ kind: "thread.updated", location: "active", thread: t }).filter((c) => c.kind !== "listed");
    assert.deepEqual(update(thread({ id: "busy", status: "running", latestRunId: "r0" })), [], "going before it was seen");
    assert.deepEqual(update(thread({ status: "queued", latestRunId: "r1" })), []);
    assert.deepEqual(
      update(thread({ status: "starting", latestRunId: "r1" })).map((c) => c.kind),
      ["started"],
    );
    assert.deepEqual(update(thread({ status: "running", latestRunId: "r1" })), [], "once");
    assert.deepEqual(
      update(thread({ status: "completed", latestRunId: "r1" })).map((c) => c.kind),
      ["completed"],
    );
    assert.deepEqual(
      update(thread({ status: "running", latestRunId: "r2" })).map((c) => c.kind),
      ["started"],
      "the next run",
    );
    assert.deepEqual(update(thread({ id: "gone", status: "running", latestRunId: "r3", archivedAt: "2026-10-29T10:00:00.000Z" })), [], "not listed: not told");
  });

  test("a pending permission is told once per request", () => {
    const shell = new Shell();
    const update = (t: ShellThread) => shell.apply({ kind: "thread.updated", location: "active", thread: t }).filter((c) => c.kind !== "listed");
    const asking = thread({ status: "running", pendingRuntimeRequest: { id: "r1", kind: "file-change" } });
    assert.deepEqual(
      update(asking).map((c) => c.kind),
      ["waiting"],
    );
    assert.deepEqual(update(asking), []);
    assert.deepEqual(
      update(thread({ status: "running", pendingRuntimeRequest: { id: "r2", kind: "command" } })).map((c) => c.kind),
      ["resolved", "waiting"],
      "r1 no longer pending, r2 is",
    );
  });

  test("a request no longer pending is told: answered (none now), another instead, or the thread gone; never twice", () => {
    const shell = new Shell();
    const apply = (item: unknown) => shell.apply(item).filter((c) => c.kind === "resolved");
    const update = (t: ShellThread) => apply({ kind: "thread.updated", location: "active", thread: t });
    update(thread({ status: "running", pendingRuntimeRequest: { id: "r1", kind: "command" } }));
    assert.deepEqual(update(thread({ status: "running" })), [{ kind: "resolved", threadId: "th1", requestId: "r1" }]);
    assert.deepEqual(update(thread({ status: "running" })), [], "once");
    update(thread({ status: "running", pendingRuntimeRequest: { id: "r2", kind: "command" } }));
    assert.deepEqual(apply({ kind: "thread.removed", threadId: "th1" }), [{ kind: "resolved", threadId: "th1", requestId: "r2" }]);
    update(thread({ status: "running", pendingRuntimeRequest: { id: "r3", kind: "command" } }));
    assert.deepEqual(apply({ kind: "thread.updated", location: "archive", thread: thread({ archivedAt: "2026-10-29T10:00:00.000Z" }) }), [{ kind: "resolved", threadId: "th1", requestId: "r3" }]);
    // A fresh snapshot (T3 restarted) without it: resolved too.
    update(thread({ status: "running", pendingRuntimeRequest: { id: "r4", kind: "command" } }));
    assert.deepEqual(apply({ kind: "snapshot", snapshot: { threads: [thread({ status: "idle" })], projects: [...PROJECTS.values()] } }), [{ kind: "resolved", threadId: "th1", requestId: "r4" }]);
  });

  test("the last reply: the run's last assistant message, and what was asked in it", () => {
    const projection = {
      messages: [
        { role: "user", text: "first", runId: "r0" },
        { role: "assistant", text: "old answer", runId: "r0" },
        { role: "user", text: "fix it", runId: "r1" },
        { role: "assistant", text: "Looking.", runId: "r1" },
        { role: "assistant", text: "Fixed it.", runId: "r1" },
      ],
    };
    assert.deepEqual(lastReply(projection, "r1"), { said: "Fixed it.", asked: "fix it" });
    assert.deepEqual(lastReply(projection, "r9"), { said: "Fixed it.", asked: "fix it" }, "no message of that run: the thread's last");
    assert.deepEqual(lastReply({}, null), { said: "", asked: "" });
  });

  test("your words in a run: its user messages, oldest first; none known to be its, none", () => {
    const projection = {
      messages: [
        { role: "user", text: "first", runId: "r0" },
        { role: "assistant", text: "old answer", runId: "r0" },
        { role: "user", text: " fix it ", runId: "r1" },
        { role: "assistant", text: "Looking.", runId: "r1" },
        { role: "user", text: "and test it", runId: "r1" },
        { role: "user", text: "queued for later", runId: null },
      ],
    };
    assert.deepEqual(askedInRun(projection, "r1"), ["fix it", "and test it"]);
    assert.deepEqual(askedInRun(projection, "r9"), []);
    assert.deepEqual(askedInRun(projection, null), []);
  });

  test("a thread's conversation as the phone's history: you and Claude, with their times, the last 60", () => {
    const projection = {
      messages: [
        { role: "user", text: "fix it", runId: "r1", createdAt: "2026-10-29T10:00:00.000Z" },
        { role: "assistant", text: "  ", runId: "r1" },
        { role: "system", text: "not a message of yours or its" },
        { role: "assistant", text: "Fixed it.", runId: "r1", createdAt: "2026-10-29T10:00:05.000Z" },
      ],
    };
    assert.deepEqual(historyOf(projection), {
      items: [
        { kind: "you", text: "fix it", at: "2026-10-29T10:00:00.000Z" },
        { kind: "claude", text: "Fixed it.", at: "2026-10-29T10:00:05.000Z" },
      ],
      truncated: false,
    });
    const long = { messages: Array.from({ length: 70 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `m${i}` })) };
    const h = historyOf(long);
    assert.equal(h.items.length, 60);
    assert.equal(h.truncated, true);
    assert.deepEqual(h.items.at(-1), { kind: "claude", text: "m69", at: null });
    assert.deepEqual(historyOf({}), { items: [], truncated: false });
  });

  test("a run that started is told as Claude Code's UserPromptSubmit is, with its message (none: nothing)", () => {
    const before = t3code.onPromptSubmitted;
    const told: [string, string][] = [];
    t3code.onPromptSubmitted = (sessionId, prompt) => told.push([sessionId, prompt]);
    try {
      promptOf({ thread: thread() as any, asked: "What about Germany?" });
      promptOf({ thread: thread() as any, asked: "" });
    } finally {
      t3code.onPromptSubmitted = before;
    }
    assert.deepEqual(told, [["t3:th1", "What about Germany?"]]);
  });

  test("a completed run's words this turn: the run's own, else what it asked, else none", () => {
    assert.deepEqual(heldOf({ thread: thread() as any, said: "Done.", asked: "and test it", turn: ["fix it", "and test it"] }, "/c").saidThisTurn(), ["fix it", "and test it"]);
    assert.deepEqual(heldOf({ thread: thread() as any, said: "Done.", asked: "fix it", turn: [] }, "/c").saidThisTurn(), ["fix it"]);
    assert.deepEqual(heldOf({ thread: thread() as any, said: "Done.", asked: "fix it" }, "/c").saidThisTurn(), ["fix it"]);
    assert.equal(heldOf({ thread: thread() as any, said: "Done.", asked: "" }, "/c").saidThisTurn(), null);
  });

  test("a completed run as a finished turn that can't be held", () => {
    const held = heldOf({ thread: thread() as any, said: "Fixed it.", asked: "fix it" }, "/code/pixie");
    assert.equal(held.sessionId, "t3:th1");
    assert.equal(held.open, false);
    assert.equal(held.isPermission, false);
    assert.equal(held.text, "Fixed it.");
    assert.equal(held.answer("more"), false, "words go as a new message instead");
  });
});

describe("the token", () => {
  test("a Secret never shows itself", () => {
    const s = new Secret("t3tok-very-secret");
    assert.equal(String(s), "[redacted]");
    assert.equal(JSON.stringify({ s }), '{"s":"[redacted]"}');
    assert.equal(inspect({ s }).includes("very-secret"), false);
    assert.equal(s.reveal(), "t3tok-very-secret");
    assert.equal(redact("bad t3tok-very-secret here", s), "bad [redacted] here");
  });

  test("the CLI's JSON: its session and token", () => {
    const issued = parseIssued(JSON.stringify({ sessionId: "s1", token: "tok", scopes: [], expiresAt: "2026-10-29T10:15:00.000Z" }));
    assert.equal(issued.sessionId, "s1");
    assert.equal(issued.token.reveal(), "tok");
    assert.equal(issued.expiresAt, Date.parse("2026-10-29T10:15:00.000Z"));
    assert.throws(() => parseIssued("Issued bearer access token s1."), /JSON/);
  });

  test("minted by T3's CLI: only the scopes it needs, a short TTL, a clean environment; revoked by its ID", async () => {
    const home = mkdtempSync(join(tmpdir(), "t3home-"));
    const fake = new FakeT3();
    const printed = fake.writeCli(home);
    process.env.KIKO_SOMETHING = "x";
    process.env.ANTHROPIC_API_KEY = "unit-test-no-network";
    const minter = cliMinter(`${home}/bin/t3`);
    const issued = await minter.issue();
    assert.equal(issued.token.reveal(), printed.token);
    minter.revoke(issued.sessionId);
    await until(() => existsSync(`${home}/revoked`), "the revoke");
    const calls = readFileSync(`${home}/calls`, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(calls[0].args, ["auth", "session", "issue", "--scope", "orchestration:read", "--scope", "orchestration:operate", "--ttl", "15m", "--label", "Kiko", "--json"]);
    assert.deepEqual(calls[0].leaked, [], "none of the app's keys or settings");
    assert.deepEqual(calls[1].args, ["auth", "session", "revoke", issued.sessionId]);
    assert.equal(readFileSync(`${home}/revoked`, "utf8").trim(), issued.sessionId);
    assert.ok(!calls.some((c) => c.args.includes(printed.token)), "never on a command line");
  });

  test("a CLI that isn't there: said so, nothing else", async () => {
    await assert.rejects(cliMinter("/nonexistent/t3").issue(), /not installed/);
  });
});

describe("the client, against a fake T3", () => {
  const clients: T3Client[] = [];
  const fakes: FakeT3[] = [];
  after(async () => {
    for (const c of clients) c.stop();
    for (const f of fakes) await f.close().catch(() => {});
  });

  async function setUp(options: Partial<ClientOptions> = {}, script?: (fake: FakeT3) => void, tokenTtlMs?: number) {
    const fake = new FakeT3();
    fakes.push(fake);
    fake.project("p1", "/code/pixie", "pixie");
    fake.thread("th1", { title: "Fix the login" });
    script?.(fake);
    const port = await fake.listen();
    const logs: { event: string; data: Record<string, unknown> }[] = [];
    const notices: string[] = [];
    const completed: Completed[] = [];
    const started: Started[] = [];
    const waiting: string[] = [];
    const client = new T3Client({ port, minter: fake.minter(tokenTtlMs), log: (event, data) => logs.push({ event, data }), backoffMs: [50, 100], ...options });
    clients.push(client);
    client.onNotice = (line) => notices.push(line);
    client.onCompleted = (done) => completed.push(done);
    client.onStarted = (s) => started.push(s);
    client.onWaiting = (t) => waiting.push(t.title);
    return { fake, client, logs, notices, completed, started, waiting, port };
  }

  test("handshake: the descriptor, a ticket for its token, the socket with protocol 2; its threads listed", async () => {
    const { fake, client, logs } = await setUp();
    await client.start();
    assert.equal(client.connected, true);
    assert.deepEqual(fake.upgrades, [{ protocol: String(PROTOCOL), ticket: true, ok: true }]);
    await until(() => client.shell.sessions().length === 1, "the thread listed");
    // The empty snapshot 30ms after the first changes nothing.
    await wait(80);
    assert.deepEqual(
      client.shell.sessions().map((s) => [s.sessionId, s.givenName, s.cwd]),
      [["t3:th1", "Fix the login", "/code/pixie"]],
    );
    assert.ok(fake.frames.some((f) => f._tag === "Request" && f.tag === "orchestration.subscribeShell"));
    assert.ok(fake.frames.filter((f) => f._tag === "Ack").length >= 2, "every chunk acked (the second snapshot waited for it)");
    assert.deepEqual(logs.find((l) => l.event === "t3_connect")?.data, { protocol: 2, ok: true });
  });

  test("a run completes: its reply read through subscribeThread, then the stream ended", async () => {
    const { fake, client, completed } = await setUp();
    await client.start();
    await until(() => client.shell.sessions().length === 1, "listed");
    fake.startRun("th1", "fix the login");
    await fake.completeRun("th1", "Fixed the login: the cookie had expired.");
    await until(() => completed.length === 1, "the completed run");
    assert.equal(completed[0].said, "Fixed the login: the cookie had expired.");
    assert.equal(completed[0].asked, "fix the login");
    const read = fake.frames.find((f) => f._tag === "Request" && f.tag === "orchestration.subscribeThread");
    assert.deepEqual(read.payload, { threadId: "th1" });
    await until(() => fake.frames.some((f) => f._tag === "Interrupt" && f.requestId === read.id), "the thread stream ended");
    await wait(50);
    assert.equal(completed.length, 1, "told once");
  });

  test("a run starts with the words sent to it: told with them (read through subscribeThread), then its end has them as its turn's", async () => {
    const { fake, client, started, completed } = await setUp();
    await client.start();
    await until(() => client.shell.sessions().length === 1, "listed");
    assert.deepEqual(await client.send("th1", "What about Germany?"), { sent: true });
    fake.startRun("th1");
    await until(() => started.length === 1, "the run's start");
    assert.deepEqual([started[0].thread.id, started[0].asked], ["th1", "What about Germany?"]);
    assert.equal(client.replies.get("th1")?.asked, "What about Germany?", "what it was last asked, at once");
    await fake.completeRun("th1", "Berlin.");
    await until(() => completed.length === 1, "the completed run");
    assert.deepEqual(completed[0].turn, ["What about Germany?"]);
    assert.deepEqual(heldOf(completed[0], "/code/pixie").saidThisTurn(), ["What about Germany?"]);
    // Typed in T3 itself: told the same way.
    fake.startRun("th1", "and France?");
    await until(() => started.length === 2, "the second run's start");
    assert.equal(started[1].asked, "and France?");
  });

  test("what each thread was last asked and said, read from T3 as it's listed: there right after Kiko starts, before any run here", async () => {
    const { client } = await setUp({}, (fake) => {
      fake.startRun("th1", "What about Germany?");
      void fake.completeRun("th1", "The capital of Germany is Berlin.");
      fake.thread("th2", { title: "Never asked" });
    });
    await wait(60); // the fake's run completes before Kiko connects
    await client.start();
    await until(() => client.replies.has("th1") && client.replies.has("th2"), "both read");
    assert.deepEqual(client.replies.get("th1"), { said: "The capital of Germany is Berlin.", asked: "What about Germany?" });
    assert.deepEqual(client.replies.get("th2"), { said: "", asked: "" });
    // t3code's own lastAsked and lastSaid read the same map (its own client's).
    const singleton = (await import("../../../src/agents/t3code/index.ts")).t3;
    singleton.replies.set("th9", { said: "Berlin.", asked: "And Germany?" });
    try {
      assert.equal(t3code.lastAsked({ sessionId: "t3:th9", cwd: "/c" }), "And Germany?");
      assert.equal(t3code.lastSaid({ sessionId: "t3:th9", cwd: "/c" }), "Berlin.");
    } finally {
      singleton.replies.delete("th9");
    }
  });

  test("a thread's conversation on the phone: at once, again as the thread changes, never after it's closed", async () => {
    const { fake, client } = await setUp();
    await client.start();
    await until(() => client.shell.sessions().length === 1, "listed");
    fake.startRun("th1", "fix the login");
    await fake.completeRun("th1", "Fixed it.");
    const got: History[] = [];
    const reads = () => fake.frames.filter((f) => f._tag === "Request" && f.tag === "orchestration.subscribeThread").length;
    await wait(100);
    const watcher = client.watchHistory(
      "th1",
      (h) => got.push(h),
      () => ({ items: [], truncated: true }),
    );
    await until(() => got.length === 1, "the conversation at once");
    assert.deepEqual(
      got[0].items.map((i) => [i.kind, i.kind === "steps" ? "" : i.text]),
      [
        ["you", "fix the login"],
        ["claude", "Fixed it."],
      ],
    );
    assert.ok(
      got[0].items.every((i) => i.at),
      "with their times",
    );
    fake.startRun("th1", "now add a test");
    await until(() => got.length === 2, "your next message in it");
    assert.deepEqual(
      got[1].items.map((i) => i.kind),
      ["you", "claude", "you"],
    );
    await fake.completeRun("th1", "Added one.");
    await until(() => got.at(-1)!.items.length === 4, "its reply in it");
    assert.equal((got.at(-1)!.items[3] as any).text, "Added one.");
    watcher.stop();
    const after = reads();
    const told = got.length;
    fake.startRun("th1", "and docs");
    await wait(400);
    assert.equal(reads(), after + 1, "only the run start's own read: not the conversation's, once it's closed");
    assert.equal(got.length, told);
    // T3 not connected: what's known, at once.
    client.stop();
    const fallback: History[] = [];
    const offline = client.watchHistory(
      "th1",
      (h) => fallback.push(h),
      () => ({ items: [{ kind: "claude", text: "Added one.", at: null }], truncated: true }),
    );
    await until(() => fallback.length === 1, "the fallback");
    offline.stop();
    assert.equal(fallback[0].truncated, true);
  });

  test("words to a thread: message.dispatch, as T3's own client sends one", async () => {
    const { fake, client } = await setUp();
    await client.start();
    assert.deepEqual(await client.send("th1", "now add a test"), { sent: true });
    const c = fake.dispatched[0];
    assert.equal(c.type, "message.dispatch");
    assert.equal(c.threadId, "th1");
    assert.equal(c.text, "now add a test");
    assert.deepEqual(c.attachments, []);
    assert.deepEqual(c.dispatchMode, { type: "start_immediately" });
    assert.equal(c.deliveryIntent, "auto");
    assert.equal(c.createdBy, "user");
    assert.ok(c.commandId && c.messageId);
    const refused = await client.send("nope", "hi");
    assert.equal(refused.sent, false);
  });

  test("a thread waiting on a permission: told once", async () => {
    const { fake, client, waiting } = await setUp();
    await client.start();
    await until(() => client.shell.sessions().length === 1, "listed");
    fake.thread("th1", { status: "running" });
    fake.askPermission("th1");
    await until(() => waiting.length === 1, "the waiting thread");
    fake.thread("th1", { title: "Fix the login" });
    await wait(50);
    assert.deepEqual(waiting, ["Fix the login"]);
    assert.equal(client.shell.sessions()[0].status, "blocked");
  });

  test("T3 restarts: connected again, with backoff, its threads listed again", async () => {
    const { fake, client } = await setUp();
    await client.start();
    fake.dropAll();
    await until(() => !client.connected, "the drop seen");
    await until(() => client.connected && fake.sockets === 1, "connected again");
    await until(() => client.shell.sessions().length === 1, "listed again");
  });

  test("T3 not running at first, started later: found then; nothing minted before", async () => {
    const probe = new FakeT3();
    const port = await probe.listen();
    await probe.close();
    const fake = new FakeT3();
    fakes.push(fake);
    fake.project("p1", "/code/pixie");
    fake.thread("th1");
    const logs: any[] = [];
    const client = new T3Client({ port, minter: fake.minter(), log: (event, data) => logs.push({ event, data }), backoffMs: [50, 100] });
    clients.push(client);
    assert.equal(client.keeping, false, "not started: its setup can't go by the connection");
    await client.start();
    assert.equal(client.keeping, true);
    assert.equal(client.connected, false);
    assert.deepEqual(logs.at(-1).data, { protocol: null, ok: false, why: "not running" });
    assert.equal(fake.issuedCount, 0);
    await fake.listen(port);
    await until(() => client.connected, "connected once it runs");
    assert.equal(logs.filter((l) => l.data.why === "not running").length, 1, "the quiet tries logged once");
  });

  test("another protocol in its descriptor: said once, logged, no token minted, nothing listed", async () => {
    const { fake, client, notices, logs } = await setUp({ backoffMs: [30, 30] }, (f) => (f.protocol = 3));
    await client.start();
    await wait(150);
    assert.deepEqual(notices, [MISMATCH]);
    assert.equal(MISMATCH, "T3 Code updated in a way this Kiko doesn't know yet; voice control of T3 is off until Kiko updates.");
    assert.deepEqual(
      logs.filter((l) => l.event === "t3_connect").map((l) => l.data),
      [{ protocol: 3, ok: false, why: "protocol" }],
    );
    assert.equal(fake.issuedCount, 0);
    assert.deepEqual(client.shell.sessions(), []);
  });

  test("another protocol at the socket (426): handled the same way", async () => {
    const { fake, client, notices, logs } = await setUp({}, (f) => (f.socketProtocol = 3));
    await client.start();
    assert.equal(client.connected, false);
    assert.deepEqual(notices, [MISMATCH]);
    assert.deepEqual(logs.find((l) => l.event === "t3_connect")?.data, { protocol: 3, ok: false, why: "protocol" });
    assert.equal(fake.upgrades[0].ok, false);
  });

  test("the token: renewed before it runs out (the connection made again with the new one, the old revoked), revoked on stop", async () => {
    // Tokens that last 2s, renewed 1.5s before: after about a second.
    const { fake, client } = await setUp({ renewBeforeMs: 1500 }, undefined, 2000);
    await client.start();
    assert.equal(fake.issuedCount, 1);
    await until(() => fake.issuedCount === 2 && client.connected, "renewed", 5000);
    await until(() => fake.revoked.includes("session-1"), "the old one revoked");
    client.stop();
    assert.ok(fake.revoked.includes("session-2"), "revoked on stop");
  });

  test("the token is never in a log, an error or a notice: refused tickets, drops and all", async () => {
    const { fake, client, logs, notices } = await setUp();
    await client.start();
    const tokens = [...fake.tokens.keys()];
    // Revoked under it: the ticket is refused on the next try, and a new one minted.
    fake.revoke("session-1");
    fake.dropAll();
    await until(() => client.connected && fake.issuedCount === 2, "connected again with a new token");
    tokens.push(...fake.tokens.keys());
    const sent = await client.send("missing-thread", "hi");
    const everything = JSON.stringify({ logs, notices, sent, inspect: inspect(client, { depth: 6 }) });
    for (const t of tokens) assert.equal(everything.includes(t), false, "a token showed");
    assert.equal(/ticket-[0-9a-f-]{8}/.test(everything), false, `a ticket showed: ${/.{80}ticket-[0-9a-f-]{8}.{20}/.exec(everything)?.[0]}`);
    assert.ok(logs.some((l) => String(l.data.why ?? "").includes("token refused")));
  });
});

describe("a thread waiting on you, held as a permission prompt (requests.ts)", () => {
  const native = (id: string) => ({ driver: "claudeAgent", nativeId: id, strength: "strong" });
  const request = (fields: Record<string, unknown> = {}) => ({
    id: "req1",
    kind: "command",
    status: "pending",
    responseCapability: { type: "live", providerSessionId: "ps", supportsFeedback: true },
    ...fields,
  });
  const approval = (fields: Record<string, unknown> = {}) => ({ type: "approval_request", requestId: "req1", requestKind: "command", prompt: "npm test", nativeItemRef: native("tu1"), ...fields });
  const projection = (requests: unknown[], turnItems: unknown[]) => ({ runtimeRequests: requests, turnItems });

  test("what it asks, in Claude Code's shape: the command, the file, Claude's own tool and input; else what T3 shows", () => {
    const run = pendingRequest(projection([request()], [{ type: "command_execution", input: "npm test", nativeItemRef: native("tu1") }, approval()]), "req1")!;
    assert.deepEqual(run.tool, { name: "Bash", input: { command: "npm test" } });
    assert.equal(run.questions, null);
    assert.equal(run.supportsFeedback, true);
    const edit = pendingRequest(
      projection(
        [request({ kind: "file-change" })],
        [{ type: "file_change", fileName: "src/login.ts", nativeItemRef: native("tu1") }, approval({ requestKind: "file-change", prompt: "Claude wants to edit" })],
      ),
      "req1",
    )!;
    assert.deepEqual(edit.tool, { name: "Edit", input: { file_path: "src/login.ts" } });
    const read = pendingRequest(
      projection(
        [request({ kind: "file-read" })],
        [{ type: "dynamic_tool", toolName: "Read", input: { file_path: "/etc/hosts" }, nativeItemRef: native("tu1") }, approval({ requestKind: "file-read" })],
      ),
      "req1",
    )!;
    assert.deepEqual(read.tool, { name: "Read", input: { file_path: "/etc/hosts" } });
    const bare = pendingRequest(projection([request({ kind: "mcp-elicitation" })], [approval({ prompt: "Claude wants to use the deploy tool", nativeItemRef: null })]), "req1")!;
    assert.deepEqual(bare.tool, { name: "Claude wants to use the deploy tool", input: {} });
    assert.equal(pendingRequest(projection([request({ kind: "permission" })], []), "req1"), null, "no approval item: nothing to say what it asks");
  });

  test("left to T3: not pending, not there, an answer that can't reach the provider, auth_refresh and dynamic_tool_call, questions answered by a message", () => {
    assert.equal(pendingRequest(projection([request({ status: "resolved" })], [approval()]), "req1"), null);
    assert.equal(pendingRequest(projection([request()], [approval()]), "other"), null);
    assert.equal(pendingRequest(projection([request({ responseCapability: { type: "not_resumable", reason: "restarted" } })], [approval()]), "req1"), null);
    for (const kind of ["auth_refresh", "dynamic_tool_call"]) assert.equal(pendingRequest(projection([request({ kind })], [approval()]), "req1"), null, kind);
    const ask = { type: "user_input_request", requestId: "req1", questions: [{ id: "q1", header: "Pick", question: "Which?", options: [{ label: "A", description: "a" }] }] };
    assert.equal(pendingRequest(projection([request({ kind: "user_input" })], [{ ...ask, responseMode: "message" }]), "req1"), null);
    assert.equal(pendingRequest(projection([request({ kind: "user_input" })], []), "req1"), null, "its questions not there");
    assert.equal(pendingRequest(null, "req1"), null);
  });

  test("Claude's questions: T3's, asked as AskUserQuestion's; answered with each question's ID → the value picked, an array when it takes several", () => {
    const questions = [
      {
        id: "Which database?",
        header: "Database",
        question: "Which database?",
        options: [
          { label: "Postgres (Recommended)", description: "relational", value: "postgres" },
          { label: "SQLite", description: "a file" },
        ],
      },
      {
        id: "q2",
        header: "Extras",
        question: "Which extras?",
        options: [
          { label: "Auth", description: "" },
          { label: "Billing", description: "" },
        ],
        multiSelect: true,
      },
    ];
    const asked = pendingRequest(projection([request({ kind: "user_input" })], [{ type: "user_input_request", requestId: "req1", questions }]), "req1")!;
    assert.equal(asked.tool.name, ASK_TOOL);
    assert.deepEqual(
      asked.questions!.map((q) => [q.header, q.question, q.options.map((o) => o.label), q.multiSelect]),
      [
        ["Database", "Which database?", ["Postgres (Recommended)", "SQLite"], false],
        ["Extras", "Which extras?", ["Auth", "Billing"], true],
      ],
    );
    assert.deepEqual(
      answersOf(asked.questions!, [
        { labels: ["Postgres (Recommended)"], text: "" },
        { labels: ["Auth", "Billing"], text: "" },
      ]),
      { "Which database?": "postgres", q2: ["Auth", "Billing"] },
    );
    assert.deepEqual(
      answersOf(asked.questions!, [
        { labels: [], text: "MySQL" },
        { labels: ["Auth"], text: "SSO too" },
      ]),
      { "Which database?": "MySQL", q2: ["Auth", "SSO too"] },
    );
  });

  test("answered: allow (accept), for the session where it offers that (acceptForSession; acceptAlways only where offered), deny with why (decline); once", () => {
    const pending = (decisions: Decision[] | null = null, supportsFeedback = true): Pending => ({
      id: "req1",
      kind: "command",
      tool: { name: "Bash", input: { command: "npm test" } },
      questions: null,
      decisions,
      supportsFeedback,
    });
    const answer = (p: Pending, act: (h: T3Held) => void) => {
      const sent: Response[] = [];
      const h = new T3Held("t3:th1", "/code/pixie", p, (r) => (sent.push(r), true));
      act(h);
      return { sent, h };
    };
    assert.deepEqual(answer(pending(), (h) => h.allow(false)).sent, [{ decision: "accept" }]);
    assert.deepEqual(answer(pending(), (h) => h.allow(true)).sent, [{ decision: "acceptForSession" }]);
    assert.deepEqual(answer(pending(["accept", "acceptAlways", "decline"]), (h) => h.allow(true)).sent, [{ decision: "acceptAlways" }]);
    const narrowed = answer(pending(["accept", "decline"]), (h) => h.allow(true));
    assert.deepEqual(narrowed.sent, [{ decision: "accept" }], "nothing more to offer: allowed once");
    assert.equal(narrowed.h.canAllowAlways, false);
    assert.deepEqual(answer(pending(), (h) => h.deny('The user said no by voice: "no"')).sent, [{ decision: "decline", feedback: 'The user said no by voice: "no"' }]);
    assert.deepEqual(answer(pending(null, false), (h) => h.deny("no")).sent, [{ decision: "decline" }], "no feedback where it takes none");
    const twice = answer(pending(), (h) => {
      assert.equal(h.allow(false), true);
      assert.equal(h.deny("no"), false);
      assert.equal(h.open, false);
    });
    assert.equal(twice.sent.length, 1);
  });

  test("let go: left in T3, nothing sent; answered in T3 (resolved): closed here, told once", () => {
    const sent: Response[] = [];
    const p: Pending = { id: "req1", kind: "command", tool: { name: "Bash", input: {} }, questions: null, decisions: null, supportsFeedback: false };
    const released = new T3Held("t3:th1", "/c", p, (r) => (sent.push(r), true));
    assert.equal(released.release(), true);
    assert.equal(released.open, false);
    assert.equal(sent.length, 0);
    const elsewhere = new T3Held("t3:th1", "/c", p, (r) => (sent.push(r), true));
    let closed = 0;
    elsewhere.onClosed = () => closed++;
    elsewhere.resolved();
    elsewhere.resolved();
    assert.equal(closed, 1);
    assert.equal(elsewhere.allow(false), false);
    assert.equal(sent.length, 0);
    assert.equal(elsewhere.isPermission, true);
    assert.equal(elsewhere.saidThisTurn(), null);
  });

  test("the agent: held for you (onHeld) when what it asks could be read, else said once as before", () => {
    const before = { onHeld: t3code.onHeld, onNotice: t3code.onNotice };
    const held: Held[] = [];
    const notices: string[] = [];
    t3code.onHeld = (h) => held.push(h);
    t3code.onNotice = (line) => notices.push(line);
    try {
      const p: Pending = { id: "req-agent", kind: "command", tool: { name: "Bash", input: { command: "ls" } }, questions: null, decisions: null, supportsFeedback: false };
      waitingOf(thread({ pendingRuntimeRequest: { id: "req-agent", kind: "command" } }), p, "/code/pixie");
      waitingOf(thread(), null, "/code/pixie");
    } finally {
      Object.assign(t3code, before);
    }
    assert.equal(held.length, 1);
    assert.deepEqual([held[0].sessionId, held[0].cwd, held[0].isPermission, held[0].tool?.name], ["t3:th1", "/code/pixie", true, "Bash"]);
    assert.deepEqual(notices, ["Fix the login in T3 is waiting for you in T3 Code."]);
  });

  test("the agent: what it does itself (interrupt, rename, archive), with its own Close words", async () => {
    assert.deepEqual(t3code.can!({ sessionId: "t3:th1" } as any), { interrupt: true, rename: true, close: true });
    assert.equal(t3code.ending!.label, "Archive in T3 Code…");
    assert.equal(t3code.ending!.done("Pixie login"), "Archived Pixie login in T3 Code.");
    // Not connected (no T3 here): said why, nothing sent.
    assert.deepEqual(await t3code.interrupt!({ sessionId: "t3:th1", cwd: "/c" }), { done: false, why: "T3 Code isn't connected" });
    assert.deepEqual(await t3code.rename!({ sessionId: "t3:th1", cwd: "/c" }, "New"), { done: false, why: "T3 Code isn't connected" });
    assert.deepEqual(await t3code.end!({ sessionId: "t3:th1", kind: "interactive", desktop: false }), { sent: false, why: "T3 Code isn't connected" });
    assert.deepEqual(await t3code.rename!({ sessionId: "not-a-thread", cwd: "/c" }, "New"), { done: false, why: "it isn't a T3 Code thread" });
  });
});

describe("answering, stopping, renaming and archiving, against a fake T3", () => {
  const clients: T3Client[] = [];
  const fakes: FakeT3[] = [];
  after(async () => {
    for (const c of clients) c.stop();
    for (const f of fakes) await f.close().catch(() => {});
  });

  async function connected(script?: (fake: FakeT3) => void) {
    const fake = new FakeT3();
    fakes.push(fake);
    fake.project("p1", "/code/pixie", "pixie");
    fake.thread("th1", { title: "Fix the login" });
    script?.(fake);
    const port = await fake.listen();
    const logs: { event: string; data: Record<string, unknown> }[] = [];
    const client = new T3Client({ port, minter: fake.minter(), log: (event, data) => logs.push({ event, data }), backoffMs: [50, 100] });
    clients.push(client);
    const waiting: Array<{ thread: ShellThread; pending: Pending | null }> = [];
    const resolved: string[] = [];
    client.onWaiting = (thread, pending) => waiting.push({ thread, pending });
    client.onResolved = (_threadId, requestId) => resolved.push(requestId);
    await client.start();
    await until(() => client.shell.sessions().length === 1, "listed");
    return { fake, client, logs, waiting, resolved };
  }
  const commands = (fake: FakeT3, type: string) => fake.dispatched.filter((c) => c.type === type);

  test("a permission: what it asks read from the thread (subscribeThread), answered with runtime-request.respond; T3 says it's resolved", async () => {
    const { fake, client, waiting, resolved, logs } = await connected();
    const run = fake.startRun("th1", "run the tests");
    const id = fake.askPermission("th1", { command: "npm test" });
    await until(() => waiting.length === 1, "waiting");
    assert.deepEqual(waiting[0].pending?.tool, { name: "Bash", input: { command: "npm test" } });
    assert.equal(client.shell.sessions()[0].status, "blocked");
    assert.deepEqual(await client.respond("th1", id, { decision: "accept" }), { done: true });
    const [sent] = commands(fake, "runtime-request.respond");
    assert.deepEqual([sent.threadId, sent.requestId, sent.decision, typeof sent.commandId], ["th1", id, "accept", "string"]);
    assert.equal("createdBy" in sent, false, "only message.dispatch says who made it, as T3's client sends");
    await until(() => resolved.includes(id), "resolved");
    assert.equal(fake.requests.get(id)!.request.status, "resolved");
    assert.equal(client.shell.sessions()[0].status, "busy", "its run goes on");
    assert.equal(fake.threads.get("th1")!.latestRunId, run);
    assert.ok(logs.some((l) => l.event === "t3_waiting" && l.data.asked === "permission"));
    assert.ok(logs.some((l) => l.event === "t3_command" && l.data.type === "runtime-request.respond" && l.data.ok === true));
  });

  test("questions: T3's read and answered by their IDs; one with nothing to read is passed on as null (said, answered in T3)", async () => {
    const { fake, client, waiting } = await connected();
    fake.startRun("th1", "set it up");
    const id = fake.askQuestions("th1", [
      {
        id: "Which database?",
        header: "Database",
        question: "Which database?",
        options: [
          { label: "Postgres", description: "relational", value: "pg" },
          { label: "SQLite", description: "a file" },
        ],
      },
    ]);
    await until(() => waiting.length === 1, "waiting");
    const pending = waiting[0].pending!;
    assert.equal(pending.questions?.[0].question, "Which database?");
    await client.respond("th1", id, { answers: answersOf(pending.questions!, [{ labels: ["Postgres"], text: "" }]) });
    assert.deepEqual(commands(fake, "runtime-request.respond")[0].answers, { "Which database?": "pg" });
    await until(() => fake.threads.get("th1")!.pendingRuntimeRequest === null, "no longer waiting");
    fake.askPermission("th1", { none: true });
    await until(() => waiting.length === 2, "the next");
    assert.equal(waiting[1].pending, null);
  });

  test("answered in T3 meanwhile: resolved, and the client says so", async () => {
    const { fake, waiting, resolved } = await connected();
    fake.startRun("th1");
    const id = fake.askPermission("th1");
    await until(() => waiting.length === 1, "waiting");
    fake.resolveInT3(id);
    await until(() => resolved.includes(id), "resolved");
  });

  test("stop: run.interrupt of its live run (the queue held), as T3's client sends without thread.stop; thread.stop where the server has it; nothing running: why", async () => {
    const { fake, client } = await connected();
    assert.deepEqual(await client.interrupt("th1"), { done: false, why: "it isn't running anything" });
    const run = fake.startRun("th1", "go");
    await until(() => client.shell.threads.get("th1")?.status === "running", "running");
    assert.deepEqual(await client.interrupt("th1"), { done: true });
    const [sent] = commands(fake, "run.interrupt");
    assert.deepEqual([sent.threadId, sent.runId, sent.holdQueue], ["th1", run, true]);
    await until(() => client.shell.sessions()[0].status === "idle", "interrupted");
    const withStop = await connected((f) => (f.capabilities = { threadStop: true }));
    withStop.fake.startRun("th1", "go");
    await until(() => withStop.client.shell.threads.get("th1")?.status === "running", "running");
    assert.deepEqual(await withStop.client.interrupt("th1"), { done: true });
    assert.equal(commands(withStop.fake, "thread.stop").length, 1);
    assert.equal(commands(withStop.fake, "run.interrupt").length, 0);
  });

  test("rename: thread.metadata.update with its title; listed by it as T3 says so", async () => {
    const { fake, client } = await connected();
    assert.deepEqual(await client.rename("th1", "Login cookies"), { done: true });
    assert.equal(commands(fake, "thread.metadata.update")[0].title, "Login cookies");
    await until(() => client.shell.sessions()[0].givenName === "Login cookies", "renamed");
  });

  test("archive: thread.archive, and it leaves the list; a running one is stopped first (T3 won't archive it running)", async () => {
    const { fake, client } = await connected();
    assert.deepEqual(await client.archive("th1"), { done: true });
    await until(() => client.shell.sessions().length === 0, "archived: off the list");
    assert.ok(fake.threads.get("th1")!.archivedAt);
    const busy = await connected();
    busy.fake.startRun("th1", "go");
    await until(() => busy.client.shell.threads.get("th1")?.status === "running", "running");
    assert.deepEqual(await busy.client.archive("th1"), { done: true });
    assert.deepEqual(
      busy.fake.dispatched.map((c) => c.type),
      ["run.interrupt", "thread.archive"],
    );
    await until(() => busy.client.shell.sessions().length === 0, "archived");
  });

  test("a refused command: said why, logged", async () => {
    const { client, logs } = await connected();
    const refused = await client.respond("th1", "req-none", { decision: "accept" });
    assert.equal(refused.done, false);
    assert.match((refused as { why: string }).why, /No such pending request/);
    assert.ok(logs.some((l) => l.event === "t3_command" && l.data.ok === false));
  });
});

describe("a thread's conversation as a transcript file, for the window's viewer (agents/mirror.ts)", () => {
  const message = (id: string, role: string, text: string, fields: Record<string, unknown> = {}) => ({ id, role, text, createdAt: "2026-10-29T10:00:00.000Z", ...fields });

  test("its done messages as a transcript's lines, each once; one still streaming waits until it's done", () => {
    const written = new Set<string>();
    const first = messageLines({ messages: [message("m1", "user", "fix the login"), message("m2", "assistant", "Fixed", { streaming: true })] }, written);
    assert.deepEqual(
      first.map((l) => JSON.parse(l)),
      [{ type: "user", message: { role: "user", content: "fix the login" }, timestamp: "2026-10-29T10:00:00.000Z" }],
    );
    const next = messageLines({ messages: [message("m1", "user", "fix the login"), message("m2", "assistant", "Fixed it: the cookie had expired."), message("m3", "system", "x")] }, written);
    assert.deepEqual(
      next.map((l) => JSON.parse(l)),
      [{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Fixed it: the cookie had expired." }] }, timestamp: "2026-10-29T10:00:00.000Z" }],
    );
    assert.deepEqual(messageLines({ messages: [message("m1", "user", "fix the login")] }, written), [], "nothing new");
    assert.deepEqual(messageLines(null, written), []);
  });

  test("the file: private, written afresh as it's first shown, kept to the thread, read by the viewer's own reader; stopped once the thread isn't listed", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "t3m-")), "t3");
    const feeds = new Map<string, (projection: unknown) => void>();
    const stopped: string[] = [];
    const mirrors = new Mirrors(
      () => dir,
      watched((id, changed) => {
        feeds.set(id, changed);
        return { stop: () => stopped.push(id) };
      }),
    );
    const path = mirrors.path("th/1");
    assert.equal(path, join(dir, "th_1.jsonl"), "its ID made safe for a file name");
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(mirrors.path("th/1"), path, "the same file while it's kept");
    feeds.get("th/1")!({ messages: [message("m1", "user", "fix the login"), message("m2", "assistant", "Fixed it.")] });
    feeds.get("th/1")!({ messages: [message("m1", "user", "fix the login"), message("m2", "assistant", "Fixed it."), message("m3", "user", "now test it")] });
    assert.deepEqual(
      readHistory(path).items.map((i: any) => [i.kind, i.text]),
      [
        ["you", "fix the login"],
        ["claude", "Fixed it."],
        ["you", "now test it"],
      ],
    );
    mirrors.keepOnly(new Set(["th/1"]));
    assert.deepEqual(stopped, []);
    mirrors.keepOnly(new Set());
    assert.deepEqual(stopped, ["th/1"]);
    mirrors.stop();
  });
});

// A request for a new session in T3 Code, with T3 not open, once opened
// Claude Code in a scratch folder "t3-code". Now a session asked of T3 Code is a thread
// started in T3 Code (app.ts startInApp), or, with T3 not open, a terminal session in its place.
describe("a new session asked of T3 Code: a start in T3 Code, with T3's name never the project", () => {
  const world = makeWorld([CAST.voice, CAST.clipkit, CAST.pixie]);
  const decideWith = (voiceCan: VoiceCan, action: Action, text: string) => {
    const deps: DecideDeps = {
      utterance: null,
      approval: null,
      route: async () => ({ text: "", actions: [action], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 }),
      trim: null,
    };
    const state: DecideState = {
      text,
      sessions: world.sessions,
      notes: world.notes,
      recent: [],
      waiting: null,
      justSpoke: null,
      lastId: null,
      appAsked: false,
      lastSent: null,
      lastRepeat: false,
      voiceCan,
      quickTask: null,
      classifierMinConfidence: 0.75,
    };
    return decide(state, deps).then((d) => d.actions);
  };
  const start = (over: Partial<Action & { name: "start_session" }> = {}): Action => ({ name: "start_session", project: null, newProject: false, sessionName: "", prompt: "", ...over });
  const SCRATCH = { kind: "scratch", said: null };
  const inT3 = (where: object, more: object = {}) => [{ type: "start", where, name: "", prompt: "", app: "t3code", ...more }];

  test("asked of T3 Code: a start in it, the same whether T3 is open or not (the app decides as it starts it)", async () => {
    assert.deepEqual(await decideWith("everything", start({ agent: "t3code" }), "Open a new session in T3 code."), inT3(SCRATCH));
    const pixie = world.byName.get("pixie")!.cwd;
    assert.deepEqual(
      await decideWith("everything", start({ project: "pixie", agent: "t3code", prompt: "Fix the login bug." }), "Start a T3 thread in pixie and fix the login bug."),
      inT3({ kind: "project", cwd: pixie, how: "exact", name: "pixie", said: "pixie" }, { prompt: "Fix the login bug." }),
    );
  });

  test("the router's answers before it could name T3: its name as the project, or as the session's name, is no project and no name", async () => {
    assert.deepEqual(await decideWith("everything", start({ project: "T3 code" }), "Open a new session in T3 code."), inT3(SCRATCH));
    assert.deepEqual(await decideWith("everything", start({ sessionName: "T3" }), "Open new T3 session, please."), inT3(SCRATCH));
    assert.deepEqual(await decideWith("everything", start({ project: "T three" }), "start a session in T three"), inT3(SCRATCH));
  });

  test("another agent named too: what runs it in T3 (or starts in its place), never the start's own agent", async () => {
    const [codex] = await decideWith("everything", start({ project: "pixie", agent: "t3code" }), "Start a T3 thread in pixie on Codex.");
    assert.deepEqual([codex.type, (codex as any).app, (codex as any).agent], ["start", "t3code", "codex"]);
    const [claude] = await decideWith("everything", start({ agent: "t3code" }), "Open a T3 session with Claude.");
    assert.deepEqual([(claude as any).app, (claude as any).agent], ["t3code", "claude-code"]);
    const [none] = await decideWith("everything", start({ agent: "t3code" }), "Open a T3 session.");
    assert.equal((none as any).agent, undefined);
  });

  test("never redirected to a session already in that folder, never asked first: you named T3", async () => {
    const clipkit = world.byName.get("clipkit")!;
    const [a] = await decideWith("everything", start({ project: "clipkit", agent: "t3code" }), "Open a T3 thread in clipkit.");
    assert.deepEqual([a.type, (a as any).app, (a as any).where.cwd], ["start", "t3code", clipkit.cwd]);
  });

  test("starting sessions off: refused as any start is", async () => {
    const [refused] = await decideWith("messages", start({ agent: "t3code" }), "Open a new session in T3 code.");
    assert.deepEqual([refused.type, (refused as any).what, (refused as any).then?.type, (refused as any).then?.app], ["refused", "start", "start", "t3code"]);
  });

  test("unchanged: no agent, Codex, T3 only in the router's guess, or a new project called T3", async () => {
    const pixie = world.byName.get("pixie")!.cwd;
    assert.deepEqual(await decideWith("everything", start({ project: "pixie" }), "Open a new session in pixie."), [
      { type: "start", where: { kind: "project", cwd: pixie, how: "exact", name: "pixie", said: "pixie" }, name: "", prompt: "" },
    ]);
    assert.deepEqual(await decideWith("everything", start({ project: "pixie", agent: "codex" }), "Start a Codex session in pixie."), [
      { type: "start", where: { kind: "project", cwd: pixie, how: "exact", name: "pixie", said: "pixie" }, name: "", prompt: "", agent: "codex" },
    ]);
    // The router named T3 but the words don't: a session as usual.
    const guessed = (await decideWith("everything", start({ project: "pixie", agent: "t3code" }), "Open a new session in pixie."))[0];
    assert.deepEqual([guessed.type, (guessed as any).app], ["start", undefined]);
    // T3 in the words, but the session's name says more than T3's name.
    const adapter = (await decideWith("everything", start({ project: "pixie", sessionName: "T3 adapter" }), "Open a new session in pixie called T3 adapter."))[0];
    assert.deepEqual([adapter.type, (adapter as any).app], ["start", undefined]);
    // A new project you asked to be made by that name (here with no projects root, so that's what's said).
    const made = await decideWith("everything", start({ project: "T3", newProject: true }), "Make a new project called T3.");
    assert.deepEqual(made, [{ type: "say", text: "I don't know where your projects go. Set a projects root in Settings, under New sessions.", why: "no_projects_root" }]);
  });

  test("T3 Code is no terminal starter: asked of by name only; in the window's picker only while it's open and the folder is one of its projects", () => {
    assert.deepEqual(
      elsewhere().map((a) => a.id),
      ["t3code"],
    );
    assert.ok(!starters().includes(t3code));
    assert.ok(!offeredStarters().includes(t3code));
    assert.deepEqual(launchersIn("/code/pixie"), [], "T3 not connected here");
    for (const said of ["Open a new session in T3 code.", "Open new T3 session, please.", "a t three session", "T-3"]) assert.ok(t3code.heard!.test(said), said);
    for (const said of ["Start a session in pixie.", "meet at 3", "it's at 3 pm"]) assert.ok(!t3code.heard!.test(said), said);
  });
});

describe("which T3 project a new thread goes in (core/projects.ts projectAmong)", () => {
  const T3 = [
    { cwd: "/code/pixie", names: ["Pixie App", "pixie"], lastUsed: 2 },
    { cwd: "/code/clipkit", names: ["clipkit"], lastUsed: 1 },
  ];
  const at = (cwd: string, said: string, how: "exact" | "close" = "exact") => ({ kind: "project" as const, cwd, how, name: said, said });

  test("by its name in T3, by its folder's, by the folder Kiko found for the name, or close to its name", () => {
    assert.equal((projectAmong({ kind: "scratch", said: "pixie app" }, T3) as any).project.cwd, "/code/pixie");
    assert.equal((projectAmong(at("/code/pixie", "pixie"), T3) as any).project.cwd, "/code/pixie");
    assert.equal((projectAmong(at("/code/clipkit", "clip kit"), T3) as any).project.cwd, "/code/clipkit");
    const close = projectAmong({ kind: "scratch", said: "Pixy" }, T3) as any;
    assert.deepEqual([close.project.cwd, close.how], ["/code/pixie", "close"]);
  });

  test("named, and not one of T3's: unknown, as said; nothing named: its only project, else which isn't guessed", () => {
    assert.deepEqual(projectAmong(at("/code/tideline", "tideline"), T3), { unknown: "tideline" });
    assert.deepEqual(projectAmong({ kind: "scratch", said: "lacy" }, T3), { unknown: "lacy" });
    assert.deepEqual(projectAmong({ kind: "home", cwd: "/Users/me" }, T3), { unknown: "your home folder" });
    assert.equal(projectAmong({ kind: "scratch", said: null }, T3), "unnamed");
    assert.equal((projectAmong({ kind: "scratch", said: null }, [T3[1]]) as any).project.cwd, "/code/clipkit");
    assert.equal(projectAmong({ kind: "scratch", said: null }, []), "unnamed");
  });
});

describe("a new thread's launch, as T3's client makes one (launch.ts)", () => {
  const ready = (instanceId: string, driver: string, model: string, more: object = {}) => ({
    instanceId,
    driver,
    enabled: true,
    installed: true,
    status: "ready",
    models: [{ slug: model, name: model, isCustom: false, isDefault: true }],
    ...more,
  });
  const PROVIDERS = [ready("codex", "codex", "gpt-6-astra"), ready("claudeAgent", "claudeAgent", "claude-opus-5-5")];
  const project = { id: "p1", title: "pixie", workspaceRoot: "/code/pixie", defaultModelSelection: null };
  const settings = (more: object = {}) => ({
    defaultModelSelection: null,
    fallbackModelSelection: null,
    defaultRuntimeMode: "full-access",
    projectSettingsOverrides: {},
    projectSettingsFolded: true,
    ...more,
  });

  test("its model: the project's default, else the settings', else the first provider ready with its default model, else the fallback", () => {
    const sel = (instanceId: string, model: string) => ({ instanceId, model });
    assert.deepEqual(modelFor({ settings: settings(), providers: PROVIDERS }, project, null), sel("codex", "gpt-6-astra"));
    assert.deepEqual(modelFor({ settings: settings({ defaultModelSelection: sel("claudeAgent", "claude-sonnet-5") }), providers: PROVIDERS }, project, null), sel("claudeAgent", "claude-sonnet-5"));
    const overridden = settings({ defaultModelSelection: sel("codex", "gpt-6-astra"), projectSettingsOverrides: { p1: { defaultModelSelection: sel("claudeAgent", "claude-opus-5-5") } } });
    assert.deepEqual(modelFor({ settings: overridden, providers: PROVIDERS }, project, null), sel("claudeAgent", "claude-opus-5-5"));
    // The project's own, until T3 folds it into the overrides; an older one names its provider.
    const own = { ...project, defaultModelSelection: { provider: "claudeAgent", model: "claude-haiku-5" } };
    assert.deepEqual(modelFor({ settings: settings({ projectSettingsFolded: false }), providers: PROVIDERS }, own, null), sel("claudeAgent", "claude-haiku-5"));
    assert.deepEqual(modelFor({ settings: settings(), providers: PROVIDERS }, own, null), sel("codex", "gpt-6-astra"), "folded: the project's own no longer counts");
    // Codex not ready (signed out): the next that is; disabled for this project: the same.
    assert.deepEqual(modelFor({ settings: settings(), providers: [{ ...PROVIDERS[0], status: "error" }, PROVIDERS[1]] }, project, null), sel("claudeAgent", "claude-opus-5-5"));
    assert.deepEqual(
      modelFor({ settings: settings({ projectSettingsOverrides: { p1: { providerInstances: { codex: { enabled: false } } } } }), providers: PROVIDERS }, project, null),
      sel("claudeAgent", "claude-opus-5-5"),
    );
    assert.deepEqual(modelFor({ settings: settings({ fallbackModelSelection: sel("codex", "gpt-5.6-sol") }), providers: [] }, project, null), sel("codex", "gpt-5.6-sol"));
    assert.equal(modelFor({ settings: settings(), providers: [] }, project, null), null);
    assert.equal(modelFor(null, project, null), null);
  });

  test("one named: that driver's first instance ready, with its default model; none: null", () => {
    assert.deepEqual(modelFor({ settings: settings(), providers: PROVIDERS }, project, DRIVERS["claude-code"]), { instanceId: "claudeAgent", model: "claude-opus-5-5" });
    assert.deepEqual(modelFor({ settings: settings({ defaultModelSelection: { instanceId: "claudeAgent", model: "x" } }), providers: PROVIDERS }, project, DRIVERS.codex), {
      instanceId: "codex",
      model: "gpt-6-astra",
    });
    assert.equal(modelFor({ settings: settings(), providers: PROVIDERS }, project, DRIVERS.opencode), null);
  });

  test("its runtime mode: the project's, else the settings', else full access", () => {
    assert.equal(runtimeModeFor({ settings: settings() }, project), "full-access");
    assert.equal(runtimeModeFor({ settings: settings({ defaultRuntimeMode: "approval-required" }) }, project), "approval-required");
    assert.equal(runtimeModeFor({ settings: settings({ projectSettingsOverrides: { p1: { defaultRuntimeMode: "auto-accept-edits" } } }) }, project), "auto-accept-edits");
    assert.equal(runtimeModeFor({}, project), "full-access");
  });

  test("its input: titled from the message (T3 titles it from there) or by the name given; no message, an empty thread called New thread", () => {
    const model = { instanceId: "codex", model: "gpt-6-astra" };
    const asked = launchInput({ threadId: "th9", projectId: "p1", name: "", prompt: "  Fix the\nlogin bug.  ", model, runtimeMode: "full-access" }) as any;
    assert.deepEqual(
      { ...asked, commandId: "c", initialMessage: { ...asked.initialMessage, messageId: "m" } },
      {
        commandId: "c",
        creationSource: "web",
        threadId: "th9",
        projectId: "p1",
        title: "Fix the login bug.",
        generateTitle: true,
        modelSelection: model,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: { messageId: "m", text: "Fix the\nlogin bug.", attachments: [] },
      },
    );
    const named = launchInput({ threadId: "th9", projectId: "p1", name: "Login fix", prompt: "Fix it.", model, runtimeMode: "full-access" }) as any;
    assert.deepEqual([named.title, named.generateTitle], ["Login fix", false]);
    const empty = launchInput({ threadId: "th9", projectId: "p1", name: "", prompt: "", model, runtimeMode: "full-access" }) as any;
    assert.deepEqual([empty.title, empty.generateTitle, "initialMessage" in empty], ["New thread", false, false]);
    assert.equal(titleOf("x".repeat(60)), `${"x".repeat(50)}...`);
  });
});

describe("a new thread, against a fake T3", () => {
  const clients: T3Client[] = [];
  const fakes: FakeT3[] = [];
  after(async () => {
    for (const c of clients) c.stop();
    for (const f of fakes) await f.close().catch(() => {});
  });

  async function connected(script?: (fake: FakeT3) => void) {
    const fake = new FakeT3();
    fakes.push(fake);
    fake.project("p1", "/code/pixie", "pixie");
    fake.thread("th1", { title: "Fix the login" });
    script?.(fake);
    const port = await fake.listen();
    const logs: { event: string; data: Record<string, unknown> }[] = [];
    const client = new T3Client({ port, minter: fake.minter(), log: (event, data) => logs.push({ event, data }), backoffMs: [50, 100] });
    clients.push(client);
    const started: Started[] = [];
    client.onStarted = (s) => started.push(s);
    await client.start();
    await until(() => client.shell.sessions().length === 1, "listed");
    return { fake, client, logs, started };
  }

  test("with a first message: server.getConfig, then orchestration.launchThread as T3's client sends it; listed beside the threads already there, its run started with the message", async () => {
    const { fake, client, logs, started } = await connected();
    const made = await client.launch({ projectId: "p1", name: "", prompt: "Fix the cookie bug.", driver: null });
    assert.equal(made.done, true);
    const id = (made as { threadId: string }).threadId;
    const tags = fake.frames.filter((f) => f._tag === "Request").map((f) => f.tag);
    assert.ok(tags.indexOf("server.getConfig") < tags.indexOf("orchestration.launchThread"), "its config read first");
    const sent = fake.launched.at(-1);
    assert.deepEqual(
      [
        sent.threadId,
        sent.projectId,
        sent.title,
        sent.generateTitle,
        sent.modelSelection,
        sent.runtimeMode,
        sent.interactionMode,
        sent.workspaceStrategy,
        sent.initialMessage.text,
        sent.creationSource,
      ],
      [id, "p1", "Fix the cookie bug.", true, { instanceId: "codex", model: "gpt-6-astra" }, "full-access", "default", { type: "root" }, "Fix the cookie bug.", "web"],
    );
    assert.equal(fake.dispatched.length, 0, "nothing through dispatchCommand: launchThread makes it and sends its message");
    // Listed by the time it's done, as an outside session (T3's), beside the one that was there.
    assert.deepEqual(
      client.shell
        .sessions()
        .map((s) => [s.sessionId, s.cwd, s.agent])
        .sort(),
      [
        [`t3:${id}`, "/code/pixie", "t3code"],
        ["t3:th1", "/code/pixie", "t3code"],
      ],
    );
    await until(() => started.some((s) => s.thread.id === id), "its run told as started");
    assert.equal(started.find((s) => s.thread.id === id)!.asked, "Fix the cookie bug.");
    assert.deepEqual(logs.find((l) => l.event === "t3_command" && l.data.type === "launchThread")?.data, { type: "launchThread", threadId: id, ok: true, model: "codex", prompt: true });
    assert.ok(!JSON.stringify(logs).includes("cookie"), "never your words in the log");
  });

  test("without one: an empty thread, New thread, nothing started; on the provider named", async () => {
    const { fake, client, started } = await connected();
    const made = await client.launch({ projectId: "p1", name: "", prompt: "", driver: "claudeAgent" });
    assert.equal(made.done, true);
    const sent = fake.launched.at(-1);
    assert.deepEqual([sent.title, sent.generateTitle, "initialMessage" in sent, sent.modelSelection.instanceId], ["New thread", false, false, "claudeAgent"]);
    const id = (made as { threadId: string }).threadId;
    assert.equal(client.shell.threads.get(id)?.status, "idle");
    await wait(100);
    assert.equal(started.length, 0);
  });

  test("refused, a project T3 doesn't have, no provider ready, not connected: why, logged, nothing made", async () => {
    const { fake, client, logs } = await connected();
    fake.refuseLaunch = "Provider is disabled.";
    const refused = await client.launch({ projectId: "p1", name: "", prompt: "go", driver: null });
    assert.deepEqual(refused, { done: false, why: "T3 Code didn't take it (OrchestrationV2ThreadLaunchError: Provider is disabled.)" });
    assert.ok(logs.some((l) => l.event === "t3_command" && l.data.type === "launchThread" && l.data.ok === false));
    fake.refuseLaunch = null;
    assert.deepEqual(await client.launch({ projectId: "nope", name: "", prompt: "", driver: null }), { done: false, why: "that project isn't in T3 Code" });
    assert.deepEqual(await client.launch({ projectId: "p1", name: "", prompt: "", driver: "opencode" }), { done: false, why: "T3 Code has no provider of that kind ready" });
    fake.config = { settings: {}, providers: [] };
    assert.deepEqual(await client.launch({ projectId: "p1", name: "", prompt: "", driver: null }), { done: false, why: "T3 Code has no provider ready to start a thread on" });
    assert.equal(fake.launched.length, 1, "only the one T3 refused reached it");
    client.stop();
    assert.deepEqual(await client.launch({ projectId: "p1", name: "", prompt: "", driver: null }), { done: false, why: "T3 Code isn't connected" });
  });
});
