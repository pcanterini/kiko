// What iTerm2 (../iterm/) and Terminal.app (../terminal-app/) share: both say, over AppleScript,
// each session's (or tab's) terminal device, its tty. A session's process says its own (`ps -o tty=`),
// so a session is matched to its tab tty to tty: exactly, never by a title. A session whose process
// isn't known (Codex's: its hooks run in its daemon) is found by its program in front on a tab's tty
// (`ps -t`: the foreground group's leader, by its executable's name) and that process's folder
// (`lsof -a -d cwd`), as tmux's byProgram and Rex's adapter do. Nothing is guessed from a title or
// a folder alone: a tab where several could be is "ambiguous", none "none".
//
// Before every word and key, the session's process is looked at again (`ps`): still running, on
// that tab's tty, in front there (its group the terminal's, not stopped). The send's own script
// then finds the tab by its tty again (iTerm: the session by its id, its tty still the same, its
// title not an agent's list of sessions) and only then writes. Never anything that brings the app
// forward or changes its selected tab: typing, keys, finding and reading a screen work while you're
// in another app (only `open`, a new window for a new session, brings it to the front).
//
// Listed only while a session may be there (ttyNeeded): one whose hook said this app, or one whose
// terminal isn't known, while the app is running (`pgrep -xq`, no Apple Events: telling an app that
// isn't running would start it). Every script also checks it's running before it tells it anything.
// Someone who never uses iTerm or Terminal is never asked whether Kiko may control them.
import { basename } from "node:path";
import { log } from "../../core/log.ts";
import { shellWord } from "../../core/shell.ts";
import { asPaste } from "../paste.ts";
import { literal, SHELLS } from "../tmux/index.ts";
import type { Command, Findable, Found, Mapping, Place, Terminal, Typed } from "../types.ts";
import { listViewOf } from "../views.ts";

/** A terminal device as the apps say it: "/dev/ttys003". */
export const TTY = /^\/dev\/ttys\d{1,4}$/;

/**
 * A session of iTerm (a tab of Terminal), as a listing gives it: its handle (iTerm: the session's
 * id; Terminal: its tty, which is how a tab is found again), its tty, and its title where the app
 * says one (iTerm), else "".
 */
export type Tab = { id: string; tty: string; title: string };

/** One process, as `ps` lists it: its group, its terminal's foreground group, its state, its tty ("/dev/ttys003"; "" for none), its executable. */
export type Proc = { pid: number; pgid: number; tpgid: number; stat: string; tty: string; comm: string };

/** What a guarded send did: went in; the tab changed since it was checked (another tty, an agents list's title); it's gone; or the app refused. */
export type Sent = { status: "sent" } | { status: "changed"; why?: string } | { status: "gone" } | { status: "failed"; error: string };

/** What an adapter on this needs from the world: real for the app (../iterm/, ../terminal-app/), fake for the unit tests. */
export type TtyDeps = {
  /** Every session (tab) of the app, with its tty: one AppleScript. */
  list(): Promise<Tab[]>;
  /** One, by its handle (`Tab.id`); null when it's gone. */
  look(id: string): Promise<Tab | null>;
  /** `data` into `tab` exactly as given (Terminal's `do script` adds its Return), only if it's still that tab on that tty. */
  send(tab: Tab, data: string): Promise<Sent>;
  /** What a tab shows now; null when it's gone. */
  screen?(id: string): Promise<string | null>;
  /** A new window in `cwd` running `line` (a shell command line, quoted) in the user's shell: its handle. */
  open(cwd: string, line: string): Promise<string>;
  /** Each of `pids`' tty (`ps -o pid=,tty=`): those still running. */
  ttysOf(pids: readonly number[]): Promise<Map<number, string>>;
  /** One process looked at (`ps -o pid=,pgid=,tpgid=,stat=,tty=,comm=`); null when it has ended. */
  proc(pid: number): Promise<Proc | null>;
  /** The processes on these ttys (`ps -t`). */
  onTtys(ttys: readonly string[]): Promise<Proc[]>;
  /** Each of `pids`' folder (`lsof -a -d cwd`). */
  cwds(pids: readonly number[]): Promise<Map<number, string>>;
  installed(): boolean;
  /** The app's process is there (`pgrep -xq`: no Apple Events). */
  running(): Promise<boolean>;
  wait(ms: number): Promise<void>;
};

