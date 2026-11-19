// The Mac's player (native/macos/player.swift) through an output device change: nothing queued is lost, nothing said
// twice past the 100 ms slice it was in, and "idle" comes once, when it's all been heard. The real helper runs, built
// as the app builds it, but offline (KIKO_PLAYER_OFFLINE: no device, it renders in real time to nowhere and says
// how much non-silent sound came out); "C" makes it act as if the device changed. And the Node side
// (src/platform/macos/speaker.ts) still gets its idle when the helper dies mid-speech.
//
// An output that takes no sound (2026-10-29: AirPods that were with the iPhone, three minutes of "speaking" in
// silence): "S" makes the offline device stop taking sound ("R": take it again). The helper gives up after its stall
// time (KIKO_PLAYER_STALL_MS, short here), says "stalled", then idle, and "back" once it takes sound; the Node
// side passes that on, and its backstop gives the idle even when the helper never does.
//
// The output's format changing under it (2026-11-13: AirPods going between their music and call profiles as their
// mic was opened or closed; a 19 s reply stopped 2.4 s in, with "rerouted 0"): the engine stops by itself and ends
// every buffer scheduled, played or not, before the helper has done anything. "D" does that to the offline engine
// (it stops, nothing brings it back but the helper's own looking, and the made-up output's rate changes). The reply
// goes on from where it was, and "idle" comes once, at its end.
//
// Both channels (2026-11-14: with the AirPods' mic held open, their call profile, 24 kHz and two channels, the
// replies were heard in the right ear only, while every other app played in both). The offline output has two
// channels and a rate; KIKO_PLAYER_OFFLINE_RENDER=device renders it at that rate, as a device takes it, and "L" says
// each channel's level since the last "L". Mono speech and the keep-alive are the same on both: at 48 kHz, through
// the change to 24 kHz (the engine stopped by it, a new one made by the helper's own looking), back again, and from
// a start at 24 kHz. None of it failed on the player as it was: the one-sided sound couldn't be made to happen
// without the AirPods (player.swift, "Both channels"). These hold what was measured, and the "channels" lines
// (player_output in the log) are what the next time is read from.
import "../../../setup.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { after, describe, test } from "node:test";
import { buildNative } from "../../../../src/platform/macos/native.ts";
import { Speaker } from "../../../../src/platform/macos/speaker.ts";
import type { Stall } from "../../../../src/platform/types.ts";
import { checkWaits, SLOW } from "../../../support/until.ts";

const waitFor = checkWaits(5000, 20);

process.env.KIKO_PLAYER_OFFLINE = "1";
const SLICE = 2400; // frames in a slice (player.swift sliceFrames)
const skip = process.platform !== "darwin" || spawnSync("which", ["swiftc"]).status !== 0 ? "needs macOS and swiftc" : false;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// How long a helper may take to start: an AVAudioEngine talks to CoreAudio even offline, and a busy machine (iOS
// simulators running, a whole test run) can keep it waiting several seconds.
const STARTS_MS = 20_000;
/** `ms` of a 220 Hz sine at a quarter of full scale, 16-bit at 24 kHz: for what's measured by its level (VOICE). */
const voice = (ms: number) => {
  const pcm = Buffer.alloc(ms * 24 * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(8192 * Math.sin((2 * Math.PI * 220 * i) / 24000)), i * 2);
  return pcm;
};
const VOICE = -15.05; // its level, dBFS: 0.25 / √2
/** `ms` of a steady non-silent tone, 16-bit at 24 kHz. */
const tone = (ms: number) => {
  const pcm = Buffer.alloc(ms * 24 * 2);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(4096, i);
  return pcm;
};
const frames = (pcm: Buffer) => pcm.length / 2;

// Every helper started, stopped at the end whatever happened: one a failed test left running keeps the run from ending.
const helpers: ChildProcess[] = [];
after(() => helpers.forEach((proc) => proc.kill()));

/** The helper, spoken to directly: each line it prints with when (ms after start). `env`: added to its environment. */
async function helper(env: Record<string, string> = {}) {
  const proc: ChildProcess = spawn(buildNative("player"), [], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
  helpers.push(proc);
  const t0 = Date.now();
  const lines: Array<{ line: string; at: number }> = [];
  let waiter: (() => void) | null = null;
  proc.stdout!.setEncoding("utf8");
  let rest = "";
  proc.stdout!.on("data", (chunk: string) => {
    const parts = (rest + chunk).split("\n");
    rest = parts.pop()!;
    for (const line of parts) lines.push({ line, at: Date.now() - t0 });
    waiter?.();
  });
  const send = (type: string, payload = Buffer.alloc(0)) => {
    const header = Buffer.alloc(5);
    header.write(type, 0, "ascii");
    header.writeUInt32LE(payload.length, 1);
    proc.stdin!.write(Buffer.concat([header, payload]));
  };
  /** The first line from `from` on matching `prefix` (within `ms`, stretched by KIKO_TEST_SLOW), and the index after it. */
  const find = async (prefix: string, from: number, ms: number) => {
    const deadline = Date.now() + ms * SLOW;
    for (;;) {
      const i = lines.findIndex((l, n) => n >= from && l.line.startsWith(prefix));
      if (i >= 0) return i;
      if (Date.now() > deadline) throw new Error(`no "${prefix}" from the player in ${ms * SLOW} ms; got ${JSON.stringify(lines)}`);
      await new Promise<void>((resolve) => {
        waiter = resolve;
        setTimeout(resolve, 50);
      });
    }
  };
  /** Resolves with the next line matching `prefix` not yet waited for (within `ms`). */
  let seen = 0;
  const next = async (prefix: string, ms = 5000) => {
    const i = await find(prefix, seen, ms);
    seen = i + 1;
    return lines[i]!;
  };
  // "Q"'s answers, read on their own: asking doesn't move `next` past lines it hasn't waited for yet.
  let probed = 0;
  /** "Q": what came out not exactly silent since the last one, and the render clock (frames rendered in all). */
  const probe = async () => {
    send("Q");
    const i = await find("output ", probed, 5000);
    probed = i + 1;
    const [out, clock] = lines[i]!.line.slice(7).split(" ").map(Number);
    return { out: out!, clock: clock! };
  };
  /**
   * Waits until the helper has rendered `ms` more of its output (its render clock, offline: real time when the
   * machine keeps up, later when it doesn't), and gives what came out not exactly silent meanwhile, in frames.
   */
  const rendered = async (ms: number) => {
    const from = (await probe()).clock;
    let out = 0;
    await waitFor(
      async () => {
        const now = await probe();
        out += now.out;
        return now.clock - from >= ms * 24;
      },
      ms + 10_000,
      `${ms} ms rendered`,
    );
    return out;
  };
  // "L"'s answers, read on their own too.
  let levelled = 0;
  /** "L": the made-up output as it's rendered (its rate and channels), and each channel's level since the last "L", in dBFS (NaN: none). */
  const levels = async () => {
    send("L");
    const i = await find("levels ", levelled, 5000);
    levelled = i + 1;
    const [rate, channels, left, right] = lines[i]!.line.slice(7).split(" ").map(Number);
    return { rate: rate!, channels: channels!, left: left!, right: right! };
  };
  const count = (prefix: string) => lines.filter((l) => l.line.startsWith(prefix)).length;
  await next("ready", STARTS_MS);
  return { send, next, count, lines, rendered, levels, now: () => Date.now() - t0, stop: () => proc.kill() };
}

/** This run's log lines for one event (setup.ts runs the tests in a temp folder: logs/ is there). */
function logged(event: string) {
  const file = readdirSync("logs")
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .at(-1)!;
  return readFileSync(`logs/${file}`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === event);
}

/** The gain message ("V"): a 32-bit little-endian float. */
const gain = (level: number) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(level);
  return b;
};

