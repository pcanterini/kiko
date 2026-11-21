// `kiko keys` (src/cli.ts runs it): the API keys, where each comes from, and entering or taking
// one out of the Keychain.
//   kiko keys                 each key: set or not, where from (the environment, .env, the
//                                Keychain), its last four characters only, and whether what you've
//                                chosen needs it; signed in to a Kiko account (accounts open), its
//                                line too: who, and the plan as last known ("free trial, 4 days left")
//   kiko keys set <name>      asks for the key, hidden (or reads one line piped in), checks it
//                                with its provider, and saves it in the Keychain
//   kiko keys remove <name>   takes it out of the Keychain, after asking
// <name>: openrouter, anthropic, deepgram, cartesia (or the variable's name). Like the rest of
// cli.ts, nothing here loads .env into the environment or writes logs: the repo's .env is only
// read to say which keys it has. A key is never printed, logged or put in a program's arguments.
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { ENV_FILE, INSTALLED } from "./core/app-root.ts";
import { SETTING_ENV } from "./core/env.ts";
import { columns } from "./core/text.ts";
import { aiUseFor, enterKey, KEY_NAMES, keyNamed, KEYS, masked, neededFor, pickEngines, type Chosen, type KeyFetch, type KeyId, type KeyInfo } from "./core/keys.ts";
import { OPENROUTER_HAIKU } from "./core/openrouter-llm.ts";
import { COMMAND, ENV_PREFIX, NAME } from "./core/name.ts";
import { loadSettings } from "./core/settings.ts";
import type { AccountView } from "./core/account/account.ts";
import { planBrief, planNoteLines, planRunsAi } from "./core/account/plan-words.ts";
import { type AiUse, keysDetail, keysInUseFor, keyUse, planUsed } from "./core/account/key-words.ts";
import type { KeyStore } from "./platform/types.ts";
import { PLAIN, styleFor, type Style } from "./ui/cli-style.ts";

/** What `kiko keys` works with: the real ones (realDeps), or a test's. */
export type KeysDeps = {
  env: NodeJS.ProcessEnv;
  /** The keys in the repo's .env (only Kiko's key names), as the app would load them. */
  dotenv: Record<string, string>;
  store: KeyStore | null;
  /** What's chosen; the rest is decided by the keys there are, as config.ts does. */
  chosen: Partial<Chosen>;
  /** The quick checks (the classifier) are on in Settings; absent: on, the default. */
  classifier?: boolean;
  /** A line of output. */
  out: (line: string) => void;
  /** The key, asked for without showing it; null when there's no terminal to ask in. */
  askKey: (question: string) => Promise<string | null>;
  /** y/N; false without a terminal. */
  confirm: (question: string) => Promise<boolean>;
  fetch?: KeyFetch;
  /** How lines are styled (ui/cli-style.ts): stdout's; PLAIN when not given. */
  style?: Style;
  /** This Mac's Kiko account as last known (account.json, nothing asked): null or absent while accounts aren't open. */
  account?: AccountView | null;
  now?: () => number;
};

const USAGE = [
  ...columns([
    [`${COMMAND} keys`, "the keys, and where each comes from"],
    [`${COMMAND} keys set <name>`, "enter one: checked, then kept in the Keychain"],
    [`${COMMAND} keys remove <name>`, "take one out of the Keychain"],
  ]),
  `<name>: ${KEYS.map((k) => k.id).join(", ")}`,
].join("\n");

/** Where a key comes from for the app, by precedence: the environment, then .env, then the Keychain. */
function sourceOf(name: string, d: KeysDeps, inKeychain: ReadonlySet<string>): "environment" | ".env" | "Keychain" | null {
  if (d.env[name]) return "environment";
  if (d.dotenv[name]) return ".env";
  return inKeychain.has(name) ? "Keychain" : null;
}

