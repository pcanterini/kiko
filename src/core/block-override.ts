// Allowing what an agent's own safety layer blocked: "Auto mode blocked Lacy from running wrangler
// deploy. Allow it?" as a permission card (the window's, the phone's, voice's yes or no), and on a yes
// the closest honest way that agent has to let it through.
//
// Why: Claude Code's auto mode blocked a session's deploy with no PermissionRequest, so no card, and "go ahead" didn't count. Kiko says such blocks now
// (core/permission-mode.ts blockedLine); this offers to allow them where that can be done.
//
// Claude Code (2.1.314; code.claude.com/docs/en/hooks "PermissionDenied", /permission-modes): the
// PermissionDenied hook can't allow anything. Its only output is `retry: true`, which tells the model
// it may try again, and a retry in auto mode goes back to the same classifier (and is ignored for a
// block with no verdict). Claude Code's own ways past a block are its window's: /permissions,
// "Recently denied", `r` (a dialog of its own, not something to drive key by key), or leaving auto
// mode, so the action asks like any other ("To run a step it won't clear, leave auto mode and answer
// the permission prompt"). So a yes here does that: Shift+Tab in its pane, in Kiko's tmux only,
// until its screen says "accept edits on", then "Out of auto mode now: try running wrangler deploy
// again." typed in (a finished turn of it the app holds is let go, as when you type there). Claude
// Code then asks for it with a PermissionRequest, an ordinary card: the action itself is still yours
// to allow, once.
// Nothing is approved for you, and it isn't switched back to auto: what it's in now is said.
//
// Shift+Tab is never counted blindly. The cycle depends on what's enabled (default → acceptEdits →
// plan → bypassPermissions if enabled → auto if available), so a press is only made from a mode
// whose next is known: auto → default ("From auto, the first press switches to default"), default →
// acceptEdits; never from plan, whose next may be bypass. After each press the screen is read until
// the mode has changed (read the same twice running) and is the one expected; anything else, or no
// change, stops there and says so. At most MAX_PRESSES. Never while a prompt is up: its screen must
// show Claude Code's input box (no numbered options in it), the floor must hold no prompt of that
// session, and its listing mustn't say it's blocked.
//
// What its screen says (2.1.314's footer under the input box, `{symbol} {indicator} on`: its mode
// table's indicators "manual mode", "accept edits", "plan mode", "auto mode", "bypass permissions",
// "don't ask"; default shows none, "? for shortcuts" instead; 2.1.323's top rule may carry a label,
// a renamed session's name, as here):
//
//   ──────────────────────────────── Bobby ─
//   ❯
//   ────────────────────────────────────────
//     ⏵⏵ auto mode on (shift+tab to cycle)
//
// Mid-turn (the usual case: it works on after a block) a yes takes it only to manual mode, one
// press (switchTarget).
//
// Codex (0.166, --approve-for-me), OpenCode (2.0.32) and T3 Code: ARCHITECTURE.md, "Blocks allowed
// anyway": Codex's refusals reach no client that isn't subscribed to the thread, OpenCode's deny rules
// are your own (said, never overridden), T3 Code doesn't tell its blocks.
import type { Held, ToolUse } from "../agents/types.ts";
import { blockedDoing, blockedLine, type Blocked, type PermissionMode } from "./permission-mode.ts";
import { NAME } from "./name.ts";

/** The most Shift+Tab presses for one switch, whatever the screen says. */
export const MAX_PRESSES = 6;

/** Each mode's indicator in Claude Code 2.1.314's footer, before " on". */
const INDICATORS: Array<[string, PermissionMode]> = [
  ["manual mode", "default"],
  ["accept edits", "acceptEdits"],
  ["plan mode", "plan"],
  ["auto mode", "auto"],
  ["bypass permissions", "bypassPermissions"],
  ["don't ask", "dontAsk"],
];
const INDICATOR = new RegExp(`(?:^|\\s)(${INDICATORS.map(([words]) => words.replace(/'/g, "['’]")).join("|")}) on\\b`, "i");

// A line across: the input box's top and bottom (its own, or a rounded box's).
const RULE = /^[╭╰]?[─━]{8,}[╮╯]?$/;
// The box's top can carry a label, rules on both sides (2026-11-12, Claude Code 2.1.323): a session's
// name at its right end, "──── Bobby ─" (Kiko names every session it starts, so most have one), a
// fast-mode or effort tag there too, or "─── History 2/9 ───" near its left while you go back through
// what you sent. Read as a plain rule, Bobby's box wasn't seen and a yes to its block did nothing.
// Its bottom never has one (Ink draws a border's text on the top only; the banner's lower line is rules).
const LABELLED = /^╭?[─━]+ [^─━│╭╮╰╯]*[^\s─━│╭╮╰╯] [─━]+╮?$/;
const RULE_CHARS = /[─━]/g;
/** The box's top: a rule, or one with a label in it (still mostly a line: 8 rule characters at least). */
const topRule = (line: string) => RULE.test(line) || (LABELLED.test(line) && (line.match(RULE_CHARS)?.length ?? 0) >= 8);
// Claude Code's input line (or an older box's, inside its sides).
const INPUT = /^(?:│\s*)?[❯>]/;
// A menu's numbered option, as a dialog draws it ("❯ 1. Yes"): a prompt is up, not the input box.
const OPTION = /^(?:│\s*)?(?:[❯>]\s*)?\d+\.\s/;
// Its footer under the box: a few lines at most (the mode, hints, a status line).
const FOOTER_LINES = 6;
// The input box's lines between its rules, at most (a long draft wraps).
const BOX_LINES = 12;

