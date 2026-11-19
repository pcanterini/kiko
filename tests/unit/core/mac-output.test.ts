// Play on this Mac (src/core/mac-output.ts). Off, the Mac's player and `say` get nothing, the phones still get every
// chunk as it's made (the tee before the player, as in app.ts), and the app hears playing and idle when the sound
// would have started and ended: each chunk's length, plus PHONE_LAG_MS at the end of speech for the phone hearing it a
// moment after it's sent. Timed with a fake clock.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AudioQueue } from "../../../src/core/audio-queue.ts";
import { MacSpeaker, MacVoice, PHONE_LAG_MS, sayMs } from "../../../src/core/mac-output.ts";
import type { Speech } from "../../../src/core/speech-lock.ts";
import type { LocalVoice, Speaker, Stall } from "../../../src/platform/types.ts";
import { FakeClock } from "../../support/clock.ts";

/** `ms` of 24 kHz 16-bit sound, tagged. */
const pcm = (tag: string, ms: number) => Buffer.concat([Buffer.from(tag), Buffer.alloc(ms * 48 - tag.length)]);
const tagOf = (b: Buffer) => b.toString("latin1").replace(/\0+$/, "");

/** The Mac's player, in time on the clock: plays what it's given in order, "playing" as it starts, "idle" as it runs dry or is cut. */
class Player implements Speaker {
  onPlaying = () => {};
  onIdle = () => {};
  onStalled = (_: Stall) => {};
  onBack = () => {};
  written: string[] = [];
  stops = 0;
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
    this.written.push(tagOf(b));
    const now = this.clock.now();
    if (!this.timer) this.clock.setTimeout(() => this.onPlaying(), 0);
    this.end = Math.max(this.end, now) + b.length / 48;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.onIdle();
    }, this.end - now);
  }
  stop() {
    this.stops++;
    this.end = this.clock.now();
    if (!this.timer) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.clock.setTimeout(() => this.onIdle(), 0);
  }
  gain = 1;
  volume(level: number) {
    this.gain = level;
  }
  /** The output took none of it (player.swift "stalled"): what's left is dropped, said, then idle. */
  stall(device: string) {
    if (!this.timer) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
    const unheardMs = this.end - this.clock.now();
    this.end = this.clock.now();
    this.onStalled({ device, unheardMs });
    this.onIdle();
  }
  shutdown() {}
}

/** The app's way out for sound (app.ts): the queue, the tee to phones, the player. `on`: Play on this Mac. */
function setup(on: boolean) {
  const clock = new FakeClock();
  const player = new Player(clock);
  const state = { on };
  const speaker = new MacSpeaker(player, () => state.on, clock);
  const phone: string[] = [];
  const queue = new AudioQueue((b, cue) => {
    speaker.write(b, cue !== null);
    phone.push(tagOf(b));
  });
  speaker.onPlaying = () => queue.playing();
  speaker.onIdle = () => queue.idle();
  const events: string[] = [];
  queue.onPlaying = () => events.push(`playing@${clock.now()}`);
  queue.onIdle = () => events.push(`idle@${clock.now()}`);
  return { clock, player, speaker, phone, queue, events, state };
}

/** A line of three 100 ms chunks, all handed over at once (the voice is faster than real time). */
function say3(queue: AudioQueue) {
  const turn = queue.speech();
  for (const tag of ["a", "b", "c"]) turn.audio(pcm(tag, 100));
  turn.end();
}

describe("Play on this Mac off", () => {
  test("the phone gets every chunk as it's made, the Mac's player nothing, and the timing follows the speech", () => {
    const off = setup(false);
    say3(off.queue);
    assert.deepEqual(off.phone, ["a", "b", "c"], "at once, as today");
    assert.deepEqual(off.player.written, []);
    off.clock.advance(300 + PHONE_LAG_MS - 1);
    assert.deepEqual(off.events, ["playing@0"], "still speaking while the phone plays it");
    off.clock.advance(1);
    assert.deepEqual(off.events, ["playing@0", `idle@${300 + PHONE_LAG_MS}`]);
    assert.equal(off.queue.busy(), false);

    // The same line on the Mac: the same, but for the moment the phone takes to hear it.
    const on = setup(true);
    say3(on.queue);
    on.clock.advance(1000);
    assert.deepEqual(on.player.written, ["a", "b", "c"]);
    assert.deepEqual(on.phone, ["a", "b", "c"]);
    assert.deepEqual(on.events, ["playing@0", "idle@300"]);
  });

  test("cues: not on the Mac, still to the phone, and speech still waits for one ahead of it", () => {
    const { clock, player, phone, queue, events } = setup(false);
    let played = false;
    queue.cue(pcm("beep", 150), () => (played = true));
    const turn = queue.speech();
    turn.audio(pcm("line", 200));
    turn.end();
    assert.deepEqual(phone, ["beep"], "the line waits for the beep");
    clock.advance(150);
    assert.equal(played, true, "no moment added after a cue: the phone queues what follows");
    assert.deepEqual(phone, ["beep", "line"]);
    clock.advance(200 + PHONE_LAG_MS);
    assert.deepEqual(player.written, []);
    assert.deepEqual(events, ["playing@150", `idle@${350 + PHONE_LAG_MS}`]);
  });

  test("a chunk that comes late (the voice fell behind) carries on the same stretch, as the player would", () => {
    const { clock, queue, events } = setup(false);
    const turn = queue.speech();
    turn.audio(pcm("a", 100));
    clock.advance(200); // past its end, inside the phone's moment
    turn.audio(pcm("b", 100));
    turn.end();
    clock.advance(1000);
    assert.deepEqual(events, ["playing@0", `idle@${300 + PHONE_LAG_MS}`]);
  });

  test("barge-in: cut at once, idle once a moment later, and the next sound starts afresh", async () => {
    const { clock, player, queue, speaker, events } = setup(false);
    say3(queue);
    clock.advance(100);
    queue.stop();
    speaker.stop();
    clock.advance(0);
    await new Promise((r) => setImmediate(r)); // the queue tells it on the next turn
    assert.deepEqual(events, ["playing@0", "idle@100"]);
    assert.equal(queue.busy(), false);
    queue.cue(pcm("listening", 100)); // the press's cue
    clock.advance(100);
    assert.equal(player.stops, 1, "the Mac's player is told to stop too, as always");
    assert.deepEqual(events, ["playing@0", "idle@100"], "a cue isn't the app speaking");
  });
});

