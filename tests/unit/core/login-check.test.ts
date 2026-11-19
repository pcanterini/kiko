// "Not logged in · Please run /login" in place of a session's reply (src/core/login-check.ts, and
// history.ts turnSoFar): read from the transcript (no Stop hook comes for it), said, and a session's
// first message sent again once, after Claude Code's 30 seconds of a failed Keychain read. The
// transcript lines have the shapes Claude Code 2.1.314 wrote for a session: the prompt, attachments,
// then a "<synthetic>" assistant entry.
import "../../setup.ts";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { turnSoFar, type TurnSoFar } from "../../../src/core/history.ts";
import { LOGIN_TIMES, loginFailed, LoginWatch, type LoginTold } from "../../../src/core/login-check.ts";

const PROMPT = "Set the screen brightness to 50%.";
let n = 0;
const you = (text: string) => ({ type: "user", uuid: `u${++n}`, timestamp: "2026-10-30T12:00:06.887Z", message: { role: "user", content: text } });
const attachment = { type: "attachment", attachment: { type: "date" } };
const notLoggedIn = {
  type: "assistant",
  isApiErrorMessage: true,
  error: "authentication_failed",
  message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Not logged in · Please run /login" }] },
};
const reply = (text: string) => ({ type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "text", text }] } });
const toolResult = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } };

function transcript(entries: object[]) {
  const path = join(mkdtempSync(join(tmpdir(), "login-")), "t.jsonl");
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
}

describe("turnSoFar", () => {
  test("the incident's transcript: failed, authentication_failed, with its words and its prompt", () => {
    const t = turnSoFar(transcript([{ type: "mode", mode: "normal" }, attachment, you(PROMPT), attachment, attachment, notLoggedIn, { type: "system", subtype: "turn_duration" }]));
    assert.equal(t.kind, "failed");
    assert.deepEqual({ ...t, id: "" }, { kind: "failed", id: "", prompt: PROMPT, error: "authentication_failed", text: "Not logged in · Please run /login" });
    assert.ok(loginFailed(t));
  });
  test("a reply (text, or a tool call first): reply; nothing yet: none; no file: none", () => {
    assert.equal(turnSoFar(transcript([you(PROMPT), reply("Done: the volume is at 10%.")])).kind, "reply");
    assert.equal(turnSoFar(transcript([you(PROMPT), { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }, toolResult])).kind, "reply");
    assert.equal(turnSoFar(transcript([you(PROMPT), attachment])).kind, "none");
    assert.equal(turnSoFar(transcript([attachment])).kind, "none");
    assert.equal(turnSoFar(join(tmpdir(), "nope.jsonl")).kind, "none");
    assert.equal(turnSoFar(undefined).kind, "none");
  });
  test("only the latest turn: an old failure followed by a prompt sent again, still waiting, is none; then its reply", () => {
    const path = transcript([you(PROMPT), notLoggedIn, you(PROMPT)]);
    assert.equal(turnSoFar(path).kind, "none");
    appendFileSync(path, JSON.stringify(reply("ok")) + "\n");
    assert.equal(turnSoFar(path).kind, "reply");
  });
  test("a tool's result and a wrapped message aren't prompts", () => {
    const t = turnSoFar(transcript([you("Earlier."), reply("Sure."), you(PROMPT), toolResult, you("<command-name>/model</command-name>"), notLoggedIn]));
    assert.equal(t.kind, "failed");
    assert.equal((t as Extract<TurnSoFar, { kind: "failed" }>).prompt, PROMPT);
  });
  // A long first message, as Claude Code hands it on: between its paste lines (2026-11-14: starting
  // with "<", it was passed over as a wrapper, and the turn read from the prompt before it).
  test("a long prompt, wrapped as a paste, is the prompt: its turn's failure is seen, its words without the paste lines", () => {
    const long = "Set the screen brightness to half, and then tell me what it was before. ".repeat(12).trim();
    const pasted = `\n\n<pasted_content id="7169">\n${long}\n</pasted_content id="7169">\n`;
    const t = turnSoFar(transcript([you("Earlier."), reply("Sure."), you(pasted), attachment, notLoggedIn]));
    assert.equal(t.kind, "failed");
    assert.equal((t as Extract<TurnSoFar, { kind: "failed" }>).prompt, long);
    // Your words in a block after one that isn't yours: still the prompt.
    const blocks = {
      type: "user",
      uuid: "b1",
      message: {
        role: "user",
        content: [
          { type: "text", text: "<some-new-wrapper>a.ts is open</some-new-wrapper>" },
          { type: "text", text: PROMPT },
        ],
      },
    };
    assert.deepEqual(turnSoFar(transcript([you("Earlier."), reply("Sure."), blocks, reply("Done.")])), { kind: "reply", id: "b1", prompt: PROMPT });
  });
  test("loginFailed: its error, or its words; other errors aren't", () => {
    assert.ok(loginFailed({ kind: "failed", id: "", prompt: "", error: "", text: "Not logged in · Please run /login" }));
    assert.ok(!loginFailed({ kind: "failed", id: "", prompt: "", error: "rate_limit", text: "Server is temporarily limiting requests" }));
    assert.ok(!loginFailed({ kind: "reply", id: "", prompt: "" }));
  });
});

