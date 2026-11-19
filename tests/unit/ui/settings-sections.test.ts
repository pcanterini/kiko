// The settings screen's other sections drawn for real with Ink (src/ui/settings.ts), at 80 columns
// (the pane opened on its own) and 120 (beside the list), as Settings → Account is
// (settings-account.test.ts): a line or two about the setting, dim (settings-options.ts
// SETTING_ABOUT), its label and value rows (SETTING_FACTS, SettingRow.facts), its note in yellow,
// all two columns in and wrapped between words (a command on a line of its own, never broken), then
// the options with their hints in one column. And the list: its labels' column never so wide that
// the values go. Every wait is for the frame showing what's expected (tests/support/ink.ts), never a
// fixed time.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Writable } from "node:stream";
import type { SettingRow } from "../../../src/core/ui-store.ts";
import { inkDone, keyboard, plain, untilFrame } from "../../support/ink.ts";

// Colours on, so what's yellow can be told (each test file runs in a process of its own); then the
// modules that draw, which read it as they load.
process.env.FORCE_COLOR = "1";
const React = (await import("react")).default;
const { render } = await import("ink");
const { Settings } = await import("../../../src/ui/settings.ts");
const { ui } = await import("../../../src/core/ui-store.ts");
const { SETTING_ABOUT, SETTING_FACTS, agentChoices } = await import("../../../src/core/settings-options.ts");
const { keyRowsFor } = await import("../../../src/core/keys.ts");

/**
 * The screen with `rows`, on `at`, `width` wide (opened at 80): the frame's lines, and what's yellow.
 * `ready`: text the pane's options bring (they come a frame later: choicesFor is async), waited for;
 * without it, the screen as first drawn (the list's, which needs nothing loaded).
 */
