// A session's recent conversation, from its Claude Code transcript: your messages, Claude's text,
// and the tool calls between them folded into steps ("ran 4 commands, edited 3 files"), each with
// its details (a command and its output cut short, a file and its lines added and removed). And a
// watcher that follows the transcript as Claude Code writes it, entry by entry, for a live view:
// the phone's session screen (src/remote/) and the Kiko window's viewer. Nothing here knows who
// shows it. Core reaches it through the agent (src/agents/claude-code/ watchHistory): another agent
// would turn its own record into the same History. For the phone's chat it also says an edit's
// lines added and removed and its changes (`diff`), which steps are still running and what the
// session is doing now ("Running pnpm build": `doing`), and the conversation before a point, for
// earlier messages as you scroll up (historyBefore; itemsBefore from a point in the file, for a
// page asked for with a cursor), and one item again with more of it kept (itemAt: Show full).
//
// Each item read from a file has an id: where in the file the entry that started it is (its byte
// offset, and ".1", ".2" for a second or third item from the same entry). It stays the same however
// much of the file is read, so the live view, a page and Show full name the same item the same way,
// and a page asked for before an item reads only what comes before it.
//
// Transcripts are internal to Claude Code and their format may change, so this is best effort:
// lines it doesn't understand are skipped, and a missing file is an empty history.
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
// How hooks/claude-code-hook.mjs hands Claude a spoken reply: worded in the hooks' own library since
// 2026-11-14 (it was repeated here, to be kept in step by hand), and taken off again below. The line
// the hook adds beside a prompt the app typed in for you (VOICE_PROMPT, UserPromptSubmit) is kept in
// the transcript the same way, as a hook's added context after the prompt: it isn't a reply, so
// like any other hook's context it's never shown as your words.
import { VOICE_REPLY } from "../../hooks/lib.mjs";
import { unpasted } from "./dictated.ts";
import { flat } from "./text.ts";

export type Step = {
  tool: string;
  /** The command, the file, the pattern: what it was. */
  title: string;
  /** What came of it: a command's output (cut short), "+3 −1" for an edit; "" when nothing to say. */
  detail: string;
  error: boolean;
  /** A file edit's size: lines added and removed (`detail` says the same: "+3 −1"). Left out for anything else. */
  added?: number;
  removed?: number;
  /**
   * A file edit's changes, as a unified diff's lines ("-old", "+new", " context", "@@ … @@"), cut
   * short (LIMITS.diffLines, LIMITS.diff). Left out where its record says nothing of them (a Codex
   * change is mirrored with only its counts), and from older edits past a snapshot's LIMITS.diffBudget.
   */
  diff?: string;
  /** No result yet: it's running now. Only in the newest item (one that never got a result, interrupted, is just left). */
  running?: boolean;
  /** Its output or diff was cut short (or the diff left out): more of it is in the record (itemAt). */
  cut?: true;
};

/**
 * `id`: where it starts in the file (see the top), when it was read from one. `cut` on a message:
 * its text was cut short.
 */
export type HistoryItem = ({ kind: "you" | "claude"; text: string; at: string | null; cut?: true } | { kind: "steps"; summary: string; steps: Step[]; at: string | null }) & {
  id?: string;
};

/**
 * `doing`: what the session is doing now, when its newest item is steps and the last of them is
 * still running ("Running pnpm build", "Editing app.ts"), for a live line under the conversation.
 */
export type History = { items: HistoryItem[]; truncated: boolean; doing?: string };

/** Sizes kept: the protocol's caps (protocol/schema.json) are the same or larger. */
export const LIMITS: Limits = {
  /** Read at most this much of the end of a transcript. */
  tailBytes: 2 * 1024 * 1024,
  items: 60,
  text: 6000,
  steps: 40,
  title: 300,
  detail: 1500,
  /** Lines of a command's output kept. */
  outputLines: 12,
  /** An edit's diff: lines kept, and characters at most. */
  diffLines: 80,
  diff: 4000,
  /**
   * The diffs one snapshot carries at most, newest first: the history goes out whole each time it
   * changes (up to twice a second while a session works), over cellular too.
   */
  diffBudget: 60_000,
  /** What `doing` says at most. */
  doing: 120,
};

export type Limits = {
  tailBytes: number;
  items: number;
  text: number;
  steps: number;
  title: number;
  detail: number;
  outputLines: number;
  diffLines: number;
  diff: number;
  diffBudget: number;
  doing: number;
};

/**
 * One item with more of it kept, for Show full (itemAt): a message's text, a command's output and an
 * edit's diff, each far longer than the live view's. The same steps (40), so a step is the same one
 * by its place.
 */
export const FULL: Limits = { ...LIMITS, text: 60_000, detail: 24_000, outputLines: 400, diffLines: 800, diff: 48_000, diffBudget: Number.POSITIVE_INFINITY };

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Tools that change files, read them, or search, for the folded summary. */
const EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const READS = new Set(["Read", "NotebookRead"]);
const SEARCHES = new Set(["Grep", "Glob", "WebSearch", "WebFetch", "ToolSearch"]);

