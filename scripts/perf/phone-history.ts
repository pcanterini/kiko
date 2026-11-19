// What the phone's session screen is sent, before and after paging (2026-11-04), from real
// transcripts: opening one (the old whole history, the new window) and while it works (the old
// whole history on every change, the new deltas), replaying each transcript's last 400 entries with
// changes grouped by half a second of their timestamps (the watcher looks twice a second). Numbers
// only: nothing of a transcript's words is printed or written.
//
//   node scripts/perf/phone-history.ts [--out scripts/perf/phone-history-<date>.json] [files…]
//
// With no files: the 8 largest, 8 from the 20th and 8 from the 50th largest of ~/.claude/projects/*/*.jsonl.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HistoryFolder, readHistory } from "../../src/core/history.ts";
import { BUDGET, deltaOf, legacy, sentOf, windowOf, withIds } from "../../src/remote/history-window.ts";

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? args.splice(outAt, 2)[1] : null;
let files = args;
if (!files.length) {
  const root = join(homedir(), ".claude", "projects");
  const all = readdirSync(root).flatMap((d) => {
    try {
      return readdirSync(join(root, d))
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => join(root, d, f));
    } catch {
      return [];
    }
  });
  const bySize = all.map((f) => ({ f, size: statSync(f).size })).sort((a, b) => b.size - a.size);
  files = [...bySize.slice(0, 8), ...bySize.slice(20, 28), ...bySize.slice(50, 58)].map((x) => x.f);
}

const message = (type: string, fields: object) => Buffer.byteLength(JSON.stringify({ v: 1, type, sessionId: "8f1c2a7e-3b4d-4e5f-9a6b-7c8d9e0f1a2b", ...fields }));
const rows = files.map((file) => {
  const h = readHistory(file);
  const before = message("history", { items: legacy(h.items).items, truncated: h.truncated });
  const uncapped = message("history", { items: h.items.map(({ id: _id, ...i }) => i), truncated: h.truncated });
  const w = windowOf(withIds(h.items), BUDGET);
  const after = message("history", { items: w.items, truncated: true, cursor: w.items[0]?.id ?? "0" });
  const text = readFileSync(file);
  const from = Math.max(0, text.length - 8_000_000);
  const lines = text
    .toString("utf8", from)
    .split("\n")
    .slice(from ? 1 : 0)
    .filter(Boolean);
  const folder = new HistoryFolder();
  let offset = 0;
  const add = (line: string) => {
    let changed = false;
    try {
      changed = folder.add(JSON.parse(line), offset);
    } catch {}
    offset += Buffer.byteLength(line) + 1;
    return changed;
  };
  for (const line of lines.slice(0, -400)) add(line);
  let sent = sentOf(windowOf(withIds(folder.snapshot().items), BUDGET).items);
  let streamBefore = 0;
  let streamAfter = 0;
  let sends = 0;
  let bucket = Number.NaN;
  let changed = false;
  const flush = () => {
    if (!changed) return;
    changed = false;
    sends++;
    const now = folder.snapshot();
    streamBefore += message("history", { items: now.items.map(({ id: _id, ...i }) => i), truncated: now.truncated });
    const win = windowOf(withIds(now.items), BUDGET).items;
    const d = deltaOf(sent, win);
    streamAfter += d ? message("history_delta", d) : message("history", { items: win, truncated: true });
    sent = sentOf(win);
  };
  for (const line of lines.slice(-400)) {
    let at = Number.NaN;
    try {
      at = Math.floor(Date.parse(JSON.parse(line).timestamp) / 500);
    } catch {}
    if (Number.isFinite(at) && at !== bucket) {
      flush();
      bucket = at;
    }
    changed = add(line) || changed;
  }
  flush();
  return {
    mb: +(statSync(file).size / 1e6).toFixed(1),
    items: h.items.length,
    openBefore: uncapped,
    openBeforeCapped: before,
    openAfter: after,
    windowItems: w.items.length,
    sends,
    streamBefore,
    streamAfter,
  };
});
console.table(rows);
const median = (k: keyof (typeof rows)[0]) => rows.map((r) => r[k] as number).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
const sum = (k: keyof (typeof rows)[0]) => rows.reduce((a, r) => a + (r[k] as number), 0);
const summary = {
  sessions: rows.length,
  openMedian: { before: median("openBefore"), after: median("openAfter") },
  openMax: { before: Math.max(...rows.map((r) => r.openBefore)), after: Math.max(...rows.map((r) => r.openAfter)) },
  stream: {
    sends: sum("sends"),
    before: sum("streamBefore"),
    after: sum("streamAfter"),
    perSendBefore: Math.round(sum("streamBefore") / sum("sends")),
    perSendAfter: Math.round(sum("streamAfter") / sum("sends")),
  },
};
console.log(summary);
if (out) writeFileSync(out, `${JSON.stringify({ date: new Date().toISOString().slice(0, 10), budget: BUDGET, rows, summary }, null, 2)}\n`);
