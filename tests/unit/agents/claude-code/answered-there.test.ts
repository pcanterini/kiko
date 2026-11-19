// A Claude Code permission prompt answered in Claude Code's own dialog while Kiko holds its hook
// (src/agents/claude-code/answered-there.ts): its tool_use found in its transcript (the most recent
// of its tool and input with nothing after it), the first sign its session moved past it, and the
// watch over its transcript and its session's process record. Transcripts and records here are this
// test's own (tests/setup.ts: KIKO_CLAUDE_SESSIONS), never ~/.claude.
import "../../../setup.ts";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { findPrompt, pastIt, promptTranscript, sameInput, watchPrompt, type PastSign } from "../../../../src/agents/claude-code/answered-there.ts";
import { recordStatus } from "../../../../src/agents/claude-code/sessions.ts";
import { checkWaits } from "../../../support/until.ts";

const until = checkWaits(3000, 10);

// Entries as Claude Code 2.1.319 writes them: one content block an entry, a message's blocks under one message.id.
const call = (id: string, name: string, input: Record<string, unknown>, messageId = `msg_${id}`) => ({
  type: "assistant",
  timestamp: new Date().toISOString(),
  message: { id: messageId, role: "assistant", content: [{ type: "tool_use", id, name, input }] },
});
const said = (text: string, messageId: string) => ({ type: "assistant", message: { id: messageId, role: "assistant", content: [{ type: "text", text }] } });
const result = (id: string, isError = false) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: isError ? "The user doesn't want to proceed" : "ok", is_error: isError }] },
});
const prompt = (text: string) => ({ type: "user", message: { role: "user", content: text } });
const BOOKKEEPING = [
  { type: "queue-operation", operation: "enqueue", content: "hi" },
  { type: "last-prompt", lastPrompt: "x" },
  { type: "ai-title", aiTitle: "x" },
  { type: "permission-mode", permissionMode: "default" },
  { type: "attachment", attachment: { type: "hook_success" } },
  { type: "file-history-snapshot" },
  { type: "system", subtype: "informational" },
];

const npmTest = { name: "Bash", input: { command: "npm test", description: "Run the tests" } };

describe("finding the prompt's own tool_use", () => {
  test("the most recent of its tool and input with nothing after it: matched", () => {
    const entries = [prompt("run the tests"), said("Running them.", "m1"), call("t1", "Bash", npmTest.input, "m1"), ...BOOKKEEPING];
    assert.deepEqual(findPrompt(entries, npmTest), { id: "t1", messageId: "m1" });
  });

  test("another tool, or the same tool with other input: not matched", () => {
    const entries = [call("t1", "Bash", { command: "npm run build" }), call("t2", "Edit", { file_path: "a.ts" })];
    assert.equal(findPrompt(entries, npmTest), null);
    assert.equal(findPrompt([], npmTest), null, "not written yet");
  });

  test("an older call of the same input, answered already, isn't it: the newer is; with only the older, none", () => {
    const older = [call("t1", "Bash", npmTest.input, "m1"), result("t1"), said("Passed.", "m2")];
    assert.equal(findPrompt(older, npmTest), null, "its result is after it");
    assert.equal(findPrompt([call("t1", "Bash", npmTest.input, "m1"), said("Next.", "m2")], npmTest), null, "the turn went on to another message after it");
    assert.equal(findPrompt([call("t1", "Bash", npmTest.input, "m1"), prompt("[Request interrupted by user for tool use]")], npmTest), null, "interrupted");
    assert.deepEqual(findPrompt([...older, prompt("again"), call("t2", "Bash", npmTest.input, "m3")], npmTest), { id: "t2", messageId: "m3" });
  });

  test("a call beside it in the same message, and its result, don't count against it", () => {
    const entries = [call("t1", "Bash", npmTest.input, "m1"), call("t2", "Read", { file_path: "a.ts" }, "m1"), result("t2")];
    assert.deepEqual(findPrompt(entries, npmTest), { id: "t1", messageId: "m1" });
  });

  test("input as the hook sends it: a long field cut to 2000 characters and '…' matches its start; other fields as they are", () => {
    const long = `echo ${"x".repeat(3000)}`;
    assert.ok(sameInput({ command: `${long.slice(0, 2000)}…` }, { command: long }));
    assert.ok(!sameInput({ command: `${"y".repeat(2000)}…` }, { command: long }));
    assert.ok(sameInput({ command: "npm test", timeout: 5 }, { command: "npm test", timeout: 9 }), "only text fields compared");
    assert.ok(sameInput(undefined, { command: "npm test" }), "no input to compare: by its tool alone");
    assert.ok(!sameInput({ command: "npm test" }, { command: "npm test " }));
  });
});

