// Prompt caching without the network: fetch is stubbed, so these check where the cache breakpoint
// goes in each request (the router, summaries, clean-up; Haiku and OpenRouter), that nothing that
// changes per call sits before it, and that cache reads and writes are priced.
import "../../setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { cleanUp } from "../../../src/core/cleanup.ts";
import { config } from "../../../src/core/config.ts";
import { cost } from "../../../src/core/log.ts";
import { toUsage } from "../../../src/core/openrouter-llm.ts";
import { Router } from "../../../src/core/router.ts";
import { Summarizer } from "../../../src/core/summarizer.ts";
import { CAST, makeWorld, type VoiceCan } from "../../support/fixtures.ts";

// What the Anthropic API sends back: a stream for the router and summaries, JSON for the clean-up.
const USAGE = { input_tokens: 1200, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 3900 };
const sse = (blocks: Array<{ start: object; delta: object }>) =>
  [
    {
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { ...USAGE, output_tokens: 1 } },
    },
    ...blocks.flatMap((b, index) => [
      { type: "content_block_start", index, content_block: b.start },
      { type: "content_block_delta", index, delta: b.delta },
      { type: "content_block_stop", index },
    ]),
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: USAGE.output_tokens } },
    { type: "message_stop" },
  ]
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
const SAY_OK = { start: { type: "tool_use", id: "toolu_1", name: "say", input: {} }, delta: { type: "input_json_delta", partial_json: '{"text":"ok","claims_action":false}' } };
const TEXT = (text: string) => ({ start: { type: "text", text: "" }, delta: { type: "text_delta", text } });

let bodies: any[] = [];
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (String(url).includes("openrouter")) {
      const completion = {
        choices: [{ message: { content: "", tool_calls: [{ function: { name: "say", arguments: '{"text":"ok"}' } }] } }],
        usage: { prompt_tokens: 1000, completion_tokens: 20, cost: 0.0001 },
      };
      return new Response(JSON.stringify(completion), { status: 200 });
    }
    if (!body.stream) {
      const message = {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: "Fix the bug." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: USAGE,
      };
      return new Response(JSON.stringify(message), { status: 200, headers: { "content-type": "application/json" } });
    }
    const blocks = body.tools ? [SAY_OK] : [TEXT("Clipkit fixed the bug.")];
    return new Response(sse(blocks), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
  config.llm = "haiku";
});
beforeEach(() => {
  bodies = [];
  config.llm = "haiku";
});

const world = makeWorld([CAST.voice, CAST.clipkit, CAST.lacy]);
const S = (name: string) => world.byName.get(name)!;

async function route(voiceCan: VoiceCan, text: string, recent: string[] = [], extra: Partial<Parameters<Router["route"]>[0]> = {}) {
  const result = await new Router().route({ sessions: world.sessions, notes: world.notes, waitingId: null, justSpoke: null, lastId: null, recent, text, voiceCan, ...extra }, () => {});
  return { result: result!, body: bodies.at(-1) };
}

