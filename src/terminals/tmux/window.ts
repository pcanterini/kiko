// The Kiko window: one terminal with Kiko's list on the left, a Claude Code session on the
// right and Kiko's state in the bottom line, all drawn by tmux on Kiko's own server.
//
//   ┌ Kiko ───────┬ pixie ─────────────────────────────┐
//   │ ── INTERNAL ── │                                    │
//   │ ► pixie   ● idle│  the real Claude Code, in its pane │
//   │   lacy ● working│                                    │
//   ├────────────────┴────────────────────────────────────┤
//   │ Kiko is ready · you: “…”       hold right ⌥ to talk│  ← the status line
//   └─────────────────────────────────────────────────────┘
//
// How: the window is a tmux session of its own (WINDOW, "_kiko") with one tmux window, the
// "view", of two panes: the list (the Kiko app itself, its Ink TUI) and the stage. Every Claude
// Code session stays a tmux session of its own, as before (its pane is the process the adapter
// matches by pid). Showing one swaps its pane into the stage (`swap-pane`, which keeps the pane, its
// process and its terminal), and the one shown before goes back where it came from (its "home"
// window, kept in the pane's @kiko-home). A placeholder (./placeholder.sh) fills the stage when
// nothing is shown, and a home while its session is shown. A session outside Kiko's tmux (in
// Ghostty, the desktop app, the background) is shown as its conversation, read-only: a viewer
// (./viewer-pane.ts) run in the stage's spot, made a placeholder again when a session comes in; so is
// Kiko's own page (its conversation with you), the stage's usual sight while the app runs. The
// bottom line is the window session's status line, whose text the app sets (@kiko-bar): no
// process of its own, always one row, with a "☰ Kiko" button at its right end. The Kiko key
// (Ctrl+Space unless you pick another: ./keys.ts), from any pane, or a click on the button, shows
// the window's menu, which the app keeps to its state (@kiko-menu); what its items ask of the
// app reaches the list's pane as input only it reads (askApp). The key again in the menu passes it
// on to the session shown.
//
// Why this way: the Kiko panes never move, so resizing and several terminals attached at once
// (each one more view of the same window, `window-size latest`) are plain tmux; a session ending
// in the stage is put back by a tmux hook even if the app isn't running; and sessions keep working
// on their own, shown or not (typing, `kiko ls`).
//
// On tmux 3.8 and later the window has the classic look instead (./classic.ts: the full-screen
// UI's, two boxes side by side, one line under them): the list and the stage are floating panes
// over a third, the frame (./frame-pane.ts), which paints that line, the app's rendering; no status
// line. Everything else (the swaps, the homes, the hooks, the menus) is the same.
//
// Used by `kiko` (src/cli.ts), by the tmux adapter to open new sessions into the window, and by
// the app (src/ui/window-glue.ts). Imports nothing that loads .env, reads settings or writes logs.
import { fileURLToPath } from "node:url";
import { appFile, programArgv } from "../../core/app-root.ts";
import { COMMAND, OWN, SLUG } from "../../core/name.ts";
import { menuSize, type MenuData } from "../../ui/menu-view.ts";
import {
  boxes,
  CAPTION_BORDER,
  CAPTION_TITLE,
  captionBox,
  captionCommands,
  CLASSIC,
  classicLook,
  draggedFormat,
  FOCUS_BORDER,
  geometry,
  LOOK,
  MENU_AT,
  placeCommands,
  placeFormat,
  REST_BORDER,
  TITLE,
  TITLE_REST,
  type Box,
} from "./classic.ts";
import type { Clash } from "./clash.ts";
import { HERDR_VARS } from "./herdr.ts";
import { DEFAULT_KEY, keySequences, keySymbol } from "./keys.ts";
import { appOption, freeName, noServer, TITLE_MARK, tmuxArg, tmuxFormatArg, tmuxPath, WINDOW, type Launch } from "./tmux.ts";

/** tmux on Kiko's server: its output, or a rejection with what it said (tmux.ts tmuxRunner). */
export type Tmux = (args: string[], input?: string) => Promise<string>;

// Pane, window and session options of ours ("@…" options are tmux's user options).
/**
 * Pane: "list" (the app's pane), "placeholder", "viewer" (an outside session's conversation), or
 * unset (a session); in the classic look also "frame" (the line under the boxes) and
 * "caption" (your words while you dictate).
 */
export const ROLE = appOption("role");
/** Pane (classic look): the agent mark before its name in its box's title, a tmux format (the app sets it: setMark). */
export const MARK = appOption("mark");
/** Pane (a viewer): the page it shows (PAGE_ID, or a session's: sessionPage). */
export const VIEWING = appOption("viewing");
/** Pane (a viewer): what its header says, as JSON from the app (src/ui/viewer.ts ViewerInfo), read by the viewer. */
export const VIEWER_INFO = appOption("viewer");
/** Pane: the window a session's pane goes back to when another is shown. */
export const HOME = appOption("home");
/** Pane: the name shown on its border in the window. */
export const LABEL = appOption("name");
/** Pane (a viewer of an outside session): where that session runs ("in Ghostty"), after its name on the border, dimmed. */
export const PLACE = appOption("place");
/** Window: 1 for the Kiko window's view (what the Kiko key and the placeholder ask). */
export const VIEW = appOption("view");
/** Session (the window's): the bottom line's text, a tmux format (styles allowed). */
export const BAR = appOption("bar");
/** Window: what the Kiko key and the ☰ button run, the popup with its menu (menuPopup), kept by the app to its state (menuKey). */
export const MENU = appOption("menu");
/** Window: the list's width as you last dragged it, kept when the window resizes. */
export const LIST_WIDTH = appOption("list-width");
/**
 * Window: set while the app is starting (setStarting): what it's doing now (a STEPS word), or
 * STARTED_ONLY when that isn't known yet. The placeholder says it in place of "No session shown here".
 */
export const STARTING = appOption("starting");
export const STARTED_ONLY = "1";
/** A placeholder's name on its border while the app starts (else "no session"). */
const STARTING_LABEL = "starting";
/** What the app is doing as it starts, as the placeholder says it (plain ASCII: it's read back through tmux). */
export const STEPS = {
  build: "Building the helpers",
  agents: "Connecting to sessions",
  voice: "Starting the voice",
  sessions: "Looking for sessions",
} as const;
export type Step = (typeof STEPS)[keyof typeof STEPS];

export const PLACEHOLDER = appFile("src/terminals/tmux/placeholder.sh", "tmux/placeholder.sh");
export const VIEWER = fileURLToPath(new URL("./viewer-pane.ts", import.meta.url));
export const FRAME = fileURLToPath(new URL("./frame-pane.ts", import.meta.url));
// The Kiko key, kept on the server (global user options) by `kiko` as it opens the window,
// for the app, the placeholder and the next `kiko` to read: the key bound now (tmux's name),
// as it's shown ("⌃Space"), what decided it (keys.ts KeyBy, or "clash" when it's a fallback), and
// what the app is to say once as it starts (Note, as JSON) and has said (their ids).
export const KEY_OPTION = appOption("key");
const KEY_NAME_OPTION = appOption("key-name");
export const KEY_BY_OPTION = appOption("key-by");
export const NOTES_OPTION = appOption("notes");
export const NOTES_SAID_OPTION = appOption("notes-said");
/**
 * Server-wide too: the agent `kiko codex` (or `kiko claude`) started a session of, by its id,
 * which new sessions preselect for that run (core/agent-pick.ts) until the next plain `kiko`
 * takes it out. Read by the app each time it picks one.
 */
export const NEW_AGENT_OPTION = appOption("new-agent");

/** The run's agent for new sessions (NEW_AGENT_OPTION) set, or (null) taken out. */
export async function setNewAgent(tmux: Tmux, id: string | null): Promise<void> {
  await (id ? tmux(["set-option", "-g", NEW_AGENT_OPTION, tmuxArg(id)]) : tmux(["set-option", "-g", "-u", NEW_AGENT_OPTION])).catch(() => "");
}

/** The run's agent for new sessions (NEW_AGENT_OPTION); null for none. */
export async function newAgent(tmux: Tmux): Promise<string | null> {
  return (await tmux(["show-options", "-gqv", NEW_AGENT_OPTION]).catch(() => "")).trim() || null;
}

/**
 * Something `kiko` found as it opened the window, for the app to tell you once (src/ui/window-glue.ts):
 * a key clash (clash.ts), herdr keeping right-clicks (herdr.ts). `id` says which, so it's told once
 * however many `kiko`s find it; `text` is shown, `spoken` said (none: only shown); `log` is the
 * app's log line for it. `ask`: a key clash to ask you about (clash.ts clashQuestion), after the warning.
 */
/** `at`: when that `kiko` left it (ms), for a question: it goes to the terminal attached since. */
export type Note = { id: string; text: string; spoken?: string; log: { event: string; fields: Record<string, unknown> }; ask?: Clash; at?: number };
/**
 * The window's pages go by IDs of their own, apart from sessions' IDs: Kiko's own page is
 * PAGE_ID, a session's is "session:" and its ID (sessionPage). So no session can ever pass for
 * Kiko's page (or the other way round): in the list, VIEWING, and what the menus ask of the app.
 */
export const PAGE_ID = `page:${SLUG}`;
export const sessionPage = (sessionId: string) => `session:${sessionId}`;
/** The session a page is (sessionPage), or null for Kiko's page and anything else. */
export const sessionOf = (page: string): string | null => (page.startsWith("session:") ? page.slice("session:".length) || null : null);

