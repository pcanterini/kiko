// The app's name as the way to talk to it (src/core/wake.ts): up front and said to the app ("Kiko,
// ask Lacy if it deployed") it's taken off and the rest is routed as usual; anywhere else ("tell
// the Kiko session to fix the bug") it's the session on the app's own code, as before. Then the
// same through decide(), with the classifier and the router stubbed. Then hands-free listening (Listener) on a
// fake clock: the name wakes it, about 1.5s of quiet ends the request, anything else is ignored.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Action } from "../../../src/core/router.ts";
import type { Session } from "../../../src/core/sessions.ts";
import { decide, type DecideDeps, type DecideState } from "../../../src/core/decide.ts";
import { applyDictionary } from "../../../src/core/dictionary.ts";
import { MINE } from "../../support/dictionary.ts";
import {
  type Asks,
  BACKGROUND_BEFORE_MS,
  END_SILENCE_MS,
  Gate,
  leadingName,
  levelOf,
  Listener,
  MAX_REQUEST_MS,
  NAME_ONLY_WAIT_MS,
  type NeedsName,
  ONSET_MS,
  PHRASE_GAP_MS,
  realReply,
  wakeIn,
  WORDS_LAG_MS,
  WORDS_STILL_MS,
  type By,
} from "../../../src/core/wake.ts";
import { FakeClock } from "../../support/clock.ts";
import { makeWorld } from "../../support/fixtures.ts";
import { outcomesOf } from "../../support/outcomes.ts";
import { misheard, setSpokenName } from "../../../src/core/name.ts";

// The default name, Kiko, and its spellings ("Kiku", "Chiko", …: name.ts misheard). A name of
// your own: tests/unit/core/spoken-name.test.ts.
setSpokenName("Kiko");

const to = (text: string) => leadingName(text);

describe("the name up front, said to the app", () => {
  test("taken off with its comma or colon; the rest is what's routed", () => {
    assert.deepEqual(to("Kiko, ask Lacy if it deployed"), { addressed: true, rest: "Ask Lacy if it deployed" });
    assert.deepEqual(to("Kiko: what's everyone doing?"), { addressed: true, rest: "What's everyone doing?" });
    assert.deepEqual(to("Kiko. Is clipkit done?"), { addressed: true, rest: "Is clipkit done?" });
    assert.deepEqual(to("Kiko - stop Lacy."), { addressed: true, rest: "Stop Lacy." });
  });

  test("speech-to-text's spellings, before or after the dictionary", () => {
    for (const said of [
      "kiku, what's everyone doing?",
      "Chiko, what's everyone doing?",
      "Keeko: what's everyone doing?",
      "Keeko, what's everyone doing?",
      "Kico, what's everyone doing?",
      "kiko, what's everyone doing?",
    ]) {
      assert.deepEqual(to(said), { addressed: true, rest: "What's everyone doing?" }, said);
      assert.deepEqual(to(applyDictionary(said, MINE).text), { addressed: true, rest: "What's everyone doing?" }, `${said}, fixed`);
    }
  });

  test("without the comma speech-to-text often leaves out", () => {
    assert.deepEqual(to("Kiko ask Lacy if it deployed"), { addressed: true, rest: "Ask Lacy if it deployed" });
    assert.deepEqual(to("Kiko what's everyone doing"), { addressed: true, rest: "What's everyone doing" });
    assert.deepEqual(to("Kiko can you repeat that"), { addressed: true, rest: "Can you repeat that" });
  });

  test("'hey', 'okay', 'um' before it", () => {
    assert.deepEqual(to("Hey Kiko, what's everyone doing?"), { addressed: true, rest: "What's everyone doing?" });
    assert.deepEqual(to("Okay, Kiko, tell clipkit to commit."), { addressed: true, rest: "Tell clipkit to commit." });
    assert.deepEqual(to("Um, kiku, repeat that."), { addressed: true, rest: "Repeat that." });
  });

  test("only the name is nothing said", () => {
    for (const said of ["Kiko.", "Kiko", "kiku?", "Hey Kiko!", " Kico, ", "Kiko, Kiko."]) {
      assert.deepEqual(to(said), { addressed: true, rest: "" }, said);
    }
  });

  test("said twice, both go", () => {
    assert.deepEqual(to("Kiko, Kiko, what's up?"), { addressed: true, rest: "What's up?" });
  });
});

