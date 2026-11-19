// Beeps and speech take turns (src/core/audio-queue.ts). Before it, a "sent" beep went straight to the player in the
// middle of "Asking Lacy." (typing finishes ~150ms after the line is asked for, as its first audio arrives), and
// with `say` it played over the voice. The player's playing/idle are driven by hand here, in the order
// native/macos/player.swift prints them.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AudioQueue } from "../../../src/core/audio-queue.ts";
import { SpeechLock } from "../../../src/core/speech-lock.ts";

const BEEP = Buffer.from("beep");
const LISTEN = Buffer.from("listen");
const pcm = (name: string) => Buffer.from(name);

/** A queue whose player only records what it's given; `events` gets what's passed on to the app. */
function setup() {
  const written: string[] = [];
  const events: string[] = [];
  const q = new AudioQueue((b) => written.push(b.toString()));
  q.onPlaying = () => events.push("playing");
  q.onIdle = () => events.push("idle");
  return { q, written, events };
}
const tick = () => new Promise((r) => setImmediate(r));

describe("a beep while speech is playing or about to", () => {
  test("nothing in line: it plays at once, and its playing/idle aren't the app speaking", () => {
    const { q, written, events } = setup();
    q.cue(BEEP);
    assert.deepEqual(written, ["beep"]);
    q.playing();
    q.idle();
    assert.deepEqual(events, []);
    assert.equal(q.busy(), false);
  });

  test('a speech with the voice and no sound yet ("Asking Lacy."): the beep waits until it\'s been heard', () => {
    const { q, written, events } = setup();
    const s = q.speech();
    q.cue(BEEP); // typing finished before the voice's first audio
    assert.deepEqual(written, [], "not before the line");
    s.audio(pcm("ask"));
    s.audio(pcm("ing"));
    q.playing();
    s.end(); // all its audio is with the player
    assert.deepEqual(written, ["ask", "ing"], "not between its chunks, nor right behind them");
    q.idle(); // the line has played
    assert.deepEqual(written, ["ask", "ing", "beep"]);
    q.playing();
    q.idle();
    assert.deepEqual(events, ["playing", "idle"], "the speech's only");
  });

  test("asked mid-speech: after its last chunk has played, not between chunks", () => {
    const { q, written } = setup();
    const s = q.speech();
    s.audio(pcm("a1"));
    q.playing();
    q.cue(BEEP);
    s.audio(pcm("a2"));
    s.end();
    q.idle();
    assert.deepEqual(written, ["a1", "a2", "beep"]);
  });

  test("a speech in line behind the beep waits for it; the one ahead plays first", () => {
    const { q, written } = setup();
    const s1 = q.speech();
    q.cue(BEEP);
    const s2 = q.speech();
    s1.audio(pcm("one"));
    s1.end();
    s2.audio(pcm("two")); // the voice lock passed it on: its audio is in early
    assert.deepEqual(written, ["one"]);
    q.idle();
    assert.deepEqual(written, ["one", "beep"]);
    q.idle();
    assert.deepEqual(written, ["one", "beep", "two"]);
  });

  test("a speech that ends without a sound (quiet, cut, muted) lets the beep go at once", () => {
    const { q, written } = setup();
    const s = q.speech();
    q.cue(BEEP);
    s.end();
    assert.deepEqual(written, ["beep"]);
  });
});

describe("speech while a beep plays", () => {
  test("its audio waits for the beep to finish, then goes in order", () => {
    const { q, written, events } = setup();
    q.cue(BEEP);
    q.playing();
    const s = q.speech();
    s.audio(pcm("x1"));
    s.audio(pcm("x2"));
    assert.deepEqual(written, ["beep"]);
    q.idle(); // the beep is done
    assert.deepEqual(written, ["beep", "x1", "x2"]);
    q.playing();
    assert.deepEqual(events, ["playing"], "the speech's playing, which a beep's swallowed playing would have hidden");
  });

  test("`say` (which plays by itself) starts once the beep is done", async () => {
    const { q } = setup();
    q.cue(BEEP);
    const s = q.speech();
    let started = false;
    void s.ready().then(() => (started = true));
    await tick();
    assert.equal(started, false);
    q.idle();
    await tick();
    assert.equal(started, true);
  });

  test("no beep involved: nothing waits", async () => {
    const { q, written } = setup();
    const s = q.speech();
    s.audio(pcm("now"));
    assert.deepEqual(written, ["now"]);
    let ready = false;
    void s.ready().then(() => (ready = true));
    await tick();
    assert.equal(ready, true);
  });

  test("a `say` speech: a beep asked for while it talks plays once it has finished", () => {
    const { q, written } = setup();
    const s = q.speech(); // its sound isn't the player's: end() is when the process exits
    q.cue(BEEP);
    assert.deepEqual(written, []);
    s.end();
    assert.deepEqual(written, ["beep"]);
  });
});

