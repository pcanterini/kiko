// Whether something around the Kiko window takes the Kiko key before Kiko's tmux sees it,
// checked by `kiko` as it opens the window (src/cli.ts), read-only, never changing anything:
//
// - **Your own tmux**, when `kiko` runs inside one (TMUX set, and it isn't Kiko's own server):
//   its prefix and prefix2 (`show -gv`), and a binding of the key in its root table (`list-keys -T
//   root <key>`), asked of that server through TMUX itself (the CLI still has it; Kiko's own
//   children don't).
// - **herdr**, when `kiko` runs in one of its panes (HERDR_ENV=1 or TERM_PROGRAM=herdr): the
//   prefix in the `[keys]` table of its config.toml (HERDR_CONFIG_PATH, else
//   ~/.config/herdr/config.toml; ctrl+b when it says none). One table of a plain TOML file.
// - **Your terminal app**, by TERM_PROGRAM (only that variable's value, nothing else of the
//   environment): its default shortcuts, in TERMINAL_KEYS (Warp's Ctrl+Space; the others Kiko
//   knows take neither Ctrl+Space nor Ctrl+\). Inside a tmux or herdr, TERM_PROGRAM names them, not
//   the terminal around them, so a terminal's own shortcuts are only seen when `kiko` runs right in it.
// - **macOS**: "Select the previous input source" (symbolic hotkey 60, ⌃Space) and "next" (61,
//   ⌃⌥Space), from `defaults export com.apple.symbolichotkeys -`, only those two entries read; a
//   clash only when one is on and the Mac has more than one input source to switch between
//   (`defaults read com.apple.HIToolbox AppleEnabledInputSources`, only counted).
//
// When one takes it, `kiko` uses the first of keys.ts FALLBACKS none of them takes this run,
// warns you, and asks (clashNote; the app shows clashQuestion in the window, never blocking the
// terminal) whether to use that key from now on when the same thing takes yours, or to set a key of
// your own in settings. The answer is kept in the settings (keyClashAnswers, by clashId), so the
// same clash isn't asked about again; let go (Escape), the fallback stays for that run and the next
// `kiko` asks again. Imports nothing that loads .env, reads settings or writes logs.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { envVar, NAME, TITLE } from "../../core/name.ts";
import type { MenuData } from "../../ui/menu-view.ts";
import { FALLBACKS, keySequences, keySpoken, keyWords, normalizeKey } from "./keys.ts";
import { insideServer } from "./tmux.ts";
import type { Note } from "./window.ts";

/** What took the key: your tmux, herdr, your terminal app, or macOS (its input source shortcut). */
type ClashBy = "tmux" | "herdr" | "terminal" | "macos";
/**
 * A clash: what took `key` (`app`: the terminal app's name, when it's one), and the key used
 * instead this run (null: none was free, `key` stays).
 */
export type Clash = { by: ClashBy; app?: string; key: string; fallback: string | null };

/** Something that may take keys first: whether it takes `key`. `app`: a terminal app's name. */
export type Taker = { by: ClashBy; app?: string; takes(key: string): Promise<boolean> };

export type { Run } from "./herdr.ts";
import type { Run } from "./herdr.ts";

const RUN_MS = 3000;
export const run: Run = (program, args, env) =>
  new Promise((resolve) => execFile(program, args, { env: env ?? process.env, timeout: RUN_MS, maxBuffer: 4 << 20 }, (err, out) => resolve(err ? null : String(out))));

// ── Your tmux ──

/** The same key to tmux: Ctrl+Space is also C-@ (both NUL). */
const aliases = (key: string) => (key === "C-Space" ? ["C-Space", "C-@"] : [key]);

/**
 * Your own tmux, when this runs inside one that isn't Kiko's (`env.TMUX`): its prefixes, asked
 * once, and its root table, asked per key. tmux is run with `env` as it is, so it asks the server
 * TMUX names. Null outside tmux, or inside Kiko's own.
 */
