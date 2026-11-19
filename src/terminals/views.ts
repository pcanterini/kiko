// What a terminal's title says when an agent's own list of sessions is in front rather than one of
// its sessions: Claude Code's agents list, where ← on an empty prompt parks a session in a background
// job and leaves its terminal (2.1.311–2.1.314). Its prompt starts a new session ("describe a task for
// a new session") or replies to whichever job is picked, so words typed there wouldn't reach the
// session the terminal was found for: the "agents" mapping, said as such, until the session is opened
// there again and its title is its name. Every terminal adapter that can read a title asks here
// (Ghostty its window's, tmux its pane's `#{pane_title}`), whichever agent the session is; an agent
// with a view like it is one more row.
//
// Each pattern is written in what JavaScript's regular expressions and POSIX extended ones (tmux's
// `#{m/r:…}`) read alike, so tmux can check it too in the same step as a paste (tmux pasteCheck). No
// "," "#" or "}" in them (they'd end tmux's format), case aside, spaces around the title aside.
const VIEWS: ReadonlyArray<{ of: string; title: string }> = [
  // "claude agents", or "2 awaiting input · claude agents" while jobs wait.
  { of: "Claude Code's agents list", title: "^ *([0-9]+ awaiting input *· *)?claude agents *$" },
];

const compiled = VIEWS.map((v) => ({ of: v.of, re: new RegExp(v.title, "i") }));

/** The agent's list a terminal titled `title` shows ("Claude Code's agents list"), or null when it isn't one. */
export function listViewOf(title: string): string | null {
  return compiled.find((v) => v.re.test(title))?.of ?? null;
}

/** Whether a terminal titled `title` shows an agent's own list of sessions, not a session. */
export const isListView = (title: string) => listViewOf(title) !== null;

/**
 * Words every view's title has in it, for a script that can't read the patterns (iTerm's
 * AppleScript send refuses a session whose name contains one: ../iterm/). Wider than the patterns:
 * there, refusing a session that only looks like one is the safe side.
 */
export const VIEW_PHRASES: readonly string[] = ["claude agents"];

/** A tmux format that's 1 when the pane's title isn't any of the views, 0 when it is one (for an if-shell -F). */
export const notListViewFormat = () => VIEWS.map((v) => `#{?#{m/ri:${v.title},#{pane_title}},0,1}`).reduce((a, b) => `#{&&:${a},${b}}`);
