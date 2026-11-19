// How the voice says words it gets wrong: a respelling list applied to the text just before it
// goes to the voice (tmux → "tee mux", nginx → "engine-x"). Only what's heard changes: the screen,
// the log and the timeline keep the words as written. Every spoken line goes through respoken()
// (app/speech.ts openSpeech), and so does the text a phone says for the macOS voice.
//
// Each entry is for some voices (`voices`: "pocket", "cartesia", "macos") or, without `voices`, all
// of them. Pocket gets the most wrong; Cartesia often gets them right, and a respelling can make it
// worse, so most of the built-in ones are Pocket's. Yours are saved next to the settings file as
// plain JSON (a list of entries), read when used, so an edit there applies to the next line said.
// Yours win over the built-in ones, and one for a voice wins over one for all of them. To stop a
// built-in one, add `{ "word": "nginx", "disabled": true }` (with `voices` to stop it for some):
// the word is then said as written.
//
// Matching is by whole word, any case, with what's around it left alone: "tmux," "(nginx)"
// "nginx's" "APIs" "CI/CD" "tmux-based". One word per entry; one pass (what one respelling says
// is never respelled again).
//
// Domains, emails, URLs and file names are said the way a person reads them out, for every voice
// (see "Said as written out" below): "kiko.sh" → "kiko dot S H", "support@kiko.sh" → "support at kiko
// dot S H", "https://www.github.com/x?y" → "github dot com slash x", "localhost:3000" → "localhost
// port 3000", "package.json" → "package dot JSON", a path to a file as just the file's name. Each
// part is respelled as a word ("api.openrouter.ai": "A P I dot openrouter dot A I"); an entry for
// the whole thing wins ("Next.js"). IPs, "e.g." and "it.Then" are left alone.
//
// Numbers (said-numbers.ts, 2026-11-12): Pocket read a version's dots as full stops ("0. 3. 1.",
// with a pause) or dropped them, so it gets versions and decimals with "point" ("0.3.1" → "0 point
// 3 point 1", "1.5" → "1 point 5") and money as dollars and cents ("$0.50" → "50 cents", "$8.99" →
// "8 dollars 99"); the macOS voice gets versions the same way ("zero, three, one" otherwise).
// Cartesia gets them as written.
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./json-file.ts";
import type { Speech } from "./speech-lock.ts";
import { SETTINGS_FILE } from "./settings.ts";
import { NAME, NAME_SAID_AS } from "./name.ts";
import { type NumberKinds, numberSaid } from "./said-numbers.ts";

export const PRONUNCIATION_FILE = join(dirname(SETTINGS_FILE), "pronunciation.json");

export type Engine = "pocket" | "cartesia" | "macos";
export const ENGINES: Engine[] = ["pocket", "cartesia", "macos"];
export type Pronunciation = { word: string; say?: string; voices?: Engine[]; disabled?: boolean };

/** The voice engine as config.tts names it ("say" is the macOS voice). */
export const engineOf = (tts: string): Engine => (tts === "say" ? "macos" : tts === "pocket" ? "pocket" : "cartesia");

export const ENGINE_LABEL: Record<Engine, string> = { pocket: "Pocket", cartesia: "Cartesia", macos: "macOS voice" };

const P: Engine[] = ["pocket"];
const PM: Engine[] = ["pocket", "macos"];

/**
 * The built-in list: coding words, tools and names TTS tends to mangle, and the app's own names.
 * Acronyms said letter by letter are spelled with spaces ("C L I"); the ones said as words are
 * respelled ("jay-son", "sequel"). For all voices only where the respelling can't make it worse.
 */
