// Where Kiko can type into a session at any moment: the terminal it runs in, or an app with a
// message box for it. One adapter each, apart from the computer's platform (src/platform/): Ghostty
// is a terminal app, not "the Mac". index.ts lists the adapters this computer has; core reaches
// them only through it, never through ./ghostty/ or ./tmux/.
//
// None of this is needed to hear a session or to answer it while it waits: announcements, replies
// in its reply window and permission answers go through its agent (its hook), wherever it runs.
// An adapter is only for words (and keys) at any other moment. A session none can reach still gets
// all of that; your words for it while it's idle are refused for now (a later step could hold them
// for its next finished turn instead).
//
// The adapters, in the order they're asked:
//   tmux            Kiko's own tmux server (`tmux -L kiko`): a session's pane found by its
//                   process, typing and keys with `send-keys`, new sessions started there and shown
//                   in a new Ghostty window. Whichever terminal app shows the pane, it's reached this
//                   way; `kiko claude` starts a session there by hand. `capture-pane` reads a pane
//                   it opened while its session starts (Claude Code's trust question).
//   agent           a session whose agent takes words itself, as a new message through its own server
//                   (Agent.message: OpenCode's background service), wherever it runs; no keys
//   rex             Rex (superlogical.com/rex) through its CLI: a session's block found by its process (or
//                   the block its hook said, while its process is in it), typing and keys checked against
//                   the process in front, new sessions in a new tab, screens read (listed only while a
//                   session may be in Rex, and Rex's server runs: `rex` is never started otherwise)
//   iterm           iTerm2 over AppleScript: a session's tab found by its tty (its process's), Codex's by
//                   program and folder; typing (`write text`, Enter on its own), keys, screens, new windows;
//                   the process checked again before every send, nothing brought forward but a new window
//   terminal        Terminal.app over AppleScript: the same, but words go in with `do script` (one bracketed
//                   paste and Terminal's own Return after it) and no keys: it can't send one without a Return
//                   (both: run by the helper app; listed only while a session may be in that app and it runs)
//   ghostty         Ghostty over AppleScript: windows matched by folder and title, typing, keys, new windows
//                   (run by the helper app; listed only while a session may be in Ghostty)
// The Claude desktop app has no adapter: the only way in was its UI, through the clipboard, and
// Kiko never touches the clipboard. Its sessions are like those in a terminal none can reach.
// kitty and WezTerm would each be one more adapter like these, only if people ask.

/** What an adapter needs to know of a listed session to find where it runs. */
export type Findable = {
  sessionId: string;
  cwd: string;
  kind: "interactive" | "background";
  /** Runs in the Claude desktop app, not in a terminal. */
  desktop: boolean;
  /** Its process, when its agent knows it: tmux finds its pane by it. */
  pid?: number;
  /** What its window may be titled: its names and titles (Claude Code titles its terminal with its conversation's). */
  titles: string[];
  /** The agent that lists it, when that isn't the main one (src/agents/index.ts agentOf): T3 Code's threads are reached by its own adapter only. */
  agent?: string;
  /** Its words always go in as a bracketed paste (AgentSession.bracketed: Codex's). */
  bracketed?: boolean;
  /** Its TUI's executable, where its process isn't known (AgentSession.program): its pane is found by that and its folder. */
  program?: string;
  /**
   * The pane it was last found in or opened in (tmux: "%12"), tried first when its process isn't
   * known; or the Rex block its hook said it runs in (REX_BLOCK, "block:<uuid>"), tried first and
   * taken only while its process is in it; or the iTerm session (Terminal tab) it was opened in.
   */
  pane?: string;
  /**
   * The terminal app it runs in, as its hook said (core/terminal-apps.ts sessionTerminal: "ghostty", "iterm",
   * "kiko-tmux"…); left out while that isn't known. Ghostty, iTerm and Terminal are scripted only for
   * sessions there, or not known while the app runs.
   */
  terminal?: string;
};

/**
 * How a session's place was found: by its process (tmux: the pane it runs in), by its window's
 * title, or as the only Claude-looking window in its folder. Not found: several windows (or panes)
 * could be it ("ambiguous"), none ("none"), its window shows Claude Code's agents list rather than
 * the session ("agents": typed there, words would start a new session or reply to whichever one is
 * picked in the list), so nothing types into it.
 */
