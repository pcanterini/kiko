// Where the voice is in the line being said, told to the phones in order with the audio
// (voice_marks `sync`, src/remote/server.ts and opus.ts), so the phone's read-along knows exactly
// which sample of which line it's playing: at a line's start, and again only when what comes doesn't
// carry on from what came (a gap, an Opus packet padded at a pause, a phone that came mid-line, after
// audio_stop). The Opus encoder's packets of 480 samples: a line that starts mid-frame says where.
// And the words' times go to the phones that play the voice (voice_marks `words`), and the macOS
// voice's line to say comes with its words' places (speak `line`). The codec is the fake one.
import "../../setup.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fakeOpus } from "../../support/fake-opus.ts";
import { LocalPhone } from "../../support/local-phone.ts";
import { checkWaits } from "../../support/until.ts";
import type { Opus } from "../../../src/platform/types.ts";
import { type FrameMarks, parseFrame, VOICE_PACKET, VoiceEncoder } from "../../../src/remote/opus.ts";
import { Pairing } from "../../../src/remote/pairing.ts";
import { invalid } from "../../../src/remote/schema.ts";
import { PhoneServer, type PhoneHub } from "../../../src/remote/server.ts";

const until = checkWaits(3000, 5);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** `samples` of 24 kHz voice. */
const voice = (samples: number) => Buffer.alloc(samples * 2, 1);

describe("the encoder: where each frame is in the lines", () => {
  test("a line's start marked where it is in the frame; carrying on, no mark; after a padded pause, marked again", async () => {
    const frames: Array<{ count: number; marks: FrameMarks }> = [];
    const enc = new VoiceEncoder(fakeOpus(), (_p, count, marks) => frames.push({ count, marks }), { idleMs: 1000, endMs: 60 });
    // Line 1: 700 samples (one packet out, 220 waiting), then line 2 starts at once, 220 samples into a packet.
    enc.push(voice(700), { line: 1, at: 0 });
    enc.push(voice(2000), { line: 2, at: 0 });
    await until(() => frames.length >= 1);
    assert.deepEqual(frames[0].marks.marks, [{ line: 1, at: 0, offset: 0 }]);
    assert.deepEqual(frames[0].marks.head, { line: 1, at: 0 });
    await until(() => frames.reduce((n, f) => n + f.count, 0) === 6, 1000); // 2700 samples: 6 packets, padded
    const all = frames.flatMap((f) => f.marks.marks);
    assert.deepEqual(all, [
      { line: 1, at: 0, offset: 0 },
      { line: 2, at: 0, offset: 700 - VOICE_PACKET },
    ]);
    // After the padded end, line 2 carries on: it starts on the next packet, marked again there.
    enc.push(voice(VOICE_PACKET), { line: 2, at: 2000 });
    await until(() => frames.length === 3, 1000);
    assert.deepEqual(frames[2].marks.marks, [{ line: 2, at: 2000, offset: 0 }]);
    enc.stop();
  });

  test("one carrying on from the last sent: its head says where, for a phone that missed the mark", async () => {
    const frames: FrameMarks[] = [];
    const enc = new VoiceEncoder(fakeOpus(), (_p, _count, marks) => frames.push(marks), { idleMs: 1000, endMs: 5000 });
    enc.push(voice(VOICE_PACKET), { line: 5, at: 0 });
    for (let i = 1; i <= 5; i++) enc.push(voice(VOICE_PACKET), { line: 5, at: i * VOICE_PACKET });
    await until(() => frames.length === 2);
    assert.deepEqual(frames[1], { marks: [], head: { line: 5, at: VOICE_PACKET } });
    enc.stop();
  });

  test("audio of no line (and after a cut): no marks, no head", async () => {
    const frames: FrameMarks[] = [];
    const enc = new VoiceEncoder(fakeOpus(), (_p, _count, marks) => frames.push(marks), { idleMs: 1000, endMs: 5000 });
    enc.push(voice(VOICE_PACKET), { line: 5, at: 0 });
    enc.cut();
    enc.push(voice(VOICE_PACKET));
    await until(() => frames.length === 1);
    assert.deepEqual(frames[0], { marks: [], head: null });
    enc.stop();
  });
});

