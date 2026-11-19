// The Kiko key: the one key that opens the Kiko window's menu from anywhere in it (tmux's
// root table: no prefix), Ctrl+Space unless you pick another. Which one this run uses: `--key`, else
// KIKO_KEY, else the "Menu key" setting, else Ctrl+Space (decideKey); then `kiko` checks it
// against what's around the window (./clash.ts: your own tmux, herdr, macOS) and takes another for
// this run if one of them would take it first.
//
// A key is written the way tmux names it (`C-Space`, `C-\`, `M-k`, `F12`), and read from tmux's
// names or the usual ones (Ctrl+Space, ctrl+\, ⌃Space, Alt+K, Option+K, ⌥K). Only keys a terminal
// sends on its own, that tmux can bind, and that leave typing alone: Ctrl or Alt with a key, or an
// F key. Not the terminal's own (Ctrl+C, Ctrl+D, Ctrl+Z, Enter as Ctrl+M…).
//
// What the rest of Kiko shows for it (the bottom line, the list, the placeholder, the viewer's
// footer) is the key this run uses, kept here (useKey) once it's known: `kiko` keeps it in Kiko's
// tmux (window.ts KEY_OPTION), where the app and the window's own programs read it.
// Imports nothing that loads .env, reads settings or writes logs: the CLI uses it.
import { ENV_PREFIX, NAME } from "../../core/name.ts";

/** The Kiko key unless you pick another. */
export const DEFAULT_KEY = "C-Space";
/** The environment's say: KIKO_KEY=C-\ (any way parseKey reads). */
export const KEY_ENV = `${ENV_PREFIX}KEY`;

/**
 * The keys taken instead when the chosen one clashes (./clash.ts), the first free one: Ctrl+\ is a
 * byte every terminal sends without extended keys (0x1c), neither tmux's nor herdr's default
 * prefix, no macOS shortcut, and not one of Claude Code's; what it usually does (SIGQUIT, a crash
 * with a core dump) is nothing anyone presses on purpose in Claude, and twice passes it on anyway.
 * Then Ctrl+] (the same, but vim's jump-to-tag), then F12.
 */
export const FALLBACKS = ["C-\\", "C-]", "F12"] as const;

const MODS = { C: "Ctrl", M: "Alt", S: "Shift" } as const;
type Mod = keyof typeof MODS;
const SYMBOL: Record<Mod, string> = { C: "⌃", M: "⌥", S: "⇧" };
const SPOKEN_MOD: Record<Mod, string> = { C: "Control", M: "Option", S: "Shift" };

/** Punctuation a key can be, with how it's said. */
const SAID: Record<string, string> = {
  "\\": "Backslash",
  "]": "Right Bracket",
  "[": "Left Bracket",
  "^": "Caret",
  _: "Underscore",
  "@": "At",
  "/": "Slash",
  ".": "Period",
  ",": "Comma",
  ";": "Semicolon",
  "'": "Quote",
  "`": "Backtick",
  "-": "Minus",
  "=": "Equals",
  "!": "Exclamation",
  "?": "Question Mark",
};

/** With Ctrl, the keys a terminal sends a byte of its own for (besides letters): Space, \ ] ^ _. */
const CTRL_PUNCT = new Set(["\\", "]", "^", "_"]);
/** Ctrl with these is the terminal's own: interrupt, end of input, backspace, Tab, new line, Enter, suspend. */
const TERMINALS_OWN = new Set(["c", "d", "h", "i", "j", "m", "z"]);

/** A key, read: its modifiers (in tmux's order: C, M, S) and the key itself (Space, a letter, F1…). */
type Parts = { mods: Mod[]; base: string };

/**
 * `text` as a key's parts, whichever way it's written ("C-Space", "Ctrl+Space", "ctrl-space",
 * "⌃Space", "^Space", "Option+K", "⌥k", "f12"); null when it isn't one. Lenient: no rules about
 * which keys Kiko takes (parseKey), so other programs' keys can be compared with it (clash.ts).
 */
