// The live check of Apple's voice processing (echo cancellation, noise suppression, AGC: what
// AVAudioEngine's inputNode.setVoiceProcessingEnabled(true) gives the app's mic): noisy clips from
// noise.ts played out of a speaker in the room, recorded by a real mic twice, voice processing off
// and on, then heard by the app's path exactly as noise.ts does (Apple helper with the name as a
// hint, the built-in name fixes, wakeIn with "Kiko").
// THIS PLAYS SOUND THROUGH THE SPEAKERS AND OPENS THE MIC. Run it only when that's wanted.
//
//   bun scripts/perf/noise-live.ts --list
//       the audio devices (nothing opened)
//   bun scripts/perf/noise-live.ts [--input <name|uid>] [--output <name|uid>] [--and-builtin]
//       [--calibrate-only] [--dry] [--work <dir>] [--out scripts/perf/noise-live-<date>.json]
//   --dry: the preflight, the clips mixed and the plan with its duration, then stop (nothing played).
//   --input/--output: the first setup's pair (default: the system's default input and output);
//   --and-builtin: then the same again with the Mac's built-in mic and speakers (the laptop case,
//   and the hardest for echo cancellation: speaker and mic in one box). Each setup: a calibration
//   (one clean clip, voice processing off then on: is the speech well above the room, and does
//   voice processing cancel it as echo?), then 30 clips (20 Kiko phrases, 10 near-misses, natural
//   voices, café and TV noise at +5 and 0 dB) played once with voice processing off and once on.
//   About 6 min a setup; a setup whose clean clip doesn't come through (under 10 dB over the room,
//   or no wake with voice processing off) is skipped after its calibration. If voice processing cancels the played clips, the other outputs are tried
//   (calibration only) and the first that isn't cancelled is used for that setup; if none, the
//   setup runs anyway and its voice-processing numbers are marked as not meaningful.
//
// Preflight: refuses while Kiko or Kiko Dev has hands-free on (the /tmp/kiko*.state.json the app
// writes; the settings files are read, never written, for a warning), prints the plan and how long
// it will take, then counts down 5 s (Ctrl-C to stop). Never starts or talks to the app, its
// sockets or tmux. The recordings stay in <work>/live/.
//
// Why not afplay: it plays only to the system's default output, and choosing the output here must
// not change the system's settings; noise-live.swift plays each clip from its own AVAudioEngine on
// the chosen device, so to voice processing it is other sound in the room, as a person or a TV is.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { CLIPS, type Clip, appWakes, hints, inputKey, LEAD, NATURAL, prepareInputs, type Row, score } from "./noise.ts";
import { Apple, hash, RATE, wavPcm } from "./wake-lib.ts";

const ROOT = join(import.meta.dirname, "../..");
const today = new Date().toISOString().slice(0, 10);
const { values: flags } = parseArgs({
  options: {
    list: { type: "boolean" },
    input: { type: "string", default: "default" },
    output: { type: "string", default: "default" },
    "and-builtin": { type: "boolean" },
    "calibrate-only": { type: "boolean" },
    dry: { type: "boolean" },
    work: { type: "string", default: join(tmpdir(), "kiko-noise") },
    out: { type: "string", default: join(ROOT, `scripts/perf/noise-live-${today}.json`) },
  },
});
const WORK = flags.work!;
const LIVE = join(WORK, "live", new Date().toISOString().replace(/[:.]/g, "-"));
const SETTLE = 2; // s of room before the first clip (the floor; voice processing settling)
const GAP = 1; // s between clips
const CANCELLED_DB = 15; // voice processing this much lower on the played clip than without: it cancels it

