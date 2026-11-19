// Catch me up (src/remote/catch-up.ts) with a fake voice and a fake model: one summary of the
// updates (one is just read; a failed call reads them one by one), each line in order for Read all,
// and Stop: what's still to come is dropped, and what's being heard is cut, as a press would. Then
// the summary's own call (src/core/summarizer.ts catchUp) with fetch stubbed: its prompt, its input
// and its cap. No live model calls.
import "../../setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "../../../src/core/config.ts";
import type { Speech } from "../../../src/core/speech-lock.ts";
import { catchUpPrompt, Summarizer, type CatchUpUpdate } from "../../../src/core/summarizer.ts";
import { CatchUp, catchUpUpdates, type CatchUpOptions } from "../../../src/remote/catch-up.ts";
import type { Missed } from "../../../src/remote/missed.ts";

const item = (id: number, name: string | null, text: string, kind: Missed["kind"] = "announcement"): Missed => ({
  id,
  at: id,
  sessionId: name && `s-${name}`,
  name,
  kind,
  text,
});
const LACY = item(1, "lacy", "Lacy finished the migration. Want it to seed the database?");
const ASK = item(2, "atlas-agents", "Atlas agents wants to run the tests. Allow?", "permission");
const KIKO = item(3, "claude-code-speech", "Merged two fixes; restart the app to get them");

type FakeSpeech = Speech & { said: string; ended: boolean; cancelled: boolean };

/**
 * One voice at a time, as the app's speech lock: each open waits for the one before to end or
 * cancel. `slow`: an ended speech keeps the voice until `handedOver()` (its audio still streaming).
 */
function fakeVoice(slow = false) {
  const speeches: FakeSpeech[] = [];
  let tail = Promise.resolve();
  let pending: Array<() => void> = [];
  const open = () => {
    const ahead = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => (release = resolve));
    return ahead.then(() => {
      const s: FakeSpeech = {
        said: "",
        ended: false,
        cancelled: false,
        push: (t) => void (s.said += t),
        end: () => {
          s.ended = true;
          if (slow) pending.push(release);
          else release();
        },
        cancel: () => {
          s.cancelled = true;
          release();
        },
        chars: () => s.said.length,
      };
      speeches.push(s);
      return s;
    });
  };
  const handedOver = () => {
    for (const release of pending.splice(0)) release();
  };
  return { speeches, open, handedOver };
}

