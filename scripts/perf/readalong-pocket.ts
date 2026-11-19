// How close the phone's read-along gets for Pocket, which gives no word timings: made-up lines of the
// kinds Kiko says (summaries, statuses, questions), cut into sentences as the app cuts them (pocket-tts.ts nextCut), respelled
// for Pocket with the built-in list only, said by a Pocket server of your own (never the app's), and
// saved as WAVs with their text. A forced aligner (readalong-align.py, torchaudio's MMS_FA, in its
// own venv) then finds where each word really starts; `--score` compares that with the estimate the
// Mac sends the phone (core/word-timing.ts) and prints the median and max offsets.
//
//   1. a Pocket server of your own on another port (the app's stays untouched):
//      cd pocket && POCKET_TTS_WATCH_STDIN=0 HF_HOME=$PWD/pocket-hf .venv/bin/python serve.py --port 8799
//   2. node scripts/perf/readalong-pocket.ts --make --port 8799 --work /tmp/readalong
//   3. <venv>/bin/python scripts/perf/readalong-align.py /tmp/readalong
//   4. node scripts/perf/readalong-pocket.ts --score --work /tmp/readalong [--out scripts/perf/readalong-pocket-<date>.json]
//
// No keys, no calls out, nothing read from your settings or voices.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { addSegment, nextCut } from "../../src/core/pocket-tts.ts";
import { respell } from "../../src/core/pronunciation.ts";
import { estimateWords, type TimedWord } from "../../src/core/word-timing.ts";

const RATE = 24000;
const args = process.argv.slice(2);
const arg = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const work = arg("work", "/tmp/readalong")!;
const VOICES = (arg("voices", "george,alba,marius") ?? "").split(",");

// Made-up lines in the shape of Kiko's summaries, numbers and versions left out: the aligner needs
// the words as said, and how Pocket reads "0.3.0" is its own business. The lines the word timing was
// first measured on are real ones, kept private (tests/eval/private/readalong-lines.ts, left out of
// the public repo); when that file is there, they're used instead.
const MADE_UP = [
  "In Atlas, Claude says you only need one new web and mobile release, and the choice is whether beta users get the new dashboard and the import tool. It recommends that option, with billing still off. Do you want it to go with that?",
  "In atlas, Claude found that the banner isn't showing, most likely because the old build is still cached in the browser or because the hide rule is too broad. It has started a debug agent to add logging and fix the banner, and it's adding a test command you can run to check it.",
  "In harbor, Claude is fixing the stuck upload bug first, plus the text running off the screen and the progress highlight, which should follow the file's real size. It'll tell you when to rebuild from Xcode, and until then, check the screen after each upload finishes.",
  "In Harbor, Claude says yes, it's possible, but the browser makes it awkward. It suggests pausing other tabs' audio while a video plays, plus lowering Spotify and Music so they dip instead of pausing, and asks whether you want that or the full per-tab version.",
  "In juniper, Claude explains it checks which window is in front, and if that's the terminal, it asks tmux whether the build pane has focus. It shows the notice otherwise, and it's only been tested with Ghostty.",
  "In juniper, Claude says it found why the notice didn't show: the helper process was started hidden, so macOS never drew its window. That's fixed and pushed, and it also narrows when the notice hides and quits the helper sooner.",
  "In orbit, Claude says the widget only stays live for about thirty seconds after you leave the app, then iOS suspends it and nothing new comes in. To update in the background, it needs push notifications, which means setting up some Apple keys and permissions with you first.",
  "In orbit, Claude says the freeze is fixed: it was a crash that Xcode's debugger paused, not a stuck screen. Stop the paused run in Xcode, then press Run on your iPhone to rebuild.",
  "In mintbox, Claude says the account setup fix is merged and pushed and goes into the next release, with all tests passing. The iPhone freeze fix, the settings screen and the banner debug are still running.",
  "In mintbox, Claude says the old search removal is on its final test run. It found one screen test on the tablet already fails on main, unrelated to its change, and it'll report that rather than stop.",
  "In rowan, Claude says it's rebuilding the sales chart as a real, accurate line that scrolls right to left at a steady speed, with no bounce or glow, and it'll tell you when it's ready to review.",
  "Restarted nginx on the staging box. The tmux session is back, and the API answers again.",
  "I couldn't reach Lacy. Your words weren't typed in.",
  "Sure. Which session should I send that to?",
];
const PRIVATE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tests", "eval", "private", "readalong-lines.ts");
const LINES: string[] = existsSync(PRIVATE) ? ((await import(pathToFileURL(PRIVATE).href)) as { READALONG_LINES: string[] }).READALONG_LINES : MADE_UP;

/** A line as Pocket gets it: respelled (the built-in list), then cut as pocket-tts.ts cuts it. */
export function segmentsOf(text: string): string[] {
  const said = respell(text, "pocket", []);
  const out: string[] = [];
  let buf = said;
  let cut: number;
  while ((cut = nextCut(buf)) > 0) {
    addSegment(out, buf.slice(0, cut));
    buf = buf.slice(cut);
  }
  addSegment(out, buf);
  return out;
}

