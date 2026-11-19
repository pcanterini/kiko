// What the phone is told, for the server (server.ts): what the TUI draws, from the same UI store
// (ui-store.ts), to every signed-in connection: the sessions (sessions), what Kiko is doing (state),
// the permission prompt being asked (permission_prompt), each line it speaks (announcement, start and
// end) and each line heard (heard). The store changes many times a second, so changes go out
// together a moment after (schedule, flush), and to each connection only what changed since it was
// last sent (Conn.last).
//
// The home screen's cards: each listed session carries its agent's mark and colours, whether it runs
// in Kiko's window, its latest line (summary), and, while it works, what it's doing now (`doing`):
// each working session's history is followed through its agent (followActivity) only while some
// phone is in front to see it. A permission question for a phone that's away goes quietly (`quiet`)
// while you're at the Mac (at-mac.ts).
import { agent, agentOf, mainAgent } from "../agents/index.ts";
import { canDo } from "../core/can.ts";
import { log } from "../core/log.ts";
import { permissionModeOf } from "../core/permission-mode.ts";
import { isStarting, sessionName, STARTING, type Session } from "../core/sessions.ts";
import { flat } from "../core/text.ts";
import { DETAIL_MAX } from "../core/decisions.ts";
import { CHECK_FOR_MAX, QUICK_CHECK_NAME } from "../core/quick-ask.ts";
import { sessionStatus, ui, type Line, type Permission, type UiState } from "../core/ui-store.ts";
import { atMacLog, type AtMac, type MacPresence } from "./at-mac.ts";
import type { Conn, PhoneHub } from "./server.ts";

const SUMMARY_MAX = 300;
// What sessions are doing, for the phone's list (`doing`): followed for this many working sessions at most.
const ACTIVITY_MAX = 8;

/** What telling the phones uses of the server. */
export type TellSide = {
  hub: PhoneHub;
  /** Every connection, as the server has them now. */
  conns: ReadonlySet<Conn>;
  send(c: Conn, message: Record<string, unknown>): void;
  /** To every signed-in connection. */
  broadcast(message: Record<string, unknown>): void;
  /** Whether you're at the Mac, for a question to an away phone; null when it can't be told. */
  macPresence: MacPresence | null;
  /** What the server does first with each change, before it's told: what was settled, a screen to follow. */
  before(s: UiState): void;
};

export class Teller {
  private s: TellSide;
  private flushTimer: NodeJS.Timeout | null = null;
  private wasSpeaking = false;
  private announced = false;
  // A session's latest line: what was read out about it, else what it said.
  private summaries = new Map<string, string>();
  private fromTranscript = new Map<string, { at: number; text: string }>();
  // What each working session is doing now ("Running pnpm build"), for the list's `doing`: its
  // history followed while it works and a phone is in front to see it (followActivity).
  private activity = new Map<string, { watcher: { stop(): void }; doing?: string }>();

  constructor(side: TellSide) {
    this.s = side;
  }

