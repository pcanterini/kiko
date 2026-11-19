// tmux: Kiko's own server (`tmux -L kiko`, ./tmux.ts), the first place a session is looked
// for. Sessions get there by `kiko claude` (src/cli.ts) or by Kiko opening them (`open`: a new
// tmux session, shown in the Kiko window when it's there, ./window.ts, else in a new Ghostty
// window, ./show.ts). Only that server is ever touched: the
// user's own tmux servers are neither read nor typed into.
//
// The one rule: typed words must never land anywhere but the session they're for. So a session is
// matched to its pane by its process, never by a title: the pane whose first process is the
// session's process or one of its ancestors. And before every word and key, all of it is checked
// again: the pane is still there with the same first process, the session's process is still in
// it, on its terminal, and in the foreground (not suspended with Ctrl+Z, a shell not in front of
// it), and the pane's title isn't an agent's own list of sessions (Claude Code's agents list, where
// ← parks a session and its process stays: ../views.ts). A pane scrolled back (tmux's copy mode, where keys would be taken as tmux's commands) is
// brought back to the bottom first, as typing in it would. Anything else off: not sent, and why.
// Text goes in through a tmux buffer (over stdin: never on a command line), pasted only if tmux
// finds the pane as it was checked, in the same step; several lines as one bracketed paste. Enter
// on its own after a moment, checked again first.
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { log } from "../../core/log.ts";
import { NAME, SLUG } from "../../core/name.ts";
import { shellWord } from "../../core/shell.ts";
import type { Command, Findable, Found, Place, Terminal, Typed } from "../types.ts";
import { listViewOf, notListViewFormat } from "../views.ts";
import { parseKey } from "./keys.ts";
import { showSession } from "./show.ts";
import { BACK_TMUX, freeName, LEAVE_TMUX, NO_ANSWER, noServer, processes, sessionNameFor, tmuxArg, tmuxFormatArg, tmuxPath, tmuxRunner, WINDOW, type Proc } from "./tmux.ts";
import { describe, HOME, ROLE, setLabel, show } from "./window.ts";

/** What the adapter needs of tmux and the computer: real for the app, fake for the unit tests. */
export type Runner = {
  /** tmux on Kiko's server: its output; rejects with what it said. `input` goes to its stdin. */
  tmux(args: string[], input?: string): Promise<string>;
  /** Every process (`ps`). */
  ps(): Promise<Proc[]>;
  /** A new window of the user's terminal app attached to one of the server's sessions. */
  show(cwd: string, session: string): Promise<void>;
  wait(ms: number): Promise<void>;
  /** tmux is installed. */
  installed(): boolean;
  /** The user's login shell, which a session Kiko opens runs its command in. */
  shell: string;
};

/**
 * A pane, as `list-panes -F FORMAT` gives it. `paste`: what runs in it asked for bracketed paste
 * (Claude Code does), so a paste with line breaks goes in as one. `role`: one of the Kiko
 * window's own (its list, a placeholder: window.ts ROLE), never a session's. `command`: the name of
 * what's in front in it (tmux's pane_current_command: its foreground process group's leader; for
 * Claude Code "claude", "node", or the native install's version number, "2.1.312"). `title`: what
 * the program in it titled it (an escape sequence; tmux keeps no control characters in it, so no
 * tab), "" or left out when it has none.
 */
export type Pane = { id: string; pid: number; tty: string; inMode: boolean; dead: boolean; paste: boolean; role: string; session: string; command: string; title?: string; cwd: string };

export const FORMAT = [
  "#{pane_id}",
  "#{pane_pid}",
  "#{pane_tty}",
  "#{pane_in_mode}",
  "#{pane_dead}",
  "#{bracket_paste_flag}",
  `#{${ROLE}}`,
  "#{session_name}",
  "#{pane_current_command}",
  "#{pane_title}",
  "#{pane_current_path}",
].join("\t");

