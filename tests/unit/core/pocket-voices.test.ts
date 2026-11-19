// Your own Pocket voices: files in voices/ next to the settings file (src/core/pocket-voices.ts),
// listed after the built-in ones in Settings → Voice (settings-options.ts choicesFor) and uploaded
// with each sentence (src/core/pocket-tts.ts). Every voices folder here is a temp one (the tests'
// settings file is in this process's own temp folder: tests/setup.ts), never ~/.config/kiko*; the
// Pocket server is a fake one on a port the system picks, never the real one on 8737.
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { DEFAULT_POCKET_VOICE, POCKET_VOICES, PocketTts } from "../../../src/core/pocket-tts.ts";
import { customVoice, customVoiceName, customVoices, VOICES_DIR } from "../../../src/core/pocket-voices.ts";
import { choicesFor, pocketVoiceName } from "../../../src/core/settings-options.ts";

const tempDir = (prefix = "pocket-voices-") => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

describe("custom voices: the files in voices/", () => {
  test("next to the settings file, which is the tests' own temp one", () => {
    assert.equal(VOICES_DIR, join(dirname(process.env.KIKO_SETTINGS!), "voices"));
    assert.ok(!VOICES_DIR.includes("/.config/kiko"));
  });

  test("each .safetensors or .wav is a voice named by its file; the .safetensors one wins a tie; anything else is left out", () => {
    const dir = tempDir();
    for (const file of ["Marlo.safetensors", "Marlo.wav", "anna-clone.WAV", "notes.txt", ".hidden.wav", "Zed.safetensors"]) writeFileSync(join(dir, file), "x");
    mkdirSync(join(dir, "Folder.wav"));
    assert.deepEqual(customVoices(dir), [
      { id: "custom:anna-clone", name: "anna-clone", path: join(dir, "anna-clone.WAV") },
      { id: "custom:Marlo", name: "Marlo", path: join(dir, "Marlo.safetensors") },
      { id: "custom:Zed", name: "Zed", path: join(dir, "Zed.safetensors") },
    ]);
    assert.equal(customVoice("custom:Marlo", dir)?.path, join(dir, "Marlo.safetensors"));
    assert.equal(customVoice("custom:Nobody", dir), undefined);
    assert.equal(customVoice("george", dir), undefined);
  });

  test("no folder: no voices, no error", () => {
    assert.deepEqual(customVoices(join(tempDir(), "missing")), []);
  });

  test("names: a custom id by its file's name, a built-in one as before", () => {
    assert.equal(customVoiceName("custom:Marlo"), "Marlo");
    assert.equal(customVoiceName("george"), undefined);
    assert.equal(pocketVoiceName("custom:Marlo"), "Marlo");
    assert.equal(pocketVoiceName("bill_boerst"), "Bill Boerst");
  });

  test("Settings → Voice: the built-in voices, then yours with a 'custom' hint, previewable", async () => {
    mkdirSync(VOICES_DIR, { recursive: true });
    writeFileSync(join(VOICES_DIR, "Marlo.safetensors"), "x");
    const set = await choicesFor("voice", { tts: "pocket", current: DEFAULT_POCKET_VOICE });
    assert.equal(set.previewable, true);
    assert.deepEqual(
      set.choices.slice(0, POCKET_VOICES.length).map((c) => c.value),
      POCKET_VOICES.map((v) => v.id),
    );
    assert.deepEqual(set.choices.slice(POCKET_VOICES.length), [{ value: "custom:Marlo", label: "Marlo", hint: "custom" }]);
  });
});

// ── The voice sent to the server ────────────────────────────────────────────

type Seen = { voiceUrl?: string; upload?: { name: string; bytes: string } };

/** A fake Pocket server: answers /openapi.json as Pocket does, and /tts with a short WAV; an upload whose bytes are "broken" gets a 500, as a file the server can't load does. */
function fakePocket() {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    if (req.url === "/openapi.json") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ info: { title: "Pocket TTS API" } }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": String(req.headers["content-type"]) } }).formData();
      const url = form.get("voice_url");
      const wav = form.get("voice_wav");
      const entry: Seen = {};
      if (typeof url === "string") entry.voiceUrl = url;
      if (wav && typeof wav !== "string") entry.upload = { name: wav.name, bytes: await wav.text() };
      seen.push(entry);
      if (entry.upload?.bytes === "broken") {
        res.statusCode = 500;
        res.end("Internal Server Error");
        return;
      }
      res.setHeader("content-type", "audio/wav");
      res.end(wav24k(Buffer.from([1, 0, 2, 0, 3, 0, 4, 0])));
    });
  });
  return { server, seen };
}

