// Mute like a TV's (src/core/mute.ts): nothing stops, it goes silent. Wired as app.ts has it: the queue, then the
// Mac's player (MacSpeaker over a player in time on a fake clock) and the tee to phones through Mute. The Mac's player
// plays everything it's given at its own pace whatever the gain, so "playing" and "idle" (what the floor goes by)
// come when they would out loud; what's heard is where the sound plays and the gain is 1. The phones get nothing while
// muted (their playback cut as it starts) and, on unmute, what's left of the line from that moment.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AudioQueue } from "../../../src/core/audio-queue.ts";
import { MacSpeaker, PHONE_LAG_MS } from "../../../src/core/mac-output.ts";
import { Mute } from "../../../src/core/mute.ts";
import type { Speaker, Stall } from "../../../src/platform/types.ts";
import { FakeClock } from "../../support/clock.ts";

/** `ms` of 24 kHz 16-bit sound, tagged. */
const pcm = (tag: string, ms: number) => Buffer.concat([Buffer.from(tag), Buffer.alloc(ms * 48 - tag.length)]);
const tagOf = (b: Buffer) => b.toString("latin1").replace(/\0+$/, "");

/** The Mac's player, in time on the clock, with a gain: what's heard is where it plays at gain 1. */
class Player implements Speaker {
  onPlaying = () => {};
  onIdle = () => {};
  onStalled = (_: Stall) => {};
  onBack = () => {};
  stops = 0;
  gain = 1;
  private gains: Array<{ at: number; level: number }> = [{ at: 0, level: 1 }];
  private sound: Array<{ from: number; to: number }> = [];
  private end = 0;
  private timer: unknown = null;
  private clock: FakeClock;
  constructor(clock: FakeClock) {
    this.clock = clock;
  }
  start() {
    return Promise.resolve();
  }
  write(b: Buffer) {
    const now = this.clock.now();
    if (!this.timer) this.clock.setTimeout(() => this.onPlaying(), 0);
    const from = Math.max(this.end, now);
    this.end = from + b.length / 48;
    this.sound.push({ from, to: this.end });
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.onIdle();
    }, this.end - now);
  }
  stop() {
    this.stops++;
    const now = this.clock.now();
    this.sound = this.sound.filter((s) => s.from < now).map((s) => ({ from: s.from, to: Math.min(s.to, now) }));
    this.end = now;
    if (!this.timer) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.clock.setTimeout(() => this.onIdle(), 0);
  }
  volume(level: number) {
    this.gain = level;
    this.gains.push({ at: this.clock.now(), level });
  }
  shutdown() {}
  /** Where sound came out and was heard (gain 1), merged: [from, to] in ms. */
  heard(): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const s of this.sound) {
      for (let i = 0; i < this.gains.length; i++) {
        const g = this.gains[i]!;
        if (g.level === 0) continue;
        const from = Math.max(s.from, g.at);
        const to = Math.min(s.to, this.gains[i + 1]?.at ?? Infinity);
        if (to <= from) continue;
        const last = out.at(-1);
        if (last && last[1] === from) last[1] = to;
        else out.push([from, to]);
      }
    }
    return out;
  }
}

/** The app's way out for sound, with Mute in it. `on`: Play on this Mac. */
function setup(on = true) {
  const clock = new FakeClock();
  const player = new Player(clock);
  const speaker = new MacSpeaker(player, () => on, clock);
  // The phones' voice: each chunk as sent ({ tag, ms, at }), and each cut.
  const phone: Array<{ tag: string; ms: number; at: number }> = [];
  let phoneStops = 0;
  const mute = new Mute({
    gain: (level) => speaker.volume(level),
    phone: { audio: (b) => phone.push({ tag: tagOf(b), ms: b.length / 48, at: clock.now() }), stop: () => phoneStops++ },
    clock,
  });
  const queue = new AudioQueue((b, cue) => {
    speaker.write(b, cue !== null);
    if (cue === null) mute.voice(b);
  });
  speaker.onPlaying = () => queue.playing();
  speaker.onIdle = () => queue.idle();
  // What the floor hears (app.ts: the queue's onPlaying and onIdle are floor.playing() and floor.idle()).
  const floor: string[] = [];
  queue.onPlaying = () => floor.push(`playing@${clock.now()}`);
  queue.onIdle = () => floor.push(`idle@${clock.now()}`);
  /** A line of three 100 ms chunks, all handed over at once (the voice is faster than real time). */
  const say3 = () => {
    const turn = queue.speech();
    for (const tag of ["a", "b", "c"]) turn.audio(pcm(tag, 100));
    turn.end();
  };
  /** Barge-in, as stopTalking does it. */
  const bargeIn = () => {
    queue.stop();
    speaker.stop();
    mute.stop();
  };
  return { clock, player, speaker, mute, queue, phone, phoneStops: () => phoneStops, floor, say3, bargeIn };
}

