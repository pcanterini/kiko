// The terminal UI (Ink) of the Kiko window's list pane: the list (window-list.ts), and the
// settings screen, which zooms the pane to the whole window. Written with createElement rather than
// JSX, since Node runs the TypeScript directly and doesn't transform JSX.
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, render, useInput, useWindowSize, type Instance } from "ink";
import type { Session } from "../core/sessions.ts";
import { NAME, spokenName } from "../core/name.ts";
import { plainLine } from "../core/text.ts";
import { ui, type Splash as SplashState, type UiState } from "../core/ui-store.ts";
import { colorDepth, type ColorDepth } from "./cli-style.ts";
import { LOGO_MS } from "./logo.ts";
import { FRAME_MS, splashBlock } from "./splash.ts";
import { Meter } from "./meter.ts";
import { connectingTo } from "./bar.ts";
import { Settings } from "./settings.ts";
import { inkInput, MOUSE_OFF, MOUSE_ON } from "./input.ts";
import { splashCtrlC, useQuitAsk, WindowList } from "./window-list.ts";
import { quitHintFor } from "./quit-again.ts";
import { markFor, slotted, type Mark } from "./marks.ts";
import { badge, captionLines, captionWidth, DECIDING_SHOWN_AFTER_MS, Footer, headerRight, spinner } from "./classic.ts";

const h = React.createElement;

/**
 * The colour a session's name is drawn in, on a line about it: its agent's (marks.ts); the
 * terminal's own for one no longer listed.
 */
const agentColor = (sessions: Session[], sessionId: string | null | undefined) => markFor(sessions, sessionId)?.color;
/** A session's name as a card shows it: its agent's mark first, when it's still listed. */
const markedName = (mark: Mark | null, name: string) => (mark ? `${slotted(mark.glyph)}${name}` : name);

function useStore() {
  const [state, setState] = useState<UiState>(ui.state);
  useEffect(() => {
    const update = (s: UiState) => setState(s);
    ui.on("change", update);
    return () => void ui.off("change", update);
  }, []);
  return state;
}

/** Re-renders every `ms` so countdowns move. */
function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
}

// After key up, "deciding…" shows only once working out where your words go takes longer than
// DECIDING_SHOWN_AFTER_MS (classic.ts), so quick ones go straight from listening to where they
// went; that shows this long.
const ROUTED_SHOWN_MS = 1200;

/**
 * The mic's spot in the header: listening while the key is held (hands-free: the name once it's
 * heard it, or "reply" for a reply without it); a send the app wasn't sure of,
 * held a moment ("→ Lacy · holding", in its colour); after key up, where your words went (a
 * spinner first if deciding takes a moment); speaking; a quick task running; else how to talk, or
 * hands-free's "listening for Kiko".
 * Always the same width, so nothing beside it moves between states.
 */
function Mic({ s }: { s: UiState }) {
  // Hands-free: listening for the name all along (the key still works).
  // The talk key not heard (no Input Monitoring: app/talk-key.ts): said in its place, in yellow; the line under says why.
  const keyOff = !s.handsFree.on && s.about.pttMode === "hold" && !!s.talkKeyOff;
  const idle = s.handsFree.on
    ? `◎ listening for “${spokenName()}”`
    : s.about.pttMode === "tap"
      ? "space to talk"
      : keyOff
        ? `${s.about.hotkey.replace(/_/g, " ")} not heard: Input Monitoring`
        : `hold ${s.about.hotkey.replace(/_/g, " ")} to talk`;
  // Spins and times out on its own; the Meter keeps its own pace while listening.
  useTick(!s.listening && (s.deciding || s.routed || s.checking) ? 100 : 60_000);
  const now = Date.now();
  const routed = s.routed && now - s.routed.at < ROUTED_SHOWN_MS ? s.routed : null;
  const shown = s.listening
    ? h(
        Box,
        { gap: 1 },
        h(Text, { backgroundColor: "red", color: "white", bold: true }, badge(s.handsFree.by)),
        // The mic not giving sound yet (a Bluetooth one connecting): said where its level would be flat.
        s.micConnecting ? h(Text, { color: "yellow", wrap: "truncate-end" }, connectingTo(s.micConnecting)) : h(Meter, { level: s.level }),
      )
    : s.holding
      ? h(Text, { wrap: "truncate-end" }, "sending to → ", h(Text, { color: agentColor(s.sessions, s.holding.sessionId), bold: true }, s.holding.to))
      : routed
        ? h(Text, { wrap: "truncate-end" }, "sent to → ", h(Text, { color: routed.sessionId ? agentColor(s.sessions, routed.sessionId) : "yellow", bold: true }, routed.to))
        : s.speaking
          ? h(Text, { backgroundColor: "magenta", color: "white", bold: true }, s.muted ? " MUTED " : " 🔊 SPEAKING ")
          : s.deciding
            ? // Blank for the first moment rather than flashing the hint or a spinner.
              now - s.deciding.startedAt > DECIDING_SHOWN_AFTER_MS
              ? h(Text, { dimColor: true }, `${spinner()} deciding…`)
              : null
            : s.checking
              ? h(Text, { color: "yellow" }, `${spinner()} checking…`)
              : h(Text, { dimColor: !s.handsFree.on && !keyOff, color: s.handsFree.on ? "green" : keyOff ? "yellow" : undefined, wrap: "truncate-end" }, idle);
  // Wide enough for listening and its waveform (24) and the hint.
  return h(Box, { width: Math.max(24, idle.length), flexShrink: 0 }, shown);
}

