// The first-run card: the agents found on this Mac (src/agents/setup.ts cardRows), drawn as the key
// clash's question is (src/ui/menu-view.ts, a checklist):
//
//   ╭──────────────────── Agents ────────────────────╮
//   │ Which coding agents should Kiko talk to?     │
//   │ [x] Claude Code   adds hooks to ~/.claude/settings.json
//   │ [x] Codex         adds hooks to ~/.codex/hooks.json
//   │ [x] T3 Code       not running
//   │  ✓  OpenCode      connected
//   │ ───────────────────────────────────────────────│
//   │ Space ticks · Enter goes on · Esc later         │
//   ╰─────────────────────────────────────────────────╯
//
// Every agent offered starts ticked. T3 Code (nothing to set up) is offered as the others are, as
// first-run setup lists it: ticked, nothing changes; unticked, Kiko leaves it alone
// (agents/setup.ts). In the Kiko window it's a popup over the window (src/ui/window-glue.ts):
// nothing waits on it, and its answer reaches the app as asks (`agentOn` for each one ticked, then
// `agents connect`; `agents later` when it's let go).
import { NAME } from "../core/name.ts";
import type { CardAnswer, CardRow } from "../agents/setup.ts";
import type { MenuData, MenuEntry } from "./menu-view.ts";

/** How an answer reaches the app: one command per ask (window.ts askApp in the window; [verb, arg] in the plain UI). */
export type Asker = (verb: string, arg: string) => string[];

/** The card, its asks made by `ask`. */
export function agentsCard(rows: CardRow[], ask: Asker): MenuData {
  const width = Math.max(...rows.map((r) => r.name.length)) + 2;
  const lines: MenuEntry[] = rows.map((r) =>
    r.ask
      ? { label: r.name.padEnd(width), note: r.detail, noteTone: "dim", check: true, run: [ask("agentOn", r.id)] }
      : { label: `${r.state === "connected" ? " ✓ " : " · "} ${r.name.padEnd(width)}`, note: r.detail, tone: r.state === "connected" ? "plain" : "dim" },
  );
  return {
    title: " Agents ",
    items: [{ label: `Which coding agents should ${NAME} talk to?`, tone: "plain" }, ...lines, "-", { label: "Space ticks · Enter goes on · Esc later", tone: "dim" }],
    submit: [ask("agents", "connect")],
    closed: [ask("agents", "later")],
  };
}

/** The answer the asks carry (each an [verb, arg]), for the agents the card offered. */
export function cardAnswer(asks: { verb: string; arg: string }[], rows: CardRow[]): CardAnswer {
  const offered = rows.filter((r) => r.ask).map((r) => r.id);
  const end = asks.find((a) => a.verb === "agents");
  const later = end?.arg !== "connect";
  const connect = later ? [] : [...new Set(asks.filter((a) => a.verb === "agentOn" && offered.includes(a.arg)).map((a) => a.arg))];
  return { offered, connect, later };
}