export function tmuxTaker(env: NodeJS.ProcessEnv, tmux: string, exec: Run = run): Taker | null {
  if (!env.TMUX || insideServer(env.TMUX)) return null;
  let prefixes: Promise<Set<string>> | null = null;
  const readPrefixes = async () => {
    const out = await Promise.all(["prefix", "prefix2"].map((o) => exec(tmux, ["show-options", "-gv", o], env)));
    return new Set(out.map((o) => normalizeKey((o ?? "").trim())).filter((k): k is string => Boolean(k) && k !== "None"));
  };
  return {
    by: "tmux",
    async takes(key) {
      // normalizeKey reads C-@ as C-Space (one key, NUL).
      prefixes ??= readPrefixes();
      if ((await prefixes).has(key)) return true;
      for (const name of aliases(key)) {
        // Bound: its line; not bound: "unknown key", and exit 1.
        const out = await exec(tmux, ["list-keys", "-T", "root", name], env);
        if (out?.trim()) return true;
      }
      return false;
    },
  };
}

// ── herdr ──

/** Whether this runs in a herdr pane (it sets HERDR_ENV=1 and TERM_PROGRAM=herdr there). */
export const inHerdr = (env: NodeJS.ProcessEnv) => env.HERDR_ENV === "1" || env.TERM_PROGRAM === "herdr";

/** herdr's config file: HERDR_CONFIG_PATH, else ~/.config/herdr/config.toml (XDG_CONFIG_HOME's when set). */
export function herdrConfigPath(env: NodeJS.ProcessEnv): string {
  if (env.HERDR_CONFIG_PATH) return env.HERDR_CONFIG_PATH;
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "herdr", "config.toml");
}

/** herdr's prefix when its config says none. */
const HERDR_DEFAULT_PREFIX = "ctrl+b";

/**
 * The `prefix` in the `[keys]` table of herdr's config.toml (a TOML string, "ctrl+b"); null when it
 * has none. Only that table is read: the lines from `[keys]` to the next table, comments left out.
 */