// The blocks Claude Code writes into a user message itself, each `<name …>…</name>`: every one seen
// starting a user message or a queued one in real transcripts (2026-11-14, 1,245 of them), and
// local-command-stderr beside its stdout. A slash command and what it printed, a `!` command and
// its output, a reminder, a background task's notice, a subagent's hand-back, another session's message.
const INJECTED = [
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
  "bash-input",
  "bash-stdout",
  "bash-stderr",
  "system-reminder",
  "task-notification",
  "agent-message",
  "cross-session-message",
].join("|");
/** One of them at the very start, whole. */
const INJECTED_FIRST = new RegExp(`^<(${INJECTED})(?:\\s[^>]*)?>[\\s\\S]*?</\\1>\\s*`);
/** One of them from the start of a line to the very end, whole (the last one: no other of its name opens inside it). */
const INJECTED_LAST = new RegExp(`(?:^|\\n)[ \\t]*<(${INJECTED})(?:\\s[^>\\n]*)?>(?:(?!<\\1[\\s>])[\\s\\S])*</\\1>$`);

/**
 * Your words in a user message's text, as they're shown and said back; "" when none of it is yours.
 *
 * Until 2026-11-14 any text starting with "<" was dropped, to hide Claude Code's own messages (a
 * slash command, a reminder, a task's notice). But Claude Code also hands on a long typed or pasted
 * prompt between `<pasted_content id="…">` lines (core/dictated.ts), and the app's own typing
 * arrives as a paste: every dictation over about 800 characters started with "<", and was missing
 * from the conversation, the phone's chat and the turn's words.
 *
 * The rule is still "starting with '<' is hidden", with two things taken off first, and not a list
 * of what to hide: Claude Code's wrappers change with its versions (the list above is only what
 * these transcripts hold), and one not listed yet would be shown, and told to a summary, as yours.
 * So the list only ever shows more: a known block at the start or the end comes off and the words
 * beside it stay. And a message that starts with a paste is yours whatever was pasted (HTML, say).
 * The paste lines come off last, so a block inside a paste stays as pasted. Something typed by hand
 * that starts with "<" (too short to be wrapped) is still hidden, as before: nothing tells it from
 * a wrapper.
 */
export function yourWords(raw: string): string {
  let text = raw.trim();
  for (let m = INJECTED_FIRST.exec(text); m; m = INJECTED_FIRST.exec(text)) text = text.slice(m[0].length);
  for (let m = INJECTED_LAST.exec(text); m; m = INJECTED_LAST.exec(text)) text = text.slice(0, m.index).trimEnd();
  // A first line that is all paste tag: nothing is left of it once the paste lines are off.
  const pasted = !unpasted(text.split("\n", 1)[0]);
  return text.startsWith("<") && !pasted ? "" : unpasted(text);
}

/**
 * A user entry's text as your words: each text block on its own, as the conversation takes them
 * (HistoryFolder.add), then together. Joined first, as a prompt and what was last asked were read
 * until 2026-11-14, one block that is a wrapper hid your words in the next. "" for a tool's result
 * or a wrapper.
 */
export const yourBlocks = (content: unknown): string =>
  typeof content === "string"
    ? yourWords(content)
    : Array.isArray(content)
      ? content
          .flatMap((b: any) => (b?.type === "text" && typeof b.text === "string" ? [yourWords(b.text)] : []))
          .filter(Boolean)
          .join("\n")
      : "";

/**
 * Turns transcript entries into history items as they come, in order. Tool calls between two
 * pieces of text fold into one steps item; a tool's result (a later entry) fills in its step.
 */
export class HistoryFolder {
  private all: HistoryItem[] = [];
  private open: (HistoryItem & { kind: "steps" }) | null = null;
  // Steps waiting for their result, by tool_use id; and every file an open fold edited, for the summary.
  private pending = new Map<string, { step: Step; fold: HistoryItem & { kind: "steps" } }>();
  private counts = new WeakMap<HistoryItem, { commands: number; edited: Set<string>; read: Set<string>; searches: number; other: number; more: number }>();
  /** Items were dropped from the front (LIMITS.items), or the transcript was read from part way. */
  truncated = false;
  /** How many items it keeps before it drops the oldest: a little more than a snapshot shows, or all of them (historyBefore). */
  private keep: number;
  private limits: Limits;
  /** Where the entry being read starts in its file, and how many items it started: for their ids. */
  private offset: number | undefined;
  private started = 0;
  /** The next item starts part way through (a read from the middle of the file): left out, `partial`. */
  private skipNext = false;
  private partial: HistoryItem | null = null;

  constructor(keep = LIMITS.items * 2, limits: Limits = LIMITS) {
    this.keep = keep;
    this.limits = limits;
  }

  /**
   * What's read next starts part way through the file: the first item it starts may have begun
   * before it (a fold's first steps, the first part of a reply), so it isn't shown; a page before
   * the next one brings it whole.
   */
  cutShort() {
    this.skipNext = true;
  }

