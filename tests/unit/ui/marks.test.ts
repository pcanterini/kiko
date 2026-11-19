// Each session's agent mark (src/ui/marks.ts, from each adapter's Agent.mark): one per agent,
// none of them named outside the adapters; a plain ◇ for an agent with none; the Nerd Font icon
// with icons "nerd" where an agent has one. The window's list draws it before each name, mark and
// name in the harness's colour (no colour of a session's own any more), Kiko's row in the
// terminal's own colour; the card and the new-session picker show it too; columns stay lined up.
// Each mark has a slot of MARK_SLOT cells (the glyph, a blank, a space), so a glyph a fallback font
// draws wider than its cell spills into its own blank, never into the name: every built-in mark is
// one whose widest drawing on a Mac is measured to fit (VETTED, below).
import "../../setup.ts";
import "../../support/force-color.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { describe, test } from "node:test";
import React from "react";
import { render } from "ink";
import { inkDone } from "../../support/ink.ts";
import { agents, agentOf } from "../../../src/agents/index.ts";
import { claudeCode } from "../../../src/agents/claude-code/index.ts";
import { codex } from "../../../src/agents/codex/index.ts";
import { opencode } from "../../../src/agents/opencode/index.ts";
import { t3code } from "../../../src/agents/t3code/index.ts";
import type { Session } from "../../../src/core/sessions.ts";
import { iconsSetting } from "../../../src/core/settings.ts";
import { choicesFor, ICONS, SETTING_GROUPS } from "../../../src/core/settings-options.ts";
import { ui, type AgentAsk, type UiState } from "../../../src/core/ui-store.ts";
import { MARK_SLOT, markFor, markOf, oneCell, PLAIN_MARK, sessionMark, slotted, speakerOf } from "../../../src/ui/marks.ts";
import { sessionPage } from "../../../src/ui/nav.ts";
import { parseInfo } from "../../../src/ui/viewer.ts";
import { viewerInfo } from "../../../src/ui/window-glue.ts";
import { agentPicker } from "../../../src/ui/agent-picker.ts";
import { MenuView } from "../../../src/ui/menu-view.ts";
import { WindowList } from "../../../src/ui/window-list.ts";

// Ink's own width measure (string-width), as Ink resolves it.
const fromInk = createRequire(import.meta.resolve("ink"));
const { default: stringWidth } = (await import(fromInk.resolve("string-width"))) as { default: (s: string) => number };

const session = (name: string, fields: Partial<Session> = {}) =>
  ({
    sessionId: name,
    cwd: `/code/${name}`,
    givenName: name,
    kind: "interactive",
    status: "idle",
    desktop: false,
    place: { via: "tmux", id: `%${name}`, keys: true, pid: 1 },
    mapping: "none",
    nameSetBy: "user",
    ...fields,
  }) as unknown as Session;
const state = (patch: Partial<UiState>): UiState => ({ ...ui.state, about: { ...ui.state.about, hotkey: "right_option" }, sessionsLoaded: true, ...patch });
const plain = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
/**
 * The glyphs a built-in mark may be, each with the widest any Mac font that has it draws it (its
 * advance, in cells of the coding font: 0.6 em, FiraMono's and Menlo's), which must fit the room
 * the slot gives the glyph (MARK_SLOT less the space before the name). Read 2026-10-30 from the
 * fonts' tables with fontTools. "The nine": Menlo, SF Mono, Monaco, Fira Mono, Fira Code, JetBrains
 * Mono, Hack, Meslo LG, Source Code Pro. A terminal draws a glyph its font lacks from a fallback
 * font: Ghostty takes a monospace one with the glyph first (one cell; its own JetBrains Mono among
 * them), else the font with the most glyphs (Arial Unicode MS, which Ghostty also scales to the main
 * font, by at most 1.2 against FiraMono); Terminal.app and iTerm2 take CoreText's choice. The widest
 * is the widest of every font on the Mac that has the glyph, whichever a terminal picks.
 */