// Mute (src/core/mute.ts): the player's gain, mid-line. What's queued plays on at its pace, unheard at 0, so "idle"
// comes when it would have; back at 1, it's heard from there.
describe("the player's gain", { skip }, () => {
  test("down to 0 mid-line: silent from then on, and idle when it would have been", async () => {
    const p = await helper();
    const pcm = tone(1000);
    p.send("A", pcm);
    const playing = await p.next("playing");
    await p.rendered(300);
    p.send("V", gain(0));
    const heard = Number((await p.next("heard ")).line.slice(6));
    const idle = await p.next("idle");
    assert.ok(heard > frames(pcm) * 0.15 && heard < frames(pcm) * 0.6, `heard up to the mute only: ${heard} of ${frames(pcm)}`);
    assert.ok(idle.at - playing.at >= 950, `played on to its end, unheard (${idle.at - playing.at} ms)`);
    assert.equal(p.count("idle"), 1);
    p.stop();
  });

  test("muted while quiet, after sound has played: the next sound is silent from its first frame", async () => {
    // A gain changed with nothing playing used to take only as the next sound started, easing in: its first ~25 ms
    // came out.
    const p = await helper();
    p.send("A", tone(200));
    await p.next("idle");
    p.send("V", gain(0));
    await p.rendered(150);
    p.send("A", tone(200));
    assert.equal((await p.next("heard ")).line, "heard 0");
    await p.next("idle");
    p.send("V", gain(1));
    await p.rendered(150);
    p.send("A", tone(200));
    assert.equal(Number((await p.next("heard ")).line.slice(6)), frames(tone(200)), "unmuted while quiet: all of the next one");
    p.stop();
  });

  test("written at 0, then back to 1 mid-line: heard from there", async () => {
    const p = await helper();
    p.send("V", gain(0));
    const pcm = tone(1000);
    p.send("A", pcm);
    const playing = await p.next("playing");
    await p.rendered(500);
    p.send("V", gain(1));
    const heard = Number((await p.next("heard ")).line.slice(6));
    const idle = await p.next("idle");
    assert.ok(heard > frames(pcm) * 0.25 && heard < frames(pcm) * 0.7, `heard from the unmute on: ${heard} of ${frames(pcm)}`);
    assert.ok(idle.at - playing.at >= 950, `idle when it would have been (${idle.at - playing.at} ms)`);
    // It stays: the next line plays out loud, all of it.
    p.send("A", tone(200));
    assert.equal(Number((await p.next("heard ")).line.slice(6)), frames(tone(200)));
    p.stop();
  });
});

describe("the player through an output device change", { skip }, () => {
  test("plays it all, then idle once", async () => {
    const p = await helper();
    const pcm = tone(1000);
    p.send("A", pcm);
    const playing = await p.next("playing");
    await p.rendered(350);
    p.send("C");
    const rerouted = await p.next("rerouted ");
    const left = Number(rerouted.line.slice(9));
    assert.ok(left > 500 && left <= 800, `what was left to play goes on (${left} ms)`);
    const heard = await p.next("heard ");
    const idle = await p.next("idle");
    const n = Number(heard.line.slice(6));
    assert.ok(n >= frames(pcm), `nothing lost: heard ${n} of ${frames(pcm)}`);
    assert.ok(n <= frames(pcm) + SLICE, `no more than a slice again: heard ${n} of ${frames(pcm)}`);
    assert.ok(idle.at - playing.at >= 1000, `idle once it's all played (${idle.at - playing.at} ms)`);
    await p.rendered(200);
    assert.equal(p.count("idle"), 1);
    assert.equal(p.count("playing"), 1);
    p.stop();
  });

  test("chunks written before and after it play in order, all of them", async () => {
    const p = await helper();
    const chunks = [tone(150), tone(250), tone(100)];
    for (const c of chunks) p.send("A", c);
    await p.next("playing");
    await p.rendered(200);
    p.send("C");
    await p.next("rerouted ");
    p.send("A", tone(200));
    p.send("C"); // twice in a row
    await p.next("rerouted ");
    const heard = Number((await p.next("heard ")).line.slice(6));
    await p.next("idle");
    const total = chunks.reduce((n, c) => n + frames(c), 0) + frames(tone(200));
    assert.ok(heard >= total && heard <= total + 2 * SLICE, `heard ${heard} of ${total}`);
    assert.equal(p.count("idle"), 1);
    p.stop();
  });

  test("while idle it just comes back, and plays what comes next", async () => {
    const p = await helper();
    p.send("C");
    assert.equal((await p.next("rerouted ")).line, "rerouted 0");
    p.send("A", tone(200));
    await p.next("playing");
    assert.equal(Number((await p.next("heard ")).line.slice(6)), frames(tone(200)));
    await p.next("idle");
    p.stop();
  });

  test("a barge-in after it still drops everything at once", async () => {
    const p = await helper();
    p.send("A", tone(2000));
    await p.next("playing");
    await p.rendered(200);
    p.send("C");
    await p.next("rerouted ");
    await p.rendered(100);
    const cut = p.now();
    p.send("F");
    const idle = await p.next("idle");
    assert.ok(idle.at - cut < 150 * SLOW, `idle right away (${idle.at - cut} ms)`);
    await p.rendered(300);
    assert.equal(p.count("idle"), 1);
    p.send("A", tone(100));
    await p.next("playing");
    assert.equal(Number((await p.next("heard ")).line.slice(6)), frames(tone(100)), "what comes next plays, only it");
    p.stop();
  });
});