  /** One transcript line, parsed (`offset`: where it starts in its file, for the items' ids). True when the history changed. */
  add(entry: any, offset?: number): boolean {
    this.offset = offset;
    this.started = 0;
    if (!entry || typeof entry !== "object" || entry.isSidechain || entry.isMeta) return false;
    const at = typeof entry.timestamp === "string" ? entry.timestamp : null;
    const content = entry.message?.content;
    if (entry.type === "user") {
      if (typeof content === "string") return this.said("you", content, at);
      if (!Array.isArray(content)) return false;
      let changed = false;
      for (const block of content) {
        if (block?.type === "tool_result") changed = this.result(block, entry.toolUseResult) || changed;
        else if (block?.type === "text") changed = this.said("you", block.text, at) || changed;
      }
      return changed;
    }
    // Your words that reach Claude another way: a spoken reply given through the Stop hook (kept as
    // the hook's added context), and a message sent while Claude was busy (kept as a queued command).
    if (entry.type === "attachment") {
      const a = entry.attachment;
      if (a?.type === "hook_additional_context" && Array.isArray(a.content)) {
        let changed = false;
        for (const line of a.content) {
          const reply = typeof line === "string" && line.startsWith(VOICE_REPLY) ? line.slice(VOICE_REPLY.length) : null;
          if (reply) changed = this.said("you", reply, at) || changed;
        }
        return changed;
      }
      // Its words are a string, or (a message with a picture, 2.1.327: imagePasteIds) blocks as a
      // user entry's are: each text block, the picture left out. One Claude Code made itself
      // (isMeta on the attachment: another agent's hand-back) is never yours.
      if (a?.type === "queued_command" && !a.isMeta) {
        if (typeof a.prompt === "string") return this.said("you", a.prompt, at);
        if (!Array.isArray(a.prompt)) return false;
        let changed = false;
        for (const block of a.prompt) if (block?.type === "text") changed = this.said("you", block.text, at) || changed;
        return changed;
      }
      return false;
    }
    if (entry.type === "assistant" && Array.isArray(content)) {
      let changed = false;
      for (const block of content) {
        if (block?.type === "text") changed = this.said("claude", block.text, at) || changed;
        else if (block?.type === "tool_use") changed = this.toolUse(block, at) || changed;
      }
      return changed;
    }
    return false;
  }

  /** The history now: the last LIMITS.items items, the newest one's steps still running marked, and what it's doing. */
  snapshot(): History {
    const items = this.shown().slice(-this.limits.items);
    const copied = copies(items, this.newestRunning(), this.limits);
    const doing = doingNow(copied, this.limits);
    return { items: copied, truncated: this.truncated || this.all.length > items.length, ...(doing ? { doing } : {}) };
  }

  /** Every item kept (all of them, for a folder made to keep all: historyBefore), as copies, none marked running. */
  everything(): HistoryItem[] {
    return copies(this.shown(), new Set(), this.limits);
  }

  /** What's kept, but an item that started before what was read (cutShort). */
  private shown(): HistoryItem[] {
    return this.partial ? this.all.filter((i) => i !== this.partial) : this.all;
  }

  /** The newest item's steps still waiting for their result. */
  private newestRunning(): Set<Step> {
    const last = this.all.at(-1);
    if (last?.kind !== "steps") return new Set();
    return new Set([...this.pending.values()].filter((p) => p.fold === last).map((p) => p.step));
  }

  private said(kind: "you" | "claude", raw: unknown, at: string | null) {
    if (typeof raw !== "string") return false;
    // Claude Code's own wrappers (slash commands, task notifications, reminders) aren't your words;
    // a long dictation or a paste, which it wraps too, is (yourWords, 2026-11-14).
    const text = kind === "you" ? yourWords(raw) : raw.trim();
    if (!text) return false;
    this.open = null;
    const last = this.all.at(-1);
    // Claude's text split over several entries in a row is one message.
    const max = this.limits.text;
    if (kind === "claude" && last?.kind === "claude") {
      const joined = `${last.text}\n\n${text}`;
      last.text = cut(joined, max);
      if (joined.length > max) last.cut = true;
    } else this.push({ kind, text: cut(text, max), at, ...(text.length > max ? { cut: true as const } : {}) });
    return true;
  }

  private toolUse(block: any, at: string | null) {
    const name = typeof block.name === "string" ? block.name : "tool";
    const input = block.input && typeof block.input === "object" ? block.input : {};
    if (!this.open) {
      this.open = { kind: "steps", summary: "", steps: [], at };
      this.counts.set(this.open, { commands: 0, edited: new Set(), read: new Set(), searches: 0, other: 0, more: 0 });
      this.push(this.open);
    }
    const fold = this.open;
    const c = this.counts.get(fold)!;
    const step = describe(name, input, this.limits);
    if (name === "Bash") c.commands++;
    else if (EDITS.has(name)) c.edited.add(step.title);
    else if (READS.has(name)) c.read.add(step.title);
    else if (SEARCHES.has(name)) c.searches++;
    else c.other++;
    if (fold.steps.length < this.limits.steps) fold.steps.push(step);
    else c.more++;
    if (typeof block.id === "string") this.pending.set(block.id, { step, fold });
    fold.summary = summarize(c);
    return true;
  }

