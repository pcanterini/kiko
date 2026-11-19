// Who has the floor (src/core/floor.ts): the announcement queue, the reply window and your presses, on a
// fake clock. The same windows as the faked-app harness (tests/harness): 1.5s to reply, 0.6s when
// only reporting, a permission prompt's 1s, giving way 0.2s after a reading, a press in the first
// 0.15s of sound still putting an announcement back. The harness runs the same cases through the
// whole app, in real time.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Floor, type Unheard, type Waiter } from "../../../src/core/floor.ts";
import { FakeClock } from "../../support/clock.ts";

class Req implements Waiter {
  readonly sessionId: string;
  readonly isPermission: boolean;
  settled = false;
  constructor(id: string, permission = false) {
    this.sessionId = id;
    this.isPermission = permission;
  }
  get open() {
    return !this.settled;
  }
  release() {
    if (this.settled) return false;
    this.settled = true;
    return true;
  }
}
const stop = (id: string) => new Req(id);
const ask = (id: string) => new Req(id, true);

/** A floor on a fake clock, with what it asked for: announcements made, lines shown, logs, cuts. */
function setup(o: { stand?: (request: Req) => boolean } = {}) {
  const clock = new FakeClock();
  const made: Req[] = [];
  const unheard = new Map<Req, Unheard<Req>>();
  const undone: string[] = [];
  const info: string[] = [];
  const logs: Array<{ event: string } & Record<string, unknown>> = [];
  const cut: Req[] = [];
  let stops = 0;
  // What's being said, or waits its turn to be (audio-queue.ts): busy until quiet() is let go.
  let busy = false;
  let quiet: Array<() => void> = [];
  const floor: Floor<Req> = new Floor<Req>({
    windows: () => ({ reply: 1500, fyi: 600, permission: 1000 }),
    quietNeedsUser: 0.5,
    giveWayMs: 200,
    unheardMs: 150,
    audio: {
      busy: () => busy,
      quiet: () => (busy ? new Promise<void>((resolve) => quiet.push(resolve)) : Promise.resolve()),
    },
    whyClosed: (request, reach) => (request.isPermission ? "no answer" : `no reply (${reach})`),
    // As app.ts's announce() and askPermission() start: a new turn, tracked until it's heard.
    make: (request) => {
      made.push(request);
      unheard.set(
        request,
        floor.announcing(request, () => undone.push(request.sessionId)),
      );
    },
    cut: (u) => cut.push(u.request),
    stopTalking: () => stops++,
    info: (text) => info.push(text),
    log: (event, fields) => logs.push({ event, ...fields }),
    changed: () => {},
    ...(o.stand ? { stand: o.stand } : {}),
    clock,
  });
  return {
    floor,
    clock,
    made,
    unheard,
    undone,
    info,
    logs,
    cut,
    stops: () => stops,
    setBusy(b: boolean) {
      busy = b;
      if (!b) for (const resolve of quiet.splice(0)) resolve();
    },
    /** The classifier's read, then the reading: it makes a sound, and `ms` later it's over. */
    readOut(request: Req, needsUser: number | null = 0.8, ms = 50) {
      floor.judged(request, "terminal", needsUser);
      floor.playing();
      clock.advance(ms);
      floor.idle();
    },
    /** A press with nothing said, or with words dealt with in `ms`. */
    async talk(dealt = false, ms = 0) {
      floor.keyDown();
      return floor.keyUp(async () => {
        clock.advance(ms);
        return dealt;
      });
    },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const ids = (q: Req[]) => q.map((r) => r.sessionId);

describe("the queue", () => {
  test("a finished session is announced at once when nothing else is going on", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    assert.deepEqual(f.made, [a]);
    assert.equal(f.floor.current, a);
    assert.equal(f.floor.waiting, a);
  });

  test("not while you talk, or while your words are dealt with: after", async () => {
    const f = setup();
    f.floor.keyDown();
    const a = stop("a");
    f.floor.add(a);
    assert.deepEqual(f.made, []);
    let during: Req[] = [];
    await f.floor.keyUp(async () => {
      f.floor.add(stop("b"));
      during = [...f.made];
      return true;
    });
    assert.deepEqual(during, [], "nothing while your words were dealt with");
    assert.deepEqual(ids(f.made), ["a"]);
    assert.deepEqual(ids(f.floor.queue), ["b"]);
  });

  test("not while the app speaks: once it's quiet", () => {
    const f = setup();
    f.floor.playing();
    f.floor.add(stop("a"));
    assert.deepEqual(f.made, []);
    f.floor.idle();
    assert.deepEqual(ids(f.made), ["a"]);
  });

  test("one after another: the next once the one waiting is let go", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.floor.add(stop("b"));
    assert.deepEqual(ids(f.made), ["a"]);
    f.floor.release(a, "done");
    assert.deepEqual(f.info, ["(done)"]);
    f.floor.drain();
    assert.deepEqual(ids(f.made), ["a", "b"]);
  });

  test("a finished turn whose hook went away while in line is still read out; a permission prompt's isn't asked", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    const b = stop("b");
    f.floor.add(b);
    const p = ask("p");
    f.floor.playing(); // a is being read out: p waits in line
    f.floor.add(p);
    f.floor.add(stop("c"));
    b.settled = true;
    p.settled = true; // answered in the terminal
    f.floor.idle();
    f.floor.release(a, "done");
    f.floor.drain();
    assert.deepEqual(ids(f.made), ["a", "b"]);
    assert.deepEqual(
      f.logs.filter((l) => l.event === "announce_dropped").map((l) => [l.sessionId, l.reason]),
      [["p", "hook_closed"]],
    );
  });

  test("permission prompts go ahead of finished turns", () => {
    const f = setup();
    f.floor.add(stop("a"));
    f.floor.playing(); // being read out: nothing takes over
    f.floor.add(stop("b"));
    f.floor.add(ask("p"));
    assert.deepEqual(ids(f.floor.queue), ["p", "b"]);
  });

  test("what it holds of a session: its finished turn, announced or not", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.floor.playing();
    const b = stop("b");
    f.floor.add(b);
    f.floor.add(ask("p"));
    assert.equal(f.floor.heldStop("a"), a);
    assert.equal(f.floor.heldStop("b"), b);
    assert.equal(f.floor.heldStop("p"), null, "a permission prompt isn't a finished turn");
    assert.ok(f.floor.holds("p"));
    assert.ok(!f.floor.holds("x"));
  });
});

