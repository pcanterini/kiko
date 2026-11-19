// How well the spoken name (name.ts SPOKEN_DEFAULT, Kiko) works as a wake word ("Hey Kiko, …"):
// does it wake when said, and does it wake when it wasn't? Synthetic voices read phrases with the
// name in the usual places (positives) and everyday phrases that sound close to it (negatives); each
// clip goes through the recognizers the app uses, then through the app's own pipeline: the built-in
// name fixes (dictionary.ts applyDictionary with no entries of yours: the built-in ones only) and
// wake.ts wakeIn. First written for Fala, the app's earlier name: a result from then has rows that
// say "Fala", so --from such a file finds none of the name's own.
//
//   Voices: macOS `say` (files only, nothing played), several English accents; each positive read
//     twice, spelled as the name (SPOKEN_DEFAULT) and as the Mac's voices are told to say it
//     (NAME_SAID_AS). Optionally ElevenLabs (ELEVENLABS_API_KEY) for a few natural voices, the name
//     spelled as it is; clips are cached in the work folder, so a rerun costs nothing.
//   Recognizers: Apple, through the app's own helper (native/macos/speech.swift: SpeechAnalyzer +
//     SpeechTranscriber, on-device, the app's contextual strings), built into the work folder and
//     fed 16 kHz PCM as the mic sends it; Deepgram Nova-3 streaming with the app's parameters and
//     the name as a keyterm, when DEEPGRAM_API_KEY is set (the shell's, else the checkout's .env,
//     read in-process as core/config.ts does; never printed).
//   "woke": the final transcript wakes it (push-to-talk, and hands-free's request). "wokeLive": any
//     live transcript on the way did (hands-free acts on those: a false wake there is a false wake).
//   Baseline (Apple only): the same positives with the name replaced by Fala (the old name) and
//     two-syllable alternatives, to tell whether the name is worse than other names.
//   Candidates: each spelling the recognizers gave for the name, tried as a new `heard` spelling
//     (fixed anywhere) and as `atStart` (only opening what you said), against the positives, the
//     negatives and, with --logs, every real transcript in the logs (counts only, no words kept).
//
//   bun scripts/perf/wake-name.ts [--work <dir>] [--out scripts/perf/wake-name-<date>.json]
//       [--voices "Samantha (English (US)),Daniel (English (UK))"] [--no-deepgram] [--no-eleven]
//       [--no-baseline] [--logs <checkout>/logs] [--show-real] [--from <an earlier result's json>]
//       [--dictation]
//
// Never plays audio or opens the mic, never starts the app or touches its config, sockets or tmux.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { Apple, type Heard, nameSlot, padded, pool, RATE, hash, sayClip as sayLib } from "./wake-lib.ts";

const ROOT = join(import.meta.dirname, "../..");
const { values: flags } = parseArgs({
  options: {
    work: { type: "string", default: join(tmpdir(), "kiko-wake-name") },
    out: { type: "string", default: join(ROOT, `scripts/perf/wake-name-${new Date().toISOString().slice(0, 10)}.json`) },
    voices: { type: "string" },
    "no-deepgram": { type: "boolean", default: false },
    "no-eleven": { type: "boolean", default: false },
    "no-baseline": { type: "boolean", default: false },
    logs: { type: "string" },
    parallel: { type: "string", default: "3" },
    // Prints (never saves) the real transcripts a candidate would newly wake, to judge them by eye.
    "show-real": { type: "boolean", default: false },
    from: { type: "string" },
    dictation: { type: "boolean", default: false },
  },
});
const WORK = flags.work!;
mkdirSync(join(WORK, "clips"), { recursive: true });

// The app's modules write a log and read settings at import: point both at the work folder first.
process.env.KIKO_LOG_DIR = join(WORK, "logs");
process.env.KIKO_SETTINGS = join(WORK, "settings.json");
const { applyDictionary } = await import("../../src/core/dictionary.ts");
const { wakeIn } = await import("../../src/core/wake.ts");
const { misheard, NAME_SAID_AS, SPOKEN_DEFAULT, setSpokenName, spokenName } = await import("../../src/core/name.ts");
/** The name studied: the default spoken name. */
const NAME = SPOKEN_DEFAULT;

