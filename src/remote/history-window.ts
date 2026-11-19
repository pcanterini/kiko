// What a session's screen on the phone is sent of its conversation (server.ts watch, history_before,
// show_full), worked out apart from the socket so it can be tested.
//
// A phone that pages (watch `paged`, to a hub whose welcome says `paging`) gets a window: the newest
// turns that fit its budget (30 turns or 64 KB, whichever is smaller, starting at your words where
// it can), each item with its id, long outputs, diffs and messages cut to a preview (`cut`: Show full
// fetches the rest, show_full → full_text). Then only what changed (history_delta: the items after
// the last one still the same), and earlier pages before a cursor (an item's id) as it scrolls up.
// An older phone gets the whole history as before, without ids, capped so it can't pull megabytes.
import type { HistoryItem, Step } from "../core/history.ts";

/** A window or page: how many turns and bytes at most (the phone may ask for less, never for more than the caps). */
export type Budget = { turns: number; bytes: number };
export const BUDGET: Budget = { turns: 30, bytes: 64 * 1024 };
export const BUDGET_CAPS = { turns: { min: 1, max: 100 }, bytes: { min: 8 * 1024, max: 256 * 1024 } };

/** What a paged phone is sent of each item, before Show full: protocol/README.md says the same. */
export const PREVIEW = { text: 2000, detail: 600, detailLines: 8, diff: 2000, diffLines: 30 };

/** The most a history or page to an older phone carries: older items go first (it's sent whole, up to twice a second). */
export const LEGACY_BYTES = 128 * 1024;

/** A phone's budget, as it asked (within the caps), else the hub's. */
export function budgetOf(asked: { turns?: number; bytes?: number }): Budget {
  const within = (n: number | undefined, fallback: number, c: { min: number; max: number }) => (Number.isInteger(n) ? Math.min(c.max, Math.max(c.min, n as number)) : fallback);
  return { turns: within(asked.turns, BUDGET.turns, BUDGET_CAPS.turns), bytes: within(asked.bytes, BUDGET.bytes, BUDGET_CAPS.bytes) };
}

/** An item's size as it goes over the socket (its JSON, UTF-8). */
export const sizeOf = (item: HistoryItem) => Buffer.byteLength(JSON.stringify(item));

/** Cut to `max` characters with "…"; and whether it was. */
function shorten(text: string, max: number): [string, boolean] {
  return text.length > max ? [`${text.slice(0, max - 1)}…`, true] : [text, false];
}

/** Lines of text: the first `lines` within `chars`, then "… N more lines"; and whether any were left out. */
function firstLines(text: string, lines: number, chars: number): [string, boolean] {
  const all = text.split("\n");
  // The record's own cut ("… 88 more lines", last): those lines count as more too.
  const said = /^… (\d+) more lines?$/.exec(all.at(-1) ?? "");
  const body = said ? all.slice(0, -1) : all;
  const kept: string[] = [];
  let size = 0;
  let long = false;
  for (const line of body) {
    if (kept.length >= lines || (kept.length && size + line.length + 1 > chars)) break;
    const [l, cut] = shorten(line, chars);
    long ||= cut;
    kept.push(l);
    size += l.length + 1;
  }
  if (kept.length === body.length) return long ? [[...kept, ...(said ? [all.at(-1)] : [])].join("\n"), true] : [text, false];
  const more = body.length - kept.length + Number(said?.[1] ?? 0);
  return [`${kept.join("\n")}\n… ${more} more ${more === 1 ? "line" : "lines"}`, true];
}

/** An item as a paged phone first gets it: messages, outputs and diffs cut to PREVIEW, `cut` where anything was. */
export function preview(item: HistoryItem): HistoryItem {
  if (item.kind !== "steps") {
    const [text, cut] = shorten(item.text, PREVIEW.text);
    return cut ? { ...item, text, cut: true } : item;
  }
  let changed = false;
  const steps = item.steps.map((s): Step => {
    const [detail, cutDetail] = s.added !== undefined ? [s.detail, false] : firstLines(s.detail, PREVIEW.detailLines, PREVIEW.detail);
    const [diff, cutDiff] = s.diff !== undefined ? firstLines(s.diff, PREVIEW.diffLines, PREVIEW.diff) : [undefined, false];
    if (!cutDetail && !cutDiff) return s;
    changed = true;
    return { ...s, detail, ...(diff !== undefined ? { diff } : {}), cut: true };
  });
  return changed ? { ...item, steps } : item;
}

