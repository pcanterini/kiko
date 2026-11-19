// The read-only view of an outside session (src/ui/viewer.ts), drawn from a made-up history on a
// fake clock: the header (folder · last active, the state on the right; the name and where it runs
// are on the box's title: placeText), the conversation readable
// (Markdown without its marks, steps as one dim line, Kiko's lines in between), the footer per
// place with the menu's key, following new messages at the bottom and not when scrolled up ("↓ new
// messages", End to jump back), an ended session still readable, and nothing a transcript holds
// reaching the terminal as an escape sequence.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { History, HistoryItem } from "../../../src/core/history.ts";
import { menuKeyName } from "../../../src/terminals/tmux/keys.ts";
const MENU_KEY_NAME = menuKeyName();
import { clean, ConversationView, footer, footerText, inputs, markdown, parseInfo, placeText, width, type ViewerInfo } from "../../../src/ui/viewer.ts";

const T0 = Date.parse("2026-10-29T10:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const you = (text: string, min: number): HistoryItem => ({ kind: "you", text, at: at(min) });
const claude = (text: string, min: number): HistoryItem => ({ kind: "claude", text, at: at(min) });
const history = (...items: HistoryItem[]): History => ({ items, truncated: false });
const INFO: ViewerInfo = { name: "notes", where: "ghostty", status: "working", folder: "/Users/me/git/notes", spoken: [] };

/** A view on a clock that says `now` (minutes after T0). */
function viewAt(now = 10) {
  let t = T0 + now * 60_000;
  const v = new ConversationView(() => t);
  v.setInfo(INFO);
  return { v, tick: (min: number) => void (t += min * 60_000) };
}
const screen = (v: ConversationView, cols = 60, rows = 20) => v.frame(cols, rows).map(plain);

describe("the viewer's drawing", () => {
  test("header: folder · last active, the state right-aligned on that line, a rule; no name (the title has it); footer: read-only, by voice, where its window is, the menu's key", () => {
    const { v } = viewAt(10);
    v.setHistory(history(you("fix the login bug", 1), claude("Done.", 7)));
    const s = screen(v, 100);
    assert.match(s[0], /^ ~\/git\/notes · last active 3 min ago\s+● working $/);
    assert.equal(width(s[0]), 100, "the state against the right edge");
    assert.match(s[1], /^─+$/);
    assert.ok(!s.slice(0, 2).some((l) => l.includes("notes  ") || l.includes("in Ghostty")), "neither the name nor where it runs above the rule");
    // Its style kept: working green, after the dim folder line.
    const raw = v.frame(100, 20)[0];
    assert.ok(raw.startsWith("\x1b[2m ~/git/notes · last active 3 min ago\x1b[0m"), JSON.stringify(raw));
    assert.ok(raw.endsWith("\x1b[32m ● working \x1b[0m"), JSON.stringify(raw));
    assert.equal(s.at(-1), ` Read-only · talk to it by voice · its own window is in Ghostty · ${MENU_KEY_NAME} menu`);
    for (const line of s) assert.ok(width(line) <= 100, line);
  });

  test("every place says where, and the footer's wording is in one place", () => {
    assert.equal(footerText("ghostty"), `Read-only · talk to it by voice · its own window is in Ghostty · ${MENU_KEY_NAME} menu`);
    assert.match(footerText("desktop"), /it's open in the Claude desktop app/);
    assert.match(footerText("background"), /runs in the background/);
    assert.equal(footer("ghostty", "Ctrl+Space").back, "Ctrl+Space menu");
    // Where it runs, for the title after its name (window.ts PLACE).
    for (const [where, words] of [
      ["ghostty", "in Ghostty"],
      ["t3", "in T3 Code"],
      ["desktop", "in the Claude desktop app"],
      ["background", "in the background"],
      ["elsewhere", "in a terminal of its own"],
    ] as const) {
      assert.equal(placeText(where), words, where);
    }
  });

  test("narrow: the menu's key kept whole, the rest cut", () => {
    const { v } = viewAt();
    const last = screen(v, 40).at(-1)!;
    assert.ok(last.endsWith(`· ${MENU_KEY_NAME} menu`), last);
    assert.ok(width(last) <= 40);
  });

  test("states: needs you, waits for you, working, idle, ended", () => {
    const { v } = viewAt();
    const top = () => screen(v)[0];
    for (const [status, text] of [
      ["needs_you", "⚠ needs you"],
      ["waiting", "◆ waits for you"],
      ["working", "● working"],
      ["idle", "○ idle"],
      ["ended", "■ ended"],
    ] as const) {
      v.setInfo({ status });
      assert.ok(top().trimEnd().endsWith(text), `${status}: ${top()}`);
    }
  });

  test("the conversation, newest at the bottom: who said it and when, steps as one dim line, Kiko's line after what it's about", () => {
    const { v } = viewAt();
    const steps: HistoryItem = { kind: "steps", summary: "ran 3 commands, edited 2 files", steps: [{ tool: "Bash", title: "pnpm test", detail: "1 failed", error: true }], at: at(3) };
    v.setHistory(history(you("fix it", 1), claude("Looking.", 2), steps, claude("Fixed.", 4)));
    v.setInfo({ spoken: [{ at: T0 + 5 * 60_000, text: "Notes fixed it; one test still fails." }] });
    const s = screen(v, 60, 30);
    const body = s.slice(2, -2).filter((l) => l.trim());
    const hhmm = (min: number) => {
      const d = new Date(T0 + min * 60_000);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    assert.deepEqual(body, [
      `› You · ${hhmm(1)}`,
      "  fix it",
      `● Claude · ${hhmm(2)}`,
      "  Looking.",
      "  ⋯ ran 3 commands, edited 2 files · 1 failed",
      "  Fixed.",
      `♪ Kiko said · ${hhmm(5)}`,
      "  Notes fixed it; one test still fails.",
    ]);
    assert.equal(s.at(-3), "  Notes fixed it; one test still fails.", "the newest line is the last before the footer");
    // The steps line is dim.
    assert.ok(v.frame(60, 30).some((l) => l.includes("\x1b[2m  ⋯ ran 3 commands")));
  });

  test("the replies are headed with who answers, in its agent's colour: Claude, Codex, OpenCode, T3 Code; Claude until the app says", () => {
    const head = (v: ConversationView) => v.frame(60, 20).find((l) => plain(l).startsWith("● "))!;
    const { v } = viewAt();
    v.setHistory(history(you("fix it", 1), claude("Fixed.", 2)));
    // Before the app has said (an older app): Claude, in the orange it always had.
    assert.match(plain(head(v)), /^● Claude · /);
    assert.ok(head(v).startsWith("\x1b[1;38;5;173m● "), JSON.stringify(head(v)));
    for (const [name, color, rgb] of [
      ["Claude", "#D77757", "215;119;87"],
      ["Codex", "#63A8F8", "99;168;248"],
      ["OpenCode", "#FAB283", "250;178;131"],
      ["T3 Code", "#7878FF", "120;120;255"],
    ] as const) {
      v.setInfo({ agent: { name, color } });
      assert.match(plain(head(v)), new RegExp(`^● ${name} · \\d\\d:\\d\\d$`), name);
      assert.ok(head(v).startsWith(`\x1b[1;38;2;${rgb}m● \x1b[0m\x1b[1;38;2;${rgb}m${name}\x1b[0m`), JSON.stringify(head(v)));
      assert.ok(!screen(v).some((l) => name !== "Claude" && l.includes("Claude")), `${name}: no Claude left`);
    }
    // An agent with no colour: bold, in the terminal's own.
    v.setInfo({ agent: { name: "Pi" } });
    assert.ok(head(v).startsWith("\x1b[1m● \x1b[0m\x1b[1mPi\x1b[0m"), JSON.stringify(head(v)));
    // Steps are under the same heading, not a new one.
    v.setHistory(history(you("go", 1), { kind: "steps", summary: "ran 1 command", steps: [], at: at(2) }, claude("Done.", 3)));
    assert.equal(screen(v).filter((l) => l.startsWith("● Pi")).length, 1);
  });

  test("nothing yet, and a transcript read from part way", () => {
    const { v } = viewAt();
    assert.ok(screen(v).some((l) => l.includes("Nothing said yet.")));
    v.setHistory({ items: [claude("later", 1)], truncated: true });
    assert.ok(screen(v).some((l) => l.includes("earlier messages aren't shown")));
  });

  test("ended: said so, and the conversation stays", () => {
    const { v } = viewAt();
    v.setHistory(history(you("hello", 1), claude("Hi.", 2)));
    v.setInfo({ status: "ended" });
    const s = screen(v);
    assert.ok(s.some((l) => l.includes("Hi.")));
    assert.ok(s.some((l) => l.includes("the session ended")));
  });

  test("a small pane still has the folder, the state and the menu's key", () => {
    const { v } = viewAt();
    v.setHistory(history(you("hello", 1)));
    const s = screen(v, 40, 4);
    assert.equal(s.length, 4);
    assert.match(s[0], /^ ~\/git\/notes.*● working $/);
    assert.match(s.slice(1, 3).join("\n"), /hello/);
    assert.match(s[3], /⌃Space menu/);
    // Narrower than the line: the folder cut, the state kept whole.
    assert.match(screen(v, 20, 4)[0], /^ ~\/git\/n.* ● working $/);
  });
});

describe("Markdown, readably", () => {
  const text = (md: string, max = 50) => markdown(md, max).map((l) => l.map((s) => s.text).join(""));
  const styled = (md: string) => markdown(md, 50).flat();

  test("bold, italic, code and links without their marks", () => {
    assert.deepEqual(text("Use **pnpm** and `tsc`, *not* [npm](https://npmjs.com)."), ["  Use pnpm and tsc, not npm."]);
    const spans = styled("**bold** `code` *it*");
    assert.equal(spans.find((s) => s.text === "bold")?.style, "1");
    assert.equal(spans.find((s) => s.text === "code")?.style, "36");
    assert.equal(spans.find((s) => s.text === "it")?.style, "3");
    // Not emphasis: a lone star, snake_case, 2 * 3.
    assert.deepEqual(text("a * b and snake_case_name and 2*3*4"), ["  a * b and snake_case_name and 2*3*4"]);
  });

  test("headings bold, lists with a hanging indent, code blocks without fences, quotes, rules", () => {
    const md = "## Plan\n- read the code carefully and slowly, line by line\n1. run the tests\n\n```ts\nconst x = 1;\n```\n> quoted\n---";
    assert.deepEqual(text(md, 30), ["  Plan", "  • read the code carefully", "    and slowly, line by line", "  1. run the tests", "", "    const x = 1;", "  │ quoted", `  ${"─".repeat(28)}`]);
    assert.equal(styled("# Title")[1].style, "1");
  });

  test("wrapped between words, a long word cut, never past the width (wide characters counted twice)", () => {
    for (const md of ["word ".repeat(40), "x".repeat(130), "日本語のテキスト".repeat(10), "emoji 🎉🎉🎉 ".repeat(12)]) {
      for (const line of markdown(md, 24)) assert.ok(width(line.map((s) => s.text).join("")) <= 24, JSON.stringify(line));
    }
  });

  test("a transcript's escape sequences and control characters never reach the terminal", () => {
    assert.equal(clean("hi\x1b[2J\x1b]0;title\x07 there\r\n\tx\u009b"), "hi[2J]0;title there\n    x");
    const { v } = viewAt();
    v.setHistory(history(claude("evil \x1b[31mred\x1b[0m \x1b]52;c;cGFzdGU=\x07 text", 1)));
    v.setInfo({ name: "a\x1b[2Jb" });
    for (const line of v.frame(60, 20)) assert.ok(!/\x1b(?!\[[0-9;]*m)/.test(line), JSON.stringify(line));
  });
});

describe("scrolling and following", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => claude(`message ${i}`, i));

  test("at the bottom, a new message comes into view", () => {
    const { v } = viewAt(60);
    v.setHistory(history(...many(20)));
    assert.ok(screen(v).some((l) => l.includes("message 19")));
    v.setHistory(history(...many(21)));
    assert.ok(screen(v).some((l) => l.includes("message 20")));
    assert.equal(v.following, true);
  });

  test("scrolled up, new messages don't move the view: “↓ 2 new messages”; End jumps back", () => {
    const { v } = viewAt(60);
    v.setHistory(history(...many(20)));
    screen(v);
    for (let i = 0; i < 5; i++) v.input({ key: "up" });
    const before = screen(v).slice(2, -2);
    assert.match(screen(v).at(-2)!, /scrolled back · End for the newest/);
    v.setHistory(history(...many(22)));
    const after = screen(v);
    assert.deepEqual(after.slice(2, -2), before, "the same lines in the same place");
    assert.match(after.at(-2)!, /↓ 2 new messages · End to jump/);
    v.input({ key: "end" });
    const back = screen(v);
    assert.ok(back.some((l) => l.includes("message 21")));
    assert.match(back.at(-2)!, /^─+$/);
    assert.equal(v.unseen, 0);
  });

  test("a line from Kiko counts as new too; scrolling down to the bottom clears it", () => {
    const { v } = viewAt(60);
    v.setHistory(history(...many(20)));
    screen(v);
    v.input({ key: "pageUp" });
    v.setInfo({ spoken: [{ at: T0 + 30 * 60_000, text: "Kiko's summary" }] });
    assert.match(screen(v).at(-2)!, /↓ 1 new message ·/);
    for (let i = 0; i < 50; i++) v.input({ wheel: 3 });
    screen(v);
    assert.equal(v.unseen, 0);
  });

  test("Home goes to the oldest, PgDn and the wheel come back down", () => {
    const { v } = viewAt(60);
    v.setHistory(history(...many(30)));
    screen(v);
    v.input({ key: "home" });
    assert.ok(screen(v).some((l) => l.includes("message 0")));
    v.input({ key: "pageDown" });
    v.input({ wheel: 3 });
    assert.ok(!screen(v).some((l) => l.includes("message 0 ")));
  });

  test("keys and the wheel as a terminal sends them", () => {
    assert.deepEqual(
      inputs("\x1b[A\x1b[B\x1b[5~\x1b[6~\x1b[H\x1b[F\x1b[1~\x1b[4~"),
      ["up", "down", "pageUp", "pageDown", "home", "end", "home", "end"].map((key) => ({ key })),
    );
    assert.deepEqual(inputs("\x1b[<64;10;5M\x1b[<65;10;5M"), [{ wheel: -3 }, { wheel: 3 }]);
    // Anything else (a click, typing, Ctrl+C, an unknown sequence) does nothing.
    assert.deepEqual(inputs("\x1b[<0;3;4Mhello\x03\x1b[99Z"), []);
  });
});

describe("the app's info, as the viewer reads it", () => {
  test("checked field by field; not JSON is nothing", () => {
    assert.deepEqual(parseInfo(JSON.stringify({ status: "ended" })), { status: "ended" });
    assert.deepEqual(parseInfo(JSON.stringify({ name: "x", where: "mars", status: "on fire", spoken: [{ at: 1, text: "a" }, { text: 2 }] })), { name: "x", spoken: [{ at: 1, text: "a" }] });
    assert.equal(parseInfo("{not json"), null);
  });
  test("who answers: its name cleaned and cut, its colour only as #rrggbb; no name, nothing", () => {
    assert.deepEqual(parseInfo(JSON.stringify({ agent: { name: "T3 Code", color: "#7878FF" } })), { agent: { name: "T3 Code", color: "#7878FF" } });
    assert.deepEqual(parseInfo(JSON.stringify({ agent: { name: "Codex\x1b[31m", color: "red" } })), { agent: { name: "Codex[31m" } });
    assert.equal(parseInfo(JSON.stringify({ agent: { name: "x".repeat(50) } }))?.agent?.name.length, 30);
    assert.deepEqual(parseInfo(JSON.stringify({ agent: { name: " ", color: "#7878FF" } })), {});
    assert.deepEqual(parseInfo(JSON.stringify({ agent: "Codex" })), {});
  });
});