// ── Phrases ──────────────────────────────────────────────────────────────────────────────────────
// {N} is the name. `next`: the first word after it, to find what the recognizer wrote for the name.
const POSITIVES: Array<{ text: string; next: string }> = [
  { text: "{N}, what's the status?", next: "what" },
  { text: "Hey {N}, ask Lacy to run the tests.", next: "ask" },
  { text: "Okay {N}, read me the last reply.", next: "read" },
  { text: "Hey {N}.", next: "" },
  { text: "{N}, stop.", next: "stop" },
  { text: "{N}, open a new Codex session.", next: "open" },
  { text: "Hi {N}, what did Claude say?", next: "what" },
  { text: "Hey {N}, what's everyone doing?", next: "what" },
  { text: "{N}, tell Claude to commit the changes.", next: "tell" },
  { text: "Tell {N} to check the logs.", next: "to" },
  { text: "{N}, repeat that.", next: "repeat" },
  { text: "Um, {N}, cancel that.", next: "cancel" },
  { text: "Hey {N}, yes, go ahead.", next: "yes" },
  { text: "{N}, how much did today cost?", next: "how" },
  { text: "Okay {N}, start listening.", next: "start" },
];
// Everyday phrases that sound close to the name (Kiko's: wake-names.ts's, and more), and "Hey <other name>": none should wake it.
const NEGATIVES = [
  "Keep going.",
  "Kick off at noon.",
  "Cocoa, please.",
  "Hey Keiko.",
  "Key code is wrong.",
  "Tico Tico.",
  "Hey Chico, come here.",
  "Pico is a tiny board.",
  "Geico called about the car.",
  "Keep it going, okay?",
  "Hey Nico, how are you?",
  "Kick it off.",
  "Coco, sit.",
  "Echo, play some music.",
  "Gecko on the wall.",
  "Hello, can you hear me?",
];
const SPELLINGS = [
  { label: "spelled", name: NAME },
  { label: "phonetic", name: NAME_SAID_AS },
];
// Baseline names (Apple only): the old one, and two-syllable alternatives with no spellings of their own.
const BASELINE = ["Fala", "Jarvis", "Dimmi"];

const DEFAULT_VOICES = [
  "Samantha (English (US))",
  "Reed (English (US))",
  "Daniel (English (UK))",
  "Flo (English (UK))",
  "Karen",
  "Moira (English (Ireland))",
  "Rishi (English (India))",
  "Tessa (English (South Africa))",
];
const VOICES = flags.voices ? flags.voices.split(",").map((v) => v.trim()) : DEFAULT_VOICES;
// What the app gives the recognizers to expect besides the name (stt-hints.ts, without your dictionary or sessions).
const HINTS_BESIDES = ["Claude Code", "Codex", "OpenCode", "T3 Code"];

// ── Keys: the shell's, else the checkout's .env (as core/config.ts reads it). Never printed. ─────
function mainCheckout() {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: ROOT, encoding: "utf8" }).trim();
  return dirname(common);
}
let dotenv: Record<string, string | undefined> | null = null;
function key(name: string): { value: string; source: string } | null {
  const own = process.env[name]?.trim();
  if (own) return { value: own, source: "environment" };
  if (dotenv === null) {
    const file = join(mainCheckout(), ".env");
    dotenv = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
  }
  const v = dotenv[name]?.trim();
  return v ? { value: v, source: ".env" } : null;
}

// ── Audio ────────────────────────────────────────────────────────────────────────────────────────
const sayClip = (voice: string, text: string) => sayLib(join(WORK, "clips"), voice, text);

