// Which agent (Claude Code, Codex; OpenCode and Pi later) a new session starts in when
// you don't name one. The agents to choose from are the registry's (agents/index.ts
// offeredStarters: each that starts sessions and is connected), passed in by id; nothing here
// knows any agent by name.
//
//   named        "start a Codex session in clipkit" (decide.ts namedAgent): that one, never asked
//   only         one agent can start sessions: that one, no picker, no question, the words as ever
//   preselected  otherwise: the run's (`kiko codex` preselects Codex until the next plain
//                `kiko`: tmux/window.ts NEW_AGENT_OPTION), else the "New sessions in" setting:
//                "last used" (the default: the agent the last session started from Kiko was in,
//                by any route) or the one pinned there; else the first offered (the main agent)
//
// From the window (c, "+ new session", the menu's New session) more than one asks which, in a
// popup (src/ui/agent-picker.ts), the preselected row chosen, so Enter alone repeats it. By voice
// (and the phone's words, which go the same way) it's never asked: the preselected one starts, and
// what's said names it ("Starting a Codex session in clipkit."), only when more than one can start.
// The app logs each choice (`harness_picked`, with `how`: named, only, picker, voice, preselected).
import { dirname } from "node:path";
import type { StartPlace } from "./projects.ts";
import { folderName, spoken } from "./sessions.ts";
import { LAST_USED } from "./settings.ts";

/** Why an agent is the one preselected: the only one, the run's (`kiko codex`), the last used, the one pinned in the setting, or the first (none of those offered). */
export type Why = "only" | "run" | "last used" | "pinned" | "first";
export type Preselected = { id: string; why: Why };

/** How the agent of a new session was picked, as logged (harness_picked). */
export type HowPicked = "named" | "only" | "picker" | "voice" | "preselected";

/**
 * The agent preselected among `offered` (agents' ids, the main one first): the only one; else the
 * run's; else, with the setting at "last used", the last used, and with an agent pinned there, that
 * one; else (that one isn't offered now: disconnected, say) the last used; else the first.
 */
export function preselect(offered: readonly string[], o: { run?: string | null; lastUsed?: string | null; setting: string }): Preselected {
  if (offered.length <= 1) return { id: offered[0] ?? "", why: "only" };
  const has = (id: string | null | undefined): id is string => Boolean(id) && offered.includes(id!);
  if (has(o.run)) return { id: o.run, why: "run" };
  if (o.setting !== LAST_USED && has(o.setting)) return { id: o.setting, why: "pinned" };
  if (has(o.lastUsed)) return { id: o.lastUsed, why: "last used" };
  return { id: offered[0], why: "first" };
}

/** More than one agent can start sessions: the window asks which. */
export const asksWhich = (offered: readonly string[]) => offered.length > 1;

/**
 * The agent of a new session nobody is asked about (by voice, the phone's words, or the window when
 * only one can start): `named` when it's one that starts sessions (`startable`), else the only one
 * offered, else the preselected one (`how`: "voice" for words, "preselected" for the window).
 */
export function chooseUnasked(o: {
  named?: string | null;
  startable: readonly string[];
  offered: readonly string[];
  run?: string | null;
  lastUsed?: string | null;
  setting: string;
  by: "voice" | "window";
}): { id: string; how: HowPicked; preselected: Preselected } {
  const preselected = preselect(o.offered, o);
  if (o.named && o.startable.includes(o.named)) return { id: o.named, how: "named", preselected };
  if (!asksWhich(o.offered)) return { id: preselected.id, how: "only", preselected };
  return { id: preselected.id, how: o.by === "voice" ? "voice" : "preselected", preselected };
}

/**
 * Whether what's said names the agent: when more than one can start sessions, or the one starting
 * isn't among them (named, not connected). One agent only: the words are as they always were.
 */
export const namesAgent = (offered: readonly string[], id: string) => asksWhich(offered) || !offered.includes(id);

/** "a Codex session", "an OpenCode session": an agent's session, said. */
export const sessionKind = (name: string) => `${/^[aeiou]/i.test(name) ? "an" : "a"} ${name} session`;

/**
 * What's said as a new session opens, for where it opens (`cwd`: its folder; `there`: a new
 * project's folder was there already; `name`: the name it was given). `kind` names its agent
 * ("a Codex session": sessionKind), when namesAgent says to; null: the words as they always were.
 */
export function openingLine(where: StartPlace, o: { cwd: string; name: string; there: boolean; kind: string | null }): string {
  const { kind } = o;
  switch (where.kind) {
    case "project": {
      const close = where.how === "close" ? `, the closest to ${where.said}` : "";
      const project = spoken(where.how === "close" ? where.name : where.said);
      return kind ? `Starting ${kind} in ${project}${close}.` : `Opening ${project}${close}.`;
    }
    case "home":
      return kind ? `Starting ${kind} in your home folder.` : "Opening one in your home folder.";
    case "new": {
      const project = spoken(folderName(o.cwd));
      const parent = folderName(dirname(o.cwd));
      if (o.there) return kind ? `There's already a ${project} in ${parent}, so I'm starting ${kind} there.` : `There's already a ${project} in ${parent}, so I'm opening that.`;
      return kind ? `Making ${project} in ${parent} and starting ${kind} there.` : `Making ${project} in ${parent} and opening it.`;
    }
    case "scratch":
      if (where.said) return kind ? `I don't know ${where.said}, so I'm starting ${kind} in a scratch folder.` : `I don't know ${where.said}, so I'm opening it in a scratch folder.`;
      if (o.name) return kind ? `Starting ${kind} named ${o.name} in a scratch folder.` : `Opening ${o.name} in a scratch folder.`;
      return kind ? `Starting ${kind} in a scratch folder.` : "Opening a new session in a scratch folder.";
  }
}

/** Where a new session opens, as the window's picker says it ("New session in clipkit"). */
export function placeWords(where: StartPlace): string {
  switch (where.kind) {
    case "project":
      return where.name;
    case "home":
      return "your home folder";
    case "new":
      return `${folderName(where.cwd)} (new)`;
    case "scratch":
      return "a scratch folder";
  }
}

/** A few words on why a row is the one chosen as the picker opens; "" for none. */
export function whyWords(why: Why): string {
  return { only: "", run: "this run", "last used": "last used", pinned: "your setting", first: "" }[why];
}