  private result(block: any, structured: any) {
    const found = typeof block.tool_use_id === "string" ? this.pending.get(block.tool_use_id) : undefined;
    if (!found) return false;
    this.pending.delete(block.tool_use_id);
    const { step } = found;
    step.error = block.is_error === true;
    if (step.tool === "Bash" || step.error) {
      const out = output(resultText(block.content), this.limits);
      step.detail = cut(out.text, this.limits.detail);
      if (out.cut || out.text.length > this.limits.detail) step.cut = true;
    } else if (EDITS.has(step.tool)) {
      const patch = patchOf(structured, this.limits);
      if (patch) {
        Object.assign(step, { added: patch.added, removed: patch.removed, detail: stats(patch.added, patch.removed) });
        // Its own lines, with context, when the patch has them (a Codex change's has only the counts).
        if (patch.diff) {
          step.diff = patch.diff.text;
          if (patch.diff.cut) step.cut = true;
          else delete step.cut;
        }
      }
    }
    return true;
  }

  private push(item: HistoryItem) {
    if (this.offset !== undefined) {
      const n = this.started++;
      item.id = n ? `${this.offset}.${n}` : String(this.offset);
    }
    if (this.skipNext) {
      this.skipNext = false;
      this.partial = item;
      this.truncated = true;
    }
    this.all.push(item);
    // Keep a little more than is shown, so a fold still open isn't lost.
    if (this.all.length > this.keep) {
      this.all.splice(0, this.all.length - this.limits.items);
      this.truncated = true;
      if (this.partial && !this.all.includes(this.partial)) this.partial = null;
    }
  }
}

/** A step from a tool call: what it is, and for an edit, its size from the input. */
function describe(tool: string, input: Record<string, any>, limits: Limits): Step {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const file = str(input.file_path) || str(input.notebook_path) || str(input.path);
  let title: string;
  let detail = "";
  // An edit's size and changes from its input, until its result's patch says them better.
  let edit: { added: number; removed: number; diff: Short } | null = null;
  switch (tool) {
    case "Bash":
      title = flat(str(input.command)) || str(input.description);
      break;
    case "Edit":
      title = file;
      edit = { added: lines(str(input.new_string)), removed: lines(str(input.old_string)), diff: replaced(str(input.old_string), str(input.new_string), limits) };
      detail = stats(edit.added, edit.removed);
      break;
    case "MultiEdit": {
      title = file;
      const edits: any[] = Array.isArray(input.edits) ? input.edits : [];
      edit = {
        added: edits.reduce((n, e) => n + lines(str(e?.new_string)), 0),
        removed: edits.reduce((n, e) => n + lines(str(e?.old_string)), 0),
        diff: shortDiff(
          edits.flatMap((e, i) => [...(i ? ["@@"] : []), ...changed(str(e?.old_string), str(e?.new_string))]),
          limits,
        ),
      };
      detail = stats(edit.added, edit.removed);
      break;
    }
    case "Write":
      title = file;
      edit = { added: lines(str(input.content)), removed: 0, diff: replaced("", str(input.content), limits) };
      detail = `+${edit.added}`;
      break;
    case "Read":
      title = file;
      break;
    case "Grep":
    case "Glob":
      title = [str(input.pattern), str(input.path)].filter(Boolean).join(" in ");
      break;
    case "WebFetch":
      title = str(input.url);
      break;
    case "WebSearch":
      title = str(input.query);
      break;
    case "Agent":
    case "Task":
      title = str(input.description) || str(input.subagent_type);
      break;
    default:
      title = file || flat(JSON.stringify(input) ?? "");
  }
  const step: Step = { tool, title: cut(title || tool, limits.title), detail, error: false };
  if (edit) Object.assign(step, { added: edit.added, removed: edit.removed }, edit.diff.text ? { diff: edit.diff.text } : {}, edit.diff.cut ? { cut: true } : {});
  return step;
}

const lines = (text: string) => (text ? text.split("\n").length : 0);
const stats = (added: number, removed: number) => `+${added} −${removed}`;

/** An edit's lines from its input: the old text's taken out, the new text's put in. */
const changed = (old: string, now: string) => [...(old ? old.split("\n").map((l) => `-${l}`) : []), ...(now ? now.split("\n").map((l) => `+${l}`) : [])];
const replaced = (old: string, now: string, limits: Limits) => shortDiff(changed(old, now), limits);

/** Text, and whether some of it was left out. */
type Short = { text: string; cut: boolean };

/** A diff's lines: the first `limits.diffLines` of them within `limits.diff` characters, and how many more there were. */
function shortDiff(all: string[], limits: Limits): Short {
  const kept: string[] = [];
  let size = 0;
  let long = false;
  for (const line of all) {
    const l = cut(line, 300);
    if (kept.length >= limits.diffLines || size + l.length + 1 > limits.diff) break;
    if (l.length < line.length) long = true;
    kept.push(l);
    size += l.length + 1;
  }
  if (kept.length < all.length) return { text: `${kept.join("\n")}\n… ${all.length - kept.length} more lines`, cut: true };
  return { text: kept.join("\n"), cut: long };
}

