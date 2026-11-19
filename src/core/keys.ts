// The API keys Kiko's own calls use, and where each comes from. A key in the environment or .env
// wins (development); one missing from both is read from the Keychain (platform/keys.ts) as the app
// starts. The ones Kiko finds (the Keychain's, .env's, one entered) are held in memory
// (./key-values.ts), never in process.env, so no program Kiko starts inherits them; keyOf reads
// one. Entering one (settings →
// Keys, `kiko keys set`, first-run setup) checks it with a cheap call to its provider first, then
// saves it in the Keychain. No key is ever logged, said, shown (only its last four characters), or
// put in a program's arguments.
import type { KeyStore } from "../platform/types.ts";
import type { SettingRow } from "./ui-store.ts";
import { COMMAND, ENV_PREFIX, NAME } from "./name.ts";
import { appEnv } from "./env.ts";
import { OPENROUTER_HAIKU, OPENROUTER_MODELS } from "./openrouter-llm.ts";
import { heldKeys, keyOf } from "./key-values.ts";

export type KeyId = "openrouter" | "anthropic" | "deepgram" | "cartesia";

/** A key: its id (`kiko keys set <id>`), its variable, its provider, and what it's for, in a few words. */
export type KeyInfo = { id: KeyId; env: string; name: string; what: string };

/** In the order they're asked for: OpenRouter first, the one key most need. */
export const KEYS: KeyInfo[] = [
  { id: "openrouter", env: "OPENROUTER_API_KEY", name: "OpenRouter", what: "the one key: every model and the classifier" },
  { id: "anthropic", env: "ANTHROPIC_API_KEY", name: "Anthropic", what: "optional: Haiku billed to Anthropic directly" },
  { id: "deepgram", env: "DEEPGRAM_API_KEY", name: "Deepgram", what: "speech-to-text with Deepgram" },
  { id: "cartesia", env: "CARTESIA_API_KEY", name: "Cartesia", what: "the Cartesia voice" },
];

export const KEY_NAMES = KEYS.map((k) => k.env);

/** A key by its id, its provider's name or its variable, any case ("openrouter", "OPENROUTER_API_KEY"). */
export function keyNamed(word: string): KeyInfo | undefined {
  const w = word.trim().toLowerCase();
  return KEYS.find((k) => k.id === w || k.name.toLowerCase() === w || k.env.toLowerCase() === w);
}

/** Where a key in use came from. */
export type KeySource = "environment" | ".env" | "Keychain";

/**
 * The keys this run uses, read in, and where each one came from: `shell`, the names set before .env
 * was read (the environment: yours, left in `env`); the rest set then, .env (taken out of `env` and
 * held in `held`); the ones missing, from the store, the Keychain (held in `held`, never put in
 * `env`). So nothing Kiko starts inherits a key it found (./key-values.ts). A store that fails (a
 * prompt said no to, the helper not built) fills nothing: `error` says why, with no key in it.
 */