const S = `=${WINDOW}`; // the window's session, by exactly that name (commands that take a session)
const V = `=${WINDOW}:`; // its (only) window, the view; as a pane target, the active pane

/** A pane on the server, as `describe` sees it. */
type WPane = {
  id: string;
  window: string;
  session: string;
  dead: boolean;
  role: "list" | "placeholder" | "viewer" | "frame" | "caption" | "";
  home: string;
  inView: boolean;
  width: number;
  height: number;
  active: boolean;
  name: string;
  /** A viewer's session (VIEWING); "" for any other pane. */
  viewing: string;
  cwd: string;
};
type View = {
  window: string;
  list: WPane | null;
  /** What the session area shows: a session's pane, a viewer, a placeholder, or nothing (closed). */
  stage: WPane | null;
  zoomed: boolean;
  width: number;
  height: number;
  /** Terminals attached to the window. */
  clients: number;
  /** The list's width as you last dragged it (LIST_WIDTH); 0 for none. In the classic look its box's, the border included. */
  listWidth: number;
  /** "classic" (./classic.ts: boxes over the frame) or "tiled" (two panes and the status line). */
  look: "classic" | "tiled";
  /** The classic look's frame pane and caption (null for none, and in the tiled look). */
  frame: WPane | null;
  caption: WPane | null;
};
export type Layout = { panes: WPane[]; view: View | null };

/** A pane's role (ROLE); a caption's from its title too, from the moment it's made (CAPTION_TITLE). */
const ROLE_FIELD = `#{?#{${ROLE}},#{${ROLE}},#{?#{==:#{pane_title},${CAPTION_TITLE}},caption,}}`;

const FIELDS = [
  "W",
  "#{pane_id}",
  "#{window_id}",
  "#{session_name}",
  "#{pane_dead}",
  ROLE_FIELD,
  `#{${HOME}}`,
  `#{${VIEW}}`,
  "#{window_zoomed_flag}",
  "#{window_width}",
  "#{pane_width}",
  "#{pane_height}",
  "#{session_attached}",
  "#{pane_active}",
  `#{${LABEL}}`,
  `#{${VIEWING}}`,
  `#{${LIST_WIDTH}}`,
  "#{window_height}",
  `#{${LOOK}}`,
  "#{pane_current_path}",
];
const LAYOUT_FORMAT = FIELDS.join("\t");

const ROLES: readonly WPane["role"][] = ["list", "placeholder", "viewer", "frame", "caption"];

/** `list-panes -a -F LAYOUT_FORMAT` read back. Lines of any other shape are left out. */
export function parseLayout(out: string): Layout {
  const seen = new Set<string>();
  const rows = out
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((f) => f.length >= FIELDS.length && f[0] === "W" && /^%\d+$/.test(f[1]) && !seen.has(f[1]) && seen.add(f[1]));
  const panes: WPane[] = [];
  let view: View | null = null;
  for (const [, id, window, session, dead, role, home, inView, zoomed, windowWidth, width, height, attached, active, name, viewing, dragged, windowHeight, look, ...cwd] of rows) {
    const pane: WPane = {
      id,
      window,
      session,
      dead: dead === "1",
      role: ROLES.includes(role as WPane["role"]) ? (role as WPane["role"]) : "",
      home,
      inView: inView === "1",
      width: Number(width),
      height: Number(height),
      active: active === "1",
      name,
      viewing,
      cwd: cwd.join("\t"),
    };
    panes.push(pane);
    if (pane.inView && session === WINDOW) {
      view ??= {
        window,
        list: null,
        stage: null,
        zoomed: zoomed === "1",
        width: Number(windowWidth),
        height: Number(windowHeight) || 0,
        clients: Number(attached) || 0,
        listWidth: Number(dragged) || 0,
        look: look === CLASSIC ? "classic" : "tiled",
        frame: null,
        caption: null,
      };
      if (window !== view.window) continue;
      if (pane.role === "list") view.list ??= pane;
      else if (pane.role === "frame") view.frame ??= pane;
      else if (pane.role === "caption") view.caption ??= pane;
      // A session over a viewer over a placeholder, if there's ever more than one (never left like that).
      else if (!view.stage || (view.stage.role === "placeholder" && pane.role !== "placeholder") || (view.stage.role === "viewer" && !pane.role)) view.stage = pane;
    }
  }
  return { panes, view };
}

/** Every pane on the server and the window's view (null when the window isn't open). */
export async function describe(tmux: Tmux): Promise<Layout> {
  try {
    return parseLayout(await tmux(["list-panes", "-a", "-F", LAYOUT_FORMAT]));
  } catch (err) {
    if (noServer(err)) return { panes: [], view: null };
    throw err;
  }
}

/**
 * The list's width for a window this wide: as you last dragged it (`dragged`), at least 16 columns
 * and at most half the window; else a quarter, 24 to 40 columns. LIST_WIDTH_FORMAT is the same for tmux.
 */
export function listWidth(windowWidth: number, dragged = 0) {
  if (dragged > 0) return Math.max(16, Math.min(Math.floor(windowWidth / 2), dragged));
  return Math.max(24, Math.min(40, Math.floor(windowWidth / 4)));
}

/** A command list for one tmux run (`a ; b ; c`): tmux runs it through without another client's commands in between. */
export function together(...commands: string[][]): string[] {
  return commands.filter((c) => c.length).flatMap((c, i) => (i ? [";", ...c] : c));
}

/** What a placeholder runs: tmux's path, our options' start, and the title it says while the app starts. */
const placeholderCommand = () => ["/bin/sh", PLACEHOLDER, tmuxPath() ?? "tmux", appOption("").slice(0, -1), OWN.title].map(tmuxArg);

/**
 * The window's starting state (STARTING): `step` while the app starts (STARTED_ONLY: not said
 * which yet), null once it's ready (or not starting after all: another app runs). The placeholders
 * in the view are named for it on their border ("starting", then "no session") and drawn again:
 * tmux sends each one's process a SIGWINCH (as on a resize, which it redraws on; if the pane has
 * become something else meanwhile, a viewer, that just redraws too). One tmux run.
 */
export async function setStarting(tmux: Tmux, step: Step | typeof STARTED_ONLY | null): Promise<void> {
  const placeholders = (await tmux(["list-panes", "-t", V, "-F", `#{pane_id}\t#{${ROLE}}`]))
    .split("\n")
    .map((l) => l.split("\t"))
    .filter(([id, role]) => /^%\d+$/.test(id ?? "") && role === "placeholder")
    .map(([id]) => id);
  await tmux(
    together(
      step ? ["set-option", "-w", "-t", V, STARTING, step] : ["set-option", "-w", "-u", "-t", V, STARTING],
      ...placeholders.flatMap((id) => [setPane(id, LABEL, step ? STARTING_LABEL : "no session"), ["run-shell", "-b", "-t", id, "kill -WINCH #{pane_pid} 2>/dev/null || true"]]),
    ),
  );
}

/** A pane's name on its border: no tabs or line breaks (they'd break `describe`), not too long. */
const label = (name: string) =>
  name
    .replace(/[\t\r\n]+/g, " ")
    .trim()
    .slice(0, 60);
const setPane = (pane: string, option: string, value: string) => ["set-option", "-p", "-t", pane, option, tmuxArg(value)];

/**
 * What a viewer runs: ./viewer-pane.ts, by the Node running this, following `path` (a session's
 * transcript). Nothing else on its command line; its environment is the tmux server's, as any pane's.
 */
export const viewerCommand = (path: string, page = false) => [...programArgv("viewer"), tmuxPath() ?? "tmux", path, ...(page ? ["page"] : [])].map(tmuxArg);

/** `pane` (a placeholder, or a viewer that's done) made a placeholder again, started afresh. */
const asPlaceholder = (pane: string) => [
  setPane(pane, ROLE, "placeholder"),
  setPane(pane, LABEL, "no session"),
  ["set-option", "-p", "-u", "-t", pane, VIEWING],
  ["set-option", "-p", "-u", "-t", pane, VIEWER_INFO],
  ["set-option", "-p", "-u", "-t", pane, MARK],
  ["set-option", "-p", "-u", "-t", pane, PLACE],
  ["respawn-pane", "-k", "-t", pane, "--", ...placeholderCommand()],
];

/**
 * When a session's pane ends in the stage (its program quit: the window keeps exited panes, so
 * this hears of it; one Kiko opened ends with its program too, its shell not kept: index.ts
 * afterProgram), the placeholder in its home comes back to the stage and the ended pane goes,
 * taking its home window and tmux session with it. tmux does it, so it's done even while the app
 * isn't running. (`run-shell -C` so the formats are filled in first; `##` stays a `#` for the
 * inner check, which looks at the home's pane.) Only when what's in its home is a placeholder:
 * respawning a home that holds a live session (moved there by some mix-up) would kill its Claude
 * Code; `tidy` sees to it then. The list's pane and a placeholder have no home: they stay, showing
 * remain-on-exit-format, for `kiko` or the app to restart.
 */
export const DIED_HOOK =
  `if-shell -F "#{${HOME}}" "run-shell -C \\"if-shell -F -t #{${HOME}} '##{==:##{${ROLE}},placeholder}' ` +
  `'respawn-pane -k -t #{${HOME}} ; swap-pane -d -s #{hook_pane} -t #{${HOME}} ; kill-pane -t #{hook_pane}'\\""`;

/** Shown at the bottom of a pane that ended and stays (see DIED_HOOK). No commas: they'd end a branch. */
const EXITED = `#{?#{==:#{${ROLE}},list},${OWN.title} stopped · run ${COMMAND},#{?#{${HOME}},#{${LABEL}} ended,}}`;

