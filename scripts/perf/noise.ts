// Does cleaning the mic's audio help Apple's recognizer hear the name in a noisy room? Offline and
// silent: `say` clips of the name ("Kiko") and its near-misses, mixed with room noise at a few
// signal-to-noise ratios, run through each noise reducer, then the app's own path exactly as
// wake-names.ts runs it (the Apple helper with the name as a hint, the built-in name fixes, wakeIn).
//
//   Clips: Kiko's 10 phrases and 8 near-misses (wake-names.ts's), by the 7 natural `say` voices
//     plus Reed and Flo (Eloquence) for reference.
//   Noise beds (16 kHz mono, built once in <work>/noise from <work>/dl):
//     cafe      a real café, Wikimedia Commons "Cafe ambiance.ogg" (CC0), 2 min from 2:00 in.
//     tv        speech from another room: four other `say` voices (Tara, Grandpa, Rocko, and
//               Samantha slowed and lowered) reading unrelated news, band-limited, with room echo.
//     fan       a fan / air conditioner, generated: brown and pink noise with a 120 Hz hum.
//     keyboard  typing, Commons "Computer keyboard.ogg" (public domain, by russiandoll).
//   Mixing: noise from a fixed place in the bed (by the clip's hash), scaled so the speech (its
//     frames within 40 dB of its loudest) sits at each SNR above it; 1.5 s of the same noise runs
//     before the clip, so a reducer is already settled when the speech starts (as on an open mic),
//     and is cut off again before the recognizer hears it.
//   Reducers: none; RNNoise (xiph, built-in model); DeepFilterNet3 (CPU), as is and limited to 12 dB
//     of attenuation; Apple's Voice Isolation (AUSoundIsolation, offline), standard and HQ models. noise-denoise.py and noise-isolate.swift do the work, file to file.
//   Scores, per reducer × noise × SNR: wake (the final words wake it; "natural" without Reed and
//     Flo), false wakes (a near-miss's final or live words wake it), and WER of the positives
//     against the script (the name written as "Kiko").
//
//   bun scripts/perf/noise.ts --work <dir> --venv <dir with bin/python: pyrnnoise, deepfilternet>
//       --dfn-model <unzipped DeepFilterNet3 folder> [--out scripts/perf/noise-<date>.json]
//       [--reducers none,rnnoise,deepfilternet,deepfilternet-12,isolation,isolation-hq] [--noises cafe,tv,fan,keyboard]
//       [--snrs 15,5,0] [--parallel 6] [--from <json>]
//   The venv: uv venv --python 3.11 <dir>; uv pip install pyrnnoise torch==2.0.1 torchaudio==2.0.2
//   deepfilternet soundfile "numpy<2" (DeepFilterNet 0.5.6 breaks on torchaudio ≥ 2.1). The model:
//   https://github.com/Rikorose/DeepFilterNet/raw/main/models/DeepFilterNet3.zip, unzipped.
//   Transcripts are cached in <work>/transcripts.jsonl, so a run picks up where one stopped.
//   --from re-scores an earlier run's JSON with no audio at all.
//
// Never plays audio or opens the mic, never starts the app or touches its config, sockets or tmux.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { Apple, hash, pool, RATE, renderSayBatch, wavFile, wavPcm } from "./wake-lib.ts";

const ROOT = join(import.meta.dirname, "../..");

// ── What is tested ───────────────────────────────────────────────────────────────────────────────
export const NAME = "Kiko";
export const SAY_NAME = "Keeko";
// wake-names.ts's phrases and Kiko's near-misses, as they were run there.
export const POSITIVES = [
  "{N}, what's the status?",
  "Hey {N}, ask Lacy to run the tests.",
  "Okay {N}, read me the last reply.",
  "Hey {N}.",
  "{N}, stop.",
  "Hi {N}, what did Claude say?",
  "{N}, tell Claude to commit the changes.",
  "Tell {N} to check the logs.",
  "Um, {N}, cancel that.",
  "{N}, how much did today cost?",
];
export const NEGATIVES = ["Keep going.", "Kick off at noon.", "Cocoa, please.", "Hey Keiko.", "Key code is wrong.", "Tico Tico.", "Hello, can you hear me?", "Hey, what's up?"];
export const NATURAL = ["Samantha (English (US))", "Daniel (English (UK))", "Karen", "Moira (English (Ireland))", "Rishi (English (India))", "Aman", "Tessa (English (South Africa))"];
const ELOQUENCE = ["Reed (English (US))", "Flo (English (UK))"];
export const VOICES = [...NATURAL, ...ELOQUENCE];
export const LEAD = 1.5; // seconds of noise before each clip, cut before recognition
export const hints = [NAME, "Claude Code", "Jev"]; // as wake-names.ts: the app's hints without your dictionary

