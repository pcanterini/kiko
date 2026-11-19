// A block allowed anyway (src/core/block-override.ts). Claude Code's auto
// mode blocked Lacy's Cloudflare change with no prompt, and "go ahead" didn't count. Now a block is a
// card ("Auto mode blocked Lacy from running wrangler deploy. Allow it?"), and a yes takes the session
// out of auto mode with Shift+Tab, its screen read back after each press, and asks it to try again.
//
// The screens are Claude Code 2.1.314's, composed from its own strings (its mode table's indicators,
// the footer's "{symbol} {indicator} on", "? for shortcuts" in manual mode) and the input box as a real
// one shows it (tests/support/screens/trust/claude-prompt.txt). The fake TUI's Shift+Tab cycle is
// set per test: what's enabled changes it, so a press is never counted blindly.
import "../../setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  BlockOverride,
  isOverride,
  MAX_PRESSES,
  overridable,
  overrideAsk,
  overrideWhat,
  readScreenMode,
  retryLine,
  switchMode,
  switchTarget,
  type ModeKeys,
} from "../../../src/core/block-override.ts";
import type { Blocked, PermissionMode } from "../../../src/core/permission-mode.ts";

const RULE = "─".repeat(78);
const SYMBOL: Record<PermissionMode, string> = { default: "", acceptEdits: "⏵⏵", plan: "⏸", auto: "⏵⏵", bypassPermissions: "⏵⏵", dontAsk: "⏵⏵" };
const INDICATOR: Record<PermissionMode, string> = { default: "", acceptEdits: "accept edits", plan: "plan mode", auto: "auto mode", bypassPermissions: "bypass permissions", dontAsk: "don't ask" };

/** Claude Code's screen in `mode`: its conversation, the input box, the footer (busy: "esc to interrupt"). */
function claudeScreen(mode: PermissionMode, o: { busy?: boolean; draft?: string; status?: string } = {}) {
  const footer = mode === "default" ? (o.busy ? "  esc to interrupt" : "  ? for shortcuts") : `  ${SYMBOL[mode]} ${INDICATOR[mode]} on (shift+tab to cycle)${o.busy ? " · esc to interrupt" : ""}`;
  return [
    "⏺ I'll deploy the worker now.",
    "",
    "⏺ Bash(wrangler deploy --env production)",
    "  ⎿  Error: Permission for this action was denied by auto mode.",
    "",
    RULE,
    `❯ ${o.draft ?? ""}`,
    RULE,
    footer,
    ...(o.status ? [o.status] : []),
    "",
  ].join("\n");
}

/** A permission dialog up instead of the input box. */
const DIALOG = [
  RULE,
  " Bash command",
  "",
  "   wrangler deploy --env production",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. No, and tell Claude what to do differently (esc)",
  "",
  " Esc to cancel",
].join("\n");

describe("its mode, read off its screen", () => {
  test("each mode by its footer; none is manual mode; busy, a status line, a draft: the same", () => {
    for (const mode of ["acceptEdits", "plan", "auto", "bypassPermissions", "dontAsk"] as const) assert.equal(readScreenMode(claudeScreen(mode)), mode, mode);
    assert.equal(readScreenMode(claudeScreen("default")), "default");
    assert.equal(readScreenMode(claudeScreen("auto", { busy: true })), "auto");
    assert.equal(readScreenMode(claudeScreen("default", { busy: true })), "default");
    assert.equal(readScreenMode(claudeScreen("acceptEdits", { status: "  🎙 Kiko · listening" })), "acceptEdits");
    assert.equal(readScreenMode(claudeScreen("auto", { draft: "and then the docs" })), "auto");
    assert.equal(readScreenMode(claudeScreen("dontAsk").replace("don't", "don’t")), "dontAsk", "a typographic apostrophe");
    assert.equal(readScreenMode(claudeScreen("default").replace("? for shortcuts", "⏵⏵ manual mode on")), "default");
  });
  test("a real 2.1.312 screen at its prompt (the trust fixture's): manual mode", () => {
    const screen = readFileSync(join(import.meta.dirname, "../../support/screens/trust/claude-prompt.txt"), "utf8");
    assert.equal(readScreenMode(screen), "default");
  });
  test("a dialog up, a shell, a partial draw, a box with options in it: null, so nothing is pressed", () => {
    assert.equal(readScreenMode(DIALOG), null);
    assert.equal(readScreenMode(`${claudeScreen("auto").split(RULE)[0]}${DIALOG}`), null, "the conversation above a dialog");
    assert.equal(readScreenMode([RULE, " ❯ 1. Yes", "   2. No", RULE, " Esc to cancel"].join("\n")), null, "numbered options between rules");
    assert.equal(readScreenMode("me@mac lacy %"), null);
    assert.equal(readScreenMode(""), null);
    assert.equal(readScreenMode([RULE, "❯ "].join("\n")), null, "the box half drawn");
    assert.equal(readScreenMode([RULE, "some output", RULE, "  ⏵⏵ auto mode on"].join("\n")), null, "not an input line in the box");
  });
});

