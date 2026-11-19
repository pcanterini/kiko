// A test message from the phone, to the Kiko session (a background process, the terminal's ID
// kept as an alias). The router said pass_on, the trim left out its routing words, and the words
// were never sent: a second press came 0.2s before the decision did, and app.ts dropped what the router
// had decided, logging nothing. The decision itself was right (below); the pieces that now keep your
// words in order are your words in line (in-line.ts) and the presses the floor counts (floor.ts
// wordsAfter). The harness (tests/harness, pressedAgainCases and phoneCases) runs it end to end.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decide, type DecideDeps, type DecideState } from "../../../src/core/decide.ts";
import { Floor, type Waiter } from "../../../src/core/floor.ts";
import { InLine } from "../../../src/core/in-line.ts";
import { findSession, namesSession, type Session } from "../../../src/core/sessions.ts";
import { isTrimOf, removeParts } from "../../../src/core/trim.ts";
import { CAST, makeSession } from "../../support/fixtures.ts";

const SAID = "One more test to Kiko, just checking that the phone gets through. The Mac showed the Kiko session twice in the list for a moment, but the phone looks fine from here.";
const KEPT = "Just checking that the phone gets through. The Mac showed the Kiko session twice in the list for a moment, but the phone looks fine from here.";

// As listed then: Lacy, and Kiko under its background process's ID, the terminal's as an alias.
const LACY = makeSession(CAST.lacy);
const FRONT = makeSession({ name: "claude-code-speech", given: "Kiko", title: "Notes file cleanup", status: "idle", activeAgoS: 43 });
const KIKO: Session = { ...FRONT, sessionId: "b5d81f3a-2e7c-4a19-8d64-0f3b7e9c2a58", aliases: ["7c2e9a41-0000-4000-8000-000000000000"] };
const SESSIONS = [LACY, KIKO];

describe("the incident: the decision", () => {
  test("'…to Kiko, …' mid-sentence: the trim's part names Kiko, and what's left is a trim of the words", () => {
    assert.ok(namesSession(SESSIONS, "One more test to Kiko"));
    const cut = removeParts(SAID, ["One more test to Kiko"]);
    assert.deepEqual(cut, { text: KEPT, dropped: ["One more test to Kiko"] });
    assert.ok(isTrimOf(SAID, KEPT));
  });

  test("pass_on to the merged session, trimmed: one send to its process's ID, with the kept words", async () => {
    const deps: DecideDeps = {
      utterance: async () => ({
        audience: "app",
        audienceConfidence: 0.28,
        intent: "message",
        intentConfidence: 0.6,
        appParts: 0.52,
        model: "test",
        costUsd: 0,
        ms: 1,
      }),
      approval: null,
      route: async () => ({ text: "", actions: [{ name: "pass_on", session: KIKO }], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 }),
      // As trimForClaude checks Haiku's answer then ("One more test to Kiko").
      trim: async ({ text, to, sessions }) => {
        assert.equal(to.sessionId, KIKO.sessionId);
        const parts = ["One more test to Kiko"].filter((p) => namesSession(sessions, p));
        const cut = removeParts(text, parts);
        assert.ok(cut && isTrimOf(text, cut.text));
        return { ...cut, costUsd: 0, ms: 766 };
      },
    };
    const state: DecideState = {
      text: SAID,
      sessions: SESSIONS,
      notes: new Map(),
      recent: [],
      waiting: null,
      justSpoke: null,
      lastId: null,
      appAsked: false,
      lastSent: null,
      lastRepeat: false,
      voiceCan: "everything",
      classifierMinConfidence: 0.75,
    };
    const d = await decide(state, deps);
    assert.ok(d.router, "the router decided");
    assert.deepEqual(d.actions, [
      {
        type: "send",
        session: { sessionId: KIKO.sessionId, cwd: KIKO.cwd },
        text: KEPT,
        trimmed: { kept: KEPT, dropped: ["One more test to Kiko"], by: "model", ms: 766 },
        // Sure: the words name Kiko. Only the second press made the app hold it (holdIf: words after).
      },
    ]);
    // Wherever the app looks it up, by the process's ID or the terminal's.
    assert.equal(findSession(SESSIONS, KIKO.sessionId), KIKO);
    assert.equal(findSession(SESSIONS, KIKO.aliases![0]), KIKO);
  });
});

