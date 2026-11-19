// What the phone's chat screen gets from a session's history (src/core/history.ts) beyond the
// conversation itself: an edit's lines added and removed and its diff (from Claude Code's structured
// patch, else from the edit's input; none for a patch of bare signs), the step still running and
// what the session is doing ("Running pnpm build"), the diffs' budget per snapshot, and earlier
// messages a page at a time (historyBefore). Transcript lines as Claude Code writes them.
import "../../setup.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { doingOf, historyBefore, HistoryFolder, LIMITS } from "../../../src/core/history.ts";

const at = "2026-10-28T14:02:11.000Z";
const you = (text: string, when = at) => ({ type: "user", timestamp: when, message: { role: "user", content: text } });
const said = (text: string, when = at) => ({ type: "assistant", timestamp: when, message: { content: [{ type: "text", text }] } });
const use = (id: string, name: string, input: object) => ({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, content: unknown, extra: object = {}) => ({
  type: "user",
  timestamp: at,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }] },
  ...extra,
});

function fold(entries: object[]) {
  const f = new HistoryFolder();
  for (const e of entries) f.add(e);
  return f.snapshot();
}
const stepsOf = (h: ReturnType<typeof fold>, i = 0) => (h.items[i] as any).steps as any[];

test("an edit's diff: Claude Code's structured patch, with each hunk's place, and its counts", () => {
  const patch = { structuredPatch: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines: [" keep", "-old", "+new", "+more"] }] };
  const h = fold([use("e", "Edit", { file_path: "src/a.ts", old_string: "old", new_string: "new\nmore" }), result("e", "ok", { toolUseResult: patch })]);
  assert.deepEqual(stepsOf(h)[0], { tool: "Edit", title: "src/a.ts", detail: "+2 −1", error: false, added: 2, removed: 1, diff: "@@ -3,2 +3,3 @@\n keep\n-old\n+new\n+more" });
});

test("before its result, an edit's diff and counts come from its input; a Write is all added", () => {
  const h = fold([use("e", "Edit", { file_path: "a.ts", old_string: "x\ny", new_string: "z" }), use("w", "Write", { file_path: "b.ts", content: "one\ntwo" })]);
  const [edit, write] = stepsOf(h);
  assert.equal(edit.diff, "-x\n-y\n+z");
  assert.deepEqual([edit.added, edit.removed], [1, 2]);
  assert.deepEqual([write.detail, write.added, write.removed, write.diff], ["+2", 2, 0, "+one\n+two"]);
});

test("a patch of bare signs (a Codex change, mirrored with its counts only) gives counts but no diff", () => {
  const h = fold([use("p", "Edit", { file_path: "a.rs" }), result("p", "", { toolUseResult: { structuredPatch: [{ lines: ["+", "+", "+", "-"] }] } })]);
  const step = stepsOf(h)[0];
  assert.deepEqual([step.detail, step.added, step.removed], ["+3 −1", 3, 1]);
  assert.ok(!("diff" in step));
});

test("a long diff is cut to its first lines, with how many more", () => {
  const body = Array.from({ length: LIMITS.diffLines + 20 }, (_, i) => `line ${i}`).join("\n");
  const diff = stepsOf(fold([use("w", "Write", { file_path: "big.ts", content: body })]))[0].diff as string;
  assert.equal(diff.split("\n").length, LIMITS.diffLines + 1);
  assert.ok(diff.endsWith("… 20 more lines"));
});

test("the step still running is marked, and what the session is doing said, until its result comes", () => {
  const entries: object[] = [you("build it"), use("b", "Bash", { command: "pnpm   build" })];
  const running = fold(entries);
  assert.equal(stepsOf(running, 1)[0].running, true);
  assert.equal(running.doing, "Running pnpm build");
  const done = fold([...entries, result("b", "built")]);
  assert.ok(!("running" in stepsOf(done, 1)[0]));
  assert.ok(!("doing" in done), "nothing runs: no doing");
  // Claude's words after it: the turn moved on, so an older step with no result isn't running.
  const after = fold([...entries, said("Stopped.")]);
  assert.ok(!("running" in stepsOf(after, 1)[0]));
  assert.equal(after.doing, undefined);
});

test("several running at once: each marked, the last one said", () => {
  const h = fold([use("r", "Read", { file_path: "/x/src/app.ts" }), use("g", "Grep", { pattern: "created_at" })]);
  assert.deepEqual(
    stepsOf(h).map((s) => s.running),
    [true, true],
  );
  assert.equal(h.doing, "Searching for created_at");
});