/**
 * An edit's size from Claude Code's structured patch, when the transcript has one; and its lines as
 * a diff ("@@ -3,4 +3,6 @@" before each hunk) when they carry text: a patch of bare signs (a Codex
 * change, mirrored with only its counts) has none.
 */
function patchOf(structured: any, limits: Limits): { added: number; removed: number; diff: Short | null } | null {
  const hunks = structured?.structuredPatch;
  if (!Array.isArray(hunks)) return null;
  let added = 0;
  let removed = 0;
  let text = false;
  const out: string[] = [];
  for (const hunk of hunks) {
    const at = [hunk?.oldStart, hunk?.oldLines, hunk?.newStart, hunk?.newLines];
    if (at.every((n) => Number.isInteger(n))) out.push(`@@ -${at[0]},${at[1]} +${at[2]},${at[3]} @@`);
    for (const line of Array.isArray(hunk?.lines) ? hunk.lines : []) {
      if (typeof line !== "string") continue;
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
      if (line.length > 1) text = true;
      out.push(line);
    }
  }
  return { added, removed, diff: text ? shortDiff(out, limits) : null };
}

/**
 * Copies of items (an open fold's steps change as their results come in): the steps in `running`
 * marked, and their diffs kept newest first within the diff budget, older ones' left out (`cut`:
 * Show full brings it).
 */
function copies(items: HistoryItem[], running: Set<Step>, limits: Limits): HistoryItem[] {
  let budget = limits.diffBudget;
  const out: HistoryItem[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind !== "steps") {
      out.push({ ...item });
      continue;
    }
    const steps = item.steps.map((s) => {
      const copy: Step = { ...s, ...(running.has(s) ? { running: true } : {}) };
      if (copy.diff && copy.diff.length > budget) {
        delete copy.diff;
        copy.cut = true;
      } else if (copy.diff) budget -= copy.diff.length;
      return copy;
    });
    out.push({ ...item, steps });
  }
  return out.reverse();
}

/** What the newest item's last running step is doing ("Running pnpm build"); undefined when none runs. */
function doingNow(items: HistoryItem[], limits: Limits): string | undefined {
  const last = items.at(-1);
  const step = last?.kind === "steps" ? last.steps.findLast((s) => s.running) : undefined;
  return step ? cut(doingOf(step), limits.doing) : undefined;
}

/**
 * A step as what's being done, in a few words for the phone's live line: "Running pnpm build",
 * "Editing app.ts", "Searching for created_at", "Using dns_update" (an MCP server's tool).
 */
