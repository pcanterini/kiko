// An agent's "trust this?" question at start, as a permission card. A session Kiko opens may stop,
// before it starts, on a screen of its agent's own that asks to trust something:
//
//   Claude Code, a folder it doesn't trust yet (every new scratch folder):
//
//     Accessing workspace:
//     /Users/me/Kiko/scratch/2026-10-29-dozer
//     Quick safety check: Is this a project you created or one you trust? …
//     ❯ No, exit
//       Yes, I trust this folder
//     Enter to confirm · Esc to cancel
//
//   Codex (codex-rs/tui 0.166.0, onboarding/trust_directory.rs), a folder it doesn't trust yet:
//
//     Folder access
//     /Users/me/git/pixie
//     Trust this folder? Codex can read, edit, and run files here, subject to …
//     › 1. Trust and continue
//       2. Quit
//     enter continue · esc quit
//
//   Codex (startup_hooks_review.rs), hooks that are new or changed since you last trusted them
//   (Kiko's own after an update, and yours):
//
//     Hooks need review
//     10 hooks are new or changed.
//     Hooks can run outside the sandbox after you trust them.
//     › 1. Review hooks
//       2. Trust all and continue
//       3. Continue without trusting (hooks won't run)
//     enter confirm · esc skip
//
// For a pane Kiko opened that's still starting (core/starting.ts), the app reads its screen
// (tmux capture-pane) and, once one of these is on it, holds it as a `Held` (TrustQuestion), so it's
// asked like any permission prompt: the window's card, by voice, the phone's card and its notification.
// Never answered for you: Kiko trusts nothing by itself here (Codex's update question and a scratch
// folder Kiko made are kept from showing at all, on its command line: agents/codex/launch.ts).
//
// Unlike other cards it has no window: it stays up (TrustCards) until it's settled, never answered
// for you. Settled: answered here (the card, voice, a phone), answered in its window (the question
// gone from its screen, or SessionStart), or the session ended. Then it goes from everywhere at once.
//
// Reading it (readTrustPrompt) is kept to its stable parts, in one place per screen, so a change in
// an agent's wording is one fix here (tests/unit/core/trust-prompt.test.ts has the screens).
//
// Answering it (answerTrust) never presses Enter blindly: the selection is a marker (Claude Code's
// `❯`, Codex's `›`) that Down and Up move one option at a time. The option wanted is picked one key
// at a time, the screen read again after each, and Enter goes in only once the marker is seen on
// it. Claude Code (2.1.312: its confirm menu, "No, exit" picked at first): allowed, "Yes, I trust
// this folder"; denied, Escape (its cancel: it exits), and if it's still asking, "No, exit" picked
// the same careful way, then Enter. Codex: allowed, "Trust and continue" or "Trust all and
// continue"; denied, "Quit" (it exits) or "Continue without trusting (hooks won't run)" (it starts,
// unheard), picked the same way; no Escape, so what's picked is always what's seen. "Review hooks"
// isn't offered: it's a browser of its own, for its window.
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import type { Held, ToolUse } from "../agents/types.ts";
import { phoneLive } from "./env.ts";
import { shortPath } from "./text.ts";

/** What it asks to trust: the session's folder, or its agent's hooks (Codex's "Hooks need review"). */
export type TrustKind = "folder" | "hooks";

/** What an option does: trusts ("yes"), doesn't ("no"), or neither (Codex's "Review hooks", never picked). */
export type TrustRole = "yes" | "no" | "other";

/** The question as read off the screen. */
export type TrustScreen = {
  kind: TrustKind;
  /**
   * The folder it's about, as shown: the one trusted (Codex in a Git project's subfolder: the
   * repository root, which is what it trusts). Hooks: "" (none is shown).
   */
  folder: string;
  /** The session's own folder as shown, where Codex shows it apart from the root it trusts. */
  cwd?: string;
  /** Hooks: how many are new or changed. */
  hooks?: number;
  /** Its options' roles, top to bottom. */
  options: TrustRole[];
  /** The option picked now (an index into options); null: can't tell. */
  at: number | null;
  /** Its role, for short: options[at]. */
  selected: TrustRole | null;
};