/** listWidth as a tmux format, for the window's own width (the dragged width, or a quarter). */
const QUARTER = "#{e|/:#{window_width},4}";
const HALF = "#{e|/:#{window_width},2}";
const DRAGGED = `#{${LIST_WIDTH}}`;
const LIST_WIDTH_FORMAT = `#{?${DRAGGED},#{?#{e|<:${DRAGGED},16},16,#{?#{e|>:${DRAGGED},${HALF}},${HALF},${DRAGGED}}},` + `#{?#{e|<:${QUARTER},24},24,#{?#{e|>:${QUARTER},40},40,${QUARTER}}}}`;

/**
 * The window resized (a terminal resized, another attached): the list (the leftmost pane) back to
 * its width, by tmux, so it holds with the app stopped too. Not while zoomed: resizing a pane
 * would unzoom the window (settings, the full screen). The target in quotes: tmux would take a
 * bare {…} for a block of commands.
 */
export const RESIZED_HOOK = `if-shell -F "#{?window_zoomed_flag,0,1}" "run-shell -C \\"resize-pane -t '${V}.{left}' -x ${LIST_WIDTH_FORMAT}\\""`;

// The borders' look. No lines: each pane's top border is a quiet header bar with its name, and the
// one between the list and the session a bar of the same colour, so no corners to line up and no
// border half one colour, half another (tmux's pane-border-indicators). Focus shows in the names:
// the active one bold in the accent colour, the other a grey that still reads (both over 5:1 on the
// bar). colour236 is #303030; colour110 #87afd7; colour248 #a8a8a8.
const BORDER = "fg=colour248,bg=colour236";
const ACTIVE_NAME = "#[fg=colour110#,bold]";
const NAME_STYLE = "#[fg=colour248#,nobold]";

/** What the classic look's frame runs (./frame-pane.ts; `caption`: the caption's words), by the Node running this. Nothing else on its command line. */
const frameCommand = (caption = false) => [...programArgv("frame"), tmuxPath() ?? "tmux", ...(caption ? ["caption"] : [])].map(tmuxArg);

// The classic look's titles, on each box's top border: bold, light on the box with the keyboard,
// dimmer on the other (the border's colour follows it too: pane-active-border-style). The list's
// box is "Sessions"; the stage's has the agent mark of the session shown (MARK, in its agent's
// colour, set by the app) and its name, or Kiko's for its page; an outside session's (a viewer)
// where it runs after it, dimmed (PLACE: "pixie · in Ghostty"). The caption has none.
const TITLE_STYLE = `#{?pane_active,#[fg=${TITLE}#,bold],#[fg=${TITLE_REST}#,bold]}`;
/** " · in Ghostty", dimmed, for a pane with a PLACE; nothing for any other. */
const PLACE_PART = `#{?#{${PLACE}},#[nobold#,dim] · #{${PLACE}},}`;
export const CLASSIC_TITLE =
  `#{?#{==:#{${ROLE}},caption},,#{?#{==:#{pane_title},${CAPTION_TITLE}},, ${TITLE_STYLE}` +
  `#{?#{==:#{${ROLE}},list},Sessions,#{E:${MARK}}${TITLE_STYLE}#{?#{${LABEL}},#{${LABEL}},#{pane_title}}${PLACE_PART}} #[default]}}`;

/** The view's look: tmux's own window options; `classic`, the classic look's (./classic.ts). */
export function viewOptions(classic = false): string[][] {
  const w = (option: string, value: string) => ["set-option", "-w", "-t", V, option, value];
  if (classic) {
    return [
      w(VIEW, "1"),
      w(LOOK, CLASSIC),
      w("remain-on-exit", "on"),
      w("remain-on-exit-format", EXITED),
      w("pane-border-status", "top-floating"),
      w("pane-border-lines", "single"),
      w("pane-border-indicators", "off"),
      w("pane-border-format", CLASSIC_TITLE),
      w("pane-border-style", `fg=${REST_BORDER}`),
      w("pane-active-border-style", `fg=${FOCUS_BORDER}`),
    ];
  }
  return [
    w(VIEW, "1"),
    w("remain-on-exit", "on"),
    w("remain-on-exit-format", EXITED),
    w("pane-border-status", "top"),
    w("pane-border-lines", "spaces"),
    w("pane-border-indicators", "off"),
    w("pane-border-format", `#{?pane_active,${ACTIVE_NAME},${NAME_STYLE}}#{?#{${LABEL}},#{${LABEL}},#{pane_title}}${PLACE_PART}`),
    w("pane-border-style", BORDER),
    w("pane-active-border-style", BORDER),
  ];
}

/**
 * The ☰ button at the bottom line's right end: a click on it opens the menu (BUTTON_KEY), so
 * there's always a way in without the key. A tmux "user range" (tmux 3.4 and later) named
 * BUTTON_RANGE; quiet, a shade off the line's own grey. colour237 is #3a3a3a.
 */
const BUTTON_RANGE = "menu";
const BUTTON = `#[align=right]#[nodim#,nobold#,default]#[range=user|${BUTTON_RANGE}]#[fg=colour252#,bg=colour237] ☰ ${OWN.title} #[norange#,default]`;

/**
 * The window session's status line: the bar, nothing else (no window list), and the ☰ button. In
 * the classic look none: the frame draws the window's last line (its menu words are the button
 * there: clickKey), and puts the boxes back when the window resizes (no hook for that).
 */
export function barOptions(text = `${OWN.title} is starting…`, classic = false): string[][] {
  const s = (option: string, value: string) => ["set-option", "-t", V, option, value];
  if (classic) {
    return [
      s("status", "off"),
      s("set-titles-string", `${TITLE_MARK}#{pane_title}`),
      s(BAR, text),
      ["set-hook", "-t", V, "pane-died", DIED_HOOK],
      ["set-hook", "-u", "-t", V, "window-resized"],
      ["set-hook", "-w", "-t", V, "pane-resized", splitHook()],
    ];
  }
  return [
    s("status", "on"),
    s("status-position", "bottom"),
    s("status-style", "bg=colour235,fg=colour250"),
    s("status-format[0]", `#[align=left] #{E:${BAR}}${BUTTON}`),
    // The terminal's title marked as Kiko's (TITLE_MARK), also on a server started with an older tmux.conf.
    s("set-titles-string", `${TITLE_MARK}#{pane_title}`),
    s(BAR, text),
    ["set-hook", "-t", V, "pane-died", DIED_HOOK],
    ["set-hook", "-t", V, "window-resized", RESIZED_HOOK],
  ];
}

/**
 * The Kiko key (`key`, tmux's name for it) in the view shows the menu the app keeps (`run-shell
 * -C` reads MENU and runs it as the tmux command it is: a popup on the terminal that pressed it);
 * anywhere else it's the program's. Server-wide. Before the app sets one, it's startingMenu.
 */
export const menuKey = (key = DEFAULT_KEY) => ["bind-key", "-n", key, "if-shell", "-F", `#{${VIEW}}`, `run-shell -C '#{${MENU}}'`, `send-keys ${tmuxQuoted(key)}`];

/**
 * A click on the ☰ button (BUTTON) shows the same menu; any other click on a status line does what
 * tmux does by default (only the window has one on this server).
 */
const buttonKey = () => ["bind-key", "-n", "MouseDown1Status", "if-shell", "-F", `#{&&:#{${VIEW}},#{==:#{mouse_status_range},${BUTTON_RANGE}}}`, `run-shell -C '#{${MENU}}'`, "switch-client -t ="];

/**
 * Dragging the border between the list and the session resizes the list (tmux's own); where you
 * leave it is kept (LIST_WIDTH) for when the window resizes: the left pane's width, read as tmux
 * finishes the drag. Elsewhere nothing (tmux binds nothing there). The classic look's: dragKeys.
 */
const dragKey = () => ["bind-key", "-n", "MouseDragEnd1Border", "if-shell", "-F", `#{${VIEW}}`, `run-shell -C -t '{left}' "set-option -w ${LIST_WIDTH} '#{pane_width}'"`];

// The classic look's boxes are floating panes, and tmux resizes a floating pane by itself as you
// drag its border (resize-pane -M: no binding runs for a drag's steps, and none knows where the
// mouse is on a border, mouse_x being a pane's). So the two move together by a hook: each step
// resizes the box dragged, which fires pane-resized, and splitHook puts the other one against it
// before tmux draws (hooks run before the screen is redrawn), the frame's layout kept: the window's
// first line to the one above its last, the list from the left edge, the stage to the right one.
// Only while a drag of ours is on (DRAGGING, from the drag's start to its end), so a resize of any
// other kind (the window, zoom, a session swapped in) is the frame's and the app's as before.

/** Window (classic look): the list's box width as a drag of a box's border began; unset when none is on. */
export const DRAGGING = appOption("dragging");
/** Window (classic look): splitHook's working: where the split goes, the list's box width. */
const SPLIT = appOption("split");
/** The list's box width, its border included (formats run over the window's panes: `P:`). */
const LIST_BOX = `#{P:#{?#{==:#{${ROLE}},list},#{e|+:#{pane_width},2},}}`;
/** The frame's process, by its pane. */
const FRAME_PID = `#{P:#{?#{==:#{${ROLE}},frame},#{pane_pid},}}`;
/** The window has the classic look (its view, not zoomed: settings). */
const CLASSIC_VIEW = `#{&&:#{${VIEW}},#{&&:#{==:#{${LOOK}},${CLASSIC}},#{?window_zoomed_flag,0,1}}}`;