describe("what shows its session moved past it", () => {
  const use = { id: "t1", messageId: "m1" };

  test("its own tool_use being written, a call beside it, its own bookkeeping: nothing", () => {
    assert.equal(pastIt(call("t1", "Bash", npmTest.input, "m1"), use), null, "its own tool_use");
    assert.equal(pastIt(call("t2", "Read", { file_path: "a" }, "m1"), use), null, "a part of the same message");
    assert.equal(pastIt(result("t2"), use), null, "another call's result");
    for (const entry of BOOKKEEPING) assert.equal(pastIt(entry, use), null, entry.type);
    assert.equal(pastIt({ type: "progress", toolUseID: "t9", data: { type: "bash_progress" } }, use), null, "another call's progress");
  });

  test("its result (allowed and done, or denied), its progress, an interruption, the next message, its turn's end", () => {
    assert.equal(pastIt(result("t1"), use), "tool_result");
    assert.equal(pastIt(result("t1", true), use), "tool_result", "denied there");
    assert.equal(pastIt({ type: "progress", toolUseID: "t1", data: { type: "bash_progress" } }, use), "progress");
    assert.equal(pastIt({ type: "progress", parentToolUseID: "t1", data: { type: "hook_progress" } }, use), "progress");
    assert.equal(pastIt(prompt("[Request interrupted by user for tool use]"), use), "interrupted");
    assert.equal(pastIt(said("Done.", "m2"), use), "next_message");
    assert.equal(pastIt({ type: "system", subtype: "turn_duration" }, use), "turn_ended");
  });
});

describe("where its call is: its session's transcript, or its subagent's own", () => {
  test("a subagent's: <session>/subagents/agent-<id>.jsonl beside the session's, when it's there", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiko-there-"));
    const main = join(dir, "s1.jsonl");
    assert.equal(promptTranscript(main, "s1"), main);
    assert.equal(promptTranscript(undefined, "s1"), null);
    assert.equal(promptTranscript(main, "s1", "a1b2"), null, "not there: none (the session's has no call of a subagent's)");
    mkdirSync(join(dir, "s1", "subagents"), { recursive: true });
    writeFileSync(join(dir, "s1", "subagents", "agent-a1b2.jsonl"), "");
    assert.equal(promptTranscript(main, "s1", "a1b2"), join(dir, "s1", "subagents", "agent-a1b2.jsonl"));
  });
});

