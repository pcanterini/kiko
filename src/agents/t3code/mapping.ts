// T3 Code's shell (orchestration.subscribeShell, contracts/src/orchestrationV2.ts at v0.1.5) as
// Kiko's sessions: its threads, by project, with their run state. Pure: client.ts feeds it the
// stream's items and acts on what it says changed.
//
//   a thread              a session: `t3:<thread id>`, named by its title, in its worktree or project folder
//   run state             busy (preparing, queued, starting, running, waiting), else idle;
//                         blocked when it waits on a permission (pendingRuntimeRequest)
//   left out              archived, deleted and settled threads, and subagents' child threads
//
// What it tells: a run that started (its message is read with subscribeThread: Claude Code's
// UserPromptSubmit, for T3), a run that completed (its reply read the same way), a thread that
// started waiting on you (once per request: asked here, ./requests.ts), and that request no longer
// pending (answered, its run stopped, the thread gone). Its gotchas, from probing T3 0.1.5:
//   - a second, empty snapshot comes about 30ms after the first: not "every thread is gone"
//   - `waiting` shows for a moment as a run ends: busy, never "needs you"; only `completed` is the end
import { LIMITS, type History } from "../../core/history.ts";
import type { AgentSession } from "../types.ts";

/** The agent's ID, and the prefix of its sessions' IDs. */
export const T3_AGENT = "t3code";
export const PREFIX = "t3:";

export const sessionIdOf = (threadId: string) => `${PREFIX}${threadId}`;
export const threadIdOf = (sessionId: string) => (sessionId.startsWith(PREFIX) ? sessionId.slice(PREFIX.length) : null);

/** The fields of a thread's shell that are read; the rest is left as it comes. */
export type ShellThread = {
  id: string;
  projectId: string;
  title: string;
  worktreePath: string | null;
  lineage?: { relationshipToParent: "fork" | "subagent" | null } | null;
  latestRunId: string | null;
  latestRunCompletedAt?: string | null;
  status: string;
  pendingRuntimeRequest: { id: string; kind: unknown; blocking?: boolean } | null;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
  settledOverride: "settled" | "active" | null;
};

type ShellProject = { id: string; title: string; workspaceRoot: string };

/** The run statuses T3 counts as live (contracts' LIVE_SHELL_STATUSES). */
const LIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/** The statuses of a run that has taken its message in: queued isn't yet; waiting is a permission, or its end. */
const STARTED = new Set(["preparing", "starting", "running"]);

/** A second snapshot this soon after another, with no threads, is the quirk, not news (its projects may be empty too). */
const EMPTY_SNAPSHOT_MS = 1000;

/** A thread's status as Kiko's: blocked when it waits on you, busy while a run is live, else idle. */
export function statusOf(thread: ShellThread): "busy" | "idle" | "blocked" {
  if (waitsOnYou(thread)) return "blocked";
  if (LIVE.has(thread.status)) return "busy";
  return "idle";
}

/** It waits on a permission, or a question, that holds its run (one that doesn't hold it, `blocking: false`, doesn't). */
const waitsOnYou = (thread: ShellThread) => thread.pendingRuntimeRequest !== null && thread.pendingRuntimeRequest.blocking !== false;

/** Whether it's listed: a top-level thread that's neither archived, deleted nor settled. */
export function listed(thread: ShellThread) {
  return !thread.archivedAt && !thread.deletedAt && thread.settledOverride !== "settled" && thread.lineage?.relationshipToParent !== "subagent";
}

/** A thread as a session: in its worktree, else its project's folder. Null when it isn't listed, or its project isn't known. */
export function sessionOf(thread: ShellThread, projects: ReadonlyMap<string, ShellProject>): AgentSession | null {
  if (!listed(thread)) return null;
  const cwd = thread.worktreePath ?? projects.get(thread.projectId)?.workspaceRoot;
  if (!cwd) return null;
  const title = thread.title.trim();
  const at = Date.parse(thread.updatedAt);
  return {
    sessionId: sessionIdOf(thread.id),
    name: title,
    // Its title is the name you see it by in T3, and say it by here.
    givenName: title,
    title: "",
    cwd,
    kind: "interactive",
    status: statusOf(thread),
    lastActiveAt: Number.isFinite(at) ? at : 0,
    desktop: false,
    titles: [],
    agent: T3_AGENT,
  };
}

/** What a shell item changed. */
type ShellChange =
  | { kind: "listed" }
  | { kind: "started"; thread: ShellThread }
  | { kind: "completed"; thread: ShellThread }
  | { kind: "waiting"; thread: ShellThread }
  /** A request it waited on is no longer pending (answered here or in T3, its run stopped, the thread gone). */
  | { kind: "resolved"; threadId: string; requestId: string };

/** The shell as it stands, fed subscribeShell's items in order. */
export class Shell {
  readonly threads = new Map<string, ShellThread>();
  readonly projects = new Map<string, ShellProject>();
  /** Runs already completed when seen (or said): never read out (again). Kept across reconnects. */
  private readonly ended = new Set<string>();
  /** Runs already going when seen (or told as started): never told as started (again). Kept across reconnects. */
  private readonly begun = new Set<string>();
  /** Pending requests already said. Kept across reconnects. */
  private readonly said = new Set<string>();
  private lastSnapshot = -Infinity;

  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** The listed threads, as sessions. */
  sessions(): AgentSession[] {
    return [...this.threads.values()].map((t) => sessionOf(t, this.projects)).filter((s): s is AgentSession => s !== null);
  }