export const DEFAULTS: Pronunciation[] = [
  // Tools and commands
  { word: "tmux", say: "tee mux", voices: PM },
  { word: "nginx", say: "engine-x" },
  { word: "kubectl", say: "cube control", voices: PM },
  { word: "sudo", say: "soo-doo", voices: P },
  { word: "npm", say: "N P M", voices: PM },
  { word: "pnpm", say: "P N P M" },
  { word: "npx", say: "N P X", voices: PM },
  { word: "npmjs", say: "N P M J S", voices: PM },
  { word: "zsh", say: "Z shell" },
  { word: "jq", say: "J Q" },
  { word: "chmod", say: "C H mod", voices: PM },
  { word: "chown", say: "C H own", voices: PM },
  { word: "mkdir", say: "make dir", voices: PM },
  { word: "ffmpeg", say: "F F M peg", voices: PM },
  { word: "stdout", say: "standard out" },
  { word: "stdin", say: "standard in" },
  { word: "stderr", say: "standard error" },
  { word: "stdlib", say: "standard lib" },
  { word: "localhost", say: "local host", voices: P },
  { word: "regex", say: "rej-ex", voices: PM },
  { word: "async", say: "ay-sink", voices: P },
  { word: "enum", say: "ee-num", voices: P },
  { word: "README", say: "read me", voices: PM },
  { word: "TODO", say: "to-do" },
  // Formats and languages
  { word: "JSON", say: "jay-son", voices: P },
  { word: "YAML", say: "yammel", voices: PM },
  { word: "TOML", say: "tom-el", voices: P },
  { word: "SQL", say: "sequel", voices: PM },
  { word: "MySQL", say: "my sequel", voices: PM },
  { word: "SQLite", say: "sequel-lite", voices: PM },
  { word: "PostgreSQL", say: "post-gress Q L", voices: PM },
  { word: "Postgres", say: "post-gress", voices: P },
  { word: "GraphQL", say: "graph Q L" },
  { word: "gRPC", say: "G R P C" },
  { word: "HTML", say: "H T M L", voices: P },
  { word: "CSS", say: "C S S", voices: P },
  { word: "JS", say: "J S", voices: P },
  { word: "JavaScript", say: "java script", voices: P },
  { word: "TypeScript", say: "type script", voices: P },
  { word: "C#", say: "C sharp", voices: PM },
  // File names and extensions, said on their own
  { word: ".ts", say: "dot T S", voices: P },
  { word: ".tsx", say: "dot T S X", voices: P },
  { word: ".js", say: "dot J S", voices: P },
  { word: ".json", say: "dot jay-son", voices: P },
  { word: ".md", say: "dot M D", voices: P },
  { word: ".py", say: "dot P Y", voices: P },
  { word: ".env", say: "dot env", voices: PM },
  // A domain's ".ai", said like "AI" itself (below): "dot A I" came back as "AI" 25 times in 48
  // ("Claude.a I"), "dot AI" 36 (2026-11-12, by ear).
  { word: ".ai", say: "dot AI", voices: P },
  { word: "CLAUDE.md", say: "Claude dot M D", voices: PM },
  { word: "TODO.md", say: "to-do dot M D", voices: PM },
  { word: "README.md", say: "read me dot M D", voices: PM },
  // Acronyms said letter by letter
  { word: "CLI", say: "C L I", voices: P },
  // A letter "A" on its own is read as the word "a": "A P I" came back "AP I" 2 times in 24, "A-P-I"
  // never (2026-11-12, by ear: scripts/perf/pocket-said.ts), so the ones
  // that start with it are joined.
  { word: "API", say: "A-P-I", voices: P },
  { word: "SDK", say: "S D K", voices: P },
  { word: "IDE", say: "I D E", voices: P },
  { word: "UI", say: "U I", voices: P },
  { word: "UX", say: "U X", voices: P },
  { word: "TUI", say: "T U I", voices: P },
  { word: "GUI", say: "gooey", voices: PM },
  { word: "URL", say: "U R L", voices: P },
  { word: "URI", say: "U R I", voices: P },
  { word: "HTTP", say: "H T T P", voices: P },
  { word: "HTTPS", say: "H T T P S", voices: P },
  { word: "SSH", say: "S S H", voices: P },
  { word: "TLS", say: "T L S", voices: P },
  { word: "DNS", say: "D N S", voices: P },
  { word: "CDN", say: "C D N", voices: P },
  { word: "JWT", say: "J W T", voices: P },
  { word: "UUID", say: "U U I D", voices: P },
  { word: "PID", say: "P I D", voices: P },
  { word: "CPU", say: "C P U", voices: P },
  { word: "GPU", say: "G P U", voices: P },
  { word: "CI", say: "C I", voices: P },
  { word: "CD", say: "C D", voices: P },
  { word: "OS", say: "O S", voices: P },
  { word: "PR", say: "P R", voices: P },
  { word: "DB", say: "D B", voices: P },
  // No "AI": Pocket says it right as written (71 of 72 by ear, 2026-11-12); "A I" came out "A, I",
  // heard as "uh, I" (right 20 of 72).
  { word: "LLM", say: "L L M", voices: P },
  { word: "AWS", say: "A-W-S", voices: P },
  { word: "GCP", say: "G C P", voices: P },
  { word: "OAuth", say: "oh-auth", voices: PM },
  // Platforms, frameworks and products
  { word: "iOS", say: "eye O S", voices: P },
  { word: "macOS", say: "mac O S", voices: P },
  { word: "Xcode", say: "X code", voices: P },
  { word: "XcodeGen", say: "X code gen", voices: P },
  { word: "SwiftUI", say: "swift U I", voices: P },
  { word: "VSCode", say: "V S code", voices: P },
  { word: "GitHub", say: "git hub", voices: P },
  { word: "Linux", say: "linn-ux", voices: P },
  { word: "Ubuntu", say: "oo-boon-too", voices: P },
  { word: "Kubernetes", say: "koo-ber-net-eez", voices: P },
  { word: "k8s", say: "kates" },
  { word: "Redis", say: "red-iss", voices: P },
  { word: "MongoDB", say: "mongo D B", voices: P },
  { word: "Supabase", say: "soo-pa-base", voices: P },
  { word: "Vercel", say: "ver-sell", voices: PM },
  { word: "WebSocket", say: "web socket", voices: P },
  { word: "Next.js", say: "next J S", voices: PM },
  { word: "Node.js", say: "node J S", voices: PM },
  { word: "Vite", say: "veet" },
  { word: "Vitest", say: "veet-test" },
  { word: "Vue", say: "view" },
  { word: "Nuxt", say: "nuxt", voices: P },
  { word: "Svelte", say: "svelt", voices: P },
  { word: "Deno", say: "dee-no", voices: PM },
  { word: "ESLint", say: "E S lint", voices: PM },
  { word: "pytest", say: "pie-test", voices: P },
  { word: "PyPI", say: "pie P I" },
  { word: "NumPy", say: "num-pie", voices: PM },
  { word: "Django", say: "jang-go", voices: PM },
  { word: "OpenAI", say: "open A I", voices: P },
  // The app's own name, and names the voices get wrong
  { word: NAME, say: NAME_SAID_AS, voices: ["macos"] },
  { word: "Claude", say: "clawed", voices: P },
  { word: "Jev", say: "jehv", voices: P },
  { word: "Ghostty", say: "ghost-ee", voices: PM },
  { word: "Tailscale", say: "tail scale", voices: P },
  { word: "Deepgram", say: "deep gram", voices: P },
  { word: "Cartesia", say: "car-tee-zha", voices: P },
  // Said two ways (see SAID_AS_WRITTEN_AFTER): "the site is live" rhymes with five (2026-10-29).
  { word: "live", say: "lyve", voices: P },
];