describe("Play on this Mac on", () => {
  test("the player's news passes on as before: a cue written right after a barge-in, before the cut's idle, still ends", async () => {
    const { clock, player, queue, speaker, events } = setup(true);
    say3(queue);
    clock.advance(100);
    queue.stop();
    speaker.stop();
    let played = false;
    queue.cue(pcm("listening", 100), () => (played = true)); // the press's cue, at once
    clock.advance(0); // the player's idle for what was cut
    await new Promise((r) => setImmediate(r));
    clock.advance(100);
    assert.equal(played, true);
    assert.deepEqual(player.written, ["a", "b", "c", "listening"]);
    assert.deepEqual(events, ["playing@0", "idle@100"]);
    assert.equal(queue.busy(), false);
  });
});

describe("a stalled output (AirPods with the phone)", () => {
  test("on the Mac: the stall passes on, with what went unheard, and the idle after it ends the speech", () => {
    const { clock, player, queue, speaker, events } = setup(true);
    const stalls: Stall[] = [];
    let back = 0;
    speaker.onStalled = (s) => stalls.push(s);
    speaker.onBack = () => back++;
    say3(queue);
    clock.advance(100);
    player.stall("AirPods");
    assert.deepEqual(stalls, [{ device: "AirPods", unheardMs: 200 }]);
    assert.deepEqual(events, ["playing@0", "idle@100"], "speaking ends: the floor goes on");
    assert.equal(queue.busy(), false);
    player.onBack();
    assert.equal(back, 1);
  });

  test("off: the clock times it, and the Mac's player has nothing to stall on", () => {
    const { clock, player, queue, speaker } = setup(false);
    const stalls: Stall[] = [];
    speaker.onStalled = (s) => stalls.push(s);
    say3(queue);
    clock.advance(100);
    player.onStalled({ device: "AirPods", unheardMs: 100 }); // a stray one from before it went off
    assert.deepEqual(stalls, []);
  });
});

describe("where a cue plays", () => {
  test("a cue for a phone's press, written right after a barge-in on the Mac: timed, not played here", async () => {
    const clock = new FakeClock();
    const player = new Player(clock);
    const speaker = new MacSpeaker(player, () => true, clock);
    const events: string[] = [];
    speaker.onPlaying = () => events.push(`playing@${clock.now()}`);
    speaker.onIdle = () => events.push(`idle@${clock.now()}`);
    speaker.write(pcm("line", 300));
    clock.advance(100);
    speaker.stop();
    speaker.write(pcm("sent", 100), true, "silent"); // before the cut's idle comes
    clock.advance(0);
    clock.advance(100);
    assert.deepEqual(player.written, ["line"], "the cue isn't played on the Mac");
    assert.deepEqual(events, ["playing@0", "idle@100", "playing@100", "idle@200"], "the cut's idle passes on; the cue's ends on its length");
  });

  test("a cue for a press on the Mac plays there with Play on this Mac off", () => {
    const clock = new FakeClock();
    const player = new Player(clock);
    const speaker = new MacSpeaker(player, () => false, clock);
    speaker.write(pcm("listening", 100), true, "mac");
    clock.advance(100);
    speaker.write(pcm("line", 100)); // what's said next, once the cue has played: timed only
    clock.advance(1000);
    assert.deepEqual(player.written, ["listening"]);
  });
});

