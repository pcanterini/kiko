// Code guards in src/core/routing-rules.ts that run around the models: BARE_STOP, ASKED_FOR_NEW, and
// the repeat/yes/no fallbacks used without the classifier.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ASKED_FOR_NEW, BARE_STOP, NO_FALLBACK, permissionAnswer, REPEAT_FALLBACK, voiceAllows, YES_FALLBACK } from "../../../src/core/routing-rules.ts";

const each = (re: RegExp, phrases: string[], want: boolean) => {
  for (const p of phrases) test(`${want ? "matches" : "doesn't match"} ${JSON.stringify(p)}`, () => assert.equal(re.test(p), want));
};

describe("BARE_STOP: you cutting the app off, never Escape in a session", () => {
  // "Stop." once made the router press Escape in claude-code-speech.
  each(BARE_STOP, ["Stop.", "stop", "Stop it.", "Okay, stop.", "No, stop!", "Wait, stop that.", "Uh, stop talking.", "Cancel.", "Enough.", "Quiet please", "shush", "hey stop now"], true);
  each(
    BARE_STOP,
    ["Stop clipkit.", "Stop the deploy.", "Stop clipkit, it's going the wrong way.", "stop that build and release", "Tell clipkit to stop.", "Don't stop.", "Stop. Clipkit, wait for me.", "Status."],
    false,
  );
});

describe("ASKED_FOR_NEW: words that ask for a new session (otherwise start_session goes to the session already there)", () => {
  each(
    ASKED_FOR_NEW,
    [
      "Start a session in pixie.",
      "Open a new one in clipkit.",
      "open a new session",
      "Spin up another Claude in lacy platform",
      "Launch a fresh instance for this",
      "Can you start a new Claude Code session in the voice folder?",
      "I want a separate window for that",
      "kick off a new terminal",
    ],
    true,
  );
  each(
    ASKED_FOR_NEW,
    [
      // A feature request that opened a new window.
      "Could we, um, maybe put in a, a progress bar or a spinner or something along those lines",
      "Could you also spin up a helper agent to look for any folders called Cloud Notes?",
      "Start the tests.",
      "open the settings screen",
      "We need a new feature branch",
      "Let's start on the second option.",
    ],
    false,
  );
  test("'are you able to open a new session for the docs' asks for one", () => {
    assert.ok(ASKED_FOR_NEW.test("Are you able to open a new session for the docs?"));
  });
});

describe("Without the classifier: repeat / yes / no by phrase", () => {
  each(REPEAT_FALLBACK, ["Can you repeat that?", "Say that again", "Come again?", "what did you say", "Sorry, can you repeat what happened?"], true);
  each(REPEAT_FALLBACK, ["Repeated tests are flaky", "Run it again"], false);
  each(YES_FALLBACK, ["Yes.", "Yeah, go ahead.", "Sure.", "Okay", "Go ahead and do it", "Allow it", "approve"], true);
  each(YES_FALLBACK, ["No.", "I think yes", "Absolutely"], false);
  each(NO_FALLBACK, ["No.", "Nope", "Don't do that", "dont", "Deny", "Stop", "Cancel that"], true);
  each(NO_FALLBACK, ["Yes", "Not now", "Nobody asked"], false);
  // "Nobody" starts with "no" but the \b keeps it out; "Not now" isn't a no by phrase (unclear).
});

describe("permissionAnswer: the classifier's answer when sure, else unclear; phrases without the classifier", () => {
  const d = (answer: "allow" | "deny" | "allow_always" | "repeat" | "unclear", confidence: number) => ({ answer, confidence, costUsd: 0, ms: 0 });
  test("the classifier sure", () => assert.equal(permissionAnswer("Yes, you can allow that.", d("allow", 1)), "allow"));
  test("the classifier unsure → unclear (asks again)", () => assert.equal(permissionAnswer("Hmm, maybe", d("allow", 0.6)), "unclear"));
  test("no classifier: phrases", () => {
    assert.equal(permissionAnswer("Yes, you can allow that.", null), "allow");
    assert.equal(permissionAnswer("No, use pnpm instead.", null), "deny");
    assert.equal(permissionAnswer("Can you repeat that?", null), "repeat");
    assert.equal(permissionAnswer("What does it want to run?", null), "unclear");
  });
});

describe("voiceAllows levels", () => {
  test("replies: no messages, no managing", () => {
    assert.equal(voiceAllows("replies", "message"), false);
    assert.equal(voiceAllows("replies", "manage"), false);
  });
  test("messages (default): messages, no managing", () => {
    assert.equal(voiceAllows("messages", "message"), true);
    assert.equal(voiceAllows("messages", "manage"), false);
  });
  test("everything", () => {
    assert.equal(voiceAllows("everything", "message"), true);
    assert.equal(voiceAllows("everything", "manage"), true);
  });
});