export const CLIPS: Clip[] = VOICES.flatMap((voice) => [
  ...POSITIVES.map((p) => ({ set: "positive" as const, voice, text: p.replace("{N}", NAME), spoken: p.replace("{N}", SAY_NAME) })),
  ...NEGATIVES.map((n) => ({ set: "negative" as const, voice, text: n, spoken: n })),
]);

// ── Word error rate ──────────────────────────────────────────────────────────────────────────────
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w === "ok" ? "okay" : w));
/** Edits (substitutions, deletions, insertions) from `ref` to `hyp`, by word. */
export function editDistance(ref: string[], hyp: string[]): number {
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[hyp.length];
}

// ── Scoring (shared with noise-live.ts) ──────────────────────────────────────────────────────────
export type Row = { cond: string; set: "positive" | "negative"; voice: string; text: string; transcript: string; live?: string[] };
export type Wakes = (text: string) => boolean;
const pct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : null);
export function score(rows: Row[], wakes: Wakes) {
  const pos = rows.filter((r) => r.set === "positive");
  const nat = pos.filter((r) => !ELOQUENCE.includes(r.voice));
  const neg = rows.filter((r) => r.set === "negative");
  const woke = (r: Row) => wakes(r.transcript);
  const falseWakes = neg.filter((r) => woke(r) || (r.live ?? []).some(wakes));
  let edits = 0;
  let refWords = 0;
  for (const r of pos) {
    const ref = words(r.text);
    edits += editDistance(ref, words(r.transcript));
    refWords += ref.length;
  }
  return {
    wake: pct(pos.filter(woke).length, pos.length),
    wakeNatural: pct(nat.filter(woke).length, nat.length),
    falseWake: pct(falseWakes.length, neg.length),
    wer: pct(edits, refWords),
    positives: pos.length,
    negatives: neg.length,
    byVoice: Object.fromEntries(VOICES.map((v) => [v.split(" ")[0], pct(pos.filter((r) => r.voice === v && woke(r)).length, pos.filter((r) => r.voice === v).length)])),
    falseWakeList: falseWakes.map((r) => `${r.voice.split(" ")[0]}: "${r.text}" → "${r.transcript}"`),
  };
}

/** The app's pipeline with Kiko as the spoken name: the built-in name fixes, then wakeIn. */
export async function appWakes(work: string): Promise<Wakes> {
  // The app's modules write a log and read settings at import: point both at the work folder first.
  process.env.KIKO_LOG_DIR = join(work, "logs");
  process.env.KIKO_SETTINGS = join(work, "settings.json");
  const { applyDictionary } = await import("../../src/core/dictionary.ts");
  const { wakeIn } = await import("../../src/core/wake.ts");
  const { setSpokenName } = await import("../../src/core/name.ts");
  setSpokenName(NAME);
  return (text: string) => wakeIn(applyDictionary(text, []).text) !== null;
}

/** File to file through a helper that reads "in\tout" lines and answers "ok"/"error" per line. */
export async function throughHelper(cmd: string, args: string[], jobs: Array<[string, string]>, label: string) {
  if (!jobs.length) return;
  const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: proc.stdout });
  let done = 0;
  let failed = 0;
  const finished = new Promise<void>((resolve) => {
    lines.on("line", (l) => {
      if (l.startsWith("error")) {
        failed++;
        console.error(`${label}: ${l}`);
      }
      if (l.startsWith("ok") || l.startsWith("error")) {
        if (++done % 500 === 0) console.log(`  ${label}: ${done}/${jobs.length}`);
        if (done === jobs.length) resolve();
      }
    });
    proc.on("exit", () => resolve());
  });
  proc.stdin.write(jobs.map(([a, b]) => `${a}\t${b}\n`).join(""));
  proc.stdin.end();
  await finished;
  if (failed) console.error(`${label}: ${failed} failed`);
}

