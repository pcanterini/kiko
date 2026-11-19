// "More" by voice (src/core/decide.ts moreOf, routing-rules.ts moreRequest, summarizer.ts more): right after a summary,
// or for the last thing a session said, "more", "tell me more", "details", "what else?" say a longer summary of that
// same reply, and "more about the failing tests" all it says about that part. A command to the app, read in code like
// "skip that": never words typed into the session waiting for your reply. And the summary_feedback log line.
import "../../setup.ts";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { decide, type DecideDeps, type DecideState } from "../../../src/core/decide.ts";
import { moreRequest } from "../../../src/core/routing-rules.ts";
import { config } from "../../../src/core/config.ts";
import { Summarizer } from "../../../src/core/summarizer.ts";
import { feedbackEvent, feedbackKind, replyIdOf } from "../../../src/core/summary-feedback.ts";
import { makeWorld } from "../../support/fixtures.ts";

const W = makeWorld([
  { name: "Kiko", folder: "kiko", given: "Kiko", title: "Voice app", status: "idle", asked: "Is there a time limit?" },
  { name: "Lacy", folder: "lacy-platform", given: "Lacy", title: "Shipping rates", status: "idle", asked: "Is anything still in progress?" },
]);
const S = (name: string) => W.byName.get(name.toLowerCase())!;

async function run(text: string, opts: Partial<DecideState> = {}) {
  const calls = { classifier: 0, router: 0 };
  const deps: DecideDeps = {
    utterance: async () => {
      calls.classifier++;
      return { audience: S("Lacy"), audienceConfidence: 0.95, intent: "message", intentConfidence: 0.95, appParts: 0.1, model: "test", costUsd: 0, ms: 1 };
    },
    approval: null,
    route: async () => {
      calls.router++;
      return { text: "", actions: [], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
    },
    trim: null,
  };
  const state: DecideState = {
    text,
    sessions: W.sessions,
    notes: W.notes,
    recent: [],
    waiting: null,
    justSpoke: null,
    lastId: null,
    appAsked: false,
    lastSent: null,
    lastRepeat: false,
    voiceCan: "messages",
    classifierMinConfidence: 0.75,
    ...opts,
  };
  return { ...(await decide(state, deps)), calls };
}

// Lacy's turn waits for your reply: without "more", your words would be typed into it.
const LACY_WAITING = (): Partial<DecideState> => ({ waiting: { sessionId: S("Lacy").sessionId, cwd: S("Lacy").cwd }, heardFrom: S("Lacy").sessionId });

describe('"more" right after a summary is the app\'s, never sent to the session', () => {
  for (const said of ["More.", "more", "Tell me more.", "Can you tell me more?", "Details.", "What else?", "A bit more, please.", "Okay, more details.", "Go on.", "Kiko, tell me more."]) {
    test(`${JSON.stringify(said)}: a longer summary of Lacy's reply, no models`, async () => {
      const d = await run(said, LACY_WAITING());
      assert.equal(d.step, "more");
      assert.deepEqual(d.actions, [{ type: "more", sessionId: S("Lacy").sessionId, topic: null }]);
      assert.deepEqual(d.calls, { classifier: 0, router: 0 });
    });
  }

  for (const [said, topic] of [
    ["Tell me more about the failing tests.", "the failing tests"],
    ["More about option two.", "option two"],
    ["What did it say about the migration?", "the migration"],
    ["more on the phone part", "the phone part"],
    ["Details on the cache change, please.", "the cache change"],
  ] as const) {
    test(`${JSON.stringify(said)}: more about "${topic}"`, async () => {
      const d = await run(said, LACY_WAITING());
      assert.equal(d.step, "more");
      assert.deepEqual(d.actions, [{ type: "more", sessionId: S("Lacy").sessionId, topic }]);
      assert.deepEqual(d.calls, { classifier: 0, router: 0 });
    });
  }
});

describe("which session's reply", () => {
  test('"Lacy, more" with Kiko heard last: the named session\'s', async () => {
    const d = await run("Lacy, more.", { heardFrom: S("Kiko").sessionId });
    assert.deepEqual(d.actions, [{ type: "more", sessionId: S("Lacy").sessionId, topic: null }]);
  });

  test('"more from Lacy", "tell me more about Lacy": Lacy\'s, with no topic', async () => {
    for (const said of ["More from Lacy.", "Tell me more about Lacy."]) {
      const d = await run(said, { heardFrom: S("Kiko").sessionId });
      assert.deepEqual(d.actions, [{ type: "more", sessionId: S("Lacy").sessionId, topic: null }], said);
    }
  });

  test('"what did Lacy say about the deploy?": Lacy\'s, about the deploy', async () => {
    const d = await run("What did Lacy say about the deploy?", { heardFrom: S("Kiko").sessionId });
    assert.deepEqual(d.actions, [{ type: "more", sessionId: S("Lacy").sessionId, topic: "the deploy" }]);
  });

  test("said in a session's screen on the phone: that session's", async () => {
    const d = await run("Tell me more.", { to: { sessionId: S("Kiko").sessionId, cwd: S("Kiko").cwd }, heardFrom: S("Lacy").sessionId });
    assert.deepEqual(d.actions, [{ type: "more", sessionId: S("Kiko").sessionId, topic: null }]);
  });

  test("the last thing said, long after its window closed: still that one", async () => {
    const d = await run("more", { heardFrom: S("Kiko").sessionId });
    assert.deepEqual(d.actions, [{ type: "more", sessionId: S("Kiko").sessionId, topic: null }]);
  });
});

describe("not a 'more'", () => {
  // Ordinary words to sessions: they still go where they always did.
  for (const said of [
    "What about Germany?",
    "What else is left on the list?",
    "What else do I need to check?",
    "Add more tests for the router.",
    "Tell me more jokes.",
    "Tell Lacy to give me more details in its next reply.",
  ]) {
    test(`${JSON.stringify(said)}: words for the session`, async () => {
      const d = await run(said, LACY_WAITING());
      assert.notEqual(d.step, "more");
      assert.ok(!d.actions.some((a) => a.type === "more"));
    });
  }

  test("nothing heard yet and no session named: words like any others", async () => {
    const d = await run("More.", { heardFrom: null });
    assert.notEqual(d.step, "more");
  });

  test("a name up front that's no session's isn't a session's 'more'", () => {
    assert.equal(moreRequest("Dozer, more.")?.lead, true);
  });

  test("a permission prompt waiting: your words answer it", async () => {
    const d = await run("More.", { waiting: { sessionId: S("Lacy").sessionId, cwd: S("Lacy").cwd, permission: "run the tests" }, heardFrom: S("Lacy").sessionId });
    assert.equal(d.step, "permission");
  });
});

// ── The longer summary itself ────────────────────────────────────────────────────────────
const sse = (text: string) =>
  [
    {
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 500, output_tokens: 1 } },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 60 } },
    { type: "message_stop" },
  ]
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");