  /** The server stopped: nothing more goes out, and no session is followed. */
  stop() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const a of this.activity.values()) a.watcher.stop();
    this.activity.clear();
  }

  /** A line in the store (said, heard, a session's own): to the phones as it comes. */
  line(line: Line) {
    if (line.kind === "session" && line.sessionId) this.summaries.set(line.sessionId, summaryLine(line.text));
    if (line.kind === "spoken" || line.kind === "voice") {
      if (line.kind === "spoken" && line.sessionId) this.summaries.set(line.sessionId, summaryLine(line.text));
      this.announced = true;
      this.s.broadcast({
        type: "announcement",
        phase: "start",
        // Kiko's own words, in the phone's where the Mac's name its keys (Line.phone).
        text: (line.phone ?? line.text).slice(0, 8000),
        kind: line.kind === "spoken" ? "session" : "app",
        sessionId: line.sessionId ?? null,
        // A quick check's result: what it checked, so the phone keeps it as "Kiko checked: …".
        ...(line.checked ? { checked: line.checked.slice(0, CHECK_FOR_MAX) } : {}),
      });
    }
    if (line.kind === "you") this.s.broadcast({ type: "heard", text: line.text.slice(0, 4000), final: true });
    this.schedule();
  }

  /** Changes go out together, a moment after they happen (the store changes many times a second). */
  schedule() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 30);
    this.flushTimer.unref();
  }

  flush() {
    const s = ui.state;
    this.s.before(s);
    if (this.wasSpeaking && !s.speaking && this.announced) {
      this.announced = false;
      this.s.broadcast({ type: "announcement", phase: "end" });
    }
    this.wasSpeaking = s.speaking;
    const authed = [...this.s.conns].filter((c) => c.phone);
    this.followActivity(s, authed);
    if (!authed.length) return;
    const sessions = this.sessions(s);
    const sessionsKey = JSON.stringify(sessions);
    const state = this.state(s);
    const prompt = this.prompt(s);
    // A question for a phone that's away: quiet while you're at the Mac. Not known yet: it goes to
    // them once it is (a moment), with the rest now.
    const macPresence = this.s.macPresence;
    let promptAtMac: AtMac | null | undefined = null;
    if (prompt.message && macPresence && authed.some((c) => c.presence === "away" && c.last.prompt !== prompt.key)) {
      promptAtMac = macPresence.latest() ?? undefined;
      if (!promptAtMac) void macPresence.check().then(() => this.schedule());
    }
    for (const c of authed) {
      if (c.last.sessions !== sessionsKey) {
        c.last.sessions = sessionsKey;
        this.s.send(c, { type: "sessions", sessions });
      }
      if (c.last.state !== state.key) {
        c.last.state = state.key;
        this.s.send(c, { type: "state", ...state.message });
      }
      if (c.last.prompt !== prompt.key) {
        const away = c.presence === "away" && prompt.message !== null;
        if (away && promptAtMac === undefined) continue;
        c.last.prompt = prompt.key;
        const quiet = away && Boolean(promptAtMac?.atMac);
        if (quiet) log("phone_prompt_quiet", { phoneId: c.phone!.id, promptId: prompt.message!.promptId, ...atMacLog(promptAtMac!) });
        this.s.send(c, { type: "permission_prompt", prompt: prompt.message, ...(prompt.queued.length ? { queued: prompt.queued } : {}), ...(quiet ? { quiet: true } : {}) });
      }
    }
  }

  /**
   * What the working sessions are doing, for the list's live line (`doing`): each one's history
   * followed through its agent (the chat's watcher, history.ts) while it works and some phone is in
   * front (not away), up to ACTIVITY_MAX of them; let go of once it stops working or no phone looks.
   * A change goes out with the sessions (the list is only sent when it changed).
   */
  private followActivity(s: UiState, authed: Conn[]) {
    const looking = authed.some((c) => c.presence !== "away");
    const working = looking
      ? listedOf(s)
          .filter((x) => !isStarting(x) && statusOf(x, s) === "working")
          .slice(0, ACTIVITY_MAX)
      : [];
    const ids = new Set(working.map((x) => x.sessionId));
    for (const [id, a] of this.activity) {
      if (ids.has(id)) continue;
      a.watcher.stop();
      this.activity.delete(id);
    }
    for (const x of working) {
      if (this.activity.has(x.sessionId)) continue;
      const followed: { watcher: { stop(): void }; doing?: string } = { watcher: { stop() {} } };
      this.activity.set(x.sessionId, followed);
      try {
        followed.watcher = agent.watchHistory(x, (history) => {
          if (followed.doing === history.doing || this.activity.get(x.sessionId) !== followed) return;
          followed.doing = history.doing;
          this.schedule();
        });
      } catch (err) {
        log("error", { where: "phone_activity", sessionId: x.sessionId, message: (err as Error).message });
      }
    }
  }

  private sessions(s: UiState) {
    return listedOf(s).map((x) => ({
      id: x.sessionId,
      name: sessionName(x).slice(0, 200),
      folder: x.cwd.slice(0, 1000),
      status: statusOf(x, s),
      // What it still runs in the background, apart from its status (never "working"): how many, and the quiet ones.
      ...backgroundOf(x),
      lastActivity: x.lastActiveAt ? Math.round(x.lastActiveAt) : null,
      summary: this.summaryOf(x),
      desktop: x.desktop,
      // Another agent's (a Codex session, a T3 thread): which, for the phone to show.
      ...(agentOf(x) === mainAgent ? {} : { agent: agentOf(x).name.slice(0, 40) }),
      // Its permission mode, once its agent has said (core/permission-mode.ts): "plan", "auto", …
      ...(permissionModeOf(x.mode) ? { permissionMode: permissionModeOf(x.mode)! } : {}),
      // Opened by the hub: the id it had while it started, so a phone that opened it then follows it.
      ...startedAs(x),
      // For its screen: who answers in it, in its agent's colour, and what can be done to it from there.
      ...chatOf(x),
      // For the home screen: its agent's mark, whether it runs in Kiko's window (the Mac's
      // INTERNAL) or outside it (EXTERNAL), and what it's doing now while it works.
      ...markOf(x),
      inApp: x.place?.via === "tmux",
      ...doingOf(this.activity.get(x.sessionId)?.doing, statusOf(x, s)),
    }));
  }

  /** The latest line about a session: what was read out, else what it said, else its transcript's last words. */
  private summaryOf(session: Session) {
    if (isStarting(session)) return session.status === STARTING ? "Starting…" : session.status === "idle" ? "Ready for its first message" : "Waiting for you in its window (trust its folder?)";
    const known = this.summaries.get(session.sessionId);
    if (known) return known;
    const cached = this.fromTranscript.get(session.sessionId);
    if (cached && cached.at === session.lastActiveAt) return cached.text;
    const text = summaryLine(agent.lastSaid(session));
    this.fromTranscript.set(session.sessionId, { at: session.lastActiveAt, text });
    return text;
  }

  private state(s: UiState) {
    const w = s.waiting;
    const talker = s.listening ? (this.s.hub.talking() ? "phone" : s.handsFree.by ? "hands-free" : "mac") : null;
    const base = {
      listening: s.listening,
      talker,
      speaking: s.speaking,
      deciding: s.deciding?.text.slice(0, 4000) ?? null,
      routed: s.routed ? { text: s.routed.text.slice(0, 4000), to: s.routed.to, sessionId: s.routed.sessionId } : null,
      holding: s.holding ? { text: s.holding.text.slice(0, 4000), to: s.holding.to } : null,
      muted: s.muted,
      playOnMac: s.playOnMac,
      catchingUp: s.catchingUp,
      // Kiko's own cost this run, as the Mac's bottom line shows it (to 3 decimals: only a change there is news).
      // Left out while no dollars are shown (on the subscription: core/dollars.ts): an app shows only
      // what the last state carried, so one of any age shows none.
      ...(typeof s.cost === "number" ? { cost: Math.max(0, Math.round(s.cost * 1000) / 1000) } : {}),
      // A quick check running: what it checks, since when ("Kiko is checking: …" on the talk bar).
      ...(s.checking ? { checking: { what: s.checking.what.replace(/\s+/g, " ").trim().slice(0, CHECK_FOR_MAX), startedAt: Math.round(s.checking.startedAt) } } : {}),
    };
    const waiting = w ? { sessionId: w.sessionId, name: w.name, kind: w.kind } : null;
    return {
      key: JSON.stringify({ ...base, waiting, until: w?.until ?? null }),
      message: { ...base, waiting: waiting && { ...waiting, remainingMs: remaining(w!.until) } },
    };
  }

  /**
   * The prompt being asked (`message`, with its window), and every other one Kiko holds open waiting
   * its turn (`queued`: no window yet), each answered with `permission` by its id. `key`: what was
   * sent, so it goes again only once something in it changes.
   */
  private prompt(s: UiState) {
    const queued = (s.queuedPermissions ?? [])
      .filter((q) => q.id !== s.permission?.id)
      .slice(0, QUEUED_MAX)
      .map((q) => promptOf(q));
    const p = s.permission;
    if (!p) return { key: JSON.stringify({ prompt: null, queued }), message: null, queued: queued.map((q) => ({ ...q, remainingMs: null })) };
    const until = s.waiting?.kind === "permission" && s.waiting.sessionId === p.sessionId ? s.waiting.until : null;
    const prompt = promptOf(p);
    return {
      key: JSON.stringify({ ...prompt, until, queued }),
      message: { ...prompt, remainingMs: remaining(until) },
      queued: queued.map((q) => ({ ...q, remainingMs: null })),
    };
  }
}

