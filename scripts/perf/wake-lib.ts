// What the wake-word scripts share (wake-name.ts, one name in depth; wake-names.ts, many names
// side by side): `say` clips as the mic sends them, the app's Apple helper fed one press at a
// time, and where in a transcript the name was. Imports nothing of src/, so a script can point the
// app's log and settings at its work folder before it loads those.
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

export const RATE = 16000;
export const hash = (...parts: string[]) => createHash("sha1").update(parts.join("\0")).digest("hex").slice(0, 12);

/** 16-bit mono PCM out of a WAV file. */
export function wavPcm(file: string): Buffer {
  const b = readFileSync(file);
  let at = 12;
  while (at < b.length) {
    const id = b.toString("ascii", at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === "data") return b.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size & 1);
  }
  throw new Error(`no data in ${file}`);
}

/** With a little quiet either side, as a mic hears it. */
export const padded = (pcm: Buffer) => Buffer.concat([Buffer.alloc(RATE * 2 * 0.3), pcm, Buffer.alloc(RATE * 2 * 0.7)]);

/** A `say` clip (files only, nothing played), rendered once into `clipsDir` and kept. */
export function sayClip(clipsDir: string, voice: string, text: string): Buffer {
  const base = join(clipsDir, `say-${hash(voice, text)}`);
  if (!existsSync(`${base}.wav`)) {
    execFileSync("say", ["-v", voice, "-o", `${base}.aiff`, text]);
    execFileSync("afconvert", ["-f", "WAVE", "-d", `LEI16@${RATE}`, "-c", "1", `${base}.aiff`, `${base}.wav`]);
  }
  return padded(wavPcm(`${base}.wav`));
}

const run = promisify(execFile);
/** The same, rendered in the background (many at once); the PCM is read when it's used. */
export async function renderSayClip(clipsDir: string, voice: string, text: string): Promise<string> {
  const base = join(clipsDir, `say-${hash(voice, text)}`);
  if (!existsSync(`${base}.wav`)) {
    await run("say", ["-v", voice, "-o", `${base}.aiff`, text]);
    await run("afconvert", ["-f", "WAVE", "-d", `LEI16@${RATE}`, "-c", "1", `${base}.aiff`, `${base}.wav`]);
  }
  return `${base}.wav`;
}

