// How a voice says what's hard to say from its spelling (numbers, money, versions, "AI"), checked by
// ear: each candidate spelling put in a real line, said by the voice several times (Pocket isn't
// deterministic) and transcribed back by the app's own Apple recognizer (native/macos/speech.swift,
// built into the work folder), then scored on whether what came back is the thing as written, with
// no sentence break inside it ("0. 3. 1": the dot read as a full stop). Each case also gets "app":
// the line as respell() gives it for that voice today, so a rerun checks the rules themselves.
// Written 2026-11-12 after "0.3.1" was read with a pause, or without its dots, and "AI" as "I".
//
//   node scripts/perf/pocket-said.ts --python <checkout>/pocket/.venv/bin/python
//       [--engine pocket|say] [--voices george,alba,marius] [--runs 3] [--port 8799]
//       [--cases ai,version] [--app-only] [--work <dir>] [--out /tmp/pocket-said-<date>.json]
//
// Pocket: a server of its own on --port (never the app's 8737), from --python's venv with that
// venv's model folder (pocket-hf beside it), stopped when the script ends. `say`: the macOS voice
// (--voices are `say -v` names). Audio and transcripts are kept in --work, so a rerun only makes
// what's missing. Nothing is played, no keys, no calls out; never touches the app's settings,
// sockets or tmux.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { type Engine, respell } from "../../src/core/pronunciation.ts";
import { Apple, padded, pool, RATE as APPLE_RATE, wavPcm } from "./wake-lib.ts";

const ROOT = join(import.meta.dirname, "../..");
const { values: flags } = parseArgs({
  options: {
    engine: { type: "string", default: "pocket" },
    python: { type: "string" },
    port: { type: "string", default: "8799" },
    voices: { type: "string" },
    runs: { type: "string", default: "3" },
    cases: { type: "string" },
    "app-only": { type: "boolean", default: false },
    work: { type: "string", default: join(tmpdir(), "kiko-pocket-said") },
    out: { type: "string" },
    parallel: { type: "string", default: "2" },
  },
});
const ENGINE = flags.engine === "say" ? "say" : "pocket";
const VOICE_ENGINE: Engine = ENGINE === "say" ? "macos" : "pocket";
const VOICES = (flags.voices ?? (ENGINE === "say" ? "Samantha" : "george,alba,marius")).split(",");
const RUNS = ENGINE === "say" ? 1 : Number(flags.runs); // `say` says a line the same way every time
const WORK = flags.work!;
const CLIPS = join(WORK, ENGINE);
mkdirSync(CLIPS, { recursive: true });

// ── The cases ────────────────────────────────────────────────────────────────────────────────────

/**
 * `line`: a real line (most from the logs) with {x} where the thing goes; `written`: the thing as
 * Kiko gets it; `want`: what the transcript (normalised: see heard()) must hold for it to count;
 * `candidates`: spellings to try, besides "written" (as is) and "app" (respell()).
 */
type Case = { id: string; group: string; line: string; written: string; want: RegExp; candidates: string[] };

const AI = /\b(?:ai|a\.i\.?)(?=\W|$)/;
const AI_CANDIDATES = ["A I", "A. I.", "A.I.", "A-I", "Ay I", "ay eye", "eh eye", "eh I", "ey eye", "A eye"];
// Round 2 (after "A eye" and "AI" as written did best): the same in more lines.
const AI_SHORTLIST = ["A I", "A eye", "eh eye", "A-I"];
const VERSION_SEP = "(?:\\.|,? point |,? dot )";
const ver = (...parts: string[]) => new RegExp(`(?:^|[^\\d.])(?:version |v)?${parts.join(VERSION_SEP)}(?![\\d])`);
// A decimal: Apple writes "one point five" as "one. 5", so a space after the point is let through
// here; a dot read as a full stop is caught by the pause instead (see Row.clean).
const dec = (whole: string, decimals: string) => new RegExp(`\\b${whole}(?:\\. ?| point )${decimals}\\b`);