function partsOf(text: string): Parts | null {
  let rest = text.trim();
  if (!rest) return null;
  const mods = new Set<Mod>();
  for (;;) {
    const m = /^(?:(ctrl|control|ctl|c|⌃|\^)|(alt|option|opt|meta|m|⌥)|(shift|s|⇧))(?:[-+]|(?<=[⌃⌥⇧^]))(?=.)/i.exec(rest);
    if (!m) break;
    // "^" alone, or "C-" before nothing, is the key itself.
    mods.add(m[1] ? "C" : m[2] ? "M" : "S");
    rest = rest.slice(m[0].length);
  }
  let base: string;
  if (/^(space|spc)$/i.test(rest) || rest === " ") base = "Space";
  else if (/^f([1-9]|1[0-2])$/i.test(rest)) base = rest.toUpperCase();
  else if ([...rest].length === 1) base = rest;
  else if (/^(backslash)$/i.test(rest)) base = "\\";
  else return null;
  // Ctrl+@ is Ctrl+Space (both NUL); Ctrl with a letter is the same either case.
  if (mods.has("C") && base === "@") base = "Space";
  if (/^[A-Za-z]$/.test(base) && (mods.has("C") || mods.has("M"))) base = base.toLowerCase();
  return { mods: (["C", "M", "S"] as Mod[]).filter((x) => mods.has(x)), base };
}

const nameOf = (p: Parts) => `${p.mods.map((m) => `${m}-`).join("")}${p.base}`;

/** `text` as tmux names that key ("ctrl+space" → "C-Space"), any key at all; null when it isn't one. For comparing keys. */
export function normalizeKey(text: string): string | null {
  const p = partsOf(text);
  return p ? nameOf(p) : null;
}

/** Why `p` can't be the Kiko key; null when it can. */
function refusal(p: Parts): string | null {
  const fkey = /^F\d+$/.test(p.base);
  if (fkey) return null;
  const ctrl = p.mods.includes("C");
  const alt = p.mods.includes("M");
  if (!ctrl && !alt) return "it needs Ctrl or Alt (Option), or an F key: a key alone would be taken from your typing";
  if (p.mods.includes("S")) return "Shift goes only with an F key: terminals don't send Ctrl or Alt with Shift apart";
  if (ctrl && !alt) {
    if (p.base === "Space" || CTRL_PUNCT.has(p.base)) return null;
    if (!/^[a-z]$/.test(p.base)) return `terminals don't send Ctrl+${p.base} on its own`;
    if (TERMINALS_OWN.has(p.base)) return `Ctrl+${p.base.toUpperCase()} is the terminal's own (${ownMeaning(p.base)})`;
    return null;
  }
  if (ctrl && alt) return /^[a-z]$/.test(p.base) && !TERMINALS_OWN.has(p.base) ? null : "with Ctrl and Alt together, only a letter";
  // Alt (Option, as Meta) with a key: letters, digits, punctuation, Space.
  return p.base === "Space" || /^[\x21-\x7e]$/.test(p.base) ? null : `Alt+${p.base} isn't a key ${NAME} can use`;
}

const ownMeaning = (letter: string) => ({ c: "interrupt", d: "end of input", h: "backspace", i: "Tab", j: "new line", m: "Enter", z: "suspend" })[letter] ?? "";

/** The key Kiko can use, as tmux names it, or why not (said back with the words as written). */
export function parseKey(text: string): { key: string } | { error: string } {
  const p = partsOf(text);
  if (!p) return { error: `${text.trim() || "(nothing)"} isn't a key (try C-Space, C-\\, Ctrl+], M-k or F12)` };
  const why = refusal(p);
  return why ? { error: `${nameOf(p)} can't be the menu key: ${why}` } : { key: nameOf(p) };
}

/** Whether `key` is one Kiko can use (parseKey takes it; for the tests). */
export const usableKey = (key: string) => "key" in parseKey(key);

/** How `key` is shown on screen, the Mac's way: "⌃Space", "⌃\", "⌥K", "F12". */
export function keySymbol(key: string): string {
  const p = partsOf(key);
  if (!p) return key;
  const base = /^[a-z]$/.test(p.base) ? p.base.toUpperCase() : p.base;
  return `${p.mods.map((m) => SYMBOL[m]).join("")}${base}`;
}

/** How `key` is written in a sentence: "Ctrl+Space", "Ctrl+\", "Alt+K", "F12". */
export function keyWords(key: string): string {
  const p = partsOf(key);
  if (!p) return key;
  const base = /^[a-z]$/.test(p.base) ? p.base.toUpperCase() : p.base;
  return [...p.mods.map((m) => MODS[m]), base].join("+");
}

