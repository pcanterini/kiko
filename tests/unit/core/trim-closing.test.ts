// Verbatim-only trimming (src/core/trim.ts) and closing phrases (src/core/closing-words.ts).
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isClosing } from "../../../src/core/closing-words.ts";
import { isTrimOf, removeParts } from "../../../src/core/trim.ts";

describe("removeParts: only deletes, and only what was said", () => {
  test("drops a routing aside, keeps the rest as said", () => {
    const r = removeParts("Oh, for the checkout page one. Uh, let's uh, actually rebase the two open branches onto main.", ["Oh, for the checkout page one."]);
    assert.deepEqual(r, {
      text: "Uh, let's uh, actually rebase the two open branches onto main.",
      dropped: ["Oh, for the checkout page one"],
    });
  });
  test("drops 'Tell, uh, Lacy' at the start", () => {
    const said = "Tell, uh, Lacy, that's fine.";
    const r = removeParts(said, ["Tell, uh, Lacy"]);
    assert.deepEqual(r, { text: "That's fine.", dropped: ["Tell, uh, Lacy"] });
    assert.ok(isTrimOf(said, r.text));
  });
  test("a part that isn't in the words: nothing", () => {
    assert.equal(removeParts("Run the tests please.", ["for the clipkit one"]), null);
  });
  test("a part with a negation is never dropped", () => {
    assert.equal(removeParts("Don't run it, for the clipkit one", ["Don't run it"]), null);
    assert.equal(removeParts("Not that file, the other one. For clipkit.", ["Not that file"]), null);
  });
  test("short parts (under 3 words) stay unless they're only uh/um", () => {
    assert.equal(removeParts("Clipkit go ahead", ["Clipkit"]), null);
    assert.deepEqual(removeParts("Uh um run the tests", ["uh um"])?.text, "Run the tests");
  });
  test("overlapping parts: nothing", () => {
    assert.equal(removeParts("for the clipkit one please run it", ["for the clipkit one", "the clipkit one please"]), null);
  });
  test("case and punctuation don't matter; the sentence end is kept", () => {
    const r = removeParts("Let's merge. This is for Claude code speech. Then deploy.", ["this is for claude code speech"]);
    assert.equal(r?.text, "Let's merge. Then deploy.");
  });
  test("a correction: the trim cut 'that was supposed to be for Clipkit' and typed the rest", () => {
    // What happened: the correction itself went to clipkit, minus its routing words.
    // removeParts did its job; the bug was upstream (a correction is not a message). See the eval.
    const r = removeParts("No, that wasn't for the atlas one, that was supposed to be for Clipkit.", ["that was supposed to be for Clipkit"]);
    assert.equal(r?.text, "No, that wasn't for the atlas one");
  });
});

describe("isTrimOf: the kept text is the original minus pieces", () => {
  test("in-order subsequence with enough left", () => {
    assert.ok(isTrimOf("for the clipkit one. Let's merge the branches now", "Let's merge the branches now"));
  });
  test("added or changed words fail", () => {
    assert.equal(isTrimOf("Let's merge the branches now", "Let us merge the branches now"), false);
    assert.equal(isTrimOf("run the tests", "run the tests"), false, "nothing removed");
  });
  test("too little left fails (under 2 real words or under a quarter)", () => {
    assert.equal(isTrimOf("a b c d e f g h i j k l", "a b"), false);
    assert.equal(isTrimOf("uh um merge", "uh merge"), false);
  });
});

describe("isClosing: wrap-ups by phrase, before the classifier", () => {
  // Wrap-ups as people say them.
  const closing = [
    "No, that's fine.",
    "Cool, thanks.",
    "No.",
    "Okay, thanks.",
    "No, that's okay.",
    "No, that's fine, thanks.",
    "Cool, thank you.",
    "Uh, no, that's fine. Thank you.",
    "That's all, thank you.",
  ];
  for (const said of closing) test(`closes: ${JSON.stringify(said)}`, () => assert.equal(isClosing(said), true));

  // Not closers by phrase: some are wrap-ups only Jev can tell, some are real replies.
  const open = [
    "okay", // may mean yes
    "Sure.",
    "Yeah, that's fine.", // a reply ("that's fine" after "yeah")
    "Got it. Thank you.", // Jev took it as wrap_up
    "No, I'll test it first.", // a reply to Claude
    "That one can wait for later. Thank you.", // a decision for Claude
    "Uh, no, that's fine. That was all I needed. Thank you.", // Jev wrap_up 1.00
    "thanks, but run the tests",
    "No, that was for clipkit.",
    "Stop.",
  ];
  for (const said of open) test(`doesn't close: ${JSON.stringify(said)}`, () => assert.equal(isClosing(said), false));
});