const VETTED: Record<string, { widest: number; why: string }> = {
  "✻": {
    widest: 1.18,
    why: "U+273B Claude Code: in Menlo and Meslo (Ghostty: Menlo's or Meslo's, one cell); Zapf Dingbats' or Arial Unicode MS's, 1.18, from an old patched Nerd Font in Terminal.app or iTerm2",
  },
  "⌬": {
    widest: 1.58,
    why: "U+232C Codex: in none of the nine nor Menlo. Ghostty: Arial Unicode MS's, 0.91 at its size, so 1.09 scaled; Terminal.app and iTerm2: Apple Symbols', 1.08 to 1.11; STIX Two Math's 1.58 the widest",
  },
  "⊤": { widest: 1.25, why: "U+22A4 T3 Code: in Fira Code, JetBrains Mono, Hack (Ghostty: its own JetBrains Mono's, one cell); Apple Symbols', 1.21 to 1.25, in Terminal.app and iTerm2" },
  "▣": { widest: 1.55, why: "U+25A3 OpenCode: in Menlo, Fira Mono, Fira Code, Hack, Meslo; Menlo's elsewhere (one cell); STIX Two Math's 1.55 the widest" },
  "◇": { widest: 1.81, why: "U+25C7 any other agent: in all of the nine but SF Mono, Monaco and Source Code Pro; Menlo's there (one cell); STIX Two Math's 1.81 the widest" },
  π: { widest: 1.13, why: "U+03C0 Pi (no adapter yet): in all nine; Arial Unicode MS's 1.13 the widest" },
};

/** The truecolor SGR for a hex colour, as chalk writes it. */
const sgr = (hex: string) => `\u001b[38;2;${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";")}m`;

