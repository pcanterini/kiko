// What Claude's reply ends by asking (src/core/summarizer.ts claudeAsked), so a spoken summary only ends in a question
// Claude asked. A reply that asked nothing and ended on a line of status about an agent still running once got a summary
// ending in a question of its own about that agent's work. The reply was read as asking because of a list item further
// up that names verbs ("Three answers from the ranker: send, send with a note, or ask."), so the made-up question was kept.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { claudeAsked, dropClosingRemark, endingAsk, OFFER_NEEDS_USER, replyAsks } from "../../../src/core/summarizer.ts";
import { GO_AHEAD, HOW_TO_GET, IF_ODD, LISTED_VERBS, NOTHING_WAITING, OFFER_THEN_LIST, OK_WITH_IT, STEP_NUMBER, WHEN_DONE } from "../../support/asks-replies.ts";

const SUMMARY =
  "In Atlas, Claude added both ideas to the notes file under Search, as future work only. The search test set will grow from 120 queries to thousands, mixing bug-tracker cases with hand-written edge cases like typos and two filters at once.";
const ADDED = "Should it leave the theme work running, or wait for that to finish first?";

/** Streams text in small pieces, like Haiku does; returns what was passed on, and the result. */
function stream(text: string, asks: boolean, size = 3) {
  const heard: string[] = [];
  const out = dropClosingRemark((d) => heard.push(d), asks);
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return { ...out.end(), heard: heard.join("") };
}

describe("a list item that names verbs isn't an offer", () => {
  test("the reply asks nothing", () => {
    assert.equal(claudeAsked(LISTED_VERBS), null);
    assert.equal(replyAsks(LISTED_VERBS), false);
  });
  test("the made-up question is dropped from the summary as it streams", () => {
    const r = stream(`${SUMMARY} ${ADDED}`, replyAsks(LISTED_VERBS));
    assert.equal(r.text, SUMMARY);
    assert.equal(r.dropped, ADDED);
    assert.equal(r.heard.trim(), SUMMARY);
  });
  test("the list item alone asks nothing either", () => {
    assert.equal(replyAsks("- **Three answers from the ranker:** send, send with a note, or ask."), false);
  });
});

describe("claudeAsked: asks nothing", () => {
  for (const [what, reply] of [
    // Replies of shapes whose summary once added a question of its own (asks-replies.ts).
    ["ends with what to do when it's done", WHEN_DONE],
    ["ends with how to get the second half", HOW_TO_GET],
    ["says nothing else is waiting on you", NOTHING_WAITING],
    // Verbs in a list, or describing what something does.
    ["a list of verbs", "Jev picks one of three options: send, wait, or ask."],
    ["a list of replies", "The watch's quick replies: tell me, ask me, send, or skip."],
    ["ways to do something, after a colon", 'To share it: say "share the shopping list", press Ctrl+S, or run the command.'],
    ["what an installer does", "The setup script should check each variable, and say which one is missing."],
    ["how to see it", "Reload and send a new request to see them."],
    ["what the status bar will show", 'When idle, the bar will just say "All synced".'],
    ['"tell me" in a quoted feature name', 'I added the "tell me when it\'s done" switch to the preferences page.'],
    // A question in an earlier paragraph that the reply then moves on from. One in the last paragraph still asks.
    [
      "a question in an earlier paragraph",
      "Want me to merge it?\n\nActually, the tests are still running, so I'll hold off. The branch is pushed, and nothing else changed. I'll merge once they pass.",
    ],
  ] as const)
    test(what, () => {
      assert.equal(claudeAsked(reply), null);
      assert.equal(replyAsks(reply), false);
    });
});

describe("claudeAsked: what the reply ends by asking or offering", () => {
  for (const [what, reply, asked] of [
    ["a final question", "All 42 tests pass. Want me to commit it?", "Want me to commit it?"],
    ["a question with a choice", "The build is ready. Should I start it now, or later?", "Should I start it now, or later?"],
    ["two questions in a row", "It's done. Should I merge it? Or wait for the tests?", "Should I merge it? Or wait for the tests?"],
    ["say 'go'", "The fix is on its branch. Say 'go' and I'll merge.", "Say 'go' and I'll merge."],
    ['say "go", with code', 'The fix is ready. Say "go" and I\'ll merge `summary-asks`.', 'Say "go" and I\'ll merge `summary-asks`.'],
    ["an offer with no question mark, in the last paragraph", "I've written the plan into NOTES.md.\n\nI can do that next if you want.", "I can do that next if you want."],
    ["send me", "The fix is in. Send me a screenshot of the error.", "Send me a screenshot of the error."],
    ["a question before a list of options", "The fix is done.\n\nWhich should I start with?\n- the phone\n- the Mac", "Which should I start with?"],
    ["a question anywhere in the last paragraph", "Should I merge it now? The tests pass, the branch is pushed, and nothing else changed. It's a small change.", "Should I merge it now?"],
    // Longer replies (asks-replies.ts).
    ["a final question, after two paragraphs", GO_AHEAD, "Should I go ahead after the merge?"],
    ["no question mark", OK_WITH_IT, "If you're OK with it, I'll have a small agent make the change once the current merge lands."],
    ["an offer, then a labelled list and a line", OFFER_THEN_LIST, "I can add it if you want (with a backup first)."],
  ] as const)
    test(what, () => {
      assert.equal(claudeAsked(reply), asked);
      assert.equal(replyAsks(reply), true);
    });
});

