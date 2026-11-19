// dropClosingRemark (src/core/summarizer.ts): a summary's last sentence about the summary itself is not spoken.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { agentNames, dropClosingRemark } from "../../../src/core/summarizer.ts";

/** Streams text in small pieces, like Haiku does; returns what was passed on before the end, and the result. */
function stream(text: string, size = 3, who?: string[]) {
  const heard: string[] = [];
  const out = dropClosingRemark((d) => heard.push(d), true, who);
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  const beforeEnd = heard.join("");
  return { beforeEnd, ...out.end(), heard: heard.join("") };
}

describe("dropClosingRemark", () => {
  const summary = "In atlas, Claude says it will let you know as soon as the export feature is finished and checked.";
  const remarks = [
    "No question needed, since you've asked to be told when it's done.",
    "No question needed here, since you've said you'll restart and test.",
    "Nothing else needs your input right now.",
    "Nothing more is needed from you for now.",
    "There's no question for you right now.",
    "That's a simple answer, so there's no follow-up question to ask.",
    "Since you've confirmed it works, there's nothing else needed from this session.",
    "Nothing else is pending there.",
    "There's nothing further it asked of you.",
    "It's not asking anything else right now.",
    // The summary eval (2026-10-31): the rule to keep what wasn't done, echoed when nothing was.
    "Nothing is left unfinished in that list.",
    "Nothing is left waiting on your input.",
  ];
  for (const remark of remarks)
    test(`drops ${JSON.stringify(remark)}`, () => {
      const r = stream(`${summary} ${remark}`);
      assert.equal(r.text, summary);
      assert.equal(r.dropped, remark);
      assert.equal(r.heard.trim(), summary);
    });

  test("the summary itself streams through before the end", () => {
    const r = stream(`${summary} Nothing else needs your input right now.`);
    assert.ok(r.beforeEnd.startsWith(summary.slice(0, -1)));
  });
  test("keeps a question", () => {
    const text = "In clipkit, Claude fixed the jump. Want it to commit that?";
    assert.deepEqual(stream(text), { beforeEnd: text.slice(0, -1), text, dropped: undefined, heard: text });
  });
  test("keeps facts that only look like one", () => {
    for (const text of [
      "In claude-code-speech, Claude saved the idea to its notes. No code was changed.",
      "In clipkit, Claude fixed the typo. Nothing else changed.",
      "In the 2 plus 2 session, Claude says 2.5 plus 2.5 is 5. So that's settled.",
    ])
      assert.equal(stream(text).heard, text);
  });
  test("never drops the only sentence", () => {
    assert.equal(stream("Nothing else is needed.").heard, "Nothing else is needed.");
  });
  test("a remark that isn't last is kept", () => {
    const text = `${summary} Nothing else is pending. It starts right after the header change.`;
    assert.equal(stream(text).heard, text);
  });

  // A Codex summary ended "Codex didn't ask anything else.", saying what its prompt's
  // <codex_asked>nothing</codex_asked> told it. The Claude ones are endings of the kind summaries came out with.
  const codex = agentNames({ agent: "Codex", speaker: "Codex" }, "workbench");
  const joke = 'In workbench, here\'s a new one: I told my plant a joke, it said "leaf me alone," so I left it in the sun.';
  test("drops \"Codex didn't ask anything else.\" from a Codex session's summary", () => {
    const r = stream(`${joke} Codex didn't ask anything else.`, 3, codex);
    assert.equal(r.text, joke);
    assert.equal(r.dropped, "Codex didn't ask anything else.");
    assert.equal(r.heard.trim(), joke);
  });
  for (const remark of [
    "Codex hasn't asked you anything.",
    "Codex isn't asking for anything else right now.",
    "Codex has no other questions for you.",
    "Codex also has nothing else to ask.",
    "Codex needs nothing else from you.",
    "Codex doesn't need anything from you.",
    "It didn't ask any questions.",
    "The session didn't ask anything else.",
    "Workbench didn't ask anything else.",
    "The workbench session has no questions.",
  ])
    test(`drops ${JSON.stringify(remark)} as Codex's`, () => {
      assert.equal(stream(`${joke} ${remark}`, 3, codex).dropped, remark);
    });
  for (const remark of [
    "Claude didn't ask anything else.",
    "Claude hasn't asked you anything.",
    "It hasn't asked you anything.",
    "Claude asked nothing, so there's nothing else to answer.",
    "Claude asked nothing, so there's nothing for you to answer.",
  ])
    test(`drops ${JSON.stringify(remark)} as Claude's, told nothing of who spoke`, () => {
      const r = stream(`${summary} ${remark}`);
      assert.equal(r.text, summary);
      assert.equal(r.dropped, remark);
    });
  test("another agent's name is no remark of this one's", () => {
    const text = `${summary} Codex didn't ask anything else.`;
    assert.equal(stream(text).heard, text);
  });
  test("keeps what it did or didn't do, and a remark with more in it", () => {
    for (const sentence of [
      "Codex didn't touch the tests.",
      "It didn't find the bug.",
      "Codex didn't ask before deleting the folder.",
      "It isn't asking for the API key anymore.",
      "Codex didn't ask anything else about the schema, so it used the default.",
      "Codex has no access to the network.",
      "Codex has nothing to show yet.",
      "It doesn't need anything else to pass.",
      // What it did, then that it asked nothing
      "Claude says it will tell you when it's ready, and it hasn't asked you anything.",
      "Claude isn't asking anything; it just offered to pull logs if something misbehaves.",
      "It needs nothing from you; once it's done, Claude will check and merge the work.",
      "It says nothing else needs doing for multiple devices right now.",
    ]) {
      assert.equal(stream(`${joke} ${sentence}`, 3, codex).heard, `${joke} ${sentence}`);
      assert.equal(stream(`${summary} ${sentence}`).heard, `${summary} ${sentence}`);
    }
  });
  test("one that only starts like one streams on once it's clear it isn't", () => {
    const r = stream(`${joke} Codex didn't touch the tests. It ran them twice.`, 3, codex);
    assert.ok(r.beforeEnd.includes("Codex didn't touch the tests."), r.beforeEnd);
  });
});
