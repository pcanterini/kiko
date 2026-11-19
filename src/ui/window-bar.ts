// The bottom line, the Kiko key's menu and the viewer's header, from the app's side of the Kiko
// window (src/ui/window-glue.ts): kept to the app's state together, each pushed to tmux only when it
// changed, the bottom line at most every BAR_EVERY_MS (tmux redraws the window for each). The classic
// look has no bottom line: the frame's line has it (window-classic.ts), drawn instead.
import { log } from "../core/log.ts";
import { findSession, idsOf, sessionName, type Session } from "../core/sessions.ts";
import { sessionStatus, ui, type UiState } from "../core/ui-store.ts";
import { NAME } from "../core/name.ts";
import * as win from "../terminals/tmux/window.ts";
import { menuKeyName } from "../terminals/tmux/keys.ts";
import { barText, barTicks, keyName } from "./bar.ts";
import { speakerOf } from "./marks.ts";
import { PAGE_ID, sessionOf, windowMenu, type Asker } from "./nav.ts";
import type { ViewerInfo, Where } from "./viewer.ts";
import type { WindowShared } from "./window-glue.ts";

/** Where a session outside Kiko's tmux runs, for its viewer's header and footer. */
export function whereOf(session: Session): Where {
  if (session.kind === "background") return "background";
  if (session.desktop) return "desktop";
  if (session.place?.via === "t3code") return "t3";
  return session.place?.via === "ghostty" ? "ghostty" : "elsewhere";
}

/** What Kiko said about it lately, kept for its viewer. */
const SPOKEN_KEPT = 8;

/** What Kiko is doing, for its page's header. */
export function doingOf(s: UiState): string {
  if (s.listening) return "listening";
  if (s.deciding) return "deciding";
  if (s.speaking) return s.muted ? "muted" : "speaking";
  if (s.checking) return "checking";
  return "ready";
}

/**
 * A viewer's header and Kiko's lines about the session (src/ui/viewer.ts), from the UI store,
 * for its page (a page's ID: nav.ts). A session no longer listed has ended: only that is said, the
 * viewer keeps the rest. Kiko's page: what it's doing.
 */
export function viewerInfo(s: UiState, page: string): Partial<ViewerInfo> {
  if (page === PAGE_ID) return { name: NAME, doing: doingOf(s), talk: s.about.pttMode === "tap" ? "space in the list to talk" : `hold ${keyName(s.about.hotkey)} to talk`, key: menuKeyName() };
  const sessionId = sessionOf(page);
  const session = sessionId ? findSession(s.sessions, sessionId) : undefined;
  if (!session) return s.sessionsLoaded ? { status: "ended" } : {};
  const ids = new Set(idsOf(session));
  const spoken = s.lines
    .filter((l) => l.kind === "spoken" && l.sessionId !== undefined && ids.has(l.sessionId))
    .slice(-SPOKEN_KEPT)
    .map((l) => ({ at: l.at, text: l.text.slice(0, 1000) }));
  return { name: sessionName(session), where: whereOf(session), status: sessionStatus(session, s), folder: session.cwd, spoken, key: menuKeyName(), agent: speakerOf(session) };
}

/** At most this often a new bottom line (tmux redraws the window for each), and a new menu. */
const BAR_EVERY_MS = 200;

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

export type WindowBar = {
  /** Pushes what changed soon: the bottom line at most every BAR_EVERY_MS, the menu and the viewer's header with it. */
  schedule(): void;
  /** The bottom line and the menu pushed at the next push even if unchanged (the window opened again, the Kiko key changed); `menu` false: the bottom line only. */
  forget(menu?: boolean): void;
  /** The app is quitting: nothing more pushed. */
  stop(): void;
};

/**
 * The bottom line, the menu and the viewer's header, for startWindow's shared handles. `ask`: how
 * the menu's items ask the app (only in the window's list; null: no menu). `scheduleFrame`: the
 * classic look's line, drawn in the bottom line's place.
 */
export function windowBar(w: WindowShared, ask: Asker | null, scheduleFrame: () => void): WindowBar {
  const { tmux } = w;
  let bar = "";
  let menu = "";
  let barTimer: NodeJS.Timeout | null = null;
  let lastBarAt = 0;

  function pushViewer() {
    const { viewing } = w;
    if (!viewing) return;
    const text = JSON.stringify(viewerInfo(ui.state, viewing.page));
    if (text === viewing.sent || text === "{}") return;
    viewing.sent = text;
    win.setViewerInfo(tmux, viewing.pane, text).catch((err) => log("window_failed", { what: "viewer", error: why(err) }));
  }
  function pushMenu() {
    if (!ask) return;
    const m = windowMenu(ui.state, ask);
    const text = JSON.stringify(m);
    if (text === menu) return;
    menu = text;
    win.setMenu(tmux, m).catch((err) => log("window_failed", { what: "menu", error: why(err) }));
  }
  function pushBar() {
    barTimer = null;
    if (!w.open) return;
    pushViewer();
    pushMenu();
    if (w.notice && Date.now() >= w.notice.until) w.notice = null;
    if (w.look === "classic") return scheduleFrame(); // no status line: the frame's line has it
    const text = barText(ui.state, Date.now(), w.notice?.text ?? "");
    if (text === bar) return;
    bar = text;
    lastBarAt = Date.now();
    win.setBar(tmux, text).catch((err) => log("window_failed", { what: "bar", error: why(err) }));
  }
  function scheduleBar() {
    if (barTimer || !w.open) return;
    barTimer = setTimeout(pushBar, Math.max(0, BAR_EVERY_MS - (Date.now() - lastBarAt)));
  }
  // A "→ pixie" goes after a moment, with nothing else changing.
  const ticker = setInterval(() => (barTicks(ui.state) || bar.includes("→") || (w.notice && Date.now() >= w.notice.until) ? scheduleBar() : undefined), 500);
  ticker.unref();

  return {
    schedule: scheduleBar,
    forget(alsoMenu = true) {
      bar = "";
      if (alsoMenu) menu = "";
    },
    stop() {
      if (barTimer) clearTimeout(barTimer);
      clearInterval(ticker);
    },
  };
}
