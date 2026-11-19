// How much data the phone's audio uses today, and what Opus would make of it. Three parts:
//   1. The logs: per day and per hour of use, the seconds of talk going up (`phone_talk`) and of
//      Kiko's voice going down to a phone that plays it (what was said while one listened), turned
//      into bytes with the real wire format (base64 in JSON, the envelope as each side writes it,
//      the WebSocket frame header).
//   2. Opus on sample speech: macOS `say` reading real phone_talk words at 16 kHz (the phone's mic
//      format), plus the same with pink noise; Pocket (the voice in use, run locally) reading real
//      summaries at 24 kHz. Encoded with ffmpeg's libopus and Apple's own encoder (afconvert, the
//      AudioToolbox one iOS has), at several bitrates: bytes per second as base64-in-JSON and as
//      binary frames, 5 frames (100 ms) per message.
//   3. Speech-to-text A/B: the same clips raw and Opus-decoded through Kiko's own Apple
//      recognizer (native/macos/speech.swift, built to a temp folder), word error rates compared.
// Offline and free: no API calls, never touches the app, its servers or logs/.
//
//   node scripts/perf/phone-audio.ts --logs <main checkout>/logs [--work <dir>] [--pocket <pocket/.venv/bin/python>]
//        [--skip-stt] [--out scripts/perf/phone-audio-<date>.json] [--items <file>]
//   node scripts/perf/phone-audio.ts --wire [--out scripts/perf/phone-audio-wire-<date>.json]
//
// --wire: the cut-down check against what's built (src/remote/opus.ts): a real phone server on
// 127.0.0.1 (its own port, a throwaway config and log folder: tests/setup.ts), Opus through the real
// helper (native/macos/opus.swift), and two fake phones over `ws`, one agreeing on Opus and one an
// older app (PCM in JSON). `say` reads a few sentences; up, the Opus phone sends them as the app
// does (Apple's encoder, the first 20 ms at once, then 100 ms frames), the PCM one as talk_audio;
// down, the server's voice gets them in 80 ms chunks a little faster than real time, as Pocket makes
// them. Counts every byte each socket carried (payload and WebSocket header) per second of speech,
// and what the hub's speech-to-text got back. No logs needed, no ffmpeg.
//
// Needs ffmpeg with libopus (Homebrew's has it), afconvert and swiftc (macOS). --pocket: Pocket's
// Python, to make the 24 kHz samples with the voice in use (else `say` at 24 kHz). --items: every
// clip's transcripts there (they hold your words: keep that file out of git).
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: flags } = parseArgs({
  options: {
    logs: { type: "string", default: "logs" },
    work: { type: "string", default: join(tmpdir(), "kiko-phone-audio") },
    pocket: { type: "string" },
    voice: { type: "string", default: "george" },
    clips: { type: "string", default: "24" },
    "skip-stt": { type: "boolean", default: false },
    out: { type: "string" },
    items: { type: "string" },
    wire: { type: "boolean", default: false },
  },
});

const ROOT = new URL("../..", import.meta.url).pathname;
const WORK = flags.work!;
mkdirSync(WORK, { recursive: true });

// ── The wire format today ────────────────────────────────────────────────────────────────────────
// Up: the phone's Wire.encode (JSONEncoder, which writes "/" as "\/"), one talk_audio per ~100 ms.
// Down: server.ts encode(), JSON.stringify of { v, type: "audio", data, rate: 24000 }.
const UP_RATE = 16000;
const DOWN_RATE = 24000;
const UP_ENVELOPE = JSON.stringify({ v: 1, type: "talk_audio", data: "" }).length; // 37
const DOWN_ENVELOPE = JSON.stringify({ v: 1, type: "audio", data: "", rate: 24000 }).length; // 45
const START_END = JSON.stringify({ v: 1, type: "talk_start", talkId: "00000000-0000-0000-0000-000000000000" }).length + JSON.stringify({ v: 1, type: "talk_end" }).length;
/** WebSocket frame header: 2 bytes, +2 for 126–65535 bytes of payload, +4 for the mask a client adds. */
const wsHeader = (payload: number, fromClient: boolean) => (payload < 126 ? 2 : payload < 65536 ? 4 : 10) + (fromClient ? 4 : 0);
const b64 = (n: number) => 4 * Math.ceil(n / 3);
/** Below the WebSocket, per packet (estimate): TCP/IPv4 with timestamps 52, and over Tailscale WireGuard + UDP + IPv4 60 more; MTU 1280 there. */
const TCP_IP = 52;
const TAILSCALE = 60;
const SEGMENT = 1280 - 52;

