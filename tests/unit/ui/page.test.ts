// Kiko's own page in its window: the file the app keeps (src/core/page.ts: private, every line
// the app shows, a mark at each start, cut back when large) and its drawing (src/ui/viewer.ts in
// "page" mode: who said what with the time, notices dim, errors red, following new lines, scrolled
// back staying put, nothing in a line reaching the terminal as an escape sequence).
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { JsonlWatcher } from "../../../src/core/history.ts";
import { keepPage, type PageLine } from "../../../src/core/page.ts";
import { ui } from "../../../src/core/ui-store.ts";
import { ConversationView, PageFolder, type PageSnapshot } from "../../../src/ui/viewer.ts";

const T0 = new Date(2026, 9, 29, 10, 0).getTime();
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const line = (min: number, kind: PageLine["kind"], text: string, name?: string): PageLine => ({ at: T0 + min * 60_000, kind, text, ...(name ? { name } : {}) });
const sheet = (...lines: PageLine[]): PageSnapshot => ({ lines, truncated: false });
const view = () => {
  const v = new ConversationView(() => T0 + 30 * 60_000, "page");
  v.setInfo({ name: "Kiko", doing: "ready", talk: "hold right ⌥ to talk" });
  return v;
};
const screen = (v: ConversationView, cols = 60, rows = 24) => v.frame(cols, rows).map(plain);

describe("the page file", () => {
  test("private (0600), a start mark, then every line the app shows; stops when told", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiko-page-"));
    const path = join(dir, "run", "page.jsonl");
    const stop = keepPage(path, T0);
    ui.you("tell pixie to run the tests");
    ui.info("→ typed into pixie");
    ui.spoken("Pixie's on it.", { name: "pixie", sessionId: "r1" });
    stop();
    ui.info("after it stopped");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "run")).mode & 0o777, 0o700);
    const got = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      got.map((l) => [l.kind, l.text, l.name]),
      [
        ["start", "", undefined],
        ["you", "tell pixie to run the tests", undefined],
        ["info", "→ typed into pixie", undefined],
        ["spoken", "Pixie's on it.", "pixie"],
      ],
    );
  });
  test("large when the app starts: cut back to its last lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiko-page-"));
    const path = join(dir, "page.jsonl");
    const big = Array.from({ length: 3000 }, (_, i) => JSON.stringify(line(0, "info", `${i} ${"x".repeat(400)}`))).join("\n");
    writeFileSync(path, `${big}\n`);
    keepPage(path, T0)();
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 601);
    assert.match(lines[0], /"2400 x/);
  });
  test("followed as it grows (the viewer's watcher): only whole, known lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiko-page-"));
    const path = join(dir, "page.jsonl");
    writeFileSync(path, `${JSON.stringify(line(1, "you", "hello"))}\nnot json\n${JSON.stringify({ at: 1, kind: "weird", text: "x" })}\n`);
    const seen: PageSnapshot[] = [];
    const w = new JsonlWatcher(
      path,
      () => new PageFolder(),
      (s) => seen.push(s),
      20,
    );
    writeFileSync(path, `${readFileSync(path, "utf8")}${JSON.stringify(line(2, "spoken", "Hi."))}\n`);
    await new Promise((r) => setTimeout(r, 80));
    w.stop();
    assert.deepEqual(
      seen.at(-1)!.lines.map((l) => l.text),
      ["hello", "Hi."],
    );
  });
});

