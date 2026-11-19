// Opus on the phone link (src/remote/opus.ts, src/remote/server.ts): which codec a connection gets
// (an older app, or one with Compressed audio off, stays on PCM in JSON exactly as before; a hub
// without Opus offers none; both taking it: Opus), the binary frames, the voice's encoder (the first
// packet of a stretch at once, then five to a message, the tail sent once the line is over, nothing
// of a cut line after audio_stop), and a press's audio decoded in order and all of it heard before
// the press ends. The codec here is a fake one, so the timing is the server's own; the real one
// (native/macos/opus.swift) has its own round trip below, on a made-up voice-like sound. Real
// speech (macOS `say`) and speech-to-text on what it decoded only with KIKO_SPEECH_LIVE=1: `say`
// once hung the whole unit run for minutes (2026-11-02).
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { LocalPhone } from "../../support/local-phone.ts";
import type { Opus } from "../../../src/platform/types.ts";
import { frame, joinPackets, KIND, parseFrame, pickCodec, splitPackets, TalkDecoder, VoiceEncoder } from "../../../src/remote/opus.ts";
import { Pairing } from "../../../src/remote/pairing.ts";
import { invalid } from "../../../src/remote/schema.ts";
import { PhoneServer, type PhoneHub } from "../../../src/remote/server.ts";
import { fakeOpus } from "../../support/fake-opus.ts";
import { checkWaits } from "../../support/until.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = checkWaits(3000, 5);

/** `ms` of PCM at `rate`, every sample `value`. */
const pcm = (ms: number, rate: number, value = 1000) => {
  const b = Buffer.alloc((rate / 1000) * ms * 2);
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(value, i);
  return b;
};

describe("which codec", () => {
  test("the first of the phone's (best first) that the hub has; PCM otherwise", () => {
    assert.equal(pickCodec(["opus"], ["opus"]), "opus", "both take it");
    assert.equal(pickCodec(null, ["opus"]), "pcm", "an older phone says nothing");
    assert.equal(pickCodec([], ["opus"]), "pcm", "the phone's Compressed audio is off");
    assert.equal(pickCodec(["opus"], []), "pcm", "a hub without Opus");
    assert.equal(pickCodec(["lyra", "opus"], ["opus"]), "opus", "one the hub doesn't know is skipped");
  });
});

describe("binary frames", () => {
  test("packets behind 2-byte lengths, after the version and the kind", () => {
    const packets = [Buffer.from([1, 2, 3]), Buffer.alloc(300, 7)];
    const joined = joinPackets(packets);
    assert.deepEqual([...joined.subarray(0, 2)], [0, 3]);
    assert.deepEqual([...joined.subarray(5, 7)], [1, 44], "300 big-endian");
    assert.deepEqual(splitPackets(joined), packets);
    const f = frame(1, KIND.talk, joined);
    assert.deepEqual([...f.subarray(0, 2)], [1, 1]);
    const parsed = parseFrame(f, 1);
    assert.ok(!("error" in parsed));
    assert.deepEqual([parsed.kind, parsed.count], [KIND.talk, 2]);
    assert.deepEqual(parsed.packets, joined);
    assert.equal(parseFrame(frame(1, KIND.voice, joined), 1).hasOwnProperty("error"), false);
  });

  test("what isn't one is caught, with why", () => {
    const ok = joinPackets([Buffer.from([9])]);
    assert.match((parseFrame(Buffer.from([1]), 1) as { error: string }).error, /shorter than its header/);
    assert.match((parseFrame(frame(2, KIND.talk, ok), 1) as { error: string }).error, /version 2/);
    assert.match((parseFrame(Buffer.concat([Buffer.from([1, 9]), ok]), 1) as { error: string }).error, /kind 9/);
    assert.match((parseFrame(frame(1, KIND.talk, Buffer.from([0, 5, 1])), 1) as { error: string }).error, /run past its end/);
    assert.match((parseFrame(frame(1, KIND.talk, Buffer.from([0])), 1) as { error: string }).error, /run past its end/);
    assert.match((parseFrame(frame(1, KIND.talk, Buffer.alloc(0)), 1) as { error: string }).error, /no packets/);
    assert.equal(splitPackets(Buffer.from([0, 0])), null, "an empty packet");
    assert.throws(() => joinPackets([Buffer.alloc(0)]));
  });
});