/** What tells the two apps apart, beyond their scripts. */
export type TtyApp = {
  /** The adapter's id, and the app's in core/terminal-apps.ts ("iterm", "terminal"): what a session's hook says. */
  id: string;
  /** Its name, in what's said ("its iTerm tab has closed"). */
  name: string;
  /**
   * How words go in. "then-enter": as given, then Enter on its own after a moment (iTerm's `write
   * text … newline false`). "with-return": in one go with the app's own Return after them
   * (Terminal's `do script`, which can't leave it out): always as one bracketed paste, so the program
   * takes the Return after it as Enter, not as a line of what's pasted.
   */
  words: "then-enter" | "with-return";
  /** Keys can be sent (iTerm: their bytes, with `write text`). Terminal has no way to without a Return after them. */
  keys: boolean;
};

const no = (why: string): Typed => ({ sent: false, why });

/** The sessions the app could have a tab for: interactive, in a terminal (not the desktop app's), not T3 Code's threads; there by its hook, or not known. */
const mayBeHere = (app: TtyApp, s: Findable) => s.kind === "interactive" && !s.desktop && s.agent !== "t3code" && (s.terminal === app.id || s.terminal === undefined);
/** And with something to find its tab by: its process, or its program. */
const findable = (app: TtyApp, s: Findable) => mayBeHere(app, s) && (Number.isInteger(s.pid) || !!s.program);

/**
 * Whether the app is to be listed for these sessions: one may be there (its hook said this app, or
 * its terminal isn't known) with something to find it by, the app is installed, and it's running.
 * Sessions known to be elsewhere (Ghostty, Rex, Kiko's tmux) never are.
 */
export async function ttyNeeded(app: TtyApp, sessions: readonly Findable[], d: Pick<TtyDeps, "installed" | "running">): Promise<boolean> {
  return sessions.some((s) => findable(app, s)) && d.installed() && (await d.running());
}

/** What's in front on a tty: the foreground group's leader there, not stopped. */
export function frontOn(tty: string, procs: readonly Proc[]): Proc | null {
  return procs.find((p) => p.tty === tty && p.pid === p.pgid && p.pgid === p.tpgid && !p.stat.includes("T")) ?? null;
}

/** A process's program, as a session's `program` names it (a login shell's may come as "-zsh"). */
export const programOf = (p: Pick<Proc, "comm">) => basename(p.comm.replace(/^-/, ""));

/** What's in front on a tab's tty, with that process's folder where it was looked at. */
export type Front = { pid: number; program: string; cwd?: string };

/** A title without what iTerm may add after it (" (claude)", its job's name). */
const bareTitle = (title: string) => title.replace(/\s+\([^()]*\)\s*$/, "");
const showsList = (title: string) => listViewOf(title) ?? listViewOf(bareTitle(title));

/**
 * Where each session is among `tabs`: by its process's tty (`ttys`: pid → tty), the one tab on it;
 * else, its process unknown, by its program in front (`fronts`: tab id → what's in front there):
 * the tab it was opened or last found in (Findable.pane) while its program is in front there, else
 * the only tab in its folder running it when it's the only such session there ("only"). Two
 * sessions on one tty (one started inside the other): "ambiguous", keys would reach either. A tab
 * titled as an agent's list of sessions: "agents" (../views.ts).
 */