export function herdrPrefix(toml: string): string | null {
  let inKeys = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inKeys = /^\[\s*keys\s*\]\s*(#.*)?$/.test(line);
      continue;
    }
    if (!inKeys) continue;
    const m = /^(?:prefix|"prefix")\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    if (m) return (m[1] ?? m[2]).replace(/\\(["\\])/g, "$1");
  }
  return null;
}

/** herdr, when this runs in one of its panes: its prefix (read once). Null outside herdr. */
export function herdrTaker(env: NodeJS.ProcessEnv, read: (path: string) => string | null = readText): Taker | null {
  if (!inHerdr(env)) return null;
  const text = read(herdrConfigPath(env));
  const prefix = normalizeKey((text !== null ? herdrPrefix(text) : null) ?? HERDR_DEFAULT_PREFIX);
  return { by: "herdr", takes: async (key) => prefix === key };
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// ── Your terminal app ──

/**
 * Terminal apps that take keys themselves out of the box, by their TERM_PROGRAM: the name to say,
 * and each key they take (tmux's name) with what it does there. A terminal is one line. Looked up
 * in each app's docs and defaults: iTerm2, Terminal.app, Alacritty, Ghostty, kitty and WezTerm
 * take neither Ctrl+Space nor Ctrl+\, so they aren't here. Warp sets TERM_PROGRAM=WarpTerminal (its
 * app says so); its Ctrl+Space splits the pane or opens an Agent Mode pane, and clearing that
 * shortcut doesn't always free it (github.com/warpdotdev/Warp/issues/5149). Its Ctrl+\ is free.
 */
export const TERMINAL_KEYS: Readonly<Record<string, { name: string; keys: Readonly<Record<string, string>> }>> = {
  WarpTerminal: { name: "Warp", keys: { "C-Space": "for a new pane" } },
};

/** What a terminal app (its name, as TERMINAL_KEYS says it) does with `key`, if it takes it. */
const terminalDoes = (app: string | undefined, key: string) => Object.values(TERMINAL_KEYS).find((t) => t.name === app)?.keys[key];

/** Your terminal app, by TERM_PROGRAM (only that variable is read), when TERMINAL_KEYS knows it takes keys. Null otherwise. */
export function terminalTaker(env: NodeJS.ProcessEnv): Taker | null {
  const program = env.TERM_PROGRAM;
  const known = program && Object.hasOwn(TERMINAL_KEYS, program) ? TERMINAL_KEYS[program] : null;
  if (!known) return null;
  return { by: "terminal", app: known.name, takes: async (key) => Object.hasOwn(known.keys, key) };
}

// ── macOS ──

/** A plist value, as the few kinds the symbolic hotkeys hold. */
type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue } | null;

/**
 * An XML property list (what `defaults export … -` writes), read: dict, array, key, string,
 * integer, real, true, false (data and date as their text). Null when it isn't one.
 */
export function parsePlist(xml: string): PlistValue {
  const tokens = [...xml.matchAll(/<(\/?)(dict|array|key|string|integer|real|true|false|data|date)(\s*\/)?>([^<]*)/g)];
  let at = 0;
  const unescape = (s: string) =>
    s
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  function value(): PlistValue {
    const t = tokens[at++];
    if (!t || t[1]) return null;
    const [, , tag, selfClosing, text] = t;
    switch (tag) {
      case "true":
      case "false":
        if (!selfClosing) at++; // <true></true>
        return tag === "true";
      case "string":
      case "data":
      case "date":
      case "key":
        if (selfClosing) return "";
        at++; // its closing tag
        return unescape(text);
      case "integer":
      case "real":
        at++;
        return Number(text.trim());
      case "array": {
        const out: PlistValue[] = [];
        if (selfClosing) return out;
        while (tokens[at] && !(tokens[at][1] && tokens[at][2] === "array")) out.push(value());
        at++;
        return out;
      }
      case "dict": {
        const out: { [key: string]: PlistValue } = {};
        if (selfClosing) return out;
        while (tokens[at] && !(tokens[at][1] && tokens[at][2] === "dict")) {
          const k = value();
          out[String(k)] = value();
        }
        at++;
        return out;
      }
    }
    return null;
  }
  try {
    return value();
  } catch {
    return null;
  }
}

/** One input source shortcut: on or off, and its key (macOS's: the character, the key code, the modifiers' mask). */
type InputHotkey = { id: 60 | 61; enabled: boolean; char: number; keyCode: number; mask: number };

/**
 * macOS's defaults for the two when the file has nothing for them: on, ⌃Space and ⌃⌥Space (as a
 * Mac new out of the box; they only act with more than one input source).
 */
const HOTKEY_DEFAULTS: Record<60 | 61, InputHotkey> = {
  60: { id: 60, enabled: true, char: 32, keyCode: 49, mask: 0x40000 },
  61: { id: 61, enabled: true, char: 32, keyCode: 49, mask: 0xc0000 },
};

/** The input source shortcuts (60 previous, 61 next) out of `defaults export com.apple.symbolichotkeys -`; only those two. */
export function inputHotkeys(xml: string | null): InputHotkey[] {
  const all = xml ? parsePlist(xml) : null;
  const keys = all && typeof all === "object" && !Array.isArray(all) ? all.AppleSymbolicHotKeys : null;
  const table = keys && typeof keys === "object" && !Array.isArray(keys) ? keys : {};
  return ([60, 61] as const).map((id) => {
    const entry = table[String(id)];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return HOTKEY_DEFAULTS[id];
    const value = entry.value && typeof entry.value === "object" && !Array.isArray(entry.value) ? entry.value : {};
    const params = Array.isArray(value.parameters) ? value.parameters.map(Number) : [];
    const [char, keyCode, mask] = params.length === 3 ? params : [HOTKEY_DEFAULTS[id].char, HOTKEY_DEFAULTS[id].keyCode, HOTKEY_DEFAULTS[id].mask];
    return { id, enabled: entry.enabled === true || entry.enabled === 1, char, keyCode, mask };
  });
}

/**
 * How many input sources macOS switches between, from `defaults read com.apple.HIToolbox
 * AppleEnabledInputSources` (an old-style plist array of dicts): keyboard layouts, input modes,
 * and input methods that have no modes listed; not the emoji picker and the like ("Non Keyboard
 * Input Method"). Only counted: nothing else is kept.
 */
export function inputSourceCount(text: string | null): number {
  if (!text) return 0;
  const entries = text.split("}").map((block) => ({
    kind: /InputSourceKind\s*=\s*"?([^";]+)"?;/.exec(block)?.[1]?.trim() ?? "",
    bundle: /"Bundle ID"\s*=\s*"?([^";]+)"?;/.exec(block)?.[1]?.trim() ?? "",
  }));
  const withModes = new Set(entries.filter((e) => e.kind === "Input Mode").map((e) => e.bundle));
  return entries.filter((e) => e.kind === "Keyboard Layout" || e.kind === "Input Mode" || (e.kind === "Keyboard Input Method" && !withModes.has(e.bundle))).length;
}

