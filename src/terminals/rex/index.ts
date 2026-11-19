// Rex (superlogical.com/rex), through its CLI (./rex.ts): a session's terminal block found by its
// process, as tmux finds a pane, never by a title. Rex says, for each block, what's in front in it
// and the processes between that and the one the block started (its `process` method), so a
// session's block is the one whose front process, or one of those under it, is the session's own.
// Claude Code's hooks also say the block they ran in (REX_BLOCK: hooks/lib.mjs terminalEnv), which
// is looked at first (Findable.pane) and taken only if the session's process is in it still. A
// session whose process isn't known (Codex's: AgentSession.program) is found by its program in
// front and its folder, as tmux's byProgram does.
//
// Before every word and key, the block is looked at again: there, the session's process in front
// in it (not something it started, not a shell after it ended), its title not an agent's list of
// sessions (../views.ts). And the send itself goes in only if the process in front is still that
// one (and, for a bracketed paste, it still asks for one), checked by Rex in the same step
// (./rex.ts SEND). Several lines go in as one bracketed paste (Rex's paste event, which brackets it
// as the program asked); one line is typed, unless the session wants a bracketed paste
// (Findable.bracketed: Codex's) and its program asks for those. Enter on its own after a moment,
// checked again first. Anything off: not sent, and why.
//
// Rex is listed only while a session may be in it (rexNeeded): one whose hook said Rex, or one whose
// terminal isn't known (a session from before its hooks said it, Codex's) while Rex's server is
// running (its socket there: no process started to ask). Someone who doesn't use Rex never has
// `rex` started, and a running server is never started for nothing: every rex command says
// `--autostart=false`. Finding is one `rex do` (every block, its processes and title: ~20 ms).
//
// New sessions (`open`) go in a new tab of the Rex session Kiko was started from (REX_SESSION), else
// of the first one, in the user's login shell, left in that shell after; its block is the handle.
import { basename } from "node:path";
import { log } from "../../core/log.ts";
import { shellWord } from "../../core/shell.ts";
import { literal, POSIX_SHELLS, SHELLS } from "../tmux/index.ts";
import type { Command, Findable, Found, Place, Terminal, Typed } from "../types.ts";
import { listViewOf } from "../views.ts";
import {
  BLOCK_ID,
  INSPECT,
  LIST,
  ownSession,
  parseInspect,
  parseList,
  parseScreen,
  parseSent,
  parseSessions,
  rexPath,
  rexRunning,
  runBlock,
  SCREEN,
  script,
  SEND,
  SESSIONS,
  tabSession,
  type Block,
  type Inspected,
  type RexKey,
  type Sent,
} from "./rex.ts";

/** What to send: text (as one bracketed paste, or typed), or one key. */
export type Sending = { text: string; paste: boolean } | { key: RexKey };

/** What the Rex adapter needs from the world: real for the app (./rex.ts), fake for the unit tests. */
export type RexDeps = {
  /** Every terminal block, looked at (one `rex do`). */
  list(): Promise<Block[]>;
  /** One block looked at closely; null when it's gone. */
  inspect(block: string): Promise<Inspected | null>;
  /** `what` into `block` only if `pid` is still what's in front there (Rex checks it as it sends). */
  send(block: string, what: Sending, pid: number): Promise<Sent>;
  /** What `block` shows; null when it's gone. */
  screen(block: string): Promise<string | null>;
  /** The server's sessions. */
  sessions(): Promise<string[]>;
  /** The session Kiko was started from (its REX_SESSION), when it was. */
  own(): string | null;
  /** A new block in `session` (null: in a new session) running `argv` in `cwd`: its id. */
  run(session: string | null, cwd: string, argv: string[]): Promise<string>;
  /** `rex` is installed. */
  installed(): boolean;
  /** Rex's server is running (its socket is there). */
  running(): boolean;
  wait(ms: number): Promise<void>;
  /** The user's login shell, which a session Kiko opens runs its command in. */
  shell: string;
};

/** The sessions Rex could have a block for: interactive, in a terminal (not the desktop app's), not T3 Code's threads; there by its hook, or not known. */
const mayBeHere = (s: Findable) => s.kind === "interactive" && !s.desktop && s.agent !== "t3code" && (s.terminal === "rex" || s.terminal === undefined);
/** And with something to find its block by: its process, or its program. */
const findable = (s: Findable) => mayBeHere(s) && (Number.isInteger(s.pid) || !!s.program);