/** The key table a drag of ours ends in (dragKeys). */
export const DRAG_TABLE = `${SLUG}-drag`;

/**
 * The classic look's drags. One of a box's border: tmux resizes the box (resize-pane -M, as by
 * default), DRAGGING noted first so splitHook keeps the other box against it all the way, and the
 * dragging client put in a key table of ours (DRAG_TABLE) for the drag's end, wherever you let go:
 * on a border, or over a pane (often where the mouse is once the split has stopped at a limit),
 * even one in copy mode (scrolled back), whose own table would otherwise take the release (tmux
 * uses a mode's table only while the client is in its root one). The end: the list's width kept
 * (LIST_WIDTH, its box's) when it changed, DRAGGING gone, and the frame told (a SIGWINCH, as a
 * resize tells it), which puts the boxes where they go: where the drag left them, so nothing moves.
 * tmux puts the client back in its root table as a key of the table runs (or as one that isn't in
 * it comes: it then tries the root table). A box moved by a drag (Alt, as tmux binds it) goes
 * back as before, at its end on a border.
 */
export function dragKeys(): string[][] {
  const end = commandString([
    ["if-shell", "-F", "-t", "=", `#{&&:#{${DRAGGING}},#{!=:#{${DRAGGING}},${LIST_BOX}}}`, commandString([["set-option", "-w", "-t", "=", "-F", LIST_WIDTH, LIST_BOX]])],
    ["set-option", "-w", "-t", "=", "-u", DRAGGING],
    ["run-shell", "-b", `kill -WINCH ${FRAME_PID}`],
  ]);
  const begin = commandString([
    ["set-option", "-w", "-t", "=", "-F", DRAGGING, LIST_BOX],
    ["switch-client", "-T", DRAG_TABLE],
    ["resize-pane", "-M"],
  ]);
  return [
    ["bind-key", "-n", "MouseDrag1Border", "if-shell", "-F", "-t", "=", CLASSIC_VIEW, begin, "resize-pane -M"],
    ["bind-key", "-n", "MouseDragEnd1Border", "if-shell", "-F", "-t", "=", `#{${VIEW}}`, end],
    ...["MouseDragEnd1Border", "MouseDragEnd1Pane"].map((k) => ["bind-key", "-T", DRAG_TABLE, k, "if-shell", "-F", "-t", "=", `#{${DRAGGING}}`, end]),
  ];
}

/**
 * The classic look's pane-resized hook (a window hook): while a drag is on (DRAGGING), a box that
 * resized (the list, or the stage: floating, not the caption) has the split where its edge is now
 * (the list's right edge, the stage's left one), kept to the widths boxes() allows (draggedFormat),
 * and both boxes go there (placeFormat). Its own resizes fire it again, which finds them in place.
 */
const BOX_RESIZED = `#{&&:#{pane_floating_flag},#{?#{||:#{==:#{${ROLE}},caption},#{==:#{pane_title},${CAPTION_TITLE}}},0,1}}`;
const EDGE = `#{?#{==:#{${ROLE}},list},#{e|+:#{e|+:#{pane_left},#{pane_width}},1},#{e|-:#{pane_left},1}}`;
export const splitHook = () =>
  commandString([
    [
      "if-shell",
      "-F",
      `#{&&:#{${DRAGGING}},#{&&:#{?window_zoomed_flag,0,1},#{&&:${BOX_RESIZED},#{&&:${LIST_ID},${STAGE_ID}}}}}`,
      commandString([
        ["set-option", "-w", "-F", SPLIT, EDGE],
        ["set-option", "-w", "-F", SPLIT, draggedFormat(`#{${SPLIT}}`)],
        ["run-shell", "-C", placeFormat(LIST_ID, STAGE_ID, `#{${SPLIT}}`)],
      ]),
    ],
  ]);

/**
 * The classic look's clicks: on the bottom line's menu words (from MENU_AT on the frame's last line, which the
 * frame keeps) the menu, as the ☰ button's click; anywhere else on the frame or on the caption
 * nothing, so neither ever takes the keyboard from the box that has it. Any other pane's as tmux
 * does it (its default MouseDown1Pane). Server-wide, as every binding is.
 */
const MENU_CLICK = `#{&&:#{==:#{${ROLE}},frame},#{&&:#{e|==:#{mouse_y},#{e|-:#{pane_height},1}},#{&&:#{e|>=:#{${MENU_AT}},1},#{e|>=:#{mouse_x},#{${MENU_AT}}}}}}`;
const OURS = `#{&&:#{${VIEW}},#{||:#{==:#{${ROLE}},frame},#{||:#{==:#{${ROLE}},caption},#{==:#{pane_title},${CAPTION_TITLE}}}}}`;
export const clickKey = () => [
  "bind-key",
  "-n",
  "MouseDown1Pane",
  "if-shell",
  "-F",
  "-t",
  "=",
  `#{&&:#{${VIEW}},${MENU_CLICK}}`,
  `run-shell -C '#{${MENU}}'`,
  `if-shell -F -t = "${OURS}" "" "select-pane -t = ; send-keys -M"`,
];

/**
 * Tab in the classic look (the menus' "focus"): from the list to the stage, from anywhere else to
 * the list, by role (`P:` runs over the window's panes: the stage is the one that's neither the
 * list, the frame nor the caption; zoomed, tmux says no pane floats, so not by that); the frame and
 * the caption never keep the keyboard. Selecting a pane unzooms the window (settings), as in the
 * tiled look, whose Tab is tmux's next pane: there are only the two.
 */
const LIST_ID = `#{P:#{?#{==:#{${ROLE}},list},#{pane_id},}}`;
const NOT_STAGE = `#{||:#{==:#{${ROLE}},list},#{||:#{==:#{${ROLE}},frame},#{||:#{==:#{${ROLE}},caption},#{==:#{pane_title},${CAPTION_TITLE}}}}}`;
const STAGE_ID = `#{P:#{?${NOT_STAGE},,#{pane_id}}}`;
export const focusRun = (classic: boolean): string[] => (classic ? ["run-shell", "-t", V, "-C", `select-pane -t '#{?#{==:#{${ROLE}},list},${STAGE_ID},${LIST_ID}}'`] : ["select-pane", "-t", `${V}.+`]);

// ── Selecting text ──
// tmux selects (its copy mode) when you drag over a pane, but only one whose program doesn't ask
// for the mouse; one that does gets the drag (tmux's own MouseDrag1Pane: `send-keys -M` when
// mouse_any_flag). A viewer (./viewer-pane.ts) asks for it, for the wheel, and does nothing with a
// drag: so its text, your conversation with Kiko or a session's, couldn't be selected. Here a
// viewer's pane (ROLE) is taken as one that doesn't ask, for a drag, a double click and a triple
// click: a drag selects, letting go copies it (tmux.conf's MouseDragEnd1Pane) and leaves copy
// mode, so the view is live again; a double click a word, a triple one the line, copied at once,
// as tmux does them. The wheel and single clicks still reach the viewer. Every other pane exactly
// as tmux's own bindings do it (these are theirs, but for the role): a session's program (Claude
// Code…) gets the mouse when it asks for it. Server-wide, as every binding is; set again each time
// the window opens (openNow), so a window made by an older version gets them too.

/** The mouse goes to the pane's program (as tmux's own bindings decide), but never a viewer's. */
const MOUSE_TO_PROGRAM = `#{||:#{pane_in_mode},#{&&:#{mouse_any_flag},#{!=:#{${ROLE}},viewer}}}`;

/**
 * What copies a selection in copy mode when its binding names no command (a double or triple
 * click's, tmux's own): the Mac's clipboard, as tmux.conf's drags do. Not every terminal takes
 * tmux's copy (set-clipboard, OSC 52), so this is the one sure way. Kiko's own server only: also in
 * tmux.conf, here for a server started with an older one.
 */
const COPY_COMMAND = "pbcopy";

/** The drag, the double click and the triple click (see above), and what copies them (COPY_COMMAND). */
export function selectKeys(): string[][] {
  const click = (key: string, select: string) => [
    "bind-key",
    "-n",
    key,
    "if-shell",
    "-F",
    "-t",
    "=",
    MOUSE_TO_PROGRAM,
    commandString([
      ["select-pane", "-t", "="],
      ["send-keys", "-M"],
    ]),
    commandString([
      ["select-pane", "-t", "="],
      ["copy-mode", "-H"],
      ["send-keys", "-X", select],
      ["run-shell", "-d", "0.3"],
      ["send-keys", "-X", "copy-pipe-and-cancel"],
    ]),
  ];
  return [
    ["set-option", "-s", "copy-command", COPY_COMMAND],
    ["bind-key", "-n", "MouseDrag1Pane", "if-shell", "-F", "-t", "=", MOUSE_TO_PROGRAM, "send-keys -M", "copy-mode -M"],
    click("DoubleClick1Pane", "select-word"),
    click("TripleClick1Pane", "select-line"),
  ];
}

/** Bindings an older Kiko window made, gone (F1 moved the keyboard before the Kiko key's menu). */
const OLD_KEYS = [["unbind-key", "-q", "-n", "F1"]];

// ── Telling the app ──
// The menus' items run tmux commands; what only the app can do (show a session, open settings)
// goes to it as input to the list's pane: an APC string (ESC _ … ESC \) with a token of this run's
// own, which no key, click or paste of yours makes, and which the app takes out of its input
// before anything else reads it (src/ui/input.ts). Sent with `send-keys -H` (its bytes in hex):
// nothing in it is ever read by tmux's parser or as a format.