let elevenCalls = 0;
async function elevenClip(apiKey: string, voiceId: string, text: string): Promise<Buffer> {
  const file = join(WORK, "clips", `eleven-${hash(voiceId, text)}.pcm`);
  if (!existsSync(file)) {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_16000`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
    });
    if (!r.ok) throw new Error(`ElevenLabs ${r.status}`);
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    elevenCalls++;
  }
  return padded(readFileSync(file));
}

async function elevenVoices(apiKey: string, wanted: string[]): Promise<Array<{ name: string; id: string }>> {
  const r = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": apiKey } });
  if (!r.ok) throw new Error(`ElevenLabs voices ${r.status}`);
  const all = ((await r.json()) as { voices: Array<{ name: string; voice_id: string }> }).voices;
  const out: Array<{ name: string; id: string }> = [];
  for (const w of wanted) {
    const v = all.find((x) => x.name.toLowerCase().startsWith(w.toLowerCase()));
    if (v) out.push({ name: v.name.split(/\s+[-–]\s+/)[0], id: v.voice_id });
  }
  return out;
}

// ── Recognizers ──────────────────────────────────────────────────────────────────────────────────
/**
 * One Deepgram Nova-3 live socket per clip, with the app's parameters (core/deepgram.ts): audio at
 * the mic's pace (faster, Deepgram answers Finalize before it has heard the end), then Finalize, as
 * key up does; the transcript once it answers `from_finalize`, and anything CloseStream flushes after.
 */
async function deepgram(apiKey: string, pcm: Buffer, keyterms: string[]): Promise<Heard> {
  const { default: WebSocket } = await import("ws");
  const params = new URLSearchParams({
    model: "nova-3",
    encoding: "linear16",
    sample_rate: String(RATE),
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    punctuate: "true",
  });
  for (const t of keyterms) params.append("keyterm", t);
  const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, { headers: { Authorization: `Token ${apiKey}` } });
  const finals: string[] = [];
  const live: string[] = [];
  let volatile = "";
  return new Promise<Heard>((resolve, reject) => {
    const joined = () => [...finals, volatile].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    let finalized = false;
    const done = () => {
      clearTimeout(timer);
      resolve({ text: joined(), live });
    };
    const timer = setTimeout(() => {
      ws.terminate();
      done();
    }, 30_000);
    ws.on("error", (e: Error) => {
      clearTimeout(timer);
      reject(new Error(`Deepgram: ${e.message.split(apiKey).join("…")}`));
    });
    ws.on("close", done);
    ws.on("message", (data: Buffer) => {
      let m: any;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (m.type !== "Results") return;
      const t = m.channel?.alternatives?.[0]?.transcript ?? "";
      if (m.is_final) {
        if (t) finals.push(t);
        volatile = "";
      } else volatile = t;
      const now = joined();
      if (now && live[live.length - 1] !== now) live.push(now);
      if (m.from_finalize && !finalized) {
        finalized = true;
        ws.send(JSON.stringify({ type: "CloseStream" }));
      }
    });
    ws.on("open", async () => {
      for (let at = 0; at < pcm.length; at += 3200) {
        ws.send(pcm.subarray(at, at + 3200));
        await new Promise((r) => setTimeout(r, 100));
      }
      ws.send(JSON.stringify({ type: "Finalize" }));
    });
  });
}

// ── The app's pipeline ───────────────────────────────────────────────────────────────────────────
/** As the app takes the words: the built-in name fixes (none of your dictionary), then the wake check. */
const NO_ENTRIES: Parameters<typeof applyDictionary>[1] = [];
function pipeline(text: string) {
  const fixed = applyDictionary(text, NO_ENTRIES).text;
  return { fixed, woke: wakeIn(fixed) !== null };
}
const wokeLive = (live: string[]) => live.some((t) => pipeline(t).woke);

// ── Running ──────────────────────────────────────────────────────────────────────────────────────
type Clip = {
  set: "positive" | "negative" | "baseline";
  name: string; // the name the phrase is for (NAME, "Fala")
  spelling: string; // "spelled", "phonetic", or "-" for negatives and other names
  tts: "say" | "eleven";
  voice: string;
  text: string;
  template?: string;
  next?: string;
  pcm: Buffer;
};
type Row = Omit<Clip, "pcm"> & {
  recognizer: "apple" | "apple-dictation" | "deepgram";
  transcript: string;
  fixed: string;
  woke: boolean;
  wokeLive: boolean;
  slot?: string;
  live?: string[];
};

const withName = (name: string, fn: () => void) => {
  const was = spokenName();
  setSpokenName(name);
  try {
    fn();
  } finally {
    setSpokenName(was);
  }
};

/** Every clip through an Apple helper, grouped by name so each helper's hints are set once per name. */
async function appleRun(binary: string, recognizer: Row["recognizer"], clips: Clip[]) {
  const apples = Array.from({ length: Number(flags.parallel) }, () => new Apple(binary));
  const started = Date.now();
  for (const name of [...new Set(clips.map((c) => c.name))]) {
    const mine = clips.filter((c) => c.name === name);
    for (const a of apples) if (a.setHints(hintsFor(name))) await a.transcribe(Buffer.alloc(RATE)); // a press for the hints to apply
    let done = 0;
    await pool(mine, apples.length, async (c, w) => {
      const heard = await apples[w].transcribe(c.pcm);
      withName(name, () => {
        const { fixed, woke } = pipeline(heard.text);
        const { pcm: _, ...rest } = c;
        rows.push({
          ...rest,
          recognizer,
          transcript: heard.text,
          fixed,
          woke,
          wokeLive: woke || wokeLive(heard.live),
          slot: c.template ? nameSlot(heard.text, c.template, c.next ?? "") : undefined,
          live: heard.live,
        });
      });
      if (++done % 100 === 0) console.log(`  ${recognizer} ${name}: ${done}/${mine.length}`);
    });
    console.log(`${recognizer}, ${name}: ${mine.length} clips`);
  }
  for (const a of apples) a.close();
  console.log(`${recognizer} done in ${((Date.now() - started) / 1000).toFixed(0)} s.`);
}

// --from: the rows of an earlier run, analysed again (new candidates, other summaries) with no audio or calls.
const prior = flags.from ? JSON.parse(readFileSync(flags.from, "utf8")) : null;
const hintsFor = (name: string) => [name, ...HINTS_BESIDES];
const notes: string[] = prior?.notes ?? [];
let elevenUsed: string[] = prior?.voices?.eleven ?? [];
let deepgramSeconds: number = prior?.usage?.deepgramAudioSeconds ?? 0;
if (prior) {
  elevenCalls = prior.usage?.elevenLabsCallsThisRun ?? 0;
}
const rows: Row[] = prior?.rows ?? [];

/** Every clip: `say` (rendered once, kept in the work folder), and ElevenLabs' when there's a key (cached the same way). */
async function buildClips(): Promise<Clip[]> {
  const clips: Clip[] = [];
  console.log(`Rendering with say: ${VOICES.length} voices…`);
  for (const voice of VOICES) {
    for (const p of POSITIVES)
      for (const s of SPELLINGS)
        clips.push({
          set: "positive",
          name: NAME,
          spelling: s.label,
          tts: "say",
          voice,
          text: p.text.replace("{N}", s.name),
          template: p.text,
          next: p.next,
          pcm: sayClip(voice, p.text.replace("{N}", s.name)),
        });
    for (const n of NEGATIVES) clips.push({ set: "negative", name: NAME, spelling: "-", tts: "say", voice, text: n, pcm: sayClip(voice, n) });
    if (!flags["no-baseline"])
      for (const name of BASELINE)
        for (const p of POSITIVES)
          clips.push({ set: "baseline", name, spelling: "-", tts: "say", voice, text: p.text.replace("{N}", name), template: p.text, next: p.next, pcm: sayClip(voice, p.text.replace("{N}", name)) });
  }

  const eleven = flags["no-eleven"] ? null : key("ELEVENLABS_API_KEY");
  if (eleven) {
    try {
      const voices = await elevenVoices(eleven.value, ["Mark", "Matilda"]);
      elevenUsed = voices.map((v) => v.name);
      console.log(`ElevenLabs (key from ${eleven.source}): ${elevenUsed.join(", ") || "none of the voices found"}`);
      for (const v of voices) {
        for (const p of POSITIVES) {
          const text = p.text.replace("{N}", NAME);
          clips.push({ set: "positive", name: NAME, spelling: "spelled", tts: "eleven", voice: v.name, text, template: p.text, next: p.next, pcm: await elevenClip(eleven.value, v.id, text) });
        }
        for (const n of NEGATIVES) clips.push({ set: "negative", name: NAME, spelling: "-", tts: "eleven", voice: v.name, text: n, pcm: await elevenClip(eleven.value, v.id, n) });
      }
    } catch (err) {
      if (!prior) notes.push(`ElevenLabs skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (!prior) notes.push(flags["no-eleven"] ? "ElevenLabs off (--no-eleven)." : "ElevenLabs skipped: no ELEVENLABS_API_KEY in the environment or .env.");
  console.log(`${clips.length} clips (${clips.filter((c) => c.tts === "eleven").length} from ElevenLabs).`);
  return clips;
}

let clips: Clip[] | null = null;
if (!prior) {
  clips = await buildClips();

  // Apple: the app's own helper, built here (never into native/macos/.build).
  const binary = join(WORK, "speech");
  execFileSync("swiftc", ["-O", join(ROOT, "native/macos/speech.swift"), "-o", binary]);
  await appleRun(binary, "apple", clips);

  const dg = flags["no-deepgram"] ? null : key("DEEPGRAM_API_KEY");
  if (dg) {
    const mine = clips.filter((c) => c.name === NAME);
    console.log(`Deepgram (key from ${dg.source}): ${mine.length} clips…`);
    let failed = 0;
    await pool(mine, 8, async (c) => {
      let heard: Heard;
      try {
        heard = await deepgram(dg.value, c.pcm, hintsFor(NAME));
      } catch (err) {
        failed++;
        if (failed <= 3) console.error(err instanceof Error ? err.message : String(err));
        return;
      }
      deepgramSeconds += c.pcm.length / 2 / RATE;
      const { fixed, woke } = pipeline(heard.text);
      const { pcm: _, ...rest } = c;
      rows.push({
        ...rest,
        recognizer: "deepgram",
        transcript: heard.text,
        fixed,
        woke,
        wokeLive: woke || wokeLive(heard.live),
        slot: c.template ? nameSlot(heard.text, c.template, c.next ?? "") : undefined,
      });
    });
    if (failed) notes.push(`Deepgram: ${failed} clips failed.`);
  } else notes.push(flags["no-deepgram"] ? "Deepgram off (--no-deepgram)." : "Deepgram skipped: no DEEPGRAM_API_KEY in the environment or .env.");
}

// --dictation: the same helper with Apple's DictationTranscriber in place of SpeechTranscriber. Not
// what the app uses: speech.swift says it follows the contextual strings closely but writes everyday
// speech worse; here, whether it hears the name.
if (flags.dictation && !rows.some((r) => r.recognizer === "apple-dictation")) {
  clips ??= await buildClips();
  const source = readFileSync(join(ROOT, "native/macos/speech.swift"), "utf8")
    .replace("SpeechTranscriber(locale: locale, preset: .progressiveTranscription)", "DictationTranscriber(locale: locale, preset: .progressiveShortDictation)")
    .replace("func makeTranscriber() -> SpeechTranscriber", "func makeTranscriber() -> DictationTranscriber")
    .replace("private let transcriber: SpeechTranscriber", "private let transcriber: DictationTranscriber");
  writeFileSync(join(WORK, "dictation.swift"), source);
  const binary = join(WORK, "dictation");
  execFileSync("swiftc", ["-O", join(WORK, "dictation.swift"), "-o", binary]);
  await appleRun(binary, "apple-dictation", clips);
}

// ── Summaries ────────────────────────────────────────────────────────────────────────────────────
const rate = (rs: Row[], f: (r: Row) => boolean) => ({ n: rs.length, hits: rs.filter(f).length, rate: rs.length ? Math.round((1000 * rs.filter(f).length) / rs.length) / 10 : null });
type Cut = { woke: ReturnType<typeof rate>; wokeLive: ReturnType<typeof rate> };
const cut = (rs: Row[]): Cut => ({ woke: rate(rs, (r) => r.woke), wokeLive: rate(rs, (r) => r.wokeLive) });
const groupBy = <K extends string>(rs: Row[], k: (r: Row) => K) => {
  const out: Record<string, Cut> = {};
  for (const g of [...new Set(rs.map(k))]) out[g] = cut(rs.filter((r) => k(r) === g));
  return out;
};
const recognizers = [...new Set(rows.map((r) => r.recognizer))];
const named = rows.filter((r) => r.name === NAME);
const summary: Record<string, unknown> = {};
for (const rec of recognizers) {
  const pos = named.filter((r) => r.recognizer === rec && r.set === "positive");
  const neg = named.filter((r) => r.recognizer === rec && r.set === "negative");
  summary[rec] = {
    positives: cut(pos),
    negatives: cut(neg),
    positivesBySpelling: groupBy(pos, (r) => `${r.tts}:${r.spelling}`),
    positivesByVoice: groupBy(pos, (r) => `${r.tts}:${r.voice}:${r.spelling}`),
    positivesByPhrase: groupBy(pos, (r) => r.template ?? r.text),
    negativesByVoice: groupBy(neg, (r) => `${r.tts}:${r.voice}`),
    negativesByPhrase: groupBy(neg, (r) => r.text),
  };
}
const baseline: Record<string, Record<string, unknown>> = {};
for (const name of [NAME, ...BASELINE]) {
  for (const rec of ["apple", "apple-dictation"]) {
    const rs = rows.filter((r) => r.recognizer === rec && r.tts === "say" && r.name === name && r.set !== "negative");
    if (rs.length) (baseline[rec] ??= {})[name] = name === NAME ? groupBy(rs, (r) => r.spelling) : cut(rs);
  }
}

// The spellings heard for the name, per recognizer, with how many of those clips still woke.
const slots: Record<string, Record<string, { n: number; woke: number }>> = {};
for (const r of named.filter((r) => r.set === "positive")) {
  const s = (slots[r.recognizer] ??= {});
  const k = r.slot || "(nothing)";
  s[k] ??= { n: 0, woke: 0 };
  s[k].n++;
  if (r.woke) s[k].woke++;
}
const sortedSlots = Object.fromEntries(Object.entries(slots).map(([rec, s]) => [rec, Object.fromEntries(Object.entries(s).sort((a, b) => b[1].n - a[1].n))]));

// ── Candidate spellings, tried in the real code ─────────────────────────────────────────────────
// misheard(NAME) hands back the table's own lists: a spelling pushed on is used by wake.ts and
// dictionary.ts once the spoken name changes (both cache by name), and taken off after.
type Spelling = { kind: "heard" | "atStart"; word: string };
function withSpellings<T>(spellings: Spelling[], fn: () => T): T {
  for (const { kind, word } of spellings) misheard(NAME)[kind].push(word);
  // Both rebuild their pattern when they next see another name: show them one, then the name again.
  const flip = () => {
    for (const name of ["Jarvis", NAME]) {
      setSpokenName(name);
      applyDictionary("x", NO_ENTRIES);
      wakeIn("x");
    }
  };
  flip();
  try {
    return fn();
  } finally {
    for (const { kind, word } of spellings) {
      const list = misheard(NAME)[kind];
      list.splice(list.indexOf(word), 1);
    }
    flip();
  }
}

// Real transcripts (push-to-talk, hands-free, phone dictation): counted, never kept.
const realTexts: string[] = [];
if (flags.logs && existsSync(flags.logs)) {
  for (const f of readdirSync(flags.logs).filter((f) => f.endsWith(".jsonl") && f !== "latest.jsonl")) {
    for (const line of readFileSync(join(flags.logs, f), "utf8").split("\n")) {
      if (!line.includes('"event":"transcript"')) continue;
      try {
        const t = JSON.parse(line).text;
        if (typeof t === "string" && t.trim()) realTexts.push(t);
      } catch {}
    }
  }
}
const realBefore = realTexts.map((t) => pipeline(t).woke);
// Each transcript as today's fixes write it (negatives' too), to tell what a new spelling would change.
const realFixed = new Map<string, string>();
for (const t of [...realTexts, ...named.map((r) => r.transcript)]) realFixed.set(t, applyDictionary(t, NO_ENTRIES).text);

const slotWords = new Map<string, number>();
for (const r of named.filter((r) => r.set === "positive" && !r.woke && r.slot)) {
  const w = r.slot!.trim();
  // Spellings of the name only: one or two words, no word of the phrase itself.
  if (!w || w.split(" ").length > 2) continue;
  slotWords.set(w, (slotWords.get(w) ?? 0) + 1);
}
const candidates = [...slotWords.entries()]
  .filter(([w]) => !misheard(NAME).heard.includes(w))
  .sort((a, b) => b[1] - a[1])
  .map(([w]) => w);
/** With these spellings added: what changes on the clips, and on the real transcripts. */
function tryOut(label: string, spellings: Spelling[]) {
  return withSpellings(spellings, () => {
    const again = (rs: Row[]) => rs.filter((r) => !r.woke && pipeline(r.transcript).woke).length;
    const lost = (rs: Row[]) => rs.filter((r) => r.woke && !pipeline(r.transcript).woke).length;
    const per: Record<string, unknown> = {};
    for (const rec of recognizers) {
      const pos = named.filter((r) => r.recognizer === rec && r.set === "positive");
      const neg = named.filter((r) => r.recognizer === rec && r.set === "negative");
      const hits = pos.filter((r) => pipeline(r.transcript).woke).length;
      const falseWakes = neg.filter((r) => pipeline(r.transcript).woke).length;
      per[rec] = {
        positivesGained: again(pos),
        positivesLost: lost(pos),
        hitRate: Math.round((1000 * hits) / pos.length) / 10,
        negativesNewlyWoken: again(neg),
        falseWakeRate: Math.round((1000 * falseWakes) / neg.length) / 10,
      };
    }
    const realNewTexts = realTexts.filter((t, i) => !realBefore[i] && pipeline(t).woke);
    if (flags["show-real"]) for (const t of realNewTexts.slice(0, 15)) console.log(`  [${label}] would wake: ${t}`);
    // A `heard` spelling is also written as the name wherever it is: what else that rewrites.
    const rewritten = (ts: string[]) => ts.filter((t) => applyDictionary(t, NO_ENTRIES).text !== realFixed.get(t)).length;
    const negTexts = [...new Set(named.filter((r) => r.set === "negative").map((r) => r.transcript))];
    return {
      per,
      negativeTranscriptsRewritten: rewritten(negTexts),
      realTranscriptsNewlyWoken: realTexts.length ? realNewTexts.length : null,
      realTranscriptsRewritten: realTexts.length ? rewritten(realTexts) : null,
    };
  });
}

const candidateResults: Array<Record<string, unknown>> = [];
for (const word of candidates)
  for (const kind of ["heard", "atStart"] as const) candidateResults.push({ word, kind, seenInMisses: slotWords.get(word), ...tryOut(`${kind} ${word}`, [{ kind, word }]) });

// Sets worth proposing, tried together (Kiko's: what Apple wrote for it in wake-names.ts's runs).
const at = (...words: string[]) => words.map((word) => ({ kind: "atStart" as const, word }));
const heard = (...words: string[]) => words.map((word) => ({ kind: "heard" as const, word }));
const BUNDLES: Record<string, Spelling[]> = {
  "atStart: chico, pico": at("chico", "pico"),
  "atStart: chico only": at("chico"),
  "atStart: pico only": at("pico"),
  "heard: kika, kito, geiko": heard("kika", "kito", "geiko"),
  "atStart: chico, pico, geico, people": at("chico", "pico", "geico", "people"),
};
const bundleResults = Object.entries(BUNDLES).map(([label, spellings]) => ({ label, spellings, ...tryOut(label, spellings) }));

const result = {
  date: new Date().toISOString(),
  what: "Spoken name as a wake word: synthetic voices through the app's recognizers, then the built-in name fixes and wake.ts wakeIn.",
  recognizers,
  voices: { say: prior?.voices?.say ?? VOICES, eleven: elevenUsed },
  spellings: SPELLINGS,
  hints: hintsFor(NAME),
  notes,
  // Clips used (made once and cached, so a rerun's calls are fewer), and this run's calls.
  usage: {
    elevenLabsClips: rows.filter((r) => r.tts === "eleven" && r.recognizer === "apple").length,
    elevenLabsChars: rows.filter((r) => r.tts === "eleven" && r.recognizer === "apple").reduce((n, r) => n + r.text.length, 0),
    elevenLabsCallsThisRun: elevenCalls,
    deepgramAudioSeconds: Math.round(deepgramSeconds),
  },
  summary,
  baselineApple: baseline,
  nameHeardAs: sortedSlots,
  candidates: candidateResults,
  bundles: bundleResults,
  realTranscripts: realTexts.length || null,
  realTranscriptsWokenToday: realTexts.length ? realBefore.filter(Boolean).length : null,
  // Each clip, one to a line: what was said and heard. `fixed` (the name fixes on `transcript`) and `next` are worked out again.
  rows: [] as unknown[],
};
const rowLines = rows.map(({ live: _, fixed: __, next: ___, ...r }) => `    ${JSON.stringify(r)}`).join(",\n");
writeFileSync(flags.out!, `${JSON.stringify(result, null, 2).replace('"rows": []', `"rows": [\n${rowLines}\n  ]`)}\n`);

// ── Printout ─────────────────────────────────────────────────────────────────────────────────────
const pct = (c: { woke: { hits: number; n: number; rate: number | null }; wokeLive: { rate: number | null } }) => `${c.woke.hits}/${c.woke.n} ${c.woke.rate}% (live ${c.wokeLive.rate}%)`;
for (const rec of recognizers) {
  const s = summary[rec] as any;
  console.log(`\n${rec}: positives woke ${pct(s.positives)}; negatives woke ${pct(s.negatives)}`);
  for (const [k, v] of Object.entries(s.positivesBySpelling)) console.log(`  ${k}: ${pct(v as Cut)}`);
  for (const [k, v] of Object.entries(s.positivesByVoice)) console.log(`    ${k}: ${pct(v as Cut)}`);
  for (const [k, v] of Object.entries(s.negativesByPhrase) as Array<[string, Cut]>) if (v.wokeLive.hits) console.log(`  false wake: "${k}" ${pct(v)}`);
  console.log(
    `  name heard as: ${Object.entries(sortedSlots[rec] ?? {})
      .map(([w, v]) => `${w} ${v.n}${v.woke ? ` (${v.woke} woke)` : ""}`)
      .join(", ")}`,
  );
}
for (const [rec, names] of Object.entries(baseline)) {
  console.log(`\nBaseline (${rec}, say):`);
  for (const [k, v] of Object.entries(names))
    console.log(
      `  ${k}: ${
        "woke" in (v as object)
          ? pct(v as Cut)
          : Object.entries(v as Record<string, Cut>)
              .map(([s, c]) => `${s} ${pct(c)}`)
              .join("; ")
      }`,
    );
}
console.log("\nCandidates:");
for (const c of candidateResults)
  console.log(
    `  ${c.kind} "${c.word}": ${JSON.stringify(c.per)}; negatives rewritten ${c.negativeTranscriptsRewritten}; real woken ${c.realTranscriptsNewlyWoken}, rewritten ${c.realTranscriptsRewritten}`,
  );
console.log("\nSets:");
for (const b of bundleResults)
  console.log(`  ${b.label}: ${JSON.stringify(b.per)}; negatives rewritten ${b.negativeTranscriptsRewritten}; real woken ${b.realTranscriptsNewlyWoken}, rewritten ${b.realTranscriptsRewritten}`);
for (const n of notes) console.log(`note: ${n}`);
console.log(`\nWrote ${flags.out}`);
process.exit(0);