function Header({ s }: { s: UiState }) {
  // One line, always: the right side truncates rather than wrapping and pushing the layout down
  // (classic.ts headerRight: the window's classic look has the same).
  return h(
    Box,
    { justifyContent: "space-between", paddingX: 1, gap: 2, height: 1 },
    h(Box, { gap: 2, flexShrink: 0 }, h(Text, { bold: true }, `🎙 ${NAME}`), h(Mic, { s })),
    h(Box, { gap: 2, flexShrink: 1, justifyContent: "flex-end" }, ...headerRight(s)),
  );
}

function secondsLeft(until: number) {
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

/** What you're saying, live: a caption over the bottom of the screen once words come in. */
function Caption({ s, columns, bottom }: { s: UiState; columns: number; bottom: number }) {
  const width = captionWidth(columns);
  const lines = captionLines(s.interim, width); // the border and a column each side inside it
  if (!lines.length) return null;
  return h(
    Box,
    {
      position: "absolute",
      bottom,
      left: Math.floor((columns - width) / 2),
      width,
      flexDirection: "column",
      borderStyle: "round",
      borderColor: "red",
      backgroundColor: "black",
      paddingX: 1,
    },
    ...lines.map((line, i) => h(Text, { key: i, color: "white" }, line)),
  );
}

function PermissionCard({ s }: { s: UiState }) {
  const p = s.permission;
  if (!p) return null;
  const left = s.waiting?.kind === "permission" && s.waiting.until !== null ? secondsLeft(s.waiting.until) : 0;
  const mark = markFor(s.sessions, p.sessionId, s.icons);
  // Claude's questions: the one being asked, and how to answer it.
  const q = p.questions?.[p.asking ?? 0];
  if (p.questions && q) {
    const of = p.questions.length > 1 ? ` (${(p.asking ?? 0) + 1} of ${p.questions.length})` : "";
    return h(
      Box,
      { flexDirection: "column", borderStyle: "double", borderColor: "yellow", paddingX: 1 },
      h(
        Text,
        { wrap: "truncate-end" },
        h(Text, { color: "yellow", bold: true }, "? "),
        h(Text, { color: mark?.color, bold: true }, markedName(mark, plainLine(p.name))),
        ` asks${of}:${plainLine(q.header ? `${q.header}: ${q.question}` : q.question)}`,
      ),
      h(
        Box,
        { justifyContent: "space-between", gap: 2, height: 1 },
        h(Text, { wrap: "truncate-end" }, q.options.map((o, i) => `${i + 1} ${plainLine(o.label)}`).join(" · ") || "say your answer", "  ", h(Text, { color: "red", bold: true }, "[n]"), " decline"),
        h(Text, { dimColor: true, wrap: "truncate-start" }, left ? `${left}s, then it's in the terminal` : ""),
      ),
    );
  }
  return h(
    Box,
    { flexDirection: "column", borderStyle: "double", borderColor: p.risky ? "red" : "yellow", paddingX: 1 },
    h(
      Text,
      { wrap: "truncate-end" },
      h(Text, { color: p.risky ? "red" : "yellow", bold: true }, "⚠ "),
      h(Text, { color: mark?.color, bold: true }, markedName(mark, plainLine(p.name))),
      ` wants to${plainLine(p.what)}`,
    ),
    h(
      Box,
      { justifyContent: "space-between", gap: 2, height: 1 }, // one line: the layout reserves 4 rows for the card
      h(
        Text,
        { wrap: "truncate-end" },
        h(Text, { color: "green", bold: true }, "[y]"),
        p.folder || p.means ? " trust  " : " allow  ",
        // A trust question isn't a tool's, and a block allowed anyway is allowed once: no "always".
        p.folder || p.means || p.once ? "" : h(Text, { color: "green", bold: true }, "[a]"),
        p.folder || p.means || p.once ? "" : " always  ",
        h(Text, { color: "red", bold: true }, "[n]"),
        p.folder || p.means ? " don't trust" : " deny",
        p.risky ? h(Text, { color: "red" }, "   risky: say “allow it”") : " · or say yes / no",
      ),
      h(Text, { dimColor: true, wrap: "truncate-start" }, left ? `${left}s, then it's in the terminal` : ""),
    ),
  );
}

/** The list; the settings screen when open (the list's pane zoomed to the whole window); the splash as the window opens. */
function Root() {
  const s = useStore();
  if (s.splash && s.screen === "main") return h(Splash, { splash: s.splash });
  return s.screen === "settings" ? h(SettingsScreen) : h(WindowList, { s });
}

/** The splash's colours: the terminal's (cli-style.ts), looked at once. */
let splashDepth: ColorDepth | null = null;

/**
 * Kiko's logo over the whole window (ui/splash.ts), its effects drawn every FRAME_MS until they're
 * done, then still. Its first frame the one start.ts left on the screen (`drawn`: Ink draws over
 * it without erasing, so it's the same one), then on from the time (ui/splash-handoff.ts). Blank
 * while it's leaving (the pane going back to the list's size: nothing cut short on the way). Any
 * key skips it; Ctrl+C too, and the list comes with quitting's hint up (Ctrl+C again quits, as in
 * the list: window-list.ts splashCtrlC).
 */
export function Splash({ splash }: { splash: SplashState }) {
  const { columns, rows } = useWindowSize();
  const [, tick] = useState(0);
  const first = useRef(splash.drawn);
  const ms = first.current ?? Date.now() - splash.since;
  const playing = !splash.leaving && ms < LOGO_MS;
  useEffect(() => {
    first.current = undefined;
  });
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => tick((n) => n + 1), FRAME_MS);
    return () => clearTimeout(timer);
  });
  useInput((input, key) => {
    if (key.ctrl && input === "c" && splashCtrlC()) return;
    ui.act({ type: "skipSplash" });
  });
  splashDepth ??= colorDepth(process.stdout);
  const block = splash.leaving ? null : splashBlock(columns, rows, playing ? ms : null, { slow: splash.slow, depth: splashDepth });
  return h(
    Box,
    { flexDirection: "column", width: columns, height: rows, paddingTop: block?.top ?? 0 },
    ...(block?.lines ?? []).map((line, i) => h(Text, { key: i, wrap: "truncate-end" }, line || " ")),
  );
}

