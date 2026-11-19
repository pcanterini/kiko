// Sessions the app opened that haven't started yet. Claude Code shows "Accessing workspace … ❯ No,
// exit / Yes, I trust this folder" for a folder it doesn't trust (every new scratch folder), and it
// neither registers the session nor runs SessionStart until you answer. Until then the session is
// nowhere in `claude agents`: invisible, unnamed, and words for it went nowhere (a question for it
// was lost while it waited at that prompt).
//
// So each one the app opens is kept here (its tmux pane, folder, given name, when) and listed as
// "starting" (STARTING) under an ID of its own, so the window, the phone and the router see it and
// can name it. Once it's listed by its agent it's matched to the one kept here: by its pane (tmux
// finds a listed session's pane by its process), else by its folder (a session there that wasn't
// listed when it opened), and the app types in what was held for it. Never before: nothing is
// typed into the trust prompt. One that hasn't started after startingWaitMs() (10s) needs you (listed as
// "blocked"); the app says so once. Platform-neutral: the app asks the terminal what's in its pane.
import { randomUUID } from "node:crypto";
import { envVar } from "./name.ts";
import { folderName, STARTING, type Session } from "./sessions.ts";

/** What a session the app opened is called while it starts, said: its name, else its folder without a scratch folder's date ("2026-10-29-look-readme" → "look readme"). */
export function calledOf(entry: { name: string; cwd: string }) {
  return (
    entry.name ||
    folderName(entry.cwd)
      .replace(/^\d{4}-\d{2}-\d{2}-(?=.)/, "")
      .replace(/[-_]+/g, " ")
  );
}

/**
 * Not started after this long: it needs you in its window (the trust prompt, most likely).
 * KIKO_STARTING_WAIT_MS sets it (the harness: longer, so sessions its cases open and never start
 * stay quiet), read each time.
 */
export const startingWaitMs = () => Number(envVar("STARTING_WAIT_MS") ?? 10_000);
/** Still not started after this long: given up on, as if it had ended. */
export const STARTING_GIVE_UP_MS = 30 * 60_000;

/** What runs in the pane a session was opened in: its program ("running"), its shell again ("shell"), or nothing ("gone"). */
type PaneState = "running" | "shell" | "gone";

/** Who opened a session or asked for something: said ("voice"), the window (its picker or menus), or the phone. */
export type By = "voice" | "window" | "phone";

/** A session the app opened that hasn't started yet. */
export type Starting = {
  /** Its own ID while it starts: "starting-<8 hex>" (letters, digits and "-": a window ask can carry it). */
  id: string;
  cwd: string;
  /** The name it was given ("" for none): what it's called while it starts, and after. */
  name: string;
  /** Who opened it, when the app did: said ("voice"), the window's picker, or the phone's sheet. */
  by?: By;
  /** The first message on its command line ("" for none): sent again once if Claude Code couldn't log in for it (core/login-check.ts). */
  prompt: string;
  /** The terminal adapter that opened it, and its handle there (tmux: its pane, "%12"); null when it gave none. */
  via: string;
  handle: string | null;
  at: number;
  /** How long it may take to start before it needs you: startingWaitMs() when it opened. */
  waitMs: number;
  /** The IDs of the sessions listed when it opened: one of them in its folder isn't it. */
  known: ReadonlySet<string>;
  /** Waited past startingWaitMs(): listed as needing you, and said once. */
  needsYou: boolean;
  /** Its program was seen in its pane: the shell in front again means it ended. */
  seenRunning: boolean;
  /** Opened for Claude Code's trust prompt in the scratch folder (trust-scratch), not to work in. */
  purpose: "work" | "trust";
  /** The agent it was started in, when that isn't the main one (a Codex session: its id); only a session of that agent's is it. */
  agent?: string;
  /**
   * Its window shows it ready for its first message (Agent.readyOnScreen: Codex, which lists a
   * session only from then): words for it are typed in now, and it doesn't need you for waiting.
   */
  atPrompt: boolean;
  /**
   * Not opened by the app: found running in a pane of Kiko's tmux that no listed session is in
   * (`kiko codex`, or started in a shell there: Agent.runsAs). Listed from its pane all the same;
   * its pane closing before its agent lists it is noted, not said.
   */
  adopted?: boolean;
};

export type Matched = { entry: Starting; session: Session; by: "pane" | "folder" };

export class StartingSessions {
  private entries: Starting[] = [];
  // A started session's real ID → the ID it had while it started, so words and the target noted
  // under it still find it (an alias). The newest few.
  private started = new Map<string, string>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  add(e: {
    cwd: string;
    name: string;
    prompt?: string;
    via: string;
    handle?: string | null;
    known: Iterable<string>;
    purpose?: Starting["purpose"];
    agent?: string;
    adopted?: boolean;
    by?: Starting["by"];
  }): Starting {
    const entry: Starting = {
      id: `${STARTING}-${randomUUID().slice(0, 8)}`,
      cwd: e.cwd,
      name: e.name.trim(),
      prompt: e.prompt ?? "",
      via: e.via,
      handle: e.handle ?? null,
      at: this.now(),
      waitMs: startingWaitMs(),
      known: new Set(e.known),
      needsYou: false,
      seenRunning: false,
      purpose: e.purpose ?? "work",
      ...(e.agent ? { agent: e.agent } : {}),
      atPrompt: false,
      ...(e.adopted ? { adopted: true } : {}),
      ...(e.by ? { by: e.by } : {}),
    };
    this.entries.push(entry);
    return entry;
  }