/** The list drawn in a pane `columns` wide: its last screen, with its colours. */
async function drawn(s: UiState, columns = 40, rows = 20) {
  let text = "";
  const stdout = Object.assign(new Writable({ write: (chunk, _enc, done) => ((text += chunk.toString()), done()) }), { columns, rows, isTTY: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  const app = render(React.createElement(WindowList, { s }), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, interactive: true });
  // Drawn through, its effects' frame too (tests/support/ink.ts), never a fixed time.
  await inkDone(app);
  app.unmount();
  return (text.split("\u001b[2J").at(-1) ?? text).split("\n");
}

describe("the marks", () => {
  test("each adapter brings its own: Claude Code ✻ orange, Codex ⌬ blue, OpenCode ▣ peach, T3 Code ⊤ indigo (the dark-background colours)", () => {
    assert.deepEqual(markOf(claudeCode), { glyph: "✻", color: "#D77757" });
    assert.deepEqual(markOf(codex), { glyph: "⌬", color: "#63A8F8" });
    assert.deepEqual(markOf(opencode), { glyph: "▣", color: "#FAB283" });
    assert.deepEqual(markOf(t3code), { glyph: "⊤", color: "#7878FF" });
    // A light background's, for when the list can tell.
    assert.deepEqual(
      [claudeCode, codex, opencode, t3code].map((a) => markOf(a, "unicode", "light").color),
      ["#C15F3C", "#1C64C8", "#9C6B12", "#5A3FD8"],
    );
  });
  test("an agent with no mark of its own, or none at all: a plain ◇ in the terminal's own colour", () => {
    const bare = { mark: undefined };
    assert.deepEqual(markOf(bare), { glyph: "◇", color: undefined });
    assert.deepEqual(markOf(null), { glyph: "◇", color: undefined });
    assert.equal(PLAIN_MARK.glyph, "◇");
    assert.deepEqual(markOf(bare, "nerd"), { glyph: "◇", color: undefined });
  });
  test("a glyph that isn't one cell (an emoji, a wide or combining character, two characters, a control) is drawn as the plain one, in the agent's colour", () => {
    const color = { dark: "#123456", light: "#654321" };
    for (const glyph of ["🤖", "✳️", "漢", "ab", "", " ", "\u001b", "e\u0301", "\u200d"]) {
      assert.equal(oneCell(glyph), false, JSON.stringify(glyph));
      assert.deepEqual(markOf({ mark: { glyph, color } }), { glyph: "◇", color: "#123456" }, JSON.stringify(glyph));
    }
    // The built-in marks are kept as they are, however wide a fallback font draws them: their slot has room.
    for (const glyph of ["✻", "⌬", "⊤", "▣", "◇", "π", "\uec82", "\u{f0001}"]) assert.ok(oneCell(glyph), glyph);
    // A Nerd Font icon that isn't one cell: the glyph instead.
    assert.equal(markOf({ mark: { glyph: "⌬", nerd: "🤖" } }, "nerd").glyph, "⌬");
  });
  test("every built-in mark is a vetted glyph: one cell as Ink counts it, its widest drawing on a Mac within its slot, none like another", async () => {
    const builtIn = agents.map((a) => a.mark!.glyph);
    for (const glyph of [...builtIn, PLAIN_MARK.glyph]) {
      assert.ok(VETTED[glyph], `${glyph} U+${glyph.codePointAt(0)!.toString(16).toUpperCase()} isn't vetted: measure the widest any Mac font that has it draws it, then add it to VETTED`);
    }
    for (const [glyph, { widest }] of Object.entries(VETTED)) {
      assert.ok(oneCell(glyph), glyph);
      assert.equal(stringWidth(glyph), 1, glyph);
      assert.ok(widest <= MARK_SLOT - 1, `${glyph} drawn ${widest} cells wide fits the slot's ${MARK_SLOT - 1}`);
    }
    // Kiko's own row, as the list draws it: the brand's square in the slot (src/ui/wordmark.ts: why ▪), not an agent's mark.
    const rows = (await drawn(state({ window: { shown: null, note: "" }, sessions: [] }))).map(plain);
    assert.match(rows.find((r) => r.includes(" Kiko"))!, /^ {2}0 {3}▪ {2}Kiko\b/);
    // The marks ARCHITECTURE.md lists (Pi's, for later, too), each vetted.
    const doc = readFileSync(new URL("../../../ARCHITECTURE.md", import.meta.url), "utf8");
    const after = doc.slice(doc.indexOf("- **The marks:**")).split("\n");
    const from = after.findIndex((l) => l.startsWith("  |"));
    const table = after
      .slice(
        from,
        after.findIndex((l, i) => i > from && !l.startsWith("  |")),
      )
      .slice(2); // past its head and rule
    const listed = table.map((l) => /\| `(.)` U\+/.exec(l)?.[1]);
    assert.ok(listed.length >= 6 && listed.every(Boolean), JSON.stringify(table));
    for (const glyph of listed) assert.ok(VETTED[glyph!], `ARCHITECTURE lists ${glyph}`);
    assert.equal(new Set([...builtIn, PLAIN_MARK.glyph, "π"]).size, builtIn.length + 2, "each its own");
  });
  test("icons \"nerd\": the Nerd Font icon where the agent has one (Claude Code's, Codex's), else its glyph", () => {
    assert.equal(markOf(claudeCode, "nerd").glyph, "");
    assert.equal(markOf(codex, "nerd").glyph, "");
    assert.equal(markOf(t3code, "nerd").glyph, "⊤");
    assert.equal(markOf(opencode, "nerd").glyph, "▣", "no Nerd Font icon of its own");
    assert.equal(markOf(claudeCode, "nerd").color, "#D77757", "the same colour");
  });
  test("every agent has one: one cell wide as Ink counts it, no emoji, each glyph and colour its own", () => {
    const marks = agents.map((a) => a.mark);
    for (const [i, m] of marks.entries()) {
      assert.ok(m, `${agents[i].id} has a mark`);
      assert.equal(stringWidth(m.glyph), 1, m.glyph);
      assert.ok(!/\p{Extended_Pictographic}/u.test(m.glyph), `${m.glyph} isn't an emoji`);
      if (m.nerd) assert.equal(stringWidth(m.nerd), 1, "a Nerd Font icon counts one cell too");
    }
    assert.equal(new Set(marks.map((m) => m!.glyph)).size, marks.length);
    assert.equal(new Set(marks.map((m) => m!.color?.dark)).size, marks.length);
  });
  test("a session's is its agent's: two Claude Code sessions share one, whatever their IDs and folders; a Codex one has Codex's", () => {
    const a = sessionMark(session("pixie"));
    const b = sessionMark(session("lacy", { cwd: "/elsewhere/clipkit" }));
    assert.deepEqual(a, b);
    assert.deepEqual(a, markOf(claudeCode));
    assert.deepEqual(sessionMark(session("api", { agent: codex.id })), markOf(codex));
    assert.equal(agentOf(session("api", { agent: codex.id })), codex);
  });
  test("a line or card's, by its session's ID (an alias too); null for one no longer listed (the terminal's colour)", () => {
    const sessions = [session("pixie", { aliases: ["old-id"] } as Partial<Session>), session("api", { agent: codex.id })];
    assert.deepEqual(markFor(sessions, "api"), markOf(codex));
    assert.deepEqual(markFor(sessions, "old-id"), markOf(claudeCode));
    assert.equal(markFor(sessions, "gone"), null);
    assert.equal(markFor(sessions, undefined), null);
  });
  test("who answers, for an outside session's viewer: each harness's own name in its mark's colour (Claude for Claude Code, T3 Code's threads by the harness)", () => {
    const sessions: [Session, string, string][] = [
      [session("pixie"), "Claude", "#D77757"],
      [session("api", { agent: codex.id }), "Codex", "#63A8F8"],
      [session("site", { agent: opencode.id }), "OpenCode", "#FAB283"],
      [session("t3-thread", { agent: t3code.id }), "T3 Code", "#7878FF"],
    ];
    for (const [s, name, color] of sessions) assert.deepEqual(speakerOf(s), { name, color }, s.sessionId);
    // Every adapter has one, never Claude's but for Claude Code's.
    for (const a of agents) {
      const said = speakerOf(session(`x-${a.id}`, { agent: a.id }));
      assert.equal(said.name, a.speaker ?? a.name, a.id);
      assert.equal(said.color, markOf(a).color, a.id);
      if (a !== claudeCode) assert.notEqual(said.name, "Claude", a.id);
    }
    // And the app sends it with the session to its viewer (window.ts viewerInfo, VIEWER_INFO's JSON).
    const listed = sessions.map(([s]) => ({ ...s, place: null }) as Session);
    for (const [s, name, color] of sessions) {
      const info = parseInfo(JSON.stringify(viewerInfo(state({ sessions: listed }), sessionPage(s.sessionId))));
      assert.deepEqual(info?.agent, { name, color }, s.sessionId);
    }
  });
  test("no colour of a session's own is left: the old palette and its helpers are gone from src/", () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith(".ts") ? [join(dir, f)] : []));
    const src = new URL("../../../src/", import.meta.url).pathname;
    const left = files(src).filter((f) => /\bcolorFor\b|\bsessionColor\b|\blineColor\b|const PALETTE\b|#f96b38|#6394f6/i.test(readFileSync(f, "utf8")));
    assert.deepEqual(left, []);
  });
});

