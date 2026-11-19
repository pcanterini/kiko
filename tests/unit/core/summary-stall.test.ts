// A summary's stream that stops sending (src/core/summarizer.ts): given up on once nothing has come for its stall time, as an error the announcement says and
// moves on from (app/announce.ts), never a wait of minutes holding the floor and the sessions queued
// behind it. One that keeps sending, however slowly, isn't cut. No network: a stand-in fetch.
import "../../setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "../../../src/core/config.ts";
import { Summarizer } from "../../../src/core/summarizer.ts";

const event = (e: Record<string, unknown>) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
const START = event({
  type: "message_start",
  message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 500, output_tokens: 1 } },
});
const BLOCK = event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
const delta = (text: string) => event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
const END =
  event({ type: "content_block_stop", index: 0 }) +
  event({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } }) +
  event({ type: "message_stop" });

/** What the stand-in server sends: each part after its wait (ms); `hang`: then nothing more, ever. */
let script: Array<[number, string]> = [];
let hang = false;
const realFetch = globalThis.fetch;
before(() => {
  config.llm = "haiku";
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        init?.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
        for (const [ms, part] of script) {
          await new Promise((r) => setTimeout(r, ms));
          if (init?.signal?.aborted) return;
          c.enqueue(enc.encode(part));
        }
        if (!hang) c.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

const TURN = { name: "Lacy", titled: true, nameSession: false, context: [], asked: [], claudeReply: "I fixed the tests." };

test("first words, then nothing: given up on after the stall time, as an error", async () => {
  script = [
    [0, START + BLOCK],
    [0, delta("Lacy fixed")],
  ];
  hang = true;
  const heard: string[] = [];
  const started = Date.now();
  await assert.rejects(
    new Summarizer({ stallMs: 150 }).summarize(TURN, (d) => heard.push(d)),
    /stopped coming/,
  );
  assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
  assert.deepEqual(heard, ["Lacy fixed"]);
});

test("no words at all: the same", async () => {
  script = [[0, START]];
  hang = true;
  await assert.rejects(
    new Summarizer({ stallMs: 150 }).summarize(TURN, () => {}),
    /stopped coming/,
  );
});

test("slow but steady, each gap under the stall time: heard whole", async () => {
  script = [
    [0, START + BLOCK],
    [100, delta("Lacy ")],
    [100, delta("fixed ")],
    [100, delta("the tests.")],
    [0, END],
  ];
  hang = false;
  const r = await new Summarizer({ stallMs: 250 }).summarize(TURN, () => {});
  assert.equal(r?.text, "Lacy fixed the tests.");
});

test("cancelled: still null, not the stall's error", async () => {
  script = [[0, START + BLOCK]];
  hang = true;
  const s = new Summarizer({ stallMs: 5000 });
  const p = s.summarize(TURN, () => {});
  setTimeout(() => s.cancel(), 50);
  assert.equal(await p, null);
});