// ── Through a real server ─────────────────────────────────────────────────

/** A phone that keeps everything it's sent, text and binary, in the order it came. */
function phone(port: number) {
  const ws = new LocalPhone(`ws://127.0.0.1:${port}`);
  const got: any[] = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) return void got.push({ type: "binary", frame: parseFrame(Buffer.from(data as Buffer), 1) });
    const m = JSON.parse(String(data));
    assert.equal(invalid(m, "hub"), null, JSON.stringify(m));
    got.push(m);
  });
  const opened = new Promise<void>((resolve) => ws.once("open", () => resolve()));
  return {
    got,
    async send(m: Record<string, unknown>) {
      await opened;
      ws.send(JSON.stringify({ v: 1, ...m }));
    },
    next(type: string) {
      return until(() => got.some((m) => m.type === type)).then(() => got.find((m) => m.type === type));
    },
    close: () => ws.close(),
  };
}

async function setUp(name: string, opus: Opus | null) {
  const hub: PhoneHub = {
    talkStart: () => null,
    talkAudio: () => {},
    talkEnd: () => {},
    type: () => null,
    permission: () => null,
    answers: () => null,
    talking: () => false,
    playOnMac: () => {},
    catchUp: () => {},
    catchUpSummary: () => {},
    catchUpStop: () => false,
  };
  const pairing = new Pairing(join(process.cwd(), `phones-sync-${name}.json`));
  const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
  const server = new PhoneServer({ hub, pairing, port: 0, host: "127.0.0.1", network, presenceMs: 60_000, opus });
  const port = await server.start();
  const p = phone(port);
  await p.send({ type: "pair", code: pairing.open().code, device: "Test iPhone", appVersion: "0.1.0" });
  await p.next("welcome");
  await p.send({ type: "presence", state: "back" });
  await p.send({ type: "play_on_phone", on: true });
  await until(() => server.audible());
  return { server, p, pairing, port };
}

/** What a phone got of the voice, in order: `sync line@at+offset`, `audio n`, `frame n`, `audio_stop`. */
const voiceLog = (got: any[]) =>
  got.flatMap((m) => {
    if (m.type === "voice_marks" && m.sync) return [`sync ${m.line}@${m.sync.at}+${m.sync.offset}`];
    if (m.type === "audio" && !m.cue) return [`audio ${Buffer.from(m.data, "base64").length / 2}`];
    if (m.type === "binary" && !("error" in m.frame)) return [`frame ${m.frame.count}`];
    if (m.type === "audio_stop") return ["audio_stop"];
    return [];
  });