export function matchTabs(app: TtyApp, sessions: readonly Findable[], tabs: readonly Tab[], ttys: ReadonlyMap<number, string>, fronts: ReadonlyMap<string, Front> = new Map()): Map<string, Found> {
  const found = new Map<string, Found>();
  const place = (s: Findable, tab: Tab, pid: number): Place => ({ via: app.id, id: tab.id, keys: app.keys, pid, tty: tab.tty, ...(s.bracketed ? { bracketed: true } : {}) });
  const set = (s: Findable, f: Found) => found.set(s.sessionId, f);
  const nowhere = (mapping: Mapping): Found => ({ place: null, mapping });

  const hits: Array<{ s: Findable; tab: Tab }> = [];
  for (const s of sessions) {
    if (!findable(app, s) || !Number.isInteger(s.pid)) continue;
    const tty = ttys.get(s.pid!);
    if (!tty || !TTY.test(tty)) continue;
    const on = tabs.filter((t) => t.tty === tty);
    if (on.length === 1) hits.push({ s, tab: on[0] });
    else if (on.length > 1) set(s, nowhere("ambiguous"));
  }
  for (const { s, tab } of hits) {
    const shared = hits.filter((h) => h.tab.tty === tab.tty).length > 1;
    set(s, shared ? nowhere("ambiguous") : { place: place(s, tab, s.pid!), mapping: "process" });
  }

  // Its process unknown, its TUI's name known (Codex: its hooks run in its daemon).
  const taken = new Set(hits.map((h) => h.tab.tty));
  const unknown = sessions.filter((s) => findable(app, s) && !Number.isInteger(s.pid) && s.program);
  const runs = (tab: Tab, program: string) => !taken.has(tab.tty) && fronts.get(tab.id)?.program === program;
  const rest: Findable[] = [];
  for (const s of unknown) {
    const hint = s.pane ? tabs.find((t) => t.id === s.pane) : undefined;
    if (hint && runs(hint, s.program!)) {
      taken.add(hint.tty);
      set(s, { place: place(s, hint, fronts.get(hint.id)!.pid), mapping: "process" });
    } else rest.push(s);
  }
  for (const s of rest) {
    const there = tabs.filter((t) => runs(t, s.program!) && fronts.get(t.id)?.cwd === s.cwd);
    const alike = rest.filter((o) => o.cwd === s.cwd && o.program === s.program);
    if (there.length === 1 && alike.length === 1) {
      taken.add(there[0].tty);
      set(s, { place: place(s, there[0], fronts.get(there[0].id)!.pid), mapping: "only" });
    } else if (there.length) set(s, nowhere("ambiguous"));
  }

  // Found, but its tab shows an agent's list of sessions (parked with ←: its process stays): nothing typed there would reach it.
  for (const [id, f] of found) {
    if (f.place && showsList(tabs.find((t) => t.id === f.place!.id)?.title ?? "")) found.set(id, nowhere("agents"));
  }
  return found;
}

/**
 * Why `pid` can't be typed into on `tty` right now, or null when it can: it runs (`proc`, looked at
 * just now), on that tty, not stopped, and in front there (its group is the terminal's), so what's
 * written to the tab reaches it and nothing else.
 */
export function notReady(app: TtyApp, pid: number | undefined, tty: string | undefined, proc: Proc | null): string | null {
  if (!pid) return "I don't know its process";
  if (!tty || !TTY.test(tty)) return `its ${app.name} tab isn't one I know`;
  if (!proc) return "its process has ended";
  if (proc.tty !== tty) return `it isn't running in that ${app.name} tab any more`;
  if (proc.stat.includes("T")) return "it's suspended in its tab";
  if (proc.pgid !== proc.tpgid) return "something else is in front of it in its tab";
  return null;
}

// The bytes a key sends, as a terminal sends them for it (arrows in normal cursor mode: Claude Code
// and Codex read either mode's).
const KEYS: Record<string, string> = {
  escape: "\u001b",
  enter: "\r",
  return: "\r",
  tab: "\t",
  "shift+tab": "\u001b[Z",
  up: "\u001b[A",
  down: "\u001b[B",
  right: "\u001b[C",
  left: "\u001b[D",
};

/** `words` as one bracketed paste: lines separated by Return, as a terminal pastes them. */
export const bracketed = (words: string) => `\u001b[200~${words.replace(/\n/g, "\r")}\u001b[201~`;

// Between the words and Enter: Claude Code takes keys that come all at once as a paste, where
// Enter is a new line rather than send (and Codex an Enter within 120ms of them).
const ENTER_AFTER_MS = 150;

const failedSend = (err: unknown): Sent => ({ status: "failed", error: err instanceof Error ? err.message : String(err) });