describe("watching a held prompt", () => {
  const lines = (...entries: unknown[]) => entries.map((e) => `${JSON.stringify(e)}\n`).join("");
  const records = process.env.KIKO_CLAUDE_SESSIONS!;
  mkdirSync(records, { recursive: true });
  const record = (pid: number, sessionId: string, status: string) => writeFileSync(join(records, `${pid}.json`), JSON.stringify({ pid, sessionId, status }));

  function watch(o: { sessionId: string; transcript: string | null; pids?: number[]; open?: () => boolean }) {
    const signs: PastSign[] = [];
    let held = true;
    const stop = watchPrompt({
      sessionId: o.sessionId,
      transcript: o.transcript,
      call: npmTest,
      pids: o.pids ?? [],
      open: o.open ?? (() => held),
      answered: (s) => signs.push(s),
      everyMs: 15,
      recordEveryMs: 15,
    });
    return { signs, stop, letGo: () => (held = false) };
  }

  test("its tool_use there already: nothing for what's written beside it; its result, once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiko-there-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(path, lines(prompt("run the tests"), call("t0", "Bash", npmTest.input, "m0"), result("t0"), said("Again.", "m1"), call("t1", "Bash", npmTest.input, "m1")));
    const w = watch({ sessionId: "s-there", transcript: path });
    appendFileSync(path, lines(...BOOKKEEPING, call("t2", "Read", { file_path: "a" }, "m1"), result("t2")));
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(w.signs, [], "its own message's other call and its result, bookkeeping: nothing");
    appendFileSync(path, lines(result("t1")));
    await until(() => w.signs.length > 0, 2000, "its result");
    appendFileSync(path, lines(said("Passed.", "m2")));
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(w.signs, ["tool_result"], "once");
  });

  test("its tool_use written after its hook came in: found then, followed past it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiko-there-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(path, lines(prompt("run the tests")));
    const w = watch({ sessionId: "s-later", transcript: path });
    await new Promise((r) => setTimeout(r, 50));
    appendFileSync(path, lines(said("Running them.", "m1"), call("t1", "Bash", npmTest.input, "m1")));
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(w.signs, [], "its own tool_use written: nothing");
    appendFileSync(path, lines(prompt("[Request interrupted by user for tool use]")));
    await until(() => w.signs.length > 0, 2000, "interrupted");
    assert.deepEqual(w.signs, ["interrupted"]);
  });

  test("no longer held (answered from Kiko): the watch stops, and says nothing after", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiko-there-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(path, lines(call("t1", "Bash", npmTest.input, "m1")));
    const w = watch({ sessionId: "s-kiko", transcript: path });
    w.letGo();
    appendFileSync(path, lines(result("t1")));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(w.signs, []);
  });

  test("its session's record: its dialog up ('waiting'), then not: answered there, though its transcript says nothing yet (a long command running)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiko-there-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(path, lines(call("t1", "Bash", npmTest.input, "m1")));
    record(4101, "s-record", "busy");
    const w = watch({ sessionId: "s-record", transcript: path, pids: [4101] });
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(w.signs, [], "busy, never seen waiting: nothing (its dialog may not be up yet)");
    record(4101, "s-record", "waiting");
    assert.equal(recordStatus("s-record", [4101]), "waiting");
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(w.signs, []);
    record(4101, "s-record", "busy");
    await until(() => w.signs.length > 0, 2000, "its dialog gone");
    assert.deepEqual(w.signs, ["dialog_closed"]);
  });

  test("another process's record (or another session's at that pid) says nothing of it", () => {
    record(4102, "someone-else", "waiting");
    assert.equal(recordStatus("s-other", [4102]), null);
    assert.equal(recordStatus("s-other", [4999, undefined]), null, "no record");
  });

  test("two of a session's prompts held at once: its record can't tell whose dialog closed, so only their transcript says", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiko-there-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(path, lines(call("t1", "Bash", npmTest.input, "m1")));
    record(4103, "s-two", "waiting");
    const a = watch({ sessionId: "s-two", transcript: path, pids: [4103] });
    const b = watch({ sessionId: "s-two", transcript: null, pids: [4103] });
    await new Promise((r) => setTimeout(r, 50));
    record(4103, "s-two", "busy");
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual([a.signs, b.signs], [[], []]);
    appendFileSync(path, lines(result("t1")));
    await until(() => a.signs.length > 0, 2000, "its result");
    assert.deepEqual(a.signs, ["tool_result"]);
    // The other, alone now: the dialog it saw go was the first's, so nothing yet; its own, up and gone, is.
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(b.signs, []);
    record(4103, "s-two", "waiting");
    await new Promise((r) => setTimeout(r, 60));
    record(4103, "s-two", "busy");
    await until(() => b.signs.length > 0, 2000, "its dialog gone");
    assert.deepEqual(b.signs, ["dialog_closed"]);
  });
});
