// What the summary of a finished turn is told about questions (src/core/summarizer.ts), with fetch stubbed. A
// summary once ended by asking whether to skip a restart, though Claude only said it would tell you whether a restart
// was needed: a statement turned into a question.
import "../../setup.ts";
import { holdKey } from "../../../src/core/key-values.ts";
// The classifier on your own OpenRouter key (core/model-route.ts: a call with no key and no plan fails before fetch).
holdKey("OPENROUTER_API_KEY", "sk-or-v1-test-only-0000");
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { config } from "../../../src/core/config.ts";
import { CLAUDE_CODE_VOICE, Summarizer, type Voice } from "../../../src/core/summarizer.ts";
import { decideStop } from "../../../src/core/decisions.ts";
import { LISTED_VERBS } from "../../support/asks-replies.ts";

const REPLY = `I'm leaving the page size alone and making the other changes now, in the background. Nothing has changed yet:

1. **After you save:** once your edit to a note is saved and another note is waiting, the app moves straight on instead of holding the first one open.
2. **Read-only notes:** a note that was only being viewed gives way about 2 seconds after it finishes loading when another note is waiting.
3. **Shorter timers:** the autosave delay goes from 15s to 10s, and the "just viewing" timeout from 6s to 4s.

It'll be committed once the tests pass. I'll let you know when it's done and whether you need to restart the app.`;
const SAID = "In Atlas, Claude is making the changes now. It'll tell you when it's done and whether the app needs a restart.";

const sse = (text: string) =>
  [
    {
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 500, output_tokens: 1 } },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 30 } },
    { type: "message_stop" },
  ]
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");