/** An adapter for `app` on `d`: iTerm's and Terminal's (../iterm/, ../terminal-app/), or a fake. */
export function ttyTerminal(app: TtyApp, d: TtyDeps): Terminal {
  const event = (what: string) => `${app.id}_${what}`;
  // Whether the last look needed the app: then the next one lists its tabs as the sessions are being
  // listed, not after them (the listing's own script checks it's still running first).
  let wasNeeded = false;

  /** A send that didn't go in, said as `type` and `key` say it. */
  function notSent(sent: Exclude<Sent, { status: "sent" }>, tab: Tab, changed: string, after = ""): Typed {
    if (sent.status === "gone") return no(`its ${app.name} tab has closed${after}`);
    if (sent.status === "changed") return no(sent.why ? `${sent.why}${after}` : changed);
    log(event("failed"), { id: tab.id, error: sent.error });
    return { sent: false, why: `${app.name} didn't take it${after}`, error: sent.error };
  }

  /** Why the place's process can't be typed into now (looked at again), or null. */
  async function check(place: Place): Promise<string | null> {
    if (!place.pid) return "I don't know its process";
    if (!place.tty || !TTY.test(place.tty)) return `its ${app.name} tab isn't one I know`;
    let proc: Proc | null;
    try {
      proc = await d.proc(place.pid);
    } catch (err) {
      log(event("failed"), { id: place.id, error: err instanceof Error ? err.message : String(err) });
      return "I couldn't look at its process";
    }
    return notReady(app, place.pid, place.tty, proc);
  }

  const send = (tab: Tab, data: string) => d.send(tab, data).catch(failedSend);
  const tabOf = (place: Place): Tab => ({ id: place.id, tty: place.tty!, title: "" });

  /** What's in front in a tab it opened: its program (not a shell), with its process; else why not. */
  async function front(handle: string): Promise<{ tab: Tab; proc: Proc } | { why: string; gone?: boolean }> {
    let tab: Tab | null;
    try {
      tab = await d.look(handle);
    } catch (err) {
      log(event("failed"), { id: handle, error: err instanceof Error ? err.message : String(err) });
      return { why: `${app.name} didn't answer` };
    }
    if (!tab || !TTY.test(tab.tty)) return { why: `its ${app.name} tab has closed`, gone: true };
    const proc = frontOn(tab.tty, await d.onTtys([tab.tty]).catch(() => []));
    if (!proc || SHELLS.has(programOf(proc))) return { why: "its program has ended" };
    return { tab, proc };
  }

  /** What's in front on each tab, for the sessions found by program: only for programs they name, with their folders. */
  async function frontsOf(tabs: readonly Tab[], programs: ReadonlySet<string>): Promise<Map<string, Front>> {
    const fronts = new Map<string, Front>();
    const ttys = tabs.map((t) => t.tty).filter((t) => TTY.test(t));
    if (!ttys.length) return fronts;
    const procs = await d.onTtys(ttys);
    const wanted: Array<{ tab: Tab; proc: Proc }> = [];
    for (const tab of tabs) {
      const proc = frontOn(tab.tty, procs);
      if (proc && programs.has(programOf(proc))) wanted.push({ tab, proc });
    }
    const cwds = wanted.length ? await d.cwds(wanted.map((w) => w.proc.pid)).catch(() => new Map<number, string>()) : new Map<number, string>();
    for (const { tab, proc } of wanted) fronts.set(tab.id, { pid: proc.pid, program: programOf(proc), cwd: cwds.get(proc.pid) });
    return fronts;
  }

  const self: Terminal = {
    id: app.id,
    label: null,
    ready: () => d.installed(),
    async find(sessions) {
      const early = wasNeeded ? d.list().catch(() => null) : null;
      const listed = await sessions;
      wasNeeded = await ttyNeeded(app, listed, d).catch(() => false);
      if (!wasNeeded) return new Map<string, Found>();
      const mine = listed.filter((s) => findable(app, s));
      const pids = mine.filter((s) => Number.isInteger(s.pid)).map((s) => s.pid!);
      const programs = new Set(mine.filter((s) => !Number.isInteger(s.pid) && s.program).map((s) => s.program!));
      // The sessions' ttys looked at while the app lists its tabs, not after.
      const ttysP = pids.length ? d.ttysOf(pids).catch(() => new Map<number, string>()) : Promise.resolve(new Map<number, string>());
      const tabs = await (early ?? d.list().catch(() => null));
      if (!tabs?.length) return new Map<string, Found>();
      const [ttys, fronts] = await Promise.all([ttysP, programs.size ? frontsOf(tabs, programs).catch(() => new Map<string, Front>()) : new Map<string, Front>()]);
      return matchTabs(app, listed, tabs, ttys, fronts);
    },
    async type(place, text) {
      const before = await check(place);
      if (before) {
        log(event("refused"), { id: place.id, pid: place.pid ?? null, why: before });
        return no(before);
      }
      const tab = tabOf(place);
      const words = literal(text);
      const lines = words.split("\n").length;
      if (app.words === "with-return") {
        // One send: the words as one bracketed paste, and the app's own Return after them, which sends them.
        log("terminal_type", { via: app.id, id: place.id, text: words, lines });
        const sent = await send(tab, words ? bracketed(words) : "");
        return sent.status === "sent" ? { sent: true } : notSent(sent, tab, "its tab changed just as I typed, so nothing went in");
      }
      // Line breaks only in a bracketed paste: without one, each would send what came before it.
      // One line as a bracketed paste too when it's long, or for a program that wants it
      // (Place.bracketed: Codex): ../paste.ts (typed, long words reach it in pieces, and Claude Code
      // kept only the last). The app can't say whether the program asks for one: these are agents' TUIs, which do.
      const paste = asPaste(words, { asks: true, always: place.bracketed === true });
      log("terminal_type", { via: app.id, id: place.id, text: words, lines, ...(paste && lines === 1 ? { bracketed: true } : {}) });
      if (words) {
        const sent = await send(tab, paste ? bracketed(words) : words);
        if (sent.status !== "sent") {
          log(event("refused"), { id: place.id, pid: place.pid ?? null, status: sent.status });
          return notSent(sent, tab, "its tab changed just as I typed, so nothing went in");
        }
      }
      await d.wait(ENTER_AFTER_MS);
      const after = await check(place);
      if (after) {
        log(event("refused"), { id: place.id, pid: place.pid ?? null, why: after, typed: true });
        return no(`${after}, so I typed it but didn't send it`);
      }
      const entered = await send(tab, KEYS.enter);
      if (entered.status === "sent") return { sent: true };
      return notSent(entered, tab, "its tab changed just as I pressed Enter, so I typed it but didn't send it", ", so I typed it but didn't send it");
    },
    async program(handle) {
      const now = await front(handle);
      if ("tab" in now) return "running";
      return now.gone ? "gone" : "shell";
    },
    async placeIn(handle) {
      // A tab it opened: what's in front there, as the place `type` then checks again, as for any session's.
      const now = await front(handle).catch(() => null);
      return now && "tab" in now ? { via: app.id, id: now.tab.id, keys: app.keys, pid: now.proc.pid, tty: now.tab.tty } : null;
    },
    async open(cwd: string, command: Command, opened?: (handle: string) => void) {
      // Typed into the user's shell in a new window, as if by hand (as Ghostty's window is), left in
      // that shell when it ends. Quoted for a POSIX shell (the name and prompt are the model's words).
      const line = [command.program, ...command.args.map(shellWord)].join(" ");
      const handle = await d.open(cwd, `cd ${shellWord(cwd)} && ${line}`);
      opened?.(handle);
      log("terminal_open", { via: app.id, cwd, command: line, handle });
    },
  };
  if (d.screen) {
    const screen = d.screen;
    self.screen = (handle) => screen(handle).catch(() => null);
  }
  if (app.keys) {
    const press = async (tab: Tab, key: string, why: string | null, extra: Record<string, unknown>): Promise<Typed> => {
      if (why) {
        log(event("refused"), { id: tab.id, why, key, ...extra });
        return no(why);
      }
      log("terminal_key", { via: app.id, id: tab.id, key, ...extra });
      const sent = await send(tab, KEYS[key.toLowerCase()]);
      return sent.status === "sent" ? { sent: true } : notSent(sent, tab, "its tab changed just as I pressed it, so nothing went in");
    };
    self.key = async (place, key) => {
      if (!KEYS[key.toLowerCase()]) return no(`I don't know the key ${key}`);
      return press(tabOf(place), key, await check(place), { pid: place.pid ?? null });
    };
    // A tab it opened whose program hasn't started its session yet: no session process to check (as
    // `key` does), so what's in front there: its program, not the shell.
    self.press = async (handle, key) => {
      if (!KEYS[key.toLowerCase()]) return no(`I don't know the key ${key}`);
      const now = await front(handle);
      if (!("tab" in now)) return press({ id: handle, tty: "", title: "" }, key, now.why, { starting: true });
      return press(now.tab, key, null, { starting: true });
    };
  }
  return self;
}