/** What starts every ask: `ESC _ kiko;<token>;<verb>;<arg> ESC \` (SLUG first). */
const ASK_PREFIX = `\x1b_${SLUG};`;
const ASK_END = "\x1b\\";

/** An ask's bytes: token, verb and arg only letters, digits, "-", "_", "." and ":" (a page's ID); anything else is dropped. */
export function askBytes(token: string, verb: string, arg = "") {
  const safe = (w: string) => w.replace(/[^A-Za-z0-9._:-]/g, "");
  return `${ASK_PREFIX}${safe(token)};${safe(verb)};${safe(arg)}${ASK_END}`;
}

/** The command that asks the app in `list` (its pane) for `verb`. */
export const askApp = (list: string, token: string, verb: string, arg = "") => [
  "send-keys",
  "-t",
  list,
  "-H",
  ...[...Buffer.from(askBytes(token, verb, arg))].map((b) => b.toString(16).padStart(2, "0")),
];

// ── Menus ──
// Drawn in a popup by ./menu-popup.ts (src/ui/menu-view.ts says why not tmux's display-menu): the app
// keeps each menu in a window option as JSON, the popup's program reads it, draws it, and runs the
// picked item's commands. The Kiko key's popup command sits in MENU, for its binding to run.

/** Window: the Kiko key's menu (src/ui/menu-view.ts MenuData, as JSON), the right-click one shown last, and a question the app asks (showQuestion). */
export const MENU_DATA = appOption("menu-data");
const ROW_MENU_DATA = appOption("row-menu");
export const QUESTION_DATA = appOption("question");
export const MENU_PROGRAM = fileURLToPath(new URL("./menu-popup.ts", import.meta.url));

/** A command list as one string for tmux's parser: every word single-quoted (tmuxQuoted), commands joined by " ; ". */
const commandString = (commands: string[][]) => commands.map((c) => c.map(tmuxQuoted).join(" ")).join(" ; ");

/**
 * The popups' look: the terminal's own background and text (`terminal`; tmux 3.8 draws a popup's
 * "default" in its theme's dark grey), a thin rounded border in the palette's blue, the title bold
 * in it. Only palette colours, so it reads in a dark theme and a light one (src/ui/menu-view.ts
 * draws the inside the same way). Window options of the view, set apart from the rest of its look
 * (popupLook): a tmux without `terminal` refuses them, and keeps its own (the terminal's colours, before themes).
 */
export const POPUP_STYLE = "bg=terminal,fg=terminal";
export const POPUP_BORDER_STYLE = "bg=terminal,fg=blue";

/** Sets the popups' look on the view; nothing when this tmux refuses it (see POPUP_STYLE). */
const popupLook = (tmux: Tmux) => tmux(together(["set-option", "-w", "-t", V, "popup-style", POPUP_STYLE], ["set-option", "-w", "-t", V, "popup-border-style", POPUP_BORDER_STYLE])).catch(() => "");

/**
 * The display-popup command (argv) that shows the menu kept in `option`: its size from the menu,
 * rounded (its colours: popupLook), `title` on its border, bold (a tmux format: literal() for
 * any text in it). `x`, `y`: where (tmux's: a number puts the popup's bottom edge on that line),
 * else the middle. Its program's command line: Node, the script, tmux's path and the option's name.
 */
export function menuPopup(menu: MenuData, option: string, where: { x?: string; y?: string; client?: string; title?: string } = {}): string[] {
  const size = menuSize(menu);
  return [
    "display-popup",
    "-E",
    ...(where.client ? ["-c", where.client] : []),
    "-b",
    "rounded",
    "-T",
    `#[bold]${where.title ?? menu.title}`,
    "-w",
    String(size.width + 2),
    "-h",
    String(size.height + 2),
    "-x",
    where.x ?? "C",
    "-y",
    where.y ?? "C",
    "--",
    ...[...programArgv("menu"), tmuxPath() ?? "tmux", option].map(tmuxArg),
  ];
}

/**
 * Tab's words in the menus (here and src/ui/nav.ts COMMANDS): where it takes the keyboard from the
 * side that has it as the menu opens (menu-popup.ts asks tmux), FOCUS_LABEL when that can't be told.
 */
export const FOCUS_LABELS = { list: "Go to the session →", stage: "Go to the list ←" } as const;
export const FOCUS_LABEL = "Switch list ⇄ session";

/** The menu before the app has made one: what tmux does on its own. The Kiko key (`key`) again closes it. */
export function startingMenu(key = DEFAULT_KEY, classic = false): MenuData {
  return {
    title: ` ${OWN.title} `,
    again: { input: keySequences(key) },
    items: [
      { label: `${OWN.title} is starting…`, tone: "dim" },
      "-",
      { label: FOCUS_LABEL, byFocus: FOCUS_LABELS, key: "Tab", input: ["\t"], run: [classic ? focusRun(true) : ["select-pane", "-t", ":.+"]] },
      { label: "Hide window (keeps listening)", key: "d", input: ["d"], run: [["detach-client"]] },
      "-",
      { label: "↑↓ move · ⏎ pick · Esc closes", tone: "dim" },
    ],
  };
}

/** The lines that keep `menu` as the Kiko key's: its JSON, and the popup command its binding runs (MENU). */
const menuLines = (menu: MenuData) => [
  `set-option -w -t ${V} ${MENU_DATA} ${tmuxQuoted(JSON.stringify(menu))}`,
  `set-option -w -t ${V} ${MENU} ${tmuxQuoted(commandString([menuPopup(menu, MENU_DATA, { title: `#[align=centre]${menu.title}` })]))}`,
];

/** Keeps the menu the Kiko key shows, over stdin as the bar is: its text never on a command line. */
export const setMenu = (tmux: Tmux, menu: MenuData) => tmux(["source-file", "-"], `${menuLines(menu).join("\n")}\n`);

/** Shows `menu` (a session's right-click one) on `client` (a terminal showing the window: latestClient), at `x`, `y`. */
export async function showMenu(tmux: Tmux, menu: MenuData, client: string, at: { x: number; y: number }, title: string) {
  await tmux(["source-file", "-"], `set-option -w -t ${V} ${ROW_MENU_DATA} ${tmuxQuoted(JSON.stringify(menu))}\n`);
  await tmux(menuPopup(menu, ROW_MENU_DATA, { client, x: String(at.x), y: String(at.y), title }));
}

/**
 * Shows `menu` as a question of the app's own (a key clash: clash.ts clashQuestion) on `client`, in
 * the middle of the window, drawn and answered as the menus are. Nothing waits on it: the popup's
 * program tells the app the answer, and Escape closes it.
 */
export async function showQuestion(tmux: Tmux, menu: MenuData, client: string) {
  await tmux(["source-file", "-"], `set-option -w -t ${V} ${QUESTION_DATA} ${tmuxQuoted(JSON.stringify(menu))}\n`);
  await tmux(menuPopup(menu, QUESTION_DATA, { client, title: `#[align=centre]${menu.title}` }));
}

/**
 * The terminal that used the window last (its tty), for a menu the app shows itself; null when none
 * shows it. `newest`: the one attached last instead (the terminal a `kiko` just ran in: a key
 * clash's question); `since` (ms), only one attached then or after (tmux keeps it to the second).
 */
export async function latestClient(tmux: Tmux, newest = false, since = 0): Promise<string | null> {
  const out = await tmux(["list-clients", "-t", S, "-F", `#{${newest ? "client_created" : "client_activity"}}\t#{client_name}`]).catch(() => "");
  const rows = out
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((r) => r.length === 2 && r[1] && (!since || Number(r[0]) >= Math.floor(since / 1000)));
  rows.sort((a, b) => Number(b[0]) - Number(a[0]));
  return rows[0]?.[1] ?? null;
}

/** A pane's top left corner in the window (a menu goes where the click was). */
export async function paneCorner(tmux: Tmux, pane: string): Promise<{ left: number; top: number }> {
  const [left, top] = (await tmux(["display", "-p", "-t", pane, "#{pane_left} #{pane_top}"])).trim().split(" ").map(Number);
  return { left: left || 0, top: top || 0 };
}

export type Size = { width: number; height: number };

/**
 * The commands that make the window, as one run so two `kiko`s at once can't both make it (the
 * second's new-session fails: "duplicate session"): the placeholder first (the stage), then the
 * list to its left running `app`, focused. `whole`: the list's pane zoomed to the whole window in
 * the same run (the splash's, or setup's: ui/splash.ts wholeFirst), before any terminal attaches.
 */
export function createCommands(app: string[], appCwd: string, size?: Size, key = DEFAULT_KEY, classic = false, whole = false): string[] {
  const made = classic ? classicCommands(app, appCwd, size, key) : tiledCommands(app, appCwd, size, key);
  // Last, with the list the active pane (V): zoomed as it's made, so no terminal ever draws the two panes first.
  return whole ? together(made, ["resize-pane", "-Z", "-t", V]) : made;
}

