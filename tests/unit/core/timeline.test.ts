// What "no, that was for clipkit" corrects (src/core/timeline.ts latestSend) and which replies are too
// bare to send anywhere else (src/core/routing-rules.ts bareReply). Once, after a
// repeat, a correction resent an older "Yeah." into clipkit, which took it as a yes.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bareReply } from "../../../src/core/routing-rules.ts";
import { latestSend, Timeline, type Entry } from "../../../src/core/timeline.ts";

const at = Date.now();
const you = (text: string, sessionId: string | null = null): Entry => ({ at, who: "you", sessionId, folder: sessionId, text });
const app = (text: string, more: Partial<Entry> = {}): Entry => ({ at, who: "app", sessionId: null, folder: null, text, ...more });
const read = (sessionId: string): Entry => ({ at, who: "claude", sessionId, folder: sessionId, text: "done", spoken: `In ${sessionId}, done.` });

describe("latestSend", () => {
  test("a send, then the app's line about it: still the latest", () => {
    assert.equal(latestSend([you("Run the tests.", "clipkit"), app("To clipkit.")], 60_000, true)?.text, "Run the tests.");
  });
  test("routed through the app first (you → app, then you → clipkit): still the latest", () => {
    assert.equal(latestSend([you("Run the tests."), you("Run the tests.", "clipkit")], 60_000, true)?.sessionId, "clipkit");
  });
  test("later words went to the app (a repeat, a question): not the latest", () => {
    const entries = [you("Yeah.", "voice"), you("Repeat the last clipkit message."), app("In voice, …", { repeated: true })];
    assert.equal(latestSend(entries, 60_000, true), undefined);
    assert.equal(latestSend(entries, 60_000)?.text, "Yeah.", "without `latest`, as before (never mind uses this)");
  });
  test("another session read out since: not the latest; its own reply read out: still is", () => {
    assert.equal(latestSend([you("Commit.", "voice"), read("clipkit")], 60_000, true), undefined);
    assert.equal(latestSend([you("Commit.", "voice"), read("voice")], 60_000, true)?.text, "Commit.");
  });
  test("too old", () => {
    assert.equal(latestSend([{ ...you("Commit.", "voice"), at: at - 200_000 }], 180_000, true), undefined);
  });
});

describe("bareReply", () => {
  for (const t of ["Yeah.", "No.", "Sure", "Okay, go ahead.", "Yes, do it.", "Sounds good, thanks."]) test(`${JSON.stringify(t)} is bare`, () => assert.ok(bareReply(t)));
  for (const t of ["Run the tests.", "Yeah, commit it.", "No, use pnpm.", "Cut a new dev build.", ""]) test(`${JSON.stringify(t)} isn't`, () => assert.equal(bareReply(t), false));
});

// What a finished turn's summary is told you sent a session during it, when its own record can't say
// (app.ts askedOf): the app's sends since its last finished turn, not a permission prompt or your answer to it.
describe("sentSinceTurn", () => {
  test("your sends to it since its last finished turn; a permission prompt and your yes aren't either", () => {
    const t = new Timeline();
    t.add({ who: "you", sessionId: "kiko", folder: "kiko", text: "An earlier ask." });
    t.add({ who: "claude", sessionId: "kiko", folder: "kiko", text: "Done." });
    t.add({ who: "you", sessionId: "kiko", folder: "kiko", text: "Tell me a short joke." });
    t.add({ who: "you", sessionId: "clipkit", folder: "clipkit", text: "Run the tests." });
    t.add({ who: "claude", sessionId: "kiko", folder: "kiko", text: "asks permission to run git merge", permission: true });
    t.add({ who: "you", sessionId: "kiko", folder: "kiko", text: "yes to run git merge", permission: true });
    assert.deepEqual(
      t.sentSinceTurn("kiko").map((e) => e.text),
      ["Tell me a short joke."],
    );
    assert.deepEqual(
      t.sentSinceTurn(["other-id", "clipkit"]).map((e) => e.text),
      ["Run the tests."],
    );
    assert.deepEqual(new Timeline().sentSinceTurn("kiko"), []);
  });
});

