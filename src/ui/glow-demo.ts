// `kiko-dev _glow-demo`: the dithered voice glow (./dither-glow.ts) on its own, at the bottom of the
// terminal, to see how it looks before it goes anywhere in the window: at its natural size
// (GLOW_COLS × GLOW_ROWS, centred), or with --wide across the whole width. It plays a
// made-up voice on a loop (a pause, a few phrases of speech, processing, Kiko speaking), or, with
// --mic, follows the real microphone (the chosen one in the settings, else the system default:
// through the helper app, as setup's mic test does).
//
//   kiko-dev _glow-demo [--mic] [--braille | --blocks] [--rows N] [--wide] [--mono | --light]
//
// Colours: the colourful palette for a dark background; --light the one for a light background;
// --mono Kiko's accent alone.
//
// Keys: q or Ctrl+C quit (the screen and cursor as they were); 1 2 3 4 hold idle, listening,
// processing, speaking; 0 goes back to the script (with --mic: to listening).
// Drawn with plain ANSI on the alternate screen; nothing of Kiko's runs but, with --mic, the mic.
import { parseArgs } from "node:util";
import { colorDepth } from "./cli-style.ts";
import { COLORFUL, chooseEncoding, DitherGlow, GLOW_COLS, GLOW_ROWS, type GlowEncoding, type GlowMode, type GlowPalette, LIGHT, monoPalette } from "./dither-glow.ts";
import { BRAND } from "./logo.ts";
import { envelope, MIC_ENVELOPE, PLAIN_ENVELOPE } from "./voice-envelope.ts";

export const GLOW_DEMO_USAGE = "Usage: kiko-dev _glow-demo [--mic] [--braille | --blocks] [--rows N] [--wide] [--mono | --light]";

const FPS = 30;
const MODES: readonly GlowMode[] = ["idle", "listening", "processing", "speaking"];

export type GlowColors = "colorful" | "light" | "mono";
export type GlowDemoFlags = { mic: boolean; encoding?: GlowEncoding; rows: number; wide: boolean; colors: GlowColors };