  all(): readonly Starting[] {
    return this.entries;
  }

  get(id: string | null | undefined): Starting | undefined {
    return id ? this.entries.find((e) => e.id === id) : undefined;
  }

  remove(id: string) {
    this.entries = this.entries.filter((e) => e.id !== id);
  }

  /** Its pane, once the terminal says (tmux tells it as it opens). */
  setHandle(id: string, handle: string) {
    const e = this.get(id);
    if (e) e.handle = handle;
  }

  /**
   * The listed sessions that are ones kept here, each taken out and returned: by its pane (the
   * listed session's place there), else by its folder (an interactive session there that wasn't
   * listed when it opened, and that no other kept here has). The oldest kept first.
   */
  match(listed: readonly Session[]): Matched[] {
    const out: Matched[] = [];
    const taken = new Set<string>();
    for (const entry of [...this.entries]) {
      const free = listed.filter((s) => !taken.has(s.sessionId) && !this.started.has(s.sessionId));
      let session = entry.handle ? free.find((s) => s.place?.via === entry.via && s.place.id === entry.handle) : undefined;
      let by: Matched["by"] = "pane";
      if (!session) {
        session = free.find((s) => s.cwd === entry.cwd && s.kind === "interactive" && s.agent === entry.agent && !entry.known.has(s.sessionId) && !(s.aliases ?? []).some((a) => entry.known.has(a)));
        by = "folder";
      }
      if (!session) continue;
      taken.add(session.sessionId);
      this.remove(entry.id);
      this.started.set(session.sessionId, entry.id);
      if (this.started.size > 50) this.started.delete(this.started.keys().next().value!);
      out.push({ entry, session, by });
    }
    return out;
  }

  /**
   * The IDs a session that just took a prompt in may have had while it started here: the one it
   * had, once it's been matched; else, for a session no listing has shown yet (`listed` false),
   * those of every one still starting. Its first prompt can come before the listing that matches
   * it: Claude Code's SessionStart and UserPromptSubmit for a first message on its command line come
   * moments apart, and Codex is listed only from its first message.
   */
  startedAs(sessionId: string, listed: boolean): string[] {
    const was = this.started.get(sessionId);
    if (was) return [was];
    return listed ? [] : this.entries.filter((e) => e.purpose === "work").map((e) => e.id);
  }

  /** The listed sessions, each that started here with the ID it had while it started as an alias. */
  withAliases(listed: readonly Session[]): Session[] {
    return listed.map((s) => {
      const was = this.started.get(s.sessionId);
      return was && !(s.aliases ?? []).includes(was) ? { ...s, aliases: [...(s.aliases ?? []), was] } : s;
    });
  }

  /** The ones still starting, as sessions: listed "starting", or "blocked" once they need you. Never typed into (no process to check). */
  sessions(): Session[] {
    return this.entries
      .filter((e) => e.purpose === "work")
      .map((e) => ({
        sessionId: e.id,
        name: e.name || folderName(e.cwd),
        givenName: e.name,
        title: "",
        nameSetBy: "user",
        cwd: e.cwd,
        kind: "interactive",
        status: e.needsYou ? "blocked" : e.atPrompt ? "idle" : STARTING,
        lastActiveAt: e.at,
        desktop: false,
        // Its pane, so the window lists it with Kiko's own and shows it (its trust prompt) when
        // picked. No pid: the terminal refuses to type into it, and the app holds its words anyway.
        place: e.handle ? { via: e.via, id: e.handle, keys: false } : null,
        mapping: "none",
        ...(e.agent ? { agent: e.agent } : {}),
      }));
  }

  /**
   * What the pane says now, for one kept here: whether it has ended. Its program seen once, the
   * shell in front again means it quit (the trust prompt's "No, exit"); before that the shell is
   * still starting it (the rc files), until the wait (startingWaitMs): then it never started.
   */
  ended(entry: Starting, state: PaneState): boolean {
    if (state === "running") entry.seenRunning = true;
    if (state === "gone") return true;
    return state === "shell" && (entry.seenRunning || this.now() - entry.at >= entry.waitMs);
  }

  /** Kept past the wait (startingWaitMs) and not told yet: marked as needing you, returned once each. */
  due(): Starting[] {
    const now = this.now();
    // One at its prompt waits for its first message, not for you in its window.
    const due = this.entries.filter((e) => !e.needsYou && !e.atPrompt && now - e.at >= e.waitMs);
    for (const e of due) e.needsYou = true;
    return due;
  }

  /** Kept past STARTING_GIVE_UP_MS: taken out and returned. Not one at its prompt: it waits for its first message, however long. */
  stale(): Starting[] {
    const now = this.now();
    const old = this.entries.filter((e) => !e.atPrompt && now - e.at >= STARTING_GIVE_UP_MS);
    for (const e of old) this.remove(e.id);
    return old;
  }
}
