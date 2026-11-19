import { appendFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { LOG_DIR, running } from "./app-root.ts";
import { appEnv } from "./env.ts";

/**
 * JSONL event log for debugging: logs/<start time>.jsonl, with logs/latest.jsonl pointing at it.
 * Every line has the wall time, ms since start, and an event name. KIKO_LOG_DIR puts
 * it in another folder (the routing eval keeps its own); an installed copy keeps them in
 * ~/.local/state/kiko/logs/ (core/app-root.ts).
 */
const dir = LOG_DIR;
const started = Date.now();
const file = `${new Date(started).toISOString().replace(/[:.]/g, "-")}.jsonl`;
/** This process's log file, by its name in LOG_DIR (core/log-retention.ts never prunes it). */
export const LOG_FILE = file;
/** The log file's mode, set as it's made: yours only, since it has what was said and the tools' inputs. */
const PRIVATE = 0o600;
// A folder made here is yours only too (one already there is left as it is: a checkout's logs/).
mkdirSync(dir, { recursive: true, mode: 0o700 });
// Only the app moves latest.jsonl: scripts and tests that import this mustn't point it away from a running app's log.
if (process.argv[1]?.endsWith("/src/app.ts") || running.program === "app") {
  rmSync(`${dir}/latest.jsonl`, { force: true });
  symlinkSync(file, `${dir}/latest.jsonl`);
}

/** Lines that couldn't be written (said once, on stderr: see `log`). */
let lost = 0;

/**
 * One line in the log. It never throws (a full disk, the folder deleted, a value JSON can't take):
 * logging is called from everywhere, and a throw here once took the app down with it. A deleted folder is made again; a line that still can't be
 * written is counted, and the first such is said on stderr, once, rather than lost without a word.
 */
export function log(event: string, data: Record<string, unknown> = {}) {
  const path = `${dir}/${file}`;
  try {
    const line = `${JSON.stringify({ t: new Date().toISOString(), ms: Date.now() - started, event, ...data })}\n`;
    try {
      appendFileSync(path, line, { mode: PRIVATE });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      appendFileSync(path, line, { mode: PRIVATE });
    }
  } catch (err) {
    if (lost++ === 0) process.stderr.write(`The log couldn't be written (${err instanceof Error ? err.message : String(err)}): ${path}. Lines are missing from it from here.\n`);
  }
}

const rate = (name: string, fallback: number) => Number(appEnv(name) ?? fallback);

// USD. Override in .env (KIKO_PRICE_…) when prices or plans change.
export const prices = {
  // Claude Haiku 5.5, per million tokens (prompts up to 100K tokens).
  haikuInput: rate("PRICE_HAIKU_INPUT", 0.1),
  haikuOutput: rate("PRICE_HAIKU_OUTPUT", 0.5),
  haikuCacheRead: rate("PRICE_HAIKU_CACHE_READ", 0.01),
  haikuCacheWrite: rate("PRICE_HAIKU_CACHE_WRITE", 0.125),
  // Deepgram Nova-3 streaming, per minute of audio (promo rate; list price 0.0077).
  deepgramMinute: rate("PRICE_DEEPGRAM_MINUTE", 0.0048),
  // Its keyterm prompting add-on (the speech hints), per minute of audio sent with keyterms.
  deepgramKeytermMinute: rate("PRICE_DEEPGRAM_KEYTERM_MINUTE", 0.0013),
  // Cartesia Sonic, per million characters (Pro plan; overage 65).
  cartesiaMillionChars: rate("PRICE_CARTESIA_MILLION_CHARS", 50),
};

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

export const cost = {
  haiku: (u: TokenUsage) =>
    (u.input_tokens * prices.haikuInput +
      u.output_tokens * prices.haikuOutput +
      (u.cache_read_input_tokens ?? 0) * prices.haikuCacheRead +
      (u.cache_creation_input_tokens ?? 0) * prices.haikuCacheWrite) /
    1e6,
  deepgram: (audioSeconds: number, keyterms = false) => (audioSeconds / 60) * (prices.deepgramMinute + (keyterms ? prices.deepgramKeytermMinute : 0)),
  cartesia: (chars: number) => (chars / 1e6) * prices.cartesiaMillionChars,
};

/** Running totals per service for the session. */
export const totals = { llm: 0, classifier: 0, deepgram: 0, cartesia: 0, turns: 0 };

export const usd = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}`;

/** The line at quit: the turns, and what each service cost while `dollars` are shown (core/dollars.ts). */
export function sessionSummary(dollars: boolean) {
  const all = totals.llm + totals.classifier + totals.deepgram + totals.cartesia;
  if (!dollars) return `session: ${totals.turns} turns`;
  return (
    `session: ${totals.turns} turns · LLM ${usd(totals.llm)} · Classifier ${usd(totals.classifier)} · Deepgram ${usd(totals.deepgram)} · ` + `Cartesia ${usd(totals.cartesia)} · total ${usd(all)}`
  );
}
