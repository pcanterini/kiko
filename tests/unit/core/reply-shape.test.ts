// What the code reads in a finished turn's reply before its summary (src/core/reply-shape.ts): what kind of reply it is,
// what a summary must never drop, and that cutting a long reply down keeps those. Replies in the shape of real ones.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clipReply, mustKeepOf, shapeOf } from "../../../src/core/reply-shape.ts";
import { claudeAsked } from "../../../src/core/summarizer.ts";

const shape = (reply: string, asked: string[] = []) => shapeOf(reply, asked, claudeAsked(reply));

describe("what kind of reply it is", () => {
  test("a short acknowledgment is a plain done", () => {
    assert.deepEqual(shape("Done, committed as `a1b2c3d`.").kinds, ["done"]);
    assert.deepEqual(shape("Sounds good.").kinds, ["done"]);
  });

  test("work reported, all well, is a report: no must-keep items", () => {
    const s = shape(
      "The export fix is merged into main. All 1,204 unit tests pass, the end-to-end run passed, and the release build succeeded. It now writes the file only once the export is complete, and a small check mark shows when it's saved. Old exports in the folder are kept rather than replaced.",
    );
    assert.deepEqual(s.kinds, ["report"]);
    assert.deepEqual(s.mustKeep, []);
  });

  test("tests that still fail make it a failure, and the failure is kept", () => {
    const s = shape("I merged the routing fix. Two tests in the nav suite still fail on the new pane layout; I haven't looked into why yet.");
    assert.ok(s.kinds.includes("failure"), s.kinds.join());
    assert.ok(
      s.mustKeep.some((m) => m.kind === "failure" && /still fail/.test(m.text)),
      JSON.stringify(s.mustKeep),
    );
  });

  test("a reply that ends by asking is a decision", () => {
    const s = shape("There are two ways to do it: a short name for each session, or matching names that sound alike. Should I do both?");
    assert.ok(s.kinds.includes("decision"));
  });

  test("your question this turn makes it an answer", () => {
    const s = shape("No, a sleeping laptop won't keep the sync going. Only an awake machine counts.", ["Does closing the lid keep the sync going?"]);
    assert.ok(s.kinds.includes("answer"));
  });

  test("a plan laid out in a list is a plan", () => {
    const s = shape(`Here's the plan:
1. Read the reply's kind in code.
2. Keep failures and questions when a long reply is cut.
3. Let "more" say a longer summary.

I'd start with the first two.`);
    assert.ok(s.kinds.includes("plan"), s.kinds.join());
  });
});

describe("what a summary must never drop", () => {
  test("a caveat, something skipped, and a risk are found; fixed things and passing tests aren't failures", () => {
    const keep = mustKeepOf(`Fixed the crash when the phone reconnects, and all 312 tests pass with no errors.
I couldn't verify it on the real iPhone, only the simulator.
I skipped the Keychain migration for now.
I also force-pushed the branch to drop the bad commit.`);
    const kinds = keep.map((m) => m.kind);
    assert.ok(kinds.includes("caveat"), JSON.stringify(keep));
    assert.ok(kinds.includes("skipped"), JSON.stringify(keep));
    assert.ok(kinds.includes("risk"), JSON.stringify(keep));
    assert.ok(!kinds.includes("failure"), JSON.stringify(keep));
  });

  test("code in a sentence isn't what it says: a `fail()` call isn't a failure", () => {
    assert.deepEqual(mustKeepOf("I renamed `assertFail()` to `fail()` in the helpers, and moved the error types next to them in `errors.ts`."), []);
  });

  test("never more than a few, so the summary doesn't turn into a list", () => {
    const many = Array.from({ length: 10 }, (_, i) => `Step ${i + 1} failed with a timeout.`).join(" ");
    assert.ok(mustKeepOf(many).length <= 4);
  });
});

describe("cutting a long reply down", () => {
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `Step ${i + 1} moved some code around in the settings screen and renamed a helper.`).join(" ");
  const reply = `I finished the routing work.\n\n${filler(40)}\n\nTwo tests in the nav suite still fail on the new pane layout.\n\n${filler(40)}\n\nShould I merge it anyway, or wait until those tests pass?`;

  test("the failure from the middle and the question at the end both survive", () => {
    assert.ok(reply.length > 6000);
    const clipped = clipReply(reply, 6000);
    assert.ok(clipped.length <= 6100, String(clipped.length));
    assert.match(clipped, /Two tests in the nav suite still fail/);
    assert.match(clipped, /Should I merge it anyway, or wait until those tests pass\?$/);
    assert.match(clipped, /^I finished the routing work\./);
  });

  test("a reply that fits is left as it is", () => {
    assert.equal(clipReply("Short reply.", 6000), "Short reply.");
  });
});
