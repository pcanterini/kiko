// The Kiko window's bottom line: the app's state in one line, from the UI store, as a tmux
// format (its status line draws it: src/terminals/tmux/window.ts). What it's doing (ready,
// listening, deciding, speaking), who waits for you, and how to talk. Your words show only while
// you say them (the key held, hands-free listening): once you let go they're gone from it, never
// left there frozen while Kiko works them out, nor after (Kiko's page has them).
//
// The state is worked out once, as spans (doing, waitingOn): drawn here as a tmux format, and in
// the window's classic look (tmux 3.8 and later) as its header's left side (src/ui/classic.ts).
import { NAME, spokenName } from "../core/name.ts";
import { sessionName } from "../core/sessions.ts";
import { sessionStatus, type UiState } from "../core/ui-store.ts";
import { menuKeyName } from "../terminals/tmux/keys.ts";

const SYMBOLS: Record<string, string> = { option: "⌥", command: "⌘", control: "⌃", shift: "⇧" };

/** The talk key as written on a Mac keyboard: right_option → "right ⌥", f13 → "F13". */
export function keyName(hotkey: string): string {
  const sided = /^(left|right)_(option|command|control|shift)$/.exec(hotkey);
  if (sided) return `${sided[1]} ${SYMBOLS[sided[2]]}`;
  if (/^f\d+$/.test(hotkey)) return hotkey.toUpperCase();
  if (hotkey.startsWith("keycode:")) return `key ${hotkey.slice(8)}`;
  return hotkey.replace(/_/g, " ") || "the talk key";
}

/** Text on one line (line breaks as spaces), cut to `max` with "…". */
export function cut(text: string, max = 60) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Text as itself in a tmux format: "#" doubled twice (the bar is expanded once as an option, `E:`,
 * then drawn, and each turns "##" into "#"), but hashes right before "[" doubled once (`E:` keeps
 * "##[" as it is, for the drawing to show as "#["; checked live: window-live.test.ts). So "#(",
 * "#{" and "#[" are shown, never run or styled.
 */
const escaped = (text: string) => text.replace(/#+\[|#/g, (m) => (m.endsWith("[") ? `${"##".repeat(m.length - 1)}[` : "####"));

/** Text as itself in a tmux format (escaped, above), on one line, cut to `max` with "…". */
export function literal(text: string, max = 60) {
  return escaped(cut(text, max));
}

/** The end of what's being said, so the newest words show. */
const tail = (text: string, max = 50) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `…${flat.slice(-(max - 1))}` : flat;
};

const ROUTED_SHOWN_MS = 1500;

/**
 * A piece of the state's words: the words as they are (never a format: each drawing makes them
 * text its own way), and how they look, in the terminal's palette. `session`: the session they
 * name, for a drawing that colours a name by its agent (the window's header).
 */
export type Span = { text: string; fg?: "red" | "yellow" | "green" | "magenta" | "cyan"; bold?: boolean; session?: string | null };

/**
 * What the app is doing, first on the line: the spans the bottom line shows, and which state it is,
 * for a drawing that shows some its own way (the window's header: listening as a red badge and the
 * mic's waveform, deciding and checking with a spinner). `by`: hands-free's (the name heard, a reply).
 */
type Doing = { kind: "listening" | "holding" | "deciding" | "routed" | "speaking" | "checking" | "ready"; spans: Span[]; by?: "name" | "reply" | null };

/** A press's mic not giving sound yet (UiState micConnecting), as each drawing of listening says it in place of the level. */
export const connectingTo = (name: string) => `connecting to ${cut(name, 30)}…`;

/** What the app is doing (Doing). */
export function doing(s: UiState, now = Date.now()): Doing {
  if (s.listening) {
    const who = s.handsFree.by === "reply" ? " (reply)" : "";
    const said: Span[] = s.interim ? [{ text: ` “${cut(tail(s.interim))}”` }] : s.micConnecting ? [{ text: ` ${connectingTo(s.micConnecting)}`, fg: "yellow" }] : [];
    return { kind: "listening", by: s.handsFree.by, spans: [{ text: `● listening${who}`, fg: "red", bold: true }, ...said] };
  }
  // Held a moment, then sent: one line that only changes its word ("sending to → pixie", "sent to → pixie").
  if (s.holding) return { kind: "holding", spans: [{ text: "sending to → " }, { text: cut(s.holding.to, 30), bold: true, session: s.holding.sessionId }] };
  if (s.deciding) return { kind: "deciding", spans: [{ text: "… deciding", fg: "yellow" }] };
  if (s.routed && now - s.routed.at < ROUTED_SHOWN_MS) return { kind: "routed", spans: [{ text: "sent to → " }, { text: cut(s.routed.to, 30), bold: true, session: s.routed.sessionId }] };
  if (s.speaking) return { kind: "speaking", spans: [s.muted ? { text: "muted", fg: "magenta" } : { text: "♪ speaking", fg: "magenta", bold: true }] };
  if (s.checking) return { kind: "checking", spans: [{ text: "… checking", fg: "yellow" }] };
  const what = s.handsFree.on ? `${NAME} is listening for “${spokenName()}”` : `${NAME} is ready`;
  return { kind: "ready", spans: [{ text: "●", fg: "green" }, { text: ` ${what}` }] };
}