export type Mapping = "process" | "title" | "only" | "ambiguous" | "agents" | "none";

/** Where an adapter can type into a session. */
export type Place = {
  /** The adapter that found it: its `id`. */
  via: string;
  /** The session's handle there: a tmux pane, a Rex block, an iTerm session's id, a Terminal tab's tty, a Ghostty terminal's id, a T3 Code thread's id. */
  id: string;
  /** It takes keys, as a terminal does (Escape interrupts the session); a message box only takes words. */
  keys: boolean;
  /** The session's process, where it was found by it (tmux, Rex, iTerm, Terminal): checked again before every key typed. */
  pid?: number;
  /** Words go in as a bracketed paste even on one line, where the program asks for those (Findable.bracketed). */
  bracketed?: boolean;
  /** Its terminal device, where it was found by it (iTerm, Terminal: "/dev/ttys003"): its process checked to be on it before every send. */
  tty?: string;
};

export type Found = { place: Place | null; mapping: Mapping };

/** Whether words got in, and if not, why (said out loud: "its tmux pane has closed"). */
export type Typed = { sent: true } | { sent: false; why: string; error?: string };

/** A program to run, and its arguments: quoted for its shell by the adapter that runs it. */
export type Command = { program: string; args: string[] };

/** A terminal app, or an app with a message box, that sessions can be typed into. */
export interface Terminal {
  readonly id: string;
  /** Shown after a send that went in through it ("→ lacy (T3 Code)"); null for a terminal ("→ typed into lacy"). */
  readonly label: string | null;
  /**
   * Where it can type into each of these sessions, by session ID: only the ones it could reach, or
   * tried to. Called with every session list, as the list is being made: anything of its own to
   * list (its windows) starts at once, not after it.
   */
  find(sessions: Promise<readonly Findable[]>): Promise<Map<string, Found>>;
  /** Types `text` in as if pasted (never through the clipboard), then sends it. */
  type(place: Place, text: string): Promise<Typed>;
  /** One key press, e.g. "escape"; only where `keys`. Not sent says why, as `type` does. */
  key?(place: Place, key: string): Promise<Typed>;
  /**
   * A new window in `cwd` running `command` in the user's shell. Throws when nothing was started;
   * a note back (said after "Opening pixie.") when it started but something's off (no window shown).
   * `opened`: told its handle (tmux: its pane) as soon as it has one, for `program`.
   */
  open?(cwd: string, command: Command, opened?: (handle: string) => void): Promise<string | void>;
  /**
   * What runs in a window it opened (`opened`'s handle): the command still ("running"), the user's
   * shell again ("shell": the command ended, or hasn't started yet), or nothing ("gone").
   */
  program?(handle: string): Promise<"running" | "shell" | "gone">;
  /**
   * The text on the screen of a window it opened (`opened`'s handle), as it shows now (tmux:
   * `capture-pane -p`); null when it's gone. For a session still starting, whose agent asks
   * something there first (Claude Code's trust question: core/trust-prompt.ts).
   */
  screen?(handle: string): Promise<string | null>;
  /**
   * One key (`down`, `up`, `enter`, `escape`) into a window it opened, while its program (not the
   * shell) is in front: for a session still starting, which has no process of its own to check yet.
   * Only that window: not sent says why, as `key` does.
   */
  press?(handle: string, key: string): Promise<Typed>;
  /**
   * Where to type into a window it opened (`opened`'s handle): its program in front there, as a
   * place `type` checks as it would a listed session's; null when nothing is in front, or it's gone.
   * For a session still starting that its agent lists only after its first message (Codex), once
   * its screen shows it ready for one (Agent.readyOnScreen).
   */
  placeIn?(handle: string): Promise<Place | null>;
  /**
   * The windows of its own whose front program `is` says is an agent's (tmux: the live panes of
   * Kiko's server that aren't the window's own), with their folder: for listing a session from its
   * pane before its agent lists it (Agent.runsAs). Left out: it can't tell.
   */
  agentPanes?(is: (command: string) => boolean): Promise<Array<{ handle: string; cwd: string; command: string }>>;
  /** Whether it can be used now (tmux: installed); always, when it doesn't say. */
  ready?(): boolean;
}