let bodies: any[] = [];
let said = SAID; // what the stubbed model says
const realFetch = globalThis.fetch;
before(() => {
  config.llm = "haiku";
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(sse(said), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

async function summarize() {
  bodies = [];
  const result = await new Summarizer().summarize(
    {
      name: "Atlas",
      titled: true,
      nameSession: true,
      context: ["you → Atlas: Can we make the autosave a little bit quicker?", "you → Atlas: Keep the page size, but you can fix the other things that make it feel faster."],
      claudeReply: REPLY,
    },
    () => {},
  );
  const body = bodies.at(-1);
  const system = typeof body.system === "string" ? body.system : body.system.map((b: any) => b.text).join("\n");
  return { result, system, body };
}

test("asks only what Claude asked, and never turns a statement into a question", async () => {
  const { system } = await summarize();
  assert.match(system, /ask a short question only when Claude asked one or offered choices/);
  assert.match(system, /Never ask something Claude didn't ask, and never turn what it said into a question\./);
  assert.doesNotMatch(system, /clear next step you'd likely want/, "no questions of its own about next steps");
  assert.doesNotMatch(system, /when it makes sense, ask what they want next/);
});

test("the reply that says it'll report on a restart reaches the model as is", async () => {
  const { result, body } = await summarize();
  const user = JSON.stringify(body.messages);
  assert.ok(user.includes("whether you need to restart the app"));
  assert.equal(result?.text, SAID);
});

// A request for a joke, sent to a session while it was busy, was answered at the top of a long status reply, and the
// summary led with the status and left the joke out. Its prompt had the ask only as an old line of the recent conversation, behind a permission answer. Now your words
// to the session during the turn come labelled, and the summary answers them first.
const JOKE_REPLY = `Here's a short joke: why did the calendar break up with the clock? It said the clock only ever counted its own hours.

The last sync fix is also merged into main, and all checks pass: 640 unit tests and the full end-to-end run. **Restart the app** to pick it up.`;

async function summarizeTurn(asked: string[] | undefined) {
  bodies = [];
  await new Summarizer().summarize({ name: "Kiko", titled: true, nameSession: true, context: ["you → Kiko: yes, run the merge"], asked, claudeReply: JOKE_REPLY }, () => {});
  const body = bodies.at(-1);
  const system = typeof body.system === "string" ? body.system : body.system.map((b: any) => b.text).join("\n");
  return { system, prompt: body.messages[0].content as string };
}

test("your words during the turn, a mid-turn one too, reach the summary labelled, before Claude's reply", async () => {
  const { prompt } = await summarizeTurn(["Merge the sync fix.", "Tell me a short joke."]);
  assert.ok(prompt.includes("<user_asked>\nMerge the sync fix.\nTell me a short joke.\n</user_asked>"), prompt);
  assert.ok(prompt.indexOf("</recent_conversation>") < prompt.indexOf("<user_asked>"));
  assert.ok(prompt.indexOf("</user_asked>") < prompt.indexOf("<claude_reply>"));
});

test("told to lead with the answer itself (the joke, not that Claude told one), then the rest briefly", async () => {
  const { system } = await summarizeTurn(["Tell me a short joke."]);
  assert.match(system, /asked a question or asked for something in user_asked and the reply answers it, lead with the answer itself, right after the session's name, short: say the joke itself/);
  assert.match(system, /Never only say that Claude answered \("Claude told a joke"\)/);
  assert.match(system, /Then the reply's most important other point, briefly, within the same length/);
  assert.match(system, /If the reply doesn't answer it, never make an answer up/);
  // In a live check without this, the summary ended in a question of its own.
  assert.match(system, /Their asking is no reason to ask them anything: the question rules below still apply/);
});

test("nothing said during the turn: the prompt is as before, with no user_asked", async () => {
  for (const asked of [undefined, []]) {
    const { prompt } = await summarizeTurn(asked);
    assert.ok(!prompt.includes("user_asked"), prompt);
    assert.match(prompt, /^<session_name>Kiko<\/session_name> \(name the session\)\n<recent_conversation>\n.*\n<\/recent_conversation>\n<claude_reply>/s);
  }
});

// Claude's reply asked nothing ("I'll tell you when both are ready."), and the summary ended in a question it made up,
// copying the summary before it, an "app said" line that ended in a fair one.
// tests/unit/core/added-question.test.ts has the guard itself; this checks the summary uses it and logs what it dropped.
const STATEMENT_REPLY = `I've started a second agent on the export setting, alongside the one fixing the slow upload.

I'll tell you when both are ready. You'll need to restart the server and reload the page for the new setting.`;
const FIRST = "In Kiko, Claude has started a second agent on the export setting, so both fixes can be tested together.";
const MADE_UP = "Want Claude to tell you when both are ready, or to walk you through the restart and the reload?";

async function summarizeReply(claudeReply: string) {
  bodies = [];
  said = `${FIRST} ${MADE_UP}`;
  let heard = "";
  try {
    const context = [
      "app said (about Kiko): In Kiko, the next step is for you to test the upload fix. Want me to add the export setting before you test, or leave it parked?",
      "you → Kiko: Yes, add it now.",
    ];
    const result = await new Summarizer().summarize({ name: "Kiko", titled: true, nameSession: true, context, claudeReply }, (d) => (heard += d));
    const logged = readdirSync("logs")
      .flatMap((f) => readFileSync(`logs/${f}`, "utf8").trim().split("\n"))
      .map((l) => JSON.parse(l));
    return { result, heard, logged: logged.filter((e) => e.event === "summary").at(-1) };
  } finally {
    said = SAID;
  }
}

test("a question the reply never asked is neither spoken nor kept, and the log says what was dropped", async () => {
  const { result, heard, logged } = await summarizeReply(STATEMENT_REPLY);
  assert.equal(heard.trim(), FIRST);
  assert.equal(result?.text, FIRST);
  assert.equal(logged.text, FIRST);
  assert.equal(logged.dropped, MADE_UP);
});

test("a reply that asks keeps the summary's question", async () => {
  const { result, logged } = await summarizeReply(`${STATEMENT_REPLY}\n\nWant me to walk you through the restart?`);
  assert.equal(result?.text, `${FIRST} ${MADE_UP}`);
  assert.equal(logged.dropped, undefined);
});

test("told that earlier app lines are no pattern to copy", async () => {
  const { system } = await summarize();
  assert.match(system, /Earlier "app said" lines are past summaries, not a pattern to copy\./);
});

// The reply asked nothing, and the summary ended in a question it made up.
// The summary is now told what Claude's reply ends by asking (claudeAsked, tests/unit/core/claude-asked.test.ts), or that
// it asked nothing, and dropClosingRemark still drops a question it adds anyway.
test("told that Claude asked nothing, and a made-up question is still dropped", async () => {
  const { result, logged } = await summarizeReply(LISTED_VERBS);
  const prompt: string = bodies.at(-1).messages[0].content;
  assert.ok(prompt.endsWith("</claude_reply>\n<claude_asked>nothing</claude_asked>"), prompt.slice(-200));
  assert.equal(result?.text, FIRST);
  assert.equal(logged.dropped, MADE_UP);
});

test("a reply that asks gives the summary its question to end with", async () => {
  await summarizeReply(`${STATEMENT_REPLY}\n\nWant me to walk you through the restart?`);
  const prompt: string = bodies.at(-1).messages[0].content;
  assert.ok(prompt.endsWith("</claude_reply>\n<claude_asked>Want me to walk you through the restart?</claude_asked>"), prompt.slice(-200));
});

// "If any step fails, just tell me its number." was given as what Claude asked, and the summary turned it into a
// question of its own about telling Claude the number. The classifier's needs_user (0.16) said nothing was waiting on you; an offer with no "?" now waits for it.
async function summarizeWithClassifier(claudeReply: string, needsUser: Promise<number | null>) {
  bodies = [];
  const result = await new Summarizer().summarize({ name: "Kiko", titled: true, nameSession: true, context: [], claudeReply, needsUser }, () => {});
  return { result, asked: bodies.at(-1)?.messages[0].content.match(/<claude_asked>(.*)<\/claude_asked>$/s)?.[1] };
}
const OFFER = `${STATEMENT_REPLY}\n\nI can add a setting for it if you want.`;

test("an offer with no question mark is asked only when Jev says you're waited on", async () => {
  assert.equal((await summarizeWithClassifier(OFFER, Promise.resolve(0.16))).asked, "nothing");
  assert.equal((await summarizeWithClassifier(OFFER, Promise.resolve(0.8))).asked, "I can add a setting for it if you want.");
  // The classifier off or failed: its words alone, as before.
  assert.equal((await summarizeWithClassifier(OFFER, Promise.resolve(null))).asked, "I can add a setting for it if you want.");
});

test("a question is asked whatever Jev says, without waiting for it", async () => {
  const never = new Promise<number | null>(() => {});
  const { asked } = await summarizeWithClassifier(`${STATEMENT_REPLY}\n\nWant me to walk you through the restart?`, never);
  assert.equal(asked, "Want me to walk you through the restart?");
});

test("cancelled while waiting for Jev (a quiet turn), it never asks for a summary", async () => {
  bodies = [];
  let answer!: (n: number) => void;
  const summarizer = new Summarizer();
  const pending = summarizer.summarize({ name: "Kiko", nameSession: true, context: [], claudeReply: OFFER, needsUser: new Promise((r) => (answer = r)) }, () => {});
  summarizer.cancel();
  answer(0.2);
  assert.equal(await pending, null);
  assert.equal(bodies.length, 0);
});

test("told that a request for later or for if something happens is no question", async () => {
  const { system } = await summarize();
  assert.match(
    system,
    /Claude asking the user to do something later or if something happens isn't a question: say it as a statement, like "If something breaks, tell Claude the step number\.", or leave it out\./,
  );
});

test("told to end with claude_asked in its own words, and with nothing asked, to ask and suggest nothing", async () => {
  const { system } = await summarize();
  assert.match(system, /claude_asked has what its reply ends by asking or offering\. End with that, in your own words/);
  assert.match(system, /When claude_asked says nothing, Claude asked nothing: don't ask or suggest anything\b/);
});

// "In T3, Claude said hello world." for a T3 Code thread running on Codex, and "In workbench, Claude said hello world." for Codex's own hooks of it: every summary named Claude. Now it
// names the session's agent's speaker (Agent.speaker), or says "it" where that can't be told; Claude Code's is as before.
async function summarizeAs(voice: Voice | undefined) {
  bodies = [];
  await new Summarizer().summarize({ name: "T3", titled: true, nameSession: true, context: ["you → T3: say hello world"], claudeReply: "hello world", ...(voice ? { voice } : {}) }, () => {});
  const body = bodies.at(-1);
  const system: string = typeof body.system === "string" ? body.system : body.system.map((b: any) => b.text).join("\n");
  return { system, prompt: body.messages[0].content as string };
}
/** "Claude" in a summary's words other than the desktop app's name (a session's folder can be in it). */
const claudes = (text: string) => text.replace(/the Claude desktop app/g, "").match(/\bClaude\b/g) ?? [];

test("Claude Code's summary is word for word as before, told or not", async () => {
  const before = await summarizeAs(undefined);
  const told = await summarizeAs(CLAUDE_CODE_VOICE);
  assert.equal(told.system, before.system);
  assert.equal(told.prompt, before.prompt);
  assert.match(before.system, /^You are the voice of Claude Code, a coding agent\. A Claude Code session just finished a turn/);
  assert.match(before.system, /like "In atlas agents, Claude says the tests are still running/);
  assert.match(before.system, /call Claude Code "Claude"\./);
  assert.ok(before.prompt.endsWith("<claude_reply>hello world</claude_reply>\n<claude_asked>nothing</claude_asked>"), before.prompt);
});

test("a Codex session's says Codex, never Claude, and its reply is tagged as Codex's", async () => {
  const { system, prompt } = await summarizeAs({ agent: "Codex", speaker: "Codex" });
  assert.deepEqual(claudes(system), []);
  assert.match(system, /^You are the voice of Codex, a coding agent\. A Codex session just finished a turn/);
  assert.match(system, /like "In atlas agents, Codex says the tests are still running/);
  assert.match(system, /Never only say that Codex answered \("Codex told a joke"\)/);
  assert.match(system, /When codex_asked says nothing, Codex asked nothing/);
  assert.match(system, /call Codex "Codex"\./);
  assert.ok(prompt.endsWith("<codex_reply>hello world</codex_reply>\n<codex_asked>nothing</codex_asked>"), prompt);
  assert.deepEqual(claudes(prompt), []);
});

test("an OpenCode session's says OpenCode", async () => {
  const { system, prompt } = await summarizeAs({ agent: "OpenCode", speaker: "OpenCode" });
  assert.deepEqual(claudes(system), []);
  assert.match(system, /An OpenCode session just finished a turn/);
  assert.match(system, /like "In atlas agents, OpenCode says/);
  assert.match(system, /If OpenCode's reply only acknowledges/);
  assert.ok(prompt.endsWith("<opencode_reply>hello world</opencode_reply>\n<opencode_asked>nothing</opencode_asked>"), prompt);
});

test("a T3 Code thread's (Claude or Codex underneath, not told) says it, and is told never to name a model", async () => {
  const { system, prompt } = await summarizeAs({ agent: "T3 Code", speaker: "" });
  assert.deepEqual(claudes(system), []);
  assert.match(system, /^You are the voice of T3 Code, a coding agent\. A T3 Code session just finished a turn/);
  assert.match(system, /like "In atlas agents, it says the tests are still running/);
  assert.match(system, /Never only say that it answered \("It told a joke"\)/);
  assert.match(system, /If its reply only acknowledges/);
  assert.match(system, /call it "it", never by a name: you don't know which model it runs\./);
  assert.ok(prompt.endsWith("<agent_reply>hello world</agent_reply>\n<agent_asked>nothing</agent_asked>"), prompt);
});

test("Jev's stop question names who spoke too: Claude for Claude Code as before, Codex, or the agent", async () => {
  const asked = async (speaker?: string) => {
    bodies = [];
    await decideStop({ claudeReply: "hello world", context: [], ...(speaker === undefined ? {} : { speaker }) }).catch(() => {});
    return bodies.find((b) => b.questions)!;
  };
  const claude = await asked();
  assert.equal(claude.questions.needs_user.instructions, "Is Claude asking the user something or waiting on their decision before it goes on?");
  assert.equal(claude.questions.needs_user.criteria.true, "Claude asks a question, offers choices, or needs approval or input.");
  assert.deepEqual((await asked("Claude")).questions, claude.questions);
  const codex = await asked("Codex");
  assert.equal(codex.questions.needs_user.instructions, "Is Codex asking the user something or waiting on their decision before it goes on?");
  assert.equal(codex.questions.needs_user.criteria.false, "Codex reports, confirms or acknowledges; it needs nothing from the user.");
  assert.equal(codex.state.claude_reply, "hello world", "the state's key as before (shadow-report.ts reads it)");
  const unsure = await asked("");
  assert.equal(unsure.questions.needs_user.instructions, "Is the agent asking the user something or waiting on their decision before it goes on?");
  assert.equal(unsure.questions.needs_user.criteria.true, "The agent asks a question, offers choices, or needs approval or input.");
});

// Asked for another joke, Codex told one in its own voice ("I told my plant a joke…"), and the summary told it as yours
// ("you told your plant a joke…") and ended "Codex didn't ask anything else.", from <codex_asked>nothing</codex_asked>.
const JOKE_I = "I told my plant a joke.\n\n“Leaf me alone,” it said.\n\nSo I left it in the sun.";
const JOKE_I_SAID = `In workbench, here's a new one: you told your plant a joke, and it said "leaf me alone," so you left it in the sun.`;

test("told to keep a joke in its own words, its I as I, and never to say Codex asked nothing", async () => {
  const { system } = await summarizeAs({ agent: "Codex", speaker: "Codex" });
  assert.match(system, /say the joke itself, give the number, say what it found\. A joke, story, quote or anything else Codex said in its own voice keeps its words: its "I" stays "I", never "you"\./);
  assert.match(system, /When codex_asked says nothing, Codex asked nothing: don't ask or suggest anything, and don't say so either: never that Codex asked nothing or has no questions\./);
  const claude = await summarizeAs(undefined);
  assert.match(claude.system, /anything else Claude said in its own voice keeps its words/);
  assert.match(claude.system, /never that Claude asked nothing or has no questions\./);
});

test("a Codex summary's \"Codex didn't ask anything else.\" is neither spoken nor kept, and the log says it was dropped", async () => {
  bodies = [];
  said = `${JOKE_I_SAID} Codex didn't ask anything else.`;
  let heard = "";
  try {
    const voice = { agent: "Codex", speaker: "Codex" };
    const turn = { name: "workbench", titled: true, nameSession: true, context: ["you → workbench: tell me another plant joke"], claudeReply: JOKE_I, voice };
    const result = await new Summarizer().summarize(turn, (d) => (heard += d));
    const prompt: string = bodies.at(-1).messages[0].content;
    assert.ok(prompt.endsWith("<codex_asked>nothing</codex_asked>"), prompt.slice(-200));
    const logged = readdirSync("logs")
      .flatMap((f) => readFileSync(`logs/${f}`, "utf8").trim().split("\n"))
      .map((l) => JSON.parse(l));
    assert.equal(heard.trim(), JOKE_I_SAID);
    assert.equal(result?.text, JOKE_I_SAID);
    assert.equal(logged.filter((e) => e.event === "summary").at(-1).dropped, "Codex didn't ask anything else.");
  } finally {
    said = SAID;
  }
});
