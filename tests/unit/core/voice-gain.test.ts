// A custom voice's volume: its sidecar (<Name>.json beside the voice, src/core/pocket-voices.ts
// voiceGain, saveVoiceGain), the gain on Pocket's s16 PCM with its limiter (src/core/voice-gain.ts),
// and Settings → Voice → Volume, shown only for one of your voices (settings-options.ts
// voiceVolumeRow). Every voices folder is a temp one, never ~/.config/kiko*. What Pocket's audio
// comes out as for such a voice is in pocket-voices.test.ts.
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { saveVoiceGain, voiceGain, voiceSidecar } from "../../../src/core/pocket-voices.ts";
import { CEILING, gainStream, KNEE, softKnee } from "../../../src/core/voice-gain.ts";
import { choicesFor, VOICE_VOLUMES, voiceVolumeRow } from "../../../src/core/settings-options.ts";
import { filterSettings } from "../../../src/ui/settings.ts";
import type { SettingRow } from "../../../src/core/ui-store.ts";

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "voice-gain-")));

const pcmOf = (samples: number[]) => {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
};
const samplesOf = (buf: Buffer) => Array.from({ length: buf.length / 2 }, (_, i) => buf.readInt16LE(i * 2));
const db = (x: number) => 20 * Math.log10(x / 32768);