describe("a label in the box's top rule (2.1.323): a renamed session's name, a tag, History", () => {
  // Bobby's real screen (names and paths made neutral): its name drawn in the top rule, and a yes did
  // nothing ("I couldn't see its mode on its screen") because only a bare rule was taken for the box.
  const bobby = readFileSync(join(import.meta.dirname, "../../support/screens/mode/claude-named-auto.txt"), "utf8");
  const top = (label: string) => claudeScreen("auto").replace(`${RULE}\n❯`, `${label}\n❯`);
  test("Bobby's screen: auto mode, as with a bare rule", () => {
    assert.equal(readScreenMode(bobby), "auto");
    assert.equal(readScreenMode(bobby.replace(/─+ Bobby ─/, RULE)), "auto");
  });
  test("at its right end, near its left, with a tag, in a rounded box", () => {
    assert.equal(readScreenMode(top(`${"─".repeat(70)} Bobby ─`)), "auto", "a name, right");
    assert.equal(readScreenMode(top(`${"─".repeat(62)} ↯ fast  Bobby ─`)), "auto", "fast mode and a name");
    assert.equal(readScreenMode(top(`${"─".repeat(60)} ultracode  high ─`)), "auto", "tags");
    assert.equal(readScreenMode(top(`─── History 2/9 ${"─".repeat(60)}`)), "auto", "History, left");
    assert.equal(readScreenMode(top(`╭${"─".repeat(68)} Bobby ─╮`).replace(`${RULE}\n  ⏵⏵`, `╰${"─".repeat(76)}╯\n  ⏵⏵`)), "auto", "rounded");
    assert.equal(readScreenMode(claudeScreen("acceptEdits").replace(`${RULE}\n❯`, `${"─".repeat(70)} Bobby ─\n❯`)), "acceptEdits");
  });
  test("mid-turn: a spinner, its todos and a queued message above the box, a status line under it", () => {
    const screen = [
      "⏺ Bash(wrangler deploy --env production)",
      "  ⎿  Error: Permission for this action was denied by auto mode.",
      "",
      "⏺ I'll commit it and leave the deploy to you.",
      "",
      "✶ Committing… (1m 12s · ↓ 3.1k tokens · esc to interrupt)",
      "  ⎿  ☒ Build the page",
      "     ☐ Commit",
      "",
      "❯ and then tell me the hash",
      "",
      `${"─".repeat(70)} Bobby ─`,
      "❯ Press up to edit queued messages",
      RULE,
      "  Model: Opus 5.5 | Ctx: 122.2k | 🎙 voice on",
      "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt",
      "",
    ].join("\n");
    assert.equal(readScreenMode(screen), "auto");
  });
  test("near misses stay null: a dialog under a labelled rule, a label in the bottom rule, a reply's rules, no box", () => {
    assert.equal(readScreenMode(bobby.replace(/─+ Bobby ─[\s\S]*$/, DIALOG)), null, "a permission dialog up");
    assert.equal(readScreenMode([`${"─".repeat(70)} Bobby ─`, " ❯ 1. Yes", "   2. No", RULE, " Esc to cancel"].join("\n")), null, "numbered options");
    assert.equal(readScreenMode([RULE, "❯ ", `${"─".repeat(70)} Bobby ─`, "  ⏵⏵ auto mode on"].join("\n")), null, "a label in the bottom rule");
    const reply = ["⏺ Notes", "", `  ${"─".repeat(40)}`, "  ── Results ─────────────", "  --- a/src/page.astro", "  │ a │ b │", `  ${"─".repeat(40)}`, "  Done."].join("\n");
    assert.equal(readScreenMode(reply), null, "a reply's rules, no box");
    assert.equal(readScreenMode(`${reply}\n\n${DIALOG}`), null, "a reply's rules over a dialog");
    assert.equal(readScreenMode(top("─ Bobby ─")), null, "too short to be the box's top");
    assert.equal(readScreenMode(top(`${"─".repeat(70)}Bobby─`)), null, "a label not set off by spaces");
  });
});