let bodies: any[] = [];
const LONGER =
  "Two of the three fixes landed. The pane-layout change broke two nav tests, which still fail, and it hasn't looked into why. The cache change is a one-liner that makes routing about a quarter cheaper. Want it to merge anyway?";
const realFetch = globalThis.fetch;
before(() => {
  config.llm = "haiku";
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(sse(LONGER), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

const REPLY = `I merged the routing fix and the cache change.

**Routing:** a session's short name now counts when it's said up front, so "To Lacy, …" is cut before the words are typed in.
**Cache:** the longer cache raises hits to about 90% and makes each routing call a little cheaper.
**Tests:** two tests in the nav suite still fail on the new pane layout; I haven't looked into why yet.

Should I merge the pane-layout change anyway, or wait until those pass?`;
const HEARD = "In Lacy, Claude merged the routing fix and the cache change, but two nav tests still fail. Want it to merge the layout change anyway?";

async function more(topic: string | null) {
  bodies = [];
  const r = await new Summarizer().more({ name: "Lacy", titled: true, claudeReply: REPLY, heard: HEARD, topic }, () => {});
  const body = bodies.at(-1);
  const system = typeof body.system === "string" ? body.system : body.system.map((b: any) => b.text).join("\n");
  return { r, system, prompt: body.messages[0].content as string };
}

describe("the longer summary of the same reply", () => {
  test("the whole reply and the summary heard go in; it's told to keep what matters and add what the summary left out", async () => {
    const { r, system, prompt } = await more(null);
    assert.ok(prompt.includes(REPLY), "the same reply, whole");
    assert.ok(prompt.includes(`<heard>${HEARD}</heard>`));
    assert.ok(!prompt.includes("<about>"));
    assert.match(
      system,
      /Give them a longer summary of the same reply: what matters most first, with anything Claude needs from them, what failed or still fails, anything risky, what it skipped or didn't do and its caveats, then the main points the short summary \(heard\) left out/,
    );
    assert.match(system, /Never mention a summary or what it left out/);
    assert.match(system, /Four to six sentences at most/);
    // The first round of the eval: reasons the reply never gave, and "I" as if the app were Claude.
    assert.match(system, /Only what the reply says: no reasons, causes, risks or numbers it doesn't give/);
    assert.match(system, /you aren't Claude, so never "I" for what it did/);
    assert.match(system, /not a report or a list/);
    // Its question is still asked at the end: your next words answer the session.
    assert.ok(prompt.includes("<claude_asked>Should I merge the pane-layout change anyway, or wait until those pass?</claude_asked>"), prompt);
    assert.equal(r?.text, LONGER);
    assert.ok(r!.text.split(/\s+/).length > HEARD.split(/\s+/).length, "longer than what was heard");
  });

  test("more about a topic: close to all the reply says about it, and never made up when it says nothing", async () => {
    const { system, prompt } = await more("the failing tests");
    assert.ok(prompt.includes("<about>the failing tests</about>"));
    assert.match(system, /close to everything the reply says about that, in depth/);
    assert.match(system, /If the reply says nothing about it, say only "It didn't say anything about <what they asked about>\." with their words for it, and nothing else: never make anything up/);
    assert.match(system, /Never read code, commands, long paths, links, IDs, times or command output word for word/);
  });
});

describe("summary_feedback", () => {
  test("what counts as feedback on the summary just heard", () => {
    assert.equal(feedbackKind("You missed the part about the tests."), "missed");
    assert.equal(feedbackKind("It left out the cache numbers."), "missed");
    assert.equal(feedbackKind("What about the migration?"), "what_about");
    assert.equal(feedbackKind("Why did the nav tests fail?"), "follow_up");
    assert.equal(feedbackKind("more", { topic: null }), "more");
    assert.equal(feedbackKind("more about the tests", { topic: "the tests" }), "more_about");
    assert.equal(feedbackKind("Go ahead and merge it."), null);
  });

  test("the log line: the reply's id (the summary eval's case id), the summary heard, and what was said", () => {
    const e = feedbackEvent({ kind: "missed", sessionId: "s1", name: "Lacy", reply: REPLY, summary: HEARD, said: "You missed the cache numbers.", went: ["send"] });
    assert.deepEqual(e, { kind: "missed", replyId: replyIdOf(REPLY), sessionId: "s1", name: "Lacy", summary: HEARD, said: "You missed the cache numbers.", went: ["send"] });
    assert.match(e.replyId, /^[0-9a-f]{12}$/);
    assert.equal(replyIdOf(REPLY), replyIdOf(REPLY), "the same reply, the same id");
  });
});
