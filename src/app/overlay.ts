// The Mac overlay, a Kiko Dev prototype: a pill at the top of the screen, drawn by the helper app
// (native/macos/app/host.swift, "The overlay"), showing what Kiko is doing while you're in another
// app: your words as you talk, "Sent to <session>", "<session> · <what Kiko says>", and a session
// that needs you. Fed from the UI store (core/ui-store.ts), so no part of the talk flow knows of it:
// each change becomes one overlay state, sent to the app over its control channel when it differs
// from the last. The app hides it only while Kiko's own window is in front (`kikoFocused`, asked as
// you start talking, then at most once a second while the overlay would show) and its terminal is
// the frontmost app (its bundle id from the environment, and the apps responsible for the tmux
// clients showing Kiko's pane, or the app whose server one is: Rex's terminals are its server's, a
// background app). Which terminal apps there are, and how each is told apart, is one list:
// core/terminal-apps.ts APPS.
// "In front" is by one of two rules (FocusRule, the user's, 2026-11-05: visible wherever the
// terminal can say it):
// - visible, in Rex: Kiko's block drawn in the tab the Rex app shows, whichever block of it has
//   the focus (Rex's own say, terminals/rex/focus.ts, goes over tmux's: its focus events don't
//   reach tmux as you change tabs). Another tab, another block zoomed: it shows.
// - focused, everywhere else (Ghostty, iTerm, Terminal…): Kiko's tmux client has its terminal's
//   focus (tmux's flag, from the focus events the terminal sends: Ghostty, iTerm and Terminal send
//   them per split or tab). A Claude session in a Ghostty split beside Kiko's, with the focus,
//   shows it. Their AppleScript could say which tab is shown (Apple Events, once a second, needing
//   a grant the overlay mustn't ask for), so they keep this rule.
// Inside Kiko's own tmux window, any of its panes having the keyboard counts (focusOf): Kiko's pane
// is on screen unless the window is zoomed on another. A focus not known (Kiko not in tmux) shows it.
// Logged: overlay_start (on or off, and why; the terminal app and which variable said it),
// overlay_sent (each new state, and which way it went), overlay_focus (what tmux or Rex said: `rule`, `by`, `why`), and the
// app's own overlay_app_* lines (what it got, shown or hidden and why, the apps responsible for
// Kiko's tmux clients, the panel on screen). `kiko-dev _overlay-test` shows each state through the
// running app, without talking (overlayTest).
// Kiko Dev only: on by default there (KIKO_OVERLAY=0 turns it off), never in the release.
import { setTimeout as sleep } from "node:timers/promises";
import { log } from "../core/log.ts";
import { DEV, envVar, NAME, OWN } from "../core/name.ts";
import { APPS, serverApps, type TerminalApp, windowApp } from "../core/terminal-apps.ts";
import { ui, type Line, type UiState } from "../core/ui-store.ts";
import { type Broker, broker, helperAppConn } from "../platform/macos/helper-app.ts";
import { tmuxRunner } from "../terminals/tmux/tmux.ts";
import { type Heard, LEVEL_MS } from "../core/spoken-lines.ts";

/** Whether the overlay is shown, and why not: Kiko Dev on a Mac unless KIKO_OVERLAY=0 (or off); never the release, never under the test runner. */
export function overlayDecision(env = envVar("OVERLAY"), dev = DEV, platform = process.platform, underTest = !!process.env.NODE_TEST_CONTEXT): { on: boolean; why: string } {
  const said = (env ?? "").trim().toLowerCase();
  if (!dev) return { on: false, why: "not Kiko Dev" };
  if (platform !== "darwin") return { on: false, why: `not a Mac (${platform})` };
  if (underTest) return { on: false, why: "under the test runner" };
  if (["0", "off", "false", "no"].includes(said)) return { on: false, why: `KIKO_OVERLAY=${env}` };
  return { on: true, why: env === undefined ? "Kiko Dev" : `Kiko Dev, KIKO_OVERLAY=${env}` };
}

export function overlayWanted(env = envVar("OVERLAY"), dev = DEV, platform = process.platform, underTest = !!process.env.NODE_TEST_CONTEXT): boolean {
  return overlayDecision(env, dev, platform, underTest).on;
}

/**
 * The terminal app Kiko's window is in, by bundle id, as the app's environment says (what it said
 * as the app started): one list of terminal apps, core/terminal-apps.ts APPS, whose envMark and
 * servers cover a terminal the defaults don't (Rex).
 */