// A frame's sides and corners, which a bordered dialog draws around each line.
const FRAME = /^[\s│┃║╭╮╰╯─━═]+|[\s│┃║╭╮╰╯─━═]+$/g;

/** An option line without its marker and number: "❯ 2. Yes, I trust this folder" → "Yes, I trust this folder". */
const optionText = (line: string, marker: string) => line.replace(new RegExp(`^\\s*${marker}?\\s*(?:\\d+\\.\\s+)?`), "").trim();

/**
 * The options found in `lines`, each by its words (`is`: whether a line is that option), each on
 * exactly one line, in that order; null otherwise (a partial draw, another screen). The picked
 * one: the only one whose line starts with `marker`.
 */
function optionsOf(lines: string[], marker: string, wanted: Array<{ role: TrustRole; is: (text: string) => boolean }>) {
  const where: number[] = [];
  for (const w of wanted) {
    const found = lines.flatMap((l, i) => (w.is(optionText(l, marker)) ? [i] : []));
    if (found.length !== 1) return null;
    where.push(found[0]);
  }
  if (where.some((w, i) => i > 0 && w <= where[i - 1])) return null;
  const marked = where.flatMap((w, i) => (lines[w].trimStart().startsWith(marker) ? [i] : []));
  const at = marked.length === 1 ? marked[0] : null;
  const options = wanted.map((w) => w.role);
  return { options, at, selected: at === null ? null : options[at], last: where.at(-1)! };
}

/** The non-empty lines from `from` until `stop` says so, trimmed and run together (a long path wraps). */
function runTogether(lines: string[], from: number, stop: (line: string) => boolean): string {
  let text = "";
  for (const l of lines.slice(from)) {
    const t = l.trim();
    if (stop(t)) break;
    text += t;
  }
  return text;
}

// ── Claude Code ──────────────────────────────────────────────────────────────

/** The option that trusts the folder, and the one that ends the session (exactly as Claude Code draws them). */
const CLAUDE_YES = "Yes, I trust this folder";
const CLAUDE_NO = "No, exit";
const CLAUDE_TITLE = "Accessing workspace:";
const CLAUDE_MARKER = "❯";

/**
 * Claude Code's trust question, if the screen shows it whole: the title, then the folder (a path,
 * wrapped over lines if long), then both options, "No, exit" and "Yes, I trust this folder", each
 * on a line of its own. Anything less (a partial draw, another dialog, a folder with settings of
 * its own, where the "No" is "No, continue without these permissions") is null.
 */
function readClaude(lines: string[]): TrustScreen | null {
  const title = lines.findIndex((l) => l.includes(CLAUDE_TITLE));
  if (title < 0) return null;
  const below = lines.slice(title + 1);
  const picked = optionsOf(below, CLAUDE_MARKER, [
    { role: "no", is: (t) => t === CLAUDE_NO },
    { role: "yes", is: (t) => t === CLAUDE_YES },
  ]);
  // Either order: the menu is drawn No first, but an older or other one may not be.
  const either =
    picked ??
    optionsOf(below, CLAUDE_MARKER, [
      { role: "yes", is: (t) => t === CLAUDE_YES },
      { role: "no", is: (t) => t === CLAUDE_NO },
    ]);
  if (!either) return null;
  // The folder: the first line after the title (on the title's own line, else below it) that's a path, and the lines it wraps onto.
  const after = lines[title].slice(lines[title].indexOf(CLAUDE_TITLE) + CLAUDE_TITLE.length).trim();
  const rest = after ? [after, ...below] : below;
  const start = rest.findIndex((l) => l.trim() !== "");
  if (start < 0 || !/^[/~]/.test(rest[start].trim())) return null;
  const folder = runTogether(rest, start, (t) => !t || /^Quick safety check/i.test(t) || [CLAUDE_YES, CLAUDE_NO].includes(optionText(t, CLAUDE_MARKER)));
  if (!folder) return null;
  return { kind: "folder", folder, options: either.options, at: either.at, selected: either.selected };
}