// ── The helper ───────────────────────────────────────────────────────────────────────────────────
mkdirSync(WORK, { recursive: true });
const recBin = join(WORK, "noise-live-rec");
if (!existsSync(recBin)) execFileSync("swiftc", ["-O", join(ROOT, "scripts/perf/noise-live.swift"), "-o", recBin], { stdio: ["ignore", "ignore", "inherit"] });
type Dev = { id: number; uid: string; name: string; builtIn: boolean; isDefault: boolean };
const devices: { inputs: Dev[]; outputs: Dev[] } = JSON.parse(execFileSync(recBin, ["--list"], { encoding: "utf8" }));
if (flags.list) {
  for (const [kind, list] of Object.entries(devices)) {
    console.log(`${kind}:`);
    for (const d of list) console.log(`  ${d.name}${d.isDefault ? " (default)" : ""}${d.builtIn ? " [built-in]" : ""}  uid ${d.uid}`);
  }
  process.exit(0);
}
const pickDev = (list: Dev[], wanted: string) =>
  wanted === "default"
    ? list.find((d) => d.isDefault)
    : (list.find((d) => d.uid === wanted) ?? list.find((d) => d.name === wanted) ?? list.find((d) => d.name.toLowerCase().includes(wanted.toLowerCase())));

type Setup = { label: string; input: Dev; output: Dev };
const setups: Setup[] = [];
{
  const input = pickDev(devices.inputs, flags.input!);
  const output = pickDev(devices.outputs, flags.output!);
  if (!input || !output) throw new Error(`no such device: ${!input ? flags.input : flags.output} (bun scripts/perf/noise-live.ts --list)`);
  setups.push({ label: input.builtIn && output.builtIn ? "built-in" : "external", input, output });
}
if (flags["and-builtin"]) {
  const input = devices.inputs.find((d) => d.builtIn);
  const output = devices.outputs.find((d) => d.builtIn);
  if (!input || !output) throw new Error("--and-builtin: no built-in mic or speakers found");
  if (!(setups[0].input.id === input.id && setups[0].output.id === output.id)) setups.push({ label: "built-in", input, output });
}

// ── Preflight: hands-free must be off ────────────────────────────────────────────────────────────
function preflight() {
  const alive = (pid: unknown) => {
    if (typeof pid !== "number") return false;
    try {
      process.kill(pid, 0); // signal 0: only asks whether it exists
      return true;
    } catch {
      return false;
    }
  };
  let refuse = "";
  const warnings: string[] = [];
  const states = readdirSync("/tmp").filter((f) => /^kiko.*\.state\.json$/.test(f));
  for (const f of states) {
    let s: any;
    try {
      s = JSON.parse(readFileSync(join("/tmp", f), "utf8"));
    } catch {
      warnings.push(`/tmp/${f}: unreadable, so hands-free can't be checked there`);
      continue;
    }
    if (!alive(s.pid)) continue; // left over from an app that isn't running
    if (s.handsFree) refuse = `/tmp/${f} says hands-free is on (pid ${s.pid}). Turn hands-free off in ${f.startsWith("kiko-dev") ? "Kiko Dev" : "Kiko"} first: it would hear the clips.`;
    else warnings.push(`${f.replace(".state.json", "")} is running with hands-free off; don't hold the talk key while this runs.`);
  }
  for (const folder of ["kiko", "kiko-dev"]) {
    const file = join(homedir(), ".config", folder, "settings.json");
    if (!existsSync(file)) continue;
    try {
      const mode = JSON.parse(readFileSync(file, "utf8")).listenMode;
      if (mode === "hands-free") warnings.push(`${folder}'s saved listen mode is hands-free: make sure it is off now (the state file is what's checked).`);
    } catch {
      warnings.push(`${file}: unreadable, listen mode not checked`);
    }
  }
  // The mic permission is the app's this runs under (the terminal); without it macOS records silence.
  const auth = execFileSync(recBin, ["--auth"], { encoding: "utf8" }).trim();
  if (auth === "denied" || auth === "restricted")
    refuse ||=
      "this terminal has no microphone permission (macOS would record silence). Run it from a terminal that has it (the one Kiko runs in), or allow this one in System Settings → Privacy & Security → Microphone.";
  else if (auth === "notDetermined") warnings.push("macOS will ask for microphone permission for this terminal at the first recording: allow it.");
  if (!states.length) warnings.push("no /tmp/kiko*.state.json: no Kiko running as far as can be told. If one is, make sure hands-free is off.");
  for (const w of warnings) console.log(`note: ${w}`);
  if (refuse) {
    console.error(`\nRefusing to run: ${refuse}`);
    process.exit(1);
  }
}