/** 16-bit mono PCM at RATE as a WAV file. */
export function wavFile(pcm: Buffer): Buffer {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVEfmt ", 8, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

/**
 * The speech in `pcm` between gaps of near silence at least `minGap` seconds long (what `say`'s
 * [[slnc]] leaves between phrases; a pause in a phrase is far shorter), each with 0.1 s either side.
 */
function splitOnSilence(pcm: Buffer, minGap: number): Buffer[] {
  const n = pcm.length >> 1;
  const quiet = (i: number) => Math.abs(pcm.readInt16LE(i * 2)) < 16;
  const gap = Math.round(minGap * RATE);
  const margin = Math.round(0.1 * RATE);
  const parts: Buffer[] = [];
  let start = -1;
  let run = 0;
  let lastLoud = -1;
  for (let i = 0; i < n; i++) {
    if (quiet(i)) {
      run++;
      if (start >= 0 && run === gap) {
        parts.push(pcm.subarray(Math.max(0, start - margin) * 2, Math.min(n, lastLoud + 1 + margin) * 2));
        start = -1;
      }
    } else {
      if (start < 0) start = i;
      lastLoud = i;
      run = 0;
    }
  }
  if (start >= 0) parts.push(pcm.subarray(Math.max(0, start - margin) * 2, Math.min(n, lastLoud + 1 + margin) * 2));
  return parts;
}

/**
 * Many phrases in one voice, rendered by one `say` (its start-up, not the speech, is most of the
 * time a clip takes) with long silences between, split there, and kept one file per phrase as
 * renderSayClip keeps them. Should the split not give one piece per phrase, each is rendered alone.
 */
export async function renderSayBatch(clipsDir: string, voice: string, texts: string[]): Promise<void> {
  const missing = [...new Set(texts)].filter((t) => !existsSync(join(clipsDir, `say-${hash(voice, t)}.wav`)));
  if (!missing.length) return;
  const batch = join(clipsDir, `batch-${hash(voice, ...missing)}.wav`);
  const script = missing.map((t) => `${t} [[slnc 1500]]`).join(" ");
  await run("say", ["-v", voice, "--file-format=WAVE", `--data-format=LEI16@${RATE}`, "-o", batch, script]);
  const parts = splitOnSilence(wavPcm(batch), 1.0);
  if (parts.length === missing.length) {
    missing.forEach((t, i) => writeFileSync(join(clipsDir, `say-${hash(voice, t)}.wav`), wavFile(parts[i])));
  } else {
    console.error(`say batch for ${voice}: ${parts.length} pieces for ${missing.length} phrases, rendering one by one`);
    for (const t of missing) await renderSayClip(clipsDir, voice, t);
  }
  unlinkSync(batch);
}

export type Heard = { text: string; live: string[] };

/** Kiko's Apple helper (native/macos/speech.swift, built by the caller), one press at a time. */
export class Apple {
  private proc;
  private buffer = "";
  private waiting = new Map<number, (text: string) => void>();
  private live = new Map<number, string[]>();
  private ready: Promise<void>;
  private hints = "";
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
        else if (m.type === "error" || m.type === "status") console.error("speech:", m.message);
        else if (m.type === "interim") this.live.get(m.id)?.push(m.text);
        else if (m.type === "final") this.waiting.get(m.id)?.(m.text);
      }
    });
  }
  private frame(type: string, payload: Buffer) {
    const head = Buffer.alloc(5);
    head.write(type, 0, "ascii");
    head.writeUInt32LE(payload.length, 1);
    this.proc.stdin.write(Buffer.concat([head, payload]));
  }
  private id = 0;
  /** The words to expect, as the app sends them (they apply from the next press). */
  setHints(hints: string[]) {
    const json = JSON.stringify(hints);
    if (json === this.hints) return false;
    this.hints = json;
    this.frame("C", Buffer.from(json));
    return true;
  }
  async transcribe(pcm: Buffer): Promise<Heard> {
    await this.ready;
    const id = ++this.id;
    const live: string[] = [];
    this.live.set(id, live);
    const done = new Promise<string>((r) => this.waiting.set(id, r));
    const idBuf = Buffer.alloc(4);
    idBuf.writeUInt32LE(id);
    this.frame("B", idBuf);
    // 100 ms chunks, a little faster than real time.
    for (let at = 0; at < pcm.length; at += 3200) {
      this.frame("A", pcm.subarray(at, at + 3200));
      await new Promise((r) => setTimeout(r, 15));
    }
    this.frame("E", Buffer.alloc(0));
    const text = await done;
    this.waiting.delete(id);
    this.live.delete(id);
    return { text, live };
  }
  close() {
    this.proc.stdin.end();
  }
}

/** `n` workers taking `items` in turn. */
export async function pool<T>(items: T[], n: number, fn: (item: T, worker: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async (_, w) => {
      while (next < items.length) await fn(items[next++], w);
    }),
  );
}

// What the recognizer wrote where the name was: the words between the opener and the next word of the phrase.
const OPENERS = new Set(["hey", "hi", "ok", "okay", "oh", "um", "umm", "uh", "so", "to", "two", "tell"]);
export function nameSlot(transcript: string, template: string, next: string): string {
  const words = transcript
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const before = template
    .split("{N}")[0]
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  let i = 0;
  // Skip the opener the phrase has ("hey", "um", "tell"), and any the recognizer added.
  while (i < words.length && (OPENERS.has(words[i]) || before.includes(words[i])) && i < before.length + 1) i++;
  let end = next ? words.indexOf(next, i + 1) : -1;
  if (end < 0) end = Math.min(words.length, i + 1);
  return words.slice(i, Math.min(end, i + 3)).join(" ");
}
