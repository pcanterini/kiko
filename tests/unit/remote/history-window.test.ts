// What a session's screen on the phone is sent of its conversation (src/remote/history-window.ts):
// a paged phone's preview of each item (long messages, outputs and diffs cut, `cut` saying so, the
// record's own "… N more lines" counted in), its window (the newest turns within its budget, whole
// turns where it can, at least one item), the deltas after it (only what changed, after the last
// item still the same), an older phone's history (no ids, at most LEGACY_BYTES, the newest kept),
// the budget a phone may ask for, and Show full's part of an item.
import "../../setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HistoryItem, Step } from "../../../src/core/history.ts";
import { BUDGET, budgetOf, deltaOf, fullPart, LEGACY_BYTES, legacy, PREVIEW, preview, sentOf, sizeOf, windowOf, windowStart, withIds } from "../../../src/remote/history-window.ts";

const you = (id: string, text = `ask ${id}`): HistoryItem => ({ kind: "you", text, at: null, id });
const claude = (id: string, text = `reply ${id}`): HistoryItem => ({ kind: "claude", text, at: null, id });
const steps = (id: string, list: Step[]): HistoryItem => ({ kind: "steps", summary: "ran 1 command", steps: list, at: null, id });
const bash = (detail: string, extra: Partial<Step> = {}): Step => ({ tool: "Bash", title: "pnpm test", detail, error: false, ...extra });

test("preview: a long message, output and diff cut, `cut` where they were; short ones as they are", () => {
  const short = claude("1", "fine");
  assert.equal(preview(short), short, "the same item: nothing to cut");
  const long = preview(claude("2", "w".repeat(5000)));
  assert.equal(long.kind === "claude" && long.text.length, PREVIEW.text);
  assert.equal(long.kind === "claude" && long.cut, true);
  const output = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const diff = Array.from({ length: 100 }, (_, i) => `+added ${i}`).join("\n");
  const item = preview(steps("3", [bash(output), { tool: "Edit", title: "a.ts", detail: "+100 −0", error: false, added: 100, removed: 0, diff }, bash("ok")]));
  assert.equal(item.kind, "steps");
  if (item.kind !== "steps") return;
  const [run, edit, ok] = item.steps;
  assert.equal(run.detail.split("\n").length, PREVIEW.detailLines + 1);
  assert.match(run.detail, /\n… 32 more lines$/);
  assert.equal(run.cut, true);
  assert.equal(edit.detail, "+100 −0", "an edit's counts are never cut");
  assert.equal(edit.diff!.split("\n").length, PREVIEW.diffLines + 1);
  assert.match(edit.diff!, /… 70 more lines$/);
  assert.equal(edit.cut, true);
  assert.deepEqual(ok, bash("ok"), "a short output untouched");
});

test('preview: the record\'s own cut ("… 88 more lines") counted in; already cut, `cut` kept', () => {
  const recorded = `${Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n")}\n… 88 more lines`;
  const item = preview(steps("1", [bash(recorded, { cut: true })]));
  const step = item.kind === "steps" ? item.steps[0] : null;
  assert.match(step!.detail, /\n… 92 more lines$/, "4 of the 12 left out here, and the record's 88");
  const fits = preview(steps("2", [bash("a\nb\n… 3 more lines", { cut: true })]));
  assert.deepEqual(fits.kind === "steps" && fits.steps[0], bash("a\nb\n… 3 more lines", { cut: true }), "short enough: as the record cut it");
});

test("windowStart: the newest items within the bytes, at least one, whole turns where it can", () => {
  const size = () => 100;
  const items = [you("1"), claude("2"), you("3"), claude("4"), steps("5", []), claude("6"), you("7"), claude("8")];
  assert.equal(windowStart(items, { turns: 30, bytes: 10_000 }, size), 0, "all of it fits");
  // 450 bytes: the newest 4 items fit (5, 6, 7, 8): 5 and 6 are part of a turn: from your words at 7.
  assert.equal(windowStart(items, { turns: 30, bytes: 450 }, size), 6);
  // 650: 6 items (3…8): 3 starts a turn, so from there.
  assert.equal(windowStart(items, { turns: 30, bytes: 650 }, size), 2);
  assert.equal(windowStart(items, { turns: 30, bytes: 10 }, size), 7, "nothing fits: the newest alone");
  const oneTurn = [you("1"), claude("2"), steps("3", []), claude("4")];
  assert.equal(windowStart(oneTurn, { turns: 30, bytes: 250 }, size), 2, "the newest turn alone too big: where it fits, part way");
});

test("windowStart: at most `turns` turns (your words in a row start one)", () => {
  const items = [you("1"), claude("2"), you("3"), you("4"), claude("5"), you("6"), claude("7")];
  assert.equal(windowStart(items, { turns: 1, bytes: 1e9 }), 5);
  assert.equal(windowStart(items, { turns: 2, bytes: 1e9 }), 2, "3 and 4 together are one turn");
  assert.equal(windowStart(items, { turns: 3, bytes: 1e9 }), 0);
});