describe("router on Haiku: one breakpoint, after the tools and instructions", () => {
  for (const level of ["replies", "messages", "everything"] as const) {
    test(`${level}: the system prompt is one cached block; tools and messages carry no breakpoint`, async () => {
      const { body } = await route(level, "hello");
      assert.equal(body.system.length, 1);
      assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
      assert.equal(body.system[0].type, "text");
      for (const tool of body.tools) assert.equal(tool.cache_control, undefined, `${tool.name} has a breakpoint`);
      assert.equal(body.cache_control, undefined, "no top-level auto-caching");
      assert.equal(typeof body.messages[0].content, "string");
    });
  }
  test("what changes per call is only in the user message, <now> first", async () => {
    const { body } = await route("everything", "tell clipkit to deploy the zebra build", ["you → clipkit: run the platypus tests"], {
      waitingId: S("clipkit").sessionId,
      lastId: S("lacy-platform").sessionId,
    });
    const prompt: string = body.messages[0].content;
    assert.match(prompt, /^<now>/);
    // The instructions name the tags (static); the values are what must stay out of the cached part.
    const now = prompt.match(/^<now>(.+)<\/now>/)![1];
    for (const part of [now, "<sessions>\ns1: ", "<waiting_for_reply>s2", "<dealt_with_last>s3", "<recent_conversation>\nyou → clipkit", "zebra", "platypus", "The user said:"]) {
      assert.ok(prompt.includes(part), `${part} not in the user message`);
      assert.ok(!body.system[0].text.includes(part), `${part} in the cached instructions`);
      assert.ok(!JSON.stringify(body.tools).includes(part), `${part} in the cached tools`);
    }
  });
  test("the cached prefix is byte-for-byte the same from call to call with the same sessions and level", async () => {
    const a = (await route("everything", "hello")).body;
    const b = (
      await route("everything", "stop clipkit", ["app said: Which one?", "you → clipkit: hi"], { waitingId: S("clipkit").sessionId, justSpoke: { id: S("lacy-platform").sessionId, secondsAgo: 3 } })
    ).body;
    assert.equal(JSON.stringify(b.tools), JSON.stringify(a.tools));
    assert.equal(JSON.stringify(b.system), JSON.stringify(a.system));
    assert.notEqual(b.messages[0].content, a.messages[0].content);
  });
  test("…and with different sessions running: no handles, names or folders before the breakpoint", async () => {
    for (const level of ["replies", "messages", "everything"] as const) {
      const a = (await route(level, "hello")).body;
      const other = makeWorld([CAST.pixie, CAST.atlas, CAST.screenapp, CAST.harbor, CAST.random, CAST.twoPlusTwo]);
      const b = (await route(level, "hello", [], { sessions: other.sessions, notes: other.notes })).body;
      const none = (await route(level, "hello", [], { sessions: [], notes: new Map() })).body;
      for (const body of [b, none]) {
        assert.equal(JSON.stringify(body.tools), JSON.stringify(a.tools), level);
        assert.equal(JSON.stringify(body.system), JSON.stringify(a.system), level);
      }
      assert.notEqual(b.messages[0].content, a.messages[0].content);
      assert.doesNotMatch(JSON.stringify(a.tools), /"enum"|"s1"|clipkit|lacy|claude-code-speech/);
    }
  });
  test("usage keeps the cache reads, and the cost prices them", async () => {
    const { result } = await route("messages", "hello");
    assert.equal(result.usage.cache_read_input_tokens, 3900);
    assert.equal(result.costUsd, cost.haiku(USAGE));
    // 1200 in at $0.10, 40 out at $0.50, 3900 cache reads at $0.01 (per million).
    assert.ok(Math.abs(result.costUsd - (1200 * 0.1 + 40 * 0.5 + 3900 * 0.01) / 1e6) < 1e-12);
  });
});

describe("router through OpenRouter", () => {
  before(() => {
    process.env.OPENROUTER_API_KEY = "unit-test-no-network";
  });
  test("a Claude model gets the breakpoint on the system message", async () => {
    config.llm = "anthropic/claude-haiku-5.5";
    const { body } = await route("messages", "hello");
    assert.deepEqual(body.messages[0], { role: "system", content: [{ type: "text", text: body.messages[0].content[0].text, cache_control: { type: "ephemeral" } }] });
    assert.match(body.messages[1].content, /^<now>/);
    assert.equal(body.messages.length, 2);
  });
  test("other models get the plain system prompt (they cache on their own, or not at all)", async () => {
    config.llm = "deepseek/deepseek-v4.1-flash";
    const { body } = await route("messages", "hello");
    assert.equal(typeof body.messages[0].content, "string");
  });
  test("usage splits out cached tokens, as the Anthropic API does", () => {
    const { usage } = toUsage({ prompt_tokens: 5176, completion_tokens: 39, cost: 0.000188, prompt_tokens_details: { cached_tokens: 3883, cache_write_tokens: 0 } });
    assert.deepEqual(usage, { input_tokens: 1293, output_tokens: 39, cache_read_input_tokens: 3883 });
    assert.deepEqual(toUsage({ prompt_tokens: 4837, completion_tokens: 146, prompt_tokens_details: { cache_write_tokens: 3883 } }).usage, {
      input_tokens: 954,
      output_tokens: 146,
      cache_creation_input_tokens: 3883,
    });
    assert.deepEqual(toUsage({ prompt_tokens: 3547, completion_tokens: 88 }).usage, { input_tokens: 3547, output_tokens: 88 });
  });
});

describe("the other prompts", () => {
  test("a summary caches its instructions; a permission prompt's are too short to", async () => {
    const summarizer = new Summarizer();
    await summarizer.summarize({ name: "clipkit", nameSession: true, context: [], claudeReply: "Fixed the bug." }, () => {});
    assert.deepEqual(bodies[0].system.at(-1).cache_control, { type: "ephemeral" });
    assert.doesNotMatch(bodies[0].system[0].text, /Fixed the bug/);
    assert.match(bodies[0].messages[0].content, /<claude_reply>Fixed the bug.<\/claude_reply>/);
    await summarizer.describePermission({ name: "clipkit", nameSession: false, tool: "Bash", input: { command: "ls" } }, () => {});
    assert.equal(typeof bodies[1].system, "string");
  });
  test("the clean-up caches its instructions; the transcript comes after", async () => {
    const r = await cleanUp("uh fix the the bug");
    assert.equal(r.text, "Fix the bug.");
    assert.deepEqual(bodies[0].system.at(-1).cache_control, { type: "ephemeral" });
    assert.equal(bodies[0].messages[0].content, "<transcript>uh fix the the bug</transcript>");
  });
});