describe("LoginWatch", () => {
  /** A session's turns as the watch reads them (each read takes the next, the last repeating), on a clock of its own. */
  function rig(o: { reads: TurnSoFar[]; opened?: { prompt: string; at: number } | null; typed?: boolean }) {
    let clock = 1_000_000;
    // Opened 6 seconds before the watch starts.
    const opened = o.opened === undefined ? { prompt: PROMPT, at: clock - 6_000 } : o.opened;
    const reads = [...o.reads];
    const told: LoginTold[] = [];
    const typedAgain: string[] = [];
    const slept: number[] = [];
    const watch = new LoginWatch({
      read: () => (reads.length > 1 ? reads.shift()! : reads[0]),
      opened: () => opened,
      typeAgain: async (_id, prompt) => (typedAgain.push(prompt), o.typed ?? true),
      tell: (_id, what) => void told.push(what),
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    return { watch, told, typedAgain, slept, push: (...t: TurnSoFar[]) => reads.push(...t) };
  }
  const failed = (id = "u1", prompt = PROMPT): TurnSoFar => ({ kind: "failed", id, prompt, error: "authentication_failed", text: "Not logged in · Please run /login" });
  const replied = (id = "u2", prompt = PROMPT): TurnSoFar => ({ kind: "reply", id, prompt });
  const none: TurnSoFar = { kind: "none" };

  test("its first message failed to log in: said, sent again once 35s after it opened, and its reply is the end of it", async () => {
    const r = rig({ reads: [none, failed(), failed(), none, replied()] });
    await r.watch.watch("s1", PROMPT);
    // Opened 6s before the failure was read (plus the half-second it waited for it): sent again 35s after it opened.
    assert.deepEqual(r.told, [{ kind: "retrying", inMs: LOGIN_TIMES.retryAfterMs - 6_000 - LOGIN_TIMES.everyMs }]);
    assert.deepEqual(r.typedAgain, [PROMPT]);
  });
  test("failed again after being sent again: said, with the words kept for try again; never a third time", async () => {
    const r = rig({ reads: [failed(), failed(), failed("u2")] });
    await r.watch.watch("s1", PROMPT);
    assert.deepEqual(r.told, [
      { kind: "retrying", inMs: LOGIN_TIMES.retryAfterMs - 6_000 },
      { kind: "failed", again: true, prompt: PROMPT },
    ]);
    assert.deepEqual(r.typedAgain, [PROMPT]);
    r.push(failed("u3"));
    await r.watch.watch("s1", PROMPT);
    assert.deepEqual(r.typedAgain, [PROMPT]);
  });
  test("the turn that failed isn't read as the one sent again (the hook and the app both watching)", async () => {
    // After it's sent again, the transcript still ends with the failure for a moment: not counted.
    const r = rig({ reads: [failed(), failed(), failed(), failed(), replied()] });
    await r.watch.watch("s1", PROMPT);
    assert.equal(r.told.length, 1);
  });
  test("a message that isn't the one it opened with (typed later, or a session it didn't open): said, not sent again", async () => {
    const later = rig({ reads: [failed("u5", "Now run the tests.")] });
    await later.watch.watch("s1", "Now run the tests.");
    assert.deepEqual(later.told, [{ kind: "failed", again: false, prompt: "Now run the tests." }]);
    assert.deepEqual(later.typedAgain, []);
    const outside = rig({ reads: [failed()], opened: null });
    await outside.watch.watch("s1", PROMPT);
    assert.deepEqual(outside.told, [{ kind: "failed", again: false, prompt: PROMPT }]);
  });
  // The hook tells a long prompt with Claude Code's paste lines around it; the transcript is read without them.
  test("a long prompt told with its paste lines is the turn read without them", async () => {
    const long = "Set the screen brightness to half, and then tell me what it was before. ".repeat(12).trim();
    const r = rig({ reads: [failed("u7", long)], opened: null });
    await r.watch.watch("s1", `<pasted_content id="7169">\n${long}\n</pasted_content id="7169">`);
    assert.deepEqual(
      r.told.map((t) => t.kind),
      ["failed"],
    );
  });
  test("something else typed in while it waited to send it again: nothing sent", async () => {
    const r = rig({ reads: [failed(), replied("u9", "never mind, I did it")] });
    await r.watch.watch("s1", PROMPT);
    assert.equal(r.told[0].kind, "retrying");
    assert.deepEqual(r.typedAgain, []);
  });
  test("a reply, another error, or nothing within its time: nothing said", async () => {
    const ok = rig({ reads: [none, replied("u1")] });
    await ok.watch.watch("s1", PROMPT);
    const other = rig({ reads: [{ kind: "failed", id: "u1", prompt: PROMPT, error: "rate_limit", text: "Server is temporarily limiting requests" }] });
    await other.watch.watch("s1", PROMPT);
    const quiet = rig({ reads: [none] });
    await quiet.watch.watch("s1", PROMPT);
    for (const r of [ok, other, quiet]) assert.deepEqual([r.told, r.typedAgain], [[], []]);
    assert.equal(
      quiet.slept.reduce((a, b) => a + b, 0),
      LOGIN_TIMES.forMs,
    );
  });
  test("an earlier turn's reply isn't this prompt's (the hook can come before its entry is written)", async () => {
    const r = rig({ reads: [replied("u0", "What's the weather?"), failed()] });
    await r.watch.watch("s1", PROMPT);
    assert.equal(r.told[0]?.kind, "retrying");
  });
  test("not typed in again (its terminal refused): no more watching; the refusal was said where it was typed", async () => {
    const r = rig({ reads: [failed()], typed: false });
    await r.watch.watch("s1", PROMPT);
    assert.deepEqual(r.told, [{ kind: "retrying", inMs: LOGIN_TIMES.retryAfterMs - 6_000 }]);
    assert.deepEqual(r.typedAgain, [PROMPT]);
  });
  test("once per session at a time; an empty prompt isn't watched", async () => {
    const r = rig({ reads: [none, none, failed()] });
    await Promise.all([r.watch.watch("s1", PROMPT), r.watch.watch("s1", PROMPT), r.watch.watch("s2", "")]);
    assert.equal(r.told.filter((t) => t.kind === "retrying").length, 1);
  });
});