const CASES: Case[] = [
  // "AI" said as "I": lines where "I" would also make sense, so the recognizer can't guess it.
  { id: "ai-1", group: "ai", line: "Then {x} wrote the rest of it.", written: "AI", want: AI, candidates: AI_CANDIDATES },
  { id: "ai-2", group: "ai", line: "It says {x} should check it first.", written: "AI", want: AI, candidates: AI_CANDIDATES },
  { id: "ai-3", group: "ai", line: "The trial runs on {x} credits.", written: "AI", want: AI, candidates: AI_CANDIDATES },
  { id: "ai-4", group: "ai", line: "Kiko's {x} sums up each reply.", written: "AI", want: AI, candidates: AI_SHORTLIST },
  { id: "ai-5", group: "ai", line: "So {x} can say it back to you.", written: "AI", want: AI, candidates: AI_SHORTLIST },
  { id: "ai-6", group: "ai", line: "The {x} answered in two seconds.", written: "AI", want: AI, candidates: AI_SHORTLIST },
  { id: "openai", group: "ai", line: "It goes through {x} for now.", written: "OpenAI", want: /\bopen ?(?:ai|a\.i\.?)(?=\W|$)/, candidates: ["open A I", "open A eye", "open eh eye"] },
  // Other letters said one by one with a bare "A" in them.
  { id: "api", group: "letters", line: "The {x} answers again.", written: "API", want: /\b(?:api|a\.p\.i\.?)(?=\W|$)/, candidates: ["A P I", "Ay P I", "ay P I", "A-P-I", "eh P I"] },
  { id: "api-2", group: "letters", line: "Then the {x} key was wrong.", written: "API", want: /\b(?:api|a\.p\.i\.?)(?=\W|$)/, candidates: ["A P I", "A-P-I", "eh P I"] },
  { id: "aws", group: "letters", line: "It runs on {x} for now.", written: "AWS", want: /\b(?:aws|a\.w\.s\.?)(?=\W|$)/, candidates: ["A W S", "Ay W S", "ay W S", "A-W-S", "eh W S"] },
  {
    id: "dot-ai",
    group: "domain",
    line: "It calls {x} for that.",
    written: "api.openrouter.ai",
    want: /\bapi(?: dot |\.)open ?r[eo]u?ter(?: dot |\.)(?:ai|a\.i\.?)(?=\W|$)/,
    candidates: ["A P I dot openrouter dot A I", "A-P-I dot openrouter dot A I", "A P I dot openrouter dot AI", "A-P-I dot openrouter dot AI"],
  },
  {
    id: "claude-ai",
    group: "domain",
    line: "Sign in on {x} first.",
    written: "claude.ai",
    want: /\b(?:claude|clawed)(?: dot |\.)(?:ai|a\.i\.?)(?=\W|$)/,
    candidates: ["clawed dot A I", "clawed dot AI"],
  },
  // Versions (logs, 2026-11-12).
  {
    id: "ver-1",
    group: "version",
    line: "People are still getting the older {x} build.",
    written: "0.3.1",
    want: ver("0", "3", "1"),
    candidates: ["0 point 3 point 1", "zero point three point one", "zero dot three dot one", "oh point three point one"],
  },
  {
    id: "ver-2",
    group: "version",
    line: "The main blocker is shipping {x}, which the beta depends on.",
    written: "0.3.2",
    want: ver("0", "3", "2"),
    candidates: ["0 point 3 point 2", "zero point three point two", "zero dot three dot two"],
  },
  {
    id: "ver-3",
    group: "version",
    line: "Production is on {x} now.",
    written: "v0.19.1",
    want: ver("0", "19", "1"),
    candidates: ["v 0 point 19 point 1", "version 0 point 19 point 1", "version zero point nineteen point one"],
  },
  { id: "ver-4", group: "version", line: "Want it to ship {x}?", written: "0.4.13", want: ver("0", "4", "13"), candidates: ["0 point 4 point 13", "zero point four point thirteen"] },
  { id: "ver-5", group: "version", line: "It's ready to ship as version {x}.", written: "1.0", want: /version 1(?:\. ?| point )0\b/, candidates: ["1 point 0"] },
  // Decimals.
  { id: "dec-1", group: "decimal", line: "It got about {x} times faster.", written: "1.5", want: dec("1", "5"), candidates: ["1 point 5", "one point five"] },
  {
    id: "dec-2",
    group: "decimal",
    line: "The error rate fell to {x} on the new build.",
    written: "0.03",
    want: /\b0?(?:\. ?| point )0 ?3\b/,
    candidates: ["0 point 0 3", "zero point zero three", "0 point zero 3"],
  },
  { id: "dec-3", group: "decimal", line: "The median was {x} seconds.", written: "52.5", want: dec("52", "5"), candidates: ["52 point 5", "fifty two point five"] },
  { id: "dec-4", group: "decimal", line: "It waits {x} seconds before it gives up.", written: "2.5", want: dec("2", "5"), candidates: ["2 point 5"] },
  { id: "dec-5", group: "decimal", line: "The model is {x} times the price of Haiku.", written: "3.7", want: dec("3", "7"), candidates: ["3 point 7"] },
  { id: "dec-6", group: "decimal", line: "Each one took {x} seconds at most.", written: "1.3", want: dec("1", "3"), candidates: ["1 point 3"] },
  { id: "times", group: "decimal", line: "It's {x} faster than before.", written: "3.5x", want: /\b3(?:\. ?| point )5 ?(?:x|times)\b/, candidates: ["3 point 5 times", "3 point 5 x"] },
  // Money (logs, 2026-11-12). Apple writes "fifty cents" as "¢50".
  {
    id: "usd-1",
    group: "money",
    line: "Each user gets a daily share of {x}.",
    written: "$0.50",
    want: /(?:\b50 ?(?:cents|¢)|¢50\b|\$0?\.50\b|\b0 dollars (?:and )?50\b)/,
    candidates: ["50 cents", "fifty cents", "0 dollars 50"],
  },
  { id: "usd-2", group: "money", line: "The trial ends after 7 days or {x} of use.", written: "$2", want: /(?:\$2\b|\b2 dollars\b)/, candidates: ["2 dollars", "two dollars"] },
  { id: "usd-3", group: "money", line: "There's an all-trials daily cap of {x} a day.", written: "$25", want: /(?:\$25\b|\b25 dollars) a day/, candidates: ["25 dollars"] },
  {
    id: "usd-4",
    group: "money",
    line: "That plan is {x} a month.",
    written: "$8.99",
    want: /(?:\$8\.99\b|\b8 dollars (?:and )?99\b|\b8 99\b|\b8\.99\b)/,
    candidates: ["8 dollars 99", "8 99", "8 dollars and 99 cents", "eight ninety-nine"],
  },
  { id: "usd-5", group: "money", line: "It costs about {x} a day.", written: "$8", want: /(?:\$8\b|\b8 dollars\b)/, candidates: ["8 dollars"] },
  { id: "usd-6", group: "money", line: "A year of it is {x} now.", written: "$24.99", want: /(?:\$24\.99\b|\b24 dollars (?:and )?99\b|\b24\.99\b)/, candidates: ["24 dollars 99"] },
  {
    id: "usd-7",
    group: "money",
    line: "That came to {x} a year.",
    written: "$12.03",
    want: /(?:\$12\.03\b|\b12 dollars (?:and )?(?:0 )?3(?: cents)?\b|\b12\.03\b)/,
    candidates: ["12 dollars 03", "12 dollars and 3 cents", "12 dollars 3 cents"],
  },
  { id: "usd-8", group: "money", line: "The cheapest one is {x}.", written: "$1", want: /(?:\$1\b|\b1 dollar\b)/, candidates: ["1 dollar"] },
  // Percentages.
  { id: "pct-1", group: "percent", line: "The tests pass {x} of the time.", written: "93%", want: /\b93 ?(?:%|per ?cent)/, candidates: ["93 percent"] },
  { id: "pct-2", group: "percent", line: "It used {x} of the allowance.", written: "5.5%", want: /\b5(?:\. ?| point )5 ?(?:%|per ?cent)/, candidates: ["5 point 5 percent"] },
  // Left alone: said right as written?
  { id: "big", group: "alone", line: "It read {x} lines in all.", written: "2,888", want: /\b2,?888\b/, candidates: ["2888", "2 thousand 888"] },
  // Apple writes "six fifteen" as "6.15" or "615".
  { id: "time", group: "alone", line: "It starts at {x} tonight.", written: "6:15", want: /\b6[:.]?15\b|\b6 15\b/, candidates: [] },
];