describe("the voice's encoder", () => {
  test("the first packet of a stretch at once, then five to a message; the tail padded once the line is over", async () => {
    const sent: number[] = [];
    const enc = new VoiceEncoder(fakeOpus(), (_p, count) => sent.push(count), { idleMs: 1000, endMs: 60 });
    enc.push(pcm(20, 24_000)); // the first frame
    await until(() => sent.length === 1);
    assert.deepEqual(sent, [1], "the first frame went alone, at once");
    for (let i = 0; i < 12; i++) enc.push(pcm(20, 24_000));
    await until(() => sent.length === 3);
    assert.deepEqual(sent, [1, 5, 5]);
    enc.push(pcm(30, 24_000)); // three frames' worth with what's left: 2 ready, half a frame waiting
    await until(() => sent.length === 4, 1000);
    assert.deepEqual(sent, [1, 5, 5, 4], "the line over: the 2 ready, one more, and the half frame padded");
    // The next line starts a new stretch: its first frame at once.
    enc.push(pcm(20, 24_000));
    await until(() => sent.length === 5);
    assert.deepEqual(sent.at(-1), 1);
    enc.stop();
  });

  test("what's ready goes once nothing more has come for a moment", async () => {
    const sent: number[] = [];
    const enc = new VoiceEncoder(fakeOpus(), (_p, count) => sent.push(count), { idleMs: 30, endMs: 5000 });
    enc.push(pcm(80, 24_000));
    await until(() => sent.length === 1);
    assert.deepEqual(sent, [4], "a first chunk of 4 frames goes at once, whole");
    enc.push(pcm(40, 24_000));
    await until(() => sent.length === 2);
    assert.deepEqual(sent, [4, 2], "two frames, not five, after the pause");
    enc.stop();
  });

  test("cut (barge-in): nothing more of the line goes, and a new encoder starts the next", async () => {
    const opus = fakeOpus({ delayMs: 20 });
    const sent: Buffer[] = [];
    const enc = new VoiceEncoder(opus, (p) => sent.push(p), { idleMs: 10, endMs: 30 });
    enc.push(pcm(200, 24_000));
    enc.cut(); // before its answer came
    await wait(100);
    assert.deepEqual(sent, [], "nothing of the cut line");
    enc.push(pcm(20, 24_000, 7));
    await until(() => sent.length === 1);
    assert.deepEqual(opus.opened, ["encoder 24000", "encoder 24000"]);
    assert.equal(splitPackets(sent[0])![0][0], 0, "the new encoder's first packet");
    enc.stop();
  });
});

describe("a press's audio decoded", () => {
  test("in the order it came, PCM in JSON behind what's still decoding; drained once all of it is through", async () => {
    const got: number[] = [];
    const dec = new TalkDecoder(fakeOpus({ delayMs: 15 }), (b) => got.push(b.readInt16LE(0)));
    const packet = (v: number) => joinPackets([Buffer.from([0, 0x55, v & 0xff, v >> 8])]);
    dec.packetsIn(packet(1), 1);
    dec.pcmIn(pcm(20, 16_000, 2));
    dec.packetsIn(packet(3), 1);
    assert.equal(await dec.drained(), true);
    assert.deepEqual(got, [1, 2, 3]);
    assert.equal(dec.pcmBytes, 3 * 640);
    dec.close();
  });
});

// ── Through a real server ─────────────────────────────────────────────────