describe("the reply window", () => {
  test("starts once the reading is over, and lets the session go when it runs out", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.floor.judged(a, "desktop", 0.8);
    f.floor.playing();
    f.clock.advance(1000);
    assert.equal(f.floor.until, null, "not while it's said");
    f.floor.idle();
    assert.equal(f.floor.until, 2500);
    f.clock.advance(1499);
    assert.ok(a.open);
    f.clock.advance(1);
    assert.ok(!a.open);
    assert.deepEqual(f.info, ["(no reply (desktop))"]);
    assert.equal(f.floor.current, null);
    assert.equal(f.floor.until, null);
  });

  test("only reporting (needs you below 0.5): the short window; no classifier: the full one", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    assert.equal(f.floor.judged(a, "terminal", 0.04), 600);
    f.floor.playing();
    f.floor.idle();
    assert.equal(f.floor.until, 600);
    f.clock.advance(600);
    assert.ok(!a.open);
    const b = stop("b");
    f.floor.add(b);
    assert.equal(f.floor.judged(b, "terminal", null), 1500);
  });

  test("the classifier's read of one that's no longer waiting changes nothing, though its length is still given", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.floor.release(a, "gone");
    const b = stop("b");
    f.floor.add(b);
    assert.equal(f.floor.judged(a, "terminal", 0.04), 600);
    f.floor.playing();
    f.floor.idle();
    assert.equal(f.floor.until, 1500, "b keeps its own window");
  });

  test("a speech still in line holds it; it starts once everything has been heard, once", async () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.floor.judged(a, "terminal", 0.8);
    f.setBusy(true);
    f.floor.startReplyTimer();
    f.floor.startReplyTimer(); // asked again meanwhile: still one wait
    assert.equal(f.floor.until, null);
    f.clock.advance(400);
    f.setBusy(false);
    await flush();
    assert.equal(f.floor.until, 1900);
    assert.equal(f.clock.pending(), 1);
  });

  test("the app speaking again stops it; quiet again, it starts over", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.readOut(a);
    f.clock.advance(1000);
    f.floor.playing(); // "repeat that", say
    assert.equal(f.floor.until, null);
    f.clock.advance(2000);
    assert.ok(a.open);
    f.floor.idle();
    assert.equal(f.floor.until, f.clock.now() + 1500);
  });

  test("a press stops it; with nothing in line, key up starts it over at full length", async () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.readOut(a);
    f.clock.advance(1400);
    f.floor.keyDown();
    assert.equal(f.floor.until, null);
    f.clock.advance(3000);
    assert.ok(a.open, "kept while the key is down");
    await f.floor.keyUp(async () => true);
    assert.equal(f.floor.until, f.clock.now() + 1500);
  });

  test('not while your words are dealt with: a quiet moment then (after "To Lacy.") waits for key up', async () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.readOut(a);
    f.floor.keyDown();
    let during: number | null = 0;
    await f.floor.keyUp(async () => {
      // The app says where your words go, and goes quiet while it decides the rest.
      f.floor.playing();
      f.clock.advance(300);
      f.floor.idle();
      during = f.floor.until;
      f.clock.advance(3000); // longer than the window: deciding takes a while
      return true;
    });
    assert.equal(during, null, "not started while replying");
    assert.ok(a.open, "not let go while your words were dealt with");
    assert.equal(f.floor.until, f.clock.now() + 1500, "key up starts it");
  });

  test("a permission prompt gets its own window", () => {
    const f = setup();
    const p = ask("p");
    f.floor.add(p);
    f.floor.startReplyTimer();
    assert.equal(f.floor.until, 1000);
    f.clock.advance(1000);
    assert.ok(!p.open);
    assert.deepEqual(f.info, ["(no answer)"]);
  });

  test("let go when answered: the window stops, and the next is announced", () => {
    const f = setup();
    const p = ask("p");
    f.floor.add(p);
    f.floor.add(stop("b"));
    f.floor.startReplyTimer();
    f.floor.drop(p);
    f.floor.clearReplyTimer();
    f.floor.drain();
    assert.deepEqual(ids(f.made), ["p", "b"]);
    assert.equal(f.clock.pending(), 0);
  });

  test("answered through its hook: its window goes with it, and never lets the next one go", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.readOut(a);
    f.floor.drop(a);
    assert.equal(f.floor.until, null);
    const b = stop("b");
    f.floor.add(b); // announced, its window not started yet
    f.clock.advance(5000);
    assert.ok(b.open, "a's window ran out after it was answered");
    assert.deepEqual(f.info, []);
  });
});