export function fillKeys(env: NodeJS.ProcessEnv, shell: ReadonlySet<string>, store: KeyStore | null, held: Record<string, string> = heldKeys): { sources: Record<string, KeySource>; error?: string } {
  const sources: Record<string, KeySource> = {};
  for (const name of KEY_NAMES) {
    const value = env[name];
    if (!isSet(value)) continue;
    if (shell.has(name)) {
      sources[name] = "environment";
      continue;
    }
    sources[name] = ".env";
    held[name] = value;
    delete env[name];
  }
  const missing = KEY_NAMES.filter((name) => !sources[name]);
  if (!store || !missing.length) return { sources };
  try {
    const found = store.get(missing);
    for (const name of missing) {
      if (!found[name]) continue;
      held[name] = found[name];
      sources[name] = "Keychain";
    }
    return { sources };
  } catch (err) {
    return { sources, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A key's variable has one: set and not blank (a blank one is no key, and the Keychain's fills it). */
const isSet = (value: string | undefined): value is string => Boolean(value?.trim());

/** The model keys: either one lets the app answer (OpenRouter's, the one setup asks for, or Anthropic's). */
export const MODEL_KEYS = ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"] as const;

/**
 * Whether there's a model key in `env` (after fillKeys: the environment, a checkout's .env, the
 * Keychain). The one question setup (../onboard.ts: whether to ask for one, and on its last step)
 * and the app (config.ts noModelKey: whether it can start) both ask, so they never disagree.
 */
export const hasModelKey = (env: NodeJS.ProcessEnv): boolean => MODEL_KEYS.some((name) => isSet(env[name]));

/**
 * Whether the app has a model to run on: a model key (hasModelKey), or a Kiko account's plan in effect
 * (`account`: core/account/app-account.ts accountRunsModels for setup's key; the app's start asks
 * accountHasPlan, Pro past its month's allowance included). Setup and the app both ask this.
 */
export const hasModel = (env: NodeJS.ProcessEnv, account: boolean): boolean => hasModelKey(env) || account;

/**
 * The keys this run uses, by variable, as an environment-like record for the questions below
 * (hasModelKey, pickEngines): yours from `env`, else the ones Kiko holds (./key-values.ts keyOf).
 * Only for asking: never a program's environment.
 */
export function keysInUse(env: NodeJS.ProcessEnv = process.env, held: Record<string, string> = heldKeys): Record<string, string> {
  return Object.fromEntries(KEY_NAMES.map((name) => [name, keyOf(name, env, held)]).filter(([, value]) => isSet(value)));
}

/** A key as it may be shown: its last four characters ("…a1b2"); a short one, not even those. */
export const masked = (key: string) => (key.length >= 16 ? `…${key.slice(-4)}` : "…");

/** `text` with every occurrence of `key` taken out: a provider's message never repeats it here. */
export const without = (text: string, key: string) => (key ? text.split(key).join("…") : text);

// ── Which keys the chosen options need ─────────────────────────────────────

/** The options that decide which keys are needed. */
export type Chosen = { stt: string; tts: string; llm: string };

/** Whether a key is needed now, by what's chosen: and why, in a few words. */
export function neededFor(id: KeyId, c: Chosen): string | null {
  switch (id) {
    case "openrouter":
      return c.llm !== "haiku" ? "the model is on OpenRouter" : null;
    case "anthropic":
      return c.llm === "haiku" ? "summaries use Haiku on Anthropic" : null;
    case "deepgram":
      return c.stt === "deepgram" ? "speech-to-text is Deepgram" : null;
    case "cartesia":
      return c.tts === "cartesia" ? "the voice is Cartesia" : null;
  }
}

/**
 * The keys to show: OpenRouter and Anthropic always; Deepgram and Cartesia only when that engine is
 * chosen, or a key for it is set (`set`: the variables that have one, anywhere).
 */
export function keysShown(c: Chosen, set: ReadonlySet<string>): KeyInfo[] {
  return KEYS.filter((k) => (k.id !== "deepgram" && k.id !== "cartesia") || neededFor(k.id, c) || set.has(k.env));
}

// ── What runs, by the keys there are ───────────────────────────────────────

/** The key an engine or model needs (`setting`: "tts", "stt" or "llm"), or null for a free one. */
export function keyForOption(setting: string, value: unknown): KeyInfo | null {
  const id =
    setting === "tts" && value === "cartesia" ? "cartesia" : setting === "stt" && value === "deepgram" ? "deepgram" : setting === "llm" ? (value === "haiku" ? "anthropic" : "openrouter") : null;
  return KEYS.find((k) => k.id === id) ?? null;
}

/** An engine or model chosen whose key is missing, and what runs instead: said once at start. */
export type Fallback = { setting: "tts" | "stt" | "llm"; chosen: string; using: string; key: KeyId };

/**
 * The voice, speech recognition and model a run uses, by what's chosen (settings, or KIKO_TTS, KIKO_STT and KIKO_LLM
 * in .env) and the keys in `env`; `account`: a Kiko account's plan runs OpenRouter's models when
 * there's no OpenRouter key (core/model-route.ts), so OpenRouter counts as there. Chosen with its key there, it runs. Chosen without one, a stand-in
 * runs and a Fallback says so: Cartesia → Pocket (the macOS voice when Pocket isn't installed),
 * Deepgram → Apple, Haiku on Anthropic → Haiku through OpenRouter, an OpenRouter model → Haiku on
 * Anthropic. Nothing chosen: the paid one when its key is there (as before keys were optional), else
 * the one-key setup (Pocket, Apple, Haiku through OpenRouter), with nothing to say. `llm` is null
 * with no model key at all (neither OpenRouter nor Anthropic). Pocket chosen but not installed here
 * (`pocket` false: a new clone or install, whose venv is its own while the settings are shared): the
 * macOS voice, with no Fallback (no key is missing; app.ts starts Pocket's download and says so).
 */
export function pickEngines(chosen: Partial<Chosen>, env: NodeJS.ProcessEnv, pocket: boolean, account = false): { tts: string; stt: string; llm: string | null; fallbacks: Fallback[] } {
  const has = (id: KeyId) => isSet(env[KEYS.find((k) => k.id === id)!.env]) || (id === "openrouter" && account);
  const fallbacks: Fallback[] = [];
  const freeVoice = pocket ? "pocket" : "say";
  let tts = chosen.tts ?? (has("cartesia") ? "cartesia" : freeVoice);
  if (tts === "cartesia" && !has("cartesia")) fallbacks.push({ setting: "tts", chosen: tts, using: (tts = freeVoice), key: "cartesia" });
  if (tts === "pocket" && !pocket) tts = "say";
  let stt = chosen.stt ?? (has("deepgram") ? "deepgram" : "apple");
  if (stt === "deepgram" && !has("deepgram")) fallbacks.push({ setting: "stt", chosen: stt, using: (stt = "apple"), key: "deepgram" });
  let llm: string | null = chosen.llm ?? (has("anthropic") ? "haiku" : OPENROUTER_HAIKU);
  const needs: KeyId = llm === "haiku" ? "anthropic" : "openrouter";
  if (!has(needs)) {
    const other = needs === "anthropic" ? OPENROUTER_HAIKU : "haiku";
    const using = has(needs === "anthropic" ? "openrouter" : "anthropic") ? other : null;
    if (using && chosen.llm) fallbacks.push({ setting: "llm", chosen: llm, using, key: needs });
    llm = using;
  }
  return { tts, stt, llm, fallbacks };
}

/** What a stand-in is, in a few words, for the line said at start. */
function standIn(f: Fallback): string {
  if (f.setting === "tts") return `${f.using === "pocket" ? "the Pocket voice" : "the macOS voice"} is speaking`;
  if (f.setting === "stt") return "Apple's speech recognition is listening";
  if (f.using === "haiku") return `Claude Haiku on Anthropic stands in for ${OPENROUTER_MODELS.find((m) => m.id === f.chosen)?.label ?? f.chosen}`;
  return "Claude Haiku runs through OpenRouter";
}

/** The line said once at start for the stand-ins: "No Cartesia key, so the Pocket voice is speaking. Add one in Settings → Keys." */
export function fallbackLine(fallbacks: Fallback[]): string {
  const said = fallbacks.map((f) => `no ${KEYS.find((k) => k.id === f.key)!.name} key, so ${standIn(f)}`).join("; ");
  return `${said.charAt(0).toUpperCase()}${said.slice(1)}. Add ${fallbacks.length > 1 ? "them" : "one"} in Settings → Keys.`;
}

/** Why the app can't start with no model key, in a line (setup's last step says it before asking for one). */
export const NEEDS_KEY = `${NAME} needs an OpenRouter key to answer.`;
/** Exactly what to do about it, by this flavour's command: said under NEEDS_KEY when the key is left for later. */
export const NO_KEY_TODO = `Run \`${COMMAND} keys set openrouter\`, paste your key, then run \`${COMMAND}\`.`;
/** Both, as the app says them when it can't start (start.ts then asks for the key in the window). */
export const NO_MODEL_KEY = `${NEEDS_KEY} ${NO_KEY_TODO}`;

// ── Checking a key ─────────────────────────────────────────────────────────

/**
 * What came of checking a key: it works; the provider turned it down (`reason`, its words); or it
 * couldn't be checked (offline, timed out, the provider failing), so whether to save it anyway is
 * for you to say. `said`: the line to show, never with the key in it.
 */
export type KeyCheck = { result: "works" | "refused" | "unchecked"; said: string };

export type KeyFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

const CARTESIA_VERSION = () => appEnv("CARTESIA_VERSION") ?? "2026-08-14";

/** The cheapest call that needs a working key, for each provider (each one's docs, 2026-10-31). */
export function checkCall(id: KeyId, key: string): { url: string; headers: Record<string, string> } {
  switch (id) {
    case "openrouter":
      // The key's own details (its limit and usage): free, any key.
      return { url: "https://openrouter.ai/api/v1/key", headers: { Authorization: `Bearer ${key}` } };
    case "anthropic":
      return { url: "https://api.anthropic.com/v1/models?limit=1", headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } };
    case "deepgram":
      return { url: "https://api.deepgram.com/v1/projects", headers: { Authorization: `Token ${key}` } };
    case "cartesia":
      // The same headers the voice itself uses (cartesia.ts).
      return { url: "https://api.cartesia.ai/voices?limit=1", headers: { "X-API-Key": key, "Cartesia-Version": CARTESIA_VERSION() } };
  }
}

/** The provider's reason from an error body (each one's shape), short, without the key. */
export function reasonFrom(body: string, key: string): string {
  let reason = body.trim();
  try {
    const j = JSON.parse(body);
    const found = [j?.error?.message, j?.err_msg, j?.message, j?.detail, typeof j?.error === "string" ? j.error : undefined].find((v) => typeof v === "string" && v.trim());
    if (found) reason = found.trim();
  } catch {
    // not JSON: the text as it is
  }
  reason = without(reason, key).replace(/\s+/g, " ");
  return reason.length > 140 ? `${reason.slice(0, 139)}…` : reason;
}

/** Checks `key` with its provider's cheap call (checkCall), within `timeoutMs`. */
export async function checkKey(id: KeyId, key: string, opts: { fetch?: KeyFetch; timeoutMs?: number } = {}): Promise<KeyCheck> {
  const info = KEYS.find((k) => k.id === id)!;
  const call = checkCall(id, key);
  const doFetch = opts.fetch ?? (fetch as unknown as KeyFetch);
  let res: Awaited<ReturnType<KeyFetch>>;
  try {
    res = await doFetch(call.url, { headers: call.headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { result: "unchecked", said: `Couldn't reach ${info.name} to check the key (${timedOut ? "it didn't answer in time" : "offline?"})` };
  }
  if (res.ok) return { result: "works", said: `✓ ${info.name} key works` };
  const reason = reasonFrom(await res.text().catch(() => ""), key);
  // Deepgram: a key without the scope to list projects can still transcribe.
  if (res.status === 401 || (res.status === 403 && id !== "deepgram")) {
    return { result: "refused", said: `✗ ${info.name} turned the key down${reason ? `: ${reason}` : ` (${res.status})`}` };
  }
  return { result: "unchecked", said: `Couldn't check the key: ${info.name} answered ${res.status}${reason ? ` (${reason})` : ""}` };
}

// ── Entering one ───────────────────────────────────────────────────────────

/** What came of entering a key: saved, or not (and why); `lines` to show, in order. */
type Entered = { saved: boolean; lines: string[] };

/**
 * A key entered (the CLI): checked, then saved in the store if it works, or if it
 * couldn't be checked and `anyway` says yes. A refused one isn't saved. Never logs it.
 */
export async function enterKey(info: KeyInfo, key: string, opts: { store: KeyStore | null; anyway: () => Promise<boolean>; fetch?: KeyFetch; timeoutMs?: number }): Promise<Entered> {
  key = key.trim();
  if (!key) return { saved: false, lines: ["No key entered; nothing saved."] };
  if (!opts.store) return { saved: false, lines: [`No Keychain here (${ENV_PREFIX}KEYCHAIN is off, or this isn't a Mac): put ${info.env} in .env instead.`] };
  const check = await checkKey(info.id, key, opts);
  const lines = [check.said];
  if (check.result === "refused") return { saved: false, lines: [...lines, "Nothing saved."] };
  if (check.result === "unchecked" && !(await opts.anyway())) return { saved: false, lines: [...lines, "Nothing saved."] };
  try {
    await opts.store.set(info.env, key);
  } catch (err) {
    return { saved: false, lines: [...lines, `Couldn't save it in ${opts.store.where}: ${without(err instanceof Error ? err.message : String(err), key)}`] };
  }
  return { saved: true, lines: [...lines, `Saved in ${opts.store.where}${check.result === "unchecked" ? " (unchecked)" : ""}.`] };
}

// ── The settings screen's Keys section ─────────────────────────────────────

/** What the Keys section works with: the app's (app.ts), or a test's. */
type KeySettingsDeps = {
  /** The keys in use, by variable (keysInUse): asked again each time the rows are drawn. */
  env: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
  /** Where each key in use came from (config.ts `keys.sources`): kept up to date as keys are saved. */
  sources: Record<string, KeySource>;
  store: KeyStore | null;
  fetch?: KeyFetch;
  timeoutMs?: number;
  /** The app's log (core/log.ts): names and outcomes only, never a key. */
  log: (event: string, data: Record<string, unknown>) => void;
  /** A line on screen (and on a phone): never a key. */
  say: (line: string) => void;
  /** A key saved that's the one to use now (no environment or .env one winning): the app takes it up. True when that needs a restart. */
  use: (info: KeyInfo, key: string) => boolean;
  /** The app restarts once settings close. */
  restart: () => void;
  /** A key saved and taken up now (not one another wins over, and no restart needed): the app says what it brings back (app/key-offer.ts). */
  saved?: (info: KeyInfo) => void;
};

/**
 * Settings → Keys: the rows, and entering, saving and removing keys from them. A key typed is
 * checked with its provider, then saved in the Keychain; one that couldn't be checked is held in
 * memory until you say save it anyway or not (or settings close). Logged by name and outcome only.
 */
export class KeySettings {
  /** The names the Keychain holds (no keys): read at start, kept as you save and remove. */
  keychain = new Set<string>();
  /** A key entered that couldn't be checked: held only here, until "save it anyway" or "don't". */
  private unchecked: { id: KeyId; key: string } | null = null;
  /** The key last entered that its provider turned down (its id), said on its row until another is entered or settings close: the screen covers Kiko's page, where the line went. */
  private refused: KeyId | null = null;

  private d: KeySettingsDeps;

  constructor(deps: KeySettingsDeps) {
    this.d = deps;
  }

  async readNames() {
    if (!this.d.store) return;
    try {
      this.keychain = new Set(await this.d.store.list());
    } catch (err) {
      this.d.log("keychain_failed", { op: "list", error: err instanceof Error ? err.message : String(err) });
    }
  }

  rows(chosen: Chosen): SettingRow[] {
    const env = typeof this.d.env === "function" ? this.d.env() : this.d.env;
    return keyRowsFor({ chosen, env, sources: this.d.sources, keychain: this.keychain, unchecked: this.unchecked?.id ?? null, refused: this.refused, store: Boolean(this.d.store) });
  }

  /** Settings closed: a key that couldn't be checked and wasn't saved is let go. */
  forget() {
    this.unchecked = null;
    this.refused = null;
  }

  /** A key typed into its row, or for an option that needs it (ui/settings.ts): true once it's saved. */
  async enter(id: string, typed: string): Promise<boolean> {
    const info = KEYS.find((k) => k.id === id);
    const key = typed.trim();
    if (!info || !key) return false;
    if (!this.d.store) {
      this.d.say(`(No Keychain here: put ${info.env} in .env instead.)`);
      return false;
    }
    this.unchecked = null;
    this.refused = null;
    this.d.say(`(checking the ${info.name} key…)`);
    const check = await checkKey(info.id, key, this.d);
    this.d.log("key_checked", { key: info.id, result: check.result });
    if (check.result === "works") return this.save(info, key, check);
    if (check.result === "refused") {
      this.refused = info.id;
      this.d.say(`(${check.said.replace(/\.$/, "")}. Nothing saved.)`);
      return false;
    }
    this.unchecked = { id: info.id, key };
    this.d.say(`(${check.said.replace(/\.$/, "")}. Save it anyway? It's under Keys → ${info.name}.)`);
    return false;
  }

  /** A key row's option (keyChoices): save the unchecked one anyway, or don't; remove the Keychain's; leave it. */
  async act(id: string, value: string) {
    const info = KEYS.find((k) => k.id === id);
    if (!info || !this.d.store) return;
    if (value === "save" && this.unchecked?.id === id) {
      const { key } = this.unchecked;
      this.unchecked = null;
      return this.save(info, key, { result: "unchecked", said: "" });
    }
    if (value === "drop") {
      this.unchecked = null;
      return this.d.say(`(${info.name} key not saved.)`);
    }
    if (value !== "remove") return;
    try {
      const removed = await this.d.store.remove(info.env);
      this.keychain.delete(info.env);
      this.d.log("key_removed", { key: info.id, removed });
      const inUse = this.d.sources[info.env] === "Keychain";
      this.d.say(`(${removed ? `${info.name} key removed from the Keychain${inUse ? "; this run keeps using it until the app restarts" : ""}` : `The Keychain had no ${info.name} key`}.)`);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.d.log("key_removed", { key: info.id, removed: false, error: why });
      this.d.say(`(Couldn't remove the ${info.name} key: ${why})`);
    }
  }

  private async save(info: KeyInfo, key: string, check: KeyCheck): Promise<boolean> {
    try {
      await this.d.store!.set(info.env, key);
    } catch (err) {
      const why = without(err instanceof Error ? err.message : String(err), key);
      this.d.log("key_saved", { key: info.id, ok: false, error: why });
      this.d.say(`(Couldn't save the ${info.name} key in the Keychain: ${why})`);
      return false;
    }
    this.keychain.add(info.env);
    const winner = this.d.sources[info.env];
    // One from the environment or .env wins, as at start.
    const shadowed = winner === "environment" || winner === ".env";
    const restart = shadowed ? false : this.d.use(info, key);
    if (!shadowed) this.d.sources[info.env] = "Keychain";
    this.d.log("key_saved", { key: info.id, ok: true, checked: check.result, restart });
    const after = shadowed ? ` The ${winner} one wins while it's there.` : restart ? " It's used once settings close and the app restarts." : "";
    this.d.say(`(${check.result === "works" ? check.said : `${info.name} key unchecked`}: saved in the Keychain.${after})`);
    if (restart) this.d.restart();
    else if (!shadowed) this.d.saved?.(info);
    return true;
  }
}

/** What a key's row carries (its `raw`, as JSON), for its options (settings-options.ts keyChoices). */
export type KeyRow = { set: boolean; source: KeySource | null; inKeychain: boolean; unchecked: boolean; store: boolean };

/**
 * The Keys section's rows (keysShown's keys): where each key comes from, with only its last four
 * characters, and a note when it matters (needed and missing, another one winning, one you entered
 * that couldn't be checked or was turned down). `keychain`: the names the Keychain holds; `unchecked`:
 * the id of a key entered and waiting for "save it anyway"; `refused`: the id of one its provider turned down.
 */
export function keyRowsFor(o: {
  chosen: Chosen;
  env: NodeJS.ProcessEnv;
  sources: Record<string, KeySource>;
  keychain: ReadonlySet<string>;
  unchecked: string | null;
  refused?: string | null;
  store: boolean;
}): SettingRow[] {
  const set = new Set([...KEY_NAMES.filter((name) => o.env[name]), ...o.keychain]);
  return keysShown(o.chosen, set).map((k) => {
    const key = o.env[k.env];
    const source = key ? (o.sources[k.env] ?? "environment") : null;
    const raw: KeyRow = { set: Boolean(key), source, inKeychain: o.keychain.has(k.env), unchecked: o.unchecked === k.id, store: o.store };
    const value = key ? `${masked(key)} · ${source}` : raw.inKeychain ? "In the Keychain, from the next start" : "Not set";
    const row: SettingRow = { key: `key:${k.id}`, label: k.name, raw: JSON.stringify(raw), value, restart: false };
    const needed = neededFor(k.id, o.chosen);
    if (raw.unchecked) row.note = "Couldn't check the key you entered: save it anyway?";
    else if (o.refused === k.id) row.note = `${k.name} turned down the key you entered: nothing saved. Enter another?`;
    else if (key && source !== "Keychain" && raw.inKeychain) row.note = `The ${source} key wins over the Keychain's`;
    else if (!key && needed) row.note = `Needed: ${needed}`;
    return row;
  });
}