// ── 1. The logs ──────────────────────────────────────────────────────────────────────────────────
type Line = { t: string; event: string; [k: string]: any };
function readLogs(dir: string) {
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}-.*\.jsonl$/.test(f))
    .sort(); // not latest.jsonl, a copy of the newest
  const lines: Line[] = [];
  for (const f of files) {
    for (const raw of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!raw.trim()) continue;
      try {
        lines.push(JSON.parse(raw));
      } catch {}
    }
  }
  lines.sort((a, b) => a.t.localeCompare(b.t));
  return { files: files.length, lines };
}

const pad = (n: number) => String(n).padStart(2, "0");
const day = (t: string) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const hour = (t: string) => `${day(t)}T${pad(new Date(t).getHours())}`;

/** What a line of speech has as its length in characters, if it's speech that went out. */
function spokenChars(l: Line): number {
  switch (l.event) {
    case "announce":
      return l.ttsChars ?? 0;
    case "ask_permission":
    case "quick_answer":
      return typeof l.text === "string" ? l.text.length : 0;
    case "auto_mode_blocked":
      return l.said && typeof l.text === "string" ? l.text.length : 0;
    default:
      return 0;
  }
}

function analyseLogs(lines: Line[]) {
  type Day = {
    presses: number;
    cancelled: number;
    talkSeconds: number;
    upPcmBytes: number;
    upChunks: number;
    typed: number;
    speechLines: number;
    speechChars: number;
    allSpeechChars: number;
    phoneHereMs: number;
    activeHours: Set<string>;
    tts: Set<string>;
  };
  const days = new Map<string, Day>();
  const get = (t: string) => {
    const k = day(t);
    let d = days.get(k);
    if (!d) {
      d = { presses: 0, cancelled: 0, talkSeconds: 0, upPcmBytes: 0, upChunks: 0, typed: 0, speechLines: 0, speechChars: 0, allSpeechChars: 0, phoneHereMs: 0, activeHours: new Set(), tts: new Set() };
      days.set(k, d);
    }
    return d;
  };
  const gaps: number[] = [];
  const addresses = new Map<string, number>();

  // Whether a phone plays what's said now: connected, its app in front (presence back, or an app
  // from before presence: taken as in front 2 s after it connects), Play on phone on.
  let conns = 0;
  let here = false;
  let pendingConnectAt: number | null = null;
  let playOnPhone = true;
  let hereSince: number | null = null;
  let tts = "pocket";
  const setHere = (on: boolean, at: number) => {
    const listening = on && playOnPhone;
    const was = hereSince !== null;
    if (listening && !was) hereSince = at;
    if (!listening && was) {
      addHere(hereSince!, at);
      hereSince = null;
    }
    here = on;
  };
  const addHere = (from: number, to: number) => {
    // Split across local days and mark each clock hour touched as active.
    let a = from;
    while (a < to) {
      const d = new Date(a);
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
      const b = Math.min(to, next);
      const iso = new Date(a).toISOString();
      const dd = get(iso);
      dd.phoneHereMs += b - a;
      dd.activeHours.add(hour(iso));
      a = b;
    }
  };

  for (const l of lines) {
    const at = Date.parse(l.t);
    if (pendingConnectAt !== null && at - pendingConnectAt > 2000) {
      setHere(true, pendingConnectAt + 2000);
      pendingConnectAt = null;
    }
    switch (l.event) {
      case "start":
        if (l.tts) tts = l.tts;
        conns = 0;
        setHere(false, at);
        pendingConnectAt = null;
        break;
      case "shutdown":
        conns = 0;
        setHere(false, at);
        pendingConnectAt = null;
        break;
      case "phone_connected":
        conns++;
        {
          const a = String(l.address ?? "");
          const kind =
            /^(::ffff:)?100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a) || /^fd7a:115c:a1e0/i.test(a)
              ? "tailscale"
              : /^fe80:/i.test(a)
                ? "link-local IPv6"
                : "IPv4 " +
                  a
                    .replace(/^::ffff:/, "")
                    .split(".")
                    .slice(0, 2)
                    .join(".") +
                  ".x.x";
          addresses.set(kind, (addresses.get(kind) ?? 0) + 1);
        }
        pendingConnectAt ??= at;
        break;
      case "phone_disconnected":
        conns = Math.max(0, conns - 1);
        if (conns === 0) {
          setHere(false, at);
          pendingConnectAt = null;
        }
        break;
      case "phone_presence":
        pendingConnectAt = null;
        setHere(l.state === "back", at);
        break;
      case "phone_play":
        playOnPhone = !!l.on;
        setHere(here, at);
        break;
      case "phone_talk": {
        const d = get(l.t);
        d.presses++;
        if (l.cancelled) d.cancelled++;
        d.talkSeconds += l.audioSeconds ?? 0;
        const bytes = l.audio?.bytes ?? Math.round((l.audioSeconds ?? 0) * UP_RATE * 2);
        d.upPcmBytes += bytes;
        d.upChunks += l.audio?.chunks ?? Math.ceil((l.audioSeconds ?? 0) * 10);
        d.activeHours.add(hour(l.t));
        if (typeof l.audio?.maxGapMs === "number") gaps.push(l.audio.maxGapMs);
        break;
      }
      case "phone_type":
        get(l.t).typed++;
        get(l.t).activeHours.add(hour(l.t));
        break;
    }
    const chars = spokenChars(l);
    if (chars) {
      const d = get(l.t);
      d.allSpeechChars += chars;
      if (hereSince !== null && tts !== "say") {
        d.speechLines++;
        d.speechChars += chars;
        d.tts.add(tts);
      }
    }
  }
  if (hereSince !== null) addHere(hereSince, Date.parse(lines.at(-1)!.t));
  return { days, gaps, addresses: Object.fromEntries(addresses) };
}