// ── The clips ────────────────────────────────────────────────────────────────────────────────────
const COMBOS: Array<[string, number]> = [
  ["cafe", 5],
  ["cafe", 0],
  ["tv", 5],
  ["tv", 0],
];
const natural = CLIPS.filter((c) => NATURAL.includes(c.voice));
const byHash = (a: Clip, b: Clip) => hash(a.voice, a.spoken).localeCompare(hash(b.voice, b.spoken));
const chosen = [
  ...natural
    .filter((c) => c.set === "positive")
    .sort(byHash)
    .slice(0, 20),
  ...natural
    .filter((c) => c.set === "negative")
    .sort(byHash)
    .slice(0, 10),
];
const PLAN = chosen.map((clip, i) => ({ clip, noise: COMBOS[i % 4][0], snr: COMBOS[i % 4][1] }));
const CALIBRATION = natural.find((c) => c.set === "positive" && c.text.startsWith("Hey Kiko, ask"))!;

// ── Sessions ─────────────────────────────────────────────────────────────────────────────────────
type Session = { using: any; clips: Array<{ i: number; start: number; file: string }>; rec: string; channelDb?: number[] };
function session(setup: Setup, vp: boolean, files: string[], name: string): Promise<Session> {
  const plan = join(LIVE, `${name}.plan`);
  const rec = join(LIVE, `${name}.wav`);
  writeFileSync(plan, `${files.join("\n")}\n`);
  return new Promise((resolve, reject) => {
    const p = spawn(
      recBin,
      ["session", "--input", setup.input.uid, "--output", setup.output.uid, "--vp", vp ? "on" : "off", "--plan", plan, "--out", rec, "--settle", String(SETTLE), "--gap", String(GAP)],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const result: Session = { using: null, clips: [], rec };
    createInterface({ input: p.stdout }).on("line", (l) => {
      const m = JSON.parse(l);
      if (m.type === "using") result.using = m;
      else if (m.type === "clip") {
        result.clips.push(m);
        process.stdout.write(".");
      } else if (m.type === "done") {
        result.channelDb = m.channelDb;
        // Channel 0 is kept; say so if another channel carried far more (voice processing's layout).
        const [first, ...rest] = m.channelDb as number[];
        if (rest.some((d) => d > first + 20)) console.log(`\n  note (${name}): channel levels ${m.channelDb.join(", ")} dB: channel 0 is much quieter than another`);
      } else if (m.type === "error") console.error(`\n${name}: ${m.message}`);
    });
    p.on("exit", (code) => {
      process.stdout.write("\n");
      // Voice processing may not take the devices asked for: say which it really used.
      const u = result.using;
      for (const [what, got, asked] of [
        ["recording from", u?.recordingFrom?.name, setup.input.name],
        ["playing to", u?.playingTo?.name, setup.output.name],
        ["echo reference", u?.echoReference?.name, setup.output.name],
      ])
        if (got && got !== asked) console.log(`  note (${name}): ${what} "${got}", not "${asked}"`);
      for (const n of u?.notes ?? []) console.log(`  note (${name}): ${n}`);
      code === 0 ? resolve(result) : reject(new Error(`${name}: the helper exited ${code}`));
    });
  });
}

const toFloat = (pcm: Buffer) => Float32Array.from({ length: pcm.length >> 1 }, (_, i) => pcm.readInt16LE(i * 2));
const db = (x: Float32Array) => {
  let p = 0;
  for (const v of x) p += v * v;
  return 10 * Math.log10(p / Math.max(1, x.length) / 32768 ** 2 + 1e-12);
};
/** 10 ms RMS envelope. */
function envelope(x: Float32Array) {
  const n = RATE / 100;
  const e = new Float32Array(Math.floor(x.length / n));
  for (let i = 0; i < e.length; i++) {
    let p = 0;
    for (let j = i * n; j < (i + 1) * n; j++) p += x[j] * x[j];
    e[i] = Math.sqrt(p / n);
  }
  return e;
}
/** Where `src` landed in `rec` after `start` (output and input latency): the best envelope match within 0–800 ms. */
function align(rec: Float32Array, src: Float32Array, start: number) {
  const es = envelope(src);
  const er = envelope(rec.subarray(start, Math.min(rec.length, start + src.length + RATE)));
  const mean = (a: Float32Array) => a.reduce((x, y) => x + y, 0) / a.length;
  const ms = mean(es);
  let best = 0;
  let bestScore = -Infinity;
  for (let lag = 0; lag <= 80 && lag + es.length <= er.length; lag++) {
    const seg = er.subarray(lag, lag + es.length);
    const mr = mean(seg);
    let num = 0;
    let dr = 0;
    let ds = 0;
    for (let i = 0; i < es.length; i++) {
      num += (es[i] - ms) * (seg[i] - mr);
      dr += (seg[i] - mr) ** 2;
      ds += (es[i] - ms) ** 2;
    }
    const s = num / Math.sqrt(dr * ds + 1e-9);
    if (s > bestScore) {
      bestScore = s;
      best = lag;
    }
  }
  return { at: start + best * (RATE / 100), match: Math.round(bestScore * 100) / 100 };
}

type Measured = { file: string; segment: Buffer; floorDb: number; playedDb: number; match: number };
/** Each clip's stretch of the recording, and how loud it came in over the room. */
function measure(s: Session): Measured[] {
  const rec = toFloat(wavPcm(s.rec));
  const floorDb = db(rec.subarray(Math.round(0.3 * RATE), Math.round((SETTLE - 0.2) * RATE)));
  return s.clips.map((c) => {
    const src = toFloat(wavPcm(c.file));
    const { at, match } = align(rec, src, c.start);
    const seg = rec.subarray(at, Math.min(rec.length, at + src.length));
    const pcm = Buffer.alloc(seg.length * 2);
    seg.forEach((v, i) => pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2));
    return { file: c.file, segment: pcm, floorDb, playedDb: db(seg.subarray(Math.round(LEAD * RATE))), match };
  });
}