async function screen(rows: SettingRow[], at: string, width: 80 | 120, open = width === 80, ready?: string): Promise<{ framed: string[]; yellow: string[] }> {
  let raw = "";
  const out = new Writable({ write: (chunk, _enc, done) => (chunk.toString().trim() ? (raw = chunk.toString()) : null, done()) }) as Writable & { columns: number; rows: number };
  out.columns = width;
  out.rows = 40;
  const stdin = keyboard();
  const act = ui.act;
  ui.act = () => {};
  const s = { ...ui.state, screen: "settings" as const, settings: rows, settingsAt: at as SettingRow["key"] };
  const app = render(React.createElement(Settings, { s, width, height: 30 }), { stdout: out as never, stdin: stdin as never, patchConsole: false, interactive: true });
  try {
    await inkDone(app);
    if (open) stdin.write("\r");
    if (ready)
      await untilFrame(
        () => plain(raw),
        (f) => f.includes(ready) && (!open || f.includes("Settings › ")),
        `the pane's options (${ready})`,
      );
  } finally {
    app.unmount();
    ui.act = act;
  }
  const yellow = [...raw.matchAll(/\x1b\[33m((?:[^\x1b]|\x1b\[(?!39m)[0-9;]*m)*)\x1b\[39m/g)].map((m) => plain(m[1]));
  return {
    framed: plain(raw)
      .split("\n")
      .filter((l) => l.startsWith("│")),
    yellow,
  };
}

/**
 * The row's pane as drawn: its lines under its title (120: the right-hand pane; 80: inside the frame,
 * above the hints), trailing blanks gone, and the text drawn in yellow; once it shows `ready` (text of
 * its options, which come a frame later).
 */
async function pane(rows: SettingRow[], at: string, width: 80 | 120, ready: string): Promise<{ lines: string[]; yellow: string[] }> {
  const { framed, yellow } = await screen([...rows, ...LIST.filter((l) => !rows.some((r) => r.key === l.key))], at, width, width === 80, ready);
  const row = rows.find((r) => r.key === at)!;
  const lines =
    width === 120
      ? framed
          .map((l) => l.split("│"))
          .filter((parts) => parts.length === 4)
          .map((parts) => parts[2].slice(2).trimEnd())
      : framed.slice(1, -1).map((l) => l.slice(2, -1).trimEnd());
  if (width === 120) assert.equal(lines.shift(), row.label, "the pane's title");
  else assert.equal(framed[0].slice(2, -1).trim(), `Settings › ${row.label}`);
  while (lines.length && !lines.at(-1)) lines.pop();
  return { lines, yellow };
}

/** At both widths: the pane's lines (the text, then the options), and what's drawn yellow; the last option waited for. */
async function check(rows: SettingRow[], at: string, want: Record<80 | 120, string[]>, yellow: string[] = []) {
  for (const width of [80, 120] as const) {
    const got = await pane(rows, at, width, want[width].at(-1)!.slice(4));
    assert.deepEqual(got.lines, want[width], `${width} columns`);
    assert.deepEqual(got.yellow, yellow, `yellow at ${width} columns`);
  }
}

/** An option's line as drawn: the cursor on the first at 80 (the pane open), none at 120 (the list has it). */
const option = (width: 80 | 120, first: boolean, text: string, current = false) => `${width === 80 && first ? "▸ " : "  "}${current ? "● " : "  "}${text}`;

const row = (r: Partial<SettingRow> & Pick<SettingRow, "key" | "label" | "value">): SettingRow => ({ raw: "", restart: false, ...r });

/** Rows as long as the real screen's longest, beside every pane drawn: so at 120 the list takes half the screen, as it does. */
const LIST: SettingRow[] = [
  row({ key: "duckMusic", label: "Lower the volume while I talk", value: "On", raw: true }),
  row({ key: "pttMode", label: "Push-to-talk style", value: "Hold the key while talking", raw: "hold", restart: true }),
];

describe("Settings' sections at 80 and 120 columns", () => {
  test("Agents → Claude Code: a two-line about, its hooks file as a row, the actions' hints in one column", async () => {
    const raw = JSON.stringify({ state: "not connected", detail: "adds hooks to ~/.claude/settings.json", file: "~/.claude/settings.json" });
    const rows = [row({ key: "agent:claude-code", label: "Claude Code", value: "Not connected", raw, facts: [{ label: "Hooks in", value: "~/.claude/settings.json" }] })];
    await check(rows, "agent:claude-code", {
      80: [
        "  Claude Code's sessions reach Kiko through hooks in its settings file, next",
        "  to yours. Sessions already open pick them up when restarted.",
        "  Hooks in  ~/.claude/settings.json",
        "",
        option(80, true, "Connect   adds Kiko's hooks, backed up first"),
        option(80, false, "Leave it"),
      ],
      120: [
        "  Claude Code's sessions reach Kiko through hooks in",
        "  its settings file, next to yours. Sessions already",
        "  open pick them up when restarted.",
        "  Hooks in  ~/.claude/settings.json",
        "",
        option(120, true, "Connect   adds Kiko's hooks, backed up first"),
        option(120, false, "Leave it"),
      ],
    });
  });

  test("Agents: one needing repair says why in yellow, capitalised, once (Repair's hint says what it does)", async () => {
    const detail = "its hook points at ~/old/hooks/claude.mjs, which is gone";
    const raw = JSON.stringify({ state: "needs repair", detail, file: "~/.claude/settings.json" });
    const rows = [
      row({
        key: "agent:claude-code",
        label: "Claude Code",
        value: "Needs repair",
        raw,
        note: "Its hook points at ~/old/hooks/claude.mjs, which is gone",
        facts: [{ label: "Hooks in", value: "~/.claude/settings.json" }],
      }),
    ];
    const got = await pane(rows, "agent:claude-code", 80, "Leave it");
    assert.deepEqual(got.lines.slice(2), [
      "  Hooks in  ~/.claude/settings.json",
      "  Its hook points at ~/old/hooks/claude.mjs, which is gone",
      "",
      option(80, true, "Repair      fixes Kiko's hooks, backed up first"),
      option(80, false, "Disconnect  takes out only Kiko's hooks, backed up first"),
      option(80, false, "Leave it"),
    ]);
    assert.deepEqual(got.yellow, ["Its hook points at ~/old/hooks/claude.mjs, which is gone"]);
  });

  test("Agents: one with nothing to set up, not installed, offers to turn it on (never 'adds hooks to ,')", () => {
    const choices = agentChoices({ state: "not installed", detail: "", file: "", nothing: true });
    assert.deepEqual(
      choices.map((c) => [c.value, c.label, c.hint]),
      [
        ["connect", "Turn on", "Kiko connects once it's running"],
        ["keep", "Leave it off", undefined],
      ],
    );
  });

  test("Keys → OpenRouter: what it's for, the command as a row, and Needed in yellow; no paragraph", async () => {
    const rows = keyRowsFor({ chosen: { stt: "apple", tts: "say", llm: "deepseek/deepseek-v4.1-flash" }, env: {}, sources: {}, keychain: new Set(), unchecked: null, store: true });
    assert.equal(rows[0].note, "Needed: the model is on OpenRouter");
    await check(
      rows,
      "key:openrouter",
      {
        80: [
          "  The one key: every model and the classifier.",
          "  In a terminal  kiko-dev keys set openrouter",
          "  Needed: the model is on OpenRouter",
          "",
          option(80, true, "Enter a key…  checked with OpenRouter, then kept in the Keychain"),
          option(80, false, "Leave it"),
        ],
        120: [
          "  The one key: every model and the classifier.",
          "  In a terminal  kiko-dev keys set openrouter",
          "  Needed: the model is on OpenRouter",
          "",
          option(120, true, "Enter a key…  checked with OpenRouter, then kept …"),
          option(120, false, "Leave it"),
        ],
      },
      ["Needed: the model is on OpenRouter", "Enter a key…"],
    );
  });

  test("Updates → Version: the commands as labels, their values in one column", async () => {
    const raw = JSON.stringify({ running: "0.2.3", installed: false, auto: true });
    const rows = [row({ key: "updates", label: "Version", value: "0.2.3 · a development copy", raw })];
    const got = await pane(rows, "updates", 120, "Nothing to do");
    assert.deepEqual(got.lines, [
      "  Kiko looks for a new version once a day. Nothing",
      "  restarts under you: a new one starts the next time",
      "  Kiko does.",
      "  kiko-dev update             installs the newest now",
      "  kiko-dev update --rollback  goes back one version",
      "",
      option(120, true, "Nothing to do  a development copy: git pull updat…"),
    ]);
  });

  test("The window → Nerd Font icons: each command on a line of its own, never broken in two", async () => {
    const rows = [row({ key: "icons", label: "Nerd Font icons", value: "Off", raw: "unicode" })];
    for (const width of [80, 120] as const) {
      const { lines } = await pane(rows, "icons", width, "plain marks");
      assert.ok(lines.includes("  brew install --cask font-symbols-only-nerd-font"), `${width}: the brew command whole`);
      assert.ok(lines.includes('  font-family = "Symbols Nerd Font Mono"'), `${width}: Ghostty's line whole`);
    }
  });

  test("New sessions → Permission mode: scratch sessions' auto and what other agents get, as rows, wrapped under the value column", async () => {
    const rows = [row({ key: "newSessionMode", label: "Permission mode", value: "Accept edits", raw: "acceptEdits" })];
    const got = await pane(rows, "newSessionMode", 120, "Your Claude Code default");
    assert.deepEqual(got.lines.slice(0, 8), [
      "  The permission mode a session Kiko opens starts in.",
      "  Sessions you start yourself aren't touched.",
      "  Scratch   Auto in Claude Code until you pick a mode",
      "  Codex     the nearest it has: Ask me is read-only,",
      "            Accept edits workspace-write, Auto its",
      "            reviewer",
      "  OpenCode  no flag for any of them",
      "",
    ]);
  });

  test("Permissions → Safety gate: a short label, two rows under its about, the kinds' hints in one column", async () => {
    const rows = [row({ key: "guard", label: "Safety gate", value: "Off", raw: JSON.stringify({ on: false, off: [] }) })];
    const got = await pane(rows, "guard", 80, "Posts: doesn't ask");
    assert.deepEqual(got.lines.slice(2, 4), ["  Works with  Claude Code and Codex CLI, while Kiko is running", "  Each kind   Enter turns it off, or back on"]);
    const options = got.lines.slice(5).map((l) => l.slice(4));
    assert.equal(options.length, 6, "on, off, and the four kinds");
    const hintAt = new Set(options.map((l) => l.search(/(?<=\S {2,})\S/)));
    assert.equal(hintAt.size, 1, `the hints in one column: ${options.join(" | ")}`);
  });

  test("a restart and a note: two columns in, as the about (never at the edge, never a space short or over)", async () => {
    const rows = [row({ key: "tts", label: "Voice engine", value: "macOS voice", raw: "say", restart: true, note: "KIKO_TTS in .env wins" })];
    await check(
      rows,
      "tts",
      {
        80: [
          "  What reads things out loud. Picking one without its key asks for the key.",
          "  KIKO_TTS in .env wins",
          "  ↻ restarts the app when you close settings",
          "",
          // At 80 the cursor opens on the one chosen.
          option(80, false, "Cartesia · needs a key  natural; about half a cent per spoken summary"),
          option(80, false, "Pocket TTS              free, runs on your Mac; first use downloads ~22…"),
          `▸ ● macOS voice             free, built in, more robotic`,
        ],
        120: [
          "  What reads things out loud. Picking one without its",
          "  key asks for the key.",
          "  KIKO_TTS in .env wins",
          "  ↻ restarts the app when you close settings",
          "",
          option(120, true, "Cartesia · needs a key  natural; about half a cen…"),
          option(120, false, "Pocket TTS              free, runs on your Mac; f…"),
          option(120, false, "macOS voice             free, built in, more robo…", true),
        ],
      },
      ["KIKO_TTS in .env wins", " · needs a key"],
    );
  });

  test("Phone → Connect to with Phone off: what its row says, not 'Nothing matches.'", async () => {
    const rows = [row({ key: "phoneConnect", label: "Connect to", value: "Turn Phone on first", raw: "[]" })];
    // Its one line comes with the options (none): the row's value.
    const got = await pane(rows, "phoneConnect", 80, "Turn Phone on first");
    assert.equal(got.lines.at(-1), "    Turn Phone on first");
    assert.ok(!got.lines.some((l) => l.includes("Nothing matches")));
  });

  test("Pair a phone's PRO: the offer first in yellow, the about under it, the same two columns in", async () => {
    const offer = "The iPhone app comes with Kiko Pro: $8.99 a month or $89 a year, Kiko's AI included.";
    const rows = [row({ key: "phonePair", label: "Pair a phone", value: "With Kiko Pro or the free trial", raw: JSON.stringify({ offer: true, trial: true }), tag: "PRO", note: offer })];
    const got = await pane(rows, "phonePair", 80, "Kiko Pro, yearly");
    assert.deepEqual(got.lines.slice(0, 3), [
      "  The iPhone app comes with Kiko Pro: $8.99 a month or $89 a year, Kiko's AI",
      "  included.",
      "  Scan the QR code with the iPhone's Camera or the Kiko app: it pairs at",
    ]);
    // The list at 80: the badge after the value, and the offer left to the pane.
    const { framed } = await screen(rows, "phonePair", 80, false);
    const line = framed.find((l) => l.includes("Pair a phone"))!;
    assert.match(line, /Pair a phone {2,}With Kiko Pro or the free trial PRO\s+│$/);
  });

  test("every about is short: each line of it at most two lines at 120 columns' pane, or a command", () => {
    for (const [key, about] of Object.entries(SETTING_ABOUT)) {
      for (const line of about.split("\n")) assert.ok(line.length <= 150, `${key}: “${line}” (${line.length})`);
      assert.ok(about.length <= 260, `${key}: ${about.length} characters`);
    }
    assert.equal(SETTING_ABOUT.account, undefined, "the account's pane is its rows");
    assert.ok(Object.values(SETTING_FACTS).every((facts) => facts.every((f) => f.value.trim())));
  });
});

describe("the list", () => {
  const ROWS = [
    row({ key: "agent:claude-code", label: "Claude Code", value: "Connected" }),
    row({ key: "guard", label: "Safety gate", value: "On, except deletes" }),
    row({ key: "duckMusic", label: "Lower the volume while I talk", value: "On" }),
    row({ key: "icons", label: "A label far too long for the list's labels column", value: "Off" }),
  ];

  test("at 120 every value shows beside its label; a label past the column is cut short, never the values", async () => {
    const { framed } = await screen(ROWS, "guard", 120, false);
    const left = framed.map((l) => l.split("│")[1] ?? "");
    // The labels' column: the longest that fits (30) and two spaces.
    assert.ok(
      left.some((l) => /^ {3}Claude Code {21}Connected/.test(l)),
      left.join("\n"),
    );
    assert.ok(left.some((l) => /^ ▸ Safety gate {21}On, except deletes/.test(l)));
    assert.ok(left.some((l) => /^ {3}Lower the volume while I talk {3}On/.test(l)));
    assert.ok(left.some((l) => /^ {3}A label far too long for the… {3}Off/.test(l)));
  });
});