describe("'To Kiko, …' and 'Tell Kiko …' are said to the app", () => {
  test("'to' (or 'two') before the name", () => {
    assert.deepEqual(to("To Kiko, trying this from the laptop. Tell me if you hear it."), { addressed: true, rest: "Trying this from the laptop. Tell me if you hear it." });
    assert.deepEqual(to("Uh, to Kiko, what's next?"), { addressed: true, rest: "What's next?" });
    assert.deepEqual(to("To, uh, kiku, just testing."), { addressed: true, rest: "Just testing." });
  });
  test("'tell' before the name: what follows 'to' or 'that' is what's said to it", () => {
    assert.deepEqual(to("Tell Kiko to check the logs."), { addressed: true, rest: "Check the logs." });
    assert.deepEqual(to("Tell Kiko that I'm back."), { addressed: true, rest: "I'm back." });
    assert.deepEqual(to("Tell Kiko, I'm back."), { addressed: true, rest: "I'm back." });
  });
  test("with 'the', or 'session' after it, it's still the session", () => {
    for (const said of ["Tell the Kiko session to run the tests.", "Tell Kiko session to run the tests.", "To the Kiko project: run the tests.", "To Kiko's settings, add a toggle."]) {
      assert.deepEqual(to(said), { addressed: false, rest: said }, said);
    }
  });
});

// A real word speech-to-text writes for the name (name.ts misheard atStart; Kiko has none yet, so
// one is put on for this test, as scripts/perf/wake-name.ts tries them): the name only opening what
// you said, with a pause after it or after "tell"; never mid-sentence, never after a sentence ended.
describe("a real word written for the name, opening what you said", () => {
  function withAtStart(word: string, fn: () => void) {
    misheard("Kiko").atStart.push(word);
    // wake.ts keeps its pattern by name: show it another, then Kiko again.
    setSpokenName("Jarvis");
    to("x");
    setSpokenName("Kiko");
    try {
      fn();
    } finally {
      misheard("Kiko").atStart.splice(misheard("Kiko").atStart.indexOf(word), 1);
      setSpokenName("Jarvis");
      to("x");
      setSpokenName("Kiko");
    }
  }
  test("up front with a pause, or after 'to' or 'tell': the name", () =>
    withAtStart("fella", () => {
      assert.deepEqual(to("Fella, ask Lacy if it deployed."), { addressed: true, rest: "Ask Lacy if it deployed." });
      assert.deepEqual(to("To fella. That was a test."), { addressed: true, rest: "That was a test." });
      assert.deepEqual(to("Tell fella I'm back."), { addressed: true, rest: "I'm back." });
      assert.deepEqual(to("Fella."), { addressed: true, rest: "" });
    }));
  test("mid-sentence, straight into more words, or after a sentence ended: the word", () =>
    withAtStart("fella", () => {
      for (const said of ["I met a fella at the shop.", "Fella over there waved.", "To fella we go."]) assert.deepEqual(to(said), { addressed: false, rest: said }, said);
      assert.equal(wakeIn("We met last year. Fella, honestly, was great."), null);
      assert.deepEqual(wakeIn("Fella, ask Lacy."), { at: 0, rest: "Ask Lacy." });
      assert.equal(applyDictionary("I met a fella.", MINE).text, "I met a fella.", "never a dictionary entry");
    }));
});

describe("the name anywhere else: the session on the app's code", () => {
  for (const said of [
    "Tell the Kiko session to fix the bug.",
    "In the Kiko project, add a test for the hold.",
    "The Kiko app's settings screen is broken.",
    "Ask Kiko to run the tests.",
    "What's the status of Kiko?",
    "Kiko's status bar never says speaking.",
    "Kiko session, run the tests.",
    "Kiko app settings screen is broken.",
    "Kiko is broken again.",
    "Kiko and Lacy should both pull main.",
    "Kiko doesn't hear me.",
    "Kiku's caption is cut off.",
    "Pixel ball, run the tests.",
  ]) {
    test(said, () => assert.deepEqual(to(said), { addressed: false, rest: said }));
  }
});