describe("cut short when another session is in line (makeRoom)", () => {
  test("one that only reported something gives way as the next comes in", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.readOut(a, 0.04);
    f.clock.advance(300);
    const b = stop("b");
    f.floor.add(b);
    f.clock.advance(0);
    assert.ok(!a.open);
    assert.deepEqual(f.info, ["(no reply (terminal))"]);
    assert.deepEqual(ids(f.made), ["a", "b"]);
    assert.deepEqual(f.logs, [{ event: "window_cut", sessionId: "a", needsUser: 0.04, answered: false, leftMs: 0 }]);
  });

  test("one that asked you something keeps the short window, counted from its own start", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.readOut(a, 0.8);
    f.clock.advance(300);
    f.floor.add(stop("b"));
    assert.equal(f.floor.until, f.clock.now() + 300);
    f.clock.advance(299);
    assert.ok(a.open);
    f.clock.advance(1);
    assert.ok(!a.open);
    assert.equal(f.made.length, 2);
    assert.equal(f.logs[0].leftMs, 300);
  });

  test("asked, and past the short window already: let go at once", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.readOut(a, 0.8);
    f.clock.advance(900);
    f.floor.add(stop("b"));
    f.clock.advance(0);
    assert.ok(!a.open);
  });

  test("no read from the classifier counts as asked", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.readOut(a, null);
    f.clock.advance(100);
    f.floor.add(stop("b"));
    assert.equal(f.floor.until, f.clock.now() + 500);
  });

  test("only reporting, with the next already in line when its reading ends: gives way 0.2s after", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.floor.judged(a, "terminal", 0.04);
    f.floor.playing();
    f.clock.advance(150);
    f.floor.add(stop("b")); // while it's read out
    assert.ok(a.open);
    f.clock.advance(150);
    f.floor.idle();
    assert.equal(f.floor.until, f.clock.now() + 200);
    f.clock.advance(200);
    assert.ok(!a.open);
    assert.deepEqual(ids(f.made), ["a", "b"]);
  });

  test("not while you hold the key: on key up its window starts over, capped at the short one", async () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.readOut(a, 0.8);
    f.clock.advance(100);
    f.floor.keyDown();
    f.floor.add(stop("b"));
    f.clock.advance(800);
    assert.ok(a.open, "still waiting while the key is held");
    await f.floor.keyUp(async () => false);
    assert.equal(f.floor.until, f.clock.now() + 600);
    f.clock.advance(600);
    assert.ok(!a.open);
  });

  test("never a permission prompt's", () => {
    const f = setup();
    const p = ask("p");
    f.floor.add(p);
    f.floor.startReplyTimer();
    f.floor.add(stop("b"));
    assert.equal(f.floor.until, 1000);
    assert.deepEqual(f.logs, []);
  });

  test("answered, with one in line: moves on once the app's answer is heard", async () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.readOut(a, 0.8);
    f.floor.spokeLast = { sessionId: "a", at: f.clock.now() };
    f.floor.keyDown();
    f.floor.add(stop("b"));
    await f.floor.keyUp(async () => {
      f.clock.advance(500); // dealt with, and the app answers
      f.floor.playing();
      return true;
    });
    assert.ok(a.open, "not while the answer is said");
    f.clock.advance(400);
    f.floor.idle();
    f.clock.advance(0);
    assert.ok(!a.open);
    assert.deepEqual(f.logs.at(-1), { event: "window_cut", sessionId: "a", needsUser: 0.8, answered: true, leftMs: 0 });
    // Words a moment late still go to it: it "just spoke" as of now.
    assert.deepEqual(f.floor.spokeLast, { sessionId: "a", at: f.clock.now() });
    assert.deepEqual(ids(f.made), ["a", "b"]);
  });

  test("answered, with nothing in line: its window starts over, and a later arrival cuts it as usual", async () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.readOut(a, 0.8);
    await f.talk(true);
    assert.equal(f.floor.until, f.clock.now() + 1500);
    f.clock.advance(300);
    f.floor.add(stop("b"));
    assert.equal(f.floor.until, f.clock.now() + 300, "the short window from its restart, not at once");
  });

  test("nothing said: not answered, so not let go at once", async () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.readOut(a, 0.8);
    f.floor.keyDown();
    f.floor.add(stop("b"));
    await f.floor.keyUp(async () => false);
    assert.equal(f.floor.until, f.clock.now() + 600);
  });
});