// The other prompts held at once, sent to the phone at most (each its own card there).
const QUEUED_MAX = 20;

/** A prompt as the phone gets it (permission_prompt `prompt`, and each `queued`), each field cut to the schema's length. */
function promptOf(p: Permission) {
  // Questions (Claude's multiple choice): only what the schema has.
  const questions = p.questions?.slice(0, 8).map((q) => ({
    question: q.question.slice(0, 2000),
    header: q.header.slice(0, 200),
    options: q.options.slice(0, 8).map((o) => ({ label: o.label.slice(0, 500), description: o.description.slice(0, 2000) })),
    multiSelect: q.multiSelect,
  }));
  return {
    promptId: p.id,
    sessionId: p.sessionId,
    // Kiko's quick check: its own name, and what it's for apart (the Mac's card puts them together).
    name: p.checkFor ? QUICK_CHECK_NAME : p.name,
    ...(p.checkFor ? { checkFor: p.checkFor.slice(0, CHECK_FOR_MAX) } : {}),
    what: p.what.slice(0, 2000),
    risky: p.risky,
    // Allowed for good where it can be: the phone's Always (permission `always`).
    ...(p.canAlways ? { canAlways: true } : {}),
    ...(questions ? { questions } : {}),
    ...(p.folder ? { folder: p.folder.slice(0, 2000) } : {}),
    // The tool call in full (a long command, its lines): the phone's request sheet shows it.
    ...(p.detail ? { detail: p.detail.slice(0, DETAIL_MAX) } : {}),
  };
}