// ── Codex ────────────────────────────────────────────────────────────────────

const CODEX_MARKER = "›";
/** Its folder question's heading, question, and options (the default ones: `codex` started in a terminal, "Quit" its cancel). */
const CODEX_FOLDER_TITLE = "Folder access";
const CODEX_FOLDER_ASKS = "Trust this folder?";
const CODEX_FOLDER_YES = "Trust and continue";
const CODEX_FOLDER_NO = "Quit";
/** In a Git project's subfolder: it trusts the repository root, shown under this note. */
const CODEX_ROOT_NOTE = /^Note: You.re in a subdirectory of a Git project/;
/** Its hooks question's heading, count, and options. */
const CODEX_HOOKS_TITLE = "Hooks need review";
const CODEX_HOOKS_COUNT = /^(\d+) hooks? (?:is|are) new or changed\.$/;
const CODEX_HOOKS_REVIEW = "Review hooks";
const CODEX_HOOKS_YES = "Trust all and continue";
// Wrapped on a narrow screen ("Continue without trusting (hooks" / "won't run)"): its start is enough.
const CODEX_HOOKS_NO = "Continue without trusting";
/** Shown while "Trust all and continue" is written, the options greyed out: answered, not asking. */
const CODEX_HOOKS_TRUSTING = "Trusting hooks...";

/**
 * Codex's folder question, if the screen shows it whole: "Folder access", the folder (a path,
 * wrapped, or cut short in the middle with "…" if it doesn't fit), maybe the note that it trusts
 * the Git project's root and that root, then "Trust this folder?" and its two options. Its other
 * versions (a folder opened restricted, an existing task; "Back to Agent Command Center" or "Keep
 * current directory" for its No) are null: left to its window.
 */
function readCodexFolder(lines: string[]): TrustScreen | null {
  const title = lines.findIndex((l) => l.trim() === CODEX_FOLDER_TITLE);
  if (title < 0) return null;
  const asks = lines.findIndex((l, i) => i > title && l.trim().startsWith(CODEX_FOLDER_ASKS));
  if (asks < 0) return null;
  const picked = optionsOf(lines.slice(asks + 1), CODEX_MARKER, [
    { role: "yes", is: (t) => t === CODEX_FOLDER_YES },
    { role: "no", is: (t) => t === CODEX_FOLDER_NO },
  ]);
  if (!picked) return null;
  const head = lines.slice(title + 1, asks);
  const note = head.findIndex((l) => CODEX_ROOT_NOTE.test(l.trim()));
  const cwd = runTogether(head, 0, (t) => CODEX_ROOT_NOTE.test(t) || t.startsWith(CODEX_FOLDER_ASKS));
  if (!/^[/~]/.test(cwd)) return null;
  let folder = cwd;
  if (note >= 0) {
    const ends = head.findIndex((l, i) => i >= note && l.trim().endsWith("repository root:"));
    folder = ends < 0 ? "" : runTogether(head, ends + 1, () => false);
    if (!/^[/~]/.test(folder)) return null;
  }
  return { kind: "folder", folder, ...(folder !== cwd ? { cwd } : {}), options: picked.options, at: picked.at, selected: picked.selected };
}

/**
 * Codex's hooks question, if the screen shows it whole: "Hooks need review", how many, and its
 * three options. While it writes their trust ("Trusting hooks..."), null: answered.
 */