// ── Running ──────────────────────────────────────────────────────────────────────────────────────
preflight();
const clipSeconds = (f: string) => wavPcm(f).length / 2 / RATE;
const { inputs } = await prepareInputs(WORK, [...new Set([...chosen, CALIBRATION])], ["cafe", "tv"], [5, 0]);
const planFiles = PLAN.map((p) => inputs.get(inputKey(p.noise, p.snr, p.clip))!);
const calFile = inputs.get(inputKey("clean", null, CALIBRATION))!;
const sessionSecs = (files: string[]) => SETTLE + 1.5 + files.reduce((t, f) => t + clipSeconds(f) + GAP, 0);
const perSetup = 2 * sessionSecs([calFile]) + (flags["calibrate-only"] ? 0 : 2 * sessionSecs(planFiles)) + 10;
const total = perSetup * setups.length;

console.log("\nPlan:");
for (const s of setups) console.log(`  ${s.label}: mic "${s.input.name}", speakers "${s.output.name}"`);
console.log(`  calibration: 1 clean clip ("${CALIBRATION.text}", ${CALIBRATION.voice.split(" ")[0]}), voice processing off then on`);
if (!flags["calibrate-only"])
  console.log(
    `  then ${PLAN.length} clips (${PLAN.filter((p) => p.clip.set === "positive").length} with Kiko, ${PLAN.filter((p) => p.clip.set === "negative").length} near-misses; café and TV at +5 and 0 dB), voice processing off, then on`,
  );
console.log(`  expected: about ${Math.ceil(total / 60)} min (${Math.round(perSetup)} s a setup), plus ~1 min to transcribe`);
console.log("  Sound will play through the speakers named above, at the system volume as set now.");
if (flags.dry) process.exit(0);
for (let i = 5; i > 0; i--) {
  process.stdout.write(`\rStarting in ${i} s (Ctrl-C to stop)… `);
  await new Promise((r) => setTimeout(r, 1000));
}
process.stdout.write("\n");
mkdirSync(LIVE, { recursive: true });

