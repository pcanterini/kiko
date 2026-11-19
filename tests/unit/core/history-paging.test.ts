// A session's conversation read a page at a time and an item read again whole (src/core/history.ts):
// each item's id is where its entry starts in the file, the same however much of it is read (the
// live watcher, a page, Show full); itemsBefore reads only what comes before an item, an item that
// isn't its entry's first included; an item cut by the start of what was read is left out; itemAt
// brings an item with far more kept (FULL) and says what was still cut; and what was cut short says
// so (`cut`). Transcript lines as Claude Code writes them.
import "../../setup.ts";
import assert from "node:assert/strict";
import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type History, type HistoryItem, HistoryWatcher, itemAt, itemsBefore, LIMITS, offsetOf, readHistory } from "../../../src/core/history.ts";

const when = (i: number) => new Date(Date.UTC(2026, 9, 28, 14, 0, 0) + i * 1000).toISOString();
const you = (text: string, i: number) => ({ type: "user", timestamp: when(i), message: { role: "user", content: text } });
const said = (text: string, i: number) => ({ type: "assistant", timestamp: when(i), message: { content: [{ type: "text", text }] } });
const saidAndUsed = (text: string, id: string, command: string, i: number) => ({
  type: "assistant",
  timestamp: when(i),
  message: {
    content: [
      { type: "text", text },
      { type: "tool_use", id, name: "Bash", input: { command } },
    ],
  },
});
const result = (id: string, content: string, i: number) => ({
  type: "user",
  timestamp: when(i),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }] },
});
const lines = (entries: object[]) => entries.map((e) => `${JSON.stringify(e)}\n`).join("");

/** A conversation of `turns` turns: your words (with an accent, so bytes and characters differ), a command and its output, a reply. */
function conversation(turns: number): object[] {
  return Array.from({ length: turns }, (_, t) => [
    you(`turn ${t}: café ☕ ${"x".repeat(t % 7)}`, t * 10),
    saidAndUsed(`Running it for turn ${t}.`, `b${t}`, `pnpm test --turn ${t}`, t * 10 + 1),
    result(`b${t}`, Array.from({ length: 30 }, (_, l) => `line ${l} of turn ${t}`).join("\n"), t * 10 + 2),
    said(`Done with turn ${t}.`, t * 10 + 3),
  ]).flat();
}

const textOf = (i: HistoryItem) => (i.kind === "steps" ? `steps:${i.steps[0]?.title}` : `${i.kind}:${i.text}`);

test("an item's id is where its entry starts in the file (bytes, not characters), and an entry's second item is .1", () => {
  const path = join(process.cwd(), "ids.jsonl");
  const entries = [you("héllo ☕", 0), saidAndUsed("Let me look.", "b", "ls", 1), result("b", "a\nb", 2), said("Two files.", 3)];
  writeFileSync(path, lines(entries));
  const items = readHistory(path).items;
  const starts = [0, ...entries.map((e) => Buffer.byteLength(`${JSON.stringify(e)}\n`))].map((_, i, all) => all.slice(0, i + 1).reduce((a, b) => a + b, 0));
  assert.deepEqual(
    items.map((i) => i.id),
    [String(starts[0]), String(starts[1]), `${starts[1]}.1`, String(starts[3])],
  );
  assert.deepEqual(items.map(textOf), ["you:héllo ☕", "claude:Let me look.", "steps:ls", "claude:Two files."]);
  assert.equal(offsetOf(`${starts[1]}.1`), starts[1]);
  assert.equal(offsetOf("t:x|you|0"), null, "the hub's own ids for an agent with no file aren't places in one");
});

test("the same item has the same id read live (the end only), and read whole", () => {
  const path = join(process.cwd(), "same.jsonl");
  writeFileSync(path, lines(conversation(3000)));
  assert.ok(statSync(path).size > LIMITS.tailBytes, "longer than the tail the watcher reads");
  const all = readAll(path);
  assert.equal(all.length, 3000 * 4);
  const seen: History[] = [];
  const w = new HistoryWatcher(path, (h) => seen.push(h), 60_000);
  w.stop();
  const live = seen[0].items;
  assert.equal(seen[0].truncated, true);
  assert.equal(live.length, LIMITS.items);
  for (const item of live)
    assert.deepEqual(
      item,
      all.find((x) => x.id === item.id),
      `${item.id} the same`,
    );
});

/** Every item in a file, read whole: everything before its end (a line's start, the file ending with a newline). */
const readAll = (path: string): HistoryItem[] => itemsBefore(path, String(statSync(path).size), () => false)!.items;