describe("a press before the announcement was heard (deferUnheard)", () => {
  test("before it made a sound: put back first in line, still open, and made again on key up", async () => {
    const f = setup();
    const before = { sessionId: "x", at: 0 }; // read out before it
    f.floor.spokeLast = before;
    const y = stop("y");
    f.floor.add(y);
    f.floor.add(stop("z"));
    f.floor.spokeLast = null; // announce() clears it as it starts
    f.clock.advance(80);
    f.floor.keyDown();
    assert.ok(y.open);
    assert.equal(f.floor.current, null);
    assert.deepEqual(ids(f.floor.queue), ["y", "z"]);
    assert.deepEqual(f.undone, ["y"]);
    assert.equal(f.floor.spokeLast, before, "as it was before");
    assert.ok(f.unheard.get(y)!.deferred);
    assert.deepEqual(f.logs, [{ event: "announce_deferred", sessionId: "y", kind: "stop", reason: "press", afterMs: 80, afterSoundMs: null }]);
    await f.floor.keyUp(async () => false);
    assert.deepEqual(ids(f.made), ["y", "y"]);
  });

  test("in its first moments of sound: put back too", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.clock.advance(300);
    f.floor.playing();
    f.clock.advance(100);
    f.floor.keyDown();
    assert.deepEqual(ids(f.floor.queue), ["a"]);
    assert.equal(f.logs[0].afterSoundMs, 100);
    assert.equal(f.logs[0].afterMs, 400);
  });

  // A line of the app's ("I can't tell which terminal is
  // Lacy…") played just as the Kiko project's announcement started, and counted as its sound.
  test("a line of the app's playing ahead of it isn't its sound: a press during that line puts it back", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.floor.playing(false); // the line's sound (app.ts announce: not yet its own)
    f.clock.advance(2000);
    f.floor.keyDown();
    assert.equal(f.floor.current, null);
    assert.deepEqual(ids(f.floor.queue), ["a"]);
    assert.equal(f.logs[0].afterSoundMs, null);
  });

  test("past them: a barge-in, and your words answer it", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.floor.playing();
    f.clock.advance(150);
    f.floor.keyDown();
    assert.equal(f.floor.current, a);
    assert.deepEqual(f.floor.queue, []);
    assert.deepEqual(f.logs, []);
  });

  test("once it's over, even a moment after its first sound: heard", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.floor.playing();
    f.clock.advance(50);
    f.floor.idle();
    f.floor.keyDown();
    assert.equal(f.floor.current, a);
  });

  test("still in line to be said (audio busy) counts as playing", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.floor.playing();
    f.clock.advance(50);
    f.floor.idle();
    f.setBusy(true); // the idle was between two chunks
    f.floor.keyDown();
    assert.equal(f.floor.current, null);
  });

  test("a sound from an older turn isn't its first", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.floor.bump(); // a voice preview, say
    f.floor.playing();
    f.clock.advance(1000);
    assert.equal(f.unheard.get(a)!.soundAt, null);
  });

  test("nothing more to hear from it (quiet, no words, muted): a press is a reply", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.floor.forget(f.unheard.get(a)!);
    f.floor.keyDown();
    assert.equal(f.floor.current, a);
  });

  test("put back, then its hook went away: still read out on key up, with no window after", async () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.floor.keyDown();
    a.settled = true;
    f.floor.closed(a, "(a stopped waiting)");
    await f.floor.keyUp(async () => false);
    assert.deepEqual(ids(f.made), ["a", "a"]);
    f.readOut(a);
    assert.equal(f.floor.current, null);
    assert.equal(f.floor.until, null);
    assert.equal(f.clock.pending(), 0);
  });

  test("each press is a new turn, and stops the window", () => {
    const f = setup();
    const t = f.floor.turn;
    assert.ok(f.floor.keyDown());
    assert.ok(!f.floor.keyDown(), "already down");
    assert.equal(f.floor.turn, t + 1);
    assert.equal(f.floor.pressedAt, 0);
  });
});

describe("speech to text failed on key up", () => {
  test("the window starts over and the next is announced all the same", async () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.readOut(a);
    f.floor.keyDown();
    f.floor.add(stop("b"));
    let then = 0;
    const up = await f.floor.keyUp(
      async () => {
        throw new Error("stt down");
      },
      () => then++,
    );
    assert.equal(up, true);
    assert.equal(f.floor.replying, 0);
    assert.equal(then, 1, "what follows key up ran");
    assert.deepEqual(f.logs.at(0), { event: "error", where: "hear", message: "stt down" });
    assert.deepEqual(f.info, ["(couldn't hear that: stt down)"]);
    assert.equal(f.floor.until, f.clock.now() + 600, "a's window started over, cut short for b");
    f.clock.advance(600);
    assert.deepEqual(ids(f.made), ["a", "b"]);
  });

  test("with nothing waiting: the one that came in meanwhile is announced", async () => {
    const f = setup();
    f.floor.keyDown();
    f.floor.add(stop("a"));
    await f.floor.keyUp(async () => {
      throw new Error("stt down");
    });
    assert.deepEqual(ids(f.made), ["a"]);
  });
});