// ── Saying ───────────────────────────────────────────────────────────────────────────────────────

const hash = (...parts: string[]) => createHash("sha1").update(parts.join("\0")).digest("hex").slice(0, 12);

/** 24 kHz (Pocket) or 22 kHz (`say`) mono s16 PCM and its rate, out of a WAV (its data chunk; Pocket streams it with no size). */
function pcmOf(wav: Buffer): { pcm: Int16Array; rate: number } {
  const rate = wav.readUInt32LE(24);
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === "data") {
      const end = Math.min(wav.length, off + 8 + (size === 0xffffffff || size === 0 ? wav.length : size));
      const data = wav.subarray(off + 8, end - ((end - off - 8) % 2));
      return { pcm: new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length)), rate };
    }
    off += 8 + size + (size % 2);
  }
  return { pcm: new Int16Array(0), rate };
}

/**
 * The longest silence inside the speech (ms): a dot read as a full stop leaves one where there
 * should be none. 10 ms frames, "silent" under -35 dB of the loudest; the ends left out.
 */
function longestPause(pcm: Int16Array, rate: number): number {
  const frame = Math.round(rate / 100);
  const rms: number[] = [];
  for (let at = 0; at + frame <= pcm.length; at += frame) {
    let sum = 0;
    for (let i = at; i < at + frame; i++) sum += pcm[i] * pcm[i];
    rms.push(Math.sqrt(sum / frame));
  }
  const floor = Math.max(...rms, 1) * 10 ** (-35 / 20);
  const loud = rms.map((r) => r > floor);
  const first = loud.indexOf(true);
  const last = loud.lastIndexOf(true);
  let longest = 0;
  let run = 0;
  for (let i = first; i <= last; i++) {
    run = loud[i] ? 0 : run + 1;
    longest = Math.max(longest, run);
  }
  return longest * 10;
}

