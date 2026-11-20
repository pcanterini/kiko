// The app's side of the Kiko window (src/terminals/tmux/window.ts): the bottom line kept to the
// app's state, sessions' names on their pane's border, and, when the app runs in the window's list
// pane (`kiko`), the rest: the Kiko key's menu kept to the app's state (src/ui/nav.ts), what its
// items ask (src/ui/input.ts), showing a page (a session; one outside Kiko's tmux as its
// conversation, read-only, in a viewer whose header this keeps to the session's state; Kiko's
// own page, the stage's usual sight), a session's right-click menu, and settings zoomed to the
// whole window and back.
//
// The Kiko key is whichever `kiko` bound last (src/terminals/tmux/keys.ts; window.ts
// KEY_OPTION): read with the layout, and shown wherever the key is named. What `kiko` found as
// it opened the window (window.ts Note: a key clash, herdr keeping right-clicks) is told once:
// under the list, on the bottom line for a while, and out loud. A key clash not answered before
// is then asked about in a popup drawn as the menus are (clash.ts clashQuestion), and the answer
// kept in the settings (keyClashAnswers) for the next `kiko`; Escape leaves the fallback for this run.
// The first-run card (agents-card.ts: the agents found, to connect) is a popup the same way, after
// the key clash's question when there's one (one popup at a time); its answer goes to the app as an
// "agents" action, which connects them (app.ts, agents/setup.ts). So is the question of which agent
// a new session starts in (agent-picker.ts), shown when the app puts one in the state
// (WindowState.agentAsk) and answered as a "pickAgent" action.
//
// The window may be open while the app runs elsewhere (one started some other way, with the list
// waiting for it): the bottom line and names are kept all the same, and voice sessions open there.
//
// In the classic look (tmux 3.8 and later: src/terminals/tmux/classic.ts) there's no status line:
// the window's one line, its last, and the caption, your words while you dictate, are drawn by
// window-classic.ts. Each box's title names what it shows: the session's agent mark (MARK) and name,
// set here with the names, and for an outside session's viewer where it runs too ("· in Ghostty":
// PLACE, on the tiled look's border as well).
//
// Its parts, each a module given the handles they share (WindowShared): the bottom line, the menu
// and the viewer's header (window-bar.ts), the classic look's frame and caption (window-classic.ts),
// and settings zoomed to the whole window (window-zoom.ts).
import { agent, agentOf } from "../agents/index.ts";
import type { Closed, Ended, Tidied } from "../core/close.ts";
import { log } from "../core/log.ts";
import { rememberKeyClash } from "../core/settings.ts";
import { findSession, sessionName, type Session } from "../core/sessions.ts";
import { ui, type AgentAsk, type SettingKey, type UiState, type WindowState } from "../core/ui-store.ts";
import { COMMAND, NAME } from "../core/name.ts";
import * as win from "../terminals/tmux/window.ts";
import { WINDOW as WINDOW_SESSION } from "../terminals/tmux/tmux.ts";
import { currentKey, useKey } from "../terminals/tmux/keys.ts";
import { answeredMessage, clashId, clashQuestion, isClashAnswer, type Clash } from "../terminals/tmux/clash.ts";
import type { CardRow } from "../agents/setup.ts";
import { agentsCard, cardAnswer } from "./agents-card.ts";
import { agentAnswer, agentPicker } from "./agent-picker.ts";
import { signInQuestion } from "./sign-in-ask.ts";
import { literal } from "./bar.ts";
import { sessionMark } from "./marks.ts";
import { TOKEN, windowEvents, type Ask } from "./input.ts";
import { asker, canDo, currentPage, PAGE_ID, pages, sessionMenu, sessionOf, sessionPage, shownSession, stepPage } from "./nav.ts";
import { placeText } from "./viewer.ts";
import { viewerInfo, whereOf, windowBar } from "./window-bar.ts";
import { classicFrame } from "./window-classic.ts";
import { windowZoom } from "./window-zoom.ts";

export { doingOf, viewerInfo } from "./window-bar.ts";

/** How long a word under the list stays: long enough to read a few lines in the narrow pane. */
const NOTE_MS = 12_000;
/** Kiko's page comes back to an empty stage no sooner than this after the last time (one that keeps dying isn't restarted in a loop). */
const PAGE_AGAIN_MS = 5000;
/** How long something `kiko` found (a key clash) stays on the bottom line. */
const NOTICE_MS = 30_000;
/**
 * How long a key clash's question waits for the terminal of the `kiko` that asked it: that one
 * leaves the question before it attaches (cli.ts: setNotes, then attach), so the terminal attached
 * last may still be another for a moment, one where you wouldn't see it. Then it goes to the one
 * attached last all the same (a `kiko` run inside Kiko's tmux attaches no new terminal).
 */
const ASK_CLIENT_MS = 5000;
/**
 * A session of Kiko's tmux that left the list with its pane still there (Claude Code's SessionEnd
 * comes as it quits, before its process has ended): looked at again this soon, this many times, so
 * its pane going (index.ts afterProgram) is seen at once rather than at the next listing.
 */
const GONE_AGAIN_MS = 250;
const GONE_TRIES = 12;

