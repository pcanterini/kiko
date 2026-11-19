// Which agent a new session starts in, asked in the Kiko window once its folder is picked (c,
// "+ new session", the menu's New session), when more than one can start sessions (core/
// agent-pick.ts). Drawn as the key clash's question and the agents card are (src/ui/menu-view.ts),
// in a popup over the window:
//
//   ╭────────── New session ──────────╮
//   │ New session in clipkit           │
//   │ ─────────────────────────────── │
//   │ ✻  Claude Code                   │
//   │ ⌬  Codex               last used │  ← chosen as it opens
//   │ ─────────────────────────────── │
//   │ Enter starts · ↑↓ picks · Esc cancels
//   ╰──────────────────────────────────╯
//
// One row per agent the registry offers (OpenCode and Pi add rows, nothing else), each with its
// agent's mark in its colour (src/ui/marks.ts, the row's `mark` as the app made it). Nothing waits on
// it: Enter (or a click) sends the app `pickAgent <ask>:<agent id>`, Esc `pickAgent <ask>:` (let go),
// as asks to the list's pane (window.ts askApp); src/ui/window-glue.ts turns them into the "pickAgent" action.
import type { AgentAsk } from "../core/ui-store.ts";
import type { Asker } from "./agents-card.ts";
import type { MenuData, MenuEntry } from "./menu-view.ts";

/** The picker for `h`, its asks made by `ask`. */
export function agentPicker(h: AgentAsk, ask: Asker): MenuData {
  const rows: MenuEntry[] = h.rows.map((r) => ({
    label: r.name,
    ...(r.mark ? { mark: r.mark } : {}),
    ...(r.note ? { note: r.note, noteTone: "dim" as const } : {}),
    run: [ask("pickAgent", `${h.ask}:${r.id}`)],
  }));
  const head: MenuEntry[] = [{ label: `New session in ${h.folder}`, tone: "plain" }, "-"];
  const at = h.rows.findIndex((r) => r.id === h.selected);
  return {
    title: " New session ",
    items: [...head, ...rows, "-", { label: "Enter starts · ↑↓ picks · Esc cancels", tone: "dim" }],
    selected: head.length + Math.max(0, at),
    closed: [ask("pickAgent", `${h.ask}:`)],
  };
}

/** A "pickAgent" ask's arg read back: the ask it answers, and the agent picked (null: let go); null when it isn't one. */
export function agentAnswer(arg: string): { ask: string; agent: string | null } | null {
  const m = /^([A-Za-z0-9_-]+):([A-Za-z0-9._-]*)$/.exec(arg);
  return m ? { ask: m[1], agent: m[2] || null } : null;
}