export function doingOf(step: Pick<Step, "tool" | "title">): string {
  const base = (path: string) => path.split("/").filter(Boolean).pop() || path;
  const title = flat(step.title);
  const named = Boolean(title) && title !== step.tool;
  switch (step.tool) {
    case "Bash":
      return named ? `Running ${title}` : "Running a command";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return named ? `Editing ${base(title)}` : "Editing a file";
    case "Write":
      return named ? `Writing ${base(title)}` : "Writing a file";
    case "Read":
    case "NotebookRead":
      return named ? `Reading ${base(title)}` : "Reading a file";
    case "Grep":
    case "Glob":
      return named ? `Searching for ${title}` : "Searching";
    case "WebFetch":
      try {
        return `Fetching ${new URL(title).hostname}`;
      } catch {
        return "Fetching a web page";
      }
    case "WebSearch":
      return named ? `Searching the web for ${title}` : "Searching the web";
    case "Agent":
    case "Task":
      return named ? `Running a subagent: ${title}` : "Running a subagent";
    case "ToolSearch":
      return "Looking up tools";
    default: {
      const mcp = step.tool.match(/^mcp__.+?__(.+)$/);
      return `Using ${mcp ? mcp[1] : step.tool}`;
    }
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((b: any) => (b?.type === "text" && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  return "";
}

/** A command's output: its first lines, and how many more there were. */
function output(text: string, limits: Limits): Short {
  const all = text.trimEnd().split("\n");
  if (all.length <= limits.outputLines) return { text: all.join("\n"), cut: false };
  return { text: `${all.slice(0, limits.outputLines).join("\n")}\n… ${all.length - limits.outputLines} more lines`, cut: true };
}

function summarize(c: { commands: number; edited: Set<string>; read: Set<string>; searches: number; other: number; more: number }) {
  const n = (count: number, one: string, many: string) => (count ? `${count === 1 ? one : many.replace("#", String(count))}` : "");
  return [
    n(c.read.size, "read 1 file", "read # files"),
    n(c.searches, "searched once", "searched # times"),
    n(c.edited.size, "edited 1 file", "edited # files"),
    n(c.commands, "ran 1 command", "ran # commands"),
    n(c.other, "1 other step", "# other steps"),
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * The end of a transcript (from `from`, at most `tailBytes` of it): its bytes, where they start in
 * the file, where the file ended, and whether the start was cut (a line there is only part of one).
 */
function readFrom(path: string, from: number, tailBytes = LIMITS.tailBytes): { bytes: Buffer; start: number; end: number; cutShort: boolean } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(from, size - tailBytes);
    const bytes = Buffer.alloc(size - start);
    readSync(fd, bytes, 0, bytes.length, start);
    return { bytes, start, end: size, cutShort: start > from };
  } finally {
    closeSync(fd);
  }
}

/** Bytes `start` to `end` of a file (as far as it goes), and the file's size. */
function readRange(path: string, start: number, end: number): { bytes: Buffer; size: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const to = Math.min(end, size);
    const bytes = Buffer.alloc(Math.max(0, to - start));
    if (bytes.length) readSync(fd, bytes, 0, bytes.length, start);
    return { bytes, size };
  } finally {
    closeSync(fd);
  }
}

/** The text of a transcript's end, for what reads its lines without folding them. */
const readText = (path: string, tailBytes = LIMITS.tailBytes) => readFrom(path, 0, tailBytes).bytes.toString("utf8");

/** How much of a transcript's end historyBefore reads at most: past this, its start isn't reached for. */
const BEFORE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * A session's conversation before a point (`before`: an item's `at`, the oldest one the phone
 * has): the last `count` items that started earlier, oldest first, and whether there are more
 * before them. The transcript's end is read, more of it each time, until it holds more than `count`
 * items before the point (the first, maybe cut part way, left out) or all of it is read; folded as
 * the live history is, so its items are the same. Nothing for no transcript, or a point that isn't a time.
 */
export function historyBefore(path: string | undefined, before: string, count = LIMITS.items): { items: HistoryItem[]; more: boolean } {
  const point = Date.parse(before);
  if (!path || !existsSync(path) || !Number.isFinite(point)) return { items: [], more: false };
  for (let bytes = LIMITS.tailBytes * 2; ; bytes *= 4) {
    const folder = new HistoryFolder(Infinity);
    const { bytes: read, start, cutShort } = readFrom(path, 0, Math.min(bytes, BEFORE_MAX_BYTES));
    if (cutShort) folder.cutShort();
    feed(folder, read, start, true);
    const all = folder.everything();
    const at = all.findIndex((i) => i.at !== null && Date.parse(i.at) >= point);
    const earlier = all.slice(0, at < 0 ? all.length : at);
    const last = bytes >= BEFORE_MAX_BYTES;
    if (!cutShort || earlier.length > count || last) return { items: earlier.slice(-count), more: earlier.length > count || (cutShort && !last) };
  }
}

/** Where an item starts in its file, from its id ("1234", "1234.1"); null for an id that isn't one. */
export function offsetOf(id: string): number | null {
  return placeOf(id)?.offset ?? null;
}

/** An id as where its entry starts and which of that entry's items it is (0 for the first). */
function placeOf(id: string): { offset: number; n: number } | null {
  const m = /^(\d{1,15})(?:\.(\d{1,4}))?$/.exec(id);
  return m ? { offset: Number(m[1]), n: Number(m[2] ?? 0) } : null;
}

/** Where the line starting at `offset` ends (just past its newline), or the file's end. */
function lineEnd(path: string, offset: number): number {
  for (let at = offset; ; at += 1024 * 1024) {
    const { bytes, size } = readRange(path, at, at + 1024 * 1024);
    const nl = bytes.indexOf(0x0a);
    if (nl >= 0) return at + nl + 1;
    if (at + bytes.length >= size || !bytes.length) return size;
  }
}

/** A point a page can be read before: the start of a line in the file (the byte before it a newline), not past its end. */
function lineStart(path: string, offset: number): boolean {
  if (offset === 0) return true;
  const { bytes, size } = readRange(path, offset - 1, offset);
  return offset <= size && bytes[0] === 0x0a;
}

/**
 * The items before a point in a transcript (`before`: an item's id, where it starts in the file),
 * oldest first: the file before it is read, from its end back, more of it each time, until `enough`
 * says what's there will do (the page asked for fits in it with some to spare) or the file's start is
 * reached (`start`: nothing before these). An item that began before what was read is left out. Null
 * when `before` isn't the start of a line in the file (the file was written again since: ask by time).
 */
export function itemsBefore(path: string | undefined, before: string, enough: (items: HistoryItem[]) => boolean): { items: HistoryItem[]; start: boolean } | null {
  const place = placeOf(before);
  if (!path || !place || !existsSync(path) || !lineStart(path, place.offset)) return null;
  const { offset, n } = place;
  // An item that isn't its entry's first: that entry's items before it are before it too.
  const to = n > 0 ? lineEnd(path, offset) : offset;
  const earlier = (i: HistoryItem) => {
    const p = i.id ? placeOf(i.id) : null;
    return !p || p.offset < offset || (p.offset === offset && p.n < n);
  };
  for (let bytes = 256 * 1024; ; bytes *= 4) {
    const from = Math.max(0, offset - Math.min(bytes, BEFORE_MAX_BYTES));
    const folder = new HistoryFolder(Infinity);
    if (from > 0) folder.cutShort();
    feed(folder, readRange(path, from, to).bytes, from, true);
    const items = folder.everything().filter(earlier);
    if (from === 0) return { items, start: true };
    if (enough(items) || bytes >= BEFORE_MAX_BYTES) return { items, start: false };
  }
}

/** How much itemAt reads at most: an item longer than this (its steps' results) is cut where it ends. */
const ITEM_MAX_BYTES = 16 * 1024 * 1024;

/**
 * One item again (by its id), with more of it kept (`limits`, FULL: Show full): read from where it
 * starts until the next item starts or the file ends. Null for an id that isn't an item's start.
 */
export function itemAt(path: string | undefined, id: string, limits: Limits = FULL): HistoryItem | null {
  const offset = offsetOf(id);
  if (!path || offset === null || !existsSync(path) || !lineStart(path, offset)) return null;
  for (let bytes = 1024 * 1024; ; bytes *= 4) {
    const folder = new HistoryFolder(Infinity, limits);
    const { bytes: read, size } = readRange(path, offset, offset + bytes);
    feed(folder, read, offset, true);
    const all = folder.everything();
    const at = all.findIndex((i) => i.id === id);
    const done = at >= 0 && at < all.length - 1;
    if (done || offset + bytes >= size || bytes >= ITEM_MAX_BYTES) return at >= 0 ? all[at] : null;
  }
}

/** What a followed file's lines go into (JsonlWatcher): one parsed line at a time (and where it starts in the file), true when it changed what's kept. */
export type Folder<T> = { add(entry: any, offset?: number): boolean; snapshot(): T; truncated: boolean; cutShort?(): void };

/**
 * A file's bytes (`start`: where they start in it) into a folder, line by line, each with where it
 * starts. A last line without its newline is still being written: handed back (`rest`), unless
 * `whole` (a part of the file read to its end, or up to a line's start: then it is a whole line).
 */
function feed(folder: Folder<unknown>, bytes: Buffer, start: number, whole = false): { changed: boolean; rest: Buffer } {
  let changed = false;
  let from = 0;
  const line = (end: number) => {
    const text = bytes.toString("utf8", from, end);
    if (text.trim()) {
      try {
        changed = folder.add(JSON.parse(text), start + from) || changed;
      } catch {
        // half a line (the start of a cut-short tail), or one this doesn't understand
      }
    }
  };
  for (let nl = bytes.indexOf(0x0a, from); nl >= 0; nl = bytes.indexOf(0x0a, from)) {
    line(nl);
    from = nl + 1;
  }
  if (whole && from < bytes.length) {
    line(bytes.length);
    from = bytes.length;
  }
  return { changed, rest: bytes.subarray(from) };
}

/** A session's recent conversation, read once (for the tests). */
export function readHistory(path: string | undefined): History {
  if (!path || !existsSync(path)) return { items: [], truncated: false };
  const folder = new HistoryFolder();
  const { bytes, start, cutShort } = readFrom(path, 0);
  if (cutShort) folder.cutShort();
  feed(folder, bytes, start, true);
  return folder.snapshot();
}

/** Where a turn ended: Claude Code writes its Stop hooks' summary, then the turn's duration, once they're done. */
const turnEnded = (e: any) => e?.type === "system" && (e.subtype === "stop_hook_summary" || e.subtype === "turn_duration");
/** A hook's own lines (hook_success, then hook_additional_context with a reply through it), just before its summary line. */
const hookLine = (e: any) => e?.type === "attachment" && typeof e.attachment?.type === "string" && e.attachment.type.startsWith("hook_");

/**
 * Your words to a session in the turn it's finishing: what reached it since its last turn ended, oldest
 * first. The prompt that started it (typed, or sent for you), a reply through the hook it was held in
 * then (kept just before that hook's summary line, so counted from there), and messages sent while it
 * was busy (queued commands, written when Claude took them in). Read while its own Stop hook is held,
 * before that ends the turn in the transcript. A turn longer than the tail read is counted from the
 * tail's start. A compacted conversation's summary isn't your words. Null with no transcript to read.
 */
export function saidThisTurn(path: string | undefined): string[] | null {
  if (!path || !existsSync(path)) return null;
  const entries: any[] = [];
  for (const line of readText(path).split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // half a line (the start of a cut-short tail), or one this doesn't understand
    }
  }
  let from = entries.length;
  while (from > 0 && !turnEnded(entries[from - 1])) from--;
  // Back over that hook's lines, to a reply through it.
  while (from > 0 && (turnEnded(entries[from - 1]) || hookLine(entries[from - 1]))) from--;
  const folder = new HistoryFolder();
  for (const entry of entries.slice(from)) if (!entry?.isCompactSummary) folder.add(entry);
  return folder.snapshot().items.flatMap((i) => (i.kind === "you" ? [i.text] : []));
}