/** Mean power of the frames (20 ms) within 40 dB of the loudest: the speech, not the gaps. */
function activePower(s: Float32Array): number {
  const frame = RATE / 50;
  const powers: number[] = [];
  for (let i = 0; i + frame <= s.length; i += frame) {
    let p = 0;
    for (let j = i; j < i + frame; j++) p += s[j] * s[j];
    powers.push(p / frame);
  }
  const floor = Math.max(...powers) / 1e4;
  const active = powers.filter((p) => p >= floor);
  return active.reduce((a, b) => a + b, 0) / active.length;
}

/** Float samples on the 16-bit scale as PCM, scaled down as a whole if they would clip. */
function toPcm(x: Float32Array): Buffer {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const k = peak > 32000 ? 32000 / peak : 1;
  const b = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.round(x[i] * k), i * 2);
  return b;
}

// ── Noise beds ───────────────────────────────────────────────────────────────────────────────────
const COMMONS = {
  cafe: { file: "Cafe_ambiance.ogg", url: "https://upload.wikimedia.org/wikipedia/commons/5/54/Cafe_ambiance.ogg" },
  keyboard: { file: "Computer_keyboard.ogg", url: "https://upload.wikimedia.org/wikipedia/commons/a/a4/Computer_keyboard.ogg" },
};
const TV_LINES = [
  ["Tara (English (India))", "Good evening. Heavy rain is expected across the northern valleys tonight, with flooding possible near the river."],
  ["Grandpa (English (US))", "Thanks, Priya. In sports, the home team won their third straight game on a late goal in extra time."],
  ["Rocko (English (UK))", "Markets closed slightly higher today as investors waited for news on interest rates next month."],
  ["SAMANTHA_LOW", "Coming up after the break: how one small town turned an old railway station into a public library."],
  ["Tara (English (India))", "The city council voted on Tuesday to extend the bus line to the airport by the end of next year."],
  ["Grandpa (English (US))", "And now the weather for the weekend. Sunny skies on Saturday, with clouds rolling in by Sunday afternoon."],
  ["Rocko (English (UK))", "Scientists say the new telescope has already sent back images of a galaxy never seen before."],
  ["SAMANTHA_LOW", "Stay with us. We'll be right back with the rest of tonight's headlines and a look at the traffic."],
];
function buildBed(name: string, file: string, dl: string) {
  const ff = (...args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
  const out = ["-ar", String(RATE), "-ac", "1", "-c:a", "pcm_s16le", file];
  if (name === "cafe" || name === "keyboard") {
    const src = COMMONS[name];
    const dir = join(dl, name);
    mkdirSync(dir, { recursive: true });
    const local = join(dir, src.file);
    if (!existsSync(local)) execFileSync("curl", ["-sSfL", "-A", "KikoPerfResearch/1.0 (research script; low volume)", "-o", local, src.url]);
    ff(...(name === "cafe" ? ["-ss", "120", "-t", "120"] : []), "-i", local, ...out);
  } else if (name === "fan") {
    ff(
      "-f",
      "lavfi",
      "-i",
      "anoisesrc=color=brown:amplitude=0.5:duration=120:seed=7",
      "-f",
      "lavfi",
      "-i",
      "anoisesrc=color=pink:amplitude=0.08:duration=120:seed=8",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=120:duration=120",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=240:duration=120",
      "-filter_complex",
      "[2]volume=0.02[h1];[3]volume=0.01[h2];[0][1][h1][h2]amix=inputs=4:normalize=0,lowpass=f=4000,tremolo=f=0.5:d=0.1",
      ...out,
    );
  } else if (name === "tv") {
    const dir = join(dl, "tv");
    mkdirSync(dir, { recursive: true });
    const parts: string[] = [];
    TV_LINES.forEach(([voice, text], i) => {
      const part = join(dir, `line-${i}.aiff`);
      if (!existsSync(part)) execFileSync("say", ["-v", voice === "SAMANTHA_LOW" ? "Samantha (English (US))" : voice, "-o", part, text]);
      const wav = join(dir, `line-${i}.wav`);
      // Samantha slowed and lowered 15% (a different-sounding speaker), then each line resampled alike.
      ff("-i", part, "-af", `${voice === "SAMANTHA_LOW" ? "asetrate=22050*0.85,aresample=22050," : ""}apad=pad_dur=0.6`, "-ar", "22050", "-ac", "1", "-c:a", "pcm_s16le", wav);
      parts.push(wav);
    });
    const list = join(dir, "list.txt");
    // The bulletin five times over (about 2 min), cut to 120 s.
    writeFileSync(list, Array.from({ length: 5 }, () => parts.map((p) => `file '${p}'`).join("\n")).join("\n"));
    ff("-f", "concat", "-safe", "0", "-i", list, "-af", "highpass=f=200,lowpass=f=5000,aecho=0.8:0.6:35|60:0.3|0.2,atrim=0:120", ...out);
  } else throw new Error(`no noise bed ${name}`);
}

// ── Inputs ───────────────────────────────────────────────────────────────────────────────────────
export type Clip = { set: "positive" | "negative"; voice: string; text: string; spoken: string };
export const inputKey = (noise: string, snr: number | null, c: Clip) => `${noise}|${snr ?? ""}|${hash(c.voice, c.spoken)}`;
/**
 * The clips rendered (`say`), the noise beds built, and every clip mixed with every noise at every
 * SNR, plus a clean copy, in <work>/mixed: LEAD s of noise, 0.3 s, the clip, 0.7 s. Files already
 * there are kept. Returns them by inputKey.
 */
export async function prepareInputs(work: string, clips: Clip[], noises: string[], snrs: number[]) {
  const dirs = { clips: join(work, "clips"), noise: join(work, "noise"), mixed: join(work, "mixed"), dl: join(work, "dl") };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

  console.log(`${clips.length} clips; rendering with say…`);
  const voices = [...new Set(clips.map((c) => c.voice))];
  await pool(voices, 4, (voice) =>
    renderSayBatch(
      dirs.clips,
      voice,
      clips.filter((c) => c.voice === voice).map((c) => c.spoken),
    ),
  );
  const clipFile = (c: Clip) => join(dirs.clips, `say-${hash(c.voice, c.spoken)}.wav`);

  const beds: Record<string, Float32Array> = {};
  for (const n of noises) {
    const file = join(dirs.noise, `${n}.wav`);
    if (!existsSync(file)) buildBed(n, file, dirs.dl);
    const pcm = wavPcm(file);
    beds[n] = Float32Array.from({ length: pcm.length >> 1 }, (_, i) => pcm.readInt16LE(i * 2));
  }

  const inputs = new Map<string, string>();
  for (const c of clips) {
    const speech = wavPcm(clipFile(c));
    const s = Float32Array.from({ length: speech.length >> 1 }, (_, i) => speech.readInt16LE(i * 2));
    const pre = Math.round((LEAD + 0.3) * RATE);
    const total = pre + s.length + Math.round(0.7 * RATE);
    const ps = activePower(s);
    const clean = join(dirs.mixed, `clean-${hash(c.voice, c.spoken)}.wav`);
    if (!existsSync(clean)) {
      const out = new Float32Array(total);
      out.set(s, pre);
      writeFileSync(clean, wavFile(toPcm(out)));
    }
    inputs.set(inputKey("clean", null, c), clean);
    for (const n of noises)
      for (const snr of snrs) {
        const file = join(dirs.mixed, `${n}-${snr}-${hash(c.voice, c.spoken)}.wav`);
        inputs.set(inputKey(n, snr, c), file);
        if (existsSync(file)) continue;
        const bed = beds[n];
        const start = parseInt(hash(n, c.voice, c.spoken), 16) % (bed.length - total);
        const seg = bed.subarray(start, start + total);
        let pn = 0;
        for (const v of seg) pn += v * v;
        pn /= seg.length;
        const gain = Math.sqrt(ps / (pn * 10 ** (snr / 10)));
        const out = new Float32Array(total);
        for (let i = 0; i < total; i++) out[i] = seg[i] * gain + (i >= pre && i < pre + s.length ? s[i - pre] : 0);
        writeFileSync(file, wavFile(toPcm(out)));
      }
  }
  return { inputs, inputKey };
}

// ── Running ──────────────────────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const { values: flags } = parseArgs({
    options: {
      work: { type: "string" },
      venv: { type: "string" },
      "dfn-model": { type: "string" },
      out: { type: "string", default: join(ROOT, `scripts/perf/noise-${new Date().toISOString().slice(0, 10)}.json`) },
      reducers: { type: "string", default: "none,rnnoise,deepfilternet,deepfilternet-12,isolation,isolation-hq" },
      noises: { type: "string", default: "cafe,tv,fan,keyboard" },
      snrs: { type: "string", default: "15,5,0" },
      parallel: { type: "string", default: "6" },
      from: { type: "string" },
    },
  });
  const REDUCERS = flags.reducers!.split(",");
  const NOISES = flags.noises!.split(",");
  const SNRS = flags.snrs!.split(",").map(Number);
  const conds = [
    ...REDUCERS.map((r) => ({ reducer: r, noise: "clean", snr: null as number | null })),
    ...REDUCERS.flatMap((r) => NOISES.flatMap((n) => SNRS.map((snr) => ({ reducer: r, noise: n, snr })))),
  ];
  const condKey = (c: { reducer: string; noise: string; snr: number | null }) => `${c.reducer}|${c.noise}${c.snr === null ? "" : `|${c.snr}`}`;

  let rows: Row[];
  let work = flags.work ?? "";
  if (flags.from) {
    rows = JSON.parse(readFileSync(flags.from, "utf8")).rows;
    work ||= "/tmp/kiko-noise-rescore";
  } else {
    if (!flags.work || !flags.venv || !flags["dfn-model"]) throw new Error("--work, --venv and --dfn-model are needed (see the top of the file)");
    rows = await runAudio();
  }
  const wakes = await appWakes(work);

  const results = conds.map((c) => ({
    reducer: c.reducer,
    noise: c.noise,
    snr: c.snr,
    ...score(
      rows.filter((r) => r.cond === condKey(c)),
      wakes,
    ),
  }));
  // Each reducer against none, over all the noisy conditions together.
  const overall = REDUCERS.map((reducer) => ({
    reducer,
    ...score(
      rows.filter((r) => r.cond.startsWith(`${reducer}|`) && !r.cond.includes("|clean")),
      wakes,
    ),
  }));
  const out = {
    date: new Date().toISOString(),
    what: "Kiko wake and word accuracy on Apple's recognizer (Kiko's speech helper, the built-in name fixes, wakeIn) for `say` clips mixed with room noise at several SNRs, with and without a noise reducer before the recognizer. Offline: nothing played or recorded.",
    voices: VOICES,
    natural: NATURAL,
    positives: POSITIVES.map((p) => p.replace("{N}", NAME)),
    negatives: NEGATIVES,
    noises: {
      cafe: "Wikimedia Commons, File:Cafe ambiance.ogg (CC0), 2:00–4:00",
      tv: "generated: `say` voices Tara, Grandpa (US), Rocko (UK), Samantha (slowed 15%) reading invented news, 200–5000 Hz, aecho room echo",
      fan: "generated: ffmpeg anoisesrc brown + pink, 120/240 Hz hum, 4 kHz low-pass",
      keyboard: "Wikimedia Commons, File:Computer keyboard.ogg (public domain, russiandoll)",
    },
    reducers: {
      none: "the mixed audio as is",
      rnnoise: "RNNoise (xiph librnnoise, built-in model, via the pyrnnoise 0.4.5 wheel), at 48 kHz",
      deepfilternet: "DeepFilterNet3 (deepfilternet 0.5.6, torch 2.0.1 CPU), at 48 kHz",
      "deepfilternet-12": "DeepFilterNet3 with its attenuation limited to 12 dB (atten_lim_db=12): noise turned down, not removed",
      isolation: "Apple AUSoundIsolation (Voice Isolation), standard voice model, 100% wet, offline at 48 kHz",
      "isolation-hq": "Apple AUSoundIsolation, high-quality voice model (macOS 15+), 100% wet, offline at 48 kHz",
    },
    overall,
    results,
    rows: [] as unknown[],
  };
  const rowLines = rows.map((r) => `    ${JSON.stringify(r.set === "negative" && r.live?.length ? r : { ...r, live: undefined })}`).join(",\n");
  writeFileSync(flags.out!, `${JSON.stringify(out, null, 2).replace('"rows": []', `"rows": [\n${rowLines}\n  ]`)}\n`);

  const f = (v: number | null) => (v === null ? "-" : String(v)).padStart(6);
  console.log("\nreducer        noise     snr   wake natural  false    WER");
  for (const r of results) console.log(`${r.reducer.padEnd(14)} ${r.noise.padEnd(9)} ${String(r.snr ?? "").padStart(3)} ${f(r.wake)} ${f(r.wakeNatural)} ${f(r.falseWake)} ${f(r.wer)}`);
  console.log("\nall noisy conditions:");
  for (const r of overall) console.log(`${r.reducer.padEnd(14)} wake ${r.wake}  natural ${r.wakeNatural}  false ${r.falseWake}  WER ${r.wer}`);
  console.log(`\nWrote ${flags.out}`);
  process.exit(0);

  async function runAudio(): Promise<Row[]> {
    const WORK = flags.work!;
    const { inputs, inputKey } = await prepareInputs(WORK, CLIPS, NOISES, SNRS);
    console.log(`${inputs.size} inputs mixed`);

    // Reducers, file to file (each skips what it has done).
    const outFile = (reducer: string, input: string) => (reducer === "none" ? input : input.replace(/\/mixed\//, `/out-${reducer}/`));
    for (const r of REDUCERS) if (r !== "none") mkdirSync(join(WORK, `out-${r}`), { recursive: true });
    const todo = (r: string) => [...inputs.values()].filter((f) => !existsSync(outFile(r, f))).map((f) => [f, outFile(r, f)] as [string, string]);
    const py = join(flags.venv!, "bin/python");
    const runs: Promise<void>[] = [];
    const t0 = Date.now();
    const denoise = join(ROOT, "scripts/perf/noise-denoise.py");
    const isolator = join(WORK, "noise-isolate");
    if (REDUCERS.some((r) => r.startsWith("isolation")) && !existsSync(isolator)) execFileSync("swiftc", ["-O", join(ROOT, "scripts/perf/noise-isolate.swift"), "-o", isolator], { stdio: "inherit" });
    const helpers: Record<string, [string, string[]]> = {
      rnnoise: [py, ["-I", denoise, "rnnoise"]],
      deepfilternet: [py, ["-I", denoise, "deepfilternet", "--model-dir", flags["dfn-model"]!]],
      "deepfilternet-12": [py, ["-I", denoise, "deepfilternet", "--model-dir", flags["dfn-model"]!, "--atten-lim", "12"]],
      isolation: [isolator, []],
      "isolation-hq": [isolator, ["--hq"]],
    };
    for (const r of REDUCERS.filter((r) => r !== "none")) {
      if (!helpers[r]) throw new Error(`no reducer ${r}`);
      runs.push(throughHelper(...helpers[r], todo(r), r));
    }
    await Promise.all(runs);
    console.log(`reducers done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

    // Recognition, cached.
    const cacheFile = join(WORK, "transcripts.jsonl");
    const cache = new Map<string, { transcript: string; live: string[] }>();
    if (existsSync(cacheFile))
      for (const l of readFileSync(cacheFile, "utf8").split("\n").filter(Boolean)) {
        const m = JSON.parse(l);
        cache.set(m.key, m);
      }
    type Job = { cond: string; clip: Clip; file: string };
    const jobs: Job[] = conds.flatMap((cd) => CLIPS.map((clip) => ({ cond: condKey(cd), clip, file: outFile(cd.reducer, inputs.get(inputKey(cd.noise, cd.snr, clip))!) })));
    const keyOf = (j: Job) => `${j.cond}|${j.clip.voice}|${j.clip.spoken}`;
    const pending = jobs.filter((j) => !cache.has(keyOf(j)));
    console.log(`${jobs.length} recognitions, ${pending.length} to run`);
    const binary = join(WORK, "speech");
    if (!existsSync(binary)) execFileSync("swiftc", ["-O", join(ROOT, "native/macos/speech.swift"), "-o", binary], { stdio: "inherit" });
    const apples = Array.from({ length: Number(flags.parallel) }, () => new Apple(binary));
    for (const a of apples) {
      a.setHints(hints);
      await a.transcribe(Buffer.alloc(RATE)); // a press for the hints to apply
    }
    const t1 = Date.now();
    let n = 0;
    await pool(pending, apples.length, async (j, w) => {
      const heard = await apples[w].transcribe(wavPcm(j.file).subarray(Math.round(LEAD * RATE) * 2));
      const entry = { key: keyOf(j), transcript: heard.text, live: [...new Set(heard.live)].filter((t) => t !== heard.text) };
      cache.set(entry.key, entry);
      appendFileSync(cacheFile, `${JSON.stringify(entry)}\n`);
      if (++n % 250 === 0) console.log(`  heard ${n}/${pending.length} (${((Date.now() - t1) / n).toFixed(0)} ms each)`);
    });
    for (const a of apples) a.close();
    return jobs.map((j) => {
      const c = cache.get(keyOf(j))!;
      return { cond: j.cond, set: j.clip.set, voice: j.clip.voice, text: j.clip.text, transcript: c.transcript, live: j.clip.set === "negative" ? c.live : undefined };
    });
  }
}