// macOS's modifier mask bits, and the key codes (US layout) for the keys that can clash.
const MASK = { shift: 0x20000, ctrl: 0x40000, alt: 0x80000, cmd: 0x100000 } as const;
const MASK_ALL = MASK.shift | MASK.ctrl | MASK.alt | MASK.cmd;
const SPACE_CODE = 49;

/** Whether shortcut `h` is `key` (tmux's name): the same modifiers, and the same character (or Space's key code). */
export function hotkeyIs(h: InputHotkey, key: string): boolean {
  const name = normalizeKey(key);
  const m = name ? /^((?:[CMS]-)*)(.+)$/.exec(name) : null;
  if (!m) return false;
  const mods = m[1];
  const base = m[2];
  const mask = (mods.includes("C-") ? MASK.ctrl : 0) | (mods.includes("M-") ? MASK.alt : 0) | (mods.includes("S-") ? MASK.shift : 0);
  if ((h.mask & MASK_ALL) !== mask) return false;
  if (base === "Space") return h.keyCode === SPACE_CODE || h.char === 32;
  return base.length === 1 && h.char !== 65535 && String.fromCharCode(h.char).toLowerCase() === base.toLowerCase();
}

/**
 * macOS's input source shortcuts, through `defaults` (KIKO_DEFAULTS: a stand-in for the tests;
 * under the test runner without one the Mac's own settings are never read, and nothing clashes).
 * Only on the Mac.
 */
export function macTaker(env: NodeJS.ProcessEnv, exec: Run = run, platform = process.platform): Taker | null {
  const defaults = envVar("DEFAULTS", env) || (env.NODE_TEST_CONTEXT ? null : "/usr/bin/defaults");
  if (platform !== "darwin" || !defaults) return null;
  let read: Promise<{ hotkeys: InputHotkey[]; sources: number }> | null = null;
  const look = async () => {
    const [hotkeys, sources] = await Promise.all([exec(defaults, ["export", "com.apple.symbolichotkeys", "-"]), exec(defaults, ["read", "com.apple.HIToolbox", "AppleEnabledInputSources"])]);
    return { hotkeys: inputHotkeys(hotkeys), sources: inputSourceCount(sources) };
  };
  return {
    by: "macos",
    async takes(key) {
      read ??= look();
      const { hotkeys, sources } = await read;
      return sources > 1 && hotkeys.some((h) => h.enabled && hotkeyIs(h, key));
    },
  };
}

// ── All together ──