describe("permission prompts", () => {
  test("one that stands as its window runs out (app/standing.ts): off the floor, still held, and the next one is announced", () => {
    const stood: string[] = [];
    const f = setup({ stand: (r) => (r.sessionId === "p" ? (stood.push(r.sessionId), true) : false) });
    const p = ask("p");
    const q = ask("q");
    const b = stop("b");
    f.floor.add(p);
    f.floor.add(q);
    f.floor.add(b);
    f.floor.startReplyTimer();
    f.clock.advance(1000);
    assert.deepEqual(stood, ["p"], "asked whether it stands");
    assert.ok(p.open, "never let go: its hook stays held");
    assert.deepEqual(f.info, [], "the line is the app's to show");
    assert.ok(!f.floor.has(p), "off the floor");
    assert.deepEqual(ids(f.made), ["p", "q"], "the next one in line is asked");
    assert.equal(f.floor.current, q);
    // q doesn't stand: let go as before, and the finished turn is read out after it.
    f.floor.startReplyTimer();
    f.clock.advance(1000);
    assert.ok(!q.open);
    assert.deepEqual(f.info, ["(no answer)"]);
    assert.deepEqual(ids(f.made), ["p", "q", "b"]);
    assert.ok(p.open, "still held");
  });

  test("only a permission prompt still held is asked to stand; a finished turn's window lets it go as before", () => {
    let asked = 0;
    const f = setup({
      stand: () => {
        asked++;
        return true;
      },
    });
    const a = stop("a");
    f.floor.add(a);
    f.readOut(a);
    f.clock.advance(1500);
    assert.ok(!a.open);
    assert.equal(asked, 0);
  });

  test("take over from a finished turn waiting out its window", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.readOut(a);
    const p = ask("p");
    f.floor.add(p);
    assert.ok(!a.open);
    assert.deepEqual(f.info, ["(a permission prompt came in)"]);
    assert.deepEqual(ids(f.made), ["a", "p"]);
    assert.deepEqual(f.cut, []);
  });

  test("before the finished turn made a sound: asked first, the turn put back behind it, cut", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    const turn = f.floor.turn;
    const p = ask("p");
    f.floor.add(p);
    assert.ok(a.open);
    assert.deepEqual(f.cut, [a]);
    assert.equal(f.floor.turn, turn + 2, "a turn for the cut, and one for the prompt");
    assert.deepEqual(ids(f.made), ["a", "p"]);
    assert.deepEqual(ids(f.floor.queue), ["a"]);
    assert.equal(f.logs[0].reason, "permission");
    f.floor.drop(p);
    f.floor.drain();
    assert.deepEqual(ids(f.made), ["a", "p", "a"]);
  });

  test("the finished turn's window started before it made a sound: it doesn't let the prompt go", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.floor.judged(a, "terminal", 0.8);
    f.floor.startReplyTimer(); // announce() starts it as the speech is handed over, before any sound
    const p = ask("p");
    f.floor.add(p);
    assert.deepEqual(ids(f.floor.queue), ["a"]);
    assert.equal(f.floor.until, null, "a's window went back with it");
    f.clock.advance(1500);
    assert.ok(p.open, "not let go with a's window, or a's note");
    assert.deepEqual(f.info, []);
    f.floor.startReplyTimer(); // asked: its own window
    f.clock.advance(1000);
    assert.ok(!p.open);
    assert.deepEqual(f.info, ["(no answer)"]);
  });

  test("a window is its own session's: another waiting when it runs out isn't let go", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.readOut(a);
    // Whoever waits changed without the window being told (as drop() and a put-back once did).
    const p = ask("p");
    f.floor.current = p;
    f.clock.advance(1500);
    assert.ok(p.open);
    assert.deepEqual(f.info, []);
  });

  test("not once it made a sound, nor while you talk: it waits in line", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.floor.playing();
    f.floor.add(ask("p"));
    assert.ok(a.open);
    assert.equal(f.floor.current, a);
    f.floor.idle();
    f.floor.keyDown();
    f.floor.add(ask("q"));
    assert.ok(a.open);
    assert.deepEqual(ids(f.floor.queue), ["p", "q"]);
  });
});

