// The config and state files (settings.json and the files kept beside it: the dictionary, the
// sayings, session numbers and names, quick checks' commands, the account's, the phones'), written
// whole or not at all, and read without taking a broken one for an empty one. Before 2026-11-12 each was written in place, and read as
// empty when it didn't parse: a crash mid-write, or a reader catching a half-written file, then
// saved that emptiness over everything (the talk key, the voice, the terms).
// - `writeFileAtomic`: a temp file beside it, synced to disk, then renamed over it in one step: a
//   reader finds the old file or the new one, never half of one.
// - `readJsonFile`: a file that can't be read or parsed is set aside as `<file>.corrupt-<time>`
//   first, and reads as none, so the caller goes on with its defaults and its next save starts a new
//   file. One that can't be set aside is never written over (`writeFileAtomic` refuses it).
// Each set aside is told to whoever listens (`onSetAside`: the app logs it and says it in a line,
// the CLI says it on stderr), and kept until someone does.
// Imports nothing that loads .env, reads settings or writes logs, so anything can import it.
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isObject } from "./is-object.ts";

/**
 * A file that couldn't be read, why (empty: not known, as for one another process set aside), and
 * where it was moved (null: it couldn't be, so it's left as it is, never written over).
 */
export type SetAside = { file: string; aside: string | null; why: string };

/** Files that couldn't be read nor set aside, by path: `writeFileAtomic` won't write over them. */
const unsafe = new Set<string>();

/**
 * `text` as `file`'s whole content, in one step: written to a temp file in the same folder, synced to
 * disk, then renamed over the old one (which stays as it was if anything fails before). The mode is
 * `mode`, else the old file's, else the usual (0666 less the umask). `write`: the tests' stand-in.
 */
export function writeFileAtomic(file: string, text: string, o: { mode?: number; write?: (fd: number, text: string) => void } = {}) {
  if (unsafe.has(file)) throw new Error(`${file} couldn't be read or set aside, so it isn't written over: move it away to start it afresh`);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const mode = o.mode ?? modeOf(file) ?? 0o666;
  // A name of its own (two processes may save at once), made new ("wx": never a file or link that's there).
  const temp = join(dir, `.${basename(file)}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  let fd: number | null = openSync(temp, "wx", mode);
  try {
    (o.write ?? ((at, t) => writeFileSync(at, t)))(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, file);
  } catch (err) {
    if (fd !== null) closeSync(fd);
    rmSync(temp, { force: true });
    throw err;
  }
}

/**
 * `value` as JSON (two-space indented unless `compact`, a newline at the end), atomically. What's
 * there and isn't JSON is set aside first, even when it was never read here.
 */
export function writeJsonAtomic(file: string, value: unknown, o: { mode?: number; compact?: boolean } = {}) {
  readJsonFile(file, () => true);
  writeFileAtomic(file, `${o.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`, { mode: o.mode });
}

function modeOf(file: string): number | undefined {
  try {
    return statSync(file).mode & 0o777;
  } catch {
    return undefined; // none yet
  }
}

/**
 * The JSON in `file`, or undefined when there's no file. One that can't be read, doesn't parse, or
 * isn't what `valid` takes (an object, unless said) is set aside first (`setAside`) and reads as
 * undefined too: the caller's defaults.
 */
export function readJsonFile(file: string, valid: (v: unknown) => boolean = isObject): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return setAside(file, `it couldn't be opened: ${(err as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return setAside(file, text.trim() ? "it isn't valid JSON" : "it's empty");
  }
  if (!valid(value)) return setAside(file, "it doesn't hold what it should");
  unsafe.delete(file);
  return value;
}

/** When a file is set aside, to the millisecond, as a file name can have it (as logs/ names are). */
const stamp = (at: Date) => at.toISOString().replace(/[:.]/g, "-");

/**
 * `file` moved to `<file>.corrupt-<time>`, beside it, and told. Gone already (another process set
 * it aside first): nothing to do. One that can't be moved stays as it is, marked never to be
 * written over.
 */
function setAside(file: string, why: string): undefined {
  const aside = `${file}.corrupt-${stamp(new Date())}`;
  try {
    renameSync(file, aside);
    unsafe.delete(file);
    tell({ file, aside, why });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // Told once, not on every read of it.
    if (unsafe.has(file)) return undefined;
    unsafe.add(file);
    tell({ file, aside: null, why: `${why}, and it couldn't be moved: ${(err as Error).message}` });
  }
  return undefined;
}

const waiting: SetAside[] = [];
let listener: ((s: SetAside) => void) | null = null;

function tell(s: SetAside) {
  if (listener) listener(s);
  else waiting.push(s);
}

/** `f` is told each file set aside from now, and those set aside before it listened. Returns the way to stop. */
export function onSetAside(f: (s: SetAside) => void): () => void {
  listener = f;
  for (const s of waiting.splice(0)) f(s);
  return () => {
    if (listener === f) listener = null;
  };
}

/** What's said of one, in one plain line. */
export function setAsideLine(s: SetAside): string {
  const what = `${basename(s.file)} couldn't be read${s.why ? ` (${s.why})` : ""}`;
  if (!s.aside) return `${what}, so it's left as it is, not saved over, and the defaults are used.`;
  return `${what}, so it was moved to ${basename(s.aside)} and the defaults are used.`;
}

const ASIDE = /^(.+)\.corrupt-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)$/;

/**
 * The files set aside in `dir` since `since` (ms epoch), by their names: those another process set
 * aside (`kiko` reads the settings before it starts the app), for the app to say too.
 */
export function setAsideSince(dir: string, since: number): SetAside[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // no folder: nothing set aside in it
  }
  return names.flatMap((name) => {
    const m = ASIDE.exec(name);
    if (!m) return [];
    const [day, time] = m[2].split("T");
    const at = Date.parse(`${day}T${time.replace(/^(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, "$1:$2:$3.$4Z")}`);
    return at >= since ? [{ file: join(dir, m[1]), aside: join(dir, name), why: "" }] : [];
  });
}

/** For the tests: as if nothing had been set aside or listened for. */
export function resetSetAside() {
  unsafe.clear();
  waiting.length = 0;
  listener = null;
}