describe("when the speech is over", () => {
  test("an idle between two chunks (the voice fell behind) isn't its end", () => {
    const { q, events } = setup();
    const s = q.speech();
    s.audio(pcm("sentence 1"));
    q.playing();
    q.idle(); // Pocket between sentences
    assert.deepEqual(events, ["playing"]);
    assert.equal(q.busy(), true);
    s.audio(pcm("sentence 2"));
    q.playing();
    s.end();
    q.idle();
    assert.deepEqual(events, ["playing", "idle"]);
    assert.equal(q.busy(), false);
  });

  test("its last idle came before the voice said it was done: the end is then", () => {
    const { q, events } = setup();
    const s = q.speech();
    s.audio(pcm("all of it"));
    q.playing();
    q.idle();
    s.end();
    assert.deepEqual(events, ["playing", "idle"]);
  });

  test("quiet() waits for the speech in line, its sound included", async () => {
    const { q } = setup();
    const s = q.speech();
    let quiet = false;
    void q.quiet().then(() => (quiet = true));
    s.audio(pcm("x"));
    s.end();
    await tick();
    assert.equal(quiet, false, "still coming out of the player");
    q.idle();
    await tick();
    assert.equal(quiet, true);
  });
});

describe("barge-in", () => {
  test("stop() drops the speech and the beeps in line; the press's beep plays at once", async () => {
    const { q, written, events } = setup();
    const s = q.speech();
    s.audio(pcm("talking"));
    q.playing();
    q.cue(BEEP); // pending behind the speech
    q.stop();
    q.cue(LISTEN);
    assert.deepEqual(written, ["talking", "listen"]);
    s.audio(pcm("late")); // still coming from a voice that was cut
    s.end();
    q.idle(); // the player's idle for what stop cut: not the listening beep's end
    q.playing();
    await tick();
    assert.deepEqual(events, ["playing", "idle"], "told it stopped speaking; the beep isn't speech");
    q.idle(); // the listening beep's
    assert.deepEqual(written, ["talking", "listen"], "the sent beep never plays");
    assert.equal(q.busy(), false);
  });

  test("a `say` waiting behind a beep goes on (to find it was cancelled)", async () => {
    const { q } = setup();
    q.cue(BEEP);
    const s = q.speech();
    let released = false;
    void s.ready().then(() => (released = true));
    q.stop();
    await tick();
    assert.equal(released, true);
  });
});

describe("a beep's done: when the volume may go down (duck.ts waits for the listening cue)", () => {
  test("once it has been heard, not when it's written", () => {
    const { q } = setup();
    let done = 0;
    q.cue(LISTEN, () => done++);
    q.playing();
    assert.equal(done, 0);
    q.idle();
    assert.equal(done, 1);
  });

  test("dropped by a press: done all the same", () => {
    const { q } = setup();
    let done = 0;
    q.cue(LISTEN, () => done++);
    q.stop();
    assert.equal(done, 1);
  });

  test("behind a speech: after the speech and then the beep", () => {
    const { q, written } = setup();
    const s = q.speech();
    s.audio(pcm("a"));
    let done = 0;
    q.cue(LISTEN, () => done++);
    q.playing();
    s.end();
    q.idle();
    assert.deepEqual(written, ["a", "listen"]);
    assert.equal(done, 0);
    q.idle();
    assert.equal(done, 1);
  });
});

describe("SpeechLock's over(): when a speech no longer holds the voice", () => {
  const opener = (log: string[], name: string) => async (h: { onAudio: (b: Buffer) => void; onDone: () => void }) => ({
    push: () => {},
    end: () => h.onDone(),
    cancel: () => log.push(`${name} cancelled`),
    chars: () => 0,
  });
  test("once each: done, cancelled, and stopped while waiting its turn", async () => {
    const lock = new SpeechLock();
    const log: string[] = [];
    await lock.open(
      opener(log, "a"),
      () => {},
      () => log.push("a over"),
    );
    const waiting = lock.open(
      opener(log, "b"),
      () => {},
      () => log.push("b over"),
    );
    lock.stop();
    await waiting;
    assert.deepEqual(log, ["a cancelled", "a over", "b over"]);
    const c = await lock.open(
      opener(log, "c"),
      () => {},
      () => log.push("c over"),
    );
    c.end();
    c.end();
    assert.deepEqual(log.slice(3), ["c over"]);
  });
});