/** What may take keys around this `kiko`: your tmux, herdr, your terminal app, macOS, those that apply. */
export function takers(env: NodeJS.ProcessEnv, tmux: string | null, exec: Run = run): Taker[] {
  return [tmux ? tmuxTaker(env, tmux, exec) : null, herdrTaker(env), terminalTaker(env), macTaker(env, exec)].filter((t): t is Taker => t !== null);
}

/** The first of `around` that takes `key`, or null. One that fails to answer takes nothing. */
async function takenBy(key: string, around: readonly Taker[]): Promise<Taker | null> {
  for (const t of around) if (await t.takes(key).catch(() => false)) return t;
  return null;
}

/**
 * Whether `key` clashes with what's `around`, and the key to use instead this run: the first of
 * FALLBACKS (not `key` itself) that nothing around takes; null when none is free. No clash: null.
 */
export async function checkKey(key: string, around: readonly Taker[]): Promise<Clash | null> {
  const taker = await takenBy(key, around);
  if (!taker) return null;
  const by = { by: taker.by, ...(taker.app ? { app: taker.app } : {}) };
  for (const other of FALLBACKS) {
    if (other === key) continue;
    if (!(await takenBy(other, around))) return { ...by, key, fallback: other };
  }
  return { ...by, key, fallback: null };
}

const OWNER: Record<Exclude<ClashBy, "terminal">, string> = { tmux: "Your tmux uses", herdr: "Your herdr uses", macos: "Your Mac uses" };
/** Who takes it, to start a sentence: "Your tmux uses", "Warp uses". */
const owner = (c: Clash) => (c.by === "terminal" ? `${c.app ?? "Your terminal"} uses` : OWNER[c.by]);
/** What it does with the key, said after the key: " to switch input sources", " for a new pane". */
const doing = (c: Clash) => (c.by === "macos" ? " to switch input sources" : c.by === "terminal" ? ` ${terminalDoes(c.app, c.key) ?? "itself"}` : "");

/**
 * Which clash this is, to remember your answer by (the settings' keyClashAnswers) and to tell it
 * once: what took which key, and the key used instead ("tmux:C-Space:C-\", "terminal:Warp:C-Space:C-\").
 * Another taker, key or fallback is another clash, asked about anew.
 */
export const clashId = (c: Clash) => [c.by, ...(c.app ? [c.app] : []), c.key, c.fallback ?? ""].join(":");

/** Your answer to the question: the fallback from now on whenever this clash comes up, or a key of your own (set in settings). */
type ClashAnswer = "fallback" | "own";
export const isClashAnswer = (value: unknown): value is ClashAnswer => value === "fallback" || value === "own";

/** What the app says once about a clash it doesn't ask about: shown (`text`, keys as written) and said (`spoken`, keys as said). */
export function clashMessage(c: Clash): { text: string; spoken: string } {
  const say = (name: (k: string) => string) =>
    c.fallback
      ? `${owner(c)} ${name(c.key)}${doing(c)}, so the menu key is ${name(c.fallback)} this time. Change it in settings.`
      : `${owner(c)} ${name(c.key)}${doing(c)}, so the menu key may not reach ${NAME}. Click ☰ ${TITLE} in the bottom line, or change the key in settings.`;
  return { text: say(keyWords), spoken: say(keySpoken).replace(`☰ ${TITLE}`, `the ${TITLE} button`) };
}

/** The warning that comes with the question (clashQuestion): shown and said once, as the question opens. */
function clashWarning(c: Clash & { fallback: string }): { text: string; spoken: string } {
  const say = (name: (k: string) => string, then: string) => `${owner(c)} ${name(c.key)}${doing(c)}, so the menu key is ${name(c.fallback)} this time. ${then}`;
  return { text: say(keyWords, "Keep it, or pick your own?"), spoken: say(keySpoken, "Keep it, or pick your own? It's asked in the window.") };
}