/**
 * How a session's latest turn has gone so far: nothing back yet, Claude answering, or an error
 * Claude Code wrote in its place; with the prompt that started it (`id`: its entry's, to tell a
 * prompt sent again from the first).
 */
export type TurnSoFar = { kind: "none" } | { kind: "reply"; id: string; prompt: string } | { kind: "failed"; id: string; prompt: string; error: string; text: string };

/** How much of a transcript's end turnSoFar reads. */
const TURN_TAIL_BYTES = 512 * 1024;

/**
 * A prompt's text (typed, sent, or on the command line): a user entry of text, not a tool's result
 * or a wrapper; "" for anything else. A long one, which Claude Code wraps as a paste, counts since
 * 2026-11-14 (yourWords): it was passed over, so a long message that couldn't log in was never seen
 * to fail, the turn being read from the prompt before it.
 */
function promptOf(e: any): string {
  if (e?.type !== "user" || e.isMeta || e.isCompactSummary) return "";
  return yourBlocks(e.message?.content);
}

/**
 * The latest turn so far, from the transcript: what came after the last prompt. An error Claude
 * Code wrote instead of a reply (`isApiErrorMessage`, model "<synthetic>": "Not logged in · Please
 * run /login", error "authentication_failed") is `failed`; anything Claude wrote is `reply`. Read
 * as it's written: no Stop hook runs for such a turn (Claude Code runs StopFailure instead), so
 * nothing else tells the app.
 */
