// Your dictated words the app typed into a session, matched against the prompt it then takes in
// (src/core/dictated.ts): the agent is told a prompt was dictated only when it's one of them, in that
// session, moments after the typing, and once. A prompt typed by hand never is. The examples are how
// the app's typing really arrives (as of 2026-11-14).
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DICTATED_QUEUED_MS, DICTATED_WITHIN_MS, Dictated, promptKey, unpasted } from "../../../src/core/dictated.ts";
import type { Session } from "../../../src/core/sessions.ts";
import { StartingSessions } from "../../../src/core/starting.ts";
import { VOICE_PROMPT, VOICE_REPLY } from "../../../hooks/lib.mjs";

/** A session as its agent lists it once it has started, in its pane. */
const listed = (sessionId: string, cwd: string, pane: string): Session => ({
  sessionId,
  name: "x",
  givenName: "",
  title: "",
  nameSetBy: "claude",
  cwd,
  kind: "interactive",
  status: "idle",
  lastActiveAt: 1,
  desktop: false,
  place: { via: "tmux", id: pane, keys: true, pid: 4242 },
  mapping: "process",
});

/** A Dictated whose clock the test moves. */
function setUp() {
  const clock = { now: 1_000_000 };
  return { clock, dictated: new Dictated(() => clock.now) };
}