/**
 * Words written one way and said two: respelled as listed, except right after one of these words,
 * where they're left as written. "Live" is mostly the adjective in what's said here ("it's live",
 * "went live", "live reload"); after a pronoun, "to" or a helping verb it's the verb ("where you
 * live", "we can live with that"). Only the word as listed: "lives", "lived" and "living" are left
 * alone ("the config lives in src").
 */
const SAID_AS_WRITTEN_AFTER: Record<string, Set<string>> = {
  live: new Set(["i", "you", "we", "they", "who", "to", "will", "would", "can", "could", "should", "might", "must", "may", "do", "don't", "doesn't", "didn't", "can't", "won't", "cannot"]),
};

/** "nginx" and "NGINX" are the same entry. */
export const keyOf = (word: string) => word.trim().toLowerCase().replace(/’/g, "'");

// ── Your list ───────────────────────────────────────────────────────────────

// One word (no spaces), and what to say for it unless it's turned off.
const usable = (e: Pronunciation) => /[\p{L}\p{N}]/u.test(e.word) && !/\s/.test(e.word) && (e.disabled === true || Boolean(e.say?.trim()));

function clean(e: unknown): Pronunciation | null {
  if (!e || typeof e !== "object") return null;
  const { word, say, voices, disabled } = e as Record<string, unknown>;
  if (typeof word !== "string") return null;
  const out: Pronunciation = { word: word.trim() };
  if (typeof say === "string" && say.trim()) out.say = say.trim();
  if (Array.isArray(voices)) {
    const known = ENGINES.filter((v) => voices.includes(v));
    if (!known.length) return null; // only voices this app doesn't have
    out.voices = known;
  }
  if (disabled === true) out.disabled = true;
  return usable(out) ? out : null;
}

// Read again only when the file changed: it's checked once for every line said.
let cache: { file: string; mtimeMs: number; entries: Pronunciation[] } | null = null;

/** Your entries in the file; none when it's missing or unreadable. */
export function loadPronunciations(file = PRONUNCIATION_FILE): Pronunciation[] {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return [];
  }
  if (cache?.file === file && cache.mtimeMs === mtimeMs) return cache.entries;
  // A broken file (one edited by hand, or left half written by a Kiko before 2026-11-12) is set
  // aside, never saved over (core/json-file.ts): only the built-in list until sayings are added again.
  const all = readJsonFile(file, Array.isArray) as unknown[] | undefined;
  const entries = (all ?? []).map(clean).filter((e): e is Pronunciation => e !== null);
  cache = { file, mtimeMs, entries };
  return entries;
}