describe("hands-free: the name at the start of a sentence", () => {
  test("at the start", () => {
    assert.deepEqual(wakeIn("Kiko, ask Lacy if it deployed"), { at: 0, rest: "Ask Lacy if it deployed" });
  });
  test("after what came before, once a sentence ended", () => {
    assert.deepEqual(wakeIn("Okay, thanks. Kiko, ask Lacy if it deployed."), { at: 14, rest: "Ask Lacy if it deployed." });
    assert.deepEqual(wakeIn("Yeah? Chiko what's everyone doing"), { at: 6, rest: "What's everyone doing" });
  });
  test("not mid-sentence, and not as what the sentence is about", () => {
    assert.equal(wakeIn("I told him the Kiko app is great"), null);
    assert.equal(wakeIn("so anyway Kiko ask Lacy"), null);
    assert.equal(wakeIn("Kiko's settings are odd."), null);
    assert.equal(wakeIn("Dinner's ready."), null);
  });
  test("the name alone", () => {
    assert.deepEqual(wakeIn("Kiko."), { at: 0, rest: "" });
  });
});

// ── Through decide() ─────────────────────────────────────────────────────────────────────────
const W = makeWorld([
  { name: "claude-code-speech", title: "Hands-free mode", status: "busy", asked: "Add the wake word." },
  { name: "Lacy", folder: "lacy-platform", given: "Lacy", status: "idle", asked: "Deploy the VM." },
  { name: "clipkit", status: "idle" },
]);
const S = (name: string) => W.byName.get(name.toLowerCase())!;