/**
 * Whether Rex is to be listed for these sessions: one may be in it (its hook said Rex, or its
 * terminal isn't known), there's something to find it by, Rex's server is running and `rex` is
 * installed. Sessions known to be elsewhere (Ghostty, iTerm, Kiko's tmux) never are.
 */
export function rexNeeded(sessions: readonly Findable[], d: Pick<RexDeps, "installed" | "running">): boolean {
  return sessions.some(findable) && d.running() && d.installed();
}

/** What's in front in a block is its program, not a shell (a login shell's name may come as "-zsh"). */
const frontName = (b: Pick<Block, "name">) => basename((b.name ?? "").replace(/^-/, ""));

/**
 * Where each session is among `blocks`: by its process (the hinted block first, then the one block
 * whose front process or one under it is the session's), else by its program and folder (the
 * hinted block running it, else the only block in its folder running it when it's the only such
 * session there: "only"). Two sessions in one block: "ambiguous" (keys would reach either). A block
 * titled as an agent's list of sessions: "agents" (../views.ts).
 */
export function matchBlocks(sessions: readonly Findable[], blocks: readonly Block[]): Map<string, Found> {
  const found = new Map<string, Found>();
  const holds = (b: Block, pid: number) => b.pid === pid || b.up.includes(pid);
  const hinted = (s: Findable) => (s.pane && BLOCK_ID.test(s.pane) ? blocks.find((b) => b.block === s.pane) : undefined);
  const place = (s: Findable, b: Block, pid: number): Place => ({ via: "rex", id: b.block, keys: true, pid, ...(s.bracketed ? { bracketed: true } : {}) });

  const hits: Array<{ s: Findable & { pid: number }; b: Block }> = [];
  for (const s of sessions.filter(findable)) {
    if (!Number.isInteger(s.pid)) continue;
    const pid = s.pid!;
    const hint = hinted(s);
    if (hint && holds(hint, pid)) {
      hits.push({ s: s as Findable & { pid: number }, b: hint });
      continue;
    }
    const holding = blocks.filter((b) => holds(b, pid));
    if (holding.length === 1) hits.push({ s: s as Findable & { pid: number }, b: holding[0] });
    else if (holding.length > 1) found.set(s.sessionId, { place: null, mapping: "ambiguous" });
  }
  for (const { s, b } of hits) {
    const shared = hits.filter((h) => h.b.block === b.block).length > 1;
    found.set(s.sessionId, shared ? { place: null, mapping: "ambiguous" } : { place: place(s, b, s.pid), mapping: "process" });
  }

  // Its process unknown, its TUI's name known (Codex: its hooks run in its daemon).
  const taken = new Set(hits.map((h) => h.b.block));
  const unknown = sessions.filter((s) => findable(s) && !Number.isInteger(s.pid) && s.program);
  const runs = (b: Block, program: string) => !!b.pid && !taken.has(b.block) && frontName(b) === program;
  const rest: Findable[] = [];
  for (const s of unknown) {
    const hint = hinted(s);
    if (hint && runs(hint, s.program!)) {
      taken.add(hint.block);
      found.set(s.sessionId, { place: place(s, hint, hint.pid!), mapping: "process" });
    } else rest.push(s);
  }
  for (const s of rest) {
    const there = blocks.filter((b) => runs(b, s.program!) && b.cwd === s.cwd);
    const alike = rest.filter((o) => o.cwd === s.cwd && o.program === s.program);
    if (there.length === 1 && alike.length === 1) {
      taken.add(there[0].block);
      found.set(s.sessionId, { place: place(s, there[0], there[0].pid!), mapping: "only" });
    } else if (there.length) found.set(s.sessionId, { place: null, mapping: "ambiguous" });
  }

  // Found, but its block shows an agent's list of sessions (parked with ←: its process stays): nothing typed there would reach it.
  for (const [id, f] of found) {
    if (f.place && listViewOf(blocks.find((b) => b.block === f.place!.id)?.title ?? "")) found.set(id, { place: null, mapping: "agents" });
  }
  return found;
}

/**
 * Why `pid` can't be typed into in `block` (as looked at just now) right now, or null when it can:
 * the block is there, `pid` is what's in front in it, and its title isn't an agent's list.
 */
export function notReady(pid: number | undefined, block: Inspected | null): string | null {
  if (!pid) return "I don't know its process";
  if (!block) return "its Rex pane has closed";
  if (block.pid !== pid) return block.up.includes(pid) ? "something else is in front of it in its pane" : "it isn't running in that Rex pane any more";
  const view = listViewOf(block.title);
  if (view) return `its pane is showing ${view}`;
  return null;
}

