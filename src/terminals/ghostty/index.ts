// Ghostty, over AppleScript (./ghostty.ts): needs no setup. It exposes no tty or pid (a terminal
// has only its id, title and working directory, Ghostty 1.3.1's dictionary), so a session is
// matched to its window by folder, then by title; typing pastes and presses Enter, and new
// sessions open in a new window.
//
// Ghostty is listed only when a session may run there (ghosttyNeeded): one whose hook said Ghostty,
// or one whose terminal isn't known yet (a session started before its hooks said it, or an agent's
// that doesn't) while Ghostty runs. Someone who never uses Ghostty is never asked whether Kiko may
// control it, and nothing asks Ghostty for its windows every few seconds for nothing.
import { shellQuote } from "../../core/shell.ts";
import { launchTerminal } from "../../core/terminal-apps.ts";
import type { Findable, Found, Terminal } from "../types.ts";
import { TITLE_MARKS } from "../tmux/tmux.ts";
import { isListView } from "../views.ts";
import { ghosttyInstalled, ghosttyRunning, listTerminals, openWindow, sendKey, typeText, type TerminalWindow } from "./ghostty.ts";

/** What the Ghostty adapter needs from the world: the tests' fakes replace them. */
export type GhosttyDeps = {
  list(): Promise<TerminalWindow[]>;
  type(id: string, text: string): Promise<void>;
  key(id: string, key: string): Promise<void>;
  open(cwd: string, command: string): Promise<void>;
  installed(): boolean;
  /** Ghostty's process is there (no Apple Events: ./ghostty.ts ghosttyRunning). */
  running(): Promise<boolean>;
  /** Kiko's own window was opened from Ghostty (the app's environment: core/terminal-apps.ts launchTerminal). */
  kikoInGhostty(): boolean;
};

/** The sessions Ghostty could have a window for: interactive, in a terminal (not the desktop app's), not T3 Code's threads. */
const inATerminal = (s: Findable) => s.kind === "interactive" && !s.desktop && s.agent !== "t3code";

/**
 * Whether Ghostty is to be listed for these sessions: installed, and a session in it as its hook
 * said, or one whose terminal isn't known (Findable.terminal) while Ghostty runs (Kiko's own window
 * in Ghostty says it does). Sessions known to be elsewhere (iTerm, Terminal, Kiko's tmux) never are.
 */
export async function ghosttyNeeded(sessions: readonly Findable[], d: Pick<GhosttyDeps, "installed" | "running" | "kikoInGhostty">): Promise<boolean> {
  const here = sessions.filter(inATerminal);
  if (!here.length || !d.installed()) return false;
  if (here.some((s) => s.terminal === "ghostty")) return true;
  if (!here.some((s) => s.terminal === undefined)) return false;
  return d.kikoInGhostty() || (await d.running());
}

export function ghosttyTerminal(d: GhosttyDeps): Terminal {
  // Whether the last look needed Ghostty: then the next one lists its windows as the sessions are
  // listed, not after (the listing's ~130 ms), as it always did.
  let wasNeeded = false;
  const self: Terminal = {
    id: "ghostty",
    label: null,
    async find(sessions) {
      const early = wasNeeded ? d.list().catch(() => [] as TerminalWindow[]) : null;
      const listed = await sessions;
      wasNeeded = await ghosttyNeeded(listed, d).catch(() => false);
      const found = new Map<string, Found>();
      if (!wasNeeded) return found;
      const windows = await (early ?? d.list().catch(() => [] as TerminalWindow[]));
      const interactive = listed.filter((s) => s.kind === "interactive");
      for (const session of listed) {
        // A desktop session has no terminal; a background one, nothing to type into; one known to
        // be in another terminal (or Kiko's tmux), no Ghostty window.
        if (session.kind !== "interactive" || session.desktop) continue;
        if (session.terminal !== undefined && session.terminal !== "ghostty") continue;
        found.set(session.sessionId, matchWindow(session, windows, interactive.filter((o) => o.cwd === session.cwd).length));
      }
      return found;
    },
    async type(place, text) {
      await d.type(place.id, text);
      return { sent: true };
    },
    async key(place, key) {
      await d.key(place.id, key);
      return { sent: true };
    },
    open: (cwd, command) => d.open(cwd, [command.program, ...command.args.map(shellQuote)].join(" ")),
  };
  return self;
}

export const ghostty: Terminal = ghosttyTerminal({
  list: listTerminals,
  type: typeText,
  key: sendKey,
  open: openWindow,
  installed: ghosttyInstalled,
  running: () => ghosttyRunning(),
  kikoInGhostty: () => launchTerminal() === "ghostty",
});

/**
 * A session's Ghostty window: the one in its folder titled with one of its names or titles (Claude
 * Code titles the terminal with the conversation's title), else the only Claude-looking one there
 * when it's the only session in that folder. `sessionsInFolder`: the interactive sessions there.
 * Never a window showing Kiko's tmux (titled TITLE_MARK first, either flavour's): it carries the active pane's
 * title, but what's typed there goes to whichever pane is active; its sessions are tmux's to reach.
 *
 * Never one showing Claude Code's agents list either (../views.ts): ← on an empty prompt parks the
 * session in a background job and leaves its terminal on that list, titled "claude agents" (or "1
 * awaiting input · claude agents"), with no session's name and no status glyph. Its prompt starts a
 * new session ("describe a task for a new session") or replies to whichever job is picked, so words
 * typed there wouldn't reach this one: "agents", said as such, until the session is opened there
 * again and its title is its name. Without it, words for two sessions, each parked seconds before,
 * were refused as "ambiguous".
 */
export function matchWindow(session: Findable, windows: TerminalWindow[], sessionsInFolder: number): Found {
  const inFolder = windows.filter((t) => t.cwd === session.cwd && !TITLE_MARKS.some((mark) => t.title.startsWith(mark)));
  const titles = session.titles.map(words).filter(Boolean);
  const byTitle = inFolder.filter((t) => titles.includes(words(stripGlyph(t.title))));
  if (byTitle.length === 1) return { place: { via: "ghostty", id: byTitle[0].id, keys: true }, mapping: "title" };
  // Claude Code prefixes its title with a status glyph (✳, ◐, ⠋…); a shell title doesn't, nor does its agents list.
  const agentsView = inFolder.filter((t) => isListView(t.title));
  const claudeLooking = inFolder.filter((t) => /^[^\p{L}\p{N}\s]/u.test(t.title));
  if (sessionsInFolder === 1 && claudeLooking.length === 1 && !agentsView.length) {
    return { place: { via: "ghostty", id: claudeLooking[0].id, keys: true }, mapping: "only" };
  }
  // Every Claude Code window in its folder shows the agents list: it's there, but nothing reaches it now.
  if (!byTitle.length && agentsView.length && !claudeLooking.length) return { place: null, mapping: "agents" };
  return { place: null, mapping: inFolder.length ? "ambiguous" : "none" };
}

function stripGlyph(title: string) {
  return title.replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

// A title as words: "cloud-speech" and "Cloud Speech" are the same title, whatever the case and punctuation.
const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(" ");