// Words that never reached a session (app.ts typeInto, notReached: Entry.notSent). A status question to
// the Kiko project was refused (its terminal on the agents list, then "ambiguous"), but its entry
// stayed "you → Kiko project: …": the next summary was told it had been asked that, and the
// router then listed it as what the session was "last asked".
describe("words that didn't reach a session", () => {
  const ASK = "Where are we on this project? A quick status, please.";
  const ID = "e9a4c7d2";
  function refused() {
    const t = new Timeline();
    t.add({ who: "you", sessionId: ID, folder: "Kiko project", text: "Run the tests before you merge." });
    t.add({ who: "claude", sessionId: ID, folder: "Kiko project", text: "Tests pass; merged." });
    t.add({ who: "you", sessionId: ID, folder: "Kiko project", text: ASK, turn: 4 });
    t.add({ who: "app", sessionId: null, folder: null, text: "I couldn't reach Kiko project: I can't tell which terminal is Kiko project, so I didn't type that in." });
    return t;
  }
  test("marked not sent: shown so in the models' lines, never as delivered", () => {
    const t = refused();
    const entry = t.markNotSent(ID, ASK);
    assert.equal(entry?.notSent, true);
    const lines = Timeline.lines(t.recent(4, ID));
    assert.ok(lines.includes(`you → Kiko project (not sent): ${ASK}`), lines.join("\n"));
    assert.ok(!lines.includes(`you → Kiko project: ${ASK}`));
  });
  test("not what it was last asked, nor words it has since its turn, nor a topic raised with it", () => {
    const t = refused();
    t.markNotSent([ID, "another-id"], ASK);
    assert.equal(t.last("you", ID)?.text, "Run the tests before you merge.");
    assert.deepEqual(t.sentSinceTurn(ID), []);
    assert.ok(!t.topics(ID, { count: 5 }).some((l) => l.includes("status")), t.topics(ID, { count: 5 }).join(" | "));
  });
  test("marked once: the same words that reached it earlier stay sent; marked again, the same entry", () => {
    const t = new Timeline();
    const first = t.add({ who: "you", sessionId: ID, folder: "Kiko project", text: "Commit." });
    const second = t.add({ who: "you", sessionId: ID, folder: "Kiko project", text: "Commit." });
    assert.equal(t.markNotSent(ID, "Commit."), second);
    assert.equal(t.markNotSent(ID, "Commit."), second);
    assert.equal(first.notSent, undefined);
    assert.equal(t.last("you", ID), first);
  });
  test("only your words for that session: another's, a permission answer, or other words aren't marked", () => {
    const t = new Timeline();
    t.add({ who: "you", sessionId: "clipkit", folder: "clipkit", text: ASK });
    t.add({ who: "you", sessionId: ID, folder: "Kiko project", text: "yes to run git merge", permission: true });
    assert.equal(t.markNotSent(ID, ASK), undefined);
    assert.equal(t.markNotSent(ID, "yes to run git merge"), undefined);
  });
  test("still the latest send (never mind and a correction see it, not an older one), but nobody else in the go lost it", () => {
    const t = refused();
    t.markNotSent(ID, ASK);
    const all = t.recent(10);
    assert.equal(latestSend(all, 60_000)?.text, ASK, "never mind: this one, not the older send");
    assert.equal(latestSend(all, 60_000, true)?.notSent, true, "a correction knows it didn't get there");
    // The router asked three at once; one of them refused it.
    const go = new Timeline();
    go.add({ who: "you", sessionId: "clipkit", folder: "clipkit", text: "Pull main.", turn: 2 });
    go.add({ who: "you", sessionId: "lacy", folder: "Lacy", text: "Pull main.", turn: 2 });
    const sent = go.add({ who: "you", sessionId: ID, folder: "Kiko project", text: "Pull main.", turn: 2 });
    go.markNotSent("lacy", "Pull main.");
    assert.deepEqual(
      go.sentWith(sent).map((e) => e.sessionId),
      ["clipkit"],
    );
  });
});