/** The settings screen over the whole window: the header, the settings, a permission prompt's card, and the footer. */
export function SettingsScreen() {
  const s = useStore();
  const { columns, rows } = useWindowSize();
  useTick(s.waiting ? 250 : 1000);
  // Ctrl+C asks to quit from here too, as in the list (its hint in the footer; Ctrl+C, q or y again
  // quits, another key only lets it go): the settings' own keys wait while it's up.
  const quit = useQuitAsk();
  useInput((input, key) => void quit.take(input, key));
  const middle = rows - 2 - (s.permission ? 4 : 0);
  return h(
    Box,
    { flexDirection: "column", width: columns, height: rows },
    h(Header, { s }),
    h(
      Box,
      { height: middle },
      // Asked for on another row while open (the menu's search found a setting): opened again there.
      // And again for a key's paste (the window's offer: settingsPaste), even on the row it's on.
      h(Settings, { key: `settings:${s.settingsAt ?? ""}${s.settingsPaste ? ":paste" : ""}`, s, width: columns, height: middle, paused: Boolean(quit.asked) }),
      // Last, so it's drawn over the settings, just above their bottom border.
      s.listening ? h(Caption, { key: "caption", s, columns, bottom: 1 }) : null,
    ),
    h(PermissionCard, { s }),
    h(Footer, { s, quit: quit.asked ? quitHintFor(quit.asked.by, columns - 2) : null }),
  );
}

let consoleRouted = false;

/**
 * Anything else that prints (helpers, libraries) goes into the app's lines (Kiko's page) instead of
 * scribbling over the screen: from startTui, or before it (app.ts: while start.ts's splash still
 * has the screen). Once.
 * The same line again soon after is dropped: React warns on every render, and a warning shown
 * here re-renders the screen, so without this a single warning freezes the app.
 */
export function routeConsole() {
  if (consoleRouted) return;
  consoleRouted = true;
  let last = { text: "", at: 0 };
  const once = (text: string, show: (text: string) => void) => {
    if (text === last.text && Date.now() - last.at < 5000) return;
    last = { text, at: Date.now() };
    show(text);
  };
  console.log = (...args: unknown[]) => once(args.map(String).join(" "), ui.info);
  console.error = (...args: unknown[]) => once(args.map(String).join(" "), (text) => ui.error("log", text));
}

export function startTui(): Instance {
  routeConsole();
  // The window's asks and the mouse are read before Ink (input.ts), and the list asks the terminal
  // (tmux) for clicks.
  const stdin = inkInput();
  process.stdout.write(MOUSE_ON);
  process.on("exit", () => process.stdout.write(MOUSE_OFF));
  // Interactive whenever it's a terminal (a tmux pane always is), even with CI set in the shell it
  // came from: Ink's own guess is "not in CI", and non-interactive it draws nothing until it exits.
  return render(h(Root), { stdin: stdin as never, alternateScreen: true, exitOnCtrlC: false, patchConsole: false, maxFps: 30, interactive: Boolean(process.stdout.isTTY) });
}