// Rex's names for the keys an agent asks for (the physical key, as its key events name it).
// Enter and Tab carry their text, as a keyboard's do.
const KEYS: Record<string, RexKey> = {
  escape: { key: "escape" },
  enter: { key: "enter", text: "\r" },
  return: { key: "enter", text: "\r" },
  tab: { key: "tab", text: "\t" },
  "shift+tab": { key: "tab", mods: "shift" },
  up: { key: "arrow_up" },
  down: { key: "arrow_down" },
  left: { key: "arrow_left" },
  right: { key: "arrow_right" },
};

// Between the words and Enter: Claude Code takes keys that come all at once as a paste, where
// Enter is a new line rather than send (and Codex an Enter within 120ms of them).
const ENTER_AFTER_MS = 150;

const no = (why: string): Typed => ({ sent: false, why });

/** A send that didn't go in, said as `type` and `key` say it. */
function notSent(sent: Exclude<Sent, { status: "sent" }>, block: string, changed: string, after = ""): Typed {
  if (sent.status === "gone") return no(`its Rex pane has closed${after}`);
  if (sent.status === "changed") return no(changed);
  log("rex_failed", { block, error: sent.error });
  return { sent: false, why: `Rex didn't take it${after}`, error: sent.error };
}

const failedSend = (err: unknown): Sent => ({ status: "failed", error: err instanceof Error ? err.message : String(err) });