describe("the player when the output's format changes under it (the engine stops by itself)", { skip }, () => {
  test("mid-reply: nothing is taken for heard that wasn't; it goes on from where it was, and idle comes once, at the end", async () => {
    const p = await helper();
    const pcm = tone(3000);
    p.send("A", pcm);
    const playing = await p.next("playing");
    await p.rendered(400);
    p.send("D");
    const rerouted = await p.next("rerouted ");
    assert.equal(p.count("idle"), 0, "no idle for a reply that stopped a moment in");
    const left = Number(rerouted.line.slice(9));
    assert.ok(left >= 2000 && left <= 2700, `what hadn't played is still to play (${left} ms of 3000, stopped ~400 ms in)`);
    assert.equal((await p.next("rate ")).line, "rate 24000", "the output's new rate is said");
    const heard = Number((await p.next("heard ")).line.slice(6));
    const idle = await p.next("idle");
    assert.ok(heard >= frames(pcm), `nothing lost: heard ${heard} of ${frames(pcm)}`);
    assert.ok(heard <= frames(pcm) + SLICE, `no more than the slice it was in said again: heard ${heard} of ${frames(pcm)}`);
    assert.ok(idle.at - playing.at >= 3000, `idle once it's all played (${idle.at - playing.at} ms)`);
    await p.rendered(200);
    assert.equal(p.count("idle"), 1);
    assert.equal(p.count("playing"), 1);
    p.stop();
  });

  test("there and back (the mic opened, then closed), with more written between: all of it, in order, idle once", async () => {
    const p = await helper();
    const first = tone(1500);
    p.send("A", first);
    await p.next("playing");
    await p.rendered(300);
    p.send("D");
    await p.next("rerouted ");
    const more = tone(700);
    p.send("A", more);
    await p.rendered(400);
    p.send("D");
    const again = Number((await p.next("rerouted ")).line.slice(9));
    assert.ok(again > 500, `still more to play after the second (${again} ms)`);
    const heard = Number((await p.next("heard ")).line.slice(6));
    await p.next("idle");
    const total = frames(first) + frames(more);
    assert.ok(heard >= total && heard <= total + 2 * SLICE, `heard ${heard} of ${total}`);
    assert.equal(p.count("idle"), 1);
    assert.deepEqual(
      p.lines.filter((l) => l.line.startsWith("rate ")).map((l) => l.line),
      ["rate 48000", "rate 24000", "rate 48000"],
      "the output's rate said at start and at each change",
    );
    p.stop();
  });

  test("a barge-in while it's stopped drops everything: it doesn't come back and play it", async () => {
    const p = await helper();
    p.send("A", tone(2000));
    await p.next("playing");
    await p.rendered(200);
    p.send("D");
    p.send("F");
    await p.next("idle");
    await p.next("rerouted ");
    await p.rendered(400);
    assert.equal(p.count("idle"), 1);
    assert.equal(p.count("playing"), 1, "nothing of the dropped reply played again");
    p.send("A", tone(100));
    assert.equal(Number((await p.next("heard ")).line.slice(6)), frames(tone(100)), "only what comes next plays");
    p.stop();
  });

  test("while idle: it comes back, says the rate, and plays what comes next", async () => {
    const p = await helper();
    p.send("D");
    assert.equal((await p.next("rerouted ")).line, "rerouted 0");
    assert.equal((await p.next("rate ")).line, "rate 24000");
    p.send("A", tone(200));
    await p.next("playing");
    assert.equal(Number((await p.next("heard ")).line.slice(6)), frames(tone(200)));
    await p.next("idle");
    p.stop();
  });
});