describe("a prompt a session took in, against what the app typed into it", () => {
  test("typed by the app: yes, once; the same words again (typed by hand right after): no", () => {
    const { dictated } = setUp();
    dictated.note("s-1", "Open it in high term.");
    assert.equal(dictated.take(["s-1"], "Open it in high term."), true);
    assert.equal(dictated.take(["s-1"], "Open it in high term."), false, "each typed message counts once");
  });

  test("typed by hand: no, whatever was typed by the app before or into another session", () => {
    const { dictated } = setUp();
    assert.equal(dictated.take(["s-1"], "Run the tests."), false, "nothing typed by the app");
    dictated.note("s-1", "Use the desk microphone.");
    assert.equal(dictated.take(["s-1"], "Run the tests."), false, "other words");
    assert.equal(dictated.take(["s-1"], "Use the desk microphone. And run the tests."), false, "more than the app typed");
    assert.equal(dictated.take(["s-1"], "the desk microphone"), false, "less than the app typed");
    assert.equal(dictated.take(["s-2"], "Use the desk microphone."), false, "another session");
    // None of those used it up: its own prompt is still the app's.
    assert.equal(dictated.take(["s-1"], "Use the desk microphone."), true);
  });

  test("any ID the session goes by", () => {
    const { dictated } = setUp();
    dictated.note("s-1", "Half of the month.");
    assert.equal(dictated.take(["s-other", "s-1"], "Half of the month."), true);
  });

  test("whitespace as a terminal changes it: line breaks and tabs as spaces, runs of them as one, none at the ends", () => {
    const { dictated } = setUp();
    dictated.note("s-1", "Fix the login page.\n\nThen\trun   the tests. ");
    assert.equal(dictated.take(["s-1"], "Fix the login page. Then run the tests."), true);
    dictated.note("s-1", "Commit it.");
    assert.equal(dictated.take(["s-1"], "  Commit it.\n"), true);
    dictated.note("s-1", "Commit it.");
    assert.equal(dictated.take(["s-1"], "Commit  it"), false, "but not other words: the full stop is missing");
  });

  test("a long message comes back between Claude Code's paste lines: still the app's", () => {
    const { dictated } = setUp();
    const long = "So the thing I want is ".repeat(40).trim();
    dictated.note("s-1", long);
    assert.equal(dictated.take(["s-1"], `\n\n<pasted_content id="7169">\n${long}\n</pasted_content id="7169">\n`), true);
    assert.equal(promptKey(`<pasted_content id="1">\nhello\n</pasted_content id="1">`), "hello");
    assert.equal(promptKey("a <pasted_content> tag in the middle of a line"), "a <pasted_content> tag in the middle of a line", "only whole lines of its own");
    // As it's shown (core/history.ts yourWords): what was pasted where it was, a paragraph of its own, its own line breaks kept.
    assert.equal(unpasted(`Two things:\n\n\n<pasted_content id="ec41">\n  one\n\ntwo\n</pasted_content id="ec41">\n\n\nWhich first?`), "Two things:\n\n  one\n\ntwo\n\nWhich first?");
    assert.equal(unpasted(`\n\n<pasted_content id="1">\nfirst\n</pasted_content id="1">\n\n\n\n<pasted_content id="2">\nsecond\n</pasted_content id="2">\n`), "first\n\nsecond");
    assert.equal(unpasted("  No paste here.\n"), "No paste here.");
  });

  test("only within a moment of the typing", () => {
    const { clock, dictated } = setUp();
    dictated.note("s-1", "Yes.");
    clock.now += DICTATED_WITHIN_MS - 1;
    assert.equal(dictated.take(["s-1"], "Yes."), true);
    dictated.note("s-1", "Yes.");
    clock.now += DICTATED_WITHIN_MS;
    assert.equal(dictated.take(["s-1"], "Yes."), false, "typed by hand a minute later: yours");
  });

  test("the same words dictated twice: each typing counts for one prompt", () => {
    const { dictated } = setUp();
    dictated.note("s-1", "Yes.");
    dictated.note("s-1", "Yes.");
    assert.deepEqual([dictated.take(["s-1"], "Yes."), dictated.take(["s-1"], "Yes."), dictated.take(["s-1"], "Yes.")], [true, true, false]);
  });

  test("typing that didn't go in is dropped: the same words typed by hand next aren't the app's", () => {
    const { dictated } = setUp();
    dictated.note("s-1", "Deploy it.");
    dictated.drop("s-1", "Deploy it.");
    assert.equal(dictated.take(["s-1"], "Deploy it."), false);
    // Only that one: an earlier typing of the same words that did go in still counts.
    dictated.note("s-1", "Deploy it.");
    dictated.note("s-1", "Deploy it.");
    dictated.drop("s-1", "Deploy it.");
    assert.deepEqual([dictated.take(["s-1"], "Deploy it."), dictated.take(["s-1"], "Deploy it.")], [true, false]);
  });

  test("several typed while it was busy, taken in as one prompt: only when all of it is them, in order", () => {
    const { dictated } = setUp();
    dictated.note("s-1", "Commit.");
    dictated.note("s-1", "And push.");
    assert.equal(dictated.take(["s-1"], "typed by hand\nCommit.\nAnd push."), false, "something of yours among them");
    assert.equal(dictated.take(["s-1"], "And push.\nCommit."), false, "not the order they were typed in");
    assert.equal(dictated.take(["s-1"], "Commit.\nAnd push."), true);
    assert.equal(dictated.take(["s-1"], "Commit."), false, "both used");
    assert.equal(dictated.take(["s-1"], "And push."), false);
  });

  test("nothing at all isn't a prompt", () => {
    const { dictated } = setUp();
    dictated.note("s-1", "  ");
    assert.equal(dictated.take(["s-1"], ""), false);
    assert.equal(dictated.take(["s-1"], " \n"), false);
  });
});