/** How `key` is said out loud: "Control-Space", "Control-Backslash", "Option-K". */
export function keySpoken(key: string): string {
  const p = partsOf(key);
  if (!p) return key;
  const base = /^[a-z]$/.test(p.base) ? p.base.toUpperCase() : (SAID[p.base] ?? p.base);
  return [...p.mods.map((m) => SPOKEN_MOD[m]), base].join("-");
}

/** CSI u's modifier number: 1 plus Shift 1, Alt 2, Ctrl 4. */
const csiMod = (p: Parts) => 1 + (p.mods.includes("S") ? 1 : 0) + (p.mods.includes("M") ? 2 : 0) + (p.mods.includes("C") ? 4 : 0);
const F_TILDE: Record<string, number> = { F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
const F_SS3: Record<string, string> = { F1: "P", F2: "Q", F3: "R", F4: "S" };

/**
 * What a program in a pane reads when `key` is pressed (the menu's popup: Kiko's key again
 * there passes it on): its plain form (Ctrl's byte, Alt as Escape first, an F key's sequence),
 * and the CSI u form tmux sends with extended keys ("ESC [ 92 ; 5 u" for Ctrl+\).
 */
export function keySequences(key: string): string[] {
  const p = partsOf(key);
  if (!p) return [];
  const mod = csiMod(p);
  if (/^F\d+$/.test(p.base)) {
    const ss3 = F_SS3[p.base];
    if (ss3) return mod === 1 ? [`\x1bO${ss3}`, `\x1b[1${ss3}`] : [`\x1b[1;${mod}${ss3}`];
    const n = F_TILDE[p.base];
    return mod === 1 ? [`\x1b[${n}~`] : [`\x1b[${n};${mod}~`];
  }
  const code = p.base === "Space" ? 32 : p.base.codePointAt(0)!;
  const ctrl = p.mods.includes("C");
  const alt = p.mods.includes("M");
  let plain = p.base === "Space" ? " " : p.base;
  if (ctrl) plain = p.base === "Space" ? "\x00" : String.fromCharCode(code & 0x1f);
  if (alt) plain = `\x1b${plain}`;
  return [plain, `\x1b[${code};${mod}u`];
}

/** What decided the key: the flag, KIKO_KEY, the setting, the default. */
export type KeyBy = "flag" | "env" | "setting" | "default";
export type KeyChoice = { key: string; by: KeyBy /** A KIKO_KEY or setting that isn't a key Kiko can use: said, then passed over. */; ignored?: string[] };

/**
 * Flag > KIKO_KEY > the setting > Ctrl+Space. The flag is checked as the command line is read
 * (cli-args.ts: a bad one is a usage error); a KIKO_KEY or setting Kiko can't use is passed
 * over, with why in `ignored`.
 */
export function decideKey(o: { flag?: string; env?: string; setting?: unknown }): KeyChoice {
  const ignored: string[] = [];
  const tryOne = (value: unknown, by: KeyBy, what: string): KeyChoice | null => {
    if (typeof value !== "string" || !value.trim()) return null;
    const parsed = parseKey(value);
    if ("key" in parsed) return { key: parsed.key, by, ...(ignored.length ? { ignored } : {}) };
    ignored.push(`${what}: ${parsed.error}`);
    return null;
  };
  return (
    tryOne(o.flag, "flag", "--key") ??
    tryOne(o.env, "env", KEY_ENV) ??
    tryOne(o.setting, "setting", "the Menu key setting") ?? { key: DEFAULT_KEY, by: "default", ...(ignored.length ? { ignored } : {}) }
  );
}

// ── The key this run uses, for what shows it ──

let current = DEFAULT_KEY;

/** The Kiko key this run uses (tmux's name for it). */
export const currentKey = () => current;
/** The Kiko key as shown: "⌃Space". */
export const menuKeyName = () => keySymbol(current);
/** Takes `key` as the Kiko key from now on (what Kiko's tmux says it is); one Kiko can't use is passed over. Whether it changed. */
export function useKey(key: string): boolean {
  const parsed = parseKey(key);
  if (!("key" in parsed) || parsed.key === current) return false;
  current = parsed.key;
  return true;
}