/** Who takes it, inside a sentence: "your tmux", "Warp", "your Mac". */
const taker = (c: Clash) => (c.by === "terminal" ? (c.app ?? "your terminal") : { tmux: "your tmux", herdr: "herdr", macos: "your Mac" }[c.by]);

/** What the app shows (under the list) once you've answered the question. */
export function answeredMessage(c: Clash & { fallback: string }, answer: ClashAnswer): string {
  return answer === "fallback" ? `The menu key is ${keyWords(c.fallback)} from now on when ${taker(c)} takes ${keyWords(c.key)}.` : `Pick the menu key here. ${keyWords(c.fallback)} until then.`;
}

/** What the app shows once when you answered before (no question, nothing said). */
function rememberedMessage(c: Clash & { fallback: string }, answer: ClashAnswer): string {
  const then = answer === "fallback" ? `The menu key is ${keyWords(c.fallback)} then, as you chose.` : `The menu key is ${keyWords(c.fallback)} this time. Set yours in settings.`;
  return `${owner(c)} ${keyWords(c.key)}${doing(c)}. ${then}`;
}

/**
 * What `kiko` leaves the app about a clash (window.ts Note): `answered`, what you answered
 * before (the settings' keyClashAnswers, by clashId), and `ask`, whether to ask (the key came from
 * the setting or the default, not --key or KIKO_KEY). A question needs a free fallback. `run`:
 * this `kiko`'s own, in a question's id, so one you let go is asked again by the next `kiko`;
 * a warning or a remembered answer is told once however many `kiko`s find it. `at`: when (a
 * question goes to the terminal attached since: ui/window-glue.ts showAsk).
 */
export function clashNote(c: Clash, o: { answered?: ClashAnswer; ask: boolean; run: string; at?: number }): Note {
  const id = `key_clash:${clashId(c)}`;
  const fallback = c.fallback;
  if (fallback && o.answered) {
    return { id: `${id}:${o.answered}`, text: rememberedMessage({ ...c, fallback }, o.answered), log: { event: "key_clash", fields: { ...c, answered: o.answered } } };
  }
  if (fallback && o.ask) {
    const said = clashWarning({ ...c, fallback });
    return { id: `${id}:ask:${o.run}`, text: said.text, spoken: said.spoken, ask: c, ...(o.at ? { at: o.at } : {}), log: { event: "key_clash", fields: { ...c, asked: true } } };
  }
  const said = clashMessage(c);
  return { id, text: said.text, spoken: said.spoken, log: { event: "key_clash", fields: { ...c } } };
}

/**
 * The question, in a popup over the window drawn as its menus are (src/ui/menu-view.ts): what
 * takes the key and why it matters, then the fallback from now on (`y`, chosen to start with), a
 * key of your own in settings (`s`, Settings' key everywhere in Kiko), and Escape (or the key
 * in use again) for neither: the fallback this run, asked again next time. `answer`: the tmux
 * commands that tell the app each answer; `dismissed`: the ones that tell it the question was let
 * go (so the next question, the agents card, can show).
 */
export function clashQuestion(c: Clash & { fallback: string }, answer: (a: ClashAnswer) => string[][], dismissed?: string[][]): MenuData {
  return {
    title: " Menu key ",
    ...(dismissed ? { closed: dismissed } : {}),
    again: { input: keySequences(c.fallback) },
    items: [
      { label: `${owner(c)} ${keyWords(c.key)}${doing(c)},`, tone: "yellow" },
      { label: `so it never reaches ${NAME}.`, tone: "plain" },
      "-",
      { label: `Use ${keyWords(c.fallback)} from now on`, key: "y", input: ["y", "Y"], run: answer("fallback") },
      { label: "Set my own key in settings…", key: "s", input: ["s", ","], run: answer("own") },
      "-",
      { label: `Esc: ${keyWords(c.fallback)} this time, ask next time`, tone: "dim" },
    ],
  };
}