export type WindowGlue = {
  /** Looks at the window again (after the sessions were listed): open or not, what's shown, names. */
  refresh(): Promise<void>;
  /**
   * Shows a page (its ID: Kiko's PAGE_ID, or a session's sessionPage); the keyboard goes there,
   * unless `focus` is false (the list's preview: it stays in the list). Shows asked for while one is
   * under way are coalesced: only the latest is done next.
   */
  show(page: string, focus?: boolean): Promise<void>;
  /** The page `by` away from the one shown, in the list's order. */
  step(by: number): Promise<void>;
  /** The page shown before the one shown now (tmux's `l`), if there was one and it's still there; `focus` as for show. */
  last(focus?: boolean): Promise<void>;
  /** A session's menu where it was right-clicked (column `x`, row `y` of the list, as the terminal counts). */
  rowMenu(sessionId: string, x: number, y: number): Promise<void>;
  /** The keyboard to the list (the picker, renaming). */
  focusList(): Promise<void>;
  /** The keyboard to the session side (the list's Tab). */
  focusStage(): Promise<void>;
  /**
   * Closes a session: one of Kiko's tmux, Claude Code asked to exit (`ending`), then its tmux
   * session closed; one outside it, ended by its agent where it runs (`endingOutside`). What it
   * notes under the list also goes to `told` (the phone that asked, from a session's screen).
   */
  close(sessionId: string, told?: (line: string) => void): Promise<void>;
  /** The terminal that used the window last stops showing it. */
  detach(): Promise<void>;
  /** A word under the list. */
  note(text: string): void;
  /** The app is quitting: the bottom line says so. */
  stop(): Promise<void>;
  /** The Kiko key now, and what decided it (keys.ts KeyBy, "clash" for a fallback), as the window says. */
  key(): { key: string; by: string };
  /** Makes `key` the Kiko key now (the setting changed), for every terminal showing the window. */
  setKey(key: string): Promise<void>;
  /**
   * The first-run card (agents-card.ts), in a popup on the terminal attached last, once there is one
   * and the key clash's question (if any) is done; its answer comes as an "agents" action. Only in
   * the window's list (false elsewhere: the plain UI draws it then).
   */
  askAgents(rows: CardRow[]): boolean;
  /** The agent `kiko codex` (or `kiko claude`) preselected for this run (window.ts NEW_AGENT_OPTION), by its id; null for none. */
  runAgent(): Promise<string | null>;
  /**
   * What the app is doing as it starts, said in the session area (window.ts setStarting); null once
   * it's ready: then the starting state goes at the end of the next look (refresh), after Kiko's page
   * has taken the placeholder's place, so "No session shown here" never shows in between. Only in
   * the window's list.
   */
  starting(step: win.Step | null): Promise<void>;
};

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * How the app ends a session before its tmux session is closed (`tidy`: the pane home, the tmux
 * session killed): app/session-ops.ts endSession, Claude Code asked to exit (core/close.ts). Without one, `tidy` only.
 */
export type Ending = (session: Session, tidy: () => Promise<Tidied>) => Promise<Closed>;

const killOnly: Ending = async (_session, tidy) => ({ how: "killed", interrupted: false, tidied: await tidy(), ms: 0 });

/** How the app ends a session outside Kiko's tmux: app/session-ops.ts endOutside, its agent's Agent.end (core/close.ts endFromOutside). Without one, it isn't. */
type EndingOutside = (session: Session) => Promise<Ended>;

const notEnded: EndingOutside = async () => ({ how: "refused", why: "this run can't end it", ms: 0 });

/** What the window says once a session is closed. */
export function closedNote(name: string, closed: Pick<Closed, "how" | "why" | "tidied">): string {
  if (closed.how === "exit") return `Closed ${name}. Its conversation is saved.`;
  if (closed.tidied !== "closed") return `${name} had closed already.`;
  return closed.why ? `Closed ${name}. It didn't exit when asked, so I ended it.` : `Closed ${name}.`;
}

/** What the window says once a session outside Kiko's tmux was closed, or wasn't. */
export function endedNote(name: string, ended: Pick<Ended, "how" | "why">): string {
  if (ended.how === "ended") return `Closed ${name}. Its conversation is saved.`;
  if (ended.how === "running") return `I asked ${name} to end, but ${ended.why ?? "it's still running"}. Its terminal can close it.`;
  return `I didn't close ${name}: ${ended.why}.`;
}

/**
 * What startWindow's parts share (the bottom line's, window-bar.ts; the classic look's frame,
 * window-classic.ts; zoom, window-zoom.ts): Kiko's tmux and the list's pane, and what the window is
 * now, as the last look and the app's own changes left it.
 */
export type WindowShared = {
  tmux: win.Tmux;
  list: string | null;
  /** Whether the window is open, at the last look. */
  open: boolean;
  /** Its look, as tmux says (the window decides: src/terminals/tmux/classic.ts). */
  look: "classic" | "tiled";
  /** Something `kiko` found, on the bottom line for a while. */
  notice: { text: string; until: number } | null;
  /** The viewer in the stage, if one is: its pane, its page (an outside session's, or PAGE_ID), and the header last sent it. */
  viewing: { pane: string; page: string; sent: string } | null;
  /**
   * Whether the list is the window's active pane (has the keyboard): the classic look's line has the
   * list's keys while it is, else only the menu's (the stage's one key).
   */
  listFocused: boolean;
};

/**
 * `tmux`: Kiko's server. `list`: the app's own pane when it runs in the window's list
 * (TMUX_PANE), else null. `page`: the file Kiko's page is drawn from (core/page.ts), null for none.
 * `ending`: how Close ends a session first (Ending). `say`: says a line out loud (what `kiko`
 * found as it opened the window); without it, only shown. `endingOutside`: how Close ends one
 * outside Kiko's tmux (EndingOutside).
 */
