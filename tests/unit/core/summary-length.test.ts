// The Summary length setting's levels (src/core/summarizer.ts LENGTHS, settings.ts summaryLengthOf): brief, short,
// normal and detailed. Short and normal say what they said before, word for word, so a saved one means what it did;
// at every level, what can't be left out (a failure, something skipped, a caveat, the choices offered) still is.
import "../../setup.ts";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { config } from "../../../src/core/config.ts";
import { summaryLengthOf, type SummaryLength } from "../../../src/core/settings.ts";
import { SUMMARY_LENGTHS } from "../../../src/core/settings-options.ts";
import { Summarizer } from "../../../src/core/summarizer.ts";

const sse = (text: string) =>
  [
    {
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 500, output_tokens: 1 } },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
    { type: "message_stop" },
  ]
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");

let bodies: any[] = [];
const realFetch = globalThis.fetch;
const realLength = config.summaryLength;
before(() => {
  config.llm = "haiku";
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(sse("In Lacy, Claude merged it."), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
  config.summaryLength = realLength;
});

async function promptAt(length: SummaryLength) {
  config.summaryLength = length;
  bodies = [];
  await new Summarizer().summarize({ name: "Lacy", titled: true, nameSession: true, context: [], claudeReply: "Merged. Two tests still fail." }, () => {});
  const body = bodies.at(-1);
  const system: string = typeof body.system === "string" ? body.system : body.system.map((b: any) => b.text).join("\n");
  return { system, message: body.messages[0].content as string };
}
const systemAt = async (length: SummaryLength) => (await promptAt(length)).system;

describe("each level's instructions", () => {
  test("normal: as before, one or two short sentences, three at most", async () => {
    const system = await systemAt("normal");
    assert.match(system, /- Sum up the reply in one or two short sentences: the outcome or the main finding, not the steps\./);
    assert.match(system, /Three sentences at most\./);
  });

  test("short: as before, one short sentence under 15 words, two at most", async () => {
    const system = await systemAt("short");
    assert.match(system, /- Sum up the reply in one short sentence, under 15 words: the outcome or the main finding, not the steps\./);
    assert.match(system, /Two short sentences at most, counting any question\./);
  });

  test("brief: the outcome in a few words, with room for what can't be left out, said again at the end of the message", async () => {
    const { system, message } = await promptAt("brief");
    assert.match(system, /- Say only the outcome, in a few words, like "In Lacy, the tests pass\." or "In Kiko, it's merged\.":/);
    assert.match(system, /Two short sentences at most, counting any question: the second only for what can't be left out/);
    // Told only in the instructions, Haiku said 44 words (the median); at the end of the message too, 26.
    assert.match(
      message,
      /\(Brief: one sentence of under 12 words after the session's name, only the outcome: no details, numbers or lists\. A second sentence only for its question or for something that failed, in a few words\. Nothing else\.\)$/,
    );
  });

  test("short, normal and detailed: nothing added to the message", async () => {
    for (const length of ["short", "normal", "detailed"] as const) assert.match((await promptAt(length)).message, /<\/claude_asked>$/, length);
  });

  test("detailed: the main points, five sentences at most", async () => {
    const system = await systemAt("detailed");
    assert.match(system, /- Sum up the reply in two to four sentences, with its main points:/);
    assert.match(system, /Five sentences at most\./);
  });

  const KEEP = /- Even when it's short, don't drop what the reply says still fails, wasn't done, or wasn't checked or tested: a few words each, and only what it says\./;
  for (const length of ["brief", "detailed"] as const) {
    test(`${length}: keeps what fails, wasn't done or wasn't checked, and asks its question`, async () => {
      const system = await systemAt(length);
      assert.match(system, KEEP);
      assert.match(system, /ask a short question only when Claude asked one or offered choices/);
    });
  }

  for (const length of ["short", "normal"] as const) {
    test(`${length}: the instructions as they were, its question still asked`, async () => {
      const system = await systemAt(length);
      // On the eval the line kept a little more, within the noise, for longer summaries: left out here.
      assert.doesNotMatch(system, KEEP);
      assert.match(system, /ask a short question only when Claude asked one or offered choices/);
    });
  }
});

describe("the saved setting", () => {
  test("short and normal, as saved before the levels, mean what they did; anything else is normal", () => {
    assert.equal(summaryLengthOf("short"), "short");
    assert.equal(summaryLengthOf("normal"), "normal");
    assert.equal(summaryLengthOf("brief"), "brief");
    assert.equal(summaryLengthOf("detailed"), "detailed");
    assert.equal(summaryLengthOf(undefined), "normal");
    assert.equal(summaryLengthOf("long"), "normal");
  });

  test("one setting, four choices, shortest first", () => {
    assert.deepEqual(
      SUMMARY_LENGTHS.map((c) => c.value),
      ["brief", "short", "normal", "detailed"],
    );
  });
});
