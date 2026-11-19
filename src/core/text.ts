// Small helpers for what's shown and said: text on one line, a list of names as a sentence would
// have it, a path with the home folder as ~, and a usage text's two columns.
import { homedir } from "node:os";

/** On one line: runs of white space (line breaks too) as one space, trimmed; past `max` characters, cut there and "…" added. */
export function flat(text: string, max = Infinity) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Text safe to draw: no escape sequences or other control characters (nor the invisible ones that reorder text), one line. */
export const plainText = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, " ");

/** One line of plain text (`plainText`, then `flat`): a command, a name, a question. */
export const plainLine = (text: string) => flat(plainText(text));

/** "a", "a and b", "a, b and c" ("" for none). */
export const andList = (items: readonly string[]) => joined(items, "and");

/** "a", "a or b", "a, b or c" ("" for none). */
export const orList = (items: readonly string[]) => joined(items, "or");

const joined = (items: readonly string[], last: string) => (items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${last} ${items.at(-1)}`);

/** Rows of two columns as lines, the second lined up three spaces after the longest first (a usage text). */
export function columns(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(...rows.map(([first]) => first.length)) + 3;
  return rows.map(([first, second]) => `${first.padEnd(width)}${second}`);
}

/** `path` with the home folder as ~, to show: only the folder itself and what's in it (not /Users/pc2 for a home of /Users/pc). */
export const shortPath = (path: string, home = homedir()) => (home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path);