function readCodexHooks(lines: string[]): TrustScreen | null {
  const title = lines.findIndex((l) => l.trim() === CODEX_HOOKS_TITLE);
  if (title < 0 || lines.some((l) => l.includes(CODEX_HOOKS_TRUSTING))) return null;
  const count = lines.slice(title + 1).find((l) => l.trim() !== "");
  const n = count?.trim().match(CODEX_HOOKS_COUNT);
  if (!n) return null;
  const picked = optionsOf(lines.slice(title + 1), CODEX_MARKER, [
    { role: "other", is: (t) => t === CODEX_HOOKS_REVIEW },
    { role: "yes", is: (t) => t === CODEX_HOOKS_YES },
    { role: "no", is: (t) => t.startsWith(CODEX_HOOKS_NO) },
  ]);
  if (!picked) return null;
  return { kind: "hooks", folder: "", hooks: Number(n[1]), options: picked.options, at: picked.at, selected: picked.selected };
}

// ── By agent ─────────────────────────────────────────────────────────────────

/** The agents whose questions are read, by id (agents/types.ts), and how each is answered. */
const AGENTS: Record<string, { read: Array<(lines: string[]) => TrustScreen | null>; name: string; escapeDenies: boolean }> = {
  "claude-code": { read: [readClaude], name: "Claude Code", escapeDenies: true },
  codex: { read: [readCodexFolder, readCodexHooks], name: "Codex", escapeDenies: false },
};
const MAIN = "claude-code";
const dialect = (agent: string | undefined) => AGENTS[agent ?? MAIN];

/** Whether Kiko reads `agent`'s trust questions off its screen (undefined: the main agent's). */
export const asksOnScreen = (agent?: string) => Boolean(dialect(agent));

/**
 * `agent`'s trust question (undefined: the main agent, Claude Code), if `screen` (a pane's text, as
 * `capture-pane -p` gives it) shows one whole; null otherwise, so nothing is asked or pressed.
 */
export function readTrustPrompt(screen: string, agent?: string): TrustScreen | null {
  const its = dialect(agent);
  if (!its) return null;
  const lines = screen.split("\n").map((l) => l.replace(FRAME, ""));
  for (const read of its.read) {
    const seen = read(lines);
    if (seen) return seen;
  }
  return null;
}

/**
 * Whether the folder the question shows is `cwd`: with ~ for the home folder, by its real path
 * (/tmp is /private/tmp), or cut short in the middle ("/Users/me/…/pixie") where it didn't fit.
 */
export function sameFolder(shown: string, cwd: string, home: string): boolean {
  const norm = (p: string) => p.replace(/^~(?=$|\/)/, home).replace(/\/+$/, "");
  let real = norm(cwd);
  try {
    real = norm(realpathSync(cwd));
  } catch {}
  const s = norm(shown);
  const matches = (c: string) => {
    if (s === c) return true;
    const cut = s.indexOf("…");
    if (cut < 0 || s.indexOf("…", cut + 1) >= 0) return false;
    const [front, back] = [s.slice(0, cut), s.slice(cut + 1)];
    return c.length >= front.length + back.length && c.startsWith(front) && c.endsWith(back);
  };
  return matches(norm(cwd)) || matches(real);
}

/**
 * How long until a pane still starting is looked at again: every 500ms for its first 15 seconds,
 * then every 3; and every 3 while its card is up (`cardUp`), for an answer typed in its window.
 */
export function trustPollMs(sinceOpenedMs: number, cardUp = false): number {
  return !cardUp && sinceOpenedMs < 15_000 ? 500 : 3_000;
}

/** A question's words: what it asks to trust, and its agent's name. */
type About = { kind: TrustKind; folder: string; hooks?: number; agentName: string };

/**
 * What it asks, short, as a permission's "what" (the card: "Dozer wants to …"): "trust its folder
 * ~/Kiko/scratch/2026-10-29-dozer", or "trust its hooks (10 new or changed)".
 */