describe("hooks that go away, and typing into a held session", () => {
  test("the one waiting went away: what's said stops, and the next is announced", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.floor.add(stop("b"));
    f.readOut(a);
    a.settled = true;
    f.floor.closed(a, "(a stopped waiting)");
    assert.equal(f.stops(), 1);
    assert.deepEqual(f.info, ["(a stopped waiting)"]);
    assert.deepEqual(ids(f.made), ["a", "b"]);
    assert.equal(f.clock.pending(), 0);
  });

  test("while you talk: nothing is cut", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.floor.keyDown();
    f.floor.closed(a, "(a stopped waiting)");
    assert.equal(f.stops(), 0);
  });

  test("one in line went away: still read out in its turn (its words are in its event), no window after", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    const b = stop("b");
    f.floor.add(b);
    b.settled = true;
    f.floor.closed(b, "(b stopped waiting)");
    assert.deepEqual(ids(f.floor.queue), ["b"]);
    assert.deepEqual(f.info, []);
    f.readOut(a);
    f.floor.release(a, "done");
    f.floor.drain();
    assert.deepEqual(ids(f.made), ["a", "b"]);
    assert.equal(f.floor.waiting, null, "nothing waits for a reply");
    f.readOut(b);
    assert.equal(f.floor.current, null);
    assert.equal(f.clock.pending(), 0);
  });

  test("the one being read out went away before you heard it: the reading goes on, then the next", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.floor.add(stop("b"));
    f.floor.playing();
    f.clock.advance(50); // in its first moments of sound
    a.settled = true;
    f.floor.closed(a, "(a stopped waiting)");
    assert.equal(f.stops(), 0, "not cut");
    assert.equal(f.floor.current, a);
    f.clock.advance(500);
    f.floor.idle();
    assert.deepEqual(ids(f.made), ["a", "b"]);
  });

  test("a permission prompt in line that went away: taken out, logged", () => {
    const f = setup();
    f.floor.add(stop("a"));
    f.floor.playing(); // being read out: p waits in line
    const p = ask("p");
    f.floor.add(p);
    f.floor.closed(p, "(p stopped waiting)");
    assert.deepEqual(f.floor.queue, []);
    assert.deepEqual(
      f.logs.filter((l) => l.event === "announce_dropped").map((l) => l.reason),
      ["hook_closed"],
    );
  });

  test("typed into one in line: let go, and it isn't announced (you were at its terminal); logged", () => {
    const f = setup();
    f.floor.add(stop("a"));
    const b = stop("b");
    f.floor.add(b);
    f.floor.typedIn(b, "you typed in b; let it go");
    assert.ok(!b.open);
    assert.deepEqual(f.floor.queue, []);
    assert.deepEqual(f.info, ["(you typed in b; let it go)"]);
    assert.equal(f.stops(), 0);
    assert.deepEqual(
      f.logs.filter((l) => l.event === "announce_dropped").map((l) => [l.sessionId, l.reason]),
      [["b", "typed_in"]],
    );
  });

  test("typed into the one being announced: cut, let go, and the next announced", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.floor.add(stop("b"));
    const turn = f.floor.turn;
    f.floor.typedIn(a, "you typed in a; let it go");
    assert.equal(f.stops(), 1);
    assert.equal(f.floor.turn, turn + 2, "the cut, then the next announcement");
    assert.ok(!a.open);
    assert.deepEqual(ids(f.made), ["a", "b"]);
  });

  test("typed into the one waiting out its window: let go, nothing cut", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.readOut(a);
    f.floor.spokeLast = { sessionId: "a", at: 0 };
    f.floor.typedIn(a, "you typed in a; let it go");
    assert.equal(f.stops(), 0);
    assert.ok(!a.open);
    assert.equal(f.floor.spokeLast, null);
  });
});

