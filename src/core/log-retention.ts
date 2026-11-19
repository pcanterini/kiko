// How long Kiko keeps its logs (Settings → Logs → Keep logs): 7, 30 or 90 days, or forever. The
// logs (core/log.ts) hold what you said, what Kiko said and typed into sessions, and permission
// requests, so they don't pile up for ever by default: 30 days for a release, enough to look back
// at a bug a few weeks on. A development checkout keeps its repo's logs/ forever unless set: they
// are the developer's record for debugging (read for real phrasing, cited by tests).
//
// Pruning is narrow on purpose. In the logs folder only, it deletes files named the way log.ts names
// a run's log (<start time>.jsonl) that are plain files (never a link, never followed out of the
// folder) last written more than the window ago: by when they were last written, so a run still
// going keeps its file however long ago it started. Never this run's file, nor the one latest.jsonl
// points at. Nothing else in the folder is touched, and a missing folder is nothing to do.
// Imports nothing that writes logs (the app passes its `log`), so the settings screen can import it.
import { lstatSync, readdirSync, readlinkSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DEV } from "./name.ts";

/** Days to keep logs; 0 is forever. */
export type KeepLogs = 7 | 30 | 90 | 0;
const KEEP_LOGS_VALUES: readonly KeepLogs[] = [7, 30, 90, 0];
/** The default: 30 days for a release; forever in a development checkout (see above). */
export const keepLogsDefault = (dev = DEV): KeepLogs => (dev ? 0 : 30);
const KEEP_LOGS_DEFAULT: KeepLogs = keepLogsDefault();

/** A saved Keep logs; anything else (unset, a typo) is `fallback`. */
export const keepLogsOf = (value: unknown, fallback: KeepLogs = KEEP_LOGS_DEFAULT): KeepLogs => (KEEP_LOGS_VALUES.includes(value as KeepLogs) ? (value as KeepLogs) : fallback);

/** How a Keep logs reads: "30 days", "Forever". */
export const keepLogsWords = (days: KeepLogs) => (days === 0 ? "Forever" : `${days} days`);

/** A run's log, as log.ts names it: its start time, ISO with : and . made -, then .jsonl. */
export const LOG_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.jsonl$/;
/** The link log.ts points at the app's current log. */
const LATEST = "latest.jsonl";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The run logs in `dir`: plain files with a log's name (never links, nor anything else). None when the folder's missing. */
function logFiles(dir: string): Array<{ name: string; size: number; mtimeMs: number }> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: Array<{ name: string; size: number; mtimeMs: number }> = [];
  for (const name of names) {
    if (!LOG_NAME.test(name)) continue;
    try {
      const st = lstatSync(join(dir, name));
      if (st.isFile()) files.push({ name, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // Gone meanwhile.
    }
  }
  return files;
}

/** The file latest.jsonl points at, by its name, when it points at one in `dir`; null otherwise. */
function latestTarget(dir: string): string | null {
  try {
    const target = readlinkSync(join(dir, LATEST));
    const path = resolve(dir, target);
    return dirname(path) === resolve(dir) ? basename(path) : null;
  } catch {
    return null;
  }
}

/** What the logs folder holds now: how many run logs and their bytes. */
export function logsSize(dir: string): { files: number; bytes: number } {
  const files = logFiles(dir);
  return { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) };
}

export type Pruned = { count: number; bytes: number };

/**
 * Deletes the run logs in `dir` last written more than `days` ago (0: none, forever). `keep`: file
 * names never deleted (this run's). Returns how many went and their bytes; a file that can't be
 * deleted is left and not counted.
 */
export function pruneLogs(opts: { dir: string; days: KeepLogs; keep?: string[]; now?: number }): Pruned {
  const { dir, days, keep = [], now = Date.now() } = opts;
  const pruned: Pruned = { count: 0, bytes: 0 };
  if (!days) return pruned;
  try {
    if (!statSync(dir).isDirectory()) return pruned;
  } catch {
    return pruned;
  }
  const spared = new Set([...keep, LATEST]);
  const latest = latestTarget(dir);
  if (latest) spared.add(latest);
  const before = now - days * DAY_MS;
  for (const f of logFiles(dir)) {
    if (spared.has(f.name) || f.mtimeMs >= before) continue;
    try {
      unlinkSync(join(dir, f.name));
      pruned.count++;
      pruned.bytes += f.size;
    } catch {
      // Not ours to force: left for next time.
    }
  }
  return pruned;
}

/** "42 MB", "980 KB", "12 bytes". */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * Prunes at once, then once a day while the app runs (the timer never holds it open). `days` is
 * read each time, so a change in settings applies from the next prune (the settings screen also
 * calls `now()` when it changes). `logPruned` hears what went, only when something did: the count
 * and bytes, never a name.
 */
export function startLogPruning(opts: { dir: string; days: () => KeepLogs; keep: () => string[]; logPruned: (p: Pruned) => void; everyMs?: number }): { now: () => Pruned; stop: () => void } {
  const run = (): Pruned => {
    let p: Pruned = { count: 0, bytes: 0 };
    try {
      p = pruneLogs({ dir: opts.dir, days: opts.days(), keep: opts.keep() });
    } catch {
      // Never in the way of the app.
    }
    if (p.count) opts.logPruned(p);
    return p;
  };
  run();
  const timer = setInterval(run, opts.everyMs ?? DAY_MS);
  timer.unref?.();
  return { now: run, stop: () => clearInterval(timer) };
}
