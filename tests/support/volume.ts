// A fake Mac output volume for duck.ts: runs its two scripts (LOWER, RAISE) against numbers here instead of
// osascript, so no test ever changes the real volume. Same answers as the scripts: "<from>,<to>", "muted",
// "no_volume", "too_low", "ours" (still at a level Kiko left it); "restored", "changed,<now>".
import { LOWER, RAISE, type Runner } from "../../src/platform/macos/duck.ts";

export type Mac = {
  /** The output volume, 0–100; null for an output that has none (HDMI). */
  volume: number | null;
  muted: boolean;
  /** The Mac keeps the volume in steps (6.25 on many outputs): what's set reads back rounded. 0: exact. */
  step: number;
  /** Every run, in order: what it answered, when it started and when it ended. */
  runs: Array<{ op: "lower" | "raise"; args: string[]; out: string; started: number; at: number }>;
  /** Makes the next runs fail, as osascript would. */
  fail: Error | null;
  /** How long a run takes (osascript takes 100ms+). */
  delayMs: number;
};

export function fakeMac(init: Partial<Mac> = {}): { mac: Mac; run: Runner } {
  const mac: Mac = { volume: 50, muted: false, step: 0, runs: [], fail: null, delayMs: 0, ...init };
  const set = (v: number) => (mac.volume = mac.step ? Math.round(Math.round(v / mac.step) * mac.step) : Math.round(v));
  const lower = (level: number, ours?: number) => {
    if (mac.muted) return "muted";
    if (mac.volume === null) return "no_volume";
    if (mac.volume === ours) return "ours";
    const from = mac.volume;
    const target = Math.round((from * level) / 100);
    if (target >= from || target < 1) return "too_low"; // as LOWER: never to 0 (macOS mutes there)
    set(target);
    return `${from},${mac.volume}`;
  };
  const raise = (original: number, ours: number, below: boolean) => {
    if (mac.volume === null) return "no_volume";
    if (below ? mac.volume > ours : mac.volume !== ours) return `changed,${mac.volume}`;
    set(original);
    return "restored";
  };
  const run: Runner = async (script, args) => {
    const started = Date.now();
    if (mac.delayMs) await new Promise((r) => setTimeout(r, mac.delayMs));
    if (mac.fail) throw mac.fail;
    let out: string;
    if (script === LOWER) out = lower(Number(args[0]), args.length > 1 ? Number(args[1]) : undefined);
    else if (script === RAISE) out = raise(Number(args[0]), Number(args[1]), args.length > 2);
    else throw new Error("not a duck script");
    mac.runs.push({ op: script === LOWER ? "lower" : "raise", args, out, started, at: Date.now() });
    return out;
  };
  return { mac, run };
}