function setup(summarize?: CatchUpOptions["summarize"], slow = false) {
  const voice = fakeVoice(slow);
  const calls: CatchUpUpdate[][] = [];
  const logged: Array<[string, Record<string, unknown>]> = [];
  const changes: boolean[] = [];
  let cuts = 0;
  let cancels = 0;
  let quiet!: () => void;
  const catchUp = new CatchUp({
    open: voice.open,
    summarize: async (updates, onText) => {
      calls.push(updates);
      if (summarize) return summarize(updates, onText);
      const text = "While you were away: Lacy finished the migration and is waiting for you; Kiko merged two fixes.";
      onText(text);
      return { text, usage: { input_tokens: 120, output_tokens: 25 }, costUsd: 0.0002 };
    },
    cancelSummary: () => void cancels++,
    cut: () => void cuts++,
    quiet: () => new Promise<void>((resolve) => (quiet = resolve)),
    changed: (on) => void changes.push(on),
    voiceCost: (speech) => speech.chars() / 1000,
    log: (event, data) => void logged.push([event, data]),
  });
  return {
    catchUp,
    voice,
    calls,
    logged,
    changes,
    cuts: () => cuts,
    cancels: () => cancels,
    heard: () => quiet?.(),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("Catch me up: one summary of the updates, through one speech, its cost logged; over once it's heard", async () => {
  const t = setup();
  t.catchUp.summary([LACY, KIKO]);
  assert.equal(t.catchUp.active, true);
  await tick();
  assert.deepEqual(t.calls, [
    [
      { name: "lacy", kind: "announcement", text: LACY.text, at: 1 },
      { name: "claude code speech", kind: "announcement", text: KIKO.text, at: 3 },
    ],
  ]);
  assert.equal(t.voice.speeches.length, 1);
  assert.match(t.voice.speeches[0].said, /^While you were away: Lacy finished the migration/);
  assert.ok(t.voice.speeches[0].ended);
  const [event, data] = t.logged.find(([e]) => e === "phone_catch_up_summary")!;
  assert.equal(event, "phone_catch_up_summary");
  assert.deepEqual([data.count, data.fallback, data.llmCost, data.usage], [2, false, 0.0002, { input_tokens: 120, output_tokens: 25 }]);
  assert.ok((data.ttsCost as number) > 0);
  assert.deepEqual(t.changes, [true], "still on until it's been heard");
  t.heard();
  await tick();
  assert.deepEqual(t.changes, [true, false]);
  assert.equal(t.catchUp.active, false);
});

test("one update is just read, with its session's name: no model call", async () => {
  const t = setup();
  t.catchUp.summary([item(4, "clipkit", "Done, and pushed.")]);
  await tick();
  assert.deepEqual(t.calls, []);
  assert.deepEqual(
    t.voice.speeches.map((s) => s.said),
    ["clipkit: Done, and pushed."],
  );
});

test("the model call fails: each update read one by one instead", async () => {
  const t = setup(async () => {
    throw new Error("overloaded");
  });
  t.catchUp.summary([LACY, ASK, KIKO]);
  await tick();
  assert.equal(t.calls.length, 1);
  assert.equal(
    t.voice.speeches[0].said,
    "Lacy finished the migration. Want it to seed the database? Atlas agents wants to run the tests. Allow? claude code speech: Merged two fixes; restart the app to get them.",
  );
  assert.ok(t.voice.speeches[0].ended);
  const fallback = t.logged.find(([e]) => e === "phone_catch_up_fallback")!;
  assert.deepEqual(fallback[1], { count: 3, error: "overloaded" });
  assert.equal(t.logged.find(([e]) => e === "phone_catch_up_summary")![1].fallback, true);
});

test("Read all, and a line's play button: each line, one by one, in order", async () => {
  const t = setup();
  t.catchUp.lines(["one.", "two.", "three."]);
  await tick();
  assert.deepEqual(
    t.voice.speeches.map((s) => [s.said, s.ended]),
    [
      ["one.", true],
      ["two.", true],
      ["three.", true],
    ],
  );
  assert.deepEqual(t.calls, []);
});

test("Stop while it's being heard: the rest is dropped and what's heard is cut, as a press", async () => {
  const t = setup(undefined, true);
  // The summary is being written: the speech has the voice, the model hasn't finished.
  let finish!: () => void;
  const s = setup(
    (_updates, onText) =>
      new Promise((resolve) => {
        onText("While you were away: Lacy");
        finish = () => resolve(null); // cancelled
      }),
  );
  s.catchUp.summary([LACY, KIKO]);
  await tick();
  assert.equal(s.voice.speeches[0].said, "While you were away: Lacy");
  assert.equal(s.catchUp.stop(), true);
  assert.ok(s.voice.speeches[0].cancelled, "the speech is cut");
  assert.equal(s.cuts(), 1, "and what's already playing, as a press");
  assert.equal(s.cancels(), 1, "the summary stops being written");
  assert.deepEqual(s.changes, [true, false]);
  finish();
  await tick();
  assert.ok(!s.voice.speeches[0].ended);
  assert.equal(s.catchUp.stop(), false, "nothing on now");

  // Read all, stopped on the second line: the third never sounds.
  t.catchUp.lines(["one.", "two.", "three."]);
  await tick();
  t.voice.handedOver();
  await tick();
  assert.deepEqual(
    t.voice.speeches.map((x) => x.said),
    ["one.", "two."],
  );
  t.catchUp.stop();
  assert.equal(t.cuts(), 1, "what's playing is cut");
  t.voice.handedOver();
  await tick();
  assert.deepEqual(
    t.voice.speeches.map((x) => [x.said, x.cancelled]),
    [
      ["one.", false],
      ["two.", false],
      ["", true],
    ],
    "the third dropped",
  );
});

test("Stop while it still waits behind something else: dropped, and nothing being said is cut", async () => {
  const t = setup();
  // Someone else holds the voice.
  const other = await t.voice.open();
  t.catchUp.lines(["one.", "two."]);
  await tick();
  assert.equal(t.voice.speeches.length, 1, "waiting its turn");
  assert.equal(t.catchUp.stop(), true);
  assert.equal(t.cuts(), 0, "what's being said isn't the catch-up's: not cut");
  other.push("an announcement");
  other.end();
  await tick();
  assert.deepEqual(
    t.voice.speeches.slice(1).map((s) => [s.said, s.cancelled]),
    [
      ["", true],
      ["", true],
    ],
  );
});

test("a press stops it too: over, with nothing more to cut", async () => {
  const t = setup();
  t.catchUp.summary([LACY, KIKO]);
  await tick();
  t.catchUp.pressed();
  assert.deepEqual(t.changes, [true, false]);
  assert.equal(t.cuts(), 0);
  assert.equal(t.catchUp.active, false);
});

test("the summary's input: each update with its session said as words, what it is, and how long ago", () => {
  const updates = catchUpUpdates([LACY, ASK, item(9, null, "The build on main passed.", "answer")]);
  assert.deepEqual(
    updates.map((u) => u.name),
    ["lacy", "atlas agents", null],
  );
  const prompt = catchUpPrompt(
    updates.map((u) => ({ ...u, at: 0 })),
    12 * 60_000,
  );
  assert.equal(
    prompt,
    [
      "<updates>",
      `<update session="lacy" kind="finished a turn" minutes_ago="12">${LACY.text}</update>`,
      `<update session="atlas agents" kind="asks permission" minutes_ago="12">${ASK.text}</update>`,
      `<update kind="the app's answer" minutes_ago="12">The build on main passed.</update>`,
      "</updates>",
    ].join("\n"),
  );
});

// ── The model call itself, with fetch stubbed ───────────────────────────

const SAID = "While you were away: Lacy finished the migration and is waiting for you; Kiko merged two fixes and asked you to restart.";
const sse = (text: string) =>
  [
    {
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 300, output_tokens: 1 } },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 28 } },
    { type: "message_stop" },
  ]
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");

let bodies: any[] = [];
const realFetch = globalThis.fetch;
before(() => {
  config.llm = "haiku";
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(sse(SAID), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

test("the summary call: its own prompt (grouped by session, 2 to 4 sentences), only the updates given, capped, its cost", async () => {
  bodies = [];
  let streamed = "";
  const r = await new Summarizer().catchUp(catchUpUpdates([LACY, KIKO]), (d) => (streamed += d));
  assert.equal(r?.text, SAID);
  assert.equal(streamed, SAID);
  assert.ok(r!.costUsd > 0, "priced like any Haiku call");
  const body = bodies[0];
  const system = typeof body.system === "string" ? body.system : body.system.map((b: any) => b.text).join("");
  assert.match(system, /While you were away:/);
  assert.match(system, /session by session, each session once/);
  assert.match(system, /Two to four short sentences/);
  assert.equal(body.max_tokens, 200);
  const input = body.messages[0].content;
  assert.match(input, /session="lacy"/);
  assert.match(input, /session="claude code speech"/);
  assert.doesNotMatch(input, /atlas agents/, "only what it was given");
});