// The Pocket server this script started (in a holder: it's set inside main and stopped in finally).
const server: { proc: ChildProcess | null } = { proc: null };
const stopServer = () => {
  server.proc?.stdin?.end();
  server.proc?.kill("SIGTERM");
};

async function startPocket(port: number) {
  if (!flags.python) throw new Error("--python <checkout>/pocket/.venv/bin/python: the Pocket venv to run its server from");
  const venv = dirname(dirname(flags.python));
  const hf = join(dirname(venv), "pocket-hf");
  const base = `http://127.0.0.1:${port}`;
  const answering = async () => {
    try {
      const res = await fetch(`${base}/openapi.json`, { signal: AbortSignal.timeout(1000) });
      return res.ok;
    } catch {
      return false;
    }
  };
  if (await answering()) throw new Error(`something already answers on port ${port}: pick another --port`);
  const log = openSync(join(WORK, "pocket-server.log"), "w");
  // Its stdin a pipe of ours: serve.py exits when it closes, so the server ends with this script.
  const pocket = spawn(flags.python, [join(ROOT, "pocket/serve.py"), "--host", "127.0.0.1", "--port", String(port), "--default-voice", VOICES[0]], {
    stdio: ["pipe", log, log],
    env: { ...process.env, HF_HOME: hf, HF_HUB_CACHE: join(hf, "hub"), HF_XET_CACHE: join(hf, "xet") },
  });
  server.proc = pocket;
  const deadline = Date.now() + 300_000;
  while (!(await answering())) {
    if (pocket.exitCode !== null) throw new Error(`the Pocket server exited (its log: ${join(WORK, "pocket-server.log")})`);
    if (Date.now() > deadline) throw new Error("the Pocket server didn't start in 5 minutes");
    await new Promise((r) => setTimeout(r, 500));
  }
  return base;
}