export function terminalBundleId(env: NodeJS.ProcessEnv = process.env): string | null {
  return windowApp(env)?.bundle ?? null;
}

/**
 * The terminal adapters (src/terminals/index.ts) that are no terminal app Kiko's window can be in,
 * and why. Every other adapter is a terminal app of APPS (tests/unit/app/overlay.test.ts checks).
 */
export const NOT_WINDOW_APPS: Record<string, string> = {
  tmux: "Kiko's own tmux: its window is always there, its client's focus is how the window is found; the app around it is what's matched",
  agent: "a session's own server (OpenCode's): a message box, no window",
  t3code: "T3 Code's threads: its own app, never Kiko's window",
};

/** Where Kiko's window is: the tmux clients showing its pane, and whether one has the focus (null: not known). */
export type Focus = { hostPids: number[]; kikoFocused: boolean | null };

/**
 * tmux's list-clients format focusOf reads: each client's pid, flags, the active pane of the window
 * it shows, whether that window is zoomed, and every pane of that window (`#{P:}`, tmux's loop
 * over a window's panes).
 */
export const CLIENTS_FORMAT = "#{client_pid}\t#{client_flags}\t#{pane_id}\t#{window_zoomed_flag}\t#{P:#{pane_id} }";

/**
 * What tmux's list-clients says (CLIENTS_FORMAT a line), for Kiko's pane `pane` (TMUX_PANE): the
 * clients showing it, and whether one has its terminal's focus. A client shows Kiko's pane when
 * it's in the window the client shows and drawn there: the window not zoomed, or zoomed on it.
 * Whichever pane of Kiko's window has the keyboard (its list, or the session beside it) doesn't
 * matter: Kiko's pane is on screen. A line of the first three fields only: the active pane alone.
 */
export function focusOf(out: string, pane: string | undefined): Focus {
  const clients = out
    .split("\n")
    .map((l) => l.split("\t"))
    .map(([pid, flags, active, zoomed, panes]) => ({
      pid: Number(pid?.trim()),
      flags: (flags ?? "").split(","),
      active: active?.trim(),
      zoomed: zoomed?.trim() === "1",
      panes: panes === undefined ? null : panes.split(/\s+/).filter(Boolean),
    }))
    .filter((c) => Number.isInteger(c.pid) && c.pid > 1);
  // Not in tmux: its clients are anyone's, and which window is in front isn't known.
  if (!pane) return { hostPids: clients.map((c) => c.pid), kikoFocused: null };
  const kiko = clients.filter((c) => c.active === pane || (c.panes?.includes(pane) && !c.zoomed));
  return { hostPids: kiko.map((c) => c.pid), kikoFocused: kiko.some((c) => c.flags.includes("focused")) };
}

/** A terminal's own say on whether Kiko's window is on screen in it (core/terminal-apps.ts TerminalApp.focus): null when it can't tell. */
export type FocusHook = NonNullable<TerminalApp["focus"]>;

/**
 * Which rule said whether Kiko's window counts as in front: "visible" (a terminal's own hook: Kiko's
 * pane drawn in the tab in front, whichever pane of it has the focus; Rex) or "focused" (tmux's
 * flag: Kiko's tmux client has its terminal's focus; Ghostty, iTerm, Terminal and the rest).
 */
export type FocusRule = "visible" | "focused";

/** Where Kiko's window is, whether it counts as in front, by which rule, and who said so: tmux, or a terminal's hook (its APPS id). */
export type Found = { focus: Focus; by: string; rule: FocusRule; tmux: boolean | null; why?: string; ms: number };

/**
 * Kiko's focus: tmux's list-clients (`listClients`) for Kiko's clients and their `focused` flag;
 * then each terminal's own hook (`hooks`, Rex's: its focus events don't reach tmux as you change
 * tabs, and it says whether Kiko's pane is on screen, focused or not), whose answer goes over
 * tmux's when it has one: a hook answers only for a client that's in its terminal, so every other
 * terminal keeps tmux's flag. A hook that fails or can't tell: tmux's.
 */