/**
 * A Claude Code session's permission mode as its screen (`capture-pane -p`) shows it under the input
 * box: the footer's indicator, or "default" when the box is there with none. Null when the input box
 * isn't the last thing on it (a permission prompt or another dialog is up, it's still drawing, or it
 * isn't Claude Code's screen): nothing is pressed then.
 */
export function readScreenMode(screen: string): PermissionMode | null {
  const lines = screen.split("\n").map((l) => l.trimEnd());
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  const bottom = lines.findLastIndex((l) => RULE.test(l.trim()));
  const top = bottom < 0 ? -1 : lines.findLastIndex((l, i) => i < bottom && topRule(l.trim()));
  if (top < 0) return null;
  const box = lines.slice(top + 1, bottom).filter((l) => l.trim());
  const footer = lines.slice(bottom + 1).filter((l) => l.trim());
  if (!box.length || bottom - top - 1 > BOX_LINES || footer.length > FOOTER_LINES) return null;
  if (!INPUT.test(box[0].trim()) || box.some((l) => OPTION.test(l.trim()))) return null;
  const found = footer.map((l) => INDICATOR.exec(l)?.[1]?.toLowerCase().replace(/’/g, "'")).find(Boolean);
  if (!found) return "default";
  return INDICATORS.find(([words]) => words === found)![1];
}

/**
 * The mode a yes takes it to: accept edits, or manual mode (one press) while a turn is running.
 * Why (2026-11-12): a block comes mid-turn and the session usually works on, so the yes often lands
 * in a turn. In manual mode its next call asks, and Shift+Tab in a permission dialog is Claude
 * Code's "confirm:cycleMode", which picks "Yes, and don't ask again" (accept-session) for you. A
 * second press could meet a dialog that opened after the screen was last read; one press from auto,
 * where calls aren't asked, can't. Manual mode is enough for the retry to ask.
 */
export const switchTarget = (status: string): PermissionMode => (status === "busy" ? "default" : "acceptEdits");

/** Which mode a press is made from, and the mode it must come to: only these. */
const NEXT: Partial<Record<PermissionMode, PermissionMode>> = { auto: "default", default: "acceptEdits" };

/** What switching needs: the pane's screen now (null: gone), Shift+Tab into it (checked as any key is), a pause. */
export type ModeKeys = {
  screen(): Promise<string | null>;
  press(): Promise<{ sent: boolean; why?: string }>;
  wait(ms: number): Promise<void>;
};

/** How it went: `ok` once its screen says `want`; `from` and `now` as read (null: couldn't); the presses made; why not. */
type ModeSwitch = { ok: boolean; from: PermissionMode | null; now: PermissionMode | null; presses: number; why?: string };

// How long the screen gets to show a press, and how often it's read meanwhile.
const SETTLE_MS = 2000;
const LOOK_MS = 100;

/** The mode, read until two reads running agree on one `fits` takes, or about SETTLE_MS: that mode, else the last read. */
async function steady(io: ModeKeys, fits: (mode: PermissionMode) => boolean): Promise<PermissionMode | null> {
  let last: PermissionMode | null | undefined;
  for (let look = 0; ; look++) {
    const screen = await io.screen();
    const mode = screen === null ? null : readScreenMode(screen);
    if (mode !== null && mode === last && fits(mode)) return mode;
    if (look >= SETTLE_MS / LOOK_MS) return mode;
    last = mode;
    await io.wait(LOOK_MS);
  }
}

/** A mode as it's said: "auto mode", "accept edits", "manual mode", "plan mode". */
export const modeWords = (mode: PermissionMode) => (mode === "default" ? "manual mode" : INDICATORS.find(([, m]) => m === mode)![0]);

/**
 * Takes a Claude Code session out of auto mode, to accept edits (`want`), with Shift+Tab (see the
 * top): a press only from auto or manual, each one read back before the next. `ok` once its screen
 * says `want`; otherwise why not, with what it's in now as read.
 */