// ── 2. Sample speech, and Opus ───────────────────────────────────────────────────────────────────
function sample<T>(items: T[], n: number, seed = 7): T[] {
  // Deterministic: a small LCG shuffle.
  const a = [...items];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

const hash = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 8);

const SAY_VOICES = ["Samantha", "Reed (English (US))", "Flo (English (US))", "Eddy (English (US))"];

function makeClips(lines: Line[]) {
  const up = join(WORK, "up");
  const down = join(WORK, "down");
  mkdirSync(up, { recursive: true });
  mkdirSync(down, { recursive: true });
  const talks = [...new Set(lines.filter((l) => l.event === "phone_talk" && !l.cancelled && typeof l.text === "string" && l.text.length >= 15 && l.text.length <= 400).map((l) => l.text as string))];
  const sums = [...new Set(lines.filter((l) => l.event === "summary" && !l.dropped && typeof l.text === "string" && l.text).map((l) => l.text as string))];
  const upClips = sample(talks, Number(flags.clips)).map((text, i) => {
    const key = `${pad(i)}-${hash(text)}`;
    const clean = join(up, `clip-${key}.wav`);
    const noisy = join(up, `noisy-${key}.wav`);
    if (!existsSync(clean)) execFileSync("say", ["-v", SAY_VOICES[i % SAY_VOICES.length], "-o", clean, "--file-format=WAVE", `--data-format=LEI16@${UP_RATE}`, text]);
    if (!existsSync(noisy)) {
      // Pink noise ~15–20 dB under the speech: a room, a street.
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-i",
        clean,
        "-filter_complex",
        `anoisesrc=c=pink:r=${UP_RATE}:a=0.02:seed=${i}[n];[0][n]amix=inputs=2:duration=first:normalize=0`,
        "-ar",
        String(UP_RATE),
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        noisy,
      ]);
    }
    return { i, key, text, clean, noisy };
  });
  const downClips = sample(sums, 8).map((text, i) => {
    const key = `${i}-${hash(text)}`;
    const file = join(down, `voice-${key}-${flags.pocket ? flags.voice : "say"}.wav`);
    if (!existsSync(file)) {
      if (flags.pocket) {
        const code = "import sys; from pocket_tts.main import cli_app; cli_app(['generate','-q','--voice',sys.argv[3],'--text',sys.argv[1],'--output-path',sys.argv[2]], prog_name='pocket-tts')";
        execFileSync(flags.pocket, ["-I", "-c", code, text, file, flags.voice!], { cwd: down, stdio: "ignore" });
      } else {
        execFileSync("say", ["-o", file, "--file-format=WAVE", `--data-format=LEI16@${DOWN_RATE}`, text]);
      }
    }
    return { i, key, text, file };
  });
  return { upClips, downClips, voice: flags.pocket ? `pocket ${flags.voice}` : "say" };
}

/** 16-bit PCM samples of a WAV (its data chunk). */
function pcmOf(file: string): Buffer {
  const buf = readFileSync(file);
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === "data") return buf.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size & 1);
  }
  throw new Error(`no data chunk in ${file}`);
}

/** The audio packets of an Ogg Opus file, without its two header packets. */
function oggPackets(file: string): number[] {
  const buf = readFileSync(file);
  const packets: number[] = [];
  let current = 0;
  let at = 0;
  while (at + 27 <= buf.length && buf.toString("ascii", at, at + 4) === "OggS") {
    const segments = buf[at + 26];
    const table = buf.subarray(at + 27, at + 27 + segments);
    for (const s of table) {
      current += s;
      if (s < 255) {
        packets.push(current);
        current = 0;
      }
    }
    at += 27 + segments + table.reduce((a, b) => a + b, 0);
  }
  return packets.slice(2);
}

type Encoded = { packets: number[]; seconds: number; decoded: string };