test("itemsBefore: only what comes before the item, read back from it until there's enough, and whether the start was reached", () => {
  const path = join(process.cwd(), "before.jsonl");
  writeFileSync(path, lines(conversation(400)));
  const all = readAll(path);
  assert.equal(all.length, 1600);
  const cursor = all[900].id!;
  let asked = 0;
  const page = itemsBefore(path, cursor, (items) => (asked++, items.length > 30))!;
  assert.ok(asked >= 1);
  assert.equal(page.start, false, "a quarter of a megabyte back is enough: the file's start isn't read");
  assert.ok(page.items.length > 30 && page.items.length < 900);
  assert.equal(page.items.at(-1)!.id, all[899].id, "up to the item just before the cursor");
  for (const item of page.items)
    assert.deepEqual(
      item,
      all.find((x) => x.id === item.id),
      "whole, as a full read has it",
    );
  // Never enough: read back to the file's start.
  const everything = itemsBefore(path, cursor, () => false)!;
  assert.equal(everything.start, true);
  assert.deepEqual(everything.items, all.slice(0, 900));
});

test("itemsBefore: an entry's second item as the cursor brings its first; a cursor that isn't a line's start is null", () => {
  const path = join(process.cwd(), "second.jsonl");
  writeFileSync(path, lines(conversation(3)));
  const all = readAll(path);
  const second = all.find((i) => i.id?.endsWith(".1"))!;
  const at = all.indexOf(second);
  const page = itemsBefore(path, second.id!, () => false)!;
  assert.deepEqual(page.items.map(textOf), all.slice(0, at).map(textOf));
  assert.equal(page.items.at(-1)!.kind, "claude", "the reply its entry started with");
  assert.equal(
    itemsBefore(path, String(Number(all[1].id) + 3), () => false),
    null,
    "not a line's start: the file was written again",
  );
  assert.equal(
    itemsBefore(path, "nope", () => false),
    null,
  );
  assert.equal(
    itemsBefore(undefined, "0", () => false),
    null,
  );
});

test("itemAt: an item again with far more kept, its id the same; `cut` where even that was cut", () => {
  const path = join(process.cwd(), "full.jsonl");
  const long = Array.from({ length: 1000 }, (_, l) => `output line ${l}`).join("\n");
  writeFileSync(path, lines([you("run it", 0), saidAndUsed("Running.", "b", "pnpm test", 1), result("b", long, 2), said("x".repeat(9000), 3), you("thanks", 4)]));
  const live = readHistory(path).items;
  const steps = live.find((i) => i.kind === "steps")!;
  assert.equal(steps.kind === "steps" && steps.steps[0].cut, true, "the live view's output is cut: it says so");
  assert.equal(steps.kind === "steps" && steps.steps[0].detail.split("\n").length, LIMITS.outputLines + 1);
  const reply = live.find((i) => i.kind === "claude" && i.text.startsWith("x"))!;
  assert.equal(reply.kind === "claude" && reply.cut, true);
  const full = itemAt(path, steps.id!)!;
  assert.equal(full.id, steps.id);
  assert.equal(full.kind, "steps");
  if (full.kind !== "steps") return;
  assert.equal(full.steps[0].detail.split("\n").length, 401, "400 lines, then how many more");
  assert.match(full.steps[0].detail, /… 600 more lines$/);
  assert.equal(full.steps[0].cut, true, "still cut: the rest is on the Mac");
  const whole = itemAt(path, reply.id!)!;
  assert.equal(whole.kind === "claude" && whole.text.length, 9000);
  assert.equal(whole.kind === "claude" && whole.cut, undefined, "nothing cut");
  assert.equal(itemAt(path, "3"), null, "not an item's start");
  assert.equal(itemAt(undefined, steps.id!), null);
});

test("an item cut by the start of what's read is left out of the live view, and a page before the next brings it whole", () => {
  const path = join(process.cwd(), "partial.jsonl");
  // One long fold (many commands) in the middle, longer than the tail the watcher reads.
  const big = "y".repeat(40_000);
  const entries: object[] = [you("start", 0)];
  for (let i = 0; i < 80; i++) entries.push(saidAndUsed("", `c${i}`, `step ${i}`, 1 + i), result(`c${i}`, big, 1 + i));
  entries.push(said("All done.", 200), you("thanks", 201));
  writeFileSync(path, lines(entries));
  const live = readHistory(path);
  assert.equal(live.truncated, true);
  assert.deepEqual(
    live.items.map((i) => i.kind),
    ["claude", "you"],
    "the fold began before the tail: left out",
  );
  const page = itemsBefore(path, live.items[0].id!, (items) => items.length > 0)!;
  const fold = page.items.at(-1)!;
  assert.equal(fold.kind, "steps");
  assert.equal(fold.kind === "steps" && fold.steps[0].title, "step 0", "whole, from its first step");
});

test("the watcher's ids stay right as lines are added, a half-written one waiting for its end", () => {
  const path = join(process.cwd(), "growing.jsonl");
  writeFileSync(path, lines([you("one ☕", 0)]));
  const seen: History[] = [];
  const w = new HistoryWatcher(path, (h) => seen.push(h), 60_000);
  try {
    const next = lines([said("two é", 1)]);
    appendFileSync(path, next.slice(0, 10));
    w.check();
    appendFileSync(path, next.slice(10));
    w.check();
    appendFileSync(path, lines([you("three", 2)]));
    w.check();
    assert.deepEqual(
      seen.at(-1)!.items.map((i) => i.id),
      readHistory(path).items.map((i) => i.id),
    );
  } finally {
    w.stop();
  }
});