/** The tiled look's window (createCommands). */
function tiledCommands(app: string[], appCwd: string, size: Size | undefined, key: string): string[] {
  const dims = size ? ["-x", String(size.width), "-y", String(size.height)] : [];
  return together(
    ["new-session", "-d", "-s", WINDOW, "-n", OWN.slug, "-c", tmuxFormatArg(appCwd), ...dims, "--", ...placeholderCommand()],
    setPane(V, ROLE, "placeholder"),
    // Starting from the first: the placeholder says so until the app is ready (start.ts, setStarting).
    setPane(V, LABEL, STARTING_LABEL),
    ["set-option", "-w", "-t", V, STARTING, STARTED_ONLY],
    ["split-window", "-hb", "-l", String(listWidth(size?.width ?? 100)), "-t", V, "-c", tmuxFormatArg(appCwd), "--", ...app.map(tmuxArg)],
    setPane(V, ROLE, "list"),
    setPane(V, LABEL, OWN.title),
    ...viewOptions(),
    ...barOptions(),
    ["set-option", "-w", "-t", V, MENU_DATA, JSON.stringify(startingMenu(key))],
    ["set-option", "-w", "-t", V, MENU, commandString([menuPopup(startingMenu(key), MENU_DATA, { title: `#[align=centre]${startingMenu(key).title}` })])],
    ...keys(key),
    ...keyOptions(key),
    ...herdrGone(),
  );
}

/** tmux's default size for a window made with none (default-size). */
const DEFAULT_SIZE: Size = { width: 80, height: 24 };

/**
 * The classic look's window (./classic.ts), in one run as the tiled one is: the frame first (the
 * window's one tiled pane, under everything), then the stage's placeholder and the list as boxes
 * over it, each made the active pane as it comes (so its options can be set on it), the list last
 * (focused). Sized for `size` until a terminal attaches; the frame puts them right then.
 */
function classicCommands(app: string[], appCwd: string, size: Size | undefined, key: string): string[] {
  const dims = size ? ["-x", String(size.width), "-y", String(size.height)] : [];
  const { width, height } = size ?? DEFAULT_SIZE;
  const b = boxes(width, height);
  const menu = startingMenu(key, true);
  const cwd = ["-c", tmuxFormatArg(appCwd)];
  return together(
    ["new-session", "-d", "-s", WINDOW, "-n", OWN.slug, ...cwd, ...dims, "--", ...frameCommand()],
    setPane(V, ROLE, "frame"),
    ["set-option", "-w", "-t", V, STARTING, STARTED_ONLY],
    floatPane(b.stage, placeholderCommand(), cwd),
    setPane(V, ROLE, "placeholder"),
    setPane(V, LABEL, STARTING_LABEL),
    floatPane(b.list, app.map(tmuxArg), cwd),
    setPane(V, ROLE, "list"),
    setPane(V, LABEL, OWN.title),
    ...viewOptions(true),
    ...barOptions(undefined, true),
    ["set-option", "-w", "-t", V, MENU_DATA, JSON.stringify(menu)],
    ["set-option", "-w", "-t", V, MENU, commandString([menuPopup(menu, MENU_DATA, { title: `#[align=centre]${menu.title}` })])],
    ...keys(key, true),
    ...keyOptions(key),
    ...herdrGone(),
  );
}

/**
 * The window's keys: the Kiko key's menu, the ☰ button's, the list's width kept as dragged; in
 * the classic look the clicks on its frame (clickKey); a viewer's text selected (selectKeys);
 * older ones gone.
 */
const keys = (key = DEFAULT_KEY, classic = false) => [menuKey(key), buttonKey(), ...(classic ? [...dragKeys(), clickKey()] : [dragKey()]), ...selectKeys(), ...OLD_KEYS];

/** The options that say which key is the Kiko key now (KEY_OPTION…), server-wide. */
const keyOptions = (key: string, by = "default") => [
  ["set-option", "-g", KEY_OPTION, tmuxArg(key)],
  ["set-option", "-g", KEY_NAME_OPTION, tmuxArg(keySymbol(key))],
  ["set-option", "-g", KEY_BY_OPTION, by],
];

/**
 * herdr's variables out of the server's global environment (herdr.ts): a server never gets them
 * from Kiko (tmux.ts cleanEnv), but one started some other way might have.
 */
const herdrGone = () => HERDR_VARS.map((name) => ["set-environment", "-g", "-u", name]);

/** What the server says the Kiko key is now (KEY_OPTION): null for none (a window made before the key could change: Ctrl+Space). */
export async function boundKey(tmux: Tmux): Promise<string | null> {
  return (await keyOption(tmux, KEY_OPTION)) || null;
}

/**
 * One of the key's server options, "" when it isn't set or no server runs yet. tmux not answering
 * (a timeout) throws: read as "", it rebound the Kiko key to the default, the one you'd set left bound.
 */
async function keyOption(tmux: Tmux, option: string): Promise<string> {
  try {
    return (await tmux(["show-options", "-gqv", option])).trim();
  } catch (err) {
    if (noServer(err)) return "";
    throw err;
  }
}

/**
 * Makes `key` the Kiko key (tmux's name for it; `by`: what decided it): the one bound before
 * (KEY_OPTION) unbound when it was another, `key` bound, the options that name it set. The
 * starting menu's key with it. Server-wide: the last `kiko` (or the settings) decides.
 */
export async function bindKey(tmux: Tmux, key: string, by = "default"): Promise<void> {
  const before = (await boundKey(tmux)) ?? DEFAULT_KEY;
  const unbind = before !== key ? [["unbind-key", "-q", "-n", tmuxArg(before)]] : [];
  await tmux(together(...unbind, menuKey(key), ...keyOptions(key, by)));
}

/** The notes for the app to tell you once (Note), kept on the server; none: what was there goes. */
export async function setNotes(tmux: Tmux, notes: readonly Note[]): Promise<void> {
  if (notes.length) await tmux(["source-file", "-"], `set-option -g ${NOTES_OPTION} ${tmuxQuoted(JSON.stringify(notes))}\n`);
  else await tmux(["set-option", "-g", "-u", NOTES_OPTION]).catch(() => "");
}

/** What `kiko` says the window should have: the Kiko key and what decided it, and notes for the app. */
export type WindowKey = { key: string; by: string; notes?: Note[] };

export type Opened = "created" | "restarted" | "open";

// ── One change at a time ──
// Every change to the window's layout (show, view, tidy, closing a session or the window, making
// it) reads the layout and then acts on it: two at once (two quick clicks, a click and a session
// opened by voice) acted on the same reading, and could leave a live session in another's home,
// where a respawn of that home (DIED_HOOK, tidy) would kill it. So they take turns, in the order
// asked, within this process (the app; `kiko` is a process of its own, and the home checks
// below guard against what it does meanwhile).
let turn: Promise<unknown> = Promise.resolve();

/** `step` once every change asked for before it is done (whether it worked or not). */
export function inOrder<T>(step: () => Promise<T>): Promise<T> {
  const run = turn.then(step, step);
  turn = run.catch(() => {});
  return run;
}

/**
 * The window, made if it isn't there, with its list running the app (`app()`: a fresh launch each
 * time, discarded when tmux doesn't run it). A list whose app ended is started again. The stage is
 * put right (tidy). `whole`: a window made now has its list's pane zoomed to the whole window from
 * the start (createCommands), for the splash or setup about to take it (ui/splash.ts wholeFirst); one that's
 * there already is left as it is.
 */
export const openWindow = (tmux: Tmux, app: () => Launch, appCwd: string, size?: Size, key?: WindowKey, whole = false): Promise<Opened> => inOrder(() => openNow(tmux, app, appCwd, size, key, whole));

async function openNow(tmux: Tmux, app: () => Launch, appCwd: string, size?: Size, wanted?: WindowKey, whole = false): Promise<Opened> {
  let layout = await describe(tmux);
  // The key: as `kiko` says, else the one bound already (a session opened by voice), else the default.
  const key = wanted?.key ?? (await boundKey(tmux)) ?? DEFAULT_KEY;
  // The classic look where this tmux has floating panes (./classic.ts; asked once).
  const classic = await classicLook(tmux);
  if (!layout.view) {
    const launch = app();
    try {
      await tmux(createCommands(launch.argv, appCwd, size, key, classic, whole));
      // The server is running now (this may have started it): what decided the key, and what to tell you.
      if (wanted) await tmux(together(...keyOptions(key, wanted.by)));
      if (wanted) await setNotes(tmux, wanted.notes ?? []).catch(() => "");
      await popupLook(tmux);
      return "created";
    } catch (err) {
      launch.discard();
      if (!/duplicate session/i.test(err instanceof Error ? err.message : String(err))) throw err;
      // Another `kiko` made it a moment ago: give it a moment to finish.
      for (let i = 0; i < 20 && !(layout = await describe(tmux)).view?.list; i++) await new Promise((r) => setTimeout(r, 100));
      if (!layout.view) throw new Error(`a tmux session named ${WINDOW} is there, but it isn't the ${OWN.title} window`);
    }
  }
  // A tiled window where this tmux can float its panes (made by an older Kiko, or before tmux
  // was updated): made over in the classic look, every pane and process as it is. A classic one
  // stays classic (KIKO_LOOK=tiled is for windows made from now on).
  let view = layout.view!;
  if (classic && view.look !== "classic" && !view.frame) {
    await toClassic(tmux, view);
    view = (await describe(tmux)).view ?? view;
  }
  const look = classic || view.look === "classic";
  // Its look and keys as this version has them (a window made by an older one, say); the bar's text kept.
  await bindKey(tmux, key, wanted?.by ?? ((await keyOption(tmux, KEY_BY_OPTION)) || "default"));
  if (wanted) await setNotes(tmux, wanted.notes ?? []).catch(() => "");
  await tmux(together(...keys(key, look).slice(1), ...viewOptions(look), ...barOptions(undefined, look).filter((c) => c[3] !== BAR), ...herdrGone()));
  await popupLook(tmux);
  let opened: Opened = "open";
  const list = view.list;
  if (!list || list.dead) {
    const launch = app();
    try {
      if (list) await tmux(["respawn-pane", "-k", "-t", list.id, "-c", tmuxFormatArg(appCwd), "--", ...launch.argv.map(tmuxArg)]);
      else {
        // Its pane was closed: a new one on the left (in the classic look, its box).
        const made = ["-d", "-c", tmuxFormatArg(appCwd), "-P", "-F", "#{pane_id}"];
        const id = (
          await tmux(
            look
              ? floatPane(boxes(view.width, view.height, view.listWidth).list, launch.argv.map(tmuxArg), made)
              : ["split-window", "-hb", "-l", String(listWidth(view.width, view.listWidth)), "-t", V, ...made, "--", ...launch.argv.map(tmuxArg)],
          )
        ).trim();
        await tmux(together(setPane(id, ROLE, "list"), setPane(id, LABEL, OWN.title), ["select-pane", "-t", id]));
      }
      opened = "restarted";
    } catch (err) {
      launch.discard();
      throw err;
    }
  }
  await tidyNow(tmux);
  if (look) await placeNow(tmux).catch(() => "");
  return opened;
}