/**
 * A fake Claude Code TUI: its mode, its Shift+Tab cycle (as enabled modes make it), a screen that
 * shows a press `lag` reads late (and `blank` reads of a frame with no footer meanwhile), a dialog that
 * can be up, keys that may not go in or not take.
 */
class FakeTui implements ModeKeys {
  presses = 0;
  reads = 0;
  dialog = false;
  gone = false;
  refuse: string | null = null;
  ignores = false;
  mode: PermissionMode;
  cycle: PermissionMode[];
  private shown: PermissionMode;
  private queue: Array<PermissionMode | "blank"> = [];
  private o: { lag?: number; blank?: number };
  constructor(mode: PermissionMode, cycle: PermissionMode[] = ["default", "acceptEdits", "plan", "auto"], o: { lag?: number; blank?: number } = {}) {
    this.mode = this.shown = mode;
    this.cycle = cycle;
    this.o = o;
  }
  async screen() {
    this.reads++;
    if (this.gone) return null;
    if (this.dialog) return DIALOG;
    const next = this.queue.shift();
    if (next === "blank") return [RULE, "❯ ", RULE].join("\n"); // mid-redraw: no footer yet
    if (next) this.shown = next;
    return claudeScreen(this.shown);
  }
  async press() {
    if (this.refuse) return { sent: false, why: this.refuse };
    this.presses++;
    if (this.ignores) return { sent: true };
    this.mode = this.cycle[(this.cycle.indexOf(this.mode) + 1) % this.cycle.length];
    this.queue = [...Array(this.o.lag ?? 0).fill(this.shown), ...Array(this.o.blank ?? 0).fill("blank"), this.mode];
    return { sent: true };
  }
  async wait() {}
}