describe("the player gives up on what it had (a stalled output: AirPods with the phone)", () => {
  /** `ms` of 24 kHz 16-bit sound, named. */
  const sound = (name: string, ms: number) => Buffer.concat([Buffer.from(name), Buffer.alloc(ms * 48 - name.length)]);
  const named = (written: string[]) => written.map((w) => w.replace(/\0+$/, ""));
  function tagged() {
    const written: string[] = [];
    const events: string[] = [];
    const q = new AudioQueue<string>((b) => written.push(b.toString("latin1")));
    q.onPlaying = () => events.push("playing");
    q.onIdle = () => events.push("idle");
    return { q, written, events };
  }

  test("hands back what it was, and the rest of it goes nowhere; the speech still ends as its voice does", () => {
    const { q, written, events } = tagged();
    const s = q.speech("lacy");
    s.audio(sound("a", 100));
    q.playing();
    assert.deepEqual(q.stalled(), ["lacy"]);
    q.idle(); // the player's, after its "stalled"
    assert.deepEqual(events, ["playing"], "more of it is still coming from the voice: not over yet");
    s.audio(sound("b", 100)); // the voice goes on
    s.end();
    assert.deepEqual(named(written), ["a"], "nothing more of it to a player that dropped its start");
    assert.deepEqual(events, ["playing", "idle"]);
    assert.equal(q.busy(), false);
  });

  test("a speech in line behind it, with no sound yet, isn't cut: it plays", () => {
    const { q, written, events } = tagged();
    const a = q.speech("lacy");
    a.audio(sound("a", 100));
    a.end();
    const b = q.speech("line");
    q.playing();
    assert.deepEqual(q.stalled(), ["lacy"]);
    q.idle();
    b.audio(sound("b", 100));
    b.end();
    assert.deepEqual(named(written), ["a", "b"]);
    q.playing();
    q.idle();
    assert.deepEqual(events, ["playing", "idle", "playing", "idle"]);
  });

  test("only what the unheard sound was of: one heard to the end before it isn't handed back", () => {
    const { q } = tagged();
    const a = q.speech("heard");
    a.audio(sound("a", 300));
    a.end();
    const b = q.speech("cut");
    b.audio(sound("b", 200)); // straight after a's, no idle between: a is still in line
    b.end();
    q.playing();
    assert.deepEqual(q.stalled(150), ["cut"]);
  });

  test("the backstop's stall (how much is unheard isn't known): all of it", () => {
    const { q } = tagged();
    const a = q.speech("one");
    a.audio(sound("a", 300));
    a.end();
    const b = q.speech("two");
    b.audio(sound("b", 200));
    b.end();
    assert.deepEqual(q.stalled(), ["one", "two"]);
  });

  test("a speech with no tag isn't handed back, but is cut all the same", () => {
    const { q, written } = tagged();
    const s = q.speech();
    s.audio(sound("a", 100));
    assert.deepEqual(q.stalled(), []);
    s.audio(sound("b", 100));
    assert.deepEqual(named(written), ["a"]);
  });
});

// "I can't tell which terminal is Lacy…" was said, and the
// Kiko project's announcement in line behind it took that line's sound as its own first sound and
// ran straight on from it. An announcement now waits for the app's lines ahead of it to be heard.
describe("clearAhead: a speech waits for the lines ahead of it to be heard", () => {
  type Tag = { kind: "line" | "reply" };
  const isLine = (t: Tag) => t.kind === "line";
  function lines() {
    const written: string[] = [];
    const events: string[] = [];
    const q = new AudioQueue<Tag>((b) => written.push(b.toString()));
    q.onPlaying = () => events.push("playing");
    q.onIdle = () => events.push("idle");
    return { q, written, events };
  }

  test("nothing ahead, or nothing it waits for: at once", async () => {
    const { q } = lines();
    const reply: Tag = { kind: "reply" };
    q.speech(reply);
    await q.clearAhead(reply, isLine);
    const other: Tag = { kind: "reply" };
    q.speech(other);
    await q.clearAhead(other, isLine); // a reply ahead isn't a line
    await q.clearAhead({ kind: "reply" }, isLine); // not in line at all
  });

  test("a line ahead: once its sound has played out, its playing over before the announcement's starts", async () => {
    const { q, written, events } = lines();
    const line = q.speech({ kind: "line" });
    const reply: Tag = { kind: "reply" };
    const announcement = q.speech(reply);
    let clear = false;
    const waited = q.clearAhead(reply, isLine).then(() => (clear = true));
    line.audio(pcm("not-sent"));
    q.playing();
    line.end(); // all its audio is with the player, still playing
    await tick();
    assert.equal(clear, false, "not while it plays");
    q.idle(); // heard to the end
    await waited;
    announcement.audio(pcm("summary"));
    q.playing();
    assert.deepEqual(written, ["not-sent", "summary"]);
    assert.deepEqual(events, ["playing", "idle", "playing"], "the announcement's own playing, after the line's idle");
  });

  test("a line cut (a press) clears it too", async () => {
    const { q } = lines();
    const line = q.speech({ kind: "line" });
    const reply: Tag = { kind: "reply" };
    q.speech(reply);
    const waited = q.clearAhead(reply, isLine);
    line.audio(pcm("cut"));
    q.stop();
    await waited;
  });
});

test("each chunk of a speech keeps its place in its line on the way to the player, held behind a beep too (the phones' read-along)", () => {
  const written: Array<[string, unknown]> = [];
  const q = new AudioQueue((b, _cue, pos) => written.push([b.toString(), pos]));
  q.cue(BEEP);
  const s = q.speech();
  s.audio(pcm("one"), { line: 4, at: 0 });
  s.audio(pcm("two"), { line: 4, at: 1 });
  q.idle(); // the beep is done: the held chunks go, with their places
  s.audio(pcm("three"));
  assert.deepEqual(written, [
    ["beep", undefined],
    ["one", { line: 4, at: 0 }],
    ["two", { line: 4, at: 1 }],
    ["three", undefined],
  ]);
});