// You pressed to ask a second question, the
// session finished its answer to your first while you talked (queued), and your words went to it. Its
// queued answer was dropped and never read out. Now it's read out first, then your words reach it.
describe("your words for a finished turn you haven't heard (replyAfter)", () => {
  /** As app.ts sendTo does for a session with a finished turn not read out yet. */
  function wordsFor(f: ReturnType<typeof setup>, id: string, sent: string[], text: string) {
    const r = f.floor.unread(id)!;
    assert.ok(r, `${id} has a turn not read out`);
    f.floor.replyAfter(r, () => {
      sent.push(`${id}: ${text}`);
      r.settled = true; // answered through its hook
    });
  }

  test("it finished while you talked; read out first, then your words go, with no window between", async () => {
    const f = setup();
    const sent: string[] = [];
    f.floor.keyDown();
    const x = stop("x");
    f.floor.add(x); // finished while you talk: queued
    assert.deepEqual(f.made, []);
    await f.floor.keyUp(async () => {
      wordsFor(f, "x", sent, "can the reply window be longer?");
      return true;
    });
    assert.deepEqual(ids(f.made), ["x"], "its answer is read out first");
    assert.deepEqual(sent, [], "your words wait for it");
    assert.ok(x.open);
    assert.equal(f.floor.waiting, null, "not waiting for a reply: your words are its reply");
    f.floor.judged(x, "terminal", 0.8);
    f.floor.startReplyTimer(); // announce(): the speech handed over, no sound yet
    assert.deepEqual(sent, [], "not before its reading made a sound");
    f.floor.playing();
    f.clock.advance(800);
    assert.deepEqual(sent, []);
    f.floor.idle();
    assert.deepEqual(sent, ["x: can the reply window be longer?"], "once it's been heard");
    assert.equal(f.floor.current, null);
    assert.equal(f.floor.until, null, "no window opened");
    assert.equal(f.clock.pending(), 0);
    assert.deepEqual(f.info, [], "nothing let go");
  });

  test("two in line, your words for the second: the first is read out (and waits) first, then the second, then your words", async () => {
    const f = setup();
    const sent: string[] = [];
    f.floor.keyDown();
    const a = stop("a");
    const b = stop("b");
    f.floor.add(a);
    f.floor.add(b);
    await f.floor.keyUp(async () => {
      wordsFor(f, "b", sent, "and push it");
      return true;
    });
    assert.deepEqual(ids(f.made), ["a"], "the one ahead stays ahead");
    assert.deepEqual(ids(f.floor.queue), ["b"]);
    f.readOut(a, 0.8);
    assert.equal(f.floor.waiting, a, "the first waits for your reply, as any");
    assert.deepEqual(sent, []);
    f.clock.advance(600); // another in line: its window is cut to the short one (makeRoom)
    assert.ok(!a.open);
    assert.deepEqual(ids(f.made), ["a", "b"]);
    assert.deepEqual(sent, [], "not before the second is read out");
    f.readOut(b);
    assert.deepEqual(sent, ["b: and push it"]);
    assert.equal(f.floor.current, null);
  });

  test("words for it again before it's read out: one go, in order", async () => {
    const f = setup();
    const sent: string[] = [];
    const a = stop("a");
    f.floor.add(a);
    f.floor.playing(); // being read out: b waits in line
    const b = stop("b");
    f.floor.add(b);
    f.floor.replyAfter(b, () => sent.push("first"));
    f.floor.replyAfter(b, () => sent.push("second"));
    f.floor.idle();
    f.floor.release(a, "done");
    f.floor.drain();
    f.readOut(b);
    assert.deepEqual(sent, ["first"], "the caller keeps the words; one delivery");
  });

  test("you press over its reading once you've heard it: your waiting words go at once, ahead of what you say now", async () => {
    const f = setup();
    const sent: string[] = [];
    const a = stop("a");
    f.floor.playing(); // something else is being said: a waits in line
    f.floor.add(a);
    wordsFor(f, "a", sent, "commit it");
    f.floor.idle();
    assert.deepEqual(ids(f.made), ["a"]);
    f.floor.playing();
    f.clock.advance(400); // past its first moments
    f.floor.keyDown();
    assert.deepEqual(sent, ["a: commit it"]);
    assert.equal(f.floor.current, null);
    assert.equal(f.floor.unread("a"), null);
  });

  test("you press before it made a sound: put back, and your words still wait for it", async () => {
    const f = setup();
    const sent: string[] = [];
    const a = stop("a");
    f.floor.playing();
    f.floor.add(a);
    wordsFor(f, "a", sent, "commit it");
    f.floor.idle();
    f.floor.keyDown();
    assert.deepEqual(ids(f.floor.queue), ["a"]);
    await f.floor.keyUp(async () => false);
    assert.deepEqual(sent, []);
    f.readOut(a);
    assert.deepEqual(sent, ["a: commit it"]);
  });

  test("its hook went away before it was read out: still read out, then your words (the app types them)", async () => {
    const f = setup();
    const sent: string[] = [];
    f.floor.playing();
    const a = stop("a");
    f.floor.add(a);
    wordsFor(f, "a", sent, "commit it");
    a.settled = true;
    f.floor.closed(a, "(a stopped waiting)");
    assert.equal(f.floor.unread("a"), a, "still to be read out");
    f.floor.idle();
    assert.deepEqual(ids(f.made), ["a"]);
    f.readOut(a);
    assert.deepEqual(sent, ["a: commit it"]);
  });

  test("let go before it's heard (a quiet turn, a speech that never starts): your words go all the same", () => {
    const f = setup();
    const sent: string[] = [];
    f.floor.playing();
    const a = stop("a");
    f.floor.add(a);
    wordsFor(f, "a", sent, "commit it");
    f.floor.idle();
    f.floor.release(a, "not worth saying; the session stopped");
    assert.deepEqual(sent, ["a: commit it"]);
    assert.deepEqual(f.info, [], "not let go without them");
    // A speech that never starts: when the window would have run out.
    f.floor.playing();
    const b = stop("b");
    f.floor.add(b);
    wordsFor(f, "b", sent, "and b");
    f.floor.idle();
    assert.deepEqual(ids(f.made), ["a", "b"]);
    f.floor.startReplyTimer();
    f.clock.advance(1500);
    assert.deepEqual(sent, ["a: commit it", "b: and b"]);
  });

  test("taken back before it's read out: read out as any other, its window after", () => {
    const f = setup();
    f.floor.playing();
    const a = stop("a");
    f.floor.add(a);
    f.floor.replyAfter(a, () => assert.fail("taken back"));
    f.floor.cancelReply(a);
    f.floor.idle();
    f.readOut(a);
    assert.equal(f.floor.waiting, a);
    assert.equal(f.floor.until, 1550);
  });

  test("what a restart waits for (owesReading): a finished turn not heard yet, or words waiting for one", () => {
    const f = setup();
    assert.ok(!f.floor.owesReading(), "nothing held");
    const a = stop("a");
    f.floor.add(a);
    assert.ok(f.floor.owesReading(), "being announced, no sound yet");
    f.floor.playing();
    f.floor.add(ask("p"));
    f.clock.advance(400);
    assert.ok(!f.floor.owesReading(), "heard; a permission prompt in line isn't a reading owed");
    const b = stop("b");
    f.floor.add(b);
    assert.ok(f.floor.owesReading(), "one in line");
    f.floor.unqueue(b);
    f.floor.replyAfter(b, () => {});
    assert.ok(f.floor.owesReading(), "words waiting");
  });

  test("shutting down: your waiting words go through its hook", () => {
    const f = setup();
    const sent: string[] = [];
    f.floor.playing();
    const a = stop("a");
    f.floor.add(a);
    wordsFor(f, "a", sent, "commit it");
    f.floor.releaseAll();
    assert.deepEqual(sent, ["a: commit it"]);
    assert.deepEqual(
      f.logs.filter((l) => l.event === "announce_dropped").map((l) => l.reason),
      ["shutdown"],
    );
  });
});