describe("the player's two channels", { skip }, () => {
  type Helper = Awaited<ReturnType<typeof helper>>;
  type Levels = Awaited<ReturnType<Helper["levels"]>>;
  // The made-up output rendered at its own rate, as a device takes it; and a Bluetooth one, its keep-alive on for long.
  const DEVICE = { KIKO_PLAYER_OFFLINE_RENDER: "device" };
  const BT = { ...DEVICE, KIKO_PLAYER_BLUETOOTH: "1", KIKO_PLAYER_KEEPALIVE_MS: "8000" };
  const KEEPALIVE = -57; // the keep-alive's level, dBFS: 0.002 / √2 (player.swift keepAliveLevel)
  /** What "L" gave: `rate` Hz and two channels, the left at `level` (within `within` dB), the right the same as the left. */
  const same = (l: Levels, rate: number, level: number, within: number, what: string) => {
    assert.deepEqual([l.rate, l.channels], [rate, 2], `${what}: the output as it's rendered`);
    assert.ok(Math.abs(l.left - level) <= within, `${what}: the left channel at about ${level} dBFS (${l.left})`);
    assert.ok(Math.abs(l.left - l.right) <= 0.1, `${what}: the right channel the same as the left (${l.left} and ${l.right} dBFS)`);
  };
  /** Each channel's level over the next `ms` rendered. */
  const over = async (p: Helper, ms: number) => {
    await p.levels();
    await p.rendered(ms);
    return p.levels();
  };

  test("speech, as the output goes from 48 to 24 kHz and back: the same on both channels all along", async () => {
    const p = await helper(DEVICE);
    p.send("A", voice(5000));
    await p.next("playing");
    same(await over(p, 400), 48000, VOICE, 0.5, "at 48 kHz");
    p.send("D");
    await p.next("rerouted ");
    same(await over(p, 400), 24000, VOICE, 0.5, "after the change to 24 kHz");
    p.send("D");
    await p.next("rerouted ");
    same(await over(p, 400), 48000, VOICE, 0.5, "back at 48 kHz");
    assert.equal(p.count("idle"), 0, "still the one reply");
    p.stop();
  });

  test("the keep-alive on a Bluetooth output, through the same change: the same on both channels", async () => {
    const p = await helper(BT);
    p.send("A", voice(200));
    await p.next("idle");
    await p.rendered(100); // the sound's last frames are past, and the keep-alive's fade in long since
    same(await over(p, 500), 48000, KEEPALIVE, 1.5, "at 48 kHz");
    p.send("D");
    await p.next("rerouted ");
    same(await over(p, 500), 24000, KEEPALIVE, 1.5, "after the change to 24 kHz");
    p.send("D");
    await p.next("rerouted ");
    same(await over(p, 500), 48000, KEEPALIVE, 1.5, "back at 48 kHz");
    p.stop();
  });

  test("from a start at 24 kHz, two channels (the call profile already on): speech and the keep-alive the same on both", async () => {
    const p = await helper({ ...BT, KIKO_PLAYER_OFFLINE_RATE: "24000" });
    assert.equal(p.lines.find((l) => l.line.startsWith("rate "))?.line, "rate 24000");
    p.send("A", voice(1000));
    await p.next("playing");
    same(await over(p, 400), 24000, VOICE, 0.5, "speech");
    await p.next("idle");
    await p.rendered(100);
    same(await over(p, 500), 24000, KEEPALIVE, 1.5, "the keep-alive");
    p.stop();
  });

  test("the output's format changes and nothing stops the engine for it: the next sound starts on a new engine, made for the output as it is", async () => {
    // "H": the made-up output goes to 24 kHz and the engine runs on, set up for 48 kHz.
    const p = await helper(DEVICE);
    p.send("H");
    assert.equal((await p.next("rate ")).line, "rate 24000", "the output's new rate is seen");
    await p.rendered(100);
    assert.equal(p.count("rerouted"), 0, "nothing to do while it's quiet");
    assert.deepEqual([(await p.levels()).rate, (await p.levels()).channels], [48000, 2], "still the engine it was");
    const pcm = voice(600);
    p.send("A", pcm);
    assert.equal((await p.next("rerouted ")).line, "rerouted 0", "a new engine before the sound starts");
    assert.equal((await p.next("channels rerouted")).line, "channels rerouted 24000 2 24000 2 - - - - -");
    await p.next("playing");
    same(await over(p, 300), 24000, VOICE, 0.5, "the sound, on the output as it is now");
    const heard = Number((await p.next("heard ")).line.slice(6));
    assert.ok(heard >= frames(pcm) - 48 && heard <= frames(pcm) + 480, `all of it, once (heard ${heard} of ${frames(pcm)})`);
    await p.next("idle");
    // The same output for the next one: nothing more is made.
    p.send("A", voice(200));
    await p.next("idle");
    assert.equal(p.count("rerouted"), 1);
    p.stop();
  });

  test("rendered at the helper's own rate (the other tests), the output has two channels too, both the same", async () => {
    const p = await helper();
    p.send("A", voice(1000));
    await p.next("playing");
    same(await over(p, 400), 24000, VOICE, 0.5, "speech");
    p.send("C");
    await p.next("rerouted ");
    same(await over(p, 300), 24000, VOICE, 0.5, "after a device change");
    p.stop();
  });

  test("says what it plays into, and what each channel got: at start, as a sound starts, after it ends, and as its engine comes back", async () => {
    const p = await helper(DEVICE);
    // "channels <why> <device rate> <device channels> <engine rate> <engine channels> <map> <stereo> <layout> <left>
    // <right>": offline there's no output unit and no device (no map, no channels for stereo, no layout).
    assert.equal(p.lines.find((l) => l.line.startsWith("channels "))?.line, "channels start 48000 2 48000 2 - - - - -");
    p.send("A", voice(600));
    assert.equal((await p.next("channels playing")).line, "channels playing 48000 2 48000 2 - - - - -");
    const idle = (await p.next("channels idle")).line.split(" ");
    assert.deepEqual(idle.slice(2, 9), ["48000", "2", "48000", "2", "-", "-", "-"], "the output it played into");
    assert.ok(Number(idle[9]) > -25 && Number(idle[9]) < VOICE, `the left channel's level over the sound and the moment after it (${idle[9]} dBFS)`);
    assert.equal(idle[10], idle[9], "the right channel's, the same");
    p.send("D");
    assert.equal((await p.next("channels rerouted")).line, "channels rerouted 24000 2 24000 2 - - - - -");
    // A sound that starts before the last one's levels were said: they're said first, each sound its own.
    p.send("A", voice(200));
    await p.next("idle");
    p.send("A", voice(200));
    await p.next("idle");
    await p.next("channels idle");
    const order = p.lines.map((l) => l.line.split(" ").slice(0, 2).join(" ")).filter((l) => /^(playing|idle|channels (playing|idle))/.test(l));
    assert.deepEqual(
      order.slice(-8).map((l) => l.replace(/^(playing|idle) .*/, "$1")),
      ["playing", "channels playing", "idle", "channels idle", "playing", "channels playing", "idle", "channels idle"],
    );
    p.stop();
  });
});