function encodeLibopus(wav: string, rate: number, kbps: number, tag: string): Encoded {
  const ogg = join(WORK, "enc", `${tag}.ogg`);
  const decoded = join(WORK, "enc", `${tag}.dec.wav`);
  mkdirSync(join(WORK, "enc"), { recursive: true });
  if (!existsSync(decoded)) {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", wav, "-c:a", "libopus", "-b:a", `${kbps}k`, "-application", "voip", "-frame_duration", "20", "-vbr", "on", ogg]);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", ogg, "-ar", String(rate), "-ac", "1", "-c:a", "pcm_s16le", decoded]);
  }
  return { packets: oggPackets(ogg), seconds: pcmOf(wav).length / 2 / rate, decoded };
}

function encodeApple(wav: string, rate: number, kbps: number, tag: string): Encoded {
  const caf = join(WORK, "enc", `${tag}.caf`);
  const decoded = join(WORK, "enc", `${tag}.dec.wav`);
  mkdirSync(join(WORK, "enc"), { recursive: true });
  if (!existsSync(decoded)) {
    execFileSync("afconvert", ["-f", "caff", "-d", "opus", "-b", String(kbps * 1000), wav, caf]);
    execFileSync("afconvert", ["-f", "WAVE", "-d", `LEI16@${rate}`, caf, decoded]);
  }
  const info = execFileSync("afinfo", [caf], { encoding: "utf8" });
  const bytes = Number(/audio bytes: (\d+)/.exec(info)![1]);
  const count = Number(/audio packets: (\d+)/.exec(info)![1]);
  // afinfo gives the total only: spread evenly (framing below needs only the count and the total).
  const packets = Array.from({ length: count }, (_, i) => Math.floor(((i + 1) * bytes) / count) - Math.floor((i * bytes) / count));
  return { packets, seconds: pcmOf(wav).length / 2 / rate, decoded };
}

/** Bytes per second of a stream of `packets` (20 ms each), `perMessage` of them per WebSocket message. */
function framing(packets: number[], seconds: number, perMessage: number, fromClient: boolean) {
  let json = 0;
  let binary = 0;
  let jsonWire = 0;
  let binaryWire = 0;
  const envelope = JSON.stringify({ v: 1, type: fromClient ? "talk_audio" : "audio", data: "", codec: "opus" }).length;
  for (let i = 0; i < packets.length; i += perMessage) {
    const group = packets.slice(i, i + perMessage);
    // Each packet behind a 2-byte length; the binary message also carries a 1-byte kind.
    const payload = group.reduce((a, b) => a + b + 2, 0);
    const j = envelope + b64(payload);
    const bin = 1 + payload;
    json += j + wsHeader(j, fromClient);
    binary += bin + wsHeader(bin, fromClient);
    jsonWire += j + wsHeader(j, fromClient) + Math.ceil(j / SEGMENT) * (TCP_IP + TAILSCALE);
    binaryWire += bin + wsHeader(bin, fromClient) + Math.ceil(bin / SEGMENT) * (TCP_IP + TAILSCALE);
  }
  const opusBytes = packets.reduce((a, b) => a + b, 0);
  return { opusKbps: (opusBytes * 8) / seconds / 1000, json: json / seconds, binary: binary / seconds, jsonWire: jsonWire / seconds, binaryWire: binaryWire / seconds };
}

/** Today's PCM stream, in bytes per second: per message `chunkMs` of PCM as base64 in JSON. */
function pcmStream(pcm: Buffer, rate: number, chunkMs: number, fromClient: boolean) {
  const chunk = (rate * 2 * chunkMs) / 1000;
  let json = 0;
  let wire = 0;
  let slashes = 0;
  let base64 = 0;
  for (let at = 0; at < pcm.length; at += chunk) {
    const data = pcm.subarray(at, at + chunk).toString("base64");
    // The phone's JSONEncoder writes each "/" as "\/".
    const escaped = fromClient ? (data.match(/\//g)?.length ?? 0) : 0;
    slashes += escaped;
    base64 += data.length;
    const j = (fromClient ? UP_ENVELOPE : DOWN_ENVELOPE) + data.length + escaped;
    json += j + wsHeader(j, fromClient);
    wire += j + wsHeader(j, fromClient) + Math.ceil(j / SEGMENT) * (TCP_IP + TAILSCALE);
  }
  const seconds = pcm.length / 2 / rate;
  return { raw: pcm.length / seconds, json: json / seconds, wire: wire / seconds, slashShare: slashes / base64 };
}

// ── 3. Speech-to-text A/B through Kiko's Apple recognizer ─────────────────────────────────────
class Recognizer {
  private proc;
  private buffer = "";
  private waiting = new Map<number, (text: string) => void>();
  private ready: Promise<void>;
  constructor(binary: string) {
    this.proc = spawn(binary, [], { stdio: ["pipe", "pipe", "inherit"] });
    let markReady!: () => void;
    this.ready = new Promise((r) => (markReady = r));
    this.proc.stdout.on("data", (d: Buffer) => {
      this.buffer += d.toString();
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.type === "ready") markReady();
        if (m.type === "error") console.error("speech:", m.message);
        if (m.type === "final") this.waiting.get(m.id)?.(m.text);
      }
    });
  }
  private frame(type: string, payload: Buffer) {
    const head = Buffer.alloc(5);
    head.write(type, 0, "ascii");
    head.writeUInt32LE(payload.length, 1);
    this.proc.stdin.write(Buffer.concat([head, payload]));
  }
  async transcribe(id: number, pcm: Buffer): Promise<string> {
    await this.ready;
    const done = new Promise<string>((r) => this.waiting.set(id, r));
    const idBuf = Buffer.alloc(4);
    idBuf.writeUInt32LE(id);
    this.frame("B", idBuf);
    // As the phone sends it: ~100 ms per message (a little faster than real time here).
    for (let at = 0; at < pcm.length; at += 3200) {
      this.frame("A", pcm.subarray(at, at + 3200));
      await new Promise((r) => setTimeout(r, 15));
    }
    this.frame("E", Buffer.alloc(0));
    const text = await done;
    this.waiting.delete(id);
    return text;
  }
  close() {
    this.proc.stdin.end();
  }
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9%]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