describe("out of auto mode with Shift+Tab, read back after each press", () => {
  test("auto → manual → accept edits: two presses, each seen before the next", async () => {
    const tui = new FakeTui("auto");
    assert.deepEqual(await switchMode(tui), { ok: true, from: "auto", now: "acceptEdits", presses: 2 });
    assert.equal(tui.mode, "acceptEdits");
  });
  test("bypass enabled (after plan in its cycle): never passed through on the way from auto", async () => {
    const tui = new FakeTui("auto", ["default", "acceptEdits", "plan", "bypassPermissions", "auto"]);
    assert.deepEqual(await switchMode(tui), { ok: true, from: "auto", now: "acceptEdits", presses: 2 });
  });
  test("a screen slow to show a press, and a frame mid-redraw: waited for, not taken as a mode", async () => {
    const tui = new FakeTui("auto", undefined, { lag: 4, blank: 1 });
    assert.deepEqual(await switchMode(tui), { ok: true, from: "auto", now: "acceptEdits", presses: 2 });
  });
  test("mid-turn, manual mode is the target: one press from auto, never a second", async () => {
    assert.equal(switchTarget("busy"), "default");
    assert.equal(switchTarget("idle"), "acceptEdits");
    const tui = new FakeTui("auto");
    assert.deepEqual(await switchMode(tui, switchTarget("busy")), { ok: true, from: "auto", now: "default", presses: 1 });
    assert.equal(tui.presses, 1);
  });
  test("already in accept edits: nothing pressed; in manual mode: one press", async () => {
    const edits = new FakeTui("acceptEdits");
    assert.deepEqual(await switchMode(edits), { ok: true, from: "acceptEdits", now: "acceptEdits", presses: 0 });
    assert.equal(edits.presses, 0);
    const manual = new FakeTui("default");
    assert.deepEqual(await switchMode(manual), { ok: true, from: "default", now: "acceptEdits", presses: 1 });
  });
  test("a cycle in another order: it stops at the first surprise, never presses on", async () => {
    const tui = new FakeTui("auto", ["auto", "plan", "bypassPermissions", "default", "acceptEdits"]);
    const r = await switchMode(tui);
    assert.equal(r.ok, false);
    assert.equal(r.presses, 1);
    assert.equal(r.now, "plan");
    assert.equal(r.why, "it went to plan mode, not manual mode");
    assert.equal(tui.mode, "plan", "never on towards bypass");
  });
  test("from plan (its next may be bypass), bypass or don't ask: nothing pressed", async () => {
    for (const mode of ["plan", "bypassPermissions", "dontAsk"] as const) {
      const tui = new FakeTui(mode, ["default", "acceptEdits", "plan", "bypassPermissions", "auto"]);
      const r = await switchMode(tui);
      assert.equal(r.ok, false, mode);
      assert.equal(tui.presses, 0, mode);
      assert.match(r.why!, /I only switch from auto or manual mode/);
    }
  });
  test("a dialog up: nothing pressed, and why", async () => {
    const tui = new FakeTui("auto");
    tui.dialog = true;
    const r = await switchMode(tui);
    assert.deepEqual(r, { ok: false, from: null, now: null, presses: 0, why: "I couldn't see its mode on its screen: something else may be open there" });
    assert.equal(tui.presses, 0);
  });
  test("a dialog that opens after the first press: no second press", async () => {
    const tui = new FakeTui("auto");
    const press = tui.press.bind(tui);
    tui.press = async () => {
      const r = await press();
      tui.dialog = true;
      return r;
    };
    const r = await switchMode(tui);
    assert.equal(r.ok, false);
    assert.equal(r.presses, 1);
    assert.equal(r.why, "its screen stopped showing its mode");
  });
  test("Shift+Tab that doesn't take, or isn't sent: it gives up, having pressed once at most", async () => {
    const deaf = new FakeTui("auto");
    deaf.ignores = true;
    const r = await switchMode(deaf);
    assert.deepEqual([r.ok, r.presses, r.why, r.now], [false, 1, "Shift+Tab didn't change its mode", "auto"]);
    const refused = new FakeTui("auto");
    refused.refuse = "its process has ended";
    assert.deepEqual(await switchMode(refused), { ok: false, from: "auto", now: "auto", presses: 0, why: "its process has ended" });
  });
  test("its pane gone: nothing pressed", async () => {
    const tui = new FakeTui("auto");
    tui.gone = true;
    assert.equal((await switchMode(tui)).presses, 0);
  });
  test("never more than MAX_PRESSES, whatever the screen says", async () => {
    // A screen that flips between auto and manual each press: it ends, at the cap or before.
    const tui = new FakeTui("auto", ["auto", "default"]);
    const r = await switchMode(tui);
    assert.equal(r.ok, false);
    assert.ok(r.presses <= MAX_PRESSES);
  });
});