describe("mute, like a TV's", () => {
  test("muted mid-line, the line isn't stopped: it plays on, unheard, to its end", () => {
    const { clock, player, mute, floor, say3 } = setup();
    say3();
    clock.advance(100);
    mute.set(true);
    assert.equal(player.gain, 0, "silent at once, mid-line");
    clock.advance(500);
    assert.equal(player.stops, 0, "nothing was cut");
    assert.deepEqual(floor, ["playing@0", "idle@300"], "the floor saw it end when it would out loud");
    assert.deepEqual(player.heard(), [[0, 100]]);
  });

  test("unmuted mid-line, it's heard from that point on", () => {
    const { clock, player, mute, floor, say3 } = setup();
    say3();
    clock.advance(100);
    mute.set(true);
    clock.advance(100);
    mute.set(false);
    assert.equal(player.gain, 1);
    clock.advance(500);
    assert.deepEqual(player.heard(), [
      [0, 100],
      [200, 300],
    ]);
    assert.deepEqual(floor, ["playing@0", "idle@300"]);
  });

  test("a line that starts while muted plays silently, and the floor sees it finish at the normal time", () => {
    const muted = setup();
    muted.mute.set(true);
    muted.say3();
    muted.clock.advance(1000);
    assert.deepEqual(muted.player.heard(), []);
    // The same line out loud: the same timing.
    const loud = setup();
    loud.say3();
    loud.clock.advance(1000);
    assert.deepEqual(loud.player.heard(), [[0, 300]]);
    assert.deepEqual(muted.floor, loud.floor);
    assert.deepEqual(muted.floor, ["playing@0", "idle@300"]);

    // Play on this Mac off (the clock stands in for the player): the same, with the phone's moment at the end.
    const off = setup(false);
    off.mute.set(true);
    off.say3();
    off.clock.advance(1000);
    assert.deepEqual(off.floor, ["playing@0", `idle@${300 + PHONE_LAG_MS}`]);
    assert.deepEqual(off.phone, [], "nothing to the phone");
  });

  test("phones: nothing audible while muted, and the rest of the line after unmute", () => {
    const { clock, mute, phone, phoneStops, say3 } = setup();
    say3();
    assert.deepEqual(
      phone.map((c) => c.tag),
      ["a", "b", "c"],
      "sent as it's made, ahead of where it plays",
    );
    clock.advance(150);
    mute.set(true);
    assert.equal(phoneStops(), 1, "what the phone holds of it is cut");
    clock.advance(50); // at 200: b is over, c starts
    mute.set(false);
    assert.deepEqual(phone.slice(3), [{ tag: "c", ms: 100, at: 200 }], "c, the rest of it");
    assert.equal(phoneStops(), 1);

    // Unmuted in the middle of a chunk: from that point in it.
    const mid = setup();
    mid.mute.set(true);
    mid.say3();
    assert.equal(mid.phone.length, 0, "nothing sent while muted");
    assert.equal(mid.phoneStops(), 0, "nothing playing to cut");
    mid.clock.advance(150);
    mid.mute.set(false);
    assert.deepEqual(
      mid.phone.map((c) => [c.ms, c.at]),
      [
        [50, 150],
        [100, 150],
      ],
      "the second half of b, then c",
    );
    assert.equal(mid.phone[0]!.tag, "", "b's start (its tag) was the muted part");

    // Chunks made while muted, after the line before: timed after it.
    const later = setup();
    later.say3();
    later.mute.set(true);
    later.say3(); // plays 300 to 600
    later.clock.advance(450);
    later.mute.set(false);
    assert.deepEqual(
      later.phone.slice(3).map((c) => [c.ms, c.at]),
      [
        [50, 450],
        [100, 450],
      ],
    );
  });

  test("phones: nothing kept after the line is over or a barge-in", () => {
    const over = setup();
    over.mute.set(true);
    over.say3();
    over.clock.advance(400);
    over.mute.set(false);
    assert.deepEqual(over.phone, [], "the line was over by then: missed, as accepted");

    const cut = setup();
    cut.mute.set(true);
    cut.say3();
    cut.clock.advance(50);
    cut.bargeIn(); // a press while muted still stops the line
    assert.equal(cut.player.stops, 1);
    cut.clock.advance(10);
    cut.mute.set(false);
    assert.deepEqual(cut.phone, [], "what the press cut isn't sent on unmute");
  });

  test("cues while muted are silent (the app asks for none, as before; one asked just before plays at gain 0)", () => {
    const { clock, player, mute, queue, phone } = setup();
    let played = false;
    queue.cue(pcm("beep", 150), () => (played = true), "mac");
    mute.set(true);
    clock.advance(1000);
    assert.equal(played, true, "it still finishes, so what waits on it goes on");
    assert.deepEqual(player.heard(), []);
    assert.deepEqual(phone, [], "a cue is never the phones' voice");
  });

  test("mute and unmute with nothing playing: only the gain", () => {
    const { player, mute, phone, phoneStops } = setup();
    mute.set(true);
    mute.set(true);
    assert.equal(player.gain, 0);
    mute.set(false);
    assert.equal(player.gain, 1);
    assert.equal(phoneStops(), 0);
    assert.deepEqual(phone, []);
    assert.equal(mute.muted, false);
  });
});

test("unmuted mid-chunk: what's sent of it keeps its place in its line, moved on by what was skipped (the phones' read-along)", () => {
  const clock = new FakeClock();
  const sent: unknown[] = [];
  const mute = new Mute({ gain: () => {}, phone: { audio: (_b, pos) => sent.push(pos), stop: () => {} }, clock });
  mute.set(true);
  mute.voice(pcm("a", 100), { line: 6, at: 0 });
  mute.voice(pcm("b", 100), { line: 6, at: 2400 });
  mute.voice(pcm("c", 100));
  clock.advance(150);
  mute.set(false);
  // b is 50 ms in: 1200 samples skipped; c had no line.
  assert.deepEqual(sent, [{ line: 6, at: 3600 }, undefined]);
});