describe("through a real server", () => {
  test("PCM: a sync just before each line's first audio and after a gap, none while it carries on; again after audio_stop", async () => {
    const { server, p } = await setUp("pcm", null);
    try {
      server.audio(voice(480), { line: 9, at: 0 });
      server.audio(voice(480), { line: 9, at: 480 });
      server.audio(voice(480), { line: 9, at: 1440 }); // a chunk this phone never got: told where
      server.audio(voice(240), { line: 10, at: 0 });
      server.audio(voice(100)); // no line: nothing said of it
      server.audio(voice(240), { line: 10, at: 240 }); // after audio of no line: told again
      server.stopAudio();
      server.audio(voice(480), { line: 10, at: 480 });
      await until(() => voiceLog(p.got).length === 13);
      assert.deepEqual(voiceLog(p.got), [
        "sync 9@0+0",
        "audio 480",
        "audio 480",
        "sync 9@1440+0",
        "audio 480",
        "sync 10@0+0",
        "audio 240",
        "audio 100",
        "sync 10@240+0",
        "audio 240",
        "audio_stop",
        "sync 10@480+0",
        "audio 480",
      ]);
    } finally {
      p.close();
      server.stop();
    }
  });

  test("Opus: the sync before the frame it's about, with where in it the line starts; a phone that comes mid-line told the frame's own place", async () => {
    const { server, p, pairing, port } = await setUp("opus", fakeOpus());
    try {
      await p.send({ type: "audio_codecs", codecs: ["opus"] });
      assert.equal((await p.next("audio_codec")).codec, "opus");
      server.audio(voice(VOICE_PACKET), { line: 3, at: 0 }); // the first packet: alone, at once
      await until(() => voiceLog(p.got).length === 2);
      assert.deepEqual(voiceLog(p.got), ["sync 3@0+0", "frame 1"]);
      // A second phone comes now, mid-line.
      const q = phone(port);
      await q.send({ type: "pair", code: pairing.open().code, device: "Second iPhone", appVersion: "0.1.0" });
      await q.next("welcome");
      await q.send({ type: "presence", state: "back" });
      await q.send({ type: "play_on_phone", on: true });
      await q.send({ type: "audio_codecs", codecs: ["opus"] });
      await q.next("audio_codec");
      await wait(50);
      for (let i = 1; i <= 4; i++) server.audio(voice(VOICE_PACKET), { line: 3, at: i * VOICE_PACKET });
      server.audio(voice(200), { line: 3, at: 5 * VOICE_PACKET });
      server.audio(voice(1000), { line: 4, at: 0 }); // line 4 starts 200 samples into the 6th packet
      // Line 3 started at stream sample 0, line 4 at 480 + 4 × 480 + 200 = 2600: in the second frame
      // (samples 480 to 2880), 2120 in. Then the rest at idle, and the tail padded once it's over.
      await until(() => voiceLog(p.got).filter((x) => x.startsWith("frame")).length === 4, 2000);
      assert.deepEqual(voiceLog(p.got), ["sync 3@0+0", "frame 1", "sync 4@0+2120", "frame 5", "frame 1", "frame 1"]);
      await until(() => voiceLog(q.got).filter((x) => x.startsWith("frame")).length === 3, 2000);
      assert.deepEqual(voiceLog(q.got), [`sync 3@${VOICE_PACKET}+0`, "sync 4@0+2120", "frame 5", "frame 1", "frame 1"], "the late phone: where its first frame starts, then as the first");
      // After the padded tail, line 4 goes on at its next sample: on a new packet, told again.
      server.audio(voice(VOICE_PACKET), { line: 4, at: 1000 });
      await until(() => voiceLog(p.got).length === 8);
      assert.deepEqual(voiceLog(p.got).slice(6), ["sync 4@1000+0", "frame 1"]);
      q.close();
    } finally {
      p.close();
      server.stop();
    }
  });

  test("the words' times and the macOS voice's line go to the phones that play the voice", async () => {
    const { server, p } = await setUp("words", null);
    try {
      server.voiceMarks({ line: 2, words: [{ i: 0, text: "Hi", start: 0, end: 4800 }], exact: true });
      server.voiceMarks({ line: 2, words: [], exact: true }); // nothing: not sent
      server.speak("Restarted engine-x.", {
        line: 3,
        words: [
          { i: 0, text: "Restarted", from: 0, to: 9 },
          { i: 1, text: "nginx.", from: 10, to: 19 },
        ],
      });
      server.speak("No line.");
      await until(() => p.got.filter((m) => m.type === "speak").length === 2);
      const marks = p.got.filter((m) => m.type === "voice_marks" || m.type === "speak");
      assert.deepEqual(marks, [
        { v: 1, type: "voice_marks", line: 2, words: [{ i: 0, text: "Hi", start: 0, end: 4800 }], exact: true },
        {
          v: 1,
          type: "voice_marks",
          line: 3,
          words: [
            { i: 0, text: "Restarted", from: 0, to: 9 },
            { i: 1, text: "nginx.", from: 10, to: 19 },
          ],
          exact: true,
        },
        { v: 1, type: "speak", text: "Restarted engine-x.", line: 3 },
        { v: 1, type: "speak", text: "No line." },
      ]);
    } finally {
      p.close();
      server.stop();
    }
  });
});