async function make(port: number) {
  mkdirSync(work, { recursive: true });
  const index: Array<{ id: string; voice: string; line: number; seg: number; text: string; ms: number; firstMs: number; seconds: number }> = [];
  for (const voice of VOICES) {
    for (const [li, line] of LINES.entries()) {
      for (const [si, text] of segmentsOf(line).entries()) {
        const id = `${voice}-${li}-${si}`;
        const form = new FormData();
        form.set("text", text);
        form.set("voice_url", voice);
        const t0 = performance.now();
        const res = await fetch(`http://127.0.0.1:${port}/tts`, { method: "POST", body: form });
        if (!res.ok || !res.body) throw new Error(`/tts ${res.status}`);
        const parts: Buffer[] = [];
        let firstMs = 0;
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          firstMs ||= performance.now() - t0;
          parts.push(Buffer.from(chunk));
        }
        const ms = performance.now() - t0;
        const wav = Buffer.concat(parts);
        writeFileSync(join(work, `${id}.wav`), wav);
        const seconds = (wav.length - 44) / 2 / RATE;
        index.push({ id, voice, line: li, seg: si, text, ms: Math.round(ms), firstMs: Math.round(firstMs), seconds });
        console.log(`${id} ${seconds.toFixed(2)} s in ${(ms / 1000).toFixed(2)} s (first ${Math.round(firstMs)} ms): ${text}`);
      }
    }
  }
  writeFileSync(join(work, "index.json"), JSON.stringify(index, null, 2));
}

/** 24 kHz mono s16 PCM out of a WAV (its data chunk). */
function pcmOf(wav: Buffer): Int16Array {
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === "data") {
      const end = Math.min(wav.length, off + 8 + (size === 0xffffffff || size === 0 ? wav.length : size));
      const data = wav.subarray(off + 8, end - ((end - off - 8) % 2));
      return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
    }
    off += 8 + size + (size % 2);
  }
  return new Int16Array(0);
}

type Truth = { id: string; words: Array<{ word: string; start: number; end: number } | null> };

function score(out?: string) {
  const index: Array<{ id: string; voice: string; text: string; ms: number; firstMs: number; seconds: number }> = JSON.parse(readFileSync(join(work, "index.json"), "utf8"));
  const truth: Truth[] = JSON.parse(readFileSync(join(work, "truth.json"), "utf8"));
  const byId = new Map(truth.map((t) => [t.id, t]));
  const modes = ["plain", "trimmed", "pauses"] as const;
  const lagMs = Number(arg("lag", "0"));
  const offsets: Record<string, number[]> = Object.fromEntries(modes.map((m) => [m, []]));
  const perVoice: Record<string, Record<string, number[]>> = {};
  let words = 0;
  for (const seg of index) {
    const t = byId.get(seg.id);
    if (!t || !t.words.length) continue;
    const pcm = pcmOf(readFileSync(join(work, `${seg.id}.wav`)));
    for (const mode of modes) {
      const est: TimedWord[] = estimateWords(seg.text.split(/\s+/).filter(Boolean), pcm, RATE, { mode, lagMs });
      if (est.length !== t.words.length) {
        console.error(`${seg.id}: ${est.length} words estimated, ${t.words.length} aligned; skipped`);
        continue;
      }
      for (let i = 0; i < est.length; i++) {
        const truth = t.words[i];
        if (!truth) continue;
        const d = (est[i].start - truth.start) / RATE;
        offsets[mode].push(d);
        ((perVoice[seg.voice] ??= {})[mode] ??= []).push(d);
      }
      if (mode === "pauses") words += est.length;
    }
  }
  const stats = (xs: number[]) => {
    const abs = xs.map(Math.abs).sort((a, b) => a - b);
    const q = (p: number) => abs[Math.min(abs.length - 1, Math.floor(p * abs.length))] ?? 0;
    const lead = xs.filter((x) => x < -0.05).length / Math.max(1, xs.length);
    const lead100 = xs.filter((x) => x < -0.1).length / Math.max(1, xs.length);
    const late = xs.filter((x) => x > 0.3).length / Math.max(1, xs.length);
    return {
      leadOver100ms: Math.round(lead100 * 1000) / 10,
      lateOver300ms: Math.round(late * 1000) / 10,
      maxLeadMs: Math.round(Math.max(0, -Math.min(0, ...xs)) * 1000),
      n: xs.length,
      medianMs: Math.round(q(0.5) * 1000),
      p90Ms: Math.round(q(0.9) * 1000),
      maxMs: Math.round((abs.at(-1) ?? 0) * 1000),
      meanMs: Math.round((xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)) * 1000),
      leadOver50ms: Math.round(lead * 1000) / 10,
    };
  };
  const report: Record<string, unknown> = {
    words,
    modes: Object.fromEntries(modes.map((m) => [m, stats(offsets[m])])),
    voices: Object.fromEntries(Object.entries(perVoice).map(([v, m]) => [v, Object.fromEntries(Object.entries(m).map(([k, xs]) => [k, stats(xs)]))])),
  };
  const rtf = index.map((s) => s.ms / 1000 / s.seconds);
  report.pocketSpeed = {
    medianRealTime: Math.round(rtf.sort((a, b) => a - b)[Math.floor(rtf.length / 2)] * 100) / 100,
    firstAudioMs: index.map((s) => s.firstMs).sort((a, b) => a - b)[Math.floor(index.length / 2)],
  };
  console.log(JSON.stringify(report, null, 2));
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
}

if (args.includes("--make")) await make(Number(arg("port", "8799")));
if (args.includes("--score")) score(arg("out"));