function phone(port: number) {
  const ws = new LocalPhone(`ws://127.0.0.1:${port}`);
  const got: any[] = [];
  const binary: Buffer[] = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) return void binary.push(Buffer.from(data as Buffer));
    const m = JSON.parse(String(data));
    assert.equal(invalid(m, "hub"), null, JSON.stringify(m));
    got.push(m);
  });
  const opened = new Promise<void>((resolve) => ws.once("open", () => resolve()));
  return {
    got,
    binary,
    async send(m: Record<string, unknown>) {
      await opened;
      const text = JSON.stringify({ v: 1, ...m });
      assert.equal(invalid(JSON.parse(text), "phone"), null, text);
      ws.send(text);
    },
    async sendBinary(b: Buffer) {
      await opened;
      ws.send(b);
    },
    next(type: string) {
      return until(() => got.some((m) => m.type === type)).then(() => got.find((m) => m.type === type));
    },
    close() {
      ws.close();
    },
  };
}

function logged(event: string): any[] {
  return readdirSync("logs")
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join("logs", f), "utf8").split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === event);
}

async function setUp(name: string, opus: Opus | null) {
  const heard: Buffer[] = [];
  const events: string[] = [];
  let talking = false;
  const hub: PhoneHub = {
    talkStart: () => ((talking = true), events.push("start"), null),
    talkAudio: (b) => void (heard.push(b), events.push(`audio ${b.readInt16LE(0)}`)),
    talkEnd: (cancel) => void ((talking = false), events.push(cancel ? "cancel" : "end")),
    type: () => null,
    permission: () => null,
    answers: () => null,
    talking: () => talking,
    playOnMac: () => {},
    catchUp: () => {},
    catchUpSummary: () => {},
    catchUpStop: () => false,
  };
  const pairing = new Pairing(join(process.cwd(), `phones-opus-${name}.json`));
  const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
  const server = new PhoneServer({ hub, pairing, port: 0, host: "127.0.0.1", network, presenceMs: 60_000, opus });
  const port = await server.start();
  const p = phone(port);
  await p.send({ type: "pair", code: pairing.open().code, device: "Test iPhone", appVersion: "0.1.0" });
  const welcome = await p.next("welcome");
  await p.send({ type: "presence", state: "back" });
  await p.send({ type: "play_on_phone", on: true });
  await until(() => server.audible());
  return { server, p, welcome, heard, events, phoneId: welcome.phoneId as string };
}