// Words a session can't take in yet: typed while it's busy (Claude Code queues them, and takes the
// ones still queued at the turn's end in as a prompt of their own, often minutes later), or a new
// session's first message, given on its command line and taken in once it has started.
describe("words a session takes in later", () => {
  test("typed while it was busy: still the app's when its turn ends minutes later, until DICTATED_QUEUED_MS", () => {
    const { clock, dictated } = setUp();
    dictated.note("s-1", "Then run the linter.", DICTATED_QUEUED_MS);
    clock.now += 5 * 60_000;
    assert.equal(dictated.take(["s-1"], "Then run the linter."), true, "taken in once its turn was over");
    dictated.note("s-1", "Then run the linter.", DICTATED_QUEUED_MS);
    clock.now += DICTATED_QUEUED_MS;
    assert.equal(dictated.take(["s-1"], "Then run the linter."), false);
    // Typed while it was at its prompt: the minute as ever.
    dictated.note("s-1", "Commit it.");
    clock.now += 5 * 60_000;
    assert.equal(dictated.take(["s-1"], "Commit it."), false);
  });

  test("taken in as the turn went (no prompt hook for those): let go once the turn ends; those still queued are kept", () => {
    const { dictated } = setUp();
    dictated.note("s-1", "Use the desk microphone.", DICTATED_QUEUED_MS);
    dictated.note("s-1", "And commit.", DICTATED_QUEUED_MS);
    dictated.reached(["s-other", "s-1"], () => ["Fix the mic picker.", "Use the desk\nmicrophone."]);
    assert.equal(dictated.take(["s-1"], "Use the desk microphone."), false, "typed by hand later: yours");
    assert.equal(dictated.take(["s-1"], "And commit."), true, "still queued at the turn's end, taken in after it");
  });

  test("its record is read only when something is noted for the session", () => {
    const { dictated } = setUp();
    let read = 0;
    dictated.reached(["s-1"], () => (read++, []));
    dictated.note("s-2", "Yes.");
    dictated.reached(["s-1"], () => (read++, []));
    assert.equal(read, 0);
    dictated.note("s-1", "Yes.");
    dictated.reached(["s-1"], () => (read++, null));
    assert.equal(read, 1);
    assert.equal(dictated.take(["s-1"], "Yes."), true, "nothing read: nothing let go");
  });

  test("a new session's first message: noted under its starting ID, found for the real one once matched or before", () => {
    const { clock, dictated } = setUp();
    const starting = new StartingSessions(() => clock.now);
    const entry = starting.add({ cwd: "/Users/me/pixie", name: "", prompt: "Fix the login.", via: "tmux", handle: "%3", known: ["old-1"] });
    const other = starting.add({ cwd: "/Users/me/maple", name: "", via: "tmux", handle: "%4", known: [] });
    dictated.note(entry.id, "Fix the login.", DICTATED_QUEUED_MS);
    // Its trust question waited for you a while; then it started and took its first message in.
    clock.now += 4 * 60_000;
    // Before any listing has it (its prompt came moments after its SessionStart): every one still starting.
    assert.deepEqual(starting.startedAs("real-1", false), [entry.id, other.id]);
    assert.equal(dictated.take(["real-1", ...starting.startedAs("real-1", false)], "Fix the login."), true);
    assert.equal(dictated.take(["real-1", ...starting.startedAs("real-1", false)], "Fix the login."), false, "once");
    // Typed by hand into a session that's listed: never one still starting.
    dictated.note(entry.id, "Fix the login.", DICTATED_QUEUED_MS);
    assert.deepEqual(starting.startedAs("old-1", true), []);
    // Matched: the ID it had, and only that.
    const [m] = starting.match([listed("real-1", "/Users/me/pixie", "%3")]);
    assert.equal(m.entry.id, entry.id);
    assert.deepEqual(starting.startedAs("real-1", true), [entry.id]);
    assert.equal(dictated.take(["real-1", ...starting.startedAs("real-1", true)], "Fix the login."), true);
  });
});

describe("the wording, in one place (hooks/lib.mjs)", () => {
  test("the reply's line and the prompt's say the same of speech-to-text, and are told apart", () => {
    const shared = "speech-to-text, so expect small transcription errors";
    assert.equal(VOICE_REPLY, `The user replied by voice (${shared}): `);
    assert.equal(VOICE_PROMPT, `The user dictated this message by voice (${shared}).`);
    // History takes a reply for your words by this start (src/core/history.ts): the prompt's line must never have it.
    assert.equal(VOICE_PROMPT.includes(VOICE_REPLY), false);
  });
});