/**
 * A tiled window made over in the classic look (./classic.ts), its panes and their processes as they
 * are: the frame comes in across the window and takes its role in the same run (made the active
 * pane for it, so no look at the window ever finds a pane of no role there but a session), then the
 * list and the stage are lifted out of the tiling as boxes over it (break-pane -W: the same panes),
 * and the keyboard goes back where it was. Unzoomed first: a zoomed window can't. Put in place after.
 */
async function toClassic(tmux: Tmux, view: View): Promise<void> {
  if (view.zoomed && view.list) await tmux(["resize-pane", "-Z", "-t", view.list.id]).catch(() => "");
  const panes = [view.list, view.stage].filter((p): p is WPane => Boolean(p));
  const back = panes.find((p) => p.active) ?? view.list;
  await tmux(
    together(
      ["split-window", "-f", "-v", "-l", "3", "-t", V, "--", ...frameCommand()],
      setPane(V, ROLE, "frame"),
      ...panes.map((p) => ["break-pane", "-W", "-d", "-s", p.id]),
      back ? ["select-pane", "-t", back.id] : [],
    ),
  );
}

/** A floating pane in the view, in `box`, running `command`; `more`: new-pane's other flags. */
function floatPane(box: Box, command: string[], more: string[] = []): string[] {
  return ["new-pane", "-t", V, "-B", "single", ...geometry(box), ...more, "--", ...command];
}

/** A new placeholder in the stage, right of the list (in the classic look, in the stage's box). */
async function newStage(tmux: Tmux, view: View): Promise<string> {
  const at = view.list?.id ?? V;
  const made = ["-d", "-P", "-F", "#{pane_id}"];
  const id = (
    await tmux(
      view.look === "classic" ? floatPane(boxes(view.width, view.height, view.listWidth).stage, placeholderCommand(), made) : ["split-window", "-h", "-t", at, ...made, "--", ...placeholderCommand()],
    )
  ).trim();
  await tmux(together(setPane(id, ROLE, "placeholder"), setPane(id, LABEL, "no session")));
  if (view.list && view.look !== "classic") await tmux(["resize-pane", "-t", view.list.id, "-x", String(listWidth(view.width, view.listWidth))]).catch(() => "");
  return id;
}

/**
 * The classic look's boxes where they go for the window's size now (./classic.ts boxes): the frame
 * does it as the window resizes (./frame-pane.ts), the app once settings give the window back. Nothing
 * while zoomed (resizing would unzoom it), nor in the tiled look.
 */
export const place = (tmux: Tmux): Promise<void> => placeNow(tmux);

async function placeNow(tmux: Tmux): Promise<void> {
  const { view } = await describe(tmux);
  if (!view || view.look !== "classic" || view.zoomed || !view.width || !view.height) return;
  const caption = view.caption && !view.caption.dead ? { id: view.caption.id, lines: view.caption.height } : null;
  const commands = placeCommands({ list: view.list?.id, stage: view.stage?.id, caption }, view.width, view.height, view.listWidth);
  if (commands.length) await tmux(together(...commands));
}

// ── The caption (classic look): your words while you dictate ──

/**
 * The caption's box over the window, for `lines` lines of words: a floating pane made without the
 * keyboard (-d, and never selected: clickKey), its border red, running the frame's program in its
 * caption mode, which gets the words from the app. Known for a caption by its title from the moment
 * it's made (CAPTION_TITLE), its role set after. The one there already, if there is one. null: no
 * classic window to show it in (or zoomed: settings).
 */
export async function openCaption(tmux: Tmux, lines: number): Promise<string | null> {
  const { view } = await describe(tmux);
  if (!view || view.look !== "classic" || view.zoomed || !view.width || !view.height) return null;
  if (view.caption && !view.caption.dead) return view.caption.id;
  const border = `fg=${CAPTION_BORDER}`;
  const box = captionBox(view.width, view.height, lines);
  const id = (await tmux(floatPane(box, frameCommand(true), ["-d", "-T", CAPTION_TITLE, "-S", border, "-R", border, "-P", "-F", "#{pane_id}"]))).trim();
  await tmux(setPane(id, ROLE, "caption")).catch(() => "");
  return id;
}

/** The caption (its pane) sized for `lines` lines in a window this size. */
export const sizeCaption = (tmux: Tmux, pane: string, size: Size, lines: number) => tmux(together(...captionCommands(pane, captionBox(size.width, size.height, lines))));

/** The caption gone (you let go); nothing when it's gone already. */
export const closeCaption = (tmux: Tmux, pane: string): Promise<void> =>
  tmux(["kill-pane", "-t", pane]).then(
    () => {},
    () => {},
  );

/**
 * The stage put right, for what DIED_HOOK couldn't do: an ended session whose home is gone is
 * closed, a placeholder (or a viewer) that ended starts again as a placeholder, and an empty stage
 * gets a placeholder.
 */
export const tidy = (tmux: Tmux): Promise<void> => inOrder(() => tidyNow(tmux));

async function tidyNow(tmux: Tmux): Promise<void> {
  const layout = await describe(tmux);
  const view = layout.view;
  if (!view) return;
  // The classic look's frame started again if it ended; a caption that ended, gone.
  if (view.frame?.dead) await tmux(["respawn-pane", "-k", "-t", view.frame.id, "--", ...frameCommand()]).catch(() => "");
  if (view.caption?.dead) await closeCaption(tmux, view.caption.id);
  const stage = view.stage;
  if (stage?.dead) {
    if (stage.role === "placeholder" || stage.role === "viewer") {
      await tmux(together(...asPlaceholder(stage.id)));
      return;
    }
    const home = homeOf(layout, stage);
    await tmux(home ? together(["respawn-pane", "-k", "-t", home.id], ["swap-pane", "-d", "-s", stage.id, "-t", home.id], ["kill-pane", "-t", stage.id]) : ["kill-pane", "-t", stage.id]);
    if (home) return;
  } else if (stage) return;
  await newStage(tmux, view);
}

/**
 * The placeholder in `pane`'s home window (there while `pane` is shown): null when that window is
 * gone, or holds anything else. Never a session's pane: what's done to a home (respawned, swapped
 * back) would end or misplace it.
 */
function homeOf(layout: Layout, pane: WPane): WPane | null {
  return (pane.home && layout.panes.find((p) => p.window === pane.home && p.id !== pane.id && !p.inView && p.role === "placeholder" && !p.dead)) || null;
}

/**
 * The command that sends the stage's session home, and the pane that comes from there to the
 * stage (the placeholder). A home that's gone (its tmux session killed) is made again first: a
 * tmux session of the session's name with a placeholder in it.
 */
async function sendHome(tmux: Tmux, layout: Layout, stage: WPane): Promise<{ command: string[]; back: string }> {
  let home = homeOf(layout, stage)?.id;
  if (!home) {
    const names = new Set(layout.panes.map((p) => p.session));
    const name = freeName(stage.name.replace(/[^A-Za-z0-9_-]+/g, "-") || "session", [...names]);
    home = (await tmux(["new-session", "-d", "-s", name, "-c", tmuxFormatArg(stage.cwd || "/"), "-P", "-F", "#{pane_id}", "--", ...placeholderCommand()])).trim();
    const window = (await tmux(["display", "-p", "-t", home, "#{window_id}"])).trim();
    await tmux(together(setPane(home, ROLE, "placeholder"), setPane(home, LABEL, "no session"), setPane(stage.id, HOME, window)));
  }
  return { command: ["swap-pane", "-d", "-s", stage.id, "-t", home], back: home };
}

export type Shown = "shown" | "already" | "gone" | "no window" | "not a session";

/**
 * Shows the session in `pane` in the window's stage, and (`focus`) moves the keyboard there. The
 * one shown before goes home; the placeholder that comes back from there (or the viewer that was
 * in the stage, made a placeholder) goes to `pane`'s home.
 */
export const show = (tmux: Tmux, pane: string, focus = true): Promise<Shown> => inOrder(() => showNow(tmux, pane, focus));

