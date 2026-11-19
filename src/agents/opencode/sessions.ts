// OpenCode's sessions that are open now. Its background service keeps every session ever made, keeps
// one after the TUI that showed it quits (words sent to it then run a turn nobody sees), and doesn't
// say which ones a TUI shows. So a session is listed only while an OpenCode TUI runs in its folder
// (./processes.ts) and it was made, used or looked at since that TUI started (its time.created,
// .updated, .viewed): a TUI quitting takes its sessions with it, and a new TUI there lists only what
// it makes or uses. Its tabs (OpenCode's TUI keeps them in $XDG_STATE_HOME/opencode/<channel>/tui/
// tabs.json, by folder or for all, from one run to the next: read only, never written) never list
// one by themselves: a new TUI shows the last one's tabs again, and an old session there (one sent
// words after its TUI had quit, say) isn't open until it's used.
// Where they hold this run's sessions (tabs are on), one used this run that's no longer a tab
// (closed there, or made by another client: `opencode run`, the web app) is left out too.
// The one used last in a folder with one TUI is the one in front: it gets that TUI's process, so
// tmux finds its pane, Ghostty its window and Close its process; the others (its other tabs, or
// two TUIs in one folder) have none, and take words through the service (Agent.message), never keys.
//
// A TUI opened with nothing typed yet has no session: OpenCode makes one at its first message (in
// Kiko's tmux its pane is listed all the same: Agent.runsAs, app/starting.ts adoptPanes).
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { envVar } from "../../core/name.ts";
import type { AgentSession } from "../types.ts";
import type { Tui } from "./processes.ts";
import type { OpenCodeSession } from "./service.ts";

/** The adapter's id: an OpenCode session is listed with it (AgentSession.agent). */
export const OPENCODE_AGENT = "opencode";

/** OpenCode's state folder: KIKO_OPENCODE_STATE (the tests'), else $XDG_STATE_HOME/opencode. Only read here. */
const stateDir = () => envVar("OPENCODE_STATE") || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode");

/**
 * The sessions OpenCode's TUIs have open as tabs, by folder ("" for those kept for every folder),
 * from each channel's tabs.json; empty when there's none or it can't be read.
 */
export function readTabs(dir = stateDir()): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (cwd: string, tabs: unknown) => {
    if (!Array.isArray(tabs)) return;
    const ids = out.get(cwd) ?? new Set<string>();
    for (const t of tabs) if (typeof t?.sessionID === "string") ids.add(t.sessionID);
    out.set(cwd, ids);
  };
  let channels: string[];
  try {
    channels = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out;
  }
  for (const channel of channels) {
    try {
      const j = JSON.parse(readFileSync(join(dir, channel, "tui", "tabs.json"), "utf8"));
      add("", j?.global?.tabs);
      if (j?.cwd && typeof j.cwd === "object") for (const [cwd, state] of Object.entries<any>(j.cwd)) add(cwd, state?.tabs);
    } catch {}
  }
  return out;
}

/** When a session was last made, used or looked at (ms epoch). */
export const touched = (s: OpenCodeSession) => Math.max(s.created, s.updated, s.viewed);

/** A TUI's start, read to the second (`ps`): a session touched within this much before it counts as since. */
const SLACK_MS = 2000;

/** A session made this recently may not be among its TUI's tabs yet (OpenCode writes them a moment after). */
const NEW_TAB_MS = 10_000;

/**
 * One session open in a TUI, as `openSessions` picks it: its TUI's process when it's the one in
 * front, and every TUI in its folder (`tuis`: it's open while one of them still runs).
 */
export type Open = { session: OpenCodeSession; tui: Tui | null; tuis: Tui[] };

/**
 * The sessions open now: in each folder a TUI runs in, those touched since the TUI there started
 * (`inFolder`: the folder's top-level sessions, as the service gave them), the one touched last
 * first, with that TUI's process when the folder has only one TUI. A folder with a TUI whose start
 * couldn't be read lists nothing (unsure: better unlisted than sent words no TUI shows). `tabs` (by folder,
 * and "" for every folder) only ever leave one out: once one touched since is a tab (tabs are on
 * there), one touched since that isn't, and wasn't made in the last moment (`now`), isn't open.
 */
export function openSessions(tuis: readonly Tui[], inFolder: ReadonlyMap<string, readonly OpenCodeSession[]>, tabs: ReadonlyMap<string, ReadonlySet<string>>, now = Date.now()): Open[] {
  const out: Open[] = [];
  const folders = new Map<string, Tui[]>();
  for (const t of tuis) folders.set(t.cwd, [...(folders.get(t.cwd) ?? []), t]);
  for (const [cwd, here] of folders) {
    if (here.some((t) => !(t.startedAt > 0))) continue;
    const since = Math.min(...here.map((t) => t.startedAt)) - SLACK_MS;
    const tabbed = new Set([...(tabs.get(cwd) ?? []), ...(tabs.get("") ?? [])]);
    const used = (inFolder.get(cwd) ?? []).filter((s) => touched(s) >= since);
    const tabsOn = used.some((s) => tabbed.has(s.id));
    const open = used.filter((s) => !tabsOn || tabbed.has(s.id) || s.created >= now - NEW_TAB_MS).sort((a, b) => touched(b) - touched(a));
    open.forEach((session, i) => out.push({ session, tui: i === 0 && here.length === 1 ? here[0] : null, tuis: here }));
  }
  return out;
}

/** A session as Kiko lists it (AgentSession): busy, blocked (it waits on you) or idle, as `status` says. */
export function describe(o: Open, status: string): AgentSession {
  const s = o.session;
  return {
    sessionId: s.id,
    // OpenCode makes up no name before its title: the folder's, as Kiko shows any.
    name: basename(s.cwd) || s.cwd,
    // Its title: given with Ctrl+R (or Kiko's Rename), or OpenCode's own after its first message.
    givenName: s.title,
    title: "",
    cwd: s.cwd,
    kind: "interactive",
    status,
    lastActiveAt: touched(s),
    desktop: false,
    // OpenCode titles its terminal "OC | <title>" (cut at 40), "OpenCode" before it has one.
    titles: s.title ? [`OC | ${s.title.length > 40 ? `${s.title.slice(0, 37)}…` : s.title}`] : [],
    ...(o.tui ? { pid: o.tui.pid } : {}),
    agent: OPENCODE_AGENT,
  };
}