async function list(d: KeysDeps): Promise<number> {
  const s = d.style ?? PLAIN;
  let inKeychain = new Set<string>();
  let keychainError = "";
  if (d.store) {
    try {
      inKeychain = new Set(await d.store.list());
    } catch (err) {
      keychainError = err instanceof Error ? err.message : String(err);
    }
  }
  // The Keychain's keys read only for those it gives the app (to show their last four characters).
  const fromKeychain = KEY_NAMES.filter((name) => sourceOf(name, d, inKeychain) === "Keychain");
  let kept: Record<string, string> = {};
  try {
    kept = d.store && fromKeychain.length ? d.store.get(fromKeychain) : {};
  } catch (err) {
    keychainError ||= err instanceof Error ? err.message : String(err);
  }
  // Nothing chosen: the default by the keys there are (keys.ts pickEngines), the one-key setup with none.
  const set = Object.fromEntries(KEY_NAMES.filter((name) => sourceOf(name, d, inKeychain)).map((name) => [name, "set"]));
  const defaults = pickEngines({}, set, true);
  const chosen: Chosen = { stt: d.chosen.stt ?? defaults.stt, tts: d.chosen.tts ?? defaults.tts, llm: d.chosen.llm ?? defaults.llm ?? OPENROUTER_HAIKU };
  const signedIn = d.account?.state === "signed-in" ? d.account : null;
  const now = d.now?.() ?? Date.now();
  // A plan running on the account runs OpenRouter's models with no key (core/model-route.ts): not "needed" then.
  const planRuns = Boolean(signedIn && planRunsAi(signedIn.plan, now));
  // What each key does now, and what runs on what (core/account/key-words.ts), as the app decides it.
  const use = aiUseFor(d.chosen, set, { planRuns, classifier: d.classifier !== false });
  for (const k of KEYS) {
    const source = sourceOf(k.env, d, inKeychain);
    const key = source === "environment" ? d.env[k.env] : source === ".env" ? d.dotenv[k.env] : source === "Keychain" ? kept[k.env] : undefined;
    const shown = source ? `${key ? masked(key) : "set"} · ${source}` : "not set";
    const needed = k.id === "openrouter" && planRuns ? null : neededFor(k.id, chosen);
    // Padded first, then styled: the escape codes take no columns.
    const where = source ? shown.padEnd(22) : s.dim(shown.padEnd(22));
    d.out(`${s.bold(k.id.padEnd(11))} ${where} ${k.what}${!source && needed ? ` ${s.yellow(`(needed: ${needed})`)}` : ""}`);
    const doing = keyUse(use, k.id as KeyId);
    if (doing) d.out(s.dim(`${"".padEnd(11)} ${doing}`));
    if (source && source !== "Keychain" && inKeychain.has(k.env)) d.out(s.dim(`${"".padEnd(11)} also in the Keychain; the ${source} one wins`));
  }
  if (signedIn) {
    // The plan runs all of the AI there is: said beside it. Your own keys in use too: which one pays, under it.
    const runs = planUsed(use) && !keysInUseFor(use).length ? s.dim(" (runs the AI: no OpenRouter key needed)") : "";
    d.out(`${s.bold(`${NAME} account:`)} ${signedIn.email ?? "signed in"} · ${planBrief(signedIn.plan, signedIn.trial, now, { use })}${runs}`);
    const note = planNoteLines(signedIn.plan, signedIn.trial, use, now).join(" ");
    if (note) d.out(s.dim(`${"".padEnd(11)} ${note}`));
  } else if (d.account?.state === "signed-out" && d.account.revoked) d.out(s.dim(`${NAME} account: signed out on its server (${COMMAND} login signs in again)`));
  d.out(s.dim(`What runs on what: ${keysDetail(use, planWho(signedIn, now)).join("; ")}.`));
  if (!d.store) d.out(s.warn(`No Keychain here (${ENV_PREFIX}KEYCHAIN is off, or this isn't a Mac): keys come from the environment and .env.`));
  else if (keychainError) d.out(s.warn(`The Keychain couldn't be read: ${keychainError}`));
  d.out(s.dim(`${COMMAND} keys set <name> enters one; ${COMMAND} keys remove <name> takes one out of the Keychain.`));
  return 0;
}