export async function kikoFocus(pane: string | undefined, listClients: () => Promise<string>, hooks: [string, FocusHook][]): Promise<Found> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  let focus: Focus;
  try {
    focus = focusOf(await listClients(), pane);
  } catch (err) {
    return { focus: { hostPids: [], kikoFocused: null }, by: "tmux", rule: "focused", tmux: null, why: `tmux: ${(err as Error).message}`, ms: ms() };
  }
  const tmux = focus.kikoFocused;
  // Not in tmux, or Kiko's pane shown nowhere: no client of Kiko's for a terminal to find.
  if (!pane || !focus.hostPids.length) return { focus, by: "tmux", rule: "focused", tmux, ms: ms() };
  const whys: string[] = [];
  for (const [id, hook] of hooks) {
    const said = await hook(focus.hostPids).catch((err: Error) => ({ kikoFocused: null, why: err.message }));
    if (said.kikoFocused !== null) return { focus: { ...focus, kikoFocused: said.kikoFocused }, by: id, rule: "visible", tmux, why: said.why, ms: ms() };
    whys.push(`${id}: ${said.why}`);
  }
  return { focus, by: "tmux", rule: "focused", tmux, ...(whys.length ? { why: whys.join("; ") } : {}), ms: ms() };
}

/** The terminals whose own say on Kiko's focus goes over tmux's (TerminalApp.focus). */
export const focusHooks = (): [string, FocusHook][] => Object.entries(APPS).flatMap(([id, a]) => (a.focus ? [[id, a.focus] as [string, FocusHook]] : []));

export type OverlayState = { state: "idle" | "listening" | "deciding" | "sent" | "speaking" | "needs"; text?: string; session?: string; level?: number };

/** How long "Sent to …" shows (the app fades it after this too), and a session that needs you. */
const SENT_MS = 1200;
const NEEDS_MS = 5000;
/** Kiko's focus asked of tmux at most this often while the overlay is up. */
const FOCUS_MS = 1000;

/** A level as the overlay is sent it: to the nearest 0.05, so a level that barely moved sends nothing. */
const levelShown = (level: number) => Math.round(level * 20) / 20;

/**
 * What the overlay shows for `s`: talking first, then where it went, Kiko speaking, a session that
 * needs you, else nothing. Kiko speaking is shown as your own words are: the words said so far and
 * the sound's level now (`saying`, sayingNow), the app keeping the newest words in view.
 */
export function overlayState(s: UiState, now: number, said: { text: string; name: string } | null, needsUntil: number, saying: Saying | null = null): OverlayState {
  // The mic not giving sound yet (a Bluetooth one connecting, 2026-11-12): said where your words go, until they come.
  if (s.listening) return { state: "listening", text: s.interim || (s.micConnecting ? `Connecting to ${s.micConnecting}…` : ""), level: levelShown(s.level) };
  if (s.deciding) return { state: "deciding", text: s.deciding.text };
  if (s.routed && now - s.routed.at < SENT_MS) return { state: "sent", session: s.routed.to };
  if (s.speaking) return { state: "speaking", session: said?.name ?? NAME, text: saying?.text ?? "", level: saying?.level ?? 0 };
  if (s.permission && now < needsUntil) return { state: "needs", session: s.permission.name, text: s.permission.what };
  return { state: "idle" };
}

/**
 * What Kiko is saying, as the overlay shows it: the words said so far, and its sound's level now
 * (0–1, the mic's scale). `fromSound`: from the sound being played (not timed).
 */
export type Saying = { text: string; level: number; fromSound?: boolean };

/** About how long the macOS voice takes a word (mac-output.ts sayMs: 160 a minute): it plays by itself, so its words are timed. */
export const SAY_WORD_MS = 375;
/** The bars' level for the macOS voice, whose sound Kiko never has: a steady middle (the app adds the bars' own life). */
export const SAY_LEVEL = 0.5;

/**
 * The words Kiko has said so far and its sound's level now, in step with what's heard: the line
 * being played, at the sample being played (speech.ts heardNow: its read-along's words, its sound's
 * level). Where the sound isn't Kiko's to measure (the macOS voice plays by itself), `said`'s words
 * at its pace from when speaking began (`since`), and a steady level until they're all said.
 * `kept`: what was shown last while this speaking lasts; once the line has played out it stays, quiet.
 */
export function sayingNow(heard: Heard | null, said: { text: string } | null, since: number, now: number, kept: Saying | null): Saying {
  if (heard?.words) return { text: heard.words.join(" "), level: levelShown(heard.level), fromSound: true };
  if (!heard && kept?.fromSound) return { text: kept.text, level: 0, fromSound: true };
  const words = (said?.text ?? "").split(/\s+/).filter(Boolean);
  const elapsed = Math.max(0, now - since);
  const n = Math.min(words.length, 1 + Math.floor(elapsed / SAY_WORD_MS));
  if (heard) return { text: words.slice(0, n).join(" "), level: levelShown(heard.level), fromSound: true };
  return { text: words.slice(0, n).join(" "), level: elapsed < words.length * SAY_WORD_MS ? SAY_LEVEL : 0 };
}