/** `list-panes -a -F FORMAT` read back. */
export function parsePanes(out: string): Pane[] {
  return out
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((f) => f.length >= 11 && /^%\d+$/.test(f[0]) && /^\d+$/.test(f[1]))
    .map(([id, pid, tty, inMode, dead, paste, role, session, command, title, ...cwd]) => ({
      id,
      pid: Number(pid),
      tty,
      inMode: Number(inMode) > 0,
      dead: dead === "1",
      paste: paste === "1",
      role,
      session,
      command,
      title,
      cwd: cwd.join("\t"),
    }));
}

/**
 * The pane `pid` runs in: the live one whose first process is it or one of its ancestors (a shell
 * that started it, `sh -c` around it). Null when it runs in none of them.
 */
export function paneOf(pid: number, panes: readonly Pane[], procs: readonly Proc[]): Pane | null {
  const parent = new Map(procs.map((p) => [p.pid, p.ppid]));
  const byPid = new Map(panes.filter((p) => !p.dead).map((p) => [p.pid, p]));
  const seen = new Set<number>();
  for (let at = pid; at > 1 && !seen.has(at); at = parent.get(at) ?? 0) {
    const pane = byPid.get(at);
    if (pane) return pane;
    seen.add(at);
  }
  return null;
}

/**
 * Why `pid` can't be typed into in `pane` right now, or null when it can: it's alive, runs in that
 * pane, on that pane's terminal, and in the foreground there (its group is the terminal's, and
 * it isn't stopped), so keys sent to the pane reach it and nothing else.
 */
export function notReady(pid: number | undefined, pane: Pane, procs: readonly Proc[]): string | null {
  if (!pid) return "I don't know its process";
  const proc = procs.find((p) => p.pid === pid);
  if (!proc) return "its process has ended";
  if (paneOf(pid, [pane], procs)?.id !== pane.id) return "it isn't running in that tmux pane any more";
  if (proc.tty === "??" || `/dev/${proc.tty}` !== pane.tty) return "it isn't on that pane's terminal";
  if (proc.stat.includes("T")) return "it's suspended in its pane";
  if (proc.pgid !== proc.tpgid) return "something else is in front of it in its pane";
  const view = listViewOf(pane.title ?? "");
  if (view) return `its pane is showing ${view}`;
  return null;
}

/**
 * Where sessions whose process isn't known are (`unknown`: each with its TUI's name, Findable.program),
 * among `free` panes (no listed session found in them by its process): the pane it was last in or
 * opened in (Findable.pane) while its program is still in front there, else the only pane in its
 * folder running its program when it's the only such session there ("only"). The place's pid is
 * what's in front of the pane (its TUI), which `type` checks again as it would a session's own.
 */
export function byProgram(unknown: readonly Findable[], free: readonly Pane[], procs: readonly Proc[]): Map<string, Found> {
  const found = new Map<string, Found>();
  const runs = (p: Pane, program: string) => basename(p.command.replace(/^-/, "")) === program;
  const front = (p: Pane) => procs.find((q) => `/dev/${q.tty}` === p.tty && q.pid === q.pgid && q.pgid === q.tpgid && paneOf(q.pid, [p], procs)?.id === p.id);
  const taken = new Set<string>();
  const place = (s: Findable, p: Pane, mapping: "process" | "only") => {
    const pid = front(p)?.pid;
    if (!pid) return false;
    taken.add(p.id);
    found.set(s.sessionId, { place: { via: "tmux", id: p.id, keys: true, pid, ...(s.bracketed ? { bracketed: true } : {}) }, mapping });
    return true;
  };
  const rest: Findable[] = [];
  for (const s of unknown) {
    const hinted = s.pane ? free.find((p) => p.id === s.pane && runs(p, s.program!)) : undefined;
    if (!hinted || !place(s, hinted, "process")) rest.push(s);
  }
  for (const s of rest) {
    const panes = free.filter((p) => !taken.has(p.id) && p.cwd === s.cwd && runs(p, s.program!));
    const alike = rest.filter((o) => o.cwd === s.cwd && o.program === s.program);
    if (panes.length === 1 && alike.length === 1) place(s, panes[0], "only");
    else if (panes.length) found.set(s.sessionId, { place: null, mapping: "ambiguous" });
  }
  return found;
}

