// The macOS voice speaking only because Pocket was still downloading (Esc on setup's voice step, or
// the app started before it finished: core/pocket-prep.ts): the download is watched, and once it's
// ready Pocket is started on the side (its server loads the model meanwhile, the macOS voice going
// on), then swapped in while nothing is being said or waiting to be, so no line changes voice
// halfway. Said once on screen. Only when Pocket is what would be picked now (nothing chosen, no
// Cartesia key: keys.ts pickEngines), looked at again when it's ready (a voice chosen meanwhile wins).
// Pocket failing to start: logged, and the macOS voice goes on.
import type { PrepState } from "../core/pocket-prep.ts";

export type SwitchDeps<T> = {
  /** Where the download stands (pocket-prep.ts pocketPrepState). */
  state(): PrepState;
  /** Pocket is what would speak now, by what's chosen and the keys there are. */
  wanted(): boolean;
  /** Pocket, started and ready to speak; throws when it can't start. */
  start(): Promise<T>;
  /** One that started too late to be used (the watch stopped meanwhile). */
  close(engine: T): void;
  /** Something is being said, or waiting to be (speech-lock.ts busy). */
  busy(): boolean;
  /** Speaks with it from the next line on (state.ts usePocket), and says so. */
  use(engine: T): void;
  log(event: string, fields?: Record<string, unknown>): void;
  /** How often the download is looked at, and how often a quiet moment is waited for. */
  everyMs?: number;
  quietMs?: number;
};

/** Watches until it switched or there's nothing to switch to. Returns the stop. */
export function watchPocket<T>(d: SwitchDeps<T>): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const later = (fn: () => void, ms: number) => {
    if (!stopped) timer = setTimeout(fn, ms);
  };
  /** Started, not yet used: closed if the watch stops first. */
  let waiting: T | null = null;
  const swapWhenQuiet = (engine: T) => {
    if (stopped) return d.close(engine);
    waiting = engine;
    if (d.busy()) return later(() => swapWhenQuiet(engine), d.quietMs ?? 200);
    waiting = null;
    d.use(engine);
    d.log("pocket_switched", {});
  };
  const look = () => {
    if (stopped) return;
    const state = d.state();
    if (state === "running") return later(look, d.everyMs ?? 5000);
    if (state !== "ready") return d.log("pocket_switch", { did: "nothing", state });
    if (!d.wanted()) return d.log("pocket_switch", { did: "nothing", why: "another voice" });
    d.start().then(swapWhenQuiet, (err) => d.log("pocket_switch", { did: "failed", message: err instanceof Error ? err.message : String(err) }));
  };
  look();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (waiting !== null) d.close(waiting);
    waiting = null;
  };
}