/** Word edit distance. */
function edits(ref: string[], hyp: string[]) {
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[hyp.length];
}

// ── Run ──────────────────────────────────────────────────────────────────────────────────────────
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};
const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
};

if (flags.wire) {
  const result = await wire();
  const json = JSON.stringify(result, null, 2);
  if (flags.out) writeFileSync(flags.out, json + "\n");
  console.log(json);
  process.exit(0);
}

const { files, lines } = readLogs(flags.logs!);
const { upClips, downClips, voice } = makeClips(lines);

// Today's streams, measured on the clips.
const upPcm = Buffer.concat(upClips.map((c) => pcmOf(c.clean)));
const downPcm = Buffer.concat(downClips.map((c) => pcmOf(c.file)));
const today = {
  up: pcmStream(upPcm, UP_RATE, 100, true),
  down80: pcmStream(downPcm, DOWN_RATE, 80, false),
  down200: pcmStream(downPcm, DOWN_RATE, 200, false),
};
const downChars = downClips.reduce((a, c) => a + c.text.length, 0);
const downSeconds = downPcm.length / 2 / DOWN_RATE;
const charsPerSecond = downChars / downSeconds;

// Opus at each bitrate, both encoders.
const UP_KBPS = [12, 16, 24, 32];
const DOWN_KBPS = [16, 24, 32];
type CodecRow = {
  encoder: string;
  dir: "up" | "down";
  kbps: number;
  opusKbps: number;
  json: number;
  binary: number;
  jsonWire: number;
  binaryWire: number;
  perFrame?: { binary: number; binaryWire: number };
};
const codecs: CodecRow[] = [];
const decodedUp = new Map<string, Map<number, string>>(); // variant → clip → decoded wav
const decodedNoisy = new Map<string, Map<number, string>>();
for (const encoder of ["libopus", "apple"] as const) {
  const enc = encoder === "libopus" ? encodeLibopus : encodeApple;
  for (const kbps of UP_KBPS) {
    const all: number[] = [];
    let seconds = 0;
    const clean = new Map<number, string>();
    const noisy = new Map<number, string>();
    for (const c of upClips) {
      const e = enc(c.clean, UP_RATE, kbps, `${encoder}-up-${kbps}-${c.key}`);
      all.push(...e.packets);
      seconds += e.seconds;
      clean.set(c.i, e.decoded);
      noisy.set(c.i, enc(c.noisy, UP_RATE, kbps, `${encoder}-noisy-${kbps}-${c.key}`).decoded);
    }
    decodedUp.set(`${encoder} ${kbps}`, clean);
    decodedNoisy.set(`${encoder} ${kbps}`, noisy);
    const f = framing(all, seconds, 5, true);
    const one = framing(all, seconds, 1, true);
    codecs.push({ encoder, dir: "up", kbps, ...f, perFrame: { binary: one.binary, binaryWire: one.binaryWire } });
  }
  for (const kbps of DOWN_KBPS) {
    const all: number[] = [];
    let seconds = 0;
    for (const c of downClips) {
      const e = enc(c.file, DOWN_RATE, kbps, `${encoder}-down-${kbps}-${c.key}`);
      all.push(...e.packets);
      seconds += e.seconds;
    }
    const f = framing(all, seconds, 5, false);
    const one = framing(all, seconds, 1, false);
    codecs.push({ encoder, dir: "down", kbps, ...f, perFrame: { binary: one.binary, binaryWire: one.binaryWire } });
  }
}