  apply(item: any): ShellChange[] {
    switch (item?.kind) {
      case "snapshot":
        return this.snapshot(item.snapshot);
      case "thread.updated":
        if (item.location === "archive") return this.remove(item.thread?.id);
        return this.update(item.thread);
      case "thread.removed":
        return this.remove(item.threadId);
      case "project.updated":
        if (item.project?.id) this.projects.set(item.project.id, item.project);
        return [{ kind: "listed" }];
      case "project.removed":
        this.projects.delete(item.projectId);
        return [{ kind: "listed" }];
      default:
        // "synchronized", and kinds a later T3 adds.
        return [];
    }
  }

  private snapshot(snapshot: any): ShellChange[] {
    const threads: ShellThread[] = Array.isArray(snapshot?.threads) ? snapshot.threads : [];
    const at = this.now();
    if (!threads.length && at - this.lastSnapshot < EMPTY_SNAPSHOT_MS) return [];
    this.lastSnapshot = at;
    const before = [...this.threads.values()];
    this.threads.clear();
    this.projects.clear();
    for (const p of Array.isArray(snapshot?.projects) ? snapshot.projects : []) this.projects.set(p.id, p);
    const changes: ShellChange[] = [{ kind: "listed" }];
    for (const t of threads) {
      this.threads.set(t.id, t);
      // What ended before Kiko saw it isn't news; what waits on you is, once.
      if (t.status === "completed" && t.latestRunId) this.ended.add(t.latestRunId);
      if (LIVE.has(t.status) && t.latestRunId) this.begun.add(t.latestRunId);
      changes.push(...this.waiting(t));
    }
    for (const t of before) changes.push(...this.resolved(t, this.threads.get(t.id)));
    return changes;
  }

  private update(thread: ShellThread | undefined): ShellChange[] {
    if (!thread?.id) return [];
    const was = this.threads.get(thread.id);
    this.threads.set(thread.id, thread);
    const changes: ShellChange[] = [{ kind: "listed" }, ...this.resolved(was, thread)];
    const run = thread.latestRunId;
    if (listed(thread) && STARTED.has(thread.status) && run && !this.begun.has(run) && !this.ended.has(run)) {
      this.begun.add(run);
      changes.push({ kind: "started", thread });
    }
    if (listed(thread) && thread.status === "completed" && thread.latestRunId && !this.ended.has(thread.latestRunId)) {
      this.ended.add(thread.latestRunId);
      changes.push({ kind: "completed", thread });
    }
    changes.push(...this.waiting(thread));
    return changes;
  }

  private waiting(thread: ShellThread): ShellChange[] {
    if (!listed(thread) || !waitsOnYou(thread)) return [];
    const id = thread.pendingRuntimeRequest!.id;
    if (this.said.has(id)) return [];
    this.said.add(id);
    return [{ kind: "waiting", thread }];
  }

  private remove(threadId: string | undefined): ShellChange[] {
    const was = threadId ? this.threads.get(threadId) : undefined;
    if (!threadId || !this.threads.delete(threadId)) return [];
    return [{ kind: "listed" }, ...this.resolved(was, undefined)];
  }

  /** The request a thread waited on, when it no longer does (another, none, or the thread gone). */
  private resolved(was: ShellThread | undefined, now: ShellThread | undefined): ShellChange[] {
    const id = was?.pendingRuntimeRequest?.id;
    if (!was || !id || now?.pendingRuntimeRequest?.id === id) return [];
    return [{ kind: "resolved", threadId: was.id, requestId: id }];
  }
}

/** A thread's last reply, from subscribeThread's snapshot (its projection's messages): the run's last assistant message, else the thread's. */
export function lastReply(projection: any, runId: string | null): { said: string; asked: string } {
  const messages: any[] = Array.isArray(projection?.messages) ? projection.messages : [];
  const text = (m: any) => (typeof m?.text === "string" ? m.text.trim() : "");
  const last = (role: string, run: string | null) => [...messages].reverse().find((m) => m?.role === role && text(m) && (run === null || m.runId === run));
  const said = last("assistant", runId) ?? last("assistant", null);
  const asked = last("user", runId) ?? last("user", null);
  return { said: text(said), asked: text(asked) };
}

const textOf = (m: any) => (typeof m?.text === "string" ? m.text.trim() : "");

/** Your words that reached a run, oldest first (its user messages); [] when none is known to be its. */
export function askedInRun(projection: any, runId: string | null): string[] {
  if (runId === null) return [];
  const messages: any[] = Array.isArray(projection?.messages) ? projection.messages : [];
  return messages.filter((m) => m?.role === "user" && m.runId === runId && textOf(m)).map(textOf);
}

/** A thread's conversation, as the phone's history shows a session's: its messages, the last LIMITS.items of them. */
export function historyOf(projection: any): History {
  const messages: any[] = Array.isArray(projection?.messages) ? projection.messages : [];
  const all = messages
    .filter((m) => (m?.role === "user" || m?.role === "assistant") && textOf(m))
    .map((m) => {
      const text = textOf(m);
      return {
        kind: m.role === "user" ? ("you" as const) : ("claude" as const),
        text: text.length > LIMITS.text ? `${text.slice(0, LIMITS.text - 1)}…` : text,
        at: typeof m.createdAt === "string" ? m.createdAt : null,
      };
    });
  const items = all.slice(-LIMITS.items);
  return { items, truncated: all.length > items.length };
}
