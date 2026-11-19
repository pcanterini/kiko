// A question the summary adds when Claude's reply asked nothing is not spoken (src/core/summarizer.ts replyAsks and
// dropClosingRemark). Once, the reply ended "I'll tell you when both are ready.", and the summary turned that into a
// question of its own (whether Claude should tell you, or walk you through the restart), copying the summary before it,
// which fairly ended in a question.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dropClosingRemark, replyAsks } from "../../../src/core/summarizer.ts";

const REPLY = `I've started a second agent on the export setting, alongside the one fixing the slow upload. They don't touch the same files, so they'll both be ready for the same test run.

**The export setting:** an "Include archived items" switch, off by default. Turned on, an export also takes the archived folders, while the regular export stays as small and quick as before. It takes effect as soon as you flip it, except mid-export: then it waits until that export finishes. The log for each export will say which folders went in, so we can check it worked.

**What you'll be able to test in one go:**
1. With a large file, an upload on a slow connection finishes without stalling. That fix is already committed.
2. With "Include archived items" on, export a project and find the archived folders in the zip.
3. With two uploads at once, the progress bar no longer gets stuck at 99%, and tells you if an upload couldn't finish.

I'll tell you when both are ready. You'll need to restart the server and reload the page for the new setting.`;
const SUMMARY = "In Kiko, Claude has started a second agent on the export setting, so both fixes can be tested together.";
const ADDED = "Want Claude to tell you when both are ready, or to walk you through the restart and the reload?";

// The turn before: the reply offered the setting ("if you want it while you're testing"), so its question was fair.
const OFFERING = `After the upload fix is merged, here's the order:

1. **You test with a large file.** That covers both fixes: the stalled upload, and the progress bar getting stuck at 99% when two uploads run at once.
2. **Optional, small:** the "Include archived items" setting, if you want it while you're testing exports anyway. Otherwise it stays parked in \`NOTES.md\`.
3. **Search, the main work.** The app would index files as they arrive, so it no longer depends on the nightly job.

I'll let you know when the upload fix is ready to test.`;
const OFFERED =
  "In Kiko, the next step is for you to test the upload fix with a large file. After that comes an optional small setting for archived items, then the main work: indexing files as they arrive. Want me to add the export setting before you test, or leave it parked?";

/** Streams text in small pieces, like Haiku does; returns what was passed on before the end, and the result. */
function stream(text: string, asks: boolean, size = 3) {
  const heard: string[] = [];
  const out = dropClosingRemark((d) => heard.push(d), asks);
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  const beforeEnd = heard.join("");
  return { beforeEnd, ...out.end(), heard: heard.join("") };
}

describe("replyAsks", () => {
  test("the reply asked nothing", () => {
    assert.equal(replyAsks(REPLY), false);
  });
  test("the reply offered a choice, with no question mark", () => {
    assert.equal(replyAsks(OFFERING), true);
  });
  test("a question mark asks", () => {
    assert.equal(replyAsks("All 42 tests pass. Want me to commit it?"), true);
  });
  for (const reply of [
    "It's on `export-setting` and not committed yet. Say when you want it committed.",
    "To use the fix, restart the app, and tell me if you want it committed.",
    "I'd go with this; your call when you're up.",
    "If you'd rather skip it entirely, say so and I'll stop it.",
    'Say "go" and I\'ll merge it.',
    "If it bothers you, I could make it quieter.",
    "Use the app normally for a day, then run the report again, or just ask me.",
    "My pick is the second layout.",
    "The calendar sync: built, waiting on you.",
    "Let me know which one.",
    "Want me to push it too.",
    "If that sounds right, I'll build it on main next.",
    "All 51 rows came through. Send the import screenshot and I'll check the server's side too.",
  ])
    test(`offers: ${JSON.stringify(reply)}`, () => assert.equal(replyAsks(reply), true));
  for (const reply of [
    "I'll tell you when it's live.",
    "I'll let you know when it's done and whether you need to restart the app.",
    "The log for each export will say which folders went in.",
    "Run `curl 'localhost:3000/x?y=1'` to check it.",
    "It's at https://example.com/page?id=4 now.",
    "The fix:\n```ts\nconst x = a ? b : c;\n```\nAll tests pass.",
    'The summary turned it into "Want Claude to tell you when both are ready?" and that\'s fixed now.',
    'Next is the "tell me when it\'s done" feature.',
    "I can't rename a session from my side.",
    // For later: nothing to answer until it's tested (claude-asked.test.ts).
    "Once you've tested the export fix, I can build it as a setting.",
  ])
    test(`asks nothing: ${JSON.stringify(reply)}`, () => assert.equal(replyAsks(reply), false));
});

describe("dropClosingRemark, when the reply asked nothing", () => {
  test("the added question is dropped, and the summary itself streams through before the end", () => {
    const r = stream(`${SUMMARY} ${ADDED}`, replyAsks(REPLY));
    assert.equal(r.text, SUMMARY);
    assert.equal(r.dropped, ADDED);
    assert.equal(r.heard.trim(), SUMMARY);
    assert.ok(r.beforeEnd.startsWith(SUMMARY.slice(0, -1)));
  });
  test("a reply that offers keeps its question", () => {
    const r = stream(OFFERED, replyAsks(OFFERING));
    assert.deepEqual({ text: r.text, dropped: r.dropped, heard: r.heard }, { text: OFFERED, dropped: undefined, heard: OFFERED });
  });
  test("a question in the middle is dropped, and what follows is kept", () => {
    const r = stream(`${SUMMARY} Should it commit that? It'll tell you when both are ready.`, false);
    assert.equal(r.text, `${SUMMARY} It'll tell you when both are ready.`);
    assert.equal(r.dropped, "Should it commit that?");
  });
  test("other ways a question starts", () => {
    for (const q of ["Do you want it to go ahead?", "Would you like the steps?", "Anything else?", "Which one should it start with?", "Or should it wait?"]) {
      const r = stream(`${SUMMARY} ${q}`, false);
      assert.equal(r.text, SUMMARY, q);
      assert.equal(r.dropped, q);
    }
  });
  test("a sentence that only starts like a question is kept", () => {
    const text = `${SUMMARY} What's next is the search work. Should the build fail, it rolls back on its own.`;
    assert.equal(stream(text, false).heard, text);
  });
  test("never drops the first sentence, even a question", () => {
    const text = "Want Claude to commit that? It finished the fix.";
    assert.equal(stream(text, false).heard, text);
  });
  test("a closing remark is still dropped too", () => {
    const r = stream(`${SUMMARY} ${ADDED} Nothing else needs your input right now.`, false);
    assert.equal(r.text, SUMMARY);
    assert.equal(r.dropped, `${ADDED} Nothing else needs your input right now.`);
  });
  test("when the reply asks, nothing changes", () => {
    const text = `${SUMMARY} ${ADDED}`;
    assert.equal(stream(text, true).heard, text);
  });
});