export function turnSoFar(path: string | undefined): TurnSoFar {
  if (!path || !existsSync(path)) return { kind: "none" };
  const entries: any[] = [];
  // Read twice a second while a turn starts: its end only (a prompt and what follows it, the
  // request's blobs included, were 240KB in a real one); a prompt further back is "none".
  for (const line of readText(path, TURN_TAIL_BYTES).split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // half a line (the start of a cut-short tail, or one still being written)
    }
  }
  let from = entries.length;
  while (from > 0 && !promptOf(entries[from - 1])) from--;
  if (from === 0) return { kind: "none" };
  const started = entries[from - 1];
  const id = String(started.uuid ?? started.timestamp ?? from);
  const prompt = promptOf(started);
  for (const e of entries.slice(from)) {
    if (e?.type !== "assistant") continue;
    if (!e.isApiErrorMessage) return { kind: "reply", id, prompt };
    const content = e.message?.content;
    const text = Array.isArray(content)
      ? content
          .filter((b: any) => b?.type === "text")
          .map((b: any) => b.text)
          .join("\n")
          .trim()
      : String(content ?? "");
    return { kind: "failed", id, prompt, error: typeof e.error === "string" ? e.error : "", text };
  }
  return { kind: "none" };
}

/**
 * Follows a file of JSON lines as it's written (a transcript, Kiko's page): `changed` gets what
 * `make()`'s folder keeps of it now, at once, then each time new lines change it, checked every
 * `everyMs`. Only the end is read the first time (LIMITS.tailBytes), then only what's added. Only
 * whole lines count, so a line half written waits for the next check. A file that shrank or was
 * replaced is read again from the start.
 */
export class JsonlWatcher<T> {
  private folder: Folder<T>;
  private offset = 0;
  /** The start of a line still being written, read already (it starts at offset - rest.length). */
  private rest: Buffer = Buffer.alloc(0);
  private timer: NodeJS.Timeout | null = null;
  private path: string;
  private make: () => Folder<T>;
  private changed: (kept: T) => void;

  constructor(path: string, make: () => Folder<T>, changed: (kept: T) => void, everyMs = 500) {
    this.path = path;
    this.make = make;
    this.folder = make();
    this.changed = changed;
    this.check(true);
    this.timer = setInterval(() => this.check(false), everyMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Reads what was added since the last check. */
  check(first = false) {
    let size = 0;
    try {
      size = statSync(this.path).size;
    } catch {
      if (first) this.changed(this.folder.snapshot());
      return;
    }
    if (size < this.offset) {
      this.folder = this.make();
      this.offset = 0;
      this.rest = Buffer.alloc(0);
    }
    if (size === this.offset && !first) return;
    let changed = first;
    try {
      const { bytes, start, end, cutShort } = readFrom(this.path, this.offset);
      if (cutShort) {
        this.folder.truncated = true;
        this.folder.cutShort?.();
        this.rest = Buffer.alloc(0);
      }
      this.offset = end;
      const fed = feed(this.folder, this.rest.length ? Buffer.concat([this.rest, bytes]) : bytes, start - this.rest.length);
      this.rest = Buffer.from(fed.rest);
      changed ||= fed.changed;
    } catch {
      return;
    }
    if (changed) this.changed(this.folder.snapshot());
  }
}

/**
 * Follows a transcript as Claude Code writes it: `changed` gets the history now, at once, then each
 * time new entries change it (a message, a step, a step's result), checked every `everyMs`.
 */
export class HistoryWatcher extends JsonlWatcher<History> {
  constructor(path: string, changed: (history: History) => void, everyMs = 500) {
    super(path, () => new HistoryFolder(), changed, everyMs);
  }
}