export function trustWhat(q: About, home: string): string {
  if (q.kind === "hooks") return `trust its hooks (${q.hooks ?? "some"} new or changed)`;
  return `trust its folder ${shortPath(q.folder, home)}`;
}

/** What Claude Code may do once it's trusted, said after the question. */
export const TRUST_MEANS = "Claude Code will be able to read, edit and run files there.";

/** What trusting means, said after the question and shown under it on the card. */
export function trustMeans(q: About): string {
  if (q.kind === "hooks")
    return `Trusting lets all of them run, yours too, outside ${q.agentName}'s sandbox. Not trusting: none of them run, so Kiko won't hear this session. To review them one by one, open the session.`;
  return `${q.agentName} will be able to read, edit and run files there.`;
}

/**
 * The question, written (`spoken` false: the folder as a path) or said (the folder by its name, a
 * path being no good out loud). `byVoice` false: voice can't answer it (Voice can), so it says how to.
 */
export function trustLine(name: string, q: About, home: string, o: { spoken: boolean; byVoice: boolean }) {
  const ask = o.byVoice ? "Allow?" : `Answer on its card${phoneLive() ? " or on your phone" : ""}.`;
  if (q.kind === "hooks") {
    const count = q.hooks === 1 ? "1 is new or changed" : `${q.hooks ?? "some"} are new or changed`;
    return `${name} wants you to trust its hooks: ${count}. ${trustMeans(q)} ${ask}`;
  }
  const where = o.spoken ? `its folder, ${basename(q.folder)}` : `its folder ${shortPath(q.folder, home)}`;
  return `${name} wants to trust ${where}. ${trustMeans(q)} ${ask}`;
}

/** The trust question's tool name, as a held permission prompt's: not a tool the agent has. */
export const TRUST_TOOL = "TrustFolder";
/** Codex's hooks question's. */
export const TRUST_HOOKS_TOOL = "TrustHooks";

/**
 * The trust question of a session still starting, held like a permission prompt (agents/types.ts
 * Held): its `sessionId` is the starting session's ID (starting-…), its tool TRUST_TOOL with the
 * folder (TRUST_HOOKS_TOOL with the count, for hooks). allow() and deny() hand the answer to
 * `answer` (the app presses the keys: answerTrust). release() is the floor letting go of it (its
 * voice window ran out, or it gave way): nothing pressed, and unlike a permission prompt it stays
 * open, its card up, until it's settled (TrustCards). close(): it went away by itself (answered in
 * its window, or the session ended); onClosed is told.
 */
export class TrustQuestion implements Held {
  readonly isPermission = true;
  readonly desktop = false;
  readonly text = "";
  readonly continued = false;
  readonly canAllowAlways = false;
  readonly questions = null;
  readonly tool: ToolUse;
  /** How it was answered here: true allowed, false denied, null not (yet, or it went away by itself). */
  answered: boolean | null = null;
  /** How it was settled (TrustCards), once it is. */
  settledHow: TrustSettled | null = null;
  onClosed: () => void = () => {};
  readonly sessionId: string;
  readonly cwd: string;
  /** The folder as the question shows it (hooks: the session's own). */
  readonly folder: string;
  /** What it asks to trust. */
  readonly kind: TrustKind;
  /** Hooks: how many are new or changed. */
  readonly hooks?: number;
  /** Its agent's id (undefined: the main agent's) and name. */
  readonly agent?: string;
  readonly agentName: string;
  private held = true;
  private readonly answer_: (allow: boolean) => void;

