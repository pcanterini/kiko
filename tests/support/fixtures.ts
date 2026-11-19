// Fake sessions and conversation state for routing tests: the same shapes src/ works with
// (Session from sessions.ts, SessionNote from router.ts, Timeline.lines strings), built from a
// short spec instead of `claude agents --json`, the terminal adapters and transcripts.
import type { Session } from "../../src/core/sessions.ts";
import { topicLine } from "../../src/core/timeline.ts";

export type VoiceCan = "replies" | "messages" | "everything";

export type SessionSpec = {
  /** The case's handle for it, and what the user calls it: the folder name, its given name, or for a desktop session without a folder, its title. */
  name: string;
  /** Folder basename when it differs from `name` (two sessions in one folder, or a titled desktop session in a folder). */
  folder?: string;
  /** Claude Code's automatic title for the conversation. */
  title?: string;
  /**
   * Its number among sessions in its folder with no names of their own ("kiko 2": 2), as the app
   * gave it (core/session-numbers.ts). Left out, makeWorld numbers them as listed: the first plain.
   */
  number?: number;
  /** The name given with /rename: the session goes by it, with its folder dimmed after it. */
  given?: string;
  /** Who gave it `given`: the user (default) or this app. */
  givenBy?: "user" | "app";
  status?: "busy" | "idle" | "blocked";
  /** Runs in the Claude desktop app. Without `folder`, it lives in a made-up scratch folder and is called by its title. */
  desktop?: boolean;
  /** `claude agents` background session: no terminal, only takes a reply right after it speaks. */
  background?: boolean;
  /** An interactive session whose Ghostty terminal wasn't found. */
  noTerminal?: boolean;
  /** A Codex CLI session: in a terminal, as a Claude Code one is, listed as Codex's. */
  codex?: boolean;
  /** A T3 Code thread: named by its title (`given`), in its project's folder, reached through T3 (no terminal). */
  t3?: boolean;
  activeAgoS?: number;
  /** What it was last asked and last said (router notes and the classifier criteria). */
  asked?: string;
  said?: string;
  /** What the user asked it before that, newest first, as the app's notes list them (Timeline.topics). */
  earlier?: Array<{ minutesAgo: number; text: string }>;
};

export const HOME = "/Users/me";
const scratch = (slug: string) => `${HOME}/Library/Application Support/Claude/scratch-workspaces/0d1e/0d1e/scratch-2026-10-26-${slug}`;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** A Session as listSessions() would return it. IDs are readable: "id-clipkit", "id-2-plus-2". */
export function makeSession(spec: SessionSpec): Session {
  const desktopScratch = Boolean(spec.desktop && !spec.folder);
  const cwd = desktopScratch ? scratch(slug(spec.name).slice(0, 6) || "x") : `${HOME}/git/${spec.folder ?? spec.name}`;
  const kind = spec.background ? "background" : "interactive";
  const typeable = kind === "interactive" && !spec.desktop && !spec.noTerminal && !spec.t3;
  const sessionId = spec.t3 ? `t3:${slug(spec.name)}` : `id-${slug(spec.name)}`;
  return {
    sessionId,
    name: spec.given ?? `${slug(spec.folder ?? spec.name)}-${slug(spec.name).slice(0, 2)}`,
    givenName: spec.given ?? "",
    // A desktop session in a scratch folder is named by its title.
    title: desktopScratch ? (spec.title ?? spec.name) : (spec.title ?? ""),
    nameSetBy: spec.given ? (spec.givenBy ?? "user") : "claude",
    cwd,
    kind,
    status: spec.status ?? "idle",
    lastActiveAt: spec.activeAgoS === undefined ? Date.now() - 60_000 : Date.now() - spec.activeAgoS * 1000,
    // Where the terminal adapters would reach it: its Ghostty window, its T3 thread. None reaches a desktop session.
    place: typeable ? { via: "ghostty", id: `term-${slug(spec.name)}`, keys: true } : spec.t3 ? { via: "t3code", id: slug(spec.name), keys: false } : null,
    mapping: typeable ? "title" : "none",
    desktop: Boolean(spec.desktop),
    ...(spec.t3 ? { agent: "t3code" } : {}),
    // A Codex session: in a terminal like Claude Code's (its Ghostty window here), listed as Codex's.
    ...(spec.codex ? { agent: "codex", bracketed: true } : {}),
    ...(spec.number ? { number: spec.number } : {}),
  };
}