/** The demo's flags, or what's wrong with them. */
export function glowDemoFlags(args: readonly string[]): GlowDemoFlags | { error: string } {
  let values: { mic?: boolean; braille?: boolean; blocks?: boolean; rows?: string; wide?: boolean; mono?: boolean; light?: boolean };
  try {
    values = parseArgs({
      args: [...args],
      options: {
        mic: { type: "boolean" },
        braille: { type: "boolean" },
        blocks: { type: "boolean" },
        rows: { type: "string" },
        wide: { type: "boolean" },
        mono: { type: "boolean" },
        light: { type: "boolean" },
      },
      strict: true,
    }).values;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (values.braille && values.blocks) return { error: "--braille or --blocks, not both" };
  if (values.mono && values.light) return { error: "--mono or --light, not both" };
  const rows = values.rows === undefined ? GLOW_ROWS : Number(values.rows);
  if (!Number.isInteger(rows) || rows < 1 || rows > 16) return { error: "--rows takes a whole number from 1 to 16" };
  return {
    mic: Boolean(values.mic),
    encoding: values.braille ? "braille" : values.blocks ? "blocks" : undefined,
    rows,
    wide: Boolean(values.wide),
    colors: values.mono ? "mono" : values.light ? "light" : "colorful",
  };
}

/** The palette for the --mono and --light flags. */
export const paletteOf = (colors: GlowColors): GlowPalette => (colors === "mono" ? monoPalette(BRAND.accent) : colors === "light" ? LIGHT : COLORFUL);

/**
 * The glow's band in a terminal `termCols` × `termRows`: GLOW_COLS centred (the set at its natural
 * size), or the whole width with --wide; `rows` high, leaving room for the demo's two lines.
 * `left` is the band's first column, from 1.
 */
export function glowBand(termCols: number, termRows: number, flags: Pick<GlowDemoFlags, "rows" | "wide">): { cols: number; rows: number; left: number } {
  const cols = flags.wide ? termCols : Math.min(GLOW_COLS, termCols);
  return { cols, rows: Math.min(flags.rows, Math.max(1, termRows - 3)), left: Math.floor((termCols - cols) / 2) + 1 };
}

// ─── The made-up voice ───────────────────────────────────────────────────────────────────────────

/** One loop of the script, in seconds: when each part starts. */
const SCRIPT = { listen: 1, process: 8, speak: 11, idle: 15.5, loop: 16.5 } as const;
/** When speech is under way while listening (the gaps between are pauses). */
const PHRASES: readonly (readonly [number, number])[] = [
  [1.3, 3.1],
  [3.6, 4.7],
  [5.4, 7.6],
];

/** A steady 0–1 "random" for whole number `n` (the same each loop). */
const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/** Syllables at about 4.5 a second, each its own loudness: 0–1. */
function syllables(t: number): number {
  const rate = 4.5;
  const n = Math.floor(t * rate);
  const within = t * rate - n;
  const shape = Math.sin(Math.PI * within) ** 2;
  return (0.55 + 0.45 * hash(n)) * shape;
}

/** The made-up speaker while listening, at `s` seconds into the script: syllables in phrases, nearly nothing between. */
function speechAt(s: number): number {
  const talking = PHRASES.some(([a, b]) => s >= a && s < b);
  return talking ? 0.2 + 0.8 * syllables(s) : 0.02 * hash(Math.floor(s * 20));
}

/** Kiko's own voice while speaking: steadier than yours. */
const kikoAt = (s: number) => 0.3 + 0.45 * syllables(s * 0.9);

/** What the script plays at `t` seconds: the mode and the voice's level. */
export function scriptAt(t: number): { mode: GlowMode; level: number } {
  const s = ((t % SCRIPT.loop) + SCRIPT.loop) % SCRIPT.loop;
  if (s < SCRIPT.listen) return { mode: "idle", level: 0 };
  if (s < SCRIPT.process) return { mode: "listening", level: speechAt(s) };
  if (s < SCRIPT.speak) return { mode: "processing", level: 0 };
  if (s < SCRIPT.idle) return { mode: "speaking", level: kikoAt(s) };
  return { mode: "idle", level: 0 };
}

/** A mode held (keys 1–4): the script's voice for it, round and round (the phrases while listening). */
export function heldAt(mode: GlowMode, t: number): { mode: GlowMode; level: number } {
  const span = SCRIPT.process - SCRIPT.listen;
  if (mode === "listening") return { mode, level: speechAt(SCRIPT.listen + (((t % span) + span) % span)) };
  if (mode === "speaking") return { mode, level: kikoAt(t) };
  return { mode, level: 0 };
}

// ─── The demo ────────────────────────────────────────────────────────────────────────────────────

const ESC = "\x1b[";
const enter = `${ESC}?1049h${ESC}?25l${ESC}2J`;
const leave = `${ESC}0m${ESC}2J${ESC}?25h${ESC}?1049l`;

/** The mic's level as it comes, while open; null when there's no mic. */
async function openMic(): Promise<{ level: () => number; stop: () => void } | null> {
  const [{ Mic }, { levelOf }, { micChoice }, { loadSettings }] = await Promise.all([
    import("../platform/macos/mic.ts"),
    import("../core/wake.ts"),
    import("../core/mic-device.ts"),
    import("../core/settings.ts"),
  ]);
  const mic = new Mic();
  await mic.start();
  if (!mic.devices.length) {
    mic.stop();
    return null;
  }
  const settings = loadSettings();
  mic.setDevice(micChoice(settings.mic, settings.micName));
  let raw = 0;
  mic.open((chunk) => {
    raw = levelOf(chunk);
  });
  return {
    level: () => raw,
    stop: () => {
      mic.close();
      mic.stop();
    },
  };
}

/** `kiko-dev _glow-demo`, until q or Ctrl+C: its exit code. */
export async function glowDemo(args: readonly string[]): Promise<number> {
  const flags = glowDemoFlags(args);
  if ("error" in flags) {
    console.error(`${flags.error}\n${GLOW_DEMO_USAGE}`);
    return 2;
  }
  const { stdout, stdin } = process;
  if (!stdout.isTTY || !stdin.isTTY) {
    console.error("_glow-demo draws in a terminal: run it in one, not through a pipe.");
    return 1;
  }
  const depth = colorDepth(stdout);
  const encoding = chooseEncoding(depth, flags.encoding);
  const note = flags.encoding === "blocks" && encoding !== "blocks" ? " (no colour here: braille instead)" : "";

  let mic: Awaited<ReturnType<typeof openMic>> = null;
  if (flags.mic) {
    stdout.write("Opening the microphone…\n");
    try {
      mic = await openMic();
    } catch (e) {
      console.error(`The microphone didn't open: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    if (!mic) {
      console.error("No microphone on this Mac.");
      return 1;
    }
  }

  const band = () => glowBand(stdout.columns || 80, stdout.rows || 24, flags);
  let { cols, rows, left } = band();
  const colors = flags.colors;
  const glow = new DitherGlow({ cols, rows, encoding, depth, palette: paletteOf(colors) });
  const options = mic ? MIC_ENVELOPE : PLAIN_ENVELOPE;
  const started = performance.now();
  let last = started;
  let level = 0;
  let held: GlowMode | null = mic ? "listening" : null;
  let msAvg = 0;

  const accent = depth === 24 ? `${ESC}38;2;154;168;255m` : depth === 256 ? `${ESC}38;5;147m` : "";
  const dim = depth ? `${ESC}2m` : "";
  const reset = depth ? `${ESC}0m` : "";

  function frame() {
    const now = performance.now();
    const t = (now - started) / 1000;
    const played = mic ? { mode: held ?? "listening", level: mic.level() } : held ? heldAt(held, t) : scriptAt(t);
    level = envelope(level, played.level, now - last, options);
    last = now;
    const a = performance.now();
    const lines = glow.render({ time: t, level, mode: played.mode });
    msAvg = msAvg * 0.9 + (performance.now() - a) * 0.1;
    const height = stdout.rows || 24;
    const top = height - lines.length + 1;
    let out = `${ESC}1;1H${ESC}2K ${accent}Kiko${reset} glow demo  ${dim}q quit · 1 idle · 2 listening · 3 processing · 4 speaking · 0 ${mic ? "listening" : "the script"}${reset}`;
    out += `${ESC}${top - 1};1H${ESC}2K ${accent}${played.mode.padEnd(10)}${reset} ${dim}level ${level.toFixed(2)} · ${encoding}${note} · ${colors} · ${cols}×${lines.length} · ${msAvg.toFixed(2)} ms a frame${mic ? " · mic" : ""}${reset}`;
    for (let i = 0; i < lines.length; i++) out += `${ESC}${top + i};${left}H${lines[i]}`;
    stdout.write(out);
  }

  return new Promise<number>((resolve) => {
    const onResize = () => {
      ({ cols, rows, left } = band());
      glow.resize(cols, rows);
      stdout.write(`${ESC}2J`);
    };
    const onKey = (data: Buffer) => {
      const key = data.toString("utf8");
      if (key === "q" || key === "Q" || key === "\x03") return done(0);
      const n = Number(key);
      if (key.length === 1 && n >= 1 && n <= 4) held = MODES[n - 1];
      else if (key === "0") held = mic ? "listening" : null;
    };
    const onSignal = () => done(130);
    const timer = setInterval(frame, 1000 / FPS);
    function done(code: number) {
      clearInterval(timer);
      stdout.off("resize", onResize);
      stdin.off("data", onKey);
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
      mic?.stop();
      stdout.write(leave);
      stdin.setRawMode(false);
      stdin.pause();
      resolve(code);
    }
    stdout.write(enter);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onKey);
    stdout.on("resize", onResize);
    process.on("SIGTERM", onSignal);
    process.on("SIGHUP", onSignal);
    frame();
  });
}