  constructor(sessionId: string, cwd: string, folder: string, answer: (allow: boolean) => void, about: { kind?: TrustKind; hooks?: number; agent?: string } = {}) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.folder = folder;
    this.answer_ = answer;
    this.kind = about.kind ?? "folder";
    if (about.hooks !== undefined) this.hooks = about.hooks;
    if (about.agent !== undefined) this.agent = about.agent;
    this.agentName = dialect(about.agent)?.name ?? "Its agent";
    this.tool = this.kind === "hooks" ? { name: TRUST_HOOKS_TOOL, input: { hooks: this.hooks ?? null } } : { name: TRUST_TOOL, input: { folder } };
  }

  get open() {
    return this.held;
  }

  allow(): boolean {
    return this.settle(true);
  }

  deny(): boolean {
    return this.settle(false);
  }

  /** The floor lets go of it: still asking, so still open (its card stays up). True while it is. */
  release(): boolean {
    return this.held;
  }

  /** It went away by itself: not held any more, and onClosed told (once). */
  close() {
    if (!this.held) return;
    this.held = false;
    this.onClosed();
  }

  private settle(allow: boolean) {
    if (!this.held) return false;
    this.held = false;
    this.answered = allow;
    this.answer_(allow);
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

/** A held prompt that is a session's trust question. */
export const isTrust = (held: unknown): held is TrustQuestion => held instanceof TrustQuestion;

/**
 * How a trust card was settled: answered on the Mac's card (the window's or the TUI's keys), by
 * voice, or on a phone; in its window (the question left its screen); by SessionStart (it started,
 * so it was answered there); or the session (or its pane) ended, Kiko closing it included.
 */
export type TrustSettled = "card" | "voice" | "phone" | "terminal" | "session_start" | "ended";

/**
 * The trust cards up now, one per session still starting, oldest first. A card stays up until it's
 * settled (no window, never answered for you), and is settled once: `settled` is told then (the app
 * takes it down from the Mac and every phone, and logs how). The floor asking it out loud, or not,
 * is the floor's business: a card it let go of is still up here.
 */
export class TrustCards {
  private cards = new Map<string, TrustQuestion>();
  private readonly settled: (question: TrustQuestion, how: TrustSettled) => void;

  constructor(settled: (question: TrustQuestion, how: TrustSettled) => void) {
    this.settled = settled;
  }

  /** Asked: up from now. False (and not added) when that session has one up already. */
  add(question: TrustQuestion): boolean {
    if (this.cards.has(question.sessionId)) return false;
    this.cards.set(question.sessionId, question);
    return true;
  }

  /** The card up for a session still starting (its starting ID), if one is. */
  get(startingId: string): TrustQuestion | undefined {
    return this.cards.get(startingId);
  }

  /** Every card up, oldest first. */
  up(): TrustQuestion[] {
    return [...this.cards.values()];
  }

  /**
   * Settled: taken down, once. Answered here (`allow` given: "card", "voice", "phone"), its answer
   * goes to it (allow() or deny(): the app presses its keys); otherwise it went away by itself
   * (close(): onClosed told). False when no card was up for it.
   */
  settle(startingId: string, how: TrustSettled, allow?: boolean): boolean {
    const question = this.cards.get(startingId);
    if (!question) return false;
    this.cards.delete(startingId);
    question.settledHow = how;
    if (allow === undefined) question.close();
    else if (allow) question.allow();
    else question.deny();
    this.settled(question, how);
    return true;
  }
}

/**
 * What answering needs: the pane's screen now (null: gone), one key into it, a pause, and whether
 * its program still runs there (a program that exited may leave its last screen behind it).
 */
export type TrustKeys = {
  screen(): Promise<string | null>;
  running?(): Promise<boolean>;
  press(key: "down" | "up" | "enter" | "escape"): Promise<{ sent: boolean; why?: string }>;
  wait(ms: number): Promise<void>;
};

/** How it went: `ok` the answer took (the question gone from the screen), `how` the keys sent, `why` when not. */
type TrustAnswer = { ok: boolean; how: string; why?: string };

// How long the screen gets to show a key's effect, and how often it's read meanwhile.
const SETTLE_MS = 2000;
const LOOK_MS = 100;

/** Which question is answered: its agent (undefined: the main agent) and kind. */
type Which = { agent?: string; kind?: TrustKind };

/** The screen read as this question (another one, or none: null). */
function readAs(screen: string | null, which: Which): TrustScreen | null {
  const seen = screen === null ? null : readTrustPrompt(screen, which.agent);
  return seen && seen.kind === (which.kind ?? "folder") ? seen : null;
}

/** Reads the screen until `done` says so, or for about SETTLE_MS: the last read. */
async function lookUntil(io: TrustKeys, which: Which, done: (seen: TrustScreen | null) => boolean) {
  for (let look = 0; ; look++) {
    const screen = await io.screen();
    const seen = readAs(screen, which);
    if (done(seen) || look >= SETTLE_MS / LOOK_MS) return { seen, screen };
    await io.wait(LOOK_MS);
  }
}

/**
 * The option that does `want` picked on the screen: Down or Up one option at a time toward it, the
 * screen read after each key and the marker seen to move before the next; seen on it before it
 * returns. Never Enter. Null when it is, else why not.
 */
async function pick(io: TrustKeys, which: Which, want: "yes" | "no", keys: string[]): Promise<string | null> {
  const first = (await lookUntil(io, which, (seen) => seen !== null)).seen;
  if (!first) return "the question isn't on its screen";
  let now: TrustScreen = first;
  const target = now.options.indexOf(want);
  if (target < 0) return `it has no option to ${want === "yes" ? "trust" : "say no"}`;
  for (let step = 0; step < now.options.length; step++) {
    if (now.at === target) return null;
    if (now.at === null) return "I couldn't tell which answer is picked";
    const from: number = now.at;
    const key = from < target ? "down" : "up";
    const sent = await io.press(key);
    keys.push(key);
    if (!sent.sent) return sent.why ?? "the key didn't go in";
    const after: TrustScreen | null = (await lookUntil(io, which, (seen) => seen !== null && seen.at !== from)).seen;
    if (!after || after.at === from || after.at === null || Math.abs(after.at - from) !== 1) break;
    now = after;
  }
  return now.at === target ? null : `the ${want === "yes" ? "trust" : "don't-trust"} option didn't get picked`;
}

/**
 * Answers the trust question on a pane's screen (see the top): Enter only with the marker seen on
 * the option wanted right before it; for Claude Code's folder, denied with Escape first. `ok` once
 * the question has gone from the screen. Nothing else is ever pressed.
 */
export async function answerTrust(io: TrustKeys, allow: boolean, which: Which = {}): Promise<TrustAnswer> {
  const keys: string[] = [];
  const how = () => keys.join("+") || "none";
  // The question gone: off the screen (another question in its place counts), or its program ended (its last screen may still show it).
  const ended = async () => (io.running ? !(await io.running()) : false);
  const gone = async () => {
    for (let look = 0; look <= SETTLE_MS / LOOK_MS; look++) {
      const screen = await io.screen();
      if (screen === null || !readAs(screen, which) || (await ended())) return true;
      await io.wait(LOOK_MS);
    }
    return false;
  };
  const pickThenEnter = async (want: "yes" | "no"): Promise<TrustAnswer> => {
    const why = await pick(io, which, want, keys);
    if (why) return { ok: false, how: how(), why: `${why}, so I didn't press Enter` };
    const sent = await io.press("enter");
    keys.push("enter");
    if (!sent.sent) return { ok: false, how: how(), why: sent.why ?? "Enter didn't go in" };
    return (await gone()) ? { ok: true, how: how() } : { ok: false, how: how(), why: "it's still asking" };
  };
  if (allow) return pickThenEnter("yes");
  if (!readAs(await io.screen(), which)) return { ok: false, how: how(), why: "the question isn't on its screen" };
  if (dialect(which.agent)?.escapeDenies) {
    const esc = await io.press("escape");
    keys.push("escape");
    if (esc.sent && (await gone())) return { ok: true, how: how() };
  }
  return pickThenEnter("no");
}
