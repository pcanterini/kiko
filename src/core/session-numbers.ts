// Numbers for sessions that would go by the same name: two new sessions in one folder are both
// called by it, so the first keeps the plain name ("kiko") and the next opened there while it's
// still open is "kiko 2", then "kiko 3" (sessions.ts sessionName). A number is the app's label
// only, never typed into the session (no /rename), and it sticks: kept for the session's life,
// even once "kiko" closes, and never given to another while its session is open. Kept next to the
// settings file by session ID, so the numbers outlast a restart while the sessions keep running;
// closed sessions are let go of.
import { dirname, join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./json-file.ts";
import { SETTINGS_FILE } from "./settings.ts";

export const NUMBERS_FILE = join(dirname(SETTINGS_FILE), "session-numbers.json");

/** sessionId → the name it shares (as sessions.ts compares names: "kiko", "kiko project") and its number there (1 for the plain one). */
export type Numbers = Record<string, { name: string; number: number }>;

/** A session listed now that goes by its folder: every ID it goes by (its own first), and the name it shares. */
export type Numberable = { ids: string[]; name: string };

// A session one listing misses (its agent's list failing once) is remembered this long, to have its
// number back when it's listed again.
const KEEP_UNLISTED_MS = 60_000;

let numbers: Numbers | null = null;
// When each was last listed (this run only: the file holds no times, so after a restart each counts as listed then).
const seen = new Map<string, number>();

function load(now: number): Numbers {
  if (numbers) return numbers;
  numbers = {};
  // None yet, or a file that can't be read (set aside, never saved over: core/json-file.ts): none.
  const all = readJsonFile(NUMBERS_FILE) ?? {};
  for (const [id, e] of Object.entries(all as Record<string, { name?: unknown; number?: unknown }>)) {
    if (typeof e?.name !== "string" || typeof e.number !== "number" || !Number.isInteger(e.number) || e.number < 1) continue;
    numbers[id] = { name: e.name, number: e.number };
    seen.set(id, now);
  }
  return numbers;
}

/**
 * Numbers the sessions listed now that go by their folder (`open`, in the order listed): one that
 * has a number keeps it; one that has none takes the lowest no other listed with its name holds,
 * so the first in a folder is plain and the next "2", and one opened after the others there closed
 * is plain again. `listed`: the IDs of every session listed now, so one that's listed but has a
 * name of its own now lets its number go at once. One not listed at all is remembered a moment
 * (`KEEP_UNLISTED_MS`): back in the next listing, it has its number again unless a new one took
 * it. Saved when anything changed. Returns each one's number by its own ID.
 */
export function assignNumbers(open: readonly Numberable[], listed: readonly string[] = [], now = Date.now()): Map<string, number> {
  const before = load(now);
  const all = new Set([...listed, ...open.flatMap((o) => o.ids)]);
  for (const o of open) for (const id of o.ids) seen.set(id, now);
  const next: Numbers = {};
  const taken = new Map<string, Set<number>>();
  const out = new Map<string, number>();
  const give = (o: Numberable, number: number) => {
    next[o.ids[0]] = { name: o.name, number };
    out.set(o.ids[0], number);
    taken.set(o.name, (taken.get(o.name) ?? new Set()).add(number));
  };
  const fresh: Numberable[] = [];
  // Those with a number first (by any ID they go by: one opened by the app had its "starting-…" one), so a new one never takes theirs.
  for (const o of open) {
    const had = o.ids.map((id) => before[id]).find(Boolean);
    if (had && !taken.get(o.name)?.has(had.number)) give(o, had.number);
    else fresh.push(o);
  }
  for (const o of fresh) {
    let n = 1;
    while (taken.get(o.name)?.has(n)) n++;
    give(o, n);
  }
  // Not listed just now, but lately (an agent's list failing once): remembered, while no listed one has its number.
  for (const [id, e] of Object.entries(before)) {
    if (all.has(id) || next[id] || now - (seen.get(id) ?? 0) >= KEEP_UNLISTED_MS || taken.get(e.name)?.has(e.number)) continue;
    next[id] = e;
  }
  for (const id of [...seen.keys()]) if (!next[id]) seen.delete(id);
  if (JSON.stringify(sorted(next)) !== JSON.stringify(sorted(before))) save(next);
  numbers = next;
  return out;
}

/** The number a session holds, by any ID it goes by; 0 for none (it isn't called by its folder, or was never listed). */
export function numberOf(ids: readonly string[]): number {
  const all = numbers ?? load(Date.now());
  return ids.map((id) => all[id]?.number).find((n) => n !== undefined) ?? 0;
}

/** Whether another session sharing `name` holds a number of 2 or more: then the plain one is told apart too. */
export function nameNumbered(name: string): boolean {
  const all = numbers ?? load(Date.now());
  return Object.values(all).some((e) => e.name === name && e.number > 1);
}

/** Forgets what's in memory, as a restart does: the next look reads the file again. For the tests. */
export function reloadNumbers() {
  numbers = null;
  seen.clear();
}

const sorted = (all: Numbers) => Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b)));

function save(all: Numbers) {
  try {
    writeJsonAtomic(NUMBERS_FILE, sorted(all));
  } catch {
    // Kept in memory: lost only with a restart.
  }
}