/** The Rex adapter, on `d` (the real one, `rex` below, or a fake). */
export function rexTerminal(d: RexDeps): Terminal {
  // Whether the last look needed Rex: then the next one lists its blocks as the sessions are being
  // listed, not after them.
  let wasNeeded = false;

  /** The place's block when everything about it checks out (see the top); else why not. */
  async function check(place: Place): Promise<{ block: Inspected } | { why: string }> {
    if (!BLOCK_ID.test(place.id)) return { why: "its Rex pane isn't one I know" };
    if (!place.pid) return { why: "I don't know its process" };
    let block: Inspected | null;
    try {
      block = await d.inspect(place.id);
    } catch (err) {
      log("rex_failed", { block: place.id, error: err instanceof Error ? err.message : String(err) });
      return { why: "Rex didn't answer" };
    }
    const why = notReady(place.pid, block);
    return why ? { why } : { block: block! };
  }

  /** What's in front in a block it opened: its program (not a shell), with its process; else why not. */
  async function front(handle: string): Promise<{ block: Inspected } | { why: string }> {
    if (!BLOCK_ID.test(handle)) return { why: "its Rex pane isn't one I know" };
    let block: Inspected | null;
    try {
      block = await d.inspect(handle);
    } catch (err) {
      log("rex_failed", { block: handle, error: err instanceof Error ? err.message : String(err) });
      return { why: "Rex didn't answer" };
    }
    if (!block) return { why: "its Rex pane has closed" };
    if (!block.pid || SHELLS.has(frontName(block)) || frontName(block) === basename(d.shell)) return { why: "its program has ended" };
    return { block };
  }

  const send = (block: string, what: Sending, pid: number) => d.send(block, what, pid).catch(failedSend);

  return {
    id: "rex",
    label: null,
    ready: () => d.running() && d.installed(),
    async find(sessions) {
      const early = wasNeeded ? d.list().catch(() => null) : null;
      const listed = await sessions;
      wasNeeded = rexNeeded(listed, d);
      if (!wasNeeded) return new Map<string, Found>();
      const blocks = await (early ?? d.list().catch(() => null));
      return blocks ? matchBlocks(listed, blocks) : new Map<string, Found>();
    },
    async type(place, text) {
      const before = await check(place);
      if ("why" in before) {
        log("rex_refused", { block: place.id, pid: place.pid ?? null, why: before.why });
        return no(before.why);
      }
      // Line breaks only as a bracketed paste: without one, each would send what came before it.
      let words = literal(text);
      if (!before.block.paste) words = words.replace(/\s*\n\s*/g, " ");
      const lines = words.split("\n").length;
      // One line as a bracketed paste too, for a program that wants it (Place.bracketed: Codex) and asks for them.
      const paste = lines > 1 || (place.bracketed === true && before.block.paste);
      log("terminal_type", { via: "rex", id: place.id, text: words, lines, ...(paste && lines === 1 ? { bracketed: true } : {}) });
      if (words) {
        const sent = await send(place.id, { text: words, paste }, place.pid!);
        if (sent.status !== "sent") {
          log("rex_refused", { block: place.id, pid: place.pid ?? null, status: sent.status });
          return notSent(sent, place.id, "its pane changed just as I typed, so nothing went in");
        }
      }
      await d.wait(ENTER_AFTER_MS);
      const after = await check(place);
      if ("why" in after) {
        log("rex_refused", { block: place.id, pid: place.pid ?? null, why: after.why, typed: true });
        return no(`${after.why}, so I typed it but didn't send it`);
      }
      const entered = await send(place.id, { key: KEYS.enter }, place.pid!);
      if (entered.status === "sent") return { sent: true };
      return notSent(entered, place.id, "its pane changed just as I pressed Enter, so I typed it but didn't send it", ", so I typed it but didn't send it");
    },
    async key(place, key) {
      const named = KEYS[key.toLowerCase()];
      if (!named) return no(`I don't know the key ${key}`);
      const before = await check(place);
      if ("why" in before) {
        log("rex_refused", { block: place.id, pid: place.pid ?? null, why: before.why, key });
        return no(before.why);
      }
      log("terminal_key", { via: "rex", id: place.id, key });
      const sent = await send(place.id, { key: named }, place.pid!);
      return sent.status === "sent" ? { sent: true } : notSent(sent, place.id, "its pane changed just as I pressed it, so nothing went in");
    },
    async program(handle) {
      if (!BLOCK_ID.test(handle)) return "gone";
      const block = await d.inspect(handle);
      if (!block || (block.exited && !block.pid)) return "gone";
      const name = frontName(block);
      return !block.pid || SHELLS.has(name) || name === basename(d.shell) ? "shell" : "running";
    },
    async placeIn(handle) {
      // A block it opened: what's in front there, as the place `type` then checks again, as for any session's.
      if (!BLOCK_ID.test(handle)) return null;
      try {
        const block = await d.inspect(handle);
        return block?.pid ? { via: "rex", id: handle, keys: true, pid: block.pid } : null;
      } catch {
        return null;
      }
    },
    async screen(handle) {
      if (!BLOCK_ID.test(handle)) return null;
      return d.screen(handle).catch(() => null);
    },
    async press(handle, key) {
      // A block it opened whose program hasn't started its session yet: no session process to check
      // (as `key` does), so what's in front there: its program, not the shell; and Rex sends the
      // key only if that's still what's in front, in the same step.
      const named = KEYS[key.toLowerCase()];
      if (!named) return no(`I don't know the key ${key}`);
      const now = await front(handle);
      if ("why" in now) {
        log("rex_refused", { block: handle, why: now.why, key });
        return no(now.why);
      }
      log("terminal_key", { via: "rex", id: handle, key, starting: true });
      const sent = await send(handle, { key: named }, now.block.pid!);
      return sent.status === "sent" ? { sent: true } : notSent(sent, handle, "its pane changed just as I pressed it, so nothing went in");
    },
    async open(cwd: string, command: Command, opened?: (handle: string) => void) {
      // In the user's login shell, interactive so their rc files set it up as a new window would
      // (claude on PATH), and left in that shell when the command ends, as Ghostty's window is.
      // Quoted for a POSIX shell (the name and prompt are the model's words): a shell that reads
      // quotes otherwise (fish, nu…) never gets the line; it gets the shell after.
      const line = [command.program, ...command.args.map(shellWord)].join(" ");
      const runner = POSIX_SHELLS.has(basename(d.shell)) ? d.shell : "/bin/zsh";
      const argv = [runner, "-l", "-i", "-c", `${line}; exec ${shellWord(d.shell)} -l`];
      // A new tab of the session Kiko was started from, else of the first one: Rex shows a new tab
      // where you're looking. With none, a new session, which Rex lists but doesn't show by itself.
      const session = tabSession(await d.sessions(), d.own());
      const block = await d.run(session, cwd, argv);
      opened?.(block);
      log("terminal_open", { via: "rex", cwd, command: line, session, block });
      if (!session) return "it's in a new Rex session: pick it in Rex's sidebar";
    },
  };
}

/** The real one: Rex's local server, through `rex`. */
export const rex: Terminal = rexTerminal({
  list: () => script(LIST).then(parseList),
  inspect: (block) => script(INSPECT, { block }).then(parseInspect),
  send: (block, what, pid) => script(SEND, { block, pid, ...what }).then(parseSent),
  screen: (block) => script(SCREEN, { block }).then(parseScreen),
  sessions: () => script(SESSIONS).then(parseSessions),
  own: () => ownSession(),
  run: runBlock,
  installed: () => rexPath() !== null,
  running: () => rexRunning(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  shell: process.env.SHELL?.startsWith("/") ? process.env.SHELL : "/bin/zsh",
});