describe("the sidecar: <Name>.json beside the voice", () => {
  test("none: 0 dB, nothing to say", () => {
    assert.deepEqual(voiceGain("Marlo", tempDir()), { gainDb: 0 });
  });

  test("its gainDb, kept to -6..+12; no gainDb: 0 dB", () => {
    const dir = tempDir();
    const file = voiceSidecar("Marlo", dir);
    assert.equal(file, join(dir, "Marlo.json"));
    for (const [text, gainDb] of [
      ['{ "gainDb": 5 }', 5],
      ['{ "gainDb": -2.5 }', -2.5],
      ['{ "gainDb": 40 }', 12],
      ['{ "gainDb": -40 }', -6],
      ['{ "note": "quiet clip" }', 0],
    ] as const) {
      writeFileSync(file, text);
      assert.deepEqual(voiceGain("Marlo", dir), { gainDb }, text);
    }
  });

  test("not JSON, or a gainDb that isn't a number: 0 dB, with what's wrong (for one log line)", () => {
    const dir = tempDir();
    const file = voiceSidecar("Marlo", dir);
    for (const [text, problem] of [
      ["{ gainDb: 5", /Marlo\.json isn't JSON/],
      ['{ "gainDb": "5" }', /Marlo\.json: gainDb isn't a number/],
      ['{ "gainDb": null }', /gainDb isn't a number/],
      ["null", null],
    ] as const) {
      writeFileSync(file, text);
      const got = voiceGain("Marlo", dir);
      assert.equal(got.gainDb, 0, text);
      if (problem) assert.match(got.problem ?? "", problem, text);
      else assert.equal(got.problem, undefined, text);
    }
  });

  test("saved: rounded to whole dB and kept in range, anything else in the file kept", () => {
    const dir = tempDir();
    saveVoiceGain("Marlo", 6, dir);
    assert.deepEqual(JSON.parse(readFileSync(voiceSidecar("Marlo", dir), "utf8")), { gainDb: 6 });
    writeFileSync(voiceSidecar("Marlo", dir), JSON.stringify({ gainDb: 1, note: "from the porch recording" }));
    saveVoiceGain("Marlo", 3.4, dir);
    assert.deepEqual(JSON.parse(readFileSync(voiceSidecar("Marlo", dir), "utf8")), { gainDb: 3, note: "from the porch recording" });
    saveVoiceGain("Marlo", 99, dir);
    assert.equal(voiceGain("Marlo", dir).gainDb, 12);
    writeFileSync(voiceSidecar("Marlo", dir), "not json");
    saveVoiceGain("Marlo", -6, dir);
    assert.deepEqual(voiceGain("Marlo", dir), { gainDb: -6 });
  });
});

describe("the gain on s16 PCM", () => {
  test("0 dB: the very same audio", () => {
    const pcm = pcmOf([0, 1, -1, 32767, -32768]);
    assert.equal(gainStream(0)(pcm), pcm);
  });

  test("below the knee: only scaled (+6 dB about doubles, -6 dB about halves)", () => {
    assert.deepEqual(samplesOf(gainStream(6)(pcmOf([0, 100, -100, 5000, -5000]))), [0, 200, -200, 9976, -9976]);
    assert.deepEqual(samplesOf(gainStream(-6)(pcmOf([0, 1000, -1000, 32767, -32768]))), [0, 501, -501, 16422, -16423]);
  });

  test("full scale turned up: no wrap-around, the sign kept, every sample under -1 dBFS", () => {
    const out = samplesOf(gainStream(12)(pcmOf([32767, -32768, 32767, -32768, 0, 30000, -30000])));
    assert.ok(out[0] > 0 && out[1] < 0 && out[5] > 0 && out[6] < 0, String(out));
    for (const s of out) assert.ok(Math.abs(s) < CEILING, `${s} over the ceiling`);
    assert.ok(out[0] > KNEE, "held near the ceiling, not squashed");
  });

  test("the limiter holds the peaks of loud speech-like audio: under -1 dBFS, the quiet parts scaled as they were", () => {
    // A 200 Hz tone with bursts near full scale, then a quiet stretch; in chunks of odd sizes, as it streams.
    const rate = 24000;
    const samples = Array.from({ length: rate }, (_, i) => {
      const loud = i < rate / 2 && Math.floor(i / 2400) % 2 === 0;
      return Math.round((loud ? 30000 : 3000) * Math.sin((2 * Math.PI * 200 * i) / rate));
    });
    const stream = gainStream(12);
    const pcm = pcmOf(samples);
    const chunks: Buffer[] = [];
    for (let at = 0; at < pcm.length; at += 2 * 937) chunks.push(stream(pcm.subarray(at, Math.min(pcm.length, at + 2 * 937))));
    const out = samplesOf(Buffer.concat(chunks));
    const peak = Math.max(...out.map(Math.abs));
    assert.ok(db(peak) < -1, `peak ${db(peak).toFixed(2)} dBFS`);
    assert.ok(db(peak) > -3, `peak ${db(peak).toFixed(2)} dBFS: not pushed down further than needed`);
    // Long after the last loud part, the limiter has let go: +12 dB, as for any quiet audio.
    const tail = out.slice(-2400).map(Math.abs);
    const tailIn = samples.slice(-2400).map(Math.abs);
    assert.ok(Math.abs(Math.max(...tail) / Math.max(...tailIn) - 10 ** (12 / 20)) < 0.01);
    // In one chunk or many: the same.
    assert.deepEqual(out, samplesOf(gainStream(12)(pcm)));
  });

  test("the knee: as it is up to -4 dBFS, then bending smoothly towards -1 dBFS, never past it", () => {
    assert.equal(softKnee(KNEE), KNEE);
    assert.equal(softKnee(1000), 1000);
    const slope = (softKnee(KNEE + 1) - softKnee(KNEE)) / 1;
    assert.ok(Math.abs(slope - 1) < 0.001);
    let last = KNEE;
    for (const level of [KNEE + 1000, 32768, 65536]) {
      const shaped = softKnee(level);
      assert.ok(shaped > last && shaped < CEILING);
      last = shaped;
    }
    assert.ok(softKnee(1e9) <= CEILING);
  });
});

describe("Settings → Voice → Volume", () => {
  test("only with Pocket and one of your voices chosen: its gain from its sidecar", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "Marlo.safetensors"), "x");
    assert.deepEqual(voiceVolumeRow("pocket", "custom:Marlo", dir), { key: "voiceVolume", label: "Volume", raw: 0, value: "0 dB", restart: false });
    writeFileSync(join(dir, "Marlo.json"), '{ "gainDb": 6 }');
    assert.deepEqual(voiceVolumeRow("pocket", "custom:Marlo", dir), { key: "voiceVolume", label: "Volume", raw: 6, value: "+6 dB", restart: false });
    assert.equal(voiceVolumeRow("pocket", "george", dir), undefined, "a built-in voice");
    assert.equal(voiceVolumeRow("pocket", "custom:Gone", dir), undefined, "a voice whose file isn't there");
    assert.equal(voiceVolumeRow("cartesia", "custom:Marlo", dir), undefined, "another engine");
    assert.equal(voiceVolumeRow("say", "Samantha", dir), undefined);
  });

  test("a sidecar it can't read: shown at 0 dB, with a note", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "Marlo.wav"), "x");
    writeFileSync(join(dir, "Marlo.json"), "{");
    const row = voiceVolumeRow("pocket", "custom:Marlo", dir);
    assert.equal(row?.value, "0 dB");
    assert.match(row?.note ?? "", /Marlo\.json unreadable/);
  });

  test("its options: -6 to +12 dB, 1 dB apart", async () => {
    assert.deepEqual(
      VOICE_VOLUMES.map((c) => c.value),
      Array.from({ length: 19 }, (_, i) => i - 6),
    );
    assert.deepEqual(VOICE_VOLUMES.map((c) => c.label).slice(0, 2), ["-6 dB", "-5 dB"]);
    assert.equal(VOICE_VOLUMES.find((c) => c.value === 12)?.label, "+12 dB");
    assert.deepEqual((await choicesFor("voiceVolume", { tts: "pocket", current: 0 })).choices, VOICE_VOLUMES);
  });

  test("under Voice, right after the voice, and found with / by 'volume'", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "Marlo.safetensors"), "x");
    const rows: SettingRow[] = [
      { key: "tts", label: "Voice engine", value: "Pocket TTS", raw: "pocket", restart: false },
      { key: "voice", label: "Voice", value: "Marlo", raw: "custom:Marlo", restart: false },
      voiceVolumeRow("pocket", "custom:Marlo", dir)!,
      { key: "duckLevel", label: "Volume while I talk", value: "20%", raw: 20, restart: false },
    ];
    const sections = (q: string | null) => filterSettings(rows, q).map((g) => [g.title, g.rows.map((r) => r.key)]);
    assert.deepEqual(sections(null), [
      ["Voice", ["tts", "voice", "voiceVolume"]],
      ["Listening", ["duckLevel"]],
    ]);
    assert.deepEqual(sections("volume"), [
      ["Voice", ["voiceVolume"]],
      ["Listening", ["duckLevel"]],
    ]);
  });
});
