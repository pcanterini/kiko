// The end of a file an agent writes as it goes (Claude Code's transcript, a Codex rollout): where
// what was said and done last is, without reading what may be megabytes before it; and what's
// appended to it from then on, line by line (`followLines`).
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";

/**
 * The last `bytes` of a file (all of it when it's small), and where the file ended as it was read
 * (`end`: what's appended after is followed from there). "" (and 0) when there's no file. `lines`:
 * from the start of a line (the one cut in half left out). Throws when it can't be read.
 */
export function tailAt(path: string, bytes: number, { lines = false } = {}): { text: string; end: number } {
  if (!existsSync(path)) return { text: "", end: 0 };
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    return { text: lines && length < size ? text.slice(text.indexOf("\n") + 1) : text, end: size };
  } finally {
    closeSync(fd);
  }
}

/**
 * The last `bytes` of a file (all of it when it's small); "" when there's no file. `lines`: from the
 * start of a line (the one cut in half left out). Throws when it can't be read.
 */
export function readTail(path: string, bytes: number, { lines = false } = {}): string {
  return tailAt(path, bytes, { lines }).text;
}

/**
 * Follows what's appended to a file: polls its size every `everyMs` and gives `onLine` each whole
 * line written after `from` (the file's size now, when not given), in order; a line not fully
 * written yet waits for its end. A file written again from scratch (smaller than read so far) is
 * followed from its new end. Stops once `active()` says so, or `onLine` returns false. Returns its
 * stop, or null when there's no file to follow.
 */
export function followLines(path: string, o: { from?: number; everyMs: number; active: () => boolean; onLine: (line: string) => boolean | undefined | void }): (() => void) | null {
  let offset: number;
  try {
    offset = o.from ?? statSync(path).size;
  } catch {
    return null;
  }
  let rest = Buffer.alloc(0); // a line not fully written yet
  const stop = () => clearInterval(timer);
  const timer = setInterval(() => {
    if (!o.active()) return stop();
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }
    if (size < offset) {
      offset = size;
      rest = Buffer.alloc(0);
    }
    if (size === offset) return;
    const chunk = Buffer.alloc(size - offset);
    let read = 0;
    let fd: number | null = null;
    try {
      fd = openSync(path, "r");
      read = readSync(fd, chunk, 0, chunk.length, offset);
    } catch {
      return;
    } finally {
      if (fd !== null) closeSync(fd);
    }
    offset += read;
    let data = Buffer.concat([rest, chunk.subarray(0, read)]);
    for (let nl = data.indexOf(10); nl >= 0; nl = data.indexOf(10)) {
      const line = data.subarray(0, nl).toString("utf8");
      data = data.subarray(nl + 1);
      if (o.onLine(line) === false || !o.active()) return stop();
    }
    rest = Buffer.from(data);
  }, o.everyMs);
  timer.unref();
  return stop;
}