// Speech-to-text A/B.
type SttRow = { variant: string; noisy: boolean; wer: number; sameAsRaw: number; worseThanRaw: number; betterThanRaw: number };
const stt: SttRow[] = [];
const items: any[] = [];
if (!flags["skip-stt"]) {
  const binary = join(WORK, "speech");
  execFileSync("swiftc", ["-O", join(ROOT, "native/macos/speech.swift"), "-o", binary]);
  const rec = new Recognizer(binary);
  let id = 1;
  for (const noisy of [false, true]) {
    const raw = new Map<number, string>();
    const rawFiles = new Map(upClips.map((c) => [c.i, noisy ? c.noisy : c.clean]));
    const variants: [string, Map<number, string>][] = [["raw", rawFiles], ["raw again", rawFiles], ...(noisy ? decodedNoisy : decodedUp)];
    for (const [variant, files] of variants) {
      let errs = 0;
      let total = 0;
      let same = 0;
      let worse = 0;
      let better = 0;
      for (const c of upClips) {
        const text = await rec.transcribe(id++, pcmOf(files.get(c.i)!));
        const ref = words(c.text);
        const e = edits(ref, words(text));
        errs += e;
        total += ref.length;
        if (variant === "raw") raw.set(c.i, text);
        else {
          const r = raw.get(c.i)!;
          const er = edits(ref, words(r));
          if (words(r).join(" ") === words(text).join(" ")) same++;
          if (e > er) worse++;
          if (e < er) better++;
        }
        items.push({ clip: c.i, noisy, variant, ref: c.text, text, edits: e });
      }
      stt.push({ variant, noisy, wer: errs / total, sameAsRaw: variant === "raw" ? upClips.length : same, worseThanRaw: worse, betterThanRaw: better });
      console.log(`stt ${noisy ? "noisy" : "clean"} ${variant}: WER ${round(100 * (errs / total))}%`);
    }
  }
  rec.close();
}

// Today's bytes per day and per hour, and with Opus.
const { days, gaps, addresses } = analyseLogs(lines);
const pick = (encoder: string, dir: string, kbps: number) => codecs.find((c) => c.encoder === encoder && c.dir === dir && c.kbps === kbps)!;
const downTodayPerSecond = today.down80.json;
const perDay = [...days.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([date, d]) => {
    const speechSeconds = d.speechChars / charsPerSecond;
    // Up today: the logged PCM as base64 (escaped as measured), the envelope and header per chunk, start and end.
    const upBytes = ((d.upPcmBytes * 4) / 3) * (1 + today.up.slashShare) + d.upChunks * (UP_ENVELOPE + 8) + d.presses * (START_END + 12);
    const downBytes = speechSeconds * downTodayPerSecond;
    const withOpus = (kbps: number, encoder = "libopus") => (d.talkSeconds * pick(encoder, "up", kbps).binary + speechSeconds * pick(encoder, "down", kbps).binary) / 1e6;
    return {
      date,
      presses: d.presses,
      cancelled: d.cancelled,
      typed: d.typed,
      talkSeconds: round(d.talkSeconds),
      upMessages: d.upChunks + 2 * d.presses,
      speechLinesToPhone: d.speechLines,
      speechCharsToPhone: d.speechChars,
      speechSecondsToPhone: round(speechSeconds),
      downMessages: Math.round(speechSeconds / 0.08),
      allSpeechChars: d.allSpeechChars,
      phoneInFrontHours: round(d.phoneHereMs / 3_600_000, 2),
      activeHours: d.activeHours.size,
      upMB: round(upBytes / 1e6, 2),
      downMB: round(downBytes / 1e6, 2),
      totalMB: round((upBytes + downBytes) / 1e6, 2),
      opus16MB: round(withOpus(16), 2),
      opus24MB: round(withOpus(24), 2),
      opus32MB: round(withOpus(32), 2),
    };
  });

const result = {
  date: day(new Date().toISOString()),
  logs: { files, lines: lines.length, last: lines.at(-1)?.t },
  wire: { upEnvelope: UP_ENVELOPE, downEnvelope: DOWN_ENVELOPE, upChunkMs: 100, downChunkMsAssumed: 80 },
  todayPerSecond: {
    up: { pcm: today.up.raw, json: round(today.up.json, 0), wireTailscale: round(today.up.wire, 0), slashShare: round(today.up.slashShare, 4) },
    down: { pcm: today.down80.raw, json80ms: round(today.down80.json, 0), json200ms: round(today.down200.json, 0), wireTailscale80ms: round(today.down80.wire, 0) },
  },
  voice: { engine: voice, clips: downClips.length, chars: downChars, seconds: round(downSeconds, 1), charsPerSecond: round(charsPerSecond, 2) },
  upClips: { count: upClips.length, seconds: round(upPcm.length / 2 / UP_RATE, 1) },
  codecs: codecs.map((c) => ({
    ...c,
    opusKbps: round(c.opusKbps, 1),
    json: round(c.json, 0),
    binary: round(c.binary, 0),
    jsonWire: round(c.jsonWire, 0),
    binaryWire: round(c.binaryWire, 0),
    perFrame: c.perFrame && { binary: round(c.perFrame.binary, 0), binaryWire: round(c.perFrame.binaryWire, 0) },
  })),
  stt: stt.map((s) => ({ ...s, wer: round(100 * s.wer, 1) })),
  // The hub's longest wait between two talk_audio messages in a press (they're sent every ~100 ms).
  upGapsMs: {
    presses: gaps.length,
    median: median(gaps),
    p90: pct(gaps, 0.9),
    p95: pct(gaps, 0.95),
    p99: pct(gaps, 0.99),
    max: Math.max(0, ...gaps),
    over250: gaps.filter((g) => g > 250).length,
    over500: gaps.filter((g) => g > 500).length,
  },
  phoneAddresses: addresses,
  perDay,
};
const json = JSON.stringify(result, null, 2);
if (flags.out) writeFileSync(flags.out, json + "\n");
if (flags.items) writeFileSync(flags.items, JSON.stringify(items, null, 1) + "\n");
console.log(json);