async function showNow(tmux: Tmux, pane: string, focus: boolean): Promise<Shown> {
  await tidyNow(tmux);
  const layout = await describe(tmux);
  const view = layout.view;
  if (!view) return "no window";
  const target = layout.panes.find((p) => p.id === pane);
  if (!target || target.dead) return "gone";
  if (target.role) return "not a session";
  const select = focus ? [["select-pane", "-t", pane]] : [];
  if (target.inView) {
    if (select.length) await tmux(together(...select));
    return "already";
  }
  let home: string[] = [];
  let spot: string;
  const stage = view.stage;
  if (stage && !stage.role) {
    const sent = await sendHome(tmux, layout, stage);
    home = sent.command;
    spot = sent.back;
  } else spot = stage?.id ?? (await newStage(tmux, view));
  await tmux(
    together(
      home,
      setPane(pane, HOME, target.window),
      target.name ? [] : setPane(pane, LABEL, label(target.session)),
      ["swap-pane", "-d", "-s", pane, "-t", spot],
      ...asPlaceholder(spot), // it's in `pane`'s home now: says so
      ...select,
    ),
  );
  return "shown";
}

/**
 * What `view` shows: an outside session's page (sessionPage), its transcript, its name, where it
 * runs (`place`, "in Ghostty": on the border after the name), and the viewer's header
 * (VIEWER_INFO's JSON); or (`page`) Kiko's own page, PAGE_ID, from the file the app keeps.
 */
export type Viewed = { id: string; path: string; name: string; info: string; place?: string; page?: boolean };

/** A viewer's PLACE set to `place`, or taken off (Kiko's page, none). */
const placeOf = (pane: string, place?: string) => (place ? setPane(pane, PLACE, label(place)) : ["set-option", "-p", "-u", "-t", pane, PLACE]);

/**
 * Shows an outside session's conversation in the stage, read-only: a viewer (./viewer-pane.ts) in the
 * stage's spot, and (`focus`) the keyboard there, for scrolling. The session shown before goes
 * home first, as for `show`; a placeholder or another viewer in the stage becomes this one.
 * `onlyIfEmpty`: only over a placeholder ("busy" when the stage shows anything else by now: the
 * app's page put in an empty stage never pushes out what was shown meanwhile).
 */
export const view = (tmux: Tmux, it: Viewed, focus = true, onlyIfEmpty = false): Promise<"shown" | "already" | "no window" | "busy"> => inOrder(() => viewNow(tmux, it, focus, onlyIfEmpty));

async function viewNow(tmux: Tmux, it: Viewed, focus: boolean, onlyIfEmpty: boolean): Promise<"shown" | "already" | "no window" | "busy"> {
  await tidyNow(tmux);
  const layout = await describe(tmux);
  const view = layout.view;
  if (!view) return "no window";
  if (onlyIfEmpty && view.stage && view.stage.role !== "placeholder") return "busy";
  const select = (pane: string) => (focus ? ["select-pane", "-t", pane] : []);
  const stage = view.stage;
  if (stage?.role === "viewer" && stage.viewing === it.id && !stage.dead) {
    await tmux(together(setPane(stage.id, VIEWER_INFO, it.info), placeOf(stage.id, it.place), select(stage.id)));
    return "already";
  }
  let home: string[] = [];
  let spot: string;
  if (stage && !stage.role) {
    const sent = await sendHome(tmux, layout, stage);
    home = sent.command;
    spot = sent.back;
  } else spot = stage?.id ?? (await newStage(tmux, view));
  await tmux(
    together(
      home,
      setPane(spot, ROLE, "viewer"),
      setPane(spot, LABEL, label(it.name)),
      setPane(spot, VIEWING, it.id),
      setPane(spot, VIEWER_INFO, it.info),
      placeOf(spot, it.place),
      ["set-option", "-p", "-u", "-t", spot, MARK], // the classic look's title: the app gives it the session's mark
      ["respawn-pane", "-k", "-t", spot, "--", ...viewerCommand(it.path, it.page)],
      select(spot),
    ),
  );
  return "shown";
}

/**
 * Ends a session of Kiko's tmux (its pane `pane`): shown, it goes home first (the stage gets the
 * placeholder back), then its own tmux session is killed, and the program in it with it. Never one
 * of the window's own panes, nor anything in the window's tmux session.
 */
export const closeSession = (tmux: Tmux, pane: string): Promise<"closed" | "gone" | "not a session"> => inOrder(() => closeNow(tmux, pane));

async function closeNow(tmux: Tmux, pane: string): Promise<"closed" | "gone" | "not a session"> {
  const layout = await describe(tmux);
  const target = layout.panes.find((p) => p.id === pane);
  if (!target || target.dead) return "gone";
  if (target.role) return "not a session";
  // Its program may quit as this runs (Close's /exit, just taken): a pane that has been in the
  // window ends with it (index.ts afterProgram), taken out by DIED_HOOK in the stage or with its
  // tmux session at home. Then there's nothing left to close: "gone", never an error, never twice.
  const now = async () => (await describe(tmux)).panes.find((p) => p.id === pane);
  const gone = async () => {
    const it = await now();
    return !it || it.dead;
  };
  try {
    let session = target.session;
    if (target.inView) {
      await tmux((await sendHome(tmux, layout, target)).command);
      // One look: where it is now, if it's still there (two looks would race its end in between).
      const home = await now();
      if (!home || home.dead) return "gone";
      session = home.session;
    }
    if (!session || session === WINDOW) return "not a session";
    await tmux(["kill-session", "-t", tmuxArg(`=${session}`)]);
    return "closed";
  } catch (err) {
    if (await gone().catch(() => false)) return "gone";
    throw err;
  }
}

/** The keyboard to `pane` (the list, the stage). */
export const focus = (tmux: Tmux, pane: string) => tmux(["select-pane", "-t", pane]);

/** A terminal showing the window goes back to its shell; the window and the app go on. */
export const detach = (tmux: Tmux, client: string) => tmux(["detach-client", "-t", client]);

/** A viewer's header (VIEWER_INFO): the app keeps it to the session's state; the viewer reads it. */
export const setViewerInfo = (tmux: Tmux, pane: string, info: string) => tmux(setPane(pane, VIEWER_INFO, info));

/** Sets a viewer's PLACE (where the outside session it shows runs, "in Ghostty"); none takes it off. */
export const setPlace = (tmux: Tmux, pane: string, place?: string) => tmux(placeOf(pane, place));

/** Sets a session pane's name on its border (the app knows sessions' names better than tmux). */
export const setLabel = (tmux: Tmux, pane: string, name: string) => tmux(setPane(pane, LABEL, label(name)));

/**
 * A pane's agent mark for its box's title in the classic look (MARK): the glyph in its slot (two
 * cells and a space, as in the list: src/ui/marks.ts), in its agent's colour; null for none
 * (Kiko's page). The glyph as text, never a format; the colour only if it's one tmux reads (#rrggbb).
 */
export function markFormat(mark: { glyph: string; color?: string } | null): string {
  if (!mark) return "";
  const color = mark.color && /^#[0-9a-fA-F]{6}$/.test(mark.color) ? `#[fg=${mark.color}]` : "";
  return `${color}${mark.glyph.replace(/[#\u0000-\u001f\u007f]/g, (c) => (c === "#" ? "##" : ""))}  `;
}
/** Sets a pane's MARK (markFormat's). */
export const setMark = (tmux: Tmux, pane: string, mark: string) => tmux(setPane(pane, MARK, mark));

/**
 * The bottom line's text (a tmux format: see src/ui/bar.ts). It has your words in it, up to five
 * times a second while you talk: so as a tmux command read from stdin (`source-file -`), never on
 * a command line. One line, in single quotes (where tmux expands nothing: no $, ~, # or ;), a
 * quote as '\''; control characters (a line break would start a new command) as spaces.
 */
export const setBar = (tmux: Tmux, text: string) => tmux(["source-file", "-"], `set-option -t ${V} ${BAR} ${tmuxQuoted(text)}\n`);

/** `text` as one single-quoted word for tmux's command parser (a config line, source-file). */
const tmuxQuoted = (text: string) => `'${text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/'/g, `'\\''`)}'`;

/** Zooms `pane` to the whole window (on) or back (off); nothing when it already is. */
export async function zoom(tmux: Tmux, pane: string, on: boolean): Promise<void> {
  const zoomed = (await tmux(["display", "-p", "-t", pane, "#{window_zoomed_flag}"])).trim() === "1";
  if (zoomed !== on) await tmux(["resize-pane", "-Z", "-t", pane]);
}

/**
 * Closes the window: the session shown goes home first (it keeps running, as every session does),
 * then the window's tmux session ends, and every terminal showing it goes back to its shell. A
 * session still in the window then (its going home failed) would end with it: so the window stays,
 * and this throws why. After, a home left holding only a placeholder (nothing shown is away from
 * it any more) is closed too.
 */
export const closeWindow = (tmux: Tmux): Promise<void> => inOrder(() => closeWindowNow(tmux));

async function closeWindowNow(tmux: Tmux): Promise<void> {
  const layout = await describe(tmux);
  const stage = layout.view?.stage;
  if (!layout.view) return;
  let failed = "";
  if (stage && !stage.role && !stage.dead) {
    try {
      await tmux((await sendHome(tmux, layout, stage)).command);
    } catch (err) {
      failed = `: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const after = await describe(tmux);
  const kept = after.panes.find((p) => p.session === WINDOW && !p.role && !p.dead);
  if (kept) throw new Error(`${kept.name || kept.session} couldn't go back to its own tmux session, so the window stays open${failed}`);
  await tmux(["kill-session", "-t", S]);
  const sessions = new Map<string, WPane[]>();
  for (const p of after.panes) if (p.session !== WINDOW) sessions.set(p.session, [...(sessions.get(p.session) ?? []), p]);
  for (const [name, panes] of sessions) {
    if (panes.every((p) => p.role === "placeholder")) await tmux(["kill-session", "-t", tmuxArg(`=${name}`)]).catch(() => "");
  }
}