/** The plan's name in a sentence, for what it runs: "Kiko Pro", "the free trial", or "the plan". */
function planWho(account: AccountView | null, now: number): string {
  if (account?.state !== "signed-in" || !planRunsAi(account.plan, now)) return "the plan";
  return account.plan?.name === "pro" ? `${NAME} Pro` : "the free trial";
}

async function set(info: KeyInfo, d: KeysDeps): Promise<number> {
  if (!d.store) return fail(d, `there's no Keychain here (${ENV_PREFIX}KEYCHAIN is off, or this isn't a Mac): put ${info.env} in .env instead`);
  const s = d.style ?? PLAIN;
  d.out(`${s.bold(info.name)}: ${info.what}.`);
  const key = await d.askKey(`Your ${info.name} key ${s.dim("(hidden; Enter when done)")}: `);
  if (key === null) return fail(d, "no key given: run it in a terminal, or pipe the key in");
  const entered = await enterKey(info, key, {
    store: d.store,
    fetch: d.fetch,
    anyway: () => d.confirm("Save it anyway?"),
  });
  // The check's own ✓ or ✗ coloured; "Saved in …" a ✓, a save that failed an X.
  entered.lines.forEach((line, i) => {
    const last = i === entered.lines.length - 1;
    d.out(last && entered.saved ? s.ok(line) : /^Couldn't save it/.test(line) ? s.error(line) : s.marked(line));
  });
  if (!entered.saved) return 1;
  const winner = d.env[info.env] ? "environment" : d.dotenv[info.env] ? ".env" : null;
  if (winner) d.out(s.warn(`Your ${winner} has ${info.env} too: that one wins until you take it out.`));
  else d.out(s.dim(`A ${NAME} that's running uses it from its next start.`));
  return 0;
}

async function remove(info: KeyInfo, d: KeysDeps): Promise<number> {
  if (!d.store) return fail(d, `there's no Keychain here (${ENV_PREFIX}KEYCHAIN is off, or this isn't a Mac)`);
  if (!(await d.confirm(`Remove the ${info.name} key from the Keychain?`))) return (d.out("Nothing changed."), 0);
  let removed: boolean;
  try {
    removed = await d.store.remove(info.env);
  } catch (err) {
    return fail(d, `couldn't remove it: ${err instanceof Error ? err.message : String(err)}`);
  }
  const s = d.style ?? PLAIN;
  d.out(removed ? s.ok(`Removed the ${info.name} key from the Keychain.`) : `The Keychain had no ${info.name} key.`);
  const left = d.env[info.env] ? "environment" : d.dotenv[info.env] ? ".env" : null;
  if (left) d.out(s.dim(`(The one in your ${left} is still there, and still used.)`));
  return 0;
}

function fail(d: KeysDeps, why: string) {
  d.out((d.style ?? PLAIN).error(`${COMMAND}: ${why}`));
  return 1;
}

/** `kiko keys [list | set <name> | remove <name>]`. Returns the exit code. */
export async function keysCommand(args: readonly string[], d: KeysDeps): Promise<number> {
  const [op = "list", word] = args;
  if (op === "list" || op === "ls") return word === undefined ? list(d) : fail(d, `keys list takes no name\n${USAGE}`);
  if (op !== "set" && op !== "remove" && op !== "rm") return fail(d, `keys ${op}? It's one of:\n${USAGE}`);
  if (word === undefined) return fail(d, `keys ${op} which? ${KEYS.map((k) => k.id).join(", ")}`);
  const info = keyNamed(word);
  if (!info) return fail(d, `no key called ${word}: ${KEYS.map((k) => k.id).join(", ")}`);
  return op === "set" ? set(info, d) : remove(info, d);
}

// ── The real ones ──────────────────────────────────────────────────────────

const ENGINES = ["stt", "tts", "llm"] as const;
/** The names that choose an engine or the model: KIKO_STT, and in a checkout STT too (core/env.ts). */
const engineNames = (setting: (typeof ENGINES)[number]) => [`${ENV_PREFIX}${SETTING_ENV[setting].env}`, ...(INSTALLED ? [] : [SETTING_ENV[setting].env])];

/**
 * What the repo's .env (the one the app loads: core/app-root.ts ENV_FILE) says of the keys and of the engines and model (which
 * decide the keys needed); the rest of it isn't kept, and nothing goes into the environment. An
 * installed copy reads none.
 */
function readDotenv(): Record<string, string> {
  if (!ENV_FILE || !existsSync(ENV_FILE)) return {};
  try {
    const all = parseEnv(readFileSync(ENV_FILE, "utf8"));
    return Object.fromEntries([...KEY_NAMES, ...ENGINES.flatMap(engineNames)].flatMap((name) => (all[name] ? [[name, all[name]!]] : [])));
  } catch {
    return {};
  }
}

/** A key typed without being shown (raw mode, nothing echoed), or one line piped in. */
async function askKey(question: string): Promise<string | null> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let text = "";
    for await (const chunk of stdin) text += chunk;
    return text.split(/\r?\n/)[0] || null;
  }
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve) => {
    let text = "";
    const done = (value: string | null) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done(text);
        if (ch === "\u0003" || ch === "\u001b") return done(""); // Ctrl+C, Esc: nothing entered
        if (ch === "\u007f" || ch === "\b") text = text.slice(0, -1);
        else if (ch > " " && ch <= "~") text += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(styleFor(process.stdout).question(question), resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/** This Mac's account as last known (account.json), while accounts are open: nothing asked of the server. */
async function accountView(store: KeyStore | null): Promise<AccountView | null> {
  const { accountsLive, accountUrl } = await import("./core/env.ts");
  if (!accountsLive()) return null;
  const [{ Account }, { accountClient }] = await Promise.all([import("./core/account/account.ts"), import("./core/account/client.ts")]);
  return new Account({ store, client: accountClient(accountUrl()) }).view();
}

/** What's chosen, as config.ts decides it: KIKO_STT (or, in a checkout, STT: core/env.ts) from the environment or else .env, then the settings. */
function chosenHere(dotenv: Record<string, string>, saved = loadSettings()): Partial<Chosen> {
  const pick = (setting: (typeof ENGINES)[number]) =>
    engineNames(setting)
      .map((name) => process.env[name] ?? dotenv[name])
      .find((value) => value !== undefined);
  return { stt: pick("stt") ?? saved.stt, tts: pick("tts") ?? saved.tts, llm: pick("llm") ?? saved.llm };
}

/**
 * What Kiko's AI runs on here (core/account/key-words.ts), for `kiko account`, given whether the
 * plan runs it: the keys set where the app takes them from (the environment, the repo's .env, the
 * Keychain: only listed, never read), what's chosen, and the quick checks' setting.
 */
export async function aiUseHere(store: KeyStore | null): Promise<(planRuns: boolean) => AiUse> {
  const saved = loadSettings();
  const dotenv = readDotenv();
  const inKeychain = new Set(store ? await store.list().catch(() => [] as string[]) : []);
  const set = Object.fromEntries(KEY_NAMES.filter((name) => process.env[name] || dotenv[name] || inKeychain.has(name)).map((name) => [name, "set"]));
  const chosen = chosenHere(dotenv, saved);
  return (planRuns) => aiUseFor(chosen, set, { planRuns, classifier: saved.classifier !== false });
}

export async function realDeps(): Promise<KeysDeps> {
  const { keyStore } = await import("./platform/keys.ts");
  const saved = loadSettings();
  const dotenv = readDotenv();
  return {
    env: process.env,
    dotenv: Object.fromEntries(KEY_NAMES.flatMap((name) => (dotenv[name] ? [[name, dotenv[name]]] : []))),
    store: keyStore,
    // As config.ts decides them: the environment (and .env), then the settings; the defaults in list().
    chosen: chosenHere(dotenv, saved),
    classifier: saved.classifier !== false,
    out: (line) => console.log(line),
    askKey,
    confirm,
    style: styleFor(process.stdout),
    account: await accountView(keyStore).catch(() => null),
  };
}