async function pocketClip(base: string, voice: string, text: string): Promise<Buffer> {
  const form = new FormData();
  form.set("text", text);
  form.set("voice_url", voice);
  const res = await fetch(`${base}/tts`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`/tts ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** A clip as a WAV file (made once), and the same at 16 kHz for the recognizer. */
async function clip(base: string, voice: string, text: string, run: number): Promise<{ file: string; apple: string }> {
  const name = join(CLIPS, `${hash(ENGINE, voice, text, String(run))}`);
  const file = `${name}.wav`;
  if (!existsSync(file)) {
    if (ENGINE === "say") execFileSync("say", ["-v", voice, "--file-format=WAVE", "--data-format=LEI16@22050", "-o", file, text]);
    else writeFileSync(file, await pocketClip(base, voice, text));
  }
  const apple = `${name}.16k.wav`;
  if (!existsSync(apple)) {
    // Pocket's streamed WAV has no sizes in its header; afconvert wants them.
    const { pcm, rate } = pcmOf(readFileSync(file));
    const fixed = `${name}.fixed.wav`;
    writeFileSync(fixed, wavAt(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), rate));
    execFileSync("afconvert", ["-f", "WAVE", "-d", `LEI16@${APPLE_RATE}`, "-c", "1", fixed, apple]);
  }
  return { file, apple };
}

function wavAt(pcm: Buffer, rate: number): Buffer {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVEfmt ", 8, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

// ── Hearing ──────────────────────────────────────────────────────────────────────────────────────

const UNITS: Record<string, number> = {
  zero: 0,
  oh: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/**
 * A transcript as the cases' `want` reads it: lowercase, number words as digits ("fifty two" →
 * 52, "oh" only between numbers), hyphens as spaces. Commas, full stops and question marks stay:
 * "0. 3. 1" (a sentence break) mustn't pass as "0.3.1".
 */
export function heard(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[-–]/g, " ")
    .replace(/(?<=\d)\.(?=[a-z])|(?<=[a-z])\.(?=\d)/g, " point ") // "0.3.one"
    .replace(/\$(?=[a-z])/g, "$ ") // "$one": "one dollar"
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const [, w, tail] = /^(.*?)([.,!?;:]*)$/.exec(words[i])!;
    const tens = TENS[w];
    if (tens !== undefined) {
      const [, next, nextTail] = /^(.*?)([.,!?;:]*)$/.exec(words[i + 1] ?? "")!;
      if (!tail && next && UNITS[next] !== undefined && UNITS[next] > 0 && UNITS[next] < 10) {
        out.push(String(tens + UNITS[next]) + nextTail);
        i++;
        continue;
      }
      out.push(String(tens) + tail);
      continue;
    }
    if (UNITS[w] !== undefined && (w !== "oh" || /\d$/.test(out.at(-1) ?? "") || /^(?:point|dot)$/.test(out.at(-1) ?? ""))) {
      out.push(String(UNITS[w]) + tail);
      continue;
    }
    out.push(words[i]);
  }
  return out.join(" ").replace(/\$ (?=\d)/g, "$");
}

// A pause this long inside a line with no comma at the thing is a full stop that shouldn't be there
// (Pocket's own between words: 40-110 ms; after "A. I.": 290-390 ms).
const BREAK_MS = 250;

/** `ok`: heard as written; `clean`: that, and no BREAK_MS pause in the line. */
type Row = { case: string; group: string; candidate: string; text: string; voice: string; run: number; transcript: string; heard: string; ok: boolean; clean: boolean; pauseMs: number };

async function main() {
  const base = ENGINE === "pocket" ? await startPocket(Number(flags.port)) : "";
  const only = flags.cases ? new Set(flags.cases.split(",")) : null;
  const cases = CASES.filter((c) => !only || only.has(c.group) || only.has(c.id));
  type Job = { c: Case; candidate: string; text: string; voice: string; run: number };
  const jobs: Job[] = [];
  for (const c of cases) {
    const said = (x: string) => c.line.replace("{x}", x);
    const tried = new Map<string, string>(); // text → its first name ("app" may be the same as one tried)
    const add = (candidate: string, text: string) => {
      if (tried.has(text) && candidate !== "app") return;
      tried.set(text, candidate);
      for (const voice of VOICES) for (let run = 0; run < RUNS; run++) jobs.push({ c, candidate, text, voice, run });
    };
    const written = c.written ? said(c.written) : c.line;
    add("app", respell(written, VOICE_ENGINE, []));
    if (!flags["app-only"]) {
      add("written", written);
      for (const k of c.candidates) add(k, said(k));
    }
  }
  console.log(`${jobs.length} clips (${ENGINE}: ${VOICES.join(", ")}; ${RUNS} runs each)`);

  const binary = join(WORK, "speech");
  if (!existsSync(binary)) execFileSync("swiftc", ["-O", join(ROOT, "native/macos/speech.swift"), "-o", binary]);
  const parallel = Number(flags.parallel);
  const apples = Array.from({ length: parallel }, () => new Apple(binary));
  const transcriptsFile = join(WORK, `transcripts-${ENGINE}.json`);
  const transcripts: Record<string, string> = existsSync(transcriptsFile) ? JSON.parse(readFileSync(transcriptsFile, "utf8")) : {};
  const rows: Row[] = [];
  let done = 0;
  let audioSeconds = 0;
  const started = Date.now();
  // Pocket one clip at a time (its server says one at a time anyway); the recognizers in parallel.
  await pool(jobs, parallel, async (j, w) => {
    const { file, apple } = await clip(base, j.voice, j.text, j.run);
    const { pcm, rate } = pcmOf(readFileSync(file));
    audioSeconds += pcm.length / rate;
    const key = hash(apple);
    transcripts[key] ??= (await apples[w].transcribe(padded(wavPcm(apple)))).text;
    const transcript = transcripts[key];
    const h = heard(transcript);
    const ok = j.c.want.test(h);
    const pauseMs = longestPause(pcm, rate);
    rows.push({ case: j.c.id, group: j.c.group, candidate: j.candidate, text: j.text, voice: j.voice, run: j.run, transcript, heard: h, ok, clean: ok && pauseMs < BREAK_MS, pauseMs });
    if (++done % 25 === 0) {
      writeFileSync(transcriptsFile, JSON.stringify(transcripts));
      console.log(`  ${done}/${jobs.length} (${Math.round((Date.now() - started) / 1000)} s)`);
    }
  });
  writeFileSync(transcriptsFile, JSON.stringify(transcripts));
  for (const a of apples) a.close();
  stopServer();

  // Per case and candidate: how often it came back right, and the median longest pause.
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const summary = cases.map((c) => {
    const mine = rows.filter((r) => r.case === c.id);
    const names = [...new Set(mine.map((r) => r.candidate))];
    return {
      case: c.id,
      line: c.written ? c.line.replace("{x}", c.written) : c.line,
      candidates: names.map((name) => {
        const rs = mine.filter((r) => r.candidate === name);
        const ok = rs.filter((r) => r.ok).length;
        const clean = rs.filter((r) => r.clean).length;
        const misses = [...new Set(rs.filter((r) => !r.clean).map((r) => (r.ok ? `(pause ${r.pauseMs} ms) ${r.transcript}` : r.transcript)))].slice(0, 4);
        return { candidate: name, text: rs[0].text, clean, ok, of: rs.length, pauseMs: median(rs.map((r) => r.pauseMs)), misses };
      }),
    };
  });
  for (const s of summary) {
    console.log(`\n${s.case}: ${s.line}`);
    for (const k of s.candidates)
      console.log(
        `  ${`${k.clean}/${k.of}`.padStart(5)} (heard ${k.ok})  pause ${String(k.pauseMs).padStart(4)} ms  ${k.candidate.padEnd(14)} ${k.text}${k.misses.length ? `   [${k.misses.join(" | ")}]` : ""}`,
      );
  }
  // Per candidate spelling over every case it was tried in (the AI ones share theirs).
  const byCandidate = new Map<string, { clean: number; of: number }>();
  for (const r of rows) {
    const k = `${r.group}: ${r.candidate}`;
    const t = byCandidate.get(k) ?? { clean: 0, of: 0 };
    t.of++;
    if (r.clean) t.clean++;
    byCandidate.set(k, t);
  }
  console.log("\nBy group and candidate:");
  for (const [k, t] of byCandidate) console.log(`  ${`${t.clean}/${t.of}`.padStart(7)}  ${k}`);
  console.log(`\n${rows.length} clips, ${Math.round(audioSeconds)} s of audio, ${Math.round((Date.now() - started) / 1000)} s`);
  if (flags.out)
    writeFileSync(
      flags.out,
      `${JSON.stringify({ date: new Date().toISOString().slice(0, 10), engine: ENGINE, voices: VOICES, runs: RUNS, audioSeconds: Math.round(audioSeconds), summary, rows }, null, 1)}\n`,
    );
}

try {
  await main();
} finally {
  stopServer();
}