/**
 * Who waits for you: the one whose window is open first (a reply's as "waiting for reply" and the
 * seconds its window has left, ticking: barTicks), then any other that needs you; each one's spans.
 */
export function waitingOn(s: UiState, now = Date.now()): Span[][] {
  const out: Span[][] = [];
  const named = new Set<string>();
  if (s.waiting) {
    const name = cut(s.waiting.name, 24);
    const session = s.waiting.sessionId;
    out.push([
      s.waiting.kind === "permission"
        ? { text: `⚠ ${name} needs you`, fg: "red", bold: true, session }
        : { text: `◆ waiting for reply${s.waiting.until === null ? "" : ` ${Math.max(0, Math.ceil((s.waiting.until - now) / 1000))}s`}`, fg: "yellow", session },
      // Hands-free, with someone else talking around the app's words: the name is needed this time.
      ...(s.waiting.needsName && s.handsFree.on ? [{ text: ` · say “${spokenName()}” first` }] : []),
    ]);
    named.add(s.waiting.sessionId);
  }
  for (const session of s.sessions) {
    if (named.has(session.sessionId) || sessionStatus(session, s) !== "needs_you") continue;
    out.push([{ text: `⚠ ${cut(sessionName(session), 24)} needs you`, fg: "red", session: session.sessionId }]);
  }
  // Then the ones that stopped on a question of their own (a background job asking what next): nothing held, no hurry.
  for (const session of s.sessions) {
    if (named.has(session.sessionId) || sessionStatus(session, s) !== "waiting") continue;
    out.push([{ text: `◆ ${cut(sessionName(session), 24)} waits for you`, fg: "yellow", session: session.sessionId }]);
  }
  return out;
}

/** Something to tell you for a while (the window's: "Your tmux uses Ctrl+Space, so…"), in yellow; nothing for "". */
export const noticeSpans = (notice: string): Span[][] => (notice ? [[{ text: cut(notice, 110), fg: "yellow" }]] : []);

/** Spans as a tmux format: the words escaped (text, never a format), a styled span ended with #[default]. */
function tmuxSpans(spans: Span[]): string {
  return spans
    .map((x) => {
      const style = [x.fg && `fg=${x.fg}`, x.bold && "bold"].filter(Boolean).join(",");
      return style ? `#[${style}]${escaped(x.text)}#[default]` : escaped(x.text);
    })
    .join("");
}

/** How to talk, and the menu's key, on the right. */
function howToTalk(s: UiState): string {
  // The key's name is from settings (a hand-edited one could hold "#("): as text, like everything else.
  const key = literal(keyName(s.about.hotkey), 30);
  const talk = s.about.pttMode === "tap" ? "space in the list to talk" : `hold ${key} to talk`;
  return `${s.handsFree.on ? `say “${spokenName()}, …” or ` : ""}${talk} · ${menuKeyName()} menu`;
}

/**
 * The line, as a tmux format. `notice`: something to tell you for a while, after what Kiko is
 * doing (the window's: "Your tmux uses Ctrl+Space, so…").
 */
export function barText(s: UiState, now = Date.now(), notice = ""): string {
  // The talk key not heard (app/talk-key.ts): in yellow, until it is.
  const keyOff: Span[][] = s.talkKeyOff && s.about.pttMode === "hold" ? [[{ text: cut(s.talkKeyOff, 120), fg: "yellow" }]] : [];
  // The microphone not allowed (app/mic-permission.ts): in yellow too, however you talk.
  const micOff: Span[][] = s.micOff ? [[{ text: cut(s.micOff, 120), fg: "yellow" }]] : [];
  const parts = [doing(s, now).spans, ...micOff, ...keyOff, ...noticeSpans(notice), ...waitingOn(s, now)].map(tmuxSpans);
  if (s.muted && !s.speaking) parts.push("#[dim]muted#[nodim]");
  // The free trial (app/settings/account.ts): short and dim, yellow near its end.
  if (s.plan) parts.push(s.plan.warn ? tmuxSpans([{ text: cut(s.plan.text, 30), fg: "yellow" }]) : `#[dim]${literal(s.plan.text, 30)}#[nodim]`);
  // A newer Kiko (core/updates/): last, in cyan.
  if (s.update) parts.push(tmuxSpans([{ text: cut(s.update, 60), fg: "cyan" }]));
  return `${parts.join(" #[dim]·#[nodim] ")}#[align=right]#[dim]${howToTalk(s)} `;
}

/** Whether the line can change with time alone (a "sent to → pixie" that goes after a moment, a reply's seconds counting down). */
export const barTicks = (s: UiState, now = Date.now()) => Boolean((s.routed && now - s.routed.at < ROUTED_SHOWN_MS) || (s.waiting?.kind === "reply" && s.waiting.until !== null));