describe("the Node side", { skip }, () => {
  /** `stallMs`: the helper's (KIKO_PLAYER_STALL_MS); `backstopMs`: the Node side's. */
  async function speaker(o: { stallMs?: number; backstopMs?: number } = {}) {
    const s = new Speaker({ backstopMs: o.backstopMs });
    const events: string[] = [];
    const stalls: Stall[] = [];
    s.onPlaying = () => events.push("playing");
    s.onIdle = () => events.push("idle");
    s.onStalled = (stall) => (events.push("stalled"), stalls.push(stall));
    s.onBack = () => events.push("back");
    // The helper reads it as it starts (and again when it's started again).
    process.env.KIKO_PLAYER_STALL_MS = String(o.stallMs ?? 5000);
    await s.start();
    const until = (n: number, ms = 5000) =>
      waitFor(
        () => events.length >= n,
        ms,
        () => `${n} events, got ${JSON.stringify(events)}`,
      );
    return { s, events, stalls, until };
  }

  test("a device change mid-speech: idle once, when it's done, and it's logged", async () => {
    const { s, events, until } = await speaker();
    const started = Date.now();
    s.write(tone(600));
    await until(1);
    await wait(200);
    s.reroute();
    await until(2);
    assert.ok(Date.now() - started >= 600, "not before it's all played");
    await wait(200);
    assert.deepEqual(events, ["playing", "idle"]);
    const [line] = logged("speaker_rerouted");
    assert.ok(line && line.unheardMs > 0, "speaker_rerouted logged with what was left");
    s.shutdown();
  });

  test("the output's format changes mid-speech (AirPods changing profile): idle once, at the end; what was left and the new output are said", async () => {
    const { s, events, until } = await speaker();
    try {
      const outputs: Array<string | null> = [];
      s.onOutput = (o) => outputs.push(o);
      assert.equal(s.output, "offline", "the output, as the helper said it at start (not Bluetooth: its name alone)");
      const started = Date.now();
      s.write(tone(1500));
      await until(1);
      await wait(300);
      s.formatChange();
      await until(2, 8000);
      assert.ok(Date.now() - started >= 1500, `not before it's all played (${Date.now() - started} ms)`);
      await wait(200);
      assert.deepEqual(events, ["playing", "idle"]);
      const line = logged("speaker_rerouted").at(-1);
      assert.ok(line && line.unheardMs >= 800, `speaker_rerouted says what was left (${line?.unheardMs} ms), not 0`);
      assert.deepEqual(
        logged("output_format")
          .slice(-2)
          .map((l) => [l.device, l.bluetooth, l.rate]),
        [
          ["offline", false, 48000],
          ["offline", false, 24000],
        ],
        "output_format: the rate at start, and the new one",
      );
      assert.deepEqual(outputs, [], "not a Bluetooth output: its rate isn't a profile, the output is the same");
    } finally {
      s.shutdown();
    }
  });

  test("what the helper plays into and what each channel got is logged (player_output): at start, with each sound, as the output's format changes", async () => {
    process.env.KIKO_PLAYER_OFFLINE_RENDER = "device";
    try {
      const from = Date.now();
      const { s, until } = await speaker();
      try {
        const mine = () => logged("player_output").filter((l) => Date.parse(l.t) >= from);
        const said = (why: string) => waitFor(() => mine().some((l) => l.why === why), 5000, `player_output logged with why "${why}"`);
        s.write(voice(500));
        await until(2);
        await said("idle"); // the sound's levels: a moment after its idle
        s.formatChange();
        await said("rerouted");
        const by = (why: string) => {
          const { t: _t, ms: _ms, event: _event, ...line } = mine().find((l) => l.why === why);
          return line;
        };
        const at48 = { device: "offline", rate: 48000, channels: 2, engineRate: 48000, engineChannels: 2, map: null, stereo: null, layout: null };
        assert.deepEqual(by("start"), { why: "start", ...at48, left: null, right: null });
        assert.deepEqual(by("playing"), { why: "playing", ...at48, left: null, right: null });
        const idle = by("idle");
        assert.deepEqual({ ...idle, left: null, right: null }, { why: "idle", ...at48, left: null, right: null });
        assert.ok(idle.left > -25 && idle.left < VOICE, `the left channel's level over the sound (${idle.left} dBFS)`);
        assert.equal(idle.right, idle.left, "the right channel's, the same");
        assert.deepEqual(by("rerouted"), { why: "rerouted", ...at48, rate: 24000, engineRate: 24000, left: null, right: null });
      } finally {
        s.shutdown();
      }
    } finally {
      delete process.env.KIKO_PLAYER_OFFLINE_RENDER;
    }
  });

  test("a Bluetooth output's rate is its profile: the output is another one, and it's told", async () => {
    process.env.KIKO_PLAYER_BLUETOOTH = "1";
    try {
      const { s } = await speaker();
      try {
        const outputs: Array<string | null> = [];
        s.onOutput = (o) => outputs.push(o);
        assert.equal(s.output, "offline@48000");
        s.formatChange();
        await waitFor(() => outputs.length === 1, 5000, "told of the output");
        assert.deepEqual([outputs[0], s.output], ["offline@24000", "offline@24000"]);
        s.formatChange();
        await waitFor(() => outputs.length === 2, 5000, "told again");
        assert.equal(s.output, "offline@48000");
      } finally {
        s.shutdown();
      }
    } finally {
      delete process.env.KIKO_PLAYER_BLUETOOTH;
    }
  });

  test("the helper dies mid-speech: idle anyway, and it's back for what comes next", async () => {
    const { s, events, until } = await speaker();
    s.write(tone(2000));
    await until(1);
    (s as any).proc.kill("SIGKILL");
    await until(2, 1000);
    assert.deepEqual(events, ["playing", "idle"], "the idle it owed");
    s.write(tone(100)); // written while it starts again: waits for it
    await until(4);
    assert.deepEqual(events, ["playing", "idle", "playing", "idle"]);
    assert.equal(logged("speaker_died").length, 1);
    s.shutdown();
  });

  test("an output that takes no sound: stalled with the device and what went unheard, then idle; back once it does", async () => {
    const { s, events, stalls, until } = await speaker({ stallMs: 1000 });
    s.deafen(true);
    const started = Date.now();
    s.write(tone(300));
    await until(3, 4000);
    assert.deepEqual(events, ["playing", "stalled", "idle"]);
    assert.ok(Date.now() - started >= 1000, "not before the stall time");
    assert.deepEqual(stalls, [{ device: "offline", unheardMs: 300 }]);
    const [line] = logged("speaker_stalled").slice(-1);
    assert.deepEqual(line && { device: line.device, unheardMs: line.unheardMs, rendering: line.rendering, by: line.by }, {
      device: "offline",
      unheardMs: 300,
      rendering: false,
      by: "player",
    });
    s.deafen(false);
    await until(4, 2000);
    assert.equal(events[3], "back");
    s.write(tone(100)); // and what comes next plays
    await until(6);
    assert.deepEqual(events.slice(4), ["playing", "idle"]);
    s.shutdown();
  });

  test("the backstop: a helper that never says idle is given up on, said as a stall, and started again", async () => {
    // The helper's own stall check is off (a minute), so only the Node side's backstop is left.
    const { s, events, stalls, until } = await speaker({ stallMs: 60_000, backstopMs: 400 });
    s.deafen(true);
    const started = Date.now();
    s.write(tone(200));
    await until(3, 3000);
    assert.deepEqual(events, ["playing", "stalled", "idle"]);
    assert.ok(Date.now() - started >= 600, `not before it should have played, and the backstop after (${Date.now() - started} ms)`);
    assert.deepEqual(stalls, [{ device: null, unheardMs: 200 }]);
    assert.equal(logged("speaker_stalled").at(-1)?.by, "backstop");
    s.write(tone(100)); // waits for the new helper, which takes sound
    await until(6);
    assert.deepEqual(events.slice(3), ["playing", "idle", "back"], "played to the end: sound is back");
    assert.equal(logged("speaker_back").at(-1)?.by, "idle");
    s.shutdown();
  });
});