describe("the page drawn", () => {
  test("header and footer: what the page is (the title names Kiko), no state while it's ready, how to talk, the menu's key", () => {
    const v = view();
    v.setPage(sheet());
    const s = screen(v, 80);
    assert.equal(s[0], " what you said, what Kiko said, where your words went");
    assert.match(s[1], /^─+$/);
    assert.ok(!s.join("\n").includes("ready"), "never ● ready");
    assert.ok(!s.join("\n").includes("your conversation with Kiko"));
    assert.match(s.at(-1)!, /^ hold right ⌥ to talk · click a session to show it · ⌃Space menu$/);
    assert.ok(s.some((l) => l.includes("Nothing said yet.")));
  });
  test("what Kiko is doing, right-aligned on that line, only while it does something: listening red, the rest amber; ready again, gone", () => {
    const v = view();
    v.setPage(sheet());
    for (const [doing, style] of [
      ["listening", "1;31"],
      ["deciding", "33"],
      ["speaking", "33"],
    ] as const) {
      v.setInfo({ doing });
      const top = screen(v, 80)[0];
      assert.match(top, new RegExp(`^ what you said, what Kiko said, where your words went\\s+● ${doing} $`));
      assert.equal(top.length, 80);
      assert.ok(v.frame(80, 24)[0].endsWith(`\x1b[${style}m ● ${doing} \x1b[0m`), doing);
    }
    v.setInfo({ doing: "ready" });
    assert.equal(screen(v, 80)[0], " what you said, what Kiko said, where your words went");
    v.setInfo({ doing: "listening" });
    // Narrow: the words cut, the state kept.
    assert.match(screen(v, 30)[0], /^ what you said.* ● listening $/);
    // A small pane: that line, the conversation, the menu's key.
    const small = screen(v, 60, 4);
    assert.equal(small.length, 4);
    assert.match(small[0], /● listening $/);
    assert.match(small[3], /⌃Space menu/);
  });
  test("you, Kiko, a session, a quick task: each under its heading with the time; notices dim beneath; errors marked; a start ruled", () => {
    const v = view();
    v.setPage(
      sheet(
        line(0, "start", ""),
        line(1, "you", "tell pixie to run the tests"),
        line(1, "info", "→ typed into pixie"),
        line(2, "session", "All **42** tests pass.", "pixie"),
        line(2, "spoken", "Pixie says all the tests pass."),
        line(3, "permission", "run pnpm build", "pixie"),
        line(4, "task", "disk space: 120 GB free"),
        line(5, "error", "[stt] connection lost"),
      ),
    );
    const s = screen(v, 70, 30).join("\n");
    for (const part of [
      "── Kiko started · 10:00",
      "› You · 10:01",
      "tell pixie to run the tests",
      "→ typed into pixie",
      "● pixie · 10:02",
      "All 42 tests pass.",
      "♪ Kiko · 10:02",
      "Pixie says all the tests pass.",
      "● pixie · 10:03",
      "wants to run pnpm build",
      "✓ Quick task · 10:04",
      "disk space: 120 GB free",
      "✗ [stt] connection lost",
    ]) {
      assert.ok(s.includes(part), `${part} in:\n${s}`);
    }
    assert.ok(!s.includes("**"));
  });
  test("following: new lines at the bottom; scrolled back, they wait (↓ new) until End", () => {
    const v = view();
    const many = Array.from({ length: 40 }, (_, i) => line(i % 60, "you", `line ${i}`));
    v.setPage(sheet(...many));
    assert.ok(screen(v).some((l) => l.includes("line 39")));
    v.input({ key: "pageUp" });
    screen(v);
    v.setPage(sheet(...many, line(50, "spoken", "a new one")));
    const back = screen(v);
    assert.ok(!back.some((l) => l.includes("a new one")));
    assert.ok(
      back.some((l) => l.includes("↓ 1 new message")),
      back.join("\n"),
    );
    v.input({ key: "end" });
    assert.ok(screen(v).some((l) => l.includes("a new one")));
  });
  test("nothing in a line reaches the terminal as an escape sequence", () => {
    const v = view();
    v.setPage(sheet(line(1, "you", "hi \x1b[2J\x1b]0;title\x07 there"), line(2, "session", "x\x1b[31mred", "ro\x1bcky")));
    const raw = v.frame(60, 20).join("\n");
    assert.ok(!raw.includes("\x1b[2J") && !raw.includes("\x1b]0") && !raw.includes("\x07") && !raw.includes("\x1b[31mred"));
  });
});