/** Ids for items an agent gave none (no file of its own: T3 Code): their time, kind and how many before them had the same. */
export function withIds(items: HistoryItem[]): HistoryItem[] {
  if (items.every((i) => i.id)) return items;
  const seen = new Map<string, number>();
  return items.map((i) => {
    if (i.id) return i;
    const key = `${i.at ?? "-"}|${i.kind}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return { ...i, id: `t:${key}|${n}` };
  });
}

/** Your words that start a turn (the first of them in a row). */
const startsTurn = (items: HistoryItem[], i: number) => items[i].kind === "you" && (i === 0 || items[i - 1].kind !== "you");

/**
 * Where a window of `items` (oldest first) starts: the newest that fit the budget, at least one.
 * Started part way through a turn, it starts at the next turn instead when there is one in it (a
 * turn whole, your words with what came of them); the newest turn alone too big starts where it fits.
 */
export function windowStart(items: HistoryItem[], budget: Budget, size: (item: HistoryItem) => number = sizeOf): number {
  let start = items.length;
  let bytes = 0;
  let turns = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (turns >= budget.turns) break;
    const n = size(items[i]);
    if (start < items.length && bytes + n > budget.bytes) break;
    bytes += n;
    start = i;
    if (startsTurn(items, i)) turns++;
  }
  if (start === 0 || startsTurn(items, start)) return start;
  for (let i = start + 1; i < items.length; i++) if (startsTurn(items, i)) return i;
  return start;
}

/** A window (or page) of items: previewed, the newest that fit, and whether there are earlier ones. */
export function windowOf(items: HistoryItem[], budget: Budget): { items: HistoryItem[]; cut: boolean } {
  const shown = items.map(preview);
  const start = windowStart(shown, budget);
  return { items: shown.slice(start), cut: start > 0 };
}

/** What was last sent to a phone of a session's window: each item's id and JSON, in order, and what it was doing. */
export type Sent = { ids: string[]; json: Map<string, string>; doing?: string };

export function sentOf(items: HistoryItem[], doing?: string): Sent {
  return { ids: items.map((i) => i.id ?? ""), json: new Map(items.map((i) => [i.id ?? "", JSON.stringify(i)])), ...(doing ? { doing } : {}) };
}

/**
 * What changed between what a phone has (`sent`) and the window now: the items after the last one
 * still the same (`after`: its id, none when the phone has none), to put in place of what it has
 * after that one. Null when that can't be said (the window moved past everything the phone has, or
 * lost its newest items): send the window whole.
 */
export function deltaOf(sent: Sent, items: HistoryItem[]): { after?: string; items: HistoryItem[] } | null {
  let k = 0;
  while (k < items.length && sent.json.get(items[k].id ?? "") === JSON.stringify(items[k])) k++;
  if (k === items.length) {
    // Nothing changed or came: the same newest item (or none on either side).
    if ((sent.ids.at(-1) ?? null) !== (items.at(-1)?.id ?? null)) return null;
    return items.length ? { after: items[k - 1].id, items: [] } : { items: [] };
  }
  if (k > 0) return { after: items[k - 1].id, items: items.slice(k) };
  if (!sent.ids.length) return { items };
  // The first item changed: it's kept from the one before it in what the phone has.
  const j = sent.ids.indexOf(items[0].id ?? "");
  if (j > 0) return { after: sent.ids[j - 1], items };
  return null;
}

/** Items for an older phone, as it always had them: no ids, no `cut`; the oldest left out past LEGACY_BYTES (the newest always kept). */
export function legacy(items: HistoryItem[]): { items: HistoryItem[]; cut: boolean } {
  const plain = items.map((i): HistoryItem => {
    const { id: _id, ...rest } = i;
    if (rest.kind !== "steps") {
      const { cut: _cut, ...message } = rest;
      return message;
    }
    return { ...rest, steps: rest.steps.map(({ cut: _cut, ...s }) => s) };
  });
  let bytes = 0;
  let start = plain.length;
  for (let i = plain.length - 1; i >= 0; i--) {
    const n = sizeOf(plain[i]);
    if (start < plain.length && bytes + n > LEGACY_BYTES) break;
    bytes += n;
    start = i;
  }
  return { items: plain.slice(start), cut: start > 0 };
}

/**
 * The rest of an item for Show full (full_text): a message's text, or one step's output and diff,
 * from the item read again with more kept. `cut` when even that was cut short.
 */
export function fullPart(item: HistoryItem, step: number | undefined): { text?: string; detail?: string; diff?: string; cut?: true } | null {
  if (item.kind !== "steps") return step === undefined ? { text: item.text, ...(item.cut ? { cut: true as const } : {}) } : null;
  const s = step === undefined ? undefined : item.steps[step];
  if (!s) return null;
  return { detail: s.detail, ...(s.diff !== undefined ? { diff: s.diff } : {}), ...(s.cut ? { cut: true as const } : {}) };
}