/** "E": the helper's next `n` plays fail, as a device that stopped responding makes them (a 32-bit little-endian count). */
const fails = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

// An output that stopped responding (2026-11-04: iOS simulators overloading CoreAudio; on macOS 27 each play threw
// -10863 "player did not see an IO cycle", and every line was given up on). "E" makes the next plays fail. The helper
// builds its engine again and tries once more, then on the system's default output, and only then gives up (a stall,
// at once): nothing heard twice, nothing lost while it works, and the Node side logs each step.
describe("the player on an output that stopped responding", { skip }, () => {
  test("a play that fails: the engine is built again, the line tried once more, and all of it heard", async () => {
    const p = await helper();
    const pcm = tone(500);
    p.send("E", fails(1));
    p.send("A", pcm);
    const playing = await p.next("playing");
    const retry = await p.next("retry ");
    assert.equal(retry.line, "retry 1 test");
    assert.equal((await p.next("rebuilt ")).line, "rebuilt test offline", "a new engine, on the same output");
    assert.ok(retry.at - playing.at < 200 * SLOW, `tried again at once, not after a stall (${retry.at - playing.at} ms)`);
    assert.equal(Number((await p.next("heard ")).line.slice(6)), frames(pcm), "all of it, once");
    await p.next("idle");
    await p.rendered(200);
    assert.equal(p.count("fallback_default"), 0);
    assert.equal(p.count("stalled"), 0);
    assert.equal(p.count("idle"), 1);
    // The engine built again plays what comes next as any other.
    p.send("A", tone(200));
    await p.next("playing");
    assert.equal(Number((await p.next("heard ")).line.slice(6)), frames(tone(200)));
    await p.next("idle");
    assert.equal(p.count("retry"), 1, "sound heard started the count over");
    p.stop();
  });

  test("failing again: tried on the system's default output, and heard there", async () => {
    const p = await helper();
    const pcm = tone(400);
    p.send("E", fails(2));
    p.send("A", pcm);
    await p.next("playing");
    assert.equal((await p.next("retry ")).line, "retry 1 test");
    await p.next("rebuilt ");
    assert.equal((await p.next("retry ")).line, "retry 2 test");
    assert.equal((await p.next("fallback_default ")).line, "fallback_default offline");
    assert.equal((await p.next("rebuilt ")).line, "rebuilt test offline");
    assert.equal(Number((await p.next("heard ")).line.slice(6)), frames(pcm));
    await p.next("idle");
    assert.equal(p.count("stalled"), 0);
    p.stop();
  });

  test("failing on the default output too: given up on as a stall at once, then idle; the next line goes back to the default output", async () => {
    const p = await helper(); // the stall time as the app has it (5 s): this one doesn't wait for it
    p.send("E", fails(3));
    p.send("A", tone(300));
    const playing = await p.next("playing");
    await p.next("retry 1");
    await p.next("retry 2");
    await p.next("fallback_default ");
    const stalled = await p.next("stalled ", 3000);
    assert.equal(stalled.line, "stalled 300 0 offline", "what went unheard, on the device that failed");
    assert.ok(stalled.at - playing.at < 4500, `not after the stall time (${stalled.at - playing.at} ms)`);
    assert.equal((await p.next("heard ")).line, "heard 0");
    await p.next("idle");
    p.send("A", tone(200));
    await p.next("playing");
    assert.equal((await p.next("rebuilt ")).line, "rebuilt unpin offline", "off the fallback device it failed on too");
    assert.equal(Number((await p.next("heard ")).line.slice(6)), frames(tone(200)), "and the next line plays, all of it");
    await p.next("idle");
    assert.equal(p.count("stalled"), 1);
    p.stop();
  });

  test("a barge-in while it's tried again drops it at once; nothing more is tried for it", async () => {
    const p = await helper();
    p.send("E", fails(1));
    p.send("A", tone(500));
    await p.next("retry 1");
    p.send("F");
    await p.next("idle", 2000);
    await p.rendered(600); // past the retry's wait
    assert.equal(p.count("rebuilt"), 0, "nothing left to try again for");
    assert.equal(p.count("stalled"), 0);
    p.send("A", tone(200));
    await p.next("playing");
    assert.equal(Number((await p.next("heard ")).line.slice(6)), frames(tone(200)));
    p.stop();
  });

  test("the Node side: each step logged, the line heard; past the last step, a stall with the device", async () => {
    process.env.KIKO_PLAYER_STALL_MS = "5000";
    const s = new Speaker();
    const events: string[] = [];
    const stalls: Stall[] = [];
    s.onPlaying = () => events.push("playing");
    s.onIdle = () => events.push("idle");
    s.onStalled = (stall) => (events.push("stalled"), stalls.push(stall));
    await s.start();
    after(() => s.shutdown()); // even when it fails: a helper left running keeps the run from ending
    const until = (n: number, ms = 5000) =>
      waitFor(
        () => events.length >= n,
        ms,
        () => `${n} events, got ${JSON.stringify(events)}`,
      );
    s.failPlays(1);
    s.write(tone(300));
    await until(2);
    assert.deepEqual(events, ["playing", "idle"], "heard after one try more: no stall");
    assert.deepEqual(
      logged("player_retry").map((l) => [l.step, l.why]),
      [[1, "test"]],
    );
    assert.deepEqual(
      logged("player_rebuilt").map((l) => [l.why, l.device]),
      [["test", "offline"]],
    );
    // A player node still running from that line plays the next without starting again: stopped (as a barge-in
    // stops it), the next line starts it, and that's what fails.
    s.stop();
    s.failPlays(3);
    const started = Date.now();
    s.write(tone(300));
    await until(5);
    assert.deepEqual(events.slice(2), ["playing", "stalled", "idle"]);
    assert.ok(Date.now() - started < 4500, `said at once, not after the stall time (${Date.now() - started} ms)`);
    assert.deepEqual(stalls, [{ device: "offline", unheardMs: 300 }], "what the Couldn't play line says");
    assert.deepEqual(
      logged("player_fallback_default").map((l) => l.device),
      ["offline"],
    );
    assert.equal(logged("player_retry").length, 3);
    s.shutdown();
  });
});