export function startWindow(
  tmux: win.Tmux,
  list: string | null,
  page: string | null = null,
  ending: Ending = killOnly,
  say?: (line: string) => void,
  endingOutside: EndingOutside = notEnded,
): WindowGlue {
  const w: WindowShared = { tmux, list, open: false, look: "tiled", notice: null, viewing: null, listFocused: true };
  let noteTimer: NodeJS.Timeout | null = null;
  let names = new Map<string, string>(); // pane → the name on its border
  let pageAt = 0; // when Kiko's page was last put in the stage
  // Counts each change to what the stage shows that the app made itself (show, a viewer), at its start
  // and its end: a refresh that looked at the window before or during one doesn't put back what it saw.
  let staged = 0;
  // The page shown now and the one before it (`last`), as the state says: a placeholder in between doesn't count.
  let nowPage: string | null = null;
  let lastPage: string | null = null;
  const closing = new Set<string>(); // sessions being closed (asked twice: once)
  // The sessions of Kiko's tmux at the last look, by pane, and how many looks since one left the list with its pane still there.
  let seen = new Map<string, { sessionId: string; unlisted: number }>();
  let againTimer: NodeJS.Timeout | null = null;
  const ask = list ? asker(list, TOKEN) : null;
  let keyBy = "default"; // what decided the Kiko key (window.ts KEY_BY_OPTION)
  // A key clash to ask you about: waiting for a terminal to show it on (`shown` false), or shown and not answered yet.
  // `since`: when its `kiko` asked (it goes to a terminal attached since: ASK_CLIENT_MS); `read`: when it was read here.
  let asking: { clash: Clash & { fallback: string }; shown: boolean; since: number; read: number } | null = null;
  // The agents card: waiting for its turn and a terminal (`shown` false), or shown, its asks so far kept until it's answered.
  let agentsAsking: { rows: CardRow[]; shown: boolean; asks: { verb: string; arg: string }[] } | null = null;
  // What `kiko` left to tell has been read once (readKey): a key clash's question, if any, is known, and goes first.
  let notesRead = false;
  // The ask of the agent picker shown last (WindowState.agentAsk): each is shown once.
  let agentAskShown: string | null = null;
  // The sign-in popup shown last (WindowState.signInAsk): each once.
  let signInAskShown: string | null = null;
  // The classic look: the marks on the boxes' titles (the frame and caption are window-classic.ts's).
  let marks = new Map<string, string>(); // pane → its MARK, as set
  let place: { pane: string; text: string } | null = null; // the viewer's PLACE, as set
  // The app said it's ready (starting(null)): the window's starting state goes at the end of the next look.
  let ready = false;
  // Kiko's page being put in the stage now (viewPage), waited for before the starting state goes.
  let pageGoing: Promise<void> | null = null;
  // The starting state's changes, one after another, in the order they were asked for.
  let startingDone: Promise<void> = Promise.resolve();
  const startingNow = (step: win.Step | null) => (startingDone = startingDone.then(() => win.setStarting(tmux, step).catch((err) => log("window_failed", { what: "starting", error: why(err) }))));

  // The window's parts, each kept to the app's state: the classic look's frame and caption; the
  // bottom line, the menu and the viewer's header (the frame's line instead, in the classic look);
  // settings zoomed to the whole window.
  const frame = classicFrame(w);
  const bars = windowBar(w, ask, frame.schedule);
  const zoom = windowZoom(w);

  // Whether the list has the keyboard (WindowShared.listFocused), asked of tmux as the list's focus
  // reports come (input.ts: one each time the keyboard comes or goes), not taken from them: your
  // terminal losing focus (another app) sends one too, and the keys shouldn't change for that. The
  // last one asked decides.
  let focusAsked = 0;
  const onFocus = () => {
    if (!list) return;
    const asked = ++focusAsked;
    void tmux(["display", "-p", "-t", list, "#{pane_active}"])
      .then((out) => {
        const on = out.trim() === "1";
        if (asked !== focusAsked || on === w.listFocused) return;
        w.listFocused = on;
        setWindow({ inStage: !on });
        frame.schedule();
      })
      .catch(() => {});
  };

  const setWindow = (patch: Partial<WindowState>) => {
    if (ui.state.window) ui.set({ window: { ...ui.state.window, ...patch } });
  };
  const note = (text: string) => {
    setWindow({ note: text });
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(() => setWindow({ note: "" }), NOTE_MS);
    noteTimer.unref();
  };
  // Under the list only, for Close's notes that also go to the phone that asked.
  const noteHere = note;

  let splashed = Boolean(ui.state.splash);
  const changed = (s: UiState) => {
    // The splash gone: a question held for it (a key clash, the agents card) is shown now.
    if (splashed && !s.splash) void showAsk();
    splashed = Boolean(s.splash);
    const page = currentPage(s);
    if (page && page !== nowPage) {
      lastPage = nowPage;
      nowPage = page;
    }
    bars.schedule();
    frame.schedule();
    zoom.changed(s);
    const picking = s.window?.agentAsk;
    if (list && picking && picking.ask !== agentAskShown) {
      agentAskShown = picking.ask;
      void askAgent(list, picking);
    }
    const signIn = s.window?.signInAsk;
    if (list && signIn && signIn !== signInAskShown) {
      signInAskShown = signIn;
      void askSignIn(list, signIn);
    }
  };

  /**
   * A paired phone turned away because this Mac is signed out: Sign in on Enter, in a popup on the
   * terminal that used the window last. Not shown (no terminal): the line under the list says it.
   */
  async function askSignIn(at: string, ask: string) {
    const client = await win.latestClient(tmux).catch(() => null);
    if (!client) return void setWindow({ signInAsk: null });
    log("sign_in_ask_shown", {});
    void win
      .showQuestion(
        tmux,
        signInQuestion(ask, (arg) => [win.askApp(at, TOKEN, "signIn", arg)]),
        client,
      )
      .catch((err) => {
        log("window_failed", { what: "sign_in_ask", error: why(err) });
        setWindow({ signInAsk: null });
      });
  }

  /**
   * Which agent a new session starts in (agent-picker.ts), in a popup on the terminal that used
   * the window last (where c was pressed). Nothing waits on it; its answer comes as a "pickAgent" ask.
   * Not shown (no terminal, tmux refused it): let go, and said why.
   */
  async function askAgent(at: string, h: AgentAsk) {
    const letGo = (reason: string) => {
      log("window_failed", { what: "harness_picker", error: reason });
      note(`I couldn't ask which agent to start it in: ${reason}`);
      ui.act({ type: "pickAgent", ask: h.ask, agent: null });
    };
    const client = await win.latestClient(tmux).catch(() => null);
    if (!client) return letGo("no terminal shows the window");
    log("harness_picker_shown", { ask: h.ask, agents: h.rows.map((r) => r.id), selected: h.selected });
    void win
      .showQuestion(
        tmux,
        agentPicker(h, (verb, arg) => win.askApp(at, TOKEN, verb, arg)),
        client,
      )
      .catch((err) => letGo(why(err)));
  }
  const onResize = () => zoom.resized();
  // What the window's menus ask (input.ts): the app's own actions, as a key in the list would.
  const onAsk = ({ verb, arg }: Ask) => {
    log("window_ask", { verb, arg });
    switch (verb) {
      case "go":
        return ui.act({ type: "show", page: arg });
      case "new":
        return ui.act({ type: "newSession" });
      case "trust":
        return ui.act({ type: "trustScratch" });
      case "signIn":
        // The sign-in popup answered (its id: sign in) or let go (""): asked no more either way.
        setWindow({ signInAsk: null });
        return arg ? ui.act({ type: "macSignIn" }) : undefined;
      case "addKey":
        // The menu's "Add your OpenRouter key…" (the plan refusing Kiko's AI: app/key-offer.ts).
        return ui.act({ type: "addKey" });
      case "settings":
        // On a row when asked (the menu's search found it: nav.ts settingEntries), else the first.
        return ui.act(arg ? { type: "settings", at: arg as SettingKey } : { type: "settings" });
      case "step":
        return ui.act({ type: "step", by: arg === "prev" ? -1 : 1 });
      case "last":
        return ui.act({ type: "last" });
      case "rename":
      case "interrupt": {
        // Only where the menus offer it (canDo): never typed into a terminal Kiko can't be sure of.
        const session = ui.state.sessions.find((s) => s.sessionId === arg);
        if (session && !canDo(session)[verb]) return note(`${sessionName(session)} is outside, where I can't ${verb === "rename" ? "rename" : "interrupt"} it.`);
        return ui.act(verb === "rename" ? { type: "renaming", sessionId: arg } : { type: "interrupt", sessionId: arg });
      }
      case "pass": {
        // The Kiko key twice: the key to the session shown, only one of Kiko's tmux (the app types it the checked way).
        const shown = shownSession(ui.state);
        return shown ? ui.act({ type: "passKey", sessionId: shown.sessionId }) : undefined;
      }
      case "close":
        return ui.act({ type: "close", sessionId: arg });
      case "quit":
        return ui.act({ type: "quit" });
      case "agentOn":
        // The agents card: one ticked as it was sent (agents-card.ts); the answer follows.
        if (agentsAsking?.shown) agentsAsking.asks.push({ verb, arg });
        return;
      case "agents": {
        // The agents card answered (connect) or let go (later): the app carries it out.
        if (!agentsAsking?.shown) return;
        const { rows, asks } = agentsAsking;
        agentsAsking = null;
        return ui.act({ type: "agents", ...cardAnswer([...asks, { verb, arg }], rows) });
      }
      case "pickAgent": {
        // The agent picker answered (an agent's id) or let go (none): the app starts it, or doesn't.
        const answer = agentAnswer(arg);
        return answer ? ui.act({ type: "pickAgent", ...answer }) : undefined;
      }
      case "keyClash": {
        // Let go (Escape): nothing kept, the fallback stays this run; the agents card's turn.
        if (asking?.shown && arg === "") {
          asking = null;
          return void showAsk();
        }
        // The key clash's question answered (clash.ts clashQuestion): kept for the next `kiko`; the fallback is the key already.
        if (!asking || !isClashAnswer(arg)) return;
        const { clash } = asking;
        asking = null;
        try {
          rememberKeyClash(clashId(clash), arg);
        } catch (err) {
          log("window_failed", { what: "key_clash_answer", error: why(err) });
        }
        log("key_clash_answer", { ...clash, answer: arg });
        note(answeredMessage(clash, arg));
        void showAsk();
        return arg === "own" ? ui.act({ type: "settings", at: "menuKey" }) : undefined;
      }
    }
  };
  ui.on("change", changed);
  if (list) {
    process.stdout.on("resize", onResize);
    windowEvents.on("ask", onAsk);
    windowEvents.on("focus", onFocus);
    // Started zoomed (first-run setup, say): the list again; kept whole for the splash, until it goes.
    zoom.start();
  }

  /** Leaves settings when something else is asked for (a page, the picker): the list again, unzoomed. */
  function leaveSettings() {
    if (ui.state.screen === "settings") ui.act({ type: "closeSettings" });
  }

  async function refresh() {
    const since = staged;
    let layout: win.Layout;
    try {
      layout = await win.describe(tmux);
    } catch {
      w.open = false;
      return;
    }
    const view = layout.view;
    const was = w.open;
    w.open = Boolean(view);
    if (!view) return;
    if (!was) {
      bars.forget();
      bars.schedule();
    }
    // Its look (as tmux says: the window decides, src/terminals/tmux/classic.ts), for the list and what's pushed.
    frame.sized({ width: view.width, height: view.height });
    if (view.look !== w.look) {
      w.look = view.look;
      bars.forget(false);
      setWindow({ look: w.look });
    } else if (ui.state.window && ui.state.window.look !== w.look) setWindow({ look: w.look });
    if (w.look === "classic") await frame.start();
    // A caption (or a glow) the app didn't make (one left by a run that stopped mid-word): gone, unless it's this one's.
    if (view.caption && !frame.ownsCaption(view.caption.id)) await win.closeCaption(tmux, view.caption.id);
    if (view.glow && !frame.ownsGlow(view.glow.id)) await win.closeGlow(tmux, view.glow.id);
    exitedByThemselves(layout);
    await readKey();
    await showAsk();
    let stageNow = view.stage;
    if (view.stage?.dead) {
      await win.tidy(tmux).catch((err) => log("window_failed", { what: "tidy", error: why(err) }));
      // What tidy left there (a placeholder, as a rule): Kiko's page goes in below, not at the next look.
      stageNow = (await win.describe(tmux).catch(() => null))?.view?.stage ?? null;
    }
    // What the stage shows, as tmux says: unless the app showed something meanwhile (a page picked
    // as this looked), which this would undo until the next look. Seen in the nested tmux test: pixie
    // picked, then the Kiko key twice went nowhere, "nothing shown" put back by a look begun before.
    const fresh = since === staged;
    const stage = view.stage && !view.stage.role && !view.stage.dead ? view.stage.id : null;
    if (fresh && ui.state.window && ui.state.window.shown !== stage) setWindow({ shown: stage });
    // A viewer (an outside session's, Kiko's page): its header kept to the state (a viewer from before a restart too).
    const viewer = view.stage?.role === "viewer" && !view.stage.dead && view.stage.viewing ? view.stage : null;
    if (fresh && (viewer?.id !== w.viewing?.pane || viewer?.viewing !== w.viewing?.page)) w.viewing = viewer && { pane: viewer.id, page: viewer.viewing, sent: "" };
    if (fresh && ui.state.window && (ui.state.window.viewing ?? null) !== (w.viewing?.page ?? null)) setWindow({ viewing: w.viewing?.page ?? null });
    bars.schedule();
    // Nothing in the stage but a placeholder: Kiko's page instead (the keyboard stays where it is).
    const empty = stageNow?.role === "placeholder" && !stageNow.dead;
    if (list && page && empty && Date.now() - pageAt > PAGE_AGAIN_MS) await viewPage(false, true);
    if (ready) {
      ready = false;
      await pageGoing;
      await startingNow(null);
    }
    // The names Kiko knows on the sessions' borders, for when they're shown.
    const panes = new Map(layout.panes.map((p) => [p.id, p]));
    const next = new Map<string, string>();
    const nextMarks = new Map<string, string>();
    const keepMark = async (pane: string, mark: string) => {
      nextMarks.set(pane, mark);
      if (marks.get(pane) !== mark) await win.setMark(tmux, pane, mark).catch(() => "");
    };
    for (const session of ui.state.sessions) {
      const pane = session.place?.via === "tmux" ? panes.get(session.place.id) : undefined;
      if (!pane || pane.role) continue;
      const name = sessionName(session);
      next.set(pane.id, name);
      if (pane.name !== name && names.get(pane.id) !== name) await win.setLabel(tmux, pane.id, name).catch(() => "");
      // In the classic look its box's title has its agent's mark too.
      if (w.look === "classic") await keepMark(pane.id, win.markFormat(sessionMark(session, ui.state.icons)));
    }
    // A viewer's title: the mark of the outside session it shows (classic), and where it runs (both looks); none for Kiko's page.
    if (viewer) {
      const id = sessionOf(viewer.viewing);
      const outside = id ? findSession(ui.state.sessions, id) : undefined;
      if (w.look === "classic") await keepMark(viewer.id, win.markFormat(outside ? sessionMark(outside, ui.state.icons) : null));
      // Kept to where it runs while it's listed; an ended one keeps what it had.
      const text = outside ? placeText(whereOf(outside)) : id ? null : "";
      if (text !== null && (place?.pane !== viewer.id || place.text !== text)) {
        place = { pane: viewer.id, text };
        await win.setPlace(tmux, viewer.id, text).catch(() => "");
      }
    }
    names = next;
    marks = nextMarks;
  }

  /**
   * Sessions of Kiko's tmux whose pane has gone since the last look, that Close wasn't closing:
   * their program quit by itself (/exit or Ctrl+D typed in it, a crash; any agent) and tmux closed
   * the pane with it (index.ts afterProgram; DIED_HOOK in the stage). Logged (`session_closed`, how
   * "exited"), and Kiko's page in an empty stage at once, as after Close (pageAt; a stage showing
   * something else keeps it). Nothing is closed here: tmux has done it. Done before the look's first
   * wait, so two looks at once never both log one. Without this, /exit typed in a session opened
   * from the window left its shell in the stage.
   */
  function exitedByThemselves(layout: win.Layout) {
    const live = new Set(layout.panes.filter((p) => !p.dead && !p.role).map((p) => p.id));
    const listed = new Map<string, string>();
    for (const s of ui.state.sessions) if (s.place?.via === "tmux" && live.has(s.place.id)) listed.set(s.place.id, s.sessionId);
    const next = new Map<string, { sessionId: string; unlisted: number }>();
    let again = false;
    for (const [pane, was] of seen) {
      if (listed.has(pane)) continue;
      if (live.has(pane)) {
        // Off the list, its pane still there: looked at again shortly, a few times.
        if (was.unlisted < GONE_TRIES) {
          next.set(pane, { ...was, unlisted: was.unlisted + 1 });
          again = true;
        }
        continue;
      }
      if (closing.has(was.sessionId)) continue;
      log("session_closed", { sessionId: was.sessionId, how: "exited", pane, shown: ui.state.window?.shown === pane });
      pageAt = 0;
    }
    for (const [pane, sessionId] of listed) next.set(pane, { sessionId, unlisted: 0 });
    seen = next;
    if (again && !againTimer) {
      againTimer = setTimeout(() => {
        againTimer = null;
        void refresh();
      }, GONE_AGAIN_MS);
      againTimer.unref();
    }
  }

  /** The Kiko key the window has now (as `kiko` or the settings bound it), and what `kiko` left to tell you. */
  async function readKey() {
    const out = await tmux(["display", "-p", "-t", `=${WINDOW_SESSION}:`, `#{${win.KEY_OPTION}}\t#{${win.KEY_BY_OPTION}}\t#{${win.NOTES_SAID_OPTION}}\t#{${win.NOTES_OPTION}}`]).catch(() => "");
    const [key = "", by = "", said = "", notes = ""] = out.replace(/\n$/, "").split("\t");
    keyBy = by || "default";
    if (key && useKey(key)) {
      // Everything that names it, again: the bottom line, the menu, the viewer's footer, the list.
      log("menu_key", { key: currentKey(), by: keyBy });
      bars.forget();
      if (w.viewing) w.viewing.sent = "";
      ui.set({});
      bars.schedule();
    }
    if (notes) await tell(notes, said);
    if (out) notesRead = true;
  }

  /** What `kiko` found (window.ts Note, as JSON), each told once: under the list, on the bottom line for a while, out loud. */
  async function tell(json: string, said: string) {
    let notes: win.Note[];
    try {
      notes = JSON.parse(json);
      if (!Array.isArray(notes)) return;
    } catch {
      return;
    }
    const told = new Set(said.split(",").filter(Boolean));
    const fresh = notes.filter((n) => n && typeof n.id === "string" && typeof n.text === "string" && !told.has(n.id));
    if (!fresh.length) return;
    // Marked first: a second app (or this one, refreshing again meanwhile) doesn't say it too. Only
    // the notes there now are kept marked (a question's id is a `kiko`'s own: they'd pile up).
    for (const n of fresh) told.add(n.id);
    const current = new Set(notes.map((n) => n?.id));
    await tmux(["set-option", "-g", win.NOTES_SAID_OPTION, [...told].filter((id) => current.has(id)).join(",")]).catch(() => "");
    for (const n of fresh) {
      if (n.log?.event) log(n.log.event, n.log.fields ?? {});
      note(n.text);
      w.notice = { text: n.text, until: Date.now() + NOTICE_MS };
      bars.schedule();
      if (n.spoken) say?.(n.spoken);
      // A key clash to ask about, after the warning; only where its answer can reach this app (the window's list).
      const clash = n.ask;
      if (list && clash && typeof clash.key === "string" && typeof clash.fallback === "string")
        asking = { clash: { ...clash, fallback: clash.fallback }, shown: false, since: typeof n.at === "number" ? n.at : 0, read: Date.now() };
    }
  }

  /**
   * The key clash's question (asking), on the terminal attached last (where that `kiko` ran), once
   * there is one; then, once it's answered or let go, the agents card. One popup at a time; nothing
   * waits for an answer.
   */
  async function showAsk() {
    // Not over the splash: once it's gone (changed).
    if (!list || ui.state.splash) return;
    if (asking) {
      if (asking.shown || agentsAsking?.shown) return;
      // The terminal of the `kiko` that asked: attached since it asked; not there yet, at a later look.
      const waiting = Date.now() - asking.read < ASK_CLIENT_MS;
      const client = await win.latestClient(tmux, true, waiting ? asking.since : 0);
      if (!client || !asking || asking.shown) return;
      const shown = asking;
      shown.shown = true;
      log("key_clash_ask", { ...shown.clash });
      const menu = clashQuestion(shown.clash, (answer) => [win.askApp(list, TOKEN, "keyClash", answer)], [win.askApp(list, TOKEN, "keyClash", "")]);
      void win.showQuestion(tmux, menu, client).catch((err) => {
        log("window_failed", { what: "key_clash_ask", error: why(err) });
        shown.shown = false;
      });
      return;
    }
    if (!agentsAsking || agentsAsking.shown || !notesRead) return;
    const client = await win.latestClient(tmux, true);
    if (!client || !agentsAsking || agentsAsking.shown || asking) return;
    const shown = agentsAsking;
    shown.shown = true;
    log("agents_card_shown", { where: "window", agents: shown.rows.filter((r) => r.ask).map((r) => r.id) });
    const menu = agentsCard(shown.rows, (verb, arg) => win.askApp(list, TOKEN, verb, arg));
    void win.showQuestion(tmux, menu, client).catch((err) => {
      log("window_failed", { what: "agents_card", error: why(err) });
      shown.shown = false;
    });
  }

  // Shows asked for while one is under way (↓ held in the list, a preview each step): only the
  // latest waits its turn, the ones it replaced are dropped, so the stage keeps up with the highlight
  // and never plays back a queue of stale ones.
  type Wanted = { page: string; focus: boolean };
  let showing: Promise<void> | null = null;
  let wanted: Wanted | null = null;
  function show(page: string, focus = true): Promise<void> {
    wanted = { page, focus };
    showing ??= (async () => {
      try {
        for (let next: Wanted | null = wanted; next; next = wanted) {
          const { page, focus } = next;
          wanted = null;
          await showOne(page, focus).catch((err) => log("window_failed", { what: "show", page, error: why(err) }));
        }
      } finally {
        showing = null;
      }
    })();
    return showing;
  }

  async function showOne(page: string, focus: boolean) {
    leaveSettings();
    if (page === PAGE_ID) return viewPage(focus, false, true);
    const sessionId = sessionOf(page);
    const session = sessionId ? ui.state.sessions.find((s) => s.sessionId === sessionId) : undefined;
    if (!session) return note("That session has ended.");
    const name = sessionName(session);
    const place = session.place;
    if (place?.via !== "tmux") return viewOutside(session, name, focus);
    let shown: win.Shown;
    staged++;
    try {
      shown = await win.show(tmux, place.id, focus);
    } catch (err) {
      log("window_failed", { what: "show", sessionId, error: why(err) });
      return note(`I couldn't show ${name}: ${why(err)}`);
    } finally {
      staged++;
    }
    log("window_show", { sessionId, pane: place.id, shown });
    if (shown === "gone") return note(`${name}'s pane has closed.`);
    if (shown === "no window") return note(`${NAME}'s window isn't open.`);
    w.viewing = null;
    setWindow({ shown: place.id, viewing: null, note: "" });
  }

  /**
   * Puts a viewer in the stage (an outside session's, Kiko's page) and keeps its header from
   * then on. `onlyIfEmpty`: only over a placeholder (what was shown meanwhile stays). `asked`:
   * shown on asking (the keyboard moved there or not), not put there on its own.
   */
  async function viewer(it: win.Viewed, focus: boolean, what: string, onlyIfEmpty = false, asked = focus) {
    let shown: Awaited<ReturnType<typeof win.view>>;
    staged++;
    try {
      shown = await win.view(tmux, it, focus, onlyIfEmpty);
    } catch (err) {
      log("window_failed", { what: "view", page: it.id, error: why(err) });
      return note(`I couldn't show ${what}: ${why(err)}`);
    } finally {
      staged++;
    }
    log("window_show", { page: it.id, shown });
    if (shown === "no window") return note(`${NAME}'s window isn't open.`);
    if (shown === "busy") return;
    // Its pane: the stage now (refresh keeps it to the state from here on).
    const stage = (await win.describe(tmux).catch(() => null))?.view?.stage;
    const viewing = stage?.role === "viewer" ? { pane: stage.id, page: it.id, sent: it.info } : null;
    w.viewing = viewing;
    if (viewing) place = { pane: viewing.pane, text: it.place ?? "" };
    // The classic look: its box's title with the outside session's agent mark at once (Kiko's page has none).
    const outside = sessionOf(it.id) ? findSession(ui.state.sessions, sessionOf(it.id)!) : undefined;
    if (w.look === "classic" && viewing && outside) {
      const mark = win.markFormat(sessionMark(outside, ui.state.icons));
      marks.set(viewing.pane, mark);
      await win.setMark(tmux, viewing.pane, mark).catch(() => "");
    }
    // Asked for: the word under the list has done its job. Put there on its own (an empty stage): it stays.
    setWindow({ shown: null, viewing: it.id, ...(asked ? { note: "" } : {}) });
  }

  /**
   * A session outside Kiko's tmux (Ghostty, the desktop app, the background): its conversation,
   * read-only, in a viewer in the stage. Its transcript's path is all the viewer's command line has.
   */
  const viewOutside = (session: Session, name: string, focus = true) => {
    const path = agent.historyFile(session);
    // An agent that keeps no file of it, nor writes one (T3 Code's, when it couldn't): it lives in its own app.
    if (!path) return note(`This thread lives in ${agentOf(session).name}.`);
    return viewer(
      { id: sessionPage(session.sessionId), path, name, place: placeText(whereOf(session)), info: JSON.stringify(viewerInfo(ui.state, sessionPage(session.sessionId))) },
      focus,
      name,
      false,
      true,
    );
  };

  /** Kiko's own page: its conversation with you, from the page file; the file's path is all its command line has. */
  async function viewPage(focus: boolean, onlyIfEmpty = false, asked = focus) {
    if (!page) return note(`${NAME}'s page isn't kept by this run.`);
    pageAt = Date.now();
    const going = viewer({ id: PAGE_ID, path: page, name: NAME, info: JSON.stringify(viewerInfo(ui.state, PAGE_ID)), page: true }, focus, `${NAME}'s page`, onlyIfEmpty, asked);
    const settled = going.then(
      () => {},
      () => {},
    );
    pageGoing = settled;
    void settled.then(() => {
      if (pageGoing === settled) pageGoing = null;
    });
    await going;
  }

  /** Close for a session outside Kiko's tmux: its agent ends it where it runs; Kiko's page in place of its conversation, if shown. */
  async function closeOutside(session: Session, told?: (line: string) => void) {
    const { sessionId } = session;
    const name = sessionName(session);
    const note = (line: string) => {
      noteHere(line);
      told?.(line);
    };
    if (!canDo(session).close) return note(`I can't close ${name} from here: close it where it runs.`);
    if (closing.has(sessionId)) return;
    closing.add(sessionId);
    try {
      note(`Closing ${name}…`);
      const ended = await endingOutside(session);
      log("window_close", { sessionId, outside: true, how: ended.how });
      // An agent whose sessions don't end as a process does (T3 Code: archived) says it its way.
      const ending = agentOf(session).ending;
      note(ending && ended.how === "ended" ? ending.done(name) : endedNote(name, ended));
      if (ended.how === "ended" && w.viewing?.page === sessionPage(sessionId)) await viewPage(false);
      await refresh();
    } catch (err) {
      log("window_failed", { what: "close", sessionId, error: why(err) });
      note(`I couldn't close ${name}: ${why(err)}`);
    } finally {
      closing.delete(sessionId);
    }
  }

  async function rowMenu(sessionId: string, x: number, y: number) {
    const session = ui.state.sessions.find((s) => s.sessionId === sessionId);
    if (!session || !list || !ask) return;
    try {
      const client = await win.latestClient(tmux);
      if (!client) return;
      const corner = await win.paneCorner(tmux, list);
      const m = sessionMenu(session, ask);
      // Just below the row clicked: tmux puts a popup's bottom edge on the line given.
      const tall = m.items.length + 2;
      await win.showMenu(tmux, m, client, { x: corner.left + Math.max(0, x - 1), y: corner.top + y + tall }, ` ${literal(sessionName(session), 30)} `);
    } catch (err) {
      log("window_failed", { what: "row menu", sessionId, error: why(err) });
    }
  }

  return {
    refresh,
    show,
    async step(by) {
      await show(stepPage(ui.state, by));
    },
    async last(focus = true) {
      if (lastPage && pages(ui.state).some((p) => p.id === lastPage)) await show(lastPage, focus);
    },
    rowMenu,
    async focusList() {
      leaveSettings();
      if (list) await win.focus(tmux, list).catch(() => "");
    },
    async focusStage() {
      const stage = (await win.describe(tmux).catch(() => null))?.view?.stage;
      if (stage) await win.focus(tmux, stage.id).catch(() => "");
    },
    async close(sessionId, told) {
      const note = (line: string) => {
        noteHere(line);
        told?.(line);
      };
      const session = ui.state.sessions.find((s) => s.sessionId === sessionId);
      if (!session) return note("That session has ended.");
      if (session.place?.via !== "tmux") return closeOutside(session, told);
      if (closing.has(sessionId)) return;
      closing.add(sessionId);
      const name = sessionName(session);
      const pane = session.place.id;
      try {
        note(`Closing ${name}…`);
        const closed = await ending(session, () => win.closeSession(tmux, pane));
        log("window_close", { sessionId, closed: closed.tidied, how: closed.how });
        note(closedNote(name, closed));
        pageAt = 0; // Kiko's page in its place at once
        await refresh();
      } catch (err) {
        log("window_failed", { what: "close", sessionId, error: why(err) });
        note(`I couldn't close ${name}: ${why(err)}`);
      } finally {
        closing.delete(sessionId);
      }
    },
    async detach() {
      const client = await win.latestClient(tmux);
      if (client) await win.detach(tmux, client).catch((err) => log("window_failed", { what: "detach", error: why(err) }));
    },
    note,
    key: () => ({ key: currentKey(), by: keyBy }),
    async setKey(key) {
      await win.bindKey(tmux, key, "setting");
      await readKey();
    },
    askAgents(rows) {
      if (!list) return false;
      agentsAsking = { rows, shown: false, asks: [] };
      void showAsk();
      return true;
    },
    runAgent: () => win.newAgent(tmux),
    async starting(step) {
      if (!list) return;
      if (step) return startingNow(step);
      ready = true;
      await refresh();
    },
    async stop() {
      bars.stop();
      if (againTimer) clearTimeout(againTimer);
      // The frame says Kiko isn't running once its socket closes; a caption goes with the app.
      await frame.stop();
      ui.off("change", changed);
      windowEvents.off("ask", onAsk);
      windowEvents.off("focus", onFocus);
      process.stdout.off("resize", onResize);
      if (!w.open || list || w.look === "classic") return; // in the window, it closes with the app (start.ts); the classic look has no bottom line
      await win.setBar(tmux, `#[fg=colour244]● ${NAME} isn't running · run ${COMMAND} to start it here`).catch(() => "");
    },
  };
}