async function run(text: string, opts: { classifier?: string; router?: (s: (n: string) => Session) => Action[]; waiting?: string } = {}) {
  const seen = { classifier: [] as string[], router: [] as string[], beforeRoute: [] as string[] };
  const deps: DecideDeps = {
    utterance: async (input) => {
      seen.classifier.push(input.text);
      const audience = opts.classifier ? S(opts.classifier) : "app";
      return { audience, audienceConfidence: opts.classifier ? 0.95 : 0.3, intent: "message", intentConfidence: 0.95, appParts: 0, model: "test", costUsd: 0, ms: 1 };
    },
    approval: null,
    route: async (input) => {
      seen.router.push(input.text);
      return { text: "", actions: opts.router?.(S) ?? [], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
    },
    trim: null,
    beforeRoute: (words) => seen.beforeRoute.push(words),
  };
  const waiting = opts.waiting ? S(opts.waiting) : null;
  const state: DecideState = {
    text,
    sessions: W.sessions,
    notes: W.notes,
    recent: [],
    waiting: waiting && { sessionId: waiting.sessionId, cwd: waiting.cwd },
    justSpoke: null,
    lastId: null,
    appAsked: false,
    lastSent: null,
    lastRepeat: false,
    voiceCan: "everything",
    classifierMinConfidence: 0.75,
  };
  const d = await decide(state, deps);
  return { d, outcomes: outcomesOf(d, state), seen };
}

describe("decide(): the name up front is taken off, the rest routed as usual", () => {
  test("'Kiko, ask Lacy if it deployed': the classifier and the router see the words without the name", async () => {
    const { d, outcomes, seen } = await run("Kiko, ask Lacy if it deployed", {
      router: (s) => [{ name: "ask_session", session: s("Lacy"), message: "Did it deploy?" }],
    });
    assert.equal(d.toApp, true);
    assert.equal(d.text, "Ask Lacy if it deployed");
    assert.deepEqual(seen.classifier, ["Ask Lacy if it deployed"]);
    assert.deepEqual(seen.router, ["Ask Lacy if it deployed"]);
    assert.deepEqual(seen.beforeRoute, ["Ask Lacy if it deployed"]);
    assert.deepEqual(
      outcomes.map((o) => [o.action, "to" in o ? o.to : null]),
      [["ask", "Lacy"]],
    );
  });

  test("'Kiko, run the tests' is no longer the session on the app's code by name: routed like 'run the tests'", async () => {
    const named = await run("Kiko, run the tests.", { classifier: "clipkit" });
    const plain = await run("Run the tests.", { classifier: "clipkit" });
    assert.equal(named.d.step, plain.d.step);
    assert.deepEqual(named.outcomes, plain.outcomes);
    assert.notEqual(named.d.step, "addressed");
  });

  test("'Kiko: what's everyone doing?' goes to the router as a question to the app", async () => {
    const { d, seen } = await run("Kiko: what's everyone doing?");
    assert.equal(d.step, "router");
    assert.deepEqual(seen.router, ["What's everyone doing?"]);
  });

  test("a reply to the waiting session still is one: 'Kiko, yes, commit it' answers clipkit", async () => {
    const { outcomes } = await run("Kiko, yes, commit it.", { waiting: "clipkit", classifier: "clipkit" });
    assert.deepEqual(
      outcomes.map((o) => [o.action, "to" in o ? o.to : null, "text" in o ? o.text : null]),
      [["send", "clipkit", "Yes, commit it."]],
    );
  });

  test("only the name: nothing goes anywhere, nothing is asked", async () => {
    const { d, outcomes, seen } = await run("Kiko.");
    assert.equal(d.step, "name-only");
    assert.deepEqual(d.actions, []);
    assert.deepEqual(outcomes, [{ action: "none" }]);
    assert.deepEqual([seen.classifier, seen.router], [[], []]);
  });
});

describe("decide(): the name anywhere else is the session on the app's code", () => {
  test("'tell the Kiko session to fix the bug' goes to it, named", async () => {
    const { d, outcomes } = await run("Tell the Kiko session to fix the bug.");
    assert.equal(d.toApp, undefined);
    assert.equal(d.text, "Tell the Kiko session to fix the bug.");
    assert.deepEqual(
      outcomes.map((o) => [o.action, "to" in o ? o.to : null]),
      [["send", "claude-code-speech"]],
    );
  });

  test("'Kiko session, run the tests' up front is about the session too", async () => {
    const { d, outcomes, seen } = await run("Kiko session, run the tests.", { classifier: "claude-code-speech" });
    assert.equal(d.toApp, undefined);
    assert.deepEqual(seen.classifier, ["Kiko session, run the tests."]);
    assert.equal(outcomes[0].action, "send");
    assert.equal("to" in outcomes[0] && outcomes[0].to, "claude-code-speech");
  });

  test("'the Kiko app's settings screen is broken' while clipkit waits: work for the session on the app's code", async () => {
    const { outcomes } = await run("The Kiko app's settings screen is broken.", {
      waiting: "clipkit",
      classifier: "claude-code-speech",
    });
    assert.deepEqual(
      outcomes.map((o) => [o.action, "to" in o ? o.to : null]),
      [["send", "claude-code-speech"]],
    );
  });
});

// ── Hands-free listening ─────────────────────────────────────────────────────────────────────
/** A listener on a fake clock, with what it asked for. */
function listening(opts: { window?: boolean; asks?: Asks } = {}) {
  const clock = new FakeClock();
  const calls: string[] = [];
  const ended: Array<{ text: string; by: By; ms: number }> = [];
  const needs: NeedsName[] = [];
  let window = opts.window ?? false;
  let asks: Asks = opts.asks === undefined ? "yes-no" : opts.asks;
  const l = new Listener({
    replyWindow: () => window,
    asks: () => asks,
    needsName: (why) => needs.push(why),
    holding: (by) => calls.push(`holding ${by}`),
    named: () => calls.push("named"),
    ended: (h) => (calls.push(`ended ${h.by}`), ended.push(h)),
    dropped: (by) => calls.push(`dropped ${by}`),
    ignored: (why) => calls.push(why ? `ignored: ${why}` : "ignored"),
    clock,
  });
  return { l, clock, calls, ended, needs, setWindow: (open: boolean) => (window = open), setAsks: (a: Asks) => (asks = a) };
}

describe("hands-free: the name wakes it, about 1.5s of quiet ends the request", () => {
  test("'Kiko, ask Lacy if it deployed': held and cued at the name, ended after the quiet", () => {
    const { l, clock, calls, ended } = listening();
    l.heard("Kiko, ask");
    assert.deepEqual(calls, ["holding name", "named"]);
    clock.advance(600);
    l.heard("Kiko, ask Lacy if it deployed");
    clock.advance(END_SILENCE_MS - 1);
    assert.deepEqual(ended, []);
    clock.advance(1);
    assert.deepEqual(ended, [{ text: "Kiko, ask Lacy if it deployed", by: "name", ms: 600 + END_SILENCE_MS }]);
    assert.equal(l.awake, false);
    assert.equal(clock.pending(), 0);
  });

  for (const said of ["Chiko, what's everyone doing?", "keeko what's everyone doing", "Kico, do this.", "kiku: tell clipkit to commit.", "Hey Kiko, uh, what's the status of Lacy?"]) {
    test(`speech-to-text's spellings and your phrasing: ${JSON.stringify(said)}`, () => {
      const { l, clock, ended } = listening();
      l.heard(said);
      clock.advance(END_SILENCE_MS);
      assert.equal(ended.length, 1);
      assert.equal(ended[0].text, said);
    });
  }

  test("after something else, once a sentence ended: the request starts at the name", () => {
    const { l, clock, ended } = listening();
    l.heard("Okay, thanks.");
    l.heard("Okay, thanks. Kiko, ask Lacy if it deployed.");
    clock.advance(END_SILENCE_MS);
    assert.deepEqual(
      ended.map((e) => e.text),
      ["Kiko, ask Lacy if it deployed."],
    );
  });

  test("with the gate hearing voices, quiet is the sound's: words that come late don't stretch it", () => {
    const { l, clock, ended } = listening();
    for (let t = 0; t < 2000; t += 100) {
      l.sound(true);
      if (t === 500) l.heard("Kiko, ask Lacy");
      clock.advance(100);
    }
    // The voice stopped at 1900; Apple's last words come a moment later.
    clock.advance(600);
    l.heard("Kiko, ask Lacy if it deployed");
    clock.advance(1900 + END_SILENCE_MS - clock.now() - 1);
    assert.equal(ended.length, 0);
    clock.advance(WORDS_LAG_MS); // up to when the late words count from (2500 - lag = 1500 < 1900)
    assert.equal(ended.length, 1);
  });

  test("steady noise keeps the gate open: words that stop changing end it anyway", () => {
    const { l, clock, ended } = listening();
    l.heard("Kiko, ask Lacy if it deployed");
    for (let t = 0; t < WORDS_STILL_MS + 500; t += 100) {
      l.sound(true);
      clock.advance(100);
    }
    assert.equal(ended.length, 1);
    assert.ok(ended[0].ms >= WORDS_STILL_MS && ended[0].ms < WORDS_STILL_MS + 200, String(ended[0].ms));
  });

  test("a long request (40s of talking) isn't cut", () => {
    const { l, clock, ended } = listening();
    for (let t = 0; t < 40_000; t += 500) {
      l.sound(true);
      l.heard(`Kiko, tell clipkit ${"and more ".repeat(t / 500 + 1)}`);
      clock.advance(500);
    }
    assert.equal(ended.length, 0);
    clock.advance(END_SILENCE_MS + WORDS_LAG_MS + 500);
    assert.equal(ended.length, 1);
  });

  test("the longest request goes as it is", () => {
    const { l, clock, ended } = listening();
    l.heard("Kiko, tell clipkit");
    for (let t = 0; t < MAX_REQUEST_MS + 1000; t += 500) {
      l.heard(`Kiko, tell clipkit ${"and more ".repeat(t / 500 + 1)}`);
      clock.advance(500);
    }
    assert.equal(ended.length, 1);
    assert.equal(ended[0].ms, MAX_REQUEST_MS);
  });
});

describe("hands-free: the name alone waits for the request", () => {
  test("nothing comes: let go after the wait", () => {
    const { l, clock, calls } = listening();
    l.heard("Kiko.");
    assert.deepEqual(calls, ["holding name", "named"]);
    clock.advance(END_SILENCE_MS);
    assert.ok(l.awake, "not over after the usual quiet");
    clock.advance(NAME_ONLY_WAIT_MS - END_SILENCE_MS);
    assert.deepEqual(calls, ["holding name", "named", "dropped name"]);
  });

  test("the request comes after a pause: it ends after the quiet that follows it", () => {
    const { l, clock, ended } = listening();
    l.heard("Kiko.");
    clock.advance(2500);
    l.heard("Kiko. Ask Lacy if it deployed.");
    clock.advance(END_SILENCE_MS);
    assert.deepEqual(ended, [{ text: "Kiko. Ask Lacy if it deployed.", by: "name", ms: 2500 + END_SILENCE_MS }]);
  });
});

describe("hands-free: anything else is ignored, and only counted", () => {
  for (const said of ["Dinner's ready.", "The Kiko session is broken again.", "Kiko's settings screen is odd.", "so anyway kiku ask Lacy", "Kiko session, run the tests."]) {
    test(JSON.stringify(said), () => {
      const { l, clock, calls } = listening();
      l.heard(said);
      clock.advance(PHRASE_GAP_MS - 1);
      assert.deepEqual(calls, []);
      clock.advance(1);
      assert.deepEqual(calls, ["ignored"]);
      assert.equal(l.started, false, "ready for the next phrase");
    });
  }

  test("a sound with no words (a cough, a door) is nothing", () => {
    const { l, clock, calls } = listening();
    l.sound(true);
    clock.advance(WORDS_LAG_MS + PHRASE_GAP_MS);
    assert.deepEqual(calls, []);
    assert.equal(l.started, false);
  });

  test("a pause right after the name: the phrase waits for the name's words before it ends", () => {
    const { l, clock, calls } = listening();
    for (let t = 0; t < 500; t += 100) {
      l.sound(true); // "Kiko", said in half a second
      clock.advance(100);
    }
    l.heard("Q"); // a first guess at the sound
    clock.advance(800); // 1.3s: the quiet so far is longer than the gap
    l.heard("Kiko.");
    assert.deepEqual(calls, ["holding name", "named"]);
  });

  test("the name in the next phrase still wakes it", () => {
    const { l, clock, calls, ended } = listening();
    l.heard("I'll be right there.");
    clock.advance(PHRASE_GAP_MS);
    l.heard("Kiko, what's everyone doing?");
    clock.advance(END_SILENCE_MS);
    assert.deepEqual(calls, ["ignored", "holding name", "named", "ended name"]);
    assert.equal(ended[0].text, "Kiko, what's everyone doing?");
  });
});

describe("hands-free: replies without the name in a session's reply window", () => {
  test("words in the window are a reply: held, no cue", () => {
    const { l, clock, calls, ended } = listening({ window: true });
    l.heard("Yes, go ahead");
    assert.deepEqual(calls, ["holding reply"]);
    l.heard("Yes, go ahead and commit it.");
    clock.advance(END_SILENCE_MS);
    assert.deepEqual(ended, [{ text: "Yes, go ahead and commit it.", by: "reply", ms: END_SILENCE_MS }]);
  });

  test("a reply that turns out to start with the name gets the cue, once", () => {
    const { l, clock, calls } = listening({ window: true });
    l.heard("Paul a yes");
    l.heard("Chiko, yes");
    l.heard("Chiko, yes, commit it");
    clock.advance(END_SILENCE_MS);
    assert.deepEqual(calls, ["holding reply", "named", "ended name"]);
  });

  test("open when the sound started, closed by the time the words came: still a reply", () => {
    const { l, clock, calls, setWindow } = listening({ window: true });
    l.sound(true);
    setWindow(false);
    clock.advance(900);
    l.heard("No, leave it.");
    assert.deepEqual(calls, ["holding reply"]);
  });

  test("outside the window (or with the setting off), ignored", () => {
    const { l, clock, calls } = listening({ window: false });
    l.heard("Yes, go ahead.");
    clock.advance(PHRASE_GAP_MS);
    assert.deepEqual(calls, ["ignored"]);
  });
});

describe("hands-free: a reply without the name must be a real one", () => {
  test("two real words or more; fillers don't count", () => {
    for (const said of ["Yes, go ahead.", "Ship it.", "No, leave it.", "uh, run the tests"]) assert.equal(realReply(said, null), true, said);
    for (const said of ["Yeah.", "uh", "Okay.", "Hmm?", "Huh.", "uh-huh", "mm-hmm", "Oh, okay.", "okay okay", "", "..."]) assert.equal(realReply(said, null), false, said);
  });

  test("one word only when it answers what was asked", () => {
    for (const said of ["Yes.", "No!", "Allow.", "Stop.", "Yeah.", "Nope", "Deny", "Uh, yes."]) assert.equal(realReply(said, "yes-no"), true, said);
    for (const said of ["Okay.", "Hmm.", "Huh?", "Right.", "Dinner."]) assert.equal(realReply(said, "yes-no"), false, said);
    // Claude's multiple-choice question: a label, or its number.
    for (const said of ["Postgres.", "Two.", "2"]) assert.equal(realReply(said, "choice"), true, said);
    assert.equal(realReply("Hmm.", "choice"), false);
  });

  test("'yeah' alone in a window where it was only reporting: ignored, not a reply", () => {
    const { l, clock, calls } = listening({ window: true, asks: null });
    l.heard("Yeah.");
    assert.deepEqual(calls, []);
    clock.advance(PHRASE_GAP_MS);
    assert.deepEqual(calls, ["ignored: not a reply"]);
  });

  test("a cough written as 'huh' when it needs you: ignored", () => {
    const { l, clock, calls } = listening({ window: true, asks: "yes-no" });
    l.heard("Huh?");
    clock.advance(PHRASE_GAP_MS);
    assert.deepEqual(calls, ["ignored: not a reply"]);
  });

  test("'yes' to a permission prompt: its reply, at once", () => {
    const { l, clock, calls, ended } = listening({ window: true, asks: "yes-no" });
    l.heard("Yes.");
    assert.deepEqual(calls, ["holding reply"]);
    clock.advance(END_SILENCE_MS);
    assert.deepEqual(ended, [{ text: "Yes.", by: "reply", ms: END_SILENCE_MS }]);
  });

  test("'yeah' that goes on to say more is a reply once there's more", () => {
    const { l, clock, calls, ended } = listening({ window: true, asks: null });
    l.heard("Yeah");
    assert.deepEqual(calls, []);
    clock.advance(300);
    l.heard("Yeah, commit it");
    assert.deepEqual(calls, ["holding reply"]);
    clock.advance(END_SILENCE_MS);
    assert.equal(ended[0].text, "Yeah, commit it");
  });

  test("'Hey' alone, or a word after it, isn't a reply: the name may be coming ('Hey Kiko, just testing')", () => {
    for (const asks of ["yes-no", "choice", null] as const) {
      assert.equal(realReply("Hey", asks), false);
      assert.equal(realReply("Hey key", asks === "choice" ? "yes-no" : asks), false);
      assert.equal(realReply("Okay, yes", "yes-no"), true);
      assert.equal(realReply("Okay, do it", asks), true);
    }
    setSpokenName("Kiko");
    try {
      const { l, clock, calls, ended } = listening({ window: true, asks: "yes-no" });
      l.heard("Hey");
      l.heard("Hey key");
      assert.deepEqual(calls, [], "nothing taken yet");
      // The dictionary's "kiku" → "Kiko" comes with the live words (hands-free.ts fixes them first).
      l.heard("Hey Kiko, just");
      l.heard("Hey Kiko, just testing.");
      clock.advance(END_SILENCE_MS);
      assert.deepEqual(calls, ["holding name", "named", "ended name"]);
      assert.equal(ended[0].text, "Hey Kiko, just testing.");
    } finally {
      setSpokenName("Kiko");
    }
  });

  test("with the name, one word is fine anywhere", () => {
    const { l, clock, ended } = listening({ window: true, asks: null });
    l.heard("Kiko, yeah.");
    clock.advance(END_SILENCE_MS);
    assert.deepEqual(
      ended.map((e) => [e.text, e.by]),
      [["Kiko, yeah.", "name"]],
    );
  });
});

describe("hands-free: someone else talking around the app's words, and the window needs the name", () => {
  /** The app speaks for `ms` (the mic dropped), then the mic is back and the window opens. */
  const speaks = (h: ReturnType<typeof listening>, ms = 6000) => {
    h.l.deaf();
    h.clock.advance(ms + 400); // its words, then DEAF_TAIL_MS
    h.setWindow(true);
    h.l.back();
  };

  test("a TV going on as the app starts to speak: the window needs the name; replies without it are ignored", () => {
    const h = listening({ asks: "yes-no" });
    for (let t = 0; t < 3000; t += 100) {
      h.l.sound(true);
      if (t % 500 === 0) h.l.heard(`and in other news tonight ${"the weather ".repeat(t / 500 + 1)}`);
      h.clock.advance(100);
    }
    speaks(h);
    h.l.sound(false);
    assert.deepEqual(h.needs, [{ why: "during", ms: 0 }]);
    assert.ok(h.l.needsName);
    h.clock.advance(1500);
    h.l.heard("Yes, go ahead.");
    h.clock.advance(PHRASE_GAP_MS);
    assert.deepEqual(h.calls, ["ignored: needs the name"]);
    // With the name it's taken.
    h.l.heard("Kiko, yes, go ahead.");
    h.clock.advance(END_SILENCE_MS);
    assert.deepEqual(h.calls.slice(1), ["holding name", "named", "ended name"]);
  });

  test("talk without the name a few seconds before the app spoke: the window needs the name", () => {
    const h = listening();
    h.l.heard("Dinner's ready in five minutes.");
    h.clock.advance(PHRASE_GAP_MS);
    assert.deepEqual(h.calls, ["ignored"]);
    h.clock.advance(2000);
    speaks(h);
    h.l.sound(false);
    assert.equal(h.needs.length, 1);
    assert.equal(h.needs[0].why, "before");
    assert.equal(h.needs[0].ms, 2000 + PHRASE_GAP_MS);
  });

  test("a voice there the moment the mic comes back: it was going on all along", () => {
    const h = listening();
    speaks(h);
    h.clock.advance(ONSET_MS - 50);
    h.l.sound(true);
    assert.deepEqual(h.needs, [{ why: "onset", ms: ONSET_MS - 50 }]);
    h.l.heard("so the thing about the market is");
    h.clock.advance(WORDS_LAG_MS + PHRASE_GAP_MS);
    assert.deepEqual(h.calls, ["ignored: needs the name"]);
  });

  test("a quiet room: a reply without the name still works", () => {
    const h = listening({ asks: "yes-no" });
    h.l.heard("Dinner's ready.");
    h.clock.advance(PHRASE_GAP_MS + BACKGROUND_BEFORE_MS + 1); // long enough ago
    speaks(h);
    h.l.sound(false);
    h.clock.advance(700); // you take a moment to answer
    h.l.sound(true);
    h.l.heard("Yes.");
    assert.deepEqual(h.needs, []);
    assert.equal(h.l.needsName, null);
    assert.deepEqual(h.calls, ["ignored", "holding reply"]);
    h.clock.advance(END_SILENCE_MS + WORDS_LAG_MS);
    assert.deepEqual(
      h.ended.map((e) => e.text),
      ["Yes."],
    );
  });

  test("a cue, then the words: talk before the cue still counts", () => {
    const h = listening();
    h.l.heard("I told you already.");
    h.clock.advance(PHRASE_GAP_MS + 4000);
    h.l.deaf(); // the cue
    h.clock.advance(800);
    h.l.back();
    h.l.sound(false);
    h.clock.advance(300);
    speaks(h); // the words: 5.9s after that talk ended, but one stretch with the cue
    h.l.sound(false);
    assert.equal(h.needs.length, 1);
    assert.equal(h.needs[0].why, "before");
  });

  test("only that window: the next one, after a quiet room, takes a reply without the name", () => {
    const h = listening();
    h.l.heard("Dinner's ready.");
    h.clock.advance(PHRASE_GAP_MS);
    speaks(h);
    h.l.sound(false);
    assert.equal(h.needs.length, 1);
    h.setWindow(false);
    h.clock.advance(10_000);
    h.l.sound(false);
    speaks(h);
    h.l.sound(false);
    assert.equal(h.needs.length, 1);
    assert.equal(h.l.needsName, null);
    h.clock.advance(800);
    h.l.heard("Yes, do it.");
    assert.deepEqual(h.calls, ["ignored", "holding reply"]);
  });

  test("your own words to the app by name aren't someone else's", () => {
    const h = listening();
    h.l.heard("Kiko, ask Lacy if it deployed.");
    h.clock.advance(END_SILENCE_MS);
    speaks(h, 2000);
    h.l.sound(false);
    assert.deepEqual(h.needs, []);
  });
});

describe("hands-free: reset drops what was heard", () => {
  test("no callback, no timer; the next phrase starts clean", () => {
    const { l, clock, calls } = listening();
    l.heard("Kiko, ask Lacy");
    l.reset();
    clock.advance(10_000);
    assert.deepEqual(calls, ["holding name", "named"]);
    assert.equal(clock.pending(), 0);
    assert.equal(l.awake, false);
  });
});

describe("hands-free: the gate", () => {
  const pcm = (amplitude: number) => {
    const b = Buffer.alloc(3200);
    for (let i = 0; i < 1600; i++) b.writeInt16LE(Math.round(Math.sin(i / 5) * amplitude), i * 2);
    return b;
  };
  test("silence is -60 dB, full scale 0 dB", () => {
    assert.equal(levelOf(Buffer.alloc(3200)), 0);
    assert.ok(levelOf(pcm(32767)) > 0.9);
  });
  test("a voice over a quiet room is voiced; the room isn't", () => {
    const g = new Gate();
    for (let i = 0; i < 20; i++) assert.equal(g.voiced(levelOf(pcm(30))), false); // ~-60 dB room
    assert.equal(g.voiced(levelOf(pcm(3000))), true); // ~-23 dB voice
  });
  test("steady noise stops counting as a voice once the gate knows it", () => {
    const g = new Gate();
    g.voiced(levelOf(pcm(30)));
    const loud = levelOf(pcm(3000));
    let voiced = 0;
    for (let i = 0; i < 400; i++) voiced += g.voiced(loud) ? 1 : 0;
    assert.ok(voiced < 400 && !g.voiced(loud), `voiced ${voiced} of 400`);
  });
});