describe("the player on an output that takes no sound", { skip }, () => {
  test("gives up after the stall time, says how much and where, then idle; back once the device takes sound", async () => {
    const p = await helper({ KIKO_PLAYER_STALL_MS: "1000" });
    p.send("S"); // the device stops taking sound: the render clock stands still
    p.send("A", tone(300));
    const playing = await p.next("playing");
    const stalled = await p.next("stalled ", 3000);
    assert.equal(stalled.line, "stalled 300 0 offline", "300 ms unheard, the clock not moving, on the offline device");
    assert.ok(stalled.at - playing.at >= 1000 && stalled.at - playing.at < 1000 + 1000 * SLOW, `after the stall time (${stalled.at - playing.at} ms)`);
    assert.equal((await p.next("heard ")).line, "heard 0");
    await p.next("idle");
    p.send("R");
    await p.next("back", 2000);
    p.send("A", tone(200));
    await p.next("playing");
    assert.equal(Number((await p.next("heard ")).line.slice(6)), frames(tone(200)), "what comes next plays, all of it");
    await p.next("idle");
    assert.equal(p.count("stalled"), 1);
    p.stop();
  });

  test("sound that plays is never taken for stalled, however much longer than the stall time it is", async () => {
    const p = await helper({ KIKO_PLAYER_STALL_MS: "500" });
    p.send("A", tone(1500));
    await p.next("playing");
    assert.equal(Number((await p.next("heard ", 4000)).line.slice(6)), frames(tone(1500)));
    await p.next("idle");
    assert.equal(p.count("stalled"), 0);
    p.stop();
  });

  test("still stalled when more comes: it's given up on too; later sound that plays is back as well", async () => {
    const p = await helper({ KIKO_PLAYER_STALL_MS: "800" });
    p.send("S");
    p.send("A", tone(200));
    await p.next("stalled ", 3000);
    await p.next("idle");
    p.send("A", tone(200));
    await p.next("stalled ", 3000);
    await p.next("idle");
    p.send("A", tone(200));
    p.send("R"); // it takes sound again with this one queued: it plays, and that's back
    await p.next("back", 2000);
    assert.equal(Number((await p.next("heard ")).line.slice(6)), frames(tone(200)));
    await p.next("idle");
    assert.equal(p.count("back"), 1);
    p.stop();
  });
});