describe("the setting", () => {
  test('icons: "nerd" however written, anything else plain Unicode (the default)', () => {
    assert.equal(iconsSetting(undefined), "unicode");
    assert.equal(iconsSetting(""), "unicode");
    assert.equal(iconsSetting("unicode"), "unicode");
    assert.equal(iconsSetting(" Nerd "), "nerd");
    assert.equal(iconsSetting("emoji"), "unicode");
    assert.equal(iconsSetting(true), "unicode");
  });
  test("in settings under the Kiko window, Off (the default) and On", async () => {
    assert.ok(SETTING_GROUPS.find((g) => g.title === "The Kiko window")?.keys.includes("icons"));
    const { choices } = await choicesFor("icons", { tts: "say", current: "unicode" });
    assert.deepEqual(
      choices.map((c) => [c.value, c.label]),
      [
        ["unicode", "Off"],
        ["nerd", "On"],
      ],
    );
    assert.equal(choices, ICONS);
    assert.match(ICONS[1].hint ?? "", /Nerd Fonts 3\.5 or newer/);
  });
});

describe("the list", () => {
  const sessions = [session("pixie"), session("api", { agent: codex.id }), session("board", { agent: t3code.id, place: null })];

  test("a row: its mark in its slot, then its name, both in the harness's colour; Kiko's own row the brand's square in the slot and its name bold, never a session's colour", async () => {
    const rows = await drawn(state({ window: { shown: "%pixie", note: "" }, sessions }));
    const row = (name: string) => rows.find((r) => plain(r).includes(` ${name} `))!;
    assert.match(row("pixie"), new RegExp(`${sgr("#D77757").replace(/\[/g, "\\[")}(?:\\u001b\\[[0-9;]*m)*✻  pixie`));
    assert.match(row("api"), new RegExp(`${sgr("#63A8F8").replace(/\[/g, "\\[")}(?:\\u001b\\[[0-9;]*m)*⌬  api`));
    assert.match(row("board"), new RegExp(`${sgr("#7878FF").replace(/\[/g, "\\[")}(?:\\u001b\\[[0-9;]*m)*⊤  board`));
    // The brand's square in the mark's slot, then the name (src/ui/wordmark.ts: its colours there).
    const kiko = rows.find((r) => plain(r).includes("▪  Kiko"))!;
    for (const hex of ["#D77757", "#63A8F8", "#7878FF"]) assert.ok(!kiko.includes(sgr(hex)), `not ${hex}`);
    assert.match(kiko, /▪(?:\u001b\[[0-9;]*m)* {2}(?:\u001b\[[0-9;]*m)*\u001b\[1m(?:\u001b\[[0-9;]*m)*Kiko(?:\u001b\[[0-9;]*m)*$/);
  });

  test("columns line up: marks in one column, a blank and a space after each (room for a glyph drawn wide), names all in the next, Kiko's too; the states ending together", async () => {
    const all = [session("pixie"), session("api", { agent: codex.id }), session("board", { agent: t3code.id }), session("notes", { agent: opencode.id })];
    const rows = (await drawn(state({ window: { shown: null, note: "" }, sessions: all }))).map(plain);
    const of = (name: string) => rows.find((r) => r.includes(` ${name} `))!;
    const names = ["pixie", "api", "board", "notes"];
    const lines = names.map(of);
    assert.deepEqual(
      lines.map((l, i) => l.indexOf(["✻", "⌬", "⊤", "▣"][i])),
      [6, 6, 6, 6],
    );
    assert.deepEqual(
      lines.map((l, i) => l.indexOf(names[i])),
      [9, 9, 9, 9],
    );
    assert.equal(rows.find((r) => r.includes("Kiko"))!.indexOf("Kiko"), 9);
    assert.equal(new Set(lines.map((l) => l.trimEnd().length)).size, 1);
    assert.match(lines[0], /^ {2}1 {3}✻ {2}pixie +● idle$/);
    assert.equal(MARK_SLOT, 3);
    assert.equal(slotted("⌬"), "⌬  ");
  });

  test("icons \"nerd\": Claude Code's and Codex's icons, T3 Code's glyph; still lined up", async () => {
    const rows = (await drawn(state({ icons: "nerd", window: { shown: null, note: "" }, sessions }))).map(plain);
    const of = (name: string) => rows.find((r) => r.includes(` ${name} `))!;
    assert.match(of("pixie"), /\uec82  pixie/);
    assert.match(of("api"), /\uec81  api/);
    assert.match(of("board"), /⊤  board/);
    assert.equal(new Set(["pixie", "api", "board"].map((n) => of(n).indexOf(n))).size, 1);
    assert.equal(new Set(["pixie", "api", "board"].map((n) => of(n).trimEnd().length)).size, 1);
  });

  test("the card: who asks with its agent's mark in its slot, in its colour; a session no longer listed, its name alone", async () => {
    const permission = { id: "p1", sessionId: "api", name: "api", what: "run pnpm test", risky: false };
    const all = await drawn(state({ window: { shown: null, note: "" }, permission, sessions }));
    const rows = all.slice(all.findIndex((r) => /╭─+╮/.test(plain(r)))); // the card, at the bottom
    assert.match(plain(rows[1]), /│ ⚠ ⌬ {2}api +│/);
    assert.ok(rows[1].includes(`${sgr("#63A8F8")}`), rows[1]);
    assert.equal(plain(rows[1]).length, plain(rows[0]).length, "its border where the top's is");
    const gone = await drawn(state({ window: { shown: null, note: "" }, permission: { ...permission, sessionId: "gone", name: "gone" }, sessions }));
    assert.match(plain(gone[gone.findIndex((r) => /╭─+╮/.test(plain(r))) + 1]), /│ ⚠ gone +│/);
  });
});

describe("the new-session picker", () => {
  const ask: AgentAsk = {
    ask: "a1b2c3d4",
    folder: "clipkit",
    rows: [
      { id: "claude-code", name: "Claude Code", mark: { glyph: "✻", color: "#D77757" } },
      { id: "codex", name: "Codex", note: "last used", mark: { glyph: "⌬", color: "#63A8F8" } },
      { id: "other", name: "Other", mark: { glyph: "◇" } },
    ],
    selected: "codex",
  };
  test("each row: its agent's mark in its colour and its slot, then its name; lined up; the chosen row keeps its mark's colour", () => {
    const view = new MenuView(agentPicker(ask, (verb, arg) => [verb, arg]));
    const lines = view.frame(40, 8);
    assert.match(plain(lines[2]), /^ ✻ {2}Claude Code\s*$/);
    assert.match(plain(lines[3]), /^ ⌬ {2}Codex last used\s*$/);
    assert.match(plain(lines[4]), /^ ◇ {2}Other\s*$/);
    assert.ok(lines[2].includes(`${sgr("#D77757")}✻`), lines[2]);
    assert.ok(lines[3].includes("38;2;99;168;248m⌬"), "chosen, and still Codex's blue");
    assert.ok(!lines[4].includes("38;2;"), "no colour: the terminal's own");
    assert.equal(new Set(lines.slice(2, 5).map((l) => stringWidth(plain(l)))).size, 1);
  });
  test("a colour that isn't #rrggbb is left out; a glyph with escapes in it is drawn plain", () => {
    const bad: AgentAsk = { ...ask, rows: [{ id: "x", name: "X", mark: { glyph: "\u001b[2J", color: "red;5m" } }], selected: "x" };
    const line = new MenuView(agentPicker(bad, (verb, arg) => [verb, arg])).frame(30, 3)[2];
    assert.ok(!line.includes("\u001b[2J") && !line.includes("red;5m"), JSON.stringify(line));
  });
  test("a mark that isn't one cell (an emoji, a wide character) is a blank: the row keeps its slot, still lined up", () => {
    const odd: AgentAsk = { ...ask, rows: [...ask.rows, { id: "e", name: "Emoji", mark: { glyph: "🤖" } }, { id: "w", name: "Wide", mark: { glyph: "漢" } }] };
    const lines = new MenuView(agentPicker(odd, (verb, arg) => [verb, arg])).frame(40, 10);
    assert.match(plain(lines[5]), /^ {4}Emoji\s*$/);
    assert.match(plain(lines[6]), /^ {4}Wide\s*$/);
    assert.equal(new Set(lines.slice(2, 7).map((l) => stringWidth(plain(l)))).size, 1);
  });
});