export async function switchMode(io: ModeKeys, want: PermissionMode = "acceptEdits"): Promise<ModeSwitch> {
  let now = await steady(io, () => true);
  const from = now;
  let presses = 0;
  const no = (why: string): ModeSwitch => ({ ok: false, from, now, presses, why });
  if (now === null) return no("I couldn't see its mode on its screen: something else may be open there");
  for (;;) {
    if (now === want) return { ok: true, from, now, presses };
    if (presses >= MAX_PRESSES) return no(`it didn't come round to ${modeWords(want)}`);
    const next: PermissionMode | undefined = NEXT[now];
    if (!next) return no(`it's in ${modeWords(now)}, and I only switch from auto or manual mode`);
    const sent = await io.press();
    if (!sent.sent) return no(sent.why ?? "Shift+Tab didn't go in");
    presses++;
    const before: PermissionMode = now;
    now = await steady(io, (mode) => mode !== before);
    if (now === null) return no("its screen stopped showing its mode");
    if (now === before) return no("Shift+Tab didn't change its mode");
    if (now !== next) return no(`it went to ${modeWords(now)}, not ${modeWords(next)}`);
  }
}

/** The card's question: "Auto mode blocked Lacy from running wrangler deploy. Allow it?" */
export const overrideAsk = (name: string, b: Pick<Blocked, "tool" | "reason" | "by">) => `${blockedLine(name, b)} Allow it?`;

/** The card's "wants to …" (the window's, the TUI's, the phone's): "run: wrangler deploy (auto mode blocked it)". */
export const overrideWhat = (what: string) => `${what} (auto mode blocked it)`;

/** What's typed in once it's out of auto mode: "Out of auto mode now: try running wrangler deploy again." */
export function retryLine(tool: ToolUse): string {
  const doing = blockedDoing(tool);
  return /^(?:doing something|running a command)$/.test(doing) ? "Out of auto mode now: try that again." : `Out of auto mode now: try ${doing} again.`;
}

/**
 * A block, offered as a permission prompt (agents/types.ts Held): its tool the blocked one, never "always".
 * allow() hands the yes to `allow` (the app switches the mode and asks for a retry); deny() and
 * release() (its window ran out) do nothing: the block stands, as it would have.
 */
export class BlockOverride implements Held {
  readonly isPermission = true;
  readonly desktop = false;
  readonly text = "";
  readonly continued = false;
  readonly canAllowAlways = false;
  readonly questions = null;
  readonly tool: ToolUse;
  readonly sessionId: string;
  readonly cwd: string;
  readonly blocked: Blocked;
  /** How it was answered: true allowed, false denied, null not (let go, or not yet). */
  answered: boolean | null = null;
  onClosed: () => void = () => {};
  private held = true;
  private readonly allow_: (card: BlockOverride) => void;

  constructor(sessionId: string, blocked: Blocked, allow: (card: BlockOverride) => void) {
    this.sessionId = sessionId;
    this.cwd = blocked.cwd;
    this.blocked = blocked;
    this.tool = blocked.tool;
    this.allow_ = allow;
  }

  get open() {
    return this.held;
  }

  allow(): boolean {
    if (!this.held) return false;
    this.held = false;
    this.answered = true;
    this.allow_(this);
    return true;
  }

  deny(): boolean {
    if (!this.held) return false;
    this.held = false;
    this.answered = false;
    return true;
  }

  release(): boolean {
    if (!this.held) return false;
    this.held = false;
    return true;
  }

  // Not a finished turn: nothing to reply to, nothing said this turn, nothing typed meanwhile.
  answer(): boolean {
    return false;
  }
  answerQuestions(): boolean {
    return false;
  }
  lastAsked() {
    return "";
  }
  saidThisTurn() {
    return null;
  }
  watchTyped() {}
}

/** A held prompt that is a block offered to be allowed anyway. */
export const isOverride = (held: unknown): held is BlockOverride => held instanceof BlockOverride;

/**
 * Whether a block can be allowed from here, and if not, why, as a sentence said after it. Only auto
 * mode's (Claude Code's), in auto mode, of a session in Kiko's tmux (its keys and screen are
 * Kiko's to read and press); with permission cards on.
 */
export function overridable(b: Pick<Blocked, "by" | "mode">, where: { inTmux: boolean; desktop?: boolean; listed: boolean; cards: boolean }): { ok: true } | { ok: false; why: string } {
  if (b.by === "rule") return { ok: false, why: "That's your own setting, so I can't allow it from here." };
  if (!where.cards) return { ok: false, why: "Permissions by voice is off, so allow it in its window. In Settings, under Permissions, Permissions by voice turns it on." };
  if (b.mode && b.mode !== "auto") return { ok: false, why: `It's in ${b.mode === "plan" ? "plan mode" : "another mode"}, so allow it in its window.` };
  if (where.desktop) return { ok: false, why: "It's in the Claude app, so allow it there." };
  if (!where.listed || !where.inTmux) return { ok: false, why: `It isn't in ${NAME}'s tmux, so I can't switch it out of auto mode: allow it in its window.` };
  return { ok: true };
}
