// A summary that couldn't connect (src/core/summarizer.ts RETRY_AFTER_MS), 2026-11-20, from the owner's
// log: a network blip, and a session's finished turn went unread ("Connection error." after the SDK's
// own quick retries); the next summary, 15s later, went through. Now one more try after a short wait,
// before it's given up on (app/announce.ts then shows the reply and its "(no reply…)" note, as before).
// Only when nothing was said yet: never the same words twice. No network: a stand-in fetch.
import "../../setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { config } from "../../../src/core/config.ts";
import { couldNotConnect, Summarizer } from "../../../src/core/summarizer.ts";

const event = (e: Record<string, unknown>) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
const ANSWER =
  event({
    type: "message_start",
    message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 500, output_tokens: 1 } },
  }) +
  event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
  event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Quill fixed the tests." } }) +
  event({ type: "content_block_stop", index: 0 }) +
  event({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } }) +
  event({ type: "message_stop" });

/** How many requests fail to connect before one answers (Infinity: none does). */
let failing = 0;
let calls = 0;
const realFetch = globalThis.fetch;
before(() => {
  config.llm = "haiku";
  globalThis.fetch = (async () => {
    calls++;
    if (calls <= failing) throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
    return new Response(ANSWER, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  calls = 0;
});

const TURN = { name: "Quill", titled: true, nameSession: false, context: [], asked: [], claudeReply: "I fixed the tests." };

test("couldn't connect (the SDK's own retries too): tried once more after the wait, and heard", async () => {
  // The SDK's first try and its two retries all fail; ours gets through.
  failing = 3;
  const heard: string[] = [];
  const r = await new Summarizer({ retryMs: 50 }).summarize(TURN, (d) => heard.push(d));
  assert.equal(r?.text, "Quill fixed the tests.");
  assert.equal(heard.join(""), "Quill fixed the tests.");
  assert.equal(calls, 4);
});

test("still can't: given up on after that one more try, as the error it was", async () => {
  failing = Number.POSITIVE_INFINITY;
  await assert.rejects(
    new Summarizer({ retryMs: 50 }).summarize(TURN, () => {}),
    /Connection error/,
  );
  assert.equal(calls, 6, "two rounds of the SDK's three, no more");
});

test("cancelled during the wait: nothing, no second try", async () => {
  failing = Number.POSITIVE_INFINITY;
  const s = new Summarizer({ retryMs: 5000 });
  const p = s.summarize(TURN, () => {});
  // Past the SDK's own retries (its backoff is under 2s), into the wait.
  while (calls < 3) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 50));
  s.cancel();
  assert.equal(await p, null);
  assert.equal(calls, 3);
});

test("what counts as not connecting: the SDK's connection error, fetch failing, a network code; not a refusal", () => {
  assert.ok(couldNotConnect(new TypeError("fetch failed")));
  assert.ok(couldNotConnect(new Error("connect ECONNREFUSED 10.0.0.1:443")));
  assert.ok(!couldNotConnect(new Error("400 invalid_request_error")));
});