test("doingOf: a step in a few words", () => {
  assert.equal(doingOf({ tool: "Edit", title: "/Users/p/git/pixie/src/app.ts" }), "Editing app.ts");
  assert.equal(doingOf({ tool: "Write", title: "db/0042.sql" }), "Writing 0042.sql");
  assert.equal(doingOf({ tool: "Read", title: "README.md" }), "Reading README.md");
  assert.equal(doingOf({ tool: "WebFetch", title: "https://docs.example.com/a/b" }), "Fetching docs.example.com");
  assert.equal(doingOf({ tool: "WebSearch", title: "xcodegen groups" }), "Searching the web for xcodegen groups");
  assert.equal(doingOf({ tool: "Task", title: "Find the router" }), "Running a subagent: Find the router");
  assert.equal(doingOf({ tool: "mcp__cloudflare__dns_update", title: "{}" }), "Using dns_update");
  assert.equal(doingOf({ tool: "Bash", title: "Bash" }), "Running a command");
});

test("a snapshot carries the newest diffs within its budget; older edits keep their counts", () => {
  const big = "x\n".repeat(30).trim();
  const edits = Math.ceil(LIMITS.diffBudget / big.length) + 5;
  const entries = Array.from({ length: edits }, (_, i) => [use(`w${i}`, "Write", { file_path: `f${i}.ts`, content: big }), said(`wrote ${i}`)]).flat();
  const f = new HistoryFolder(Infinity);
  for (const e of entries) f.add(e);
  const steps = f.everything().flatMap((i) => (i.kind === "steps" ? i.steps : []));
  assert.equal(steps.length, edits);
  assert.ok(steps.at(-1)!.diff, "the newest has its diff");
  assert.ok(!steps[0].diff, "the oldest past the budget hasn't");
  assert.ok(
    steps.every((s) => s.added === 30),
    "every one keeps its counts",
  );
  assert.ok(steps.reduce((n, s) => n + (s.diff?.length ?? 0), 0) <= LIMITS.diffBudget);
});

const when = (i: number) => new Date(Date.UTC(2026, 9, 28, 14, 0, 0) + i * 1000).toISOString();
const line = (e: object) => `${JSON.stringify(e)}\n`;

test("historyBefore: the page before a point, newest first fitted, and whether there's more", () => {
  const path = join(process.cwd(), "paged.jsonl");
  writeFileSync(path, Array.from({ length: 150 }, (_, i) => line(i % 2 ? said(`reply ${i}`, when(i)) : you(`ask ${i}`, when(i)))).join(""));
  const page = historyBefore(path, when(100));
  assert.equal(page.items.length, LIMITS.items);
  assert.equal((page.items[0] as any).text, "ask 40");
  assert.equal((page.items.at(-1) as any).text, "reply 99");
  assert.equal(page.more, true);
  const first = historyBefore(path, when(40));
  assert.deepEqual(first.items.map((i: any) => i.text).slice(0, 2), ["ask 0", "reply 1"]);
  assert.equal(first.items.length, 40);
  assert.equal(first.more, false);
  assert.deepEqual(historyBefore(path, when(0)), { items: [], more: false });
});

test("historyBefore: no transcript, or a point that isn't a time, is an empty page", () => {
  assert.deepEqual(historyBefore(undefined, at), { items: [], more: false });
  assert.deepEqual(historyBefore(join(process.cwd(), "nope.jsonl"), at), { items: [], more: false });
  writeFileSync(join(process.cwd(), "one.jsonl"), line(you("hi", when(1))));
  assert.deepEqual(historyBefore(join(process.cwd(), "one.jsonl"), "yesterday"), { items: [], more: false });
});

test("historyBefore: reads further back than the live view's tail when the page is there", () => {
  const path = join(process.cwd(), "long.jsonl");
  const early = Array.from({ length: 10 }, (_, i) => line(i % 2 ? said(`early reply ${i}`, when(i)) : you(`early ask ${i}`, when(i))));
  // Lines it skips (Claude Code's meta entries), more than the first read takes.
  const filler = line({ type: "user", isMeta: true, timestamp: when(20), message: { role: "user", content: "x".repeat(100_000) } });
  const late = Array.from({ length: 4 }, (_, i) => line(you(`late ${i}`, when(1000 + i))));
  writeFileSync(path, [...early, filler.repeat(Math.ceil((LIMITS.tailBytes * 2.5) / filler.length)), ...late].join(""));
  const page = historyBefore(path, when(1000));
  assert.equal(page.items.length, 10);
  assert.equal((page.items[0] as any).text, "early ask 0");
  assert.equal(page.more, false);
});