const binary = join(WORK, "speech");
if (!existsSync(binary)) execFileSync("swiftc", ["-O", join(ROOT, "native/macos/speech.swift"), "-o", binary], { stdio: ["ignore", "ignore", "inherit"] });
const apple = new Apple(binary);
apple.setHints(hints);
await apple.transcribe(Buffer.alloc(RATE));
const wakes = await appWakes(WORK);
const hear = async (m: Measured) => apple.transcribe(m.segment.subarray(Math.round(LEAD * RATE) * 2));

type Calibration = { output: string; off: any; on: any; cancelled: boolean; usable: boolean };
async function calibrate(setup: Setup): Promise<Calibration> {
  const res: any = {};
  for (const vp of [false, true]) {
    console.log(`  calibration, ${setup.output.name}, voice processing ${vp ? "on" : "off"}`);
    const s = await session(setup, vp, [calFile], `${setup.label}-cal-${hash(setup.output.uid)}-${vp ? "on" : "off"}`);
    const [m] = measure(s);
    const heard = await hear(m);
    res[vp ? "on" : "off"] = {
      using: s.using,
      roomDb: Math.round(m.floorDb * 10) / 10,
      speechDb: Math.round(m.playedDb * 10) / 10,
      snrDb: Math.round((m.playedDb - m.floorDb) * 10) / 10,
      alignment: m.match,
      transcript: heard.text,
      woke: wakes(heard.text),
    };
  }
  if (res.off.roomDb <= -119 && res.off.speechDb <= -119) console.log("    the mic gave digital silence: no microphone permission for this terminal?");
  const cancelled = res.on.snrDb < res.off.snrDb - CANCELLED_DB;
  const usable = res.off.snrDb >= 10 && res.off.woke;
  for (const k of ["off", "on"])
    console.log(`    vp ${k}: room ${res[k].roomDb} dBFS, clip ${res[k].speechDb} dBFS, ${res[k].snrDb} dB over the room; heard "${res[k].transcript}"${res[k].woke ? " (wakes)" : ""}`);
  console.log(
    `    ${usable ? "usable" : "NOT usable: the clean clip isn't clearly above the room or didn't wake it (turn the volume up or move the mic closer)"}${cancelled ? "; voice processing CANCELS the played clip as echo" : ""}`,
  );
  return { output: setup.output.name, off: res.off, on: res.on, cancelled, usable };
}