describe('"skip that" (skippable, skip)', () => {
  test("the announcement your press put back before you heard it: skipped, let go, logged; the next is announced", async () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.floor.add(stop("b"));
    f.floor.keyDown(); // before it made a sound
    assert.equal(f.floor.skippable(true), a, "even when something just spoke: it's what your press cut");
    await f.floor.keyUp(async () => {
      assert.ok(f.floor.skip(a, "skipped a"));
      return true;
    });
    assert.ok(!a.open);
    assert.deepEqual(f.info, ["(skipped a)"]);
    assert.deepEqual(ids(f.made), ["a", "b"]);
    assert.deepEqual(
      f.logs.filter((l) => l.event === "announce_dropped").map((l) => [l.sessionId, l.reason]),
      [["a", "skipped"]],
    );
  });

  test("none put back: the next in line, unless one waits for your reply or just spoke", async () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.readOut(a);
    const b = stop("b");
    f.floor.add(b);
    f.floor.keyDown(); // a barge-in on nothing: a waits for your reply
    assert.equal(f.floor.skippable(), null, "words are a's reply");
    await f.floor.keyUp(async () => false);
    f.floor.release(a, "done");
    f.floor.keyDown();
    assert.equal(f.floor.skippable(true), null, "words most likely answer the one that just spoke");
    assert.equal(f.floor.skippable(false), b);
  });

  test("past its first moments of sound: heard, so not skippable; nothing in line: nothing", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.floor.playing();
    f.clock.advance(400);
    f.floor.keyDown();
    assert.equal(f.floor.skippable(), null);
  });

  test("words waiting for the one skipped still go", async () => {
    const f = setup();
    const sent: string[] = [];
    const a = stop("a");
    f.floor.playing();
    f.floor.add(a);
    f.floor.replyAfter(a, () => {
      sent.push("commit it");
      a.settled = true;
    });
    f.floor.idle();
    f.floor.keyDown();
    await f.floor.keyUp(async () => {
      f.floor.skip(f.floor.skippable()!, "skipped a");
      return true;
    });
    assert.deepEqual(sent, ["commit it"]);
    assert.deepEqual(f.info, [], "given your words, not let go");
  });

  test("gone already: nothing skipped", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    assert.ok(!f.floor.skip(a, "skipped a"), "being announced, not in line");
  });
});

describe("the session that just spoke", () => {
  test("its reading's end is when it last spoke, while it waits", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.floor.spokeLast = { sessionId: "a", at: 0 };
    f.readOut(a, 0.8, 700);
    assert.deepEqual(f.floor.spokeLast, { sessionId: "a", at: 700 });
  });

  test("not once it's no longer waiting", () => {
    const f = setup();
    const a = stop("a");
    f.floor.add(a);
    f.floor.spokeLast = { sessionId: "a", at: 0 };
    f.floor.release(a, "done");
    f.floor.playing();
    f.clock.advance(700);
    f.floor.idle();
    assert.deepEqual(f.floor.spokeLast, { sessionId: "a", at: 0 });
  });

  test("shutting down lets every held session go; the ones not heard yet are logged", () => {
    const f = setup();
    const a = stop("a");
    const b = stop("b");
    f.floor.add(a);
    f.floor.add(b);
    f.readOut(a);
    f.floor.releaseAll();
    assert.ok(!a.open && !b.open);
    assert.deepEqual(
      f.logs.filter((l) => l.event === "announce_dropped").map((l) => [l.sessionId, l.reason]),
      [["b", "shutdown"]],
    );
  });
});