/** The sessions the phone lists: the interactive ones, and any other one waiting for you or asking. */
const listedOf = (s: UiState) =>
  s.sessions.filter(
    (x) => x.kind === "interactive" || x.sessionId === s.waiting?.sessionId || x.sessionId === s.permission?.sessionId || Boolean(s.queuedPermissions?.some((q) => q.sessionId === x.sessionId)),
  );

/**
 * How a session shows on the phone: needs you (a permission prompt), waiting for your reply,
 * working, idle. One still starting is idle there (protocol version 1 has no "starting"), its
 * summary saying so.
 */
const statusOf = (session: Session, s: UiState) => {
  const status = sessionStatus(session, s);
  return status === "starting" ? "idle" : status;
};

/** What a session still runs in the background (AgentSession.background), as the phone gets it: `background`, or nothing. */
function backgroundOf(session: Session): { background?: { count: number; agents?: number; quiet?: number; quietSince?: number } } {
  const bg = session.background;
  if (!bg || !Number.isInteger(bg.count) || bg.count < 1) return {};
  const count = Math.min(bg.count, 1000);
  const agents = Number.isInteger(bg.agents) && bg.agents! >= 0 ? { agents: Math.min(bg.agents!, count) } : {};
  const quiet = bg.quiet && bg.quietSince ? { quiet: Math.min(bg.quiet, count), quietSince: Math.round(bg.quietSince) } : {};
  return { background: { count, ...agents, ...quiet } };
}

/**
 * Its agent's mark (Agent.mark: ✻ Claude Code, ⌬ Codex), one character, as the Mac's lists draw
 * it (`mark`), and its colour for a light background (`colorLight`: `color` is the dark one); each
 * left out where its agent has none.
 */
function markOf(session: Session): { mark?: string; colorLight?: string } {
  const mark = agentOf(session).mark;
  const glyph = mark?.glyph;
  const light = mark?.color?.light;
  return {
    // One character, not a private-use one (a Nerd Font icon the phone has no font for).
    ...(glyph && [...glyph].length === 1 && !/[-]/u.test(glyph) ? { mark: glyph } : {}),
    ...(light && /^#[0-9A-Fa-f]{6}$/.test(light) ? { colorLight: light } : {}),
  };
}

/** What a working session is doing now ("Running pnpm build"), for the list's live line: `doing`, or nothing. */
function doingOf(doing: string | undefined, status: string): { doing?: string } {
  const text = doing?.replace(/\s+/g, " ").trim();
  return status === "working" && text ? { doing: text.slice(0, 120) } : {};
}

/** A session's id while it started (starting-…), for one that started from there: as `startedAs`, or nothing. */
function startedAs(session: Session): { startedAs?: string } {
  const was = session.aliases?.find((id) => isStarting({ sessionId: id }));
  return was ? { startedAs: was.slice(0, 200) } : {};
}

const remaining = (until: number | null) => (until === null ? null : Math.max(0, Math.round(until - Date.now())));

/**
 * A session's screen on the phone: who answers in it, as the Mac's viewer heads its replies (its
 * agent's speaker, "Claude", else its agent's name, "T3 Code"), its agent's colour (for a dark
 * background, as the lists draw it: src/ui/marks.ts), and what its menu can do to it (canDo).
 */
function chatOf(session: Session) {
  const its = agentOf(session);
  const color = its.mark?.color?.dark;
  return {
    speaker: (its.speaker?.trim() || its.name).slice(0, 40),
    ...(color && /^#[0-9A-Fa-f]{6}$/.test(color) ? { color } : {}),
    can: canDo(session),
  };
}

/** On one line, at most SUMMARY_MAX characters with its "…". */
function summaryLine(text: string) {
  const t = flat(text);
  return t.length > SUMMARY_MAX ? `${t.slice(0, SUMMARY_MAX - 1)}…` : t;
}