describe("agreeing on it, through a real server", () => {
  test("an older app (it never says): PCM in JSON both ways, exactly as before", async () => {
    const { server, p, welcome, heard, events, phoneId } = await setUp("old-app", fakeOpus());
    try {
      assert.deepEqual(welcome.codecs, ["opus"], "the hub says it takes Opus; an older app ignores it");
      const voice = pcm(80, 24_000, 300);
      server.audio(voice);
      await p.next("audio");
      assert.deepEqual(
        p.got.find((m) => m.type === "audio"),
        { v: 1, type: "audio", data: voice.toString("base64"), rate: 24000 },
      );
      assert.equal(p.binary.length, 0);
      const mine = pcm(100, 16_000, 5);
      await p.send({ type: "talk_start" });
      await p.send({ type: "talk_audio", data: mine.toString("base64") });
      await p.send({ type: "talk_end" });
      await until(() => events.includes("end"));
      assert.deepEqual(heard, [mine], "the same bytes reach speech-to-text");
      assert.deepEqual(events, ["start", "audio 5", "end"]);
      assert.deepEqual(
        logged("phone_connected")
          .filter((l) => l.phoneId === phoneId)
          .map((l) => l.codec),
        ["pcm"],
      );
      assert.deepEqual(
        logged("phone_audio_codec").filter((l) => l.phoneId === phoneId),
        [],
      );
    } finally {
      p.close();
      server.stop();
    }
  });

  test("the app's Compressed audio off (it takes none): PCM, said and logged", async () => {
    const { server, p, phoneId } = await setUp("compressed-off", fakeOpus());
    try {
      await p.send({ type: "audio_codecs", codecs: [] });
      assert.equal((await p.next("audio_codec")).codec, "pcm");
      server.audio(pcm(40, 24_000));
      await p.next("audio");
      assert.equal(p.binary.length, 0);
      const line = logged("phone_audio_codec").find((l) => l.phoneId === phoneId);
      assert.deepEqual([line.codec, line.theirs, line.ours], ["pcm", [], ["opus"]]);
    } finally {
      p.close();
      server.stop();
    }
  });

  test("a hub without Opus offers none, and one asked anyway answers PCM", async () => {
    const { server, p } = await setUp("no-opus", null);
    try {
      assert.equal("codecs" in (await p.next("welcome")), false, "welcome as before");
      await p.send({ type: "audio_codecs", codecs: ["opus"] });
      assert.equal((await p.next("audio_codec")).codec, "pcm");
      // Binary audio from it is refused, not taken for anything.
      await p.send({ type: "talk_start" });
      await p.sendBinary(frame(1, KIND.talk, joinPackets([Buffer.from([0, 0x55, 1, 0])])));
      await until(() => p.got.some((m) => m.type === "error" && m.code === "invalid"));
    } finally {
      p.close();
      server.stop();
    }
  });

  test("both take it: Opus both ways in binary frames; a press decoded and all heard before it ends; cut at audio_stop", async () => {
    const opus = fakeOpus({ delayMs: 5 });
    const { server, p, events, heard, phoneId } = await setUp("both", opus);
    try {
      // Binary before agreeing is refused.
      await p.sendBinary(frame(1, KIND.talk, joinPackets([Buffer.from([0, 0x55, 1, 0])])));
      await until(() => p.got.some((m) => m.type === "error" && /before agreeing/.test(m.message)));
      await p.send({ type: "audio_codecs", codecs: ["opus"] });
      assert.equal((await p.next("audio_codec")).codec, "opus");
      const line = logged("phone_audio_codec").find((l) => l.phoneId === phoneId);
      assert.deepEqual([line.codec, line.was, line.theirs, line.ours], ["opus", "pcm", ["opus"], ["opus"]]);

      // Down: the voice in binary frames, the first packet at once; no PCM audio for this phone.
      server.audio(pcm(20, 24_000, 300));
      await until(() => p.binary.length === 1);
      const first = parseFrame(p.binary[0], 1);
      assert.ok(!("error" in first));
      assert.deepEqual([first.kind, first.count], [KIND.voice, 1]);
      for (let i = 0; i < 5; i++) server.audio(pcm(20, 24_000, 300));
      await until(() => p.binary.length === 2);
      assert.equal((parseFrame(p.binary[1], 1) as { count: number }).count, 5);
      assert.equal(p.got.filter((m) => m.type === "audio").length, 0);
      // A cue stays PCM in JSON.
      server.cue(pcm(30, 24_000), phoneId);
      await p.next("audio");
      assert.equal(p.got.find((m) => m.type === "audio").cue, true);
      // Barge-in: audio_stop, and nothing of what was cut after it.
      server.audio(pcm(60, 24_000, 300));
      server.stopAudio();
      await p.next("audio_stop");
      const atStop = p.binary.length;
      await wait(400);
      assert.equal(p.binary.length, atStop, "nothing of the cut line after audio_stop");

      // Up: a press in binary frames, decoded to 16 kHz in order, all of it before the end.
      await p.send({ type: "talk_start" });
      const packet = (v: number) => Buffer.from([0, 0x55, v, 0]);
      await p.sendBinary(frame(1, KIND.talk, joinPackets([packet(1)])));
      await p.sendBinary(frame(1, KIND.talk, joinPackets([packet(2), packet(3), packet(4), packet(5), packet(6)])));
      await p.send({ type: "talk_end" });
      // The next press right away waits behind the last one's decoding, in order.
      await p.send({ type: "talk_start" });
      await p.sendBinary(frame(1, KIND.talk, joinPackets([packet(9)])));
      await p.send({ type: "talk_cancel" });
      await until(() => events.filter((e) => e === "start").length === 2 && events.includes("cancel"));
      // Each frame's packets come out as one stretch of PCM (the fake's samples say which packet began it).
      assert.deepEqual(events, ["start", "audio 1", "audio 2", "end", "start", "cancel"]);
      assert.deepEqual(
        heard.slice(-2).map((b) => b.length),
        [640, 5 * 640],
        "16 kHz, 20 ms a packet",
      );
      assert.deepEqual(
        opus.opened.filter((o) => o.startsWith("decoder")),
        ["decoder 16000", "decoder 16000"],
      );
      // Audio after its end is late, as in JSON.
      await p.sendBinary(frame(1, KIND.talk, joinPackets([packet(7)])));
      await until(() => p.got.some((m) => m.type === "error" && m.code === "not_talking"));
      // A voice frame from the phone isn't taken.
      await p.send({ type: "talk_start" });
      await p.sendBinary(frame(1, KIND.voice, joinPackets([packet(8)])));
      await until(() => p.got.some((m) => m.type === "error" && /hub's kind/.test(m.message)));
      await p.send({ type: "talk_end" });
      // Switched off on the phone: PCM from now on.
      await p.send({ type: "audio_codecs", codecs: [] });
      await until(() => p.got.filter((m) => m.type === "audio_codec").length === 2);
      server.audio(pcm(20, 24_000, 300));
      await until(() => p.got.filter((m) => m.type === "audio" && !m.cue).length === 1);
    } finally {
      p.close();
      server.stop();
    }
    await until(() => logged("phone_disconnected").some((l) => l.phoneId === phoneId));
    const gone = logged("phone_disconnected").find((l) => l.phoneId === phoneId);
    assert.equal(gone.codec, "pcm");
    assert.ok(gone.audioBytesIn > 0 && gone.audioBytesOut > 0);
  });
});

// ── The real codec (native/macos/opus.swift) ─────────────────────────────

const skip = process.platform !== "darwin" || spawnSync("which", ["swiftc"]).status !== 0 ? "needs macOS and swiftc" : false;
// Real speech: macOS `say`, and the Apple recognizer on what came back. Opt in: it speaks for seconds
// and has hung before.
const LIVE = process.env.KIKO_SPEECH_LIVE === "1";
const liveSkip = skip || (!LIVE ? "real speech: KIKO_SPEECH_LIVE=1 runs it" : spawnSync("which", ["say"]).status !== 0 ? "needs say" : false);

/** `say` reading `text` as 16-bit mono PCM at `rate`; given up on after 30 s, never left running. */
function say(text: string, rate: number) {
  const file = join(process.cwd(), `say-${rate}.wav`);
  const r = spawnSync("say", ["-o", file, `--data-format=LEI16@${rate}`, text], { timeout: 30_000, killSignal: "SIGKILL" });
  assert.equal(r.error, undefined, `say: ${r.error?.message}`);
  assert.equal(r.status, 0, String(r.stderr));
  const wav = readFileSync(file);
  return wav.subarray(wav.indexOf("data") + 8);
}

/**
 * Three seconds of something voice-like, 16-bit mono at `rate`, made here: a wavering pitch with its
 * harmonics, in syllables four times a second, with a little noise. Enough for the codec's sizes and
 * energy; real speech is KIKO_SPEECH_LIVE's.
 */
function voiceLike(rate: number, seconds = 3) {
  const pcm = Buffer.alloc(rate * seconds * 2);
  let phase = 0;
  let seed = 1;
  const noise = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31) * 2 - 1;
  for (let i = 0; i < pcm.length / 2; i++) {
    const t = i / rate;
    phase += (2 * Math.PI * (140 + 30 * Math.sin(2 * Math.PI * 1.3 * t))) / rate;
    let v = 0;
    for (let h = 1; h <= 12; h++) v += Math.sin(h * phase) / h;
    const syllable = Math.max(0, Math.sin(2 * Math.PI * 4 * t)) ** 0.5;
    pcm.writeInt16LE(Math.round((v * 0.6 + noise() * 0.05) * syllable * 6000), i * 2);
  }
  return pcm;
}

describe("Apple's Opus, for real", { skip }, () => {
  const TEXT = "Tell the clipkit session to run the tests and commit when they pass.";

  for (const rate of [16_000, 24_000]) {
    test(`${rate / 1000} kHz: encoded to ~24 kbps in 20 ms packets, decoded back to as many samples`, async () => {
      const { opus } = await import("../../../src/platform/macos/opus.ts");
      assert.equal(opus.available(), true);
      const speech = LIVE ? say(TEXT, rate) : voiceLike(rate);
      const enc = opus.encoder(rate, 24_000);
      const parts: Buffer[] = [];
      const chunk = (rate / 10) * 2; // 100 ms, as the phone sends
      for (let i = 0; i < speech.length; i += chunk) parts.push(await enc.push(speech.subarray(i, i + chunk)));
      parts.push(await enc.flush());
      enc.close();
      const packets = splitPackets(Buffer.concat(parts))!;
      const frames = Math.ceil(speech.length / ((rate / 50) * 2));
      assert.equal(packets.length, frames, "one packet per 20 ms frame");
      const seconds = speech.length / 2 / rate;
      const kbps = (packets.reduce((n, p) => n + p.length, 0) * 8) / seconds / 1000;
      assert.ok(kbps > 12 && kbps < 30, `${kbps.toFixed(1)} kbps`);
      const dec = opus.decoder(rate);
      const out = Buffer.concat([await dec.push(joinPackets(packets.slice(0, 1))), await dec.push(joinPackets(packets.slice(1)))]);
      dec.close();
      // As many samples as were encoded (padded to the frame), less the decoder's priming (2.5 ms).
      assert.equal(out.length, frames * (rate / 50) * 2 - (rate / 400) * 2);
      // The same speech: most of its energy comes back.
      const energy = (b: Buffer) => {
        let e = 0;
        for (let i = 0; i + 1 < b.length; i += 2) e += b.readInt16LE(i) ** 2;
        return e;
      };
      const ratio = energy(out) / energy(speech);
      assert.ok(ratio > 0.5 && ratio < 1.5, `energy ratio ${ratio.toFixed(2)}`);
    });
  }

  test("speech-to-text (the Mac's Apple recognizer) still hears the words after Opus at 16 kHz", { skip: liveSkip, timeout: 60_000 }, async (t) => {
    const { opus } = await import("../../../src/platform/macos/opus.ts");
    const { AppleTranscriber } = await import("../../../src/platform/macos/apple-stt.ts");
    const speech = say(TEXT, 16_000);
    const enc = opus.encoder(16_000, 24_000);
    const packets = Buffer.concat([await enc.push(speech), await enc.flush()]);
    enc.close();
    const dec = opus.decoder(16_000);
    const decoded = await dec.push(packets);
    dec.close();
    const stt = new AppleTranscriber();
    try {
      await Promise.race([stt.connect(), wait(20_000).then(() => Promise.reject(new Error("not ready in 20 s")))]);
    } catch (err) {
      stt.close();
      return t.skip(`the Apple recognizer isn't available here: ${err instanceof Error ? err.message : err}`);
    }
    try {
      const hear = async (audio: Buffer) => {
        stt.begin();
        for (let i = 0; i < audio.length; i += 3200) stt.send(audio.subarray(i, i + 3200));
        return (await stt.finish()).toLowerCase();
      };
      const words = (s: string) =>
        s
          .replace(/[^a-z ]/g, "")
          .split(/\s+/)
          .filter(Boolean);
      const raw = await hear(speech);
      const viaOpus = await hear(decoded);
      const expected = words(TEXT.toLowerCase());
      const hits = (heard: string) => expected.filter((w) => words(heard).includes(w)).length;
      t.diagnostic(`raw: "${raw}" · through Opus: "${viaOpus}"`);
      assert.ok(hits(viaOpus) >= expected.length - 2, `through Opus: "${viaOpus}" (raw: "${raw}")`);
      assert.ok(hits(viaOpus) >= hits(raw) - 1, `through Opus: "${viaOpus}" vs raw "${raw}"`);
    } finally {
      stt.close();
    }
  });
});