const report: any[] = [];
const rows: Row[] = [];
// The same clips heard straight from the files (no room), for reference.
for (const [i, p] of PLAN.entries()) {
  const heard = await apple.transcribe(wavPcm(planFiles[i]).subarray(Math.round(LEAD * RATE) * 2));
  rows.push({ cond: `direct|${p.noise}|${p.snr}`, set: p.clip.set, voice: p.clip.voice, text: p.clip.text, transcript: heard.text, live: heard.live });
}
for (const setup of setups) {
  console.log(`\n${setup.label}: mic "${setup.input.name}", speakers "${setup.output.name}"`);
  const calibrations = [await calibrate(setup)];
  let use = setup;
  if (calibrations[0].cancelled) {
    for (const other of devices.outputs.filter((d) => d.id !== setup.output.id)) {
      console.log(`  trying "${other.name}" instead (voice processing cancelled the clip on "${setup.output.name}")`);
      const c = await calibrate({ ...setup, output: other });
      calibrations.push(c);
      if (!c.cancelled && c.usable) {
        use = { ...setup, output: other };
        break;
      }
    }
    if (use === setup) console.log("  no other output avoids it: running anyway; this setup's voice-processing numbers are not meaningful (it cancelled the clips themselves)");
  }
  const entry: any = { setup: setup.label, input: use.input.name, output: use.output.name, calibrations, vpMeaningful: !calibrations.at(-1)!.cancelled || use !== setup };
  report.push(entry);
  if (flags["calibrate-only"]) continue;
  // A setup whose clean clip doesn't come through clearly with voice processing off says nothing.
  const cal = calibrations.find((c) => c.output === use.output.name)!;
  if (!cal.usable) {
    entry.skipped = `calibration: the clean clip was ${cal.off.snrDb} dB over the room and ${cal.off.woke ? "woke it" : "didn't wake it"} ("${cal.off.transcript}")`;
    console.log(`  skipping ${setup.label}: ${entry.skipped}`);
    continue;
  }

  const levels: Record<string, number[]> = {};
  for (const vp of [false, true]) {
    const mode = vp ? "vp-on" : "vp-off";
    console.log(`  ${PLAN.length} clips, voice processing ${vp ? "on" : "off"}`);
    const s = await session(use, vp, planFiles, `${setup.label}-${mode}`);
    entry[mode] = { using: s.using };
    const measured = measure(s);
    levels[mode] = measured.map((m) => m.playedDb - m.floorDb);
    for (const [i, m] of measured.entries()) {
      const p = PLAN[i];
      const heard = await hear(m);
      rows.push({ cond: `${setup.label}|${mode}|${p.noise}|${p.snr}`, set: p.clip.set, voice: p.clip.voice, text: p.clip.text, transcript: heard.text, live: heard.live });
    }
    entry[mode].alignment = Math.round((measured.reduce((t, m) => t + m.match, 0) / measured.length) * 100) / 100;
  }
  // Per clip: how much lower voice processing brought the played clip in, over the room.
  const drops = levels["vp-off"].map((off, i) => off - levels["vp-on"][i]);
  entry.echo = {
    meanDropDb: Math.round((drops.reduce((a, b) => a + b, 0) / drops.length) * 10) / 10,
    clipsCancelled: drops.filter((d) => d > CANCELLED_DB).length,
    of: drops.length,
  };
}
apple.close();

// ── Scores ───────────────────────────────────────────────────────────────────────────────────────
const conds = [...new Set(rows.map((r) => r.cond))];
const results = conds.map((cond) => ({
  cond,
  ...score(
    rows.filter((r) => r.cond === cond),
    wakes,
  ),
}));
const bySetup = [
  ...new Set(
    rows.map((r) =>
      r.cond
        .split("|")
        .slice(0, r.cond.startsWith("direct") ? 1 : 2)
        .join("|"),
    ),
  ),
].map((k) => ({
  cond: k,
  ...score(
    rows.filter((r) => r.cond.startsWith(`${k}|`)),
    wakes,
  ),
}));
const out = {
  date: new Date().toISOString(),
  what: "Apple voice processing (AVAudioEngine setVoiceProcessingEnabled) off vs on, live: noise.ts's noisy clips played from a speaker and recorded by a mic, then Kiko's Apple helper, the built-in name fixes and wakeIn with Kiko. 'direct': the same files heard with no room.",
  setups: report,
  plan: PLAN.map((p) => ({ set: p.clip.set, voice: p.clip.voice, text: p.clip.text, noise: p.noise, snr: p.snr })),
  bySetup,
  results,
  recordings: LIVE,
  rows,
};
writeFileSync(flags.out!, `${JSON.stringify(out, null, 2)}\n`);
const f = (v: number | null) => (v === null ? "-" : String(v)).padStart(6);
console.log("\ncondition                     wake natural  false    WER");
for (const r of [...bySetup, ...results]) console.log(`${r.cond.padEnd(28)} ${f(r.wake)} ${f(r.wakeNatural)} ${f(r.falseWake)} ${f(r.wer)}`);
for (const e of report)
  if (e.echo)
    console.log(
      `${e.setup}: voice processing brought the clips in ${e.echo.meanDropDb} dB lower on average; ${e.echo.clipsCancelled} of ${e.echo.of} cancelled (> ${CANCELLED_DB} dB)${e.vpMeaningful ? "" : " — its voice-processing numbers are not meaningful"}`,
    );
console.log(`\nWrote ${flags.out}; recordings in ${LIVE}`);
process.exit(0);