/**
 * Starts feeding the overlay (once). `heard`: what's being heard now (speech.ts heardNow), looked
 * at every LEVEL_MS while Kiko speaks, as the mic's level is while you talk.
 */
export function startOverlay(heard: () => Heard | null = () => null) {
  const decided = overlayDecision();
  const app = windowApp();
  const hosts = app ? [app.bundle] : [];
  // Background apps that run a terminal's terminals, as the app responsible for Kiko's tmux client: that terminal's app.
  const hostServers = serverApps();
  const pane = process.env.TMUX_PANE;
  log("overlay_start", {
    on: decided.on,
    why: decided.why,
    dev: DEV,
    env: envVar("OVERLAY") ?? null,
    platform: process.platform,
    underTest: !!process.env.NODE_TEST_CONTEXT,
    hosts,
    hostsBy: app?.by ?? null,
    hostServers,
    pane: pane ?? null,
  });
  if (!decided.on) return;
  let focus: Focus = { hostPids: [], kikoFocused: null };
  let focusAt = 0;
  let asking = false;
  let last = "";
  let lastState: OverlayState["state"] = "idle";
  let said: { text: string; name: string } | null = null;
  let permissionId: string | null = null;
  let needsUntil = 0;
  let timer: NodeJS.Timeout | undefined;
  let saidNoApp = false;
  // While Kiko speaks: since when, what was shown last, and the next look at what's heard.
  let speakingSince = 0;
  let saying: Saying | null = null;
  let speakTimer: NodeJS.Timeout | undefined;

  const send = (m: OverlayState) => {
    const changed = m.state !== lastState;
    lastState = m.state;
    void broker.use().then((use) => {
      if ("conn" in use) {
        use.conn.send({ op: "overlay", ...m, hosts, hostServers, ...focus });
        if (changed) log("overlay_sent", { state: m.state, via: "app", pid: use.conn.hello?.pid ?? null, hosts, ...focus });
      } else if (!saidNoApp) {
        saidNoApp = true;
        log("overlay_sent", { state: m.state, via: "nowhere", why: use.why });
      }
    });
  };

  // Kiko's tmux clients, and whether Kiko's window counts as in front (tmux's flag, or Rex's say of whether it's drawn: kikoFocus): asked
  // as the overlay comes up, then at most once a second while it would show, never while it's idle.
  // True when an answer is on its way (the overlay waits for it as it comes up).
  const listClients = () => tmuxRunner()(["list-clients", "-F", CLIENTS_FORMAT]);
  const hooks = focusHooks();
  let by = "";
  let why = "";
  let focusTimer: NodeJS.Timeout | undefined;
  const askFocus = (): boolean => {
    if (asking || Date.now() - focusAt < FOCUS_MS) return false;
    asking = true;
    void kikoFocus(pane, listClients, hooks).then((found) => {
      asking = false;
      focusAt = Date.now();
      const f = found.focus;
      // Logged as it changes: what it says, who said it, or why (another block taking the focus in Kiko's tab says so).
      if (JSON.stringify(f) !== JSON.stringify(focus) || found.by !== by || (found.why ?? "") !== why) {
        focus = f;
        by = found.by;
        why = found.why ?? "";
        log("overlay_focus", { pane: pane ?? null, ...f, rule: found.rule, by: found.by, tmuxFocused: found.tmux, ...(found.why ? { why: found.why } : {}), ms: found.ms });
        last = "";
      }
      update();
      // Asked again while the overlay would show (a tab changed while Kiko speaks), never once it's idle.
      clearTimeout(focusTimer);
      if (lastState !== "idle") focusTimer = setTimeout(() => lastState !== "idle" && askFocus(), FOCUS_MS).unref();
    });
    return true;
  };

  function update() {
    const s = ui.state;
    const now = Date.now();
    const id = s.permission?.id ?? null;
    if (id !== permissionId) {
      permissionId = id;
      needsUntil = id ? now + NEEDS_MS : 0;
    }
    if (!s.speaking) saying = null;
    else {
      if (!saying) speakingSince = now;
      saying = sayingNow(heard(), said, speakingSince, now, saying);
    }
    const m = overlayState(s, now, said, needsUntil, saying);
    // Kiko speaking: looked at again in a moment, for the words said since and the sound's level.
    clearTimeout(speakTimer);
    if (m.state === "speaking") speakTimer = setTimeout(update, LEVEL_MS).unref();
    // Re-looked at when "sent" or "needs" runs out.
    clearTimeout(timer);
    const ends = m.state === "sent" && s.routed ? s.routed.at + SENT_MS : m.state === "needs" ? needsUntil : 0;
    if (ends) timer = setTimeout(update, Math.max(0, ends - now) + 20).unref();
    // Coming up: sent once tmux has said where Kiko's window is (asked now, or already being asked).
    if (m.state !== "idle" && (askFocus() || asking) && lastState === "idle") return;
    const json = JSON.stringify(m);
    if (json === last) return;
    last = json;
    send(m);
  }

  ui.on("line", (line: Line) => {
    if (line.kind === "spoken" || line.kind === "voice") said = { text: line.text, name: line.kind === "spoken" ? (line.name ?? NAME) : NAME };
  });
  ui.on("change", update);
}