test("windowOf: previewed, and whether there's more before it", () => {
  const items = Array.from({ length: 200 }, (_, i) => (i % 2 ? claude(String(i), "z".repeat(3000)) : you(String(i))));
  const w = windowOf(items, BUDGET);
  assert.equal(w.cut, true);
  assert.ok(Buffer.byteLength(JSON.stringify(w.items)) <= BUDGET.bytes);
  assert.equal(w.items[0].kind, "you", "from a turn's start");
  assert.equal(w.items.at(-1)!.id, "199");
  for (const i of w.items) if (i.kind === "claude") assert.equal(i.cut, true);
  assert.deepEqual(windowOf(items.slice(-4), BUDGET).cut, false);
});

test("deltaOf: only the items after the last one still the same; nothing, or the window again, when that's all it can say", () => {
  const before = [you("1"), claude("2"), steps("3", [bash("", { running: true })])];
  const sent = sentOf(before, "Running pnpm test");
  // The running step finished, and a reply came.
  const now = [you("1"), claude("2"), steps("3", [bash("ok")]), claude("4")];
  assert.deepEqual(deltaOf(sent, now), { after: "2", items: [now[2], now[3]] });
  assert.deepEqual(deltaOf(sent, before), { after: "3", items: [] }, "nothing changed: only what it's doing may have");
  // The window moved on (its first item dropped off): still only what's new.
  assert.deepEqual(deltaOf(sentOf(now), [claude("2"), steps("3", [bash("ok")]), claude("4"), you("5")]), { after: "4", items: [you("5")] });
  // The first item changed: kept from the one before it in what the phone has.
  assert.deepEqual(deltaOf(sentOf(now), [claude("4", "longer"), you("5")]), { after: "3", items: [claude("4", "longer"), you("5")] });
  assert.deepEqual(deltaOf(sentOf([]), [you("1")]), { items: [you("1")] }, "it had none: all of them");
  assert.equal(deltaOf(sentOf(now), [you("9")]), null, "past everything it has: the window whole");
  assert.equal(deltaOf(sentOf(now), [you("1"), claude("2")]), null, "its newest items gone: the window whole");
});

test("legacy: as an older phone always had it (no ids, no cut), within LEGACY_BYTES, the newest kept", () => {
  const items = [you("1"), steps("2", [bash("x", { cut: true })]), claude("3", "c".repeat(2000))];
  const old = legacy(items);
  assert.equal(old.cut, false);
  assert.deepEqual(old.items, [
    { kind: "you", text: "ask 1", at: null },
    { kind: "steps", summary: "ran 1 command", steps: [bash("x")], at: null },
    { kind: "claude", text: "c".repeat(2000), at: null },
  ]);
  const huge = Array.from({ length: 60 }, (_, i) =>
    steps(
      String(i),
      Array.from({ length: 40 }, () => bash("o".repeat(1500))),
    ),
  );
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) > 3_000_000, "today's worst: megabytes");
  const capped = legacy(huge);
  assert.equal(capped.cut, true);
  assert.ok(Buffer.byteLength(JSON.stringify(capped.items)) <= LEGACY_BYTES);
  assert.deepEqual(capped.items.at(-1), legacy([huge.at(-1)!]).items[0], "the newest kept");
  const one = legacy([
    steps(
      "x",
      Array.from({ length: 40 }, () => bash("o".repeat(6000))),
    ),
  ]);
  assert.equal(one.items.length, 1, "the newest goes whatever its size");
});

test("budgetOf: what the phone asked within the caps, else the hub's 30 turns and 64 KB", () => {
  assert.deepEqual(budgetOf({}), BUDGET);
  assert.deepEqual(budgetOf({ turns: 10, bytes: 32_768 }), { turns: 10, bytes: 32_768 });
  assert.deepEqual(budgetOf({ turns: 1000, bytes: 10_000_000 }), { turns: 100, bytes: 256 * 1024 });
  assert.deepEqual(budgetOf({ turns: 0, bytes: 1 }), { turns: 1, bytes: 8 * 1024 });
  assert.deepEqual(budgetOf({ turns: 2.5 }), BUDGET);
});

test("withIds: an agent's items without ids (T3 Code) get the hub's, the same each time", () => {
  const items: HistoryItem[] = [
    { kind: "you", text: "a", at: "2026-10-28T14:00:00.000Z" },
    { kind: "you", text: "b", at: "2026-10-28T14:00:00.000Z" },
  ];
  const ids = withIds(items).map((i) => i.id);
  assert.deepEqual(ids, ["t:2026-10-28T14:00:00.000Z|you|0", "t:2026-10-28T14:00:00.000Z|you|1"]);
  assert.deepEqual(
    withIds(items).map((i) => i.id),
    ids,
  );
  const fromFile = [you("12")];
  assert.equal(withIds(fromFile), fromFile, "ids already: as they are");
});

test("fullPart: a message's text, or one step's output and diff; nothing for a step that isn't there", () => {
  assert.deepEqual(fullPart(claude("1", "all of it"), undefined), { text: "all of it" });
  const item = steps("2", [bash("out", { cut: true }), { tool: "Edit", title: "a.ts", detail: "+1 −0", error: false, diff: "+x" }]);
  assert.deepEqual(fullPart(item, 0), { detail: "out", cut: true });
  assert.deepEqual(fullPart(item, 1), { detail: "+1 −0", diff: "+x" });
  assert.equal(fullPart(item, 5), null);
  assert.equal(fullPart(claude("1"), 0), null);
  assert.ok(sizeOf(item) > 0);
});