describe("your words in line (in-line.ts)", () => {
  test("the second words wait for the first to be on their way, whatever finishes first", async () => {
    const line = new InLine();
    const order: string[] = [];
    const seen = () => [...order];
    const first = await line.enter();
    const second = line.enter().then((t) => (order.push("second decided"), t));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen(), [], "not while the first is decided");
    order.push("first sent");
    first.done();
    const t = await second;
    assert.deepEqual(seen(), ["first sent", "second decided"]);
    assert.equal(t.late, false);
    t.done();
  });

  test("done more than once is done once; a third waits for the second", async () => {
    const line = new InLine();
    const a = await line.enter();
    const b = line.enter();
    const c = line.enter();
    let cIn = false;
    void c.then(() => (cIn = true));
    a.done();
    a.done();
    const bt = await b;
    await new Promise((r) => setImmediate(r));
    assert.equal(cIn, false, "the third waits for the second, not the first");
    bt.done();
    (await c).done();
    assert.equal(cIn, true);
  });

  test("one that never lets go holds the next only so long: then it goes, marked late", async () => {
    const line = new InLine(30);
    await line.enter(); // never done
    const t = await line.enter();
    assert.equal(t.late, true);
    assert.ok(t.waitedMs >= 25, `waited ${t.waitedMs}ms`);
  });
});

describe("words after a press's (floor.ts wordsAfter)", () => {
  type Req = Waiter;
  const floor = () =>
    new Floor<Req>({
      windows: () => ({ reply: 1500, fyi: 600, permission: 1000 }),
      quietNeedsUser: 0.5,
      giveWayMs: 200,
      unheardMs: 150,
      audio: { busy: () => false, quiet: () => Promise.resolve() },
      whyClosed: () => "",
      make: () => {},
      cut: () => {},
      stopTalking: () => {},
      info: () => {},
      log: () => {},
      changed: () => {},
    });

  test("each press is numbered, and key up hands its number to what hears it", async () => {
    const f = floor();
    const heard: number[] = [];
    for (let i = 0; i < 2; i++) {
      f.keyDown();
      await f.keyUp(async (press) => (heard.push(press), false));
    }
    assert.deepEqual(heard, [1, 2]);
  });

  test("the key down again, or a later press's words not yet dealt with: words come after; then they don't", async () => {
    const f = floor();
    const seen: boolean[] = [];
    let release!: () => void;
    const later = new Promise<void>((resolve) => (release = resolve));
    let second: Promise<boolean> | null = null;
    f.keyDown();
    await f.keyUp(async (first) => {
      seen.push(f.wordsAfter(first)); // nothing after yet
      f.keyDown();
      seen.push(f.wordsAfter(first)); // pressed again (the phone's second press)
      second = f.keyUp(async (p) => {
        seen.push(f.wordsAfter(first), f.wordsAfter(p)); // its words being dealt with; none after them
        await later;
        return true;
      });
      release();
      await second;
      seen.push(f.wordsAfter(first)); // dealt with
      return true;
    });
    assert.deepEqual(seen, [false, true, true, false, false]);
  });

  test("an earlier press's words still being dealt with aren't after a later one's", async () => {
    const f = floor();
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    f.keyDown();
    const first = f.keyUp(async () => (await slow, true));
    f.keyDown();
    let after: boolean | null = null;
    await f.keyUp(async (press) => ((after = f.wordsAfter(press)), true));
    assert.equal(after, false);
    release();
    await first;
  });
});
