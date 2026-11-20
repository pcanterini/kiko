// Each session's agent mark, wherever a session's name is drawn: the window's list
// (window-list.ts: its rows and its card), the settings screen's cards (tui.ts), and the new-session picker (agent-picker.ts, its rows made by the app). Each
// agent's adapter brings its own (Agent.mark, src/agents/types.ts): a one-cell glyph and its colour,
// so nothing here names an agent and a new adapter brings its mark with it. A session's name is
// drawn in its agent's colour, not one of its own: two Claude Code sessions share Claude Code's
// orange, and their names and numbers tell them apart.
//
// The background is taken to be dark: nothing asks the terminal which it is (the list's cursor row is
// a fixed dark grey too), so each mark's light colour waits for that. Colours go through Ink (chalk),
// as every colour in the TUI does: down to 256 or 16 colours where the terminal has no truecolor,
// none where it has no colour at all. The glyph still tells the agents apart without colour.
//
// Lined up by its slot: every mark gets the same MARK_SLOT cells, the glyph first (one cell as the
// TUI counts it: markOf turns anything else into the plain mark) and blanks after, then the name.
// So every name starts in the same column whatever the glyph, and a glyph the terminal draws wider
// than its cell spills only into its own slot's blank, never into the name. A glyph the font lacks
// comes from a fallback font at that font's width: in the user's Ghostty (FiraMono) ⌬ comes from
// Arial Unicode MS and ✻ from Meslo; in Terminal.app or iTerm2, ⊤ and ⌬ from Apple Symbols (1.25
// and 1.11 cells) and ✻ from Zapf Dingbats with an old Nerd Font (1.18). None reaches two cells, so
// two cells for the glyph and a space before the name. The glyph sits at the slot's left: a leading
// blank wouldn't help, as a glyph only ever spills rightwards. ARCHITECTURE.md, "Agent marks".
import { agentOf } from "../agents/index.ts";
import type { Agent, AgentMark } from "../agents/types.ts";
import { findSession, type Session } from "../core/sessions.ts";
import type { Icons } from "../core/settings.ts";
import { cells, type Speaker } from "./viewer.ts";

/** An agent with no mark of its own: a white diamond, in the terminal's own colour. */
export const PLAIN_MARK: AgentMark = { glyph: "◇" };

/** Cells from a mark's column to its name's: the glyph's two (room for one drawn up to twice as wide) and a space. */
export const MARK_SLOT = 3;

/** A mark's glyph in its slot, ready to have the name after it: "⌬  " (the menus' popup, menu-view.ts, keeps its own copy of this). */
export const slotted = (glyph: string) => glyph + " ".repeat(MARK_SLOT - 1);

/** A mark as drawn: its glyph (its Nerd Font icon with icons "nerd", where it has one), and its colour (undefined: the terminal's own). */
export type Mark = { glyph: string; color: string | undefined };

/** The background the colours are for: dark, always for now (above); the voice glow's palette too (window-glow.ts). */
export const BACKGROUND: "dark" | "light" = "dark";

/**
 * Whether a glyph can be a mark: one character, one cell as Ink counts it and the terminal places
 * it. Not an emoji (two cells, or in colour), East Asian wide, combining, a space, or a control or
 * format character. A Nerd Font icon (Private Use Area) is one.
 */
export function oneCell(glyph: string | undefined): glyph is string {
  if (!glyph || [...glyph].length !== 1) return false;
  return !/[\p{Extended_Pictographic}\p{M}\p{Z}\p{Cc}\p{Cf}\p{Cs}]/u.test(glyph) && cells(glyph) === 1;
}

/** An agent's mark as drawn; no agent, or one with no mark, PLAIN_MARK. A glyph that isn't one cell (oneCell): the plain one, in the agent's colour. */
export function markOf(of: Pick<Agent, "mark"> | null | undefined, icons: Icons = "unicode", background = BACKGROUND): Mark {
  const mark = of?.mark ?? PLAIN_MARK;
  const nerd = icons === "nerd" && oneCell(mark.nerd) ? mark.nerd : undefined;
  return { glyph: nerd ?? (oneCell(mark.glyph) ? mark.glyph : PLAIN_MARK.glyph), color: mark.color?.[background] };
}

/** A session's mark: its agent's. */
export const sessionMark = (session: Session, icons?: Icons): Mark => markOf(agentOf(session), icons);

/**
 * Who answers in a session, for its viewer's heading over the replies (viewer.ts Speaker): its
 * agent's speaker ("Claude", "Codex", "OpenCode"), else its agent's name ("T3 Code": a thread runs on
 * Claude or Codex, which Kiko doesn't read from T3), in its mark's colour.
 */
export function speakerOf(session: Pick<Session, "sessionId" | "agent">): Speaker {
  const agent = agentOf(session);
  const color = markOf(agent).color;
  return { name: agent.speaker?.trim() || agent.name, ...(color ? { color } : {}) };
}

/**
 * The mark of the session a line or card is about, by its ID; null when it's no longer listed: its
 * name is drawn in the terminal's own colour then, with no mark.
 */
export function markFor(sessions: readonly Session[], sessionId: string | null | undefined, icons?: Icons): Mark | null {
  const session = findSession(sessions, sessionId);
  return session ? sessionMark(session, icons) : null;
}