function save(entries: Pronunciation[], file: string) {
  writeJsonAtomic(file, entries);
  cache = null;
}

const appliesTo = (e: Pronunciation, voice: Engine) => !e.voices || e.voices.includes(voice);

/** `e` without `voice`: null when it was its only one. Without `voices`, it keeps the others. */
function without(e: Pronunciation, voice: Engine): Pronunciation | null {
  const rest = (e.voices ?? ENGINES).filter((v) => v !== voice);
  return rest.length ? { ...e, voices: rest } : null;
}

/** What `word` is said as by `voice` now: the respelling, or undefined when it's said as written. */
export function sayingOf(word: string, voice: Engine, user: Pronunciation[] = loadPronunciations()): string | undefined {
  return tableFor(voice, user).get(keyOf(word)) ?? undefined;
}

/**
 * "Kiko, say nginx as engine-x": `word` said as `say` by `voice` from now on, replacing what
 * you'd set for that voice before. Returns what it was said as before (undefined: as written).
 */
export function addPronunciation(word: string, say: string, voice: Engine, file = PRONUNCIATION_FILE): { before?: string } {
  const entry: Pronunciation = { word: word.trim(), say: say.trim(), voices: [voice] };
  if (!usable(entry)) throw new Error("A pronunciation needs one word and what to say for it.");
  const all = loadPronunciations(file);
  const before = sayingOf(word, voice, all);
  const key = keyOf(word);
  // Entries for this word with this voice among others keep the others; one for all voices stays (this one wins for its voice).
  const kept = all.flatMap((e) => (keyOf(e.word) !== key || !e.voices || !e.voices.includes(voice) ? [e] : (without(e, voice) ?? [])));
  save([...kept, entry], file);
  return { before };
}

/**
 * "Kiko, forget how to say nginx": `voice` says it as written from now on. Your entries for it
 * are taken out (for that voice); a built-in one still left is turned off for it. Returns what it
 * was said as before; undefined when it was already said as written (nothing changes then).
 */
export function forgetPronunciation(word: string, voice: Engine, file = PRONUNCIATION_FILE): { before?: string } {
  const all = loadPronunciations(file);
  const before = sayingOf(word, voice, all);
  if (before === undefined) return {};
  const key = keyOf(word);
  const kept = all.flatMap((e) => (keyOf(e.word) !== key || !appliesTo(e, voice) ? [e] : (without(e, voice) ?? [])));
  const next = sayingOf(word, voice, kept) === undefined ? kept : [...kept, { word: word.trim(), disabled: true, voices: [voice] }];
  save(next, file);
  return { before };
}

/** Takes out your entry at `index` (the settings screen): a turned-off built-in one comes back. */
export function removePronunciation(index: number, file = PRONUNCIATION_FILE): Pronunciation | null {
  const all = loadPronunciations(file);
  const gone = all[index];
  if (!gone) return null;
  save(
    all.filter((_, i) => i !== index),
    file,
  );
  return gone;
}

/** Turns off the built-in entry at `index` (the settings screen), for the voices it's for. */
export function disableDefault(index: number, file = PRONUNCIATION_FILE): Pronunciation | null {
  const d = DEFAULTS[index];
  if (!d) return null;
  const all = loadPronunciations(file);
  const same = (e: Pronunciation) => e.disabled && keyOf(e.word) === keyOf(d.word) && String(e.voices ?? "") === String(d.voices ?? "");
  if (!all.some(same)) save([...all, { word: d.word, disabled: true, ...(d.voices ? { voices: d.voices } : {}) }], file);
  return d;
}

/** Whether you have an entry for the built-in one's word that takes its place for any of its voices. */
export const overridden = (d: Pronunciation, user: Pronunciation[] = loadPronunciations()) => user.some((e) => keyOf(e.word) === keyOf(d.word) && (d.voices ?? ENGINES).some((v) => appliesTo(e, v)));

// ── Respelling ──────────────────────────────────────────────────────────────

// word → what to say (null: as written), for one voice, kept while your entries are the same.
type Table = Map<string, string | null>;
let tables: { user: Pronunciation[]; byVoice: Map<Engine, Table> } | null = null;

function tableFor(voice: Engine, user: Pronunciation[]): Table {
  if (tables?.user !== user) tables = { user, byVoice: new Map() };
  let table = tables.byVoice.get(voice);
  if (table) return table;
  table = new Map();
  // Later wins: built-in for all voices, built-in for this one, yours for all, yours for this one.
  for (const [list, scoped] of [
    [DEFAULTS, false],
    [DEFAULTS, true],
    [user, false],
    [user, true],
  ] as const) {
    for (const e of list) {
      if (Boolean(e.voices) !== scoped || !appliesTo(e, voice)) continue;
      table.set(keyOf(e.word), e.disabled ? null : e.say!);
    }
  }
  tables.byVoice.set(voice, table);
  return table;
}