describe("the card", () => {
  const b: Blocked = { sessionId: "lacy", cwd: "/x/lacy", tool: { name: "Bash", input: { command: "wrangler deploy --env production" } }, reason: "[Production Deploy]", by: "auto", mode: "auto" };
  test("its question, its line on the card, what's typed in after", () => {
    assert.equal(overrideAsk("Lacy", b), "Auto mode blocked Lacy from running wrangler deploy --env production. Allow it?");
    assert.equal(overrideWhat("run: wrangler deploy"), "run: wrangler deploy (auto mode blocked it)");
    assert.equal(retryLine(b.tool), "Out of auto mode now: try running wrangler deploy --env production again.");
    assert.equal(retryLine({ name: "Edit", input: { file_path: "/x/wrangler.toml" } }), "Out of auto mode now: try editing wrangler.toml again.");
    assert.equal(retryLine({ name: "Bash", input: undefined }), "Out of auto mode now: try that again.");
  });
  test("a long or code-like command is never said, nor typed back: what it's for, else a plain phrase (spoken-permission.ts)", () => {
    const pipeline = {
      name: "Bash",
      input: { command: "curl -s https://api.cloudflare.com/client/v4/zones | jq '.result[] | select(.name==\"lacy.dev\")' && wrangler deploy", description: "Deploy the worker to production" },
    };
    const ask = overrideAsk("Lacy", { ...b, tool: pipeline });
    assert.doesNotMatch(ask, /curl|jq|\|/);
    assert.match(ask, /^Auto mode blocked Lacy from running a command to .+\. Allow it\?$/);
    assert.doesNotMatch(retryLine(pipeline), /curl|jq|\|/);
    const bare = { name: "Bash", input: { command: pipeline.input.command } };
    assert.equal(overrideAsk("Lacy", { ...b, tool: bare }), "Auto mode blocked Lacy from running a command. Allow it?");
    assert.equal(retryLine(bare), "Out of auto mode now: try that again.");
  });
  test('a permission prompt with no "always": a yes hands it on once; no, or no answer, does nothing', () => {
    const allowed: BlockOverride[] = [];
    const card = new BlockOverride("lacy", b, (c) => allowed.push(c));
    assert.ok(isOverride(card));
    assert.equal(card.isPermission, true);
    assert.equal(card.canAllowAlways, false);
    assert.equal(card.questions, null);
    assert.deepEqual(card.tool, b.tool);
    assert.equal(card.allow(), true);
    assert.equal(card.allow(), false, "once");
    assert.deepEqual(allowed, [card]);
    assert.equal(card.open, false);
    const no = new BlockOverride("lacy", b, (c) => allowed.push(c));
    assert.equal(no.deny(), true);
    assert.equal(no.allow(), false);
    const gone = new BlockOverride("lacy", b, (c) => allowed.push(c));
    assert.equal(gone.release(), true);
    assert.equal(gone.allow(), false);
    assert.equal(allowed.length, 1, "only the yes");
    assert.equal(card.answer(), false, "not a finished turn");
  });
  test("offered only where it can be done; otherwise why, in a sentence", () => {
    const tmux = { inTmux: true, listed: true, cards: true };
    assert.deepEqual(overridable(b, tmux), { ok: true });
    assert.deepEqual(overridable({ ...b, mode: undefined }, tmux), { ok: true }, "a hook that didn't say its mode");
    assert.deepEqual(overridable(b, { ...tmux, inTmux: false }), { ok: false, why: "It isn't in Kiko's tmux, so I can't switch it out of auto mode: allow it in its window." });
    assert.deepEqual(overridable(b, { ...tmux, listed: false }), { ok: false, why: "It isn't in Kiko's tmux, so I can't switch it out of auto mode: allow it in its window." });
    assert.deepEqual(overridable({ ...b, mode: "plan" }, tmux), { ok: false, why: "It's in plan mode, so allow it in its window." });
    assert.deepEqual(overridable(b, { ...tmux, desktop: true }), { ok: false, why: "It's in the Claude app, so allow it there." });
    assert.deepEqual(overridable(b, { ...tmux, cards: false }), {
      ok: false,
      why: "Permissions by voice is off, so allow it in its window. In Settings, under Permissions, Permissions by voice turns it on.",
    });
    assert.deepEqual(overridable({ ...b, by: "rule" }, tmux), { ok: false, why: "That's your own setting, so I can't allow it from here." });
  });
});