/** `text` as itself inside a tmux format (a comparison's side): "#", "," and "}" escaped. */
export const formatText = (text: string) => text.replace(/[#,}]/g, "#$&");

/**
 * What tmux checks as it pastes into `pane`: its first process is still the one checked, and the
 * same program is in front (a voice-opened session's pane never in the window runs `claude; exec $SHELL`: the first
 * process stays the same after Claude Code quits, but the shell is then in front), and its title
 * isn't an agent's list of sessions (a session parked with ← just then: its process stays in front,
 * ../views.ts); for several lines, it still asks for bracketed paste.
 */
export function pasteCheck(pane: Pane, bracketed: boolean) {
  const same = `#{&&:#{&&:#{==:#{pane_pid},${pane.pid}},#{==:#{pane_current_command},${formatText(pane.command)}}},${notListViewFormat()}}`;
  return bracketed ? `#{&&:#{bracket_paste_flag},${same}}` : same;
}

/** Text as it's typed: no control characters but line breaks (one kind), tabs as spaces. */
export function literal(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
}

// tmux's names for the keys an agent asks for (Ghostty's names: agent.interruptKey is "escape").
// Shift+Tab is tmux's BTab: Claude Code's key for its next permission mode (core/block-override.ts
// presses it, reading the mode back off the screen after each press). Sent through `key`, so with
// every check a typed word gets.
const KEYS: Record<string, string> = {
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  "shift+tab": "BTab",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
};

/** tmux's name for `key`: one of KEYS, or a key the Kiko key can be (passed on to a session when pressed twice: keys.ts). */
function keyName(key: string): string | undefined {
  const named = KEYS[key.toLowerCase()];
  if (named) return named;
  const parsed = parseKey(key);
  return "key" in parsed ? parsed.key : undefined;
}

// Between the words and Enter: Claude Code takes keys that come all at once as a paste, where
// Enter is a new line rather than send.
const ENTER_AFTER_MS = 150;

const no = (why: string): Typed => ({ sent: false, why });

/** Login shells that read a command line as POSIX sh does (shellWord's quoting). */
export const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "ksh", "dash"]);
/** Shells, as tmux names what's in front of a pane: one there means the command it ran has ended (or not started). */
export const SHELLS = new Set([...POSIX_SHELLS, "fish", "nu", "tcsh", "csh", "elvish", "xonsh"]);

/**
 * What a session's shell does once the program it opened has returned, right after it (TMUX back
 * first: BACK_TMUX). Ended (it quit: /exit, Ctrl+D, a crash; any agent), a pane that has been in
 * the Kiko window (its HOME set, as `show` does) ends with it, as Close leaves it: in the stage,
 * tmux's DIED_HOOK puts the placeholder back and closes it (Kiko's page comes in at the app's
 * next look: src/ui/window-glue.ts); at home, its tmux session ends quietly and the stage stays as it
 * was. Any other pane (shown in a window of its own, no Kiko window then) is left in the login
 * shell, as Ghostty's window is; so is one whose program was only stopped (Ctrl+Z: its status is
 * 128 + TSTP, STOP, TTIN or TTOU, as `kill -l` names it), whose process was still there: as before
 * this, the login shell (bash's exec then ends a stopped job itself; zsh leaves it stopped). tmux is
 * asked about the pane right then, on its own server (`-S`, from TMUX) and its own pane
 * (TMUX_PANE), before the shell is anyone's: nothing typed or started there is ever ended. tmux not
 * answering: the shell, as before. Without this, /exit typed in a session opened from the window
 * left a bare shell in the stage after the session had left the list.
 */