function wav24k(pcm: Buffer) {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVE", 8, "ascii");
  head.write("fmt ", 12, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(24000, 24);
  head.writeUInt32LE(48000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

describe("custom voices: what Pocket is sent", () => {
  const fake = fakePocket();
  let port = 0;
  const errors: string[] = [];
  const realError = console.error;

  before(async () => {
    await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", r));
    port = (fake.server.address() as AddressInfo).port;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  });
  after(() => {
    console.error = realError;
    fake.server.close();
  });

  /** One reply of `text` with `voice`: the audio bytes it played and what the server was sent for it. */
  async function say(tts: PocketTts, voice: string, text = "Hi, I'm testing this voice.") {
    fake.seen.length = 0;
    const pcm: Buffer[] = [];
    await new Promise<void>((resolve) => {
      void tts.open({ onAudio: (b) => pcm.push(b), onDone: resolve }, voice).then((s) => {
        s.push(text);
        s.end();
      });
    });
    const all = Buffer.concat(pcm);
    return { bytes: all.length, samples: Array.from({ length: all.length / 2 }, (_, i) => all.readInt16LE(i * 2)), seen: [...fake.seen] };
  }

  test("a built-in voice goes by name, as before", async () => {
    const tts = new PocketTts({ port, voicesDir: tempDir() });
    const out = await say(tts, "alba");
    assert.deepEqual(out.seen, [{ voiceUrl: "alba" }]);
    assert.equal(out.bytes, 8);
  });

  test("the read-along's marks: each sentence told before its audio, and once all of it came (the phone's read-along)", async () => {
    const tts = new PocketTts({ port, voicesDir: tempDir() });
    const events: string[] = [];
    const marks = {
      sentence: (t: string) => events.push(`sentence ${t}`),
      sentenceDone: () => events.push("done"),
      timestamps: () => events.push("timestamps"),
    };
    await new Promise<void>((resolve) => {
      void tts.open({ onAudio: (b) => events.push(`audio ${b.length}`), onDone: resolve, marks }, "alba").then((s) => {
        s.push("First sentence here. And **the** second one.");
        s.end();
      });
    });
    assert.deepEqual(events, ["sentence First sentence here.", "audio 8", "done", "sentence And the second one.", "audio 8", "done"]);
  });

  test("one of yours goes up with each sentence, named as its file (the server reads .safetensors by the name)", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "Marlo.safetensors"), "voice-state");
    const tts = new PocketTts({ port, voicesDir: dir });
    const out = await say(tts, "custom:Marlo", "First sentence here. And the second one.");
    assert.deepEqual(out.seen, [{ upload: { name: "Marlo.safetensors", bytes: "voice-state" } }, { upload: { name: "Marlo.safetensors", bytes: "voice-state" } }]);
    assert.equal(out.bytes, 16);
  });

  test("a missing file: the built-in voice speaks, and one line says so, not one per reply", async () => {
    errors.length = 0;
    const dir = tempDir();
    const tts = new PocketTts({ port, voicesDir: dir });
    for (let i = 0; i < 2; i++) {
      const out = await say(tts, "custom:Gone");
      assert.deepEqual(out.seen, [{ voiceUrl: DEFAULT_POCKET_VOICE }]);
      assert.equal(out.bytes, 8);
    }
    assert.equal(errors.length, 1);
    assert.match(errors[0], /voice "Gone": no Gone\.safetensors or Gone\.wav in .*; using george instead/);
  });

  test("a file the server can't load: that sentence again in the built-in voice, then the built-in one straight away; one line", async () => {
    errors.length = 0;
    const dir = tempDir();
    writeFileSync(join(dir, "Bad.safetensors"), "broken");
    const tts = new PocketTts({ port, voicesDir: dir });
    const first = await say(tts, "custom:Bad", "One sentence here. Then another one.");
    assert.deepEqual(first.seen, [{ upload: { name: "Bad.safetensors", bytes: "broken" } }, { voiceUrl: "george" }, { voiceUrl: "george" }]);
    assert.equal(first.bytes, 16);
    const second = await say(tts, "custom:Bad");
    assert.deepEqual(second.seen, [{ voiceUrl: "george" }]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /voice "Bad": the server couldn't load .*Bad\.safetensors \(\/tts 500: Internal Server Error\); using george instead/);
    // Replaced by a good one: tried again.
    writeFileSync(join(dir, "Bad.safetensors"), "fixed-state");
    const third = await say(tts, "custom:Bad");
    assert.deepEqual(third.seen, [{ upload: { name: "Bad.safetensors", bytes: "fixed-state" } }]);
  });

  test("its volume (Marlo.json beside it): its audio turned up as it comes; read at each reply; a built-in voice untouched", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "Marlo.safetensors"), "voice-state");
    const tts = new PocketTts({ port, voicesDir: dir });
    assert.deepEqual((await say(tts, "custom:Marlo")).samples, [1, 2, 3, 4], "no sidecar: as it came");
    writeFileSync(join(dir, "Marlo.json"), JSON.stringify({ gainDb: 6 }));
    assert.deepEqual((await say(tts, "custom:Marlo")).samples, [2, 4, 6, 8], "+6 dB: about twice as loud");
    writeFileSync(join(dir, "alba.json"), JSON.stringify({ gainDb: 6 }));
    assert.deepEqual((await say(tts, "alba")).samples, [1, 2, 3, 4], "a built-in voice has no sidecar");
  });

  test("a sidecar that isn't JSON: 0 dB, and one line says so, not one per reply", async () => {
    errors.length = 0;
    const dir = tempDir();
    writeFileSync(join(dir, "Marlo.safetensors"), "voice-state");
    writeFileSync(join(dir, "Marlo.json"), "{ gainDb: 6");
    const tts = new PocketTts({ port, voicesDir: dir });
    for (let i = 0; i < 2; i++) assert.deepEqual((await say(tts, "custom:Marlo")).samples, [1, 2, 3, 4]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /voice "Marlo": .*Marlo\.json isn't JSON; playing it at 0 dB/);
  });

  test("a custom voice as the instance's own (KIKO_POCKET_VOICE, first-run setup's): used when a reply names none; the server's own stays built in", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "Marlo.safetensors"), "voice-state");
    const tts = new PocketTts({ port, voicesDir: dir, voice: "custom:Marlo" });
    const out = await say(tts, "not-a-voice");
    assert.deepEqual(out.seen, [{ upload: { name: "Marlo.safetensors", bytes: "voice-state" } }]);
    assert.equal((tts as unknown as { builtInVoice: string }).builtInVoice, DEFAULT_POCKET_VOICE);
  });
});