// ── --wire: what the built Opus path puts on the socket ──────────────────────────────────────────
async function wire() {
  const work = WORK;
  // Hermetic, as the unit tests are: a throwaway working folder (the server's log goes there),
  // settings and config of its own, never the user's live Kiko.
  await import("../../tests/setup.ts");
  // The app's socket on the home network: every message one sealed record, 17 bytes more (its type byte and tag).
  const { LocalPhone } = await import("../../tests/support/local-phone.ts");
  const SEALED = 17;
  const { PhoneServer } = await import("../../src/remote/server.ts");
  const { Pairing } = await import("../../src/remote/pairing.ts");
  const { opus } = await import("../../src/platform/macos/opus.ts");
  const { joinPackets, splitPackets, frame, KIND } = await import("../../src/remote/opus.ts");

  const TEXT = [
    "Tell the clipkit session to run the tests and commit when they pass.",
    "What did Lacy say about the migration? Read me the last summary.",
    "Okay, go ahead and push it, then start a new session in the scratch folder.",
    "No, the other one. The atlas agents session, the one that was waiting for me.",
  ].join(" ");
  const say = (rate: number) => {
    const file = join(work, `wire-${rate}.wav`);
    execFileSync("say", ["-o", file, `--data-format=LEI16@${rate}`, TEXT]);
    const wav = readFileSync(file);
    return wav.subarray(wav.indexOf("data") + 8);
  };
  const up = say(UP_RATE);
  const down = say(DOWN_RATE);
  const upSeconds = up.length / 2 / UP_RATE;
  const downSeconds = down.length / 2 / DOWN_RATE;

  const heard: Buffer[] = [];
  let talking = false;
  const hub = {
    talkStart: () => ((talking = true), null),
    talkAudio: (pcm: Buffer) => void heard.push(pcm),
    talkEnd: () => void (talking = false),
    type: () => null,
    permission: () => null,
    answers: () => null,
    talking: () => talking,
    playOnMac: () => {},
    catchUp: () => {},
    catchUpSummary: () => {},
    catchUpStop: () => false,
  };
  const pairing = new Pairing(join(work, "wire-phones.json"));
  const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
  const server = new PhoneServer({ hub, pairing, port: 0, host: "127.0.0.1", network, presenceMs: 60_000 });
  const port = await server.start();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** A fake phone: what it got, byte for byte (payload plus the frame header the server wrote). */
  async function phone(codecs: string[] | null) {
    const ws = new LocalPhone(`ws://127.0.0.1:${port}`);
    const got = { json: 0, binary: 0, messages: 0, audioMessages: 0, codec: "pcm" };
    let sentBytes = 0;
    let sentMessages = 0;
    const waiters: Array<() => void> = [];
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      const n = data.length + SEALED + wsHeader(data.length + SEALED, false);
      got.messages++;
      if (isBinary) {
        got.binary += n;
        got.audioMessages++;
      } else {
        const m = JSON.parse(String(data));
        if (m.type === "audio") {
          got.json += n;
          got.audioMessages++;
        }
        if (m.type === "audio_codec") got.codec = m.codec;
        if (m.type === "welcome" || m.type === "audio_codec") waiters.splice(0).forEach((w) => w());
      }
    });
    await new Promise((r) => ws.once("open", r));
    const send = (m: string | Buffer, audio: boolean) => {
      ws.send(m);
      if (audio) {
        const len = Buffer.byteLength(m) + SEALED;
        sentBytes += len + wsHeader(len, true);
        sentMessages++;
      }
    };
    const json = (m: Record<string, unknown>) => send(JSON.stringify({ v: 1, ...m }), false);
    const next = () => new Promise<void>((r) => waiters.push(r));
    let w = next();
    json({ type: "pair", code: pairing.open().code, device: codecs ? "Opus phone" : "Older phone", appVersion: "0.2.0" });
    await w;
    json({ type: "presence", state: "back" });
    json({ type: "play_on_phone", on: true });
    if (codecs) {
      w = next();
      json({ type: "audio_codecs", codecs });
      await w;
    }
    return { ws, got, json, send, sent: () => ({ bytes: sentBytes, messages: sentMessages }) };
  }

  const opusPhone = await phone(["opus"]);
  const pcmPhone = await phone(null);

  // Up, the Opus phone: as the app sends a press (the first 20 ms at once, then 100 ms chunks).
  const enc = opus.encoder(UP_RATE, 24_000);
  const chunks = [up.subarray(0, 640)];
  for (let at = 640; at < up.length; at += 3200) chunks.push(up.subarray(at, at + 3200));
  opusPhone.json({ type: "talk_start" });
  await sleep(20);
  for (const c of chunks) {
    const packets = splitPackets(await enc.push(c))!;
    if (packets.length) opusPhone.send(frame(1, KIND.talk, joinPackets(packets)), true);
  }
  const tail = splitPackets(await enc.flush())!;
  if (tail.length) opusPhone.send(frame(1, KIND.talk, joinPackets(tail)), true);
  enc.close();
  opusPhone.json({ type: "talk_end" });
  await new Promise<void>((r) => {
    const check = () => (talking ? setTimeout(check, 10) : r());
    check();
  });
  const decodedUp = Buffer.concat(heard).length;
  heard.length = 0;
  const opusUp = opusPhone.sent();

  // Up, the older phone: talk_audio as base64 in JSON, the same chunks.
  pcmPhone.json({ type: "talk_start" });
  await sleep(20);
  for (const c of chunks) pcmPhone.send(JSON.stringify({ v: 1, type: "talk_audio", data: c.toString("base64") }), true);
  pcmPhone.json({ type: "talk_end" });
  await sleep(100);
  const pcmUp = pcmPhone.sent();
  const pcmUpHeard = Buffer.concat(heard).length;

  // Down: the voice in 80 ms chunks, ~2x real time, as Pocket makes it; both phones listen.
  const t0 = Date.now();
  const chunk = (DOWN_RATE * 2 * 80) / 1000;
  for (let at = 0; at < down.length; at += chunk) {
    server.audio(down.subarray(at, at + chunk));
    await sleep(40);
  }
  await sleep(600); // the line's end: the tail goes once nothing has come for 250 ms
  const madeMs = Date.now() - t0;

  opusPhone.ws.close();
  pcmPhone.ws.close();
  server.stop();
  const kb = (bytes: number, seconds: number) => Math.round((bytes / seconds / 1000) * 100) / 100;
  const perSecond = (n: number, seconds: number) => Math.round((n / seconds) * 10) / 10;
  // Below the WebSocket (estimate, as above): TCP/IP and Tailscale's headers, once per segment.
  const tailscale = (bytes: number, messages: number) => bytes + messages * (TCP_IP + TAILSCALE);
  return {
    date: new Date().toISOString(),
    speech: { text: TEXT, upSeconds: Math.round(upSeconds * 100) / 100, downSeconds: Math.round(downSeconds * 100) / 100, voice: "say", downMadeMs: madeMs },
    codecs: { opusPhone: opusPhone.got.codec, olderPhone: pcmPhone.got.codec },
    up: {
      opus: {
        kbPerSecond: kb(opusUp.bytes, upSeconds),
        messagesPerSecond: perSecond(opusUp.messages, upSeconds),
        tailscaleKbPerSecond: kb(tailscale(opusUp.bytes, opusUp.messages), upSeconds),
        decodedSeconds: Math.round((decodedUp / 2 / UP_RATE) * 100) / 100,
      },
      pcm: {
        kbPerSecond: kb(pcmUp.bytes, upSeconds),
        messagesPerSecond: perSecond(pcmUp.messages, upSeconds),
        tailscaleKbPerSecond: kb(tailscale(pcmUp.bytes, pcmUp.messages), upSeconds),
        heardSeconds: Math.round((pcmUpHeard / 2 / UP_RATE) * 100) / 100,
        note: "Node's JSON; the phone's JSONEncoder also escapes every / (+~6.5% of the base64)",
      },
    },
    down: {
      opus: {
        kbPerSecond: kb(opusPhone.got.binary, downSeconds),
        messagesPerSecond: perSecond(opusPhone.got.audioMessages, downSeconds),
        tailscaleKbPerSecond: kb(tailscale(opusPhone.got.binary, opusPhone.got.audioMessages), downSeconds),
        jsonAudioBytes: opusPhone.got.json,
      },
      pcm: {
        kbPerSecond: kb(pcmPhone.got.json, downSeconds),
        messagesPerSecond: perSecond(pcmPhone.got.audioMessages, downSeconds),
        tailscaleKbPerSecond: kb(tailscale(pcmPhone.got.json, pcmPhone.got.audioMessages), downSeconds),
        binaryBytes: pcmPhone.got.binary,
      },
    },
  };
}