export const afterProgram = (shell: string, tmux: string) =>
  `program_status=$?; ${BACK_TMUX}; ` +
  `case "$(kill -l "$program_status" 2>/dev/null)" in TSTP|STOP|TTIN|TTOU) exec ${shellWord(shell)} -l;; esac; ` +
  `[ -n "$(${shellWord(tmux)} -S "\${TMUX%%,*}" display -p -t "$TMUX_PANE" '#{${HOME}}' 2>/dev/null)" ] || exec ${shellWord(shell)} -l`;

/** tmux refused a send, or didn't answer (its message logged and kept as `error`). */
function failed(place: Place, err: unknown): Typed {
  const error = err instanceof Error ? err.message : String(err);
  log("tmux_failed", { pane: place.id, error });
  return error === NO_ANSWER ? { sent: false, why: NO_ANSWER } : { sent: false, why: "tmux didn't take it", error };
}

/** The tmux adapter, on `r` (the real one, `tmux` below, or a fake). */
export function tmuxTerminal(r: Runner): Terminal {
  async function panes(): Promise<Pane[]> {
    try {
      return parsePanes(await r.tmux(["list-panes", "-a", "-F", FORMAT]));
    } catch (err) {
      if (noServer(err)) return [];
      throw err;
    }
  }

  /** The place's pane when everything about it checks out (see the top); else why not. */
  async function check(place: Place): Promise<{ pane: Pane } | { why: string }> {
    let all: Pane[];
    let procs: Proc[];
    try {
      [all, procs] = await Promise.all([panes(), r.ps()]);
    } catch (err) {
      log("tmux_failed", { pane: place.id, error: err instanceof Error ? err.message : String(err) });
      return { why: "tmux didn't answer" };
    }
    const pane = all.find((p) => p.id === place.id);
    if (!pane || pane.dead) return { why: "its tmux pane has closed" };
    if (pane.role) return { why: `that's ${NAME}'s own pane, not a session's` };
    const why = notReady(place.pid, pane, procs);
    return why ? { why } : { pane };
  }

  /** Checked (see `check`), and out of copy mode or any other tmux mode: brought back to the bottom, as typing in it would. */
  async function ready(place: Place): Promise<{ pane: Pane } | { why: string }> {
    const first = await check(place);
    if (!("pane" in first) || !first.pane.inMode) return first;
    await r.tmux(["copy-mode", "-q", "-t", place.id]).catch(() => "");
    log("tmux_left_mode", { pane: place.id });
    const again = await check(place);
    if ("pane" in again && again.pane.inMode) return { why: "its pane is scrolled back and wouldn't come out of it" };
    return again;
  }

  /**
   * `words` into `pane`, checked and pasted in one step by tmux: through a buffer of its own (over
   * stdin, never on a command line), pasted only if the pane's first process and the program in
   * front are still the ones checked and, for several lines, it still asks for bracketed paste
   * (else a shell come to the front meanwhile would run each line): pasteCheck. The buffer still
   * there afterwards: nothing went in. True when pasted, else why not; throws when tmux refused.
   */
  async function paste(pane: Pane, words: string, bracketed: boolean): Promise<true | string> {
    if (!/^%\d+$/.test(pane.id) || !Number.isInteger(pane.pid)) return "its tmux pane isn't one I know";
    const buffer = `${SLUG}-${randomUUID().slice(0, 8)}`;
    await r.tmux(["load-buffer", "-b", buffer, "-"], words);
    try {
      await r.tmux(["if-shell", "-F", "-t", pane.id, pasteCheck(pane, bracketed), `paste-buffer ${bracketed ? "-p " : ""}-d -b ${buffer} -t ${pane.id}`]);
    } catch (err) {
      await r.tmux(["delete-buffer", "-b", buffer]).catch(() => "");
      throw err;
    }
    // Pasted, the buffer went with it (-d); still there, the check failed: deleted now, unsent.
    return r.tmux(["delete-buffer", "-b", buffer]).then(
      () => "its pane changed just as I typed, so nothing went in",
      (err) => {
        if (/unknown buffer|no buffer/i.test(err instanceof Error ? err.message : String(err))) return true as const;
        throw err;
      },
    );
  }

  /** A new session's pane shown in the Kiko window, when it's there: false when it isn't (or it failed: then its own window). */
  async function intoWindow(pane: string, session: string, cwd: string): Promise<boolean> {
    try {
      const view = (await describe(r.tmux)).view;
      if (!view) return false;
      await setLabel(r.tmux, pane, session);
      const shown = await show(r.tmux, pane);
      log("terminal_window", { via: WINDOW, session, pane, shown, clients: view.clients });
      if (shown !== "shown" && shown !== "already") return false;
      if (!view.clients) await r.show(cwd, WINDOW);
      return true;
    } catch (err) {
      log("tmux_show_failed", { session, window: WINDOW, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  async function names(): Promise<string[]> {
    try {
      return (await r.tmux(["list-sessions", "-F", "#{session_name}"])).split("\n").filter(Boolean);
    } catch (err) {
      if (noServer(err)) return [];
      throw err;
    }
  }

  return {
    id: "tmux",
    label: null,
    ready: () => r.installed(),
    async find(sessions) {
      const found = new Map<string, Found>();
      if (!r.installed()) {
        await sessions;
        return found;
      }
      // Never Kiko's own panes (the window's list: a claude started from the app would have it
      // for an ancestor, and its words would be keys in the list).
      const [listed, all] = await Promise.all([
        sessions,
        panes().then(
          (p) => p.filter((x) => !x.role),
          () => [] as Pane[],
        ),
      ]);
      const wanted = listed.filter((s): s is Findable & { pid: number } => s.kind === "interactive" && !s.desktop && Number.isInteger(s.pid));
      // Its process unknown, its TUI's name known (Codex 0.166: its hooks run in its daemon).
      const unknown = listed.filter((s) => s.kind === "interactive" && !s.desktop && !Number.isInteger(s.pid) && s.program);
      if (!all.length || (!wanted.length && !unknown.length)) return found;
      const procs = await r.ps().catch(() => [] as Proc[]);
      const hits = wanted.map((s) => ({ s, pane: paneOf(s.pid, all, procs) })).filter((h) => h.pane);
      // Two sessions in one pane (one started inside the other): can't tell which keys would reach.
      const inPane = (id: string) => hits.filter((h) => h.pane!.id === id).length;
      for (const { s, pane } of hits) {
        found.set(
          s.sessionId,
          inPane(pane!.id) > 1
            ? { place: null, mapping: "ambiguous" }
            : { place: { via: "tmux", id: pane!.id, keys: true, pid: s.pid, ...(s.bracketed ? { bracketed: true } : {}) }, mapping: "process" },
        );
      }
      for (const [id, f] of byProgram(
        unknown,
        all.filter((p) => !p.dead && !hits.some((h) => h.pane!.id === p.id)),
        procs,
      ))
        found.set(id, f);
      // Found, but its pane shows an agent's list of sessions (parked with ←: its process stays in
      // the pane): nothing typed there would reach it, so "agents", said as such, until it's opened again.
      for (const [id, f] of found) {
        if (f.place && listViewOf(all.find((p) => p.id === f.place!.id)?.title ?? "")) found.set(id, { place: null, mapping: "agents" });
      }
      return found;
    },
    async type(place, text) {
      const before = await ready(place);
      if ("why" in before) {
        log("tmux_refused", { pane: place.id, pid: place.pid ?? null, why: before.why });
        return no(before.why);
      }
      // Line breaks only as a bracketed paste: without one, each would send what came before it.
      let words = literal(text);
      if (!before.pane.paste) words = words.replace(/\s*\n\s*/g, " ");
      const lines = words.split("\n").length;
      // One line as a bracketed paste too, for a program that wants it (Place.bracketed: Codex) and asks for them.
      const bracketed = lines > 1 || (place.bracketed === true && before.pane.paste);
      log("terminal_type", { via: "tmux", id: place.id, text: words, lines, ...(bracketed && lines === 1 ? { bracketed } : {}) });
      try {
        const pasted = words ? await paste(before.pane, words, bracketed) : true;
        if (pasted !== true) {
          log("tmux_refused", { pane: place.id, pid: place.pid ?? null, why: pasted });
          return no(pasted);
        }
      } catch (err) {
        return failed(place, err);
      }
      await r.wait(ENTER_AFTER_MS);
      const after = await ready(place);
      if ("why" in after) {
        log("tmux_refused", { pane: place.id, pid: place.pid ?? null, why: after.why, typed: true });
        return no(`${after.why}, so I typed it but didn't send it`);
      }
      return r.tmux(["send-keys", "-t", place.id, "Enter"]).then(
        () => ({ sent: true }) as const,
        (err) => failed(place, err),
      );
    },
    async key(place, key) {
      const name = keyName(key);
      if (!name) return no(`I don't know the key ${key}`);
      const before = await ready(place);
      if ("why" in before) {
        log("tmux_refused", { pane: place.id, pid: place.pid ?? null, why: before.why, key });
        return no(before.why);
      }
      log("terminal_key", { via: "tmux", id: place.id, key });
      return r.tmux(["send-keys", "-t", place.id, name]).then(
        () => ({ sent: true }) as const,
        (err) => failed(place, err),
      );
    },
    async program(handle) {
      const pane = (await panes()).find((p) => p.id === handle);
      if (!pane || pane.dead) return "gone";
      // pane_current_command: what's in front. A login shell may show as "-zsh".
      const front = basename(pane.command.replace(/^-/, ""));
      return SHELLS.has(front) || front === basename(r.shell) ? "shell" : "running";
    },
    async placeIn(handle) {
      // A pane it opened: its program in front (the leader of the terminal's foreground group, in
      // that pane), as the place `type` then checks again, as for any session's.
      if (!/^%\d+$/.test(handle)) return null;
      try {
        const [all, procs] = await Promise.all([panes(), r.ps()]);
        const pane = all.find((p) => p.id === handle && !p.dead && !p.role);
        if (!pane) return null;
        const front = procs.find((p) => `/dev/${p.tty}` === pane.tty && p.pid === p.pgid && p.pgid === p.tpgid && paneOf(p.pid, [pane], procs)?.id === pane.id);
        return front ? { via: "tmux", id: handle, keys: true, pid: front.pid } : null;
      } catch {
        return null;
      }
    },
    async agentPanes(is) {
      if (!r.installed()) return [];
      const all = await panes().catch(() => [] as Pane[]);
      return all.filter((p) => !p.dead && !p.role && is(basename(p.command.replace(/^-/, "")))).map((p) => ({ handle: p.id, cwd: p.cwd, command: p.command }));
    },
    async screen(handle) {
      if (!/^%\d+$/.test(handle)) return null;
      const pane = (await panes().catch(() => [] as Pane[])).find((p) => p.id === handle);
      if (!pane || pane.dead || pane.role) return null;
      return r.tmux(["capture-pane", "-p", "-t", handle]).catch(() => null);
    },
    async press(handle, key) {
      // A pane it opened whose program hasn't started its session yet: no session process to check
      // (as `key` does), so the pane itself: one of ours, not the window's, its program (not the
      // shell) in front; and tmux sends the key only if its first process and what's in front are
      // still those (pasteCheck), in the same step.
      const name = KEYS[key.toLowerCase()];
      if (!name) return no(`I don't know the key ${key}`);
      if (!/^%\d+$/.test(handle)) return no("its tmux pane isn't one I know");
      let pane: Pane | undefined;
      try {
        pane = (await panes()).find((p) => p.id === handle);
        if (pane?.inMode) {
          await r.tmux(["copy-mode", "-q", "-t", handle]).catch(() => "");
          pane = (await panes()).find((p) => p.id === handle);
        }
      } catch (err) {
        return failed({ via: "tmux", id: handle, keys: true }, err);
      }
      const front = pane && basename(pane.command.replace(/^-/, ""));
      const why =
        !pane || pane.dead
          ? "its tmux pane has closed"
          : pane.role
            ? `that's ${NAME}'s own pane, not a session's`
            : pane.inMode
              ? "its pane is scrolled back"
              : SHELLS.has(front!) || front === basename(r.shell)
                ? "its program has ended"
                : null;
      if (why) {
        log("tmux_refused", { pane: handle, why, key });
        return no(why);
      }
      log("terminal_key", { via: "tmux", id: handle, key, starting: true });
      return r.tmux(["if-shell", "-F", "-t", handle, pasteCheck(pane!, false), `send-keys -t ${handle} ${name}`]).then(
        () => ({ sent: true }) as const,
        (err) => failed({ via: "tmux", id: handle, keys: true }, err),
      );
    },
    async open(cwd: string, command: Command, opened?: (handle: string) => void) {
      // In the user's login shell, interactive so their rc files set it up as a new window would
      // (claude on PATH), and left in that shell when the command ends, as Ghostty's window is;
      // unless it has been in the Kiko window, where the pane ends with it (afterProgram).
      // The line is quoted for a POSIX shell (the name and prompt are the model's words): a shell
      // that reads quotes otherwise (fish, nu…) never gets it, zsh runs it and then becomes theirs.
      // The command runs without TMUX (LEAVE_TMUX, after the rc files, which may look at it):
      // nothing it runs reaches Kiko's server; the shell left after gets it back (BACK_TMUX).
      // Not in a subshell, nor `env -u` (claude may be an alias), nor as `TMUX= claude` (zsh
      // expands no alias after an assignment): the command stays a job of its own, leading its
      // process group, which the paste check reads (pane_current_command).
      const line = [command.program, ...command.args.map(shellWord)].join(" ");
      const runner = POSIX_SHELLS.has(basename(r.shell)) ? r.shell : "/bin/zsh";
      let session = "";
      let pane = "";
      for (let tries = 0; !session; tries++) {
        const name = freeName(sessionNameFor(cwd), await names());
        try {
          const run = [runner, "-l", "-i", "-c", `${LEAVE_TMUX}; ${line}; ${afterProgram(r.shell, tmuxPath() ?? "tmux")}`].map(tmuxArg);
          const out = await r.tmux(["new-session", "-d", "-s", name, "-c", tmuxFormatArg(cwd), "-P", "-F", "#{pane_id}", "--", ...run]);
          session = name;
          pane = /^%\d+$/.test(out.trim()) ? out.trim() : "";
          if (pane) opened?.(pane);
        } catch (err) {
          // Taken meanwhile (two opened at once): the next free name.
          if (tries >= 2 || !/duplicate session/i.test(err instanceof Error ? err.message : "")) throw err;
        }
      }
      log("terminal_open", { via: "tmux", cwd, command: line, session });
      // The Kiko window open: it's shown there, and a terminal shows the window if none does.
      if (pane && (await intoWindow(pane, session, cwd))) return;
      try {
        await r.show(cwd, session);
      } catch (err) {
        log("tmux_show_failed", { session, error: err instanceof Error ? err.message : String(err) });
        return `I couldn't show its window: it's running in ${NAME}'s tmux as ${session}`;
      }
    },
  };
}

/** The real one: Kiko's server, `ps`, and Ghostty (or Terminal.app) to show a session. */
export const tmux = tmuxTerminal({
  tmux: tmuxRunner(),
  ps: processes,
  show: (cwd, session) => showSession(cwd, session),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  installed: () => tmuxPath() !== null,
  shell: process.env.SHELL?.startsWith("/") ? process.env.SHELL : "/bin/zsh",
});