// Around a word: quotes, brackets and an ellipsis before it, and those and punctuation after it.
const AROUND = /^([\p{Ps}\p{Pi}"'“‘`*_…]*)(.*?)([\p{Pe}\p{Pf}"'”’`*_.,;:!?…]*)$/su;
const bare = (s: string) => AROUND.exec(s)![2];
// A URL, an email or scoped package, a path, or a file name in a folder: left as written.
const URLISH = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)|[@\\]/i;
const PATHISH = (s: string) => /^(?:\/|~|\.{1,2}\/)/.test(s) || (s.includes("/") && (s.split("/").length > 2 || /\w\.\w/.test(s)));

const ENDINGS = ["'s", "s", "es"];

/** What one word (no punctuation around it) is said as; undefined when it isn't in the list. */
function lookup(word: string, table: Table): string | undefined {
  const key = keyOf(word);
  const exact = table.get(key);
  if (exact !== undefined) return exact ?? word;
  // "nginx's", "APIs", "regexes": the word's respelling with the ending. Letters said one by one
  // take "'s" ("C L I's", "A-P-I's", not "A-P-Is"). Only for words of two letters or more ("is" isn't "I"s).
  for (const end of ENDINGS) {
    if (!key.endsWith(end) || key.length - end.length < 2) continue;
    const base = table.get(key.slice(0, -end.length));
    if (base === undefined || key.slice(0, -end.length) in SAID_AS_WRITTEN_AFTER) continue;
    if (base === null) return word;
    return base + (end === "s" && /(?:^|[\s-])\p{Lu}$/u.test(base) ? "'s" : end);
  }
  return undefined;
}

// ── Said as written out: domains, emails, URLs and file names ───────────────

/**
 * How a domain's last part is said, written as it's said and then respelled for the voice like any
 * other words. Words where people say them as words ("dot com", "dot dev"), letters where they
 * spell them ("dot I O", "dot S H"). Only common ones, and none that's a common English word
 * ("to", "is", "it", "in", "at", "no"): "kiko.sh", not "done.It". Lowercase only, so "it.So" (a
 * missing space) isn't a domain.
 */
export const DOMAIN_ENDINGS: Record<string, string> = {
  com: "com",
  net: "net",
  org: "org",
  edu: "E D U",
  gov: "gov",
  dev: "dev",
  app: "app",
  io: "I O",
  ai: "A I",
  sh: "S H",
  co: "co",
  me: "me",
  so: "so",
  gg: "G G",
  fm: "F M",
  tv: "T V",
  ly: "L Y",
  cc: "C C",
  xyz: "X Y Z",
  us: "U S",
  uk: "U K",
  ca: "C A",
  de: "D E",
  fr: "F R",
  eu: "E U",
  info: "info",
  biz: "biz",
  pro: "pro",
  tech: "tech",
  cloud: "cloud",
  site: "site",
};

/**
 * How a file's ending is said, the same way ("JSON" is then Pocket's "jay-son", "YAML" "yammel").
 * Lowercase or all capitals ("IMG_01.JPG"). No one-letter ones: "a.m" isn't a file.
 */
export const FILE_ENDINGS: Record<string, string> = {
  ts: "T S",
  tsx: "T S X",
  mts: "M T S",
  js: "J S",
  jsx: "J S X",
  mjs: "M J S",
  cjs: "C J S",
  json: "JSON",
  jsonl: "JSON L",
  md: "M D",
  mdx: "M D X",
  sh: "S H",
  zsh: "Z S H",
  bash: "bash",
  py: "P Y",
  rb: "R B",
  rs: "R S",
  go: "go",
  swift: "swift",
  kt: "K T",
  java: "java",
  cpp: "C P P",
  php: "P H P",
  lua: "lua",
  css: "CSS",
  scss: "S C S S",
  html: "HTML",
  vue: "Vue",
  svelte: "Svelte",
  yml: "YAML",
  yaml: "YAML",
  toml: "TOML",
  xml: "X M L",
  csv: "C S V",
  sql: "SQL",
  txt: "T X T",
  log: "log",
  lock: "lock",
  plist: "P list",
  conf: "conf",
  env: "env",
  wasm: "wasm",
  png: "P N G",
  jpg: "J P G",
  jpeg: "J peg",
  gif: "gif",
  svg: "S V G",
  pdf: "P D F",
  wav: "wave",
  mp3: "M P 3",
  mp4: "M P 4",
  zip: "zip",
  dmg: "D M G",
  pkg: "P K G",
  app: "app",
};

// Acronyms in the built-in list said letter by letter: written lowercase in a domain ("api",
// "cdn") the voice can't tell they're letters, so they're spelled for every voice there.
// "A-P-I" counts: joined only so Pocket says the "A" as a letter.
const SPELLED = new Set(DEFAULTS.filter((e) => e.say?.toLowerCase().replace(/-/g, " ") === [...e.word.toLowerCase()].join(" ")).map((e) => e.word.toLowerCase()));

/** Words as written ("dot I O", "JSON L") respelled for the voice, each on its own. */
const sayWords = (words: string, table: Table) => words.replace(/\S+/g, (w) => lookup(w, table) ?? w);

/** One part of a name ("openrouter", "FUTURE", "lacy-platform", "my_file"), as it's said. */
function namePart(part: string, table: Table): string {
  return part
    .split(/([-_])/)
    .map((p, i) => {
      if (i % 2) return p === "_" ? " " : p;
      if (!p) return p;
      const said = lookup(p, table);
      if (said !== undefined) return said;
      if (SPELLED.has(p)) return [...p.toUpperCase()].join(" ");
      // A capitalised name ("FUTURE", "LAUNCH") is a word, not letters to spell out.
      return /^\p{Lu}{4,}$/u.test(p) ? p.toLowerCase() : p;
    })
    .join("");
}

/** ".io" or ".json" said on its own: yours or the built-in entry for it if there's one, else the tables. */
function endingSaid(ending: string, table: Table): string {
  const entry = table.get(keyOf(`.${ending}`));
  if (entry) return entry;
  const lower = ending.toLowerCase();
  const words = FILE_ENDINGS[lower] ?? DOMAIN_ENDINGS[lower];
  return `dot ${entry === null || !words ? lower : sayWords(words, table)}`;
}

const DOTTED = /^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+$/u;
const isFileEnding = (e: string) => (e === e.toLowerCase() || e === e.toUpperCase()) && e.toLowerCase() in FILE_ENDINGS;
const isDomainEnding = (e: string) => e in DOMAIN_ENDINGS;

/**
 * A domain or a file name ("kiko.sh", "api.openrouter.ai", "README.md", "vite.config.ts"): each
 * part said, " dot " between them, the ending as the tables say. `anyEnding`: for a host in an
 * email or a URL, where it's a domain whatever its ending ("corp.internal"). Undefined for
 * anything else: versions ("v0.1.0"), decimals, IPs, "e.g", a missing space ("it.Then").
 */
function dotted(word: string, table: Table, anyEnding = false): string | undefined {
  if (!DOTTED.test(word)) return undefined;
  const parts = word.split(".");
  const ending = parts.pop()!;
  if (parts.some((p) => !/[\p{L}\p{N}]/u.test(p))) return undefined;
  if (!isFileEnding(ending) && !isDomainEnding(ending) && !(anyEnding && /^\p{L}+$/u.test(ending))) return undefined;
  // "Vue.js", "Three.js": a library's name, said "Vue J S" like the built-in "Next.js".
  if (ending === "js" && parts.length === 1 && /^\p{Lu}\p{Ll}/u.test(parts[0])) return `${namePart(parts[0], table)} ${sayWords("J S", table)}`;
  return `${parts.map((p) => namePart(p, table)).join(" dot ")} ${endingSaid(ending, table)}`;
}

const EMAIL = /^([\p{L}\p{N}._%+-]+)@([\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+)$/u;
const SEPARATOR_SAID: Record<string, string> = { ".": " dot ", _: " underscore ", "+": " plus ", "%": " percent " };

/** "support@kiko.sh": "support at kiko dot S H"; "first.last@example.com": "first dot last at example dot com". */
function email(word: string, table: Table): string | undefined {
  const m = EMAIL.exec(word);
  if (!m) return undefined;
  const host = dotted(m[2], table, true);
  if (host === undefined) return undefined;
  const local = m[1]
    .split(/([._+%])/)
    .map((p, i) => (i % 2 ? SEPARATOR_SAID[p] : p && namePart(p, table)))
    .join("");
  return `${local} at ${host}`;
}

const URL_PARTS = /^(?:(https?):\/\/)?(?:www\.)?([\p{L}\p{N}.-]+)(?::(\d{1,5}))?(\/[^?#]*)?(\?[^#]*)?(#.*)?$/iu;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
// A path kept when it's short: two parts at most, each a word or a name, not an ID.
const MAX_PATH_PARTS = 2;
const pathPartOk = (p: string) => p.length <= 24 && /^[\p{L}\p{N}._~-]+$/u.test(p) && !(p.length >= 8 && /\d/.test(p) && /\p{L}/u.test(p));

/**
 * A web address: "https://" and "www." dropped, the host as a domain, a port as "port 3000", a
 * short path kept ("kiko.sh/releases": "kiko dot S H slash releases"). A longer path, a query and
 * a hash are dropped: the screen has them, and nobody reads one out. Only http(s), "www." or a
 * domain or local address followed by a path or port: "10:30", "v0.1.0" and "node@20" aren't URLs.
 */
function url(word: string, table: Table): string | undefined {
  const m = URL_PARTS.exec(word);
  if (!m) return undefined;
  const [, scheme, host, port, path, query, hash] = m;
  const local = host.toLowerCase() === "localhost" || IPV4.test(host);
  const written = scheme !== undefined || /^www\./i.test(word);
  const more = port !== undefined || path !== undefined || query !== undefined || hash !== undefined;
  // Without "https://" or "www.", a host needs a dot: "app/speech.ts" is a path, not the domain "app".
  if (!written && !(more && (local || (host.includes(".") && isDomainEnding(host.split(".").pop()!))))) return undefined;
  let said = IPV4.test(host) ? host : (dotted(host, table, written) ?? (/^[\p{L}\p{N}-]+$/u.test(host) ? namePart(host, table) : undefined));
  if (said === undefined) return undefined;
  if (port) said += ` port ${port}`;
  const parts = (path ?? "").split("/").filter(Boolean);
  if (parts.length && parts.length <= MAX_PATH_PARTS && parts.every(pathPartOk)) {
    for (const p of parts) said += ` slash ${lookup(p, table) ?? dotted(p, table) ?? namePart(p, table)}`;
  }
  return said;
}

/**
 * A domain, email, URL or file name as it's said; a possessive keeps its "'s" ("kiko.sh's").
 * Undefined when the word is none of those.
 */
function writtenOut(word: string, table: Table): string | undefined {
  const own = /^(.+?)(['’]s)$/u.exec(word);
  if (own) {
    const said = writtenOut(own[1], table);
    return said === undefined ? undefined : said + own[2];
  }
  // ".com", ".io", ".sh" on their own ("the .dev and .app domains").
  const bareEnding = /^\.([\p{L}\p{N}]+)$/u.exec(word);
  if (bareEnding) return isFileEnding(bareEnding[1]) || isDomainEnding(bareEnding[1]) ? endingSaid(bareEnding[1], table) : undefined;
  if (word.includes("@")) return email(word, table);
  return url(word, table) ?? dotted(word, table);
}

/**
 * Which numbers each voice gets written out (said-numbers.ts). By ear (2026-11-12): Pocket all of
 * them; the macOS voice versions only ("0.3.1" was "zero, three, one"; decimals and money it says
 * right). Cartesia wasn't tried (no key here) and has its own text normalisation: none.
 */
const NUMBERS_FOR: Partial<Record<Engine, NumberKinds>> = { pocket: "all", macos: "versions" };

/**
 * `prev`: the word before, lowercased, without what's around it ("" at the start). `numbers`:
 * which numbers this voice gets written out (NUMBERS_FOR), if any.
 */
function respellToken(token: string, table: Table, prev = "", numbers?: NumberKinds): string {
  const [, before, word, after] = AROUND.exec(token)!;
  if (!word) return token;
  if (SAID_AS_WRITTEN_AFTER[keyOf(word)]?.has(prev)) return token;
  // An entry for the whole word first ("Next.js", "CLAUDE.md", or yours for "kiko.sh"); then a
  // number ("0.3.1", "$0.50": its punctuation after it, a sentence's full stop, stays).
  const said = lookup(word, table) ?? (numbers ? numberSaid(word, prev, numbers) : undefined) ?? writtenOut(word, table);
  if (said !== undefined) return before + said + after;
  if (URLISH.test(word)) return token;
  // A path to a file ("ios/README.md", "src/core/app.ts"): said as just the file's name, when its
  // ending is in the tables; the folders are noise to the ear and the screen has them. Other
  // paths ("~/git/x", "/usr/bin") are left as written.
  if (PATHISH(word)) {
    const file = word.split("/").pop()!;
    const named = file.includes(".") ? (lookup(file, table) ?? dotted(file, table)) : undefined;
    return named !== undefined && file !== word.split("/")[0] ? before + named + after : token;
  }
  // "CI/CD", "tmux-based": each part on its own.
  if (!/[-/]/.test(word)) return token;
  let changed = false;
  const parts = word.split(/([-/])/).map((part, i) => {
    if (i % 2 || !part) return part;
    const p = lookup(part, table);
    if (p === undefined) return part;
    changed = true;
    return p;
  });
  return changed ? before + parts.join("") + after : token;
}

/** `text` as `voice` should say it: each word in the list respelled, everything else as it was. */
export function respell(text: string, voice: Engine, user: Pronunciation[] = loadPronunciations(), prev = ""): string {
  return respellWords(text, voice, user, prev).said;
}

/**
 * A word as written and as it's said: `at`, where the said one starts in the text said (UTF-16
 * offsets, as an NSRange counts them). For the phone's read-along (voice-marks.ts), which shows the
 * written words while the voice says the respelled ones.
 */
export type SaidWord = { written: string; said: string; at: number };

/** respell(), with each word as written and as said. */
export function respellWords(text: string, voice: Engine, user: Pronunciation[] = loadPronunciations(), prev = ""): { said: string; words: SaidWord[] } {
  const table = tableFor(voice, user);
  const numbers = NUMBERS_FOR[voice];
  const words: SaidWord[] = [];
  if (!text) return { said: text, words };
  let out = "";
  let last = 0;
  for (const m of text.matchAll(/\S+/g)) {
    const token = m[0];
    const said = table.size || numbers ? respellToken(token, table, prev, numbers) : token;
    // Only a word ends a sentence's context for the next: "it's live. Live reload…" isn't "it's live live".
    prev = /[.!?]["'”’)]*$/.test(token) ? "" : keyOf(bare(token));
    out += text.slice(last, m.index);
    words.push({ written: token, said, at: out.length });
    out += said;
    last = m.index + token.length;
  }
  out += text.slice(last);
  return { said: out, words };
}

/**
 * Respelling for text that streams in: a word cut between two pieces ("tm" then "ux") is held
 * until the space after it, or the end. push() and end() return what's ready to say. `onWords`:
 * each piece's words as written and said (offsets within that piece), before it's returned.
 */
export function respeller(voice: Engine, user: Pronunciation[] = loadPronunciations(), onWords?: (words: SaidWord[], said: string) => void) {
  let held = "";
  // The last word said, so a word at the start of the next piece knows what came before it.
  let prev = "";
  const say = (text: string) => {
    const { said: out, words: pairs } = respellWords(text, voice, user, prev);
    if (out) onWords?.(pairs, out);
    const words = text.trim().split(/\s+/);
    const last = words[words.length - 1];
    if (last) prev = /[.!?]["'”’)]*$/.test(last) ? "" : keyOf(bare(last));
    return out;
  };
  return {
    push(delta: string) {
      held += delta;
      const cut = held.search(/\s\S*$/);
      if (cut < 0) return "";
      const ready = held.slice(0, cut + 1);
      held = held.slice(cut + 1);
      return say(ready);
    },
    end() {
      const rest = held;
      held = "";
      return say(rest);
    },
  };
}

/** A speech that says what's pushed to it respelled for `voice`. */
export function respoken(speech: Speech, voice: Engine, user: Pronunciation[] = loadPronunciations(), onWords?: (words: SaidWord[], said: string) => void): Speech {
  const r = respeller(voice, user, onWords);
  return {
    ...speech,
    push: (delta) => {
      const text = r.push(delta);
      if (text) speech.push(text);
    },
    end: () => {
      const text = r.end();
      if (text) speech.push(text);
      speech.end();
    },
  };
}

// ── "Kiko, say X as Y" ───────────────────────────────────────────────────

const letters = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * The word you meant in "say X as Y", as it's written where the voice read it. Speech-to-text
 * writes what you said, which isn't always the spelling ("T-Mux" for tmux, "T M U X" spelled out),
 * so a word in `recent` (what was said and shown lately, newest first) with the same letters wins;
 * else letters said one by one make a word; else one word as heard. Null when it's more than one
 * word and none of those fit ("engine x"): the app asks you to spell it.
 */
export function wordFrom(heard: string, recent: string[] = []): string | null {
  const said = heard
    .trim()
    .replace(/^["'“‘]+|["'”’.,!?]+$/g, "")
    .trim();
  const key = letters(said);
  if (!key) return null;
  for (const text of recent) {
    for (const token of text.split(/\s+/)) {
      const w = bare(token);
      if (w && letters(w) === key && !URLISH.test(w) && !PATHISH(w)) return w;
    }
  }
  if (!/\s/.test(said)) return bare(said) || null;
  // "T M U X", "t. m. u. x."
  if (
    said
      .split(/[\s.,-]+/)
      .filter(Boolean)
      .every((p) => /^\p{L}$/u.test(p))
  )
    return key;
  return null;
}