// A Bluetooth output (2026-10-31: AirPods, whose cues were never heard): its link sleeps on silence and loses the
// first few hundred ms after it. KIKO_PLAYER_BLUETOOTH makes the offline device a Bluetooth one; the keep-alive and
// pre-roll times are short here. "Q" says how many frames came out that weren't exactly silent: the keep-alive is
// there, far below hearing ("heard" doesn't count it), and isn't once it's over, when muted, or off Bluetooth. It's
// measured over what the helper renders (its render clock, which "Q" also says), never over a sleep: on a busy machine
// a sleep and the render it stood for came apart, and a window of keep-alive read as too little (the mute test,
// 2026-11-04, failing alone: the player was right, muted it never let a frame out).
describe("the player on a Bluetooth output", { skip }, () => {
  const BT = { KIKO_PLAYER_BLUETOOTH: "1", KIKO_PLAYER_KEEPALIVE_MS: "1500", KIKO_PLAYER_PREROLL_MS: "400" };
  type Helper = Awaited<ReturnType<typeof helper>>;
  /** What came out over the next `ms` the helper renders that wasn't exactly silent, in frames. */
  const outputOver = (p: Helper, ms: number) => p.rendered(ms);

  test("says what the output is, Bluetooth or not", async () => {
    const plain = await helper();
    assert.ok(
      plain.lines.some((l) => l.line === "route 0 offline"),
      JSON.stringify(plain.lines),
    );
    plain.stop();
    const bt = await helper(BT);
    assert.ok(
      bt.lines.some((l) => l.line === "route 1 offline"),
      JSON.stringify(bt.lines),
    );
    bt.stop();
  });

  test("a cue on a sleeping link waits for it to wake, then plays all of it; the next one, at once", async () => {
    const p = await helper(BT);
    const sent = p.now();
    p.send("B", tone(130));
    await p.next("keepalive on");
    const waking = await p.next("waking ");
    const [ms, asleep] = waking.line.slice(7).split(" ").map(Number);
    assert.ok(ms! >= 350 && ms! <= 400, `waits the pre-roll (${ms} ms)`);
    assert.equal(asleep, 1, "nothing was keeping it awake");
    const playing = await p.next("playing");
    assert.ok(playing.at - sent >= 380, `plays once the link is awake (${playing.at - sent} ms)`);
    assert.equal(Number((await p.next("heard ")).line.slice(6)), frames(tone(130)), "all of it, the keep-alive not counted");
    await p.next("idle");
    // The next cue, on the link kept awake: at once.
    const again = p.now();
    p.send("B", tone(130));
    const second = await p.next("playing");
    assert.ok(second.at - again < 150 * SLOW, `at once (${second.at - again} ms)`);
    await p.next("idle");
    assert.equal(p.count("waking"), 1);
    assert.equal(p.count("playing"), 2);
    p.stop();
  });

  test("speech never waits for it", async () => {
    const p = await helper(BT);
    const sent = p.now();
    p.send("A", tone(200));
    await p.next("keepalive on");
    const playing = await p.next("playing");
    assert.ok(playing.at - sent < 150 * SLOW, `at once (${playing.at - sent} ms)`);
    assert.equal(Number((await p.next("heard ")).line.slice(6)), frames(tone(200)));
    await p.next("idle");
    assert.equal(p.count("waking"), 0);
    p.stop();
  });

  test("the keep-alive runs from a sound until its time after the last one, then stops; a cue after that waits again", async () => {
    // Its time a little longer here: what's measured right after the sound is well inside it, however busy the machine.
    const p = await helper({ ...BT, KIKO_PLAYER_KEEPALIVE_MS: "2500" });
    assert.equal(await outputOver(p, 300), 0, "nothing before any sound");
    p.send("A", tone(100));
    await p.next("keepalive on");
    const idle = await p.next("idle");
    assert.ok((await outputOver(p, 300)) > 6000, "kept awake: not silence");
    const off = await p.next("keepalive off", 5000);
    // Looked at every 500 ms: off within that of its time, give or take a busy machine.
    assert.ok(off.at - idle.at >= 2400 && off.at - idle.at < 3000 + 500 * SLOW, `its time after the last sound (${off.at - idle.at} ms)`);
    await outputOver(p, 200); // its fade out
    assert.equal(await outputOver(p, 300), 0, "silence again: the link may sleep");
    p.send("B", tone(130));
    assert.match((await p.next("waking ")).line, / 1$/);
    await p.next("idle");
    p.stop();
  });

  test("muted, nothing comes out, the keep-alive neither; unmuted, it's back", async () => {
    // The keep-alive's time as the app has it (30 s): it runs all through, so what's measured is the mute alone.
    const p = await helper({ ...BT, KIKO_PLAYER_KEEPALIVE_MS: "30000" });
    p.send("A", tone(200));
    await p.next("keepalive on");
    await p.next("idle");
    assert.ok((await outputOver(p, 200)) > 4000, "the keep-alive runs");
    p.send("V", gain(0));
    await outputOver(p, 100); // the mixer eases a change of gain in over a few ms (of what it renders)
    assert.equal(await outputOver(p, 300), 0, "silent while muted");
    p.send("A", tone(200)); // what's played muted: unheard, the keep-alive under it too
    assert.equal((await p.next("heard ")).line, "heard 0");
    await p.next("idle");
    assert.equal(await outputOver(p, 300), 0, "still silent");
    p.send("V", gain(1));
    await outputOver(p, 100);
    assert.ok((await outputOver(p, 300)) > 6000, "the keep-alive again");
    p.stop();
  });

  test("a barge-in while a cue waits drops it at once; the next cue still waits for the link", async () => {
    const p = await helper(BT);
    p.send("B", tone(130));
    await p.next("waking ");
    const cut = p.now();
    p.send("F");
    const idle = await p.next("idle");
    assert.ok(idle.at - cut < 150 * SLOW, `idle at once (${idle.at - cut} ms)`);
    p.send("B", tone(130));
    const playing = await p.next("playing");
    assert.ok(playing.at - cut >= 300, `after the link's woken (${playing.at - cut} ms)`);
    assert.equal(Number((await p.next("heard ")).line.slice(6)), frames(tone(130)), "only the second cue");
    await p.next("idle");
    p.stop();
  });

  test("not Bluetooth: no keep-alive, and a cue never waits", async () => {
    const p = await helper({ KIKO_PLAYER_KEEPALIVE_MS: "1500", KIKO_PLAYER_PREROLL_MS: "400" });
    const sent = p.now();
    p.send("B", tone(130));
    const playing = await p.next("playing");
    assert.ok(playing.at - sent < 150 * SLOW, `at once (${playing.at - sent} ms)`);
    assert.equal(Number((await p.next("heard ")).line.slice(6)), frames(tone(130)));
    await p.next("idle");
    assert.equal(await outputOver(p, 300), 0, "silence after it");
    assert.equal(p.count("waking"), 0);
    assert.equal(p.count("keepalive"), 0);
    p.stop();
  });

  test("the Node side: a cue goes as one, and the route, the keep-alive and the pre-roll are logged", async () => {
    Object.assign(process.env, BT);
    try {
      const s = new Speaker();
      const events: string[] = [];
      s.onPlaying = () => events.push("playing");
      s.onIdle = () => events.push("idle");
      await s.start();
      s.write(tone(130), true);
      await waitFor(
        () => events.length >= 2,
        3000,
        () => `playing and idle, got ${JSON.stringify(events)}`,
      );
      assert.deepEqual(events, ["playing", "idle"]);
      assert.equal(logged("output_route").at(-1)?.bluetooth, true);
      assert.equal(logged("output_keepalive").at(-1)?.on, true);
      const preroll = logged("cue_preroll").at(-1);
      assert.ok(preroll && preroll.asleep === true && preroll.ms > 0, JSON.stringify(preroll));
      s.shutdown();
    } finally {
      for (const k of Object.keys(BT)) delete process.env[k];
    }
  });
});