describe("switched while it plays", () => {
  test("turned off mid-line: the Mac stops now, and the clock times the rest", () => {
    const { clock, player, queue, speaker, events, state } = setup(true);
    say3(queue);
    clock.advance(120);
    state.on = false;
    speaker.silence();
    assert.equal(player.stops, 1);
    clock.advance(0); // the player's idle for what was cut: not the end of the line
    assert.deepEqual(events, ["playing@0"]);
    clock.advance(300 + PHONE_LAG_MS - 120);
    assert.deepEqual(events, ["playing@0", `idle@${300 + PHONE_LAG_MS}`]);
    // The next line: silent from the start.
    say3(queue);
    clock.advance(1000);
    assert.deepEqual(player.written, ["a", "b", "c"]);
  });

  test("turned on mid-line: the rest stays off the Mac; the next line plays on it", () => {
    const { clock, player, queue, events, state } = setup(false);
    say3(queue);
    clock.advance(100);
    state.on = true;
    clock.advance(1000);
    assert.deepEqual(player.written, []);
    assert.deepEqual(events, ["playing@0", `idle@${300 + PHONE_LAG_MS}`]);
    say3(queue);
    clock.advance(1000);
    assert.deepEqual(player.written, ["a", "b", "c"]);
  });
});

/** `say` in time on the clock: starts 5 ms after it's asked, ends `ms` later; killed, it exits at once. */
class Say implements LocalVoice {
  onStart = () => {};
  onEnd = () => {};
  said: string[] = [];
  private exit: (() => void) | null = null;
  private timers: unknown[] = [];
  private clock: FakeClock;
  private ms: number;
  constructor(clock: FakeClock, ms = 1000) {
    this.clock = clock;
    this.ms = ms;
  }
  async open(onDone = () => {}): Promise<Speech> {
    let text = "";
    return {
      push: (d) => void (text += d),
      chars: () => text.length,
      end: () => {
        if (!text.trim()) return onDone();
        this.said.push(text);
        const exit = () => {
          this.exit = null;
          for (const t of this.timers.splice(0)) this.clock.clearTimeout(t);
          this.onEnd();
          onDone();
        };
        this.exit = exit;
        this.timers.push(
          this.clock.setTimeout(() => this.onStart(), 5),
          this.clock.setTimeout(exit, this.ms),
        );
      },
      cancel: () => this.stop(),
    };
  }
  stop() {
    this.exit?.();
  }
}

function voice(on: boolean) {
  const clock = new FakeClock();
  const say = new Say(clock);
  const state = { on };
  const v = new MacVoice(say, () => state.on, clock);
  const events: string[] = [];
  v.onStart = () => events.push(`start@${clock.now()}`);
  v.onEnd = () => events.push(`end@${clock.now()}`);
  return { clock, say, v, events, state };
}

describe("the macOS voice", () => {
  const LINE = "Atlas agents finished the migration and all tests pass";
  const ms = sayMs(LINE);

  test("about how long it takes to say, on the slow side", () => {
    assert.equal(sayMs("one two three four"), 1500);
    assert.equal(sayMs("  "), 0);
  });

  test("off: `say` isn't run, and the line is timed by its words", async () => {
    const { clock, say, v, events } = voice(false);
    let done = 0;
    const speech = await v.open(() => done++);
    speech.push(LINE);
    speech.end();
    clock.advance(ms + PHONE_LAG_MS - 1);
    assert.deepEqual(say.said, []);
    assert.deepEqual(events, ["start@0"]);
    assert.equal(done, 0);
    clock.advance(1);
    assert.deepEqual(events, ["start@0", `end@${ms + PHONE_LAG_MS}`]);
    assert.equal(done, 1);
  });

  test("off, cut short: it ends then, once", async () => {
    const { clock, v, events } = voice(false);
    let done = 0;
    const speech = await v.open(() => done++);
    speech.push(LINE);
    speech.end();
    clock.advance(200);
    v.stop();
    clock.advance(10_000);
    assert.deepEqual(events, ["start@0", "end@200"]);
    assert.equal(done, 1);
  });

  test("on: `say` says it, as before", async () => {
    const { clock, say, v, events } = voice(true);
    let done = 0;
    const speech = await v.open(() => done++);
    speech.push(LINE);
    speech.end();
    clock.advance(2000);
    assert.deepEqual(say.said, [LINE]);
    assert.deepEqual(events, ["start@5", "end@1000"]);
    assert.equal(done, 1);
  });

  test("turned off while `say` speaks: it stops now, and the clock times the rest", async () => {
    const { clock, say, v, events, state } = voice(true);
    let done = 0;
    const speech = await v.open(() => done++);
    speech.push(LINE);
    speech.end();
    clock.advance(300);
    state.on = false;
    v.silence();
    assert.deepEqual(say.said, [LINE]);
    assert.deepEqual(events, ["start@5"], "`say` exiting isn't the end of the line");
    assert.equal(done, 0);
    clock.advance(ms + PHONE_LAG_MS - 300);
    assert.deepEqual(events, ["start@5", `end@${ms + PHONE_LAG_MS}`]);
    assert.equal(done, 1);
  });
});