/** The states `kiko-dev _overlay-test` shows, each for `ms`. */
export const TEST_STATES: OverlayState[] = [
  { state: "listening", text: "", level: 0.1 },
  { state: "listening", text: "Testing the overlay, one two three", level: 0.4 },
  { state: "deciding", text: "Testing the overlay, one two three" },
  { state: "sent", session: "kiko" },
  { state: "speaking", session: NAME, text: "This is what Kiko saying something looks like.", level: 0.6 },
  { state: "needs", session: "kiko", text: "wants to run npm test" },
];

/**
 * `kiko-dev _overlay-test`: each overlay state for ~2 s through the running helper app (started
 * if none runs), whatever app is in front (no focus sent: shown even over this terminal), and what
 * the app says about each. Kiko Dev's prototype: the release says it has none.
 */
export async function overlayTest(say: (line: string) => void = (l) => console.log(l), ms = 2000, via: Broker = broker): Promise<number> {
  if (!DEV) {
    say(`The overlay is a ${NAME} Dev prototype: not in the release.`);
    return 1;
  }
  if (process.platform !== "darwin") {
    say("The overlay is the Mac's.");
    return 1;
  }
  const decided = overlayDecision();
  if (!decided.on) say(`Note: ${OWN.command} itself wouldn't show it (${decided.why}); showing it anyway.`);
  const got = await helperAppConn(via);
  if ("why" in got) {
    say(`${OWN.helperApp} can't be used: ${got.why}`);
    return 1;
  }
  const { conn, hello, diskBuild } = got;
  say(`${OWN.helperApp} pid ${hello?.pid ?? "?"}, build ${hello?.build ?? "?"}.`);
  if (hello && diskBuild && hello.build !== diskBuild)
    say(`The running ${OWN.helperApp} is an older build than the one on disk (${diskBuild}): quit ${OWN.command} and start it again, then try this again.`);
  let onScreen = false;
  const heard = (m: Record<string, unknown>) => {
    const { op: _op, event, ...fields } = m;
    if (event === "overlay_app_panel" && fields.onScreen === true) onScreen = true;
    say(`  ${OWN.helperApp}: ${String(event)} ${JSON.stringify(fields)}`);
  };
  conn.on("log", heard);
  const show = (m: OverlayState) => conn.send({ op: "overlay", ...m, hosts: [], hostServers: {}, hostPids: [], kikoFocused: null });
  for (const m of TEST_STATES) {
    say(`${m.state}${m.text ? `: ${m.text}` : ""}${m.session ? ` (${m.session})` : ""}`);
    show(m);
    await sleep(m.state === "listening" && !m.text ? ms / 2 : ms);
  }
  show({ state: "idle" });
  await sleep(500);
  conn.off("log", heard);
  // Only a connection of this command's own is closed: the broker's stays for any helper it started.
  if (conn !== (via.last && "conn" in via.last ? via.last.conn : null)) conn.close();
  say(
    onScreen
      ? "Done: the app put the overlay on screen."
      : `The app never said the overlay was on screen: an older ${OWN.helperApp} (from before this test)? Quit ${OWN.command}, start it again, and try this again.`,
  );
  return onScreen ? 0 : 1;
}