export type World = {
  sessions: Session[];
  byName: Map<string, Session>;
  notes: Map<string, { asked: string; said: string; topics?: string[] }>;
};

export function makeWorld(specs: SessionSpec[]): World {
  const sessions = numbered(specs, specs.map(makeSession));
  const byName = new Map<string, Session>();
  specs.forEach((spec, i) => byName.set(spec.name.toLowerCase(), sessions[i]));
  const notes = new Map(
    specs.map((spec, i) => {
      const topics = (spec.earlier ?? []).flatMap((e) => topicLine(e.text, e.minutesAgo * 60_000) ?? []);
      return [sessions[i].sessionId, { asked: spec.asked ?? "", said: spec.said ?? "", ...(topics.length ? { topics } : {}) }];
    }),
  );
  return { sessions, byName, notes };
}

/**
 * Sessions in one folder with no names of their own numbered as the app numbers them as it lists
 * them (core/sessions.ts numberSessions): the first plain (1), the next 2, a number a spec gives
 * kept. Here rather than through src/, which this file never loads (a test sets the log's folder
 * before src/core/log.ts loads).
 */
function numbered(specs: SessionSpec[], sessions: Session[]): Session[] {
  const groupOf = (spec: SessionSpec) => (spec.given || (spec.desktop && !spec.folder) ? null : slug(spec.folder ?? spec.name));
  const numbers = specs.map((spec) => spec.number ?? 0);
  specs.forEach((spec, i) => {
    const group = groupOf(spec);
    if (group === null || numbers[i]) return;
    const taken = new Set(specs.flatMap((other, j) => (groupOf(other) === group ? [numbers[j]] : [])));
    let n = 1;
    while (taken.has(n)) n++;
    numbers[i] = n;
  });
  const shown = new Set(specs.flatMap((spec, i) => (groupOf(spec) !== null && numbers[i] > 1 ? [groupOf(spec)] : [])));
  return sessions.map((session, i) => {
    const { number: _, ...rest } = session;
    return groupOf(specs[i]) !== null && numbers[i] && (numbers[i] > 1 || shown.has(groupOf(specs[i]))) ? { ...rest, number: numbers[i] } : rest;
  });
}

/** The usual cast: names, titles and kinds as the app lists them. */
export const CAST = {
  voice: {
    name: "claude-code-speech",
    title: "random",
    status: "busy",
    activeAgoS: 20,
  },
  clipkit: { name: "clipkit", title: "ClipKit export window jump", status: "idle", activeAgoS: 40 },
  lacy: { name: "lacy-platform", title: "Shipping rates in secure checkout", status: "idle", activeAgoS: 600 },
  twoPlusTwo: { name: "2 plus 2", desktop: true, status: "idle", activeAgoS: 7200, asked: "What about 20+20?", said: "20 + 20 = 40." },
  random: { name: "random", desktop: true, status: "idle", activeAgoS: 7200, asked: "Voice app test 4: just reply OK.", said: "OK" },
  atlas: { name: "atlas-agents", title: "Shipping rates in secure checkout", status: "busy", activeAgoS: 120 },
  screenapp: { name: "screenapp", title: "ClipKit Library window focus issue", status: "busy", activeAgoS: 22 },
  pixie: { name: "pixie", background: true, status: "blocked" },
  harbor: { name: "harbor", background: true, status: "blocked" },
} satisfies Record<string, SessionSpec>;