// "If any step fails, just tell me its number." was taken as asking, and the summary turned it into a question of its
// own about telling Claude the number. A request for later, or for if something happens, asks nothing now (forLater); an offer with no "?" also needs the classifier to agree
// the session is waiting on you (OFFER_NEEDS_USER).
describe("a request for later or for if something happens asks nothing", () => {
  test("the reply asks nothing, with or without the classifier", () => {
    assert.equal(endingAsk(STEP_NUMBER), null);
    assert.equal(claudeAsked(STEP_NUMBER), null);
    assert.equal(claudeAsked(STEP_NUMBER, 0.16), null);
    assert.equal(claudeAsked(STEP_NUMBER, 0.9), null);
  });
  test("neither does a line about what's next after one", () => assert.equal(claudeAsked(IF_ODD), null));
  // Steps to try, then a request for if one misbehaves, then a line of status.
  const STEPS = (step: string) =>
    `Try these:\n\n7. **Pause:** during an upload, say "pause <file>". Then try right-click → Pause.\n8. ${step}\n\nIf anything misbehaves, tell me roughly when and I'll pull the logs.\n\nStill running: the "Session expired" banner fix.`;
  test("how-tos in a list above it aren't offers", () => {
    assert.equal(claudeAsked(STEPS("**Rename during an upload:** say a new name for the file while it's uploading.")), null);
  });
  test("a question in that list still asks", () => {
    assert.equal(claudeAsked(STEPS("**Rename:** should I add it to the menu too?")), "Rename: should I add it to the menu too?");
  });
  for (const reply of [
    "If any step fails, just tell me its number.",
    "It's all in the log, so I can trace it from there.",
    "Tell me if anything breaks.",
    "Let me know when you're back.",
    "Ping me if it fails again.",
    "Once you've tested, tell me what you see.",
    "Tell me how it goes.",
    "Send me whatever you find.",
    "If pages keep loading slowly, send me a screenshot of the timings.",
    "If something's off, I can roll it back in one command.",
    "Once you've tested the export fix, I can build it as a setting.",
    "Tell me once it's uploaded.",
    "Send the screenshot when you have it and I'll check the number.",
    "If they don't match, or the billing page shows a different total, tell me both numbers and I'll look.",
    "Let me know if that fixes it.",
    "If it breaks, say so and I'll roll it back.",
    "Say when you're back.",
    "Ask me any time to compare the two.",
    "Let me know whenever you'd like to dig into the data or need a hand with something.",
  ])
    test(JSON.stringify(reply), () => {
      assert.equal(claudeAsked(reply), null);
      assert.equal(claudeAsked(reply, 0.9), null);
    });
});

describe("still asking: a wish, a choice, the go-ahead", () => {
  for (const reply of [
    "Tell me which one you want.",
    "Let me know if you want me to commit it.",
    "Let me know if you'd like me to push it too.",
    "Tell me if you prefer the shorter one.",
    "Say when you want it committed.",
    "If you'd rather skip it entirely, say so and I'll stop it.",
    "If you meant something else, tell me.",
    "If it bothers you, I could make it quieter.",
    "I can do that next if you want.",
    "If you want it sooner, it's a small job I can start any time.",
    "I can start the price watch whenever you like.",
    // When the work would be, not when to answer.
    "Or I can wait and merge all three branches together once Search and the import fixes are done.",
    "When to start, your call.",
    "After the reload, tell me whether that layout is enough or whether you want a separate page.",
    "When you get a moment, tell me which kind of storage usage you meant.",
    "Just say when.",
    "Whenever you're ready, say 'go' and I'll merge.",
    "Tell me and I'll merge it when the tests pass.",
    "If that sounds right, I'll build it on main next.",
  ])
    test(JSON.stringify(reply), () => assert.equal(claudeAsked(reply), reply));
});

describe('an offer with no "?" needs the classifier to agree', () => {
  const OFFER = "The fix is in. I can add a setting for it if you want.";
  const ASKED = "I can add a setting for it if you want.";
  test(`counts at needs_user ${OFFER_NEEDS_USER} or more`, () => {
    assert.equal(claudeAsked(OFFER, OFFER_NEEDS_USER), ASKED);
    assert.equal(claudeAsked(OFFER, 0.8), ASKED);
  });
  test("not under it", () => {
    assert.equal(claudeAsked(OFFER, OFFER_NEEDS_USER - 0.01), null);
    assert.equal(claudeAsked(OFFER, 0.1), null);
  });
  test("without the classifier (null), as its words say", () => assert.equal(claudeAsked(OFFER, null), ASKED));
  test("it's an offer, not a question", () => assert.deepEqual(endingAsk(OFFER), { text: ASKED, question: false }));
  for (const [reply, asked] of [
    ["All 42 tests pass. Want me to commit it?", "Want me to commit it?"],
    ["If any step misbehaves, should I trace it?", "If any step misbehaves, should I trace it?"],
    ["It's done. Should I merge it? Or wait for the tests?", "Should I merge it? Or wait for the tests?"],
    [GO_AHEAD, "Should I go ahead after the merge?"],
  ] as const)
    test(`a "?" counts whatever the classifier says: ${JSON.stringify(asked)}`, () => {
      assert.equal(endingAsk(reply)?.question, true);
      for (const needsUser of [null, 0, 0.1, 0.9]) assert.equal(claudeAsked(reply, needsUser), asked);
    });
});
