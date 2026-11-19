// Claude Code's running sessions: `claude agents --json` (the documented way to read them), each
// with what its process record (~/.claude/sessions/<pid>.json) and its transcript add. Only the ones
// you started: never another Claude's (`hiddenWhy`). Subagents aren't sessions here: they run inside
// their session's process, with no process record and no row in `claude agents`.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { log } from "../../core/log.ts";
import { envVar } from "../../core/name.ts";
import { checkSessionProcess, recordOf as recordIn, systemReach, terminate, type ProcessReach } from "../process-check.ts";
import type { AgentSession, Endable, SessionRef, Signalled } from "../types.ts";
import { jobBackground, sessionBackground } from "./background.ts";
import { modeOf } from "./modes.ts";
import { paneOf, terminalOf } from "./terminals.ts";
import { transcriptInfo, transcriptPath, transcriptTurn } from "./transcripts.ts";
import { inTurn, turnOf } from "./turns.ts";

const run = promisify(execFile);

type Listed = { pid?: number; id?: string; sessionId: string; name: string; cwd: string; kind: string; status?: string; state?: string };
type Live = PidRecord & { pid: number };

/** How long `claude agents --json` may take: it answers in well under a second. */
const AGENTS_MS = 15_000;

/**
 * `claude agents --json`, read; throws when it fails, or hangs past `timeoutMs` (it's stopped then):
 * the app's list of sessions, and everything waiting on it (the window's look every few seconds),
 * would otherwise wait for good.
 */
export async function claudeAgents(timeoutMs = AGENTS_MS): Promise<Listed[]> {
  const { stdout } = await run("claude", ["agents", "--json"], { timeout: timeoutMs });
  return JSON.parse(stdout);
}

/** The sessions someone can talk to. */
export async function listSessions(): Promise<AgentSession[]> {
  const listed = await claudeAgents();
  listedPids.clear();
  for (const a of listed) if (Number.isInteger(a.pid)) listedPids.set(a.sessionId, a.pid as number);
  const records = liveRecords();
  const fronts = await continuations(listed, records, commandOf);
  faces = new Map([...fronts].map(([id, f]) => [id, { sessionId: f.sessionId as string, cwd: f.cwd as string }]));
  // A terminal session whose turns a background process now runs is listed as that process.
  const hidden = new Set([...fronts.values()].map((f) => f.sessionId as string));
  const all = withUnlisted(listed, records, hidden).filter((a) => !hidden.has(a.sessionId));
  // Headless runs (`claude -p`, Agent SDK apps, this app's quick tasks) are listed as interactive
  // while they run, but nobody can talk to them: their hooks skip them too (claude-code-hook.mjs).
  const yours = all.map((a) => ({ a, record: pidRecord(a) })).filter(({ record }) => !headless(record?.entrypoint));
  // Nor ones another Claude started (`hiddenWhy`).
  const why = await leftOut(yours.map(({ a, record }) => ({ a, record, front: fronts.get(a.sessionId) ?? null })));
  const agents = yours.filter(({ a }) => !why.has(a.sessionId));
  return agents.map(({ a, record }) => {
    const front = fronts.get(a.sessionId);
    return front ? continued(describe(a, record), describe(listedOf(front), front)) : describe(a, record);
  });
}

export function describe(a: Listed, record: PidRecord | null): AgentSession {
  const { customTitle, aiTitle, entrypoint } = transcriptInfo(a.cwd, a.sessionId);
  const givenName = userNamed(record) || customTitle;
  // Whether it's in a turn: its hooks', else `claude agents`', with its transcript (./turns.ts).
  const path = transcriptPath(a.cwd, a.sessionId);
  const transcript = transcriptTurn(path);
  const listed = statusOf(a);
  const turn = inTurn(turnOf(a.sessionId), transcript, listed === "busy" ? true : listed === "idle" ? false : null);
  const job = a.kind !== "interactive" && (a.id || typeof record?.jobId === "string") ? a.id || (record!.jobId as string) : "";
  // What it still runs in the background, apart (./background.ts): a job's own file says; else its
  // transcript, while its process may run something (`claude agents` says idle once nothing does).
  const background = job ? jobBackground(job, a.cwd, a.sessionId) : sessionBackground(path, a.cwd, a.sessionId, { busy: turn === true || listed !== "idle", since: startedAt(record) });
  return {
    sessionId: a.sessionId,
    name: a.name,
    givenName,
    title: aiTitle,
    cwd: a.cwd,
    kind: a.kind === "interactive" ? "interactive" : "background",
    status: statusOf(a, turn),
    ...(background ? { background } : {}),
    lastActiveAt: transcript.at,
    desktop: fromDesktop(entrypoint),
    // Claude Code titles the terminal with the conversation's title, or the name it was given.
    titles: [givenName, customTitle, aiTitle].filter(Boolean),
    // Its process, by which tmux finds its pane. One continued in a background process keeps the
    // terminal one's (`continued`): that's the process in the pane.
    ...(Number.isInteger(a.pid) ? { pid: a.pid } : {}),
    // A background job's, for `claude stop` (endProcess).
    ...(job ? { jobId: job } : {}),
    // Its permission mode, as its hooks last said it (./modes.ts).
    ...(modeOf(a.sessionId) ? { mode: modeOf(a.sessionId) } : {}),
    // Its terminal app, as its hooks last said it (./terminals.ts): Ghostty is scripted only for sessions there.
    ...(terminalOf(a.sessionId) ? { terminal: terminalOf(a.sessionId) } : {}),
    // The Rex block its hooks last said it runs in: Rex's adapter looks there first.
    ...(paneOf(a.sessionId) ? { pane: paneOf(a.sessionId) } : {}),
  };
}

/**
 * Its status in the agent's words (AgentSession.status), from `claude agents --json` (2.1.312): a
 * row's `status` is its process's ("busy", "idle", or "waiting": a dialog open in its window, a
 * permission prompt say), and a background job's row adds `state`, the job's own ("working",
 * "blocked", "done"…), which is "blocked" also when Claude ended its turn asking you something
 * ("What would you like to work on?") with nothing open anywhere. So a dialog waiting is "blocked"
 * (it needs you), a job stopped on a question of its own is "waiting" (it waits for you), and a job
 * with no process left goes by its state ("working" is "busy").
 * Busy or not is `turn`'s, when it's known (./turns.ts inTurn): "busy" there is the process's, and a
 * shell or subagent left running in the background keeps it busy with no turn. Out of one, a job
 * stopped on a question is still "waiting".
 */
export function statusOf(a: { status?: string; state?: string }, turn: boolean | null = null): string {
  if (a.status === "blocked" || a.status === "waiting") return "blocked";
  if (turn === true) return "busy";
  if (turn === false) return a.state === "blocked" ? "waiting" : "idle";
  if (a.status === "busy") return a.status;
  if (a.state === "blocked") return "waiting";
  if (a.status) return a.status;
  return a.state === "working" ? "busy" : (a.state ?? "unknown");
}

/**
 * One session made of a background process and the terminal session it continues (see
 * `continuations`): the process's ID, status and transcript, since its hooks, turns and history
 * are all there now; the terminal session's names and kind, since its window is what you look at
 * and type into (the terminal adapters find it by them). The terminal session's ID is an alias.
 * Except the name given with /rename: one typed into its window since goes to the process (the
 * job's record and transcript take it; the terminal's record keeps the old name), so the process's
 * given name, when it has one, is the newer (renamed from the menu "Lacy" → "Yo Lacy", the list
 * otherwise kept "Lacy").
 */
export function continued(engine: AgentSession, front: AgentSession): AgentSession {
  return {
    ...front,
    givenName: engine.givenName || front.givenName,
    sessionId: engine.sessionId,
    aliases: [front.sessionId, ...(front.aliases ?? [])],
    kind: "interactive",
    status: engine.status,
    // What runs in the background is the job's, which runs its turns (a terminal session says nothing of its own).
    ...(engine.background ? { background: engine.background } : {}),
    lastActiveAt: engine.lastActiveAt || front.lastActiveAt,
    titles: [...new Set([...front.titles, ...engine.titles])],
    // Ending it (endProcess) stops the job and the terminal's process both.
    ...(engine.jobId ? { jobId: engine.jobId } : {}),
    // Its hooks are the process's now: its mode is the newer.
    ...(engine.mode || front.mode ? { mode: engine.mode ?? front.mode } : {}),
  };
}

/**
 * Claude Code 2.1.312 can move a running terminal session X into a background process (seen
 * 2026-10-28; ← on an empty prompt opens its agents view and parks the session there). From then on
 * every hook, every turn and the transcript are the job's own session's, while X's process stays on
 * as the terminal you type into (its record stuck at "idle", with `parkedJobId` naming the job). So
 * a background job continues X when X is a live interactive record in the same folder whose
 * `parkedJobId` is the job's id: first, whatever the job's command line says, since a job started
 * fresh (X had no turn yet) has no `--resume` in it; one Claude
 * Code un-parks clears `parkedJobId`, and the link goes with it. Else, as before, when its command
 * line resumes X (`--session-id <new> --fork-session --resume <…/X.jsonl>`), and X's `parkedJobId`,
 * if it has one, is this job; several claiming one X with nothing to tell them apart: none does.
 * Background ID → X's record.
 */
export async function continuations(listed: Listed[], records: Live[], command: (pid: number, sessionId: string) => Promise<string>): Promise<Map<string, Live>> {
  const fronts = records.filter((r) => r.kind === "interactive" && typeof r.sessionId === "string" && typeof r.cwd === "string" && !headless(r.entrypoint));
  // Only a process with a live terminal session in its folder is worth asking `ps` about.
  const jobs = listed.filter((a) => (a.kind === "bg" || a.kind === "background") && fronts.some((f) => f.cwd === a.cwd && f.sessionId !== a.sessionId));
  const jobOf = (engine: Listed) => {
    const own = records.find((r) => r.pid === engine.pid && r.sessionId === engine.sessionId);
    return engine.id ?? (typeof own?.jobId === "string" ? own.jobId : engine.sessionId.slice(0, 8));
  };
  const links = new Map<string, Live>();
  // Parked: X names the job. One X, one job.
  const taken = new Set<string>();
  for (const engine of jobs) {
    const job = jobOf(engine);
    const parked = fronts.filter((f) => f.cwd === engine.cwd && f.sessionId !== engine.sessionId && f.parkedJobId === job && !taken.has(f.sessionId as string));
    if (parked.length !== 1) continue;
    links.set(engine.sessionId, parked[0]);
    taken.add(parked[0].sessionId as string);
  }
  // Resumed: the job's command line names X.
  const engines = jobs.filter((a) => !links.has(a.sessionId) && Number.isInteger(a.pid));
  const resumes = await Promise.all(engines.map((a) => command(a.pid!, a.sessionId).then(resumedFrom)));
  const claims = new Map<string, Array<{ engine: Listed; job: string }>>();
  for (const [i, engine] of engines.entries()) {
    const resumed = resumes[i];
    if (taken.has(resumed)) continue;
    const front = fronts.find((f) => f.cwd === engine.cwd && f.sessionId === resumed && resumed !== engine.sessionId);
    if (!front) continue;
    claims.set(resumed, [...(claims.get(resumed) ?? []), { engine, job: jobOf(engine) }]);
  }
  for (const [id, claimed] of claims) {
    const front = fronts.find((f) => f.sessionId === id)!;
    const parked = typeof front.parkedJobId === "string" ? front.parkedJobId : "";
    const it = parked ? claimed.filter((c) => c.job === parked) : claimed;
    if (it.length === 1) links.set(it[0].engine.sessionId, front);
  }
  return links;
}

/** The session a command line resumes: `--resume <id>` or `--resume <…/id.jsonl>`; "" when none. */
export function resumedFrom(command: string): string {
  const m = command.match(/(?:^|\s)--resume(?:=|\s+)(\S+)/);
  return m ? (m[1].split("/").pop() ?? "").replace(/\.jsonl$/, "") : "";
}

// A process's command line doesn't change: `ps` once per process, kept by pid and session.
const commands = new Map<string, Promise<string>>();

function commandOf(pid: number, sessionId: string): Promise<string> {
  const key = `${pid}:${sessionId}`;
  let got = commands.get(key);
  if (!got) {
    got = run("ps", ["-o", "command=", "-p", String(pid)]).then(
      ({ stdout }) => stdout.trim(),
      () => "",
    );
    if (commands.size > 200) commands.clear();
    commands.set(key, got);
  }
  return got;
}

// The terminal session each background session continues, as of the last listing.
let faces = new Map<string, SessionRef>();

/** The terminal session a background session continues (see `continuations`), as last listed; null for none. */
export function faceOf(sessionId: string): SessionRef | null {
  return faces.get(sessionId) ?? null;
}

/**
 * `claude agents` sometimes leaves out a running terminal session: seen 2026-10-28 with 2.1.312,
 * where a terminal session whose turns had moved into a background process was missing while that
 * process was listed. Its process record still says it's there, so add the interactive ones the
 * listing missed, as long as their process is alive; but not one of `fronts`, whose turns a
 * background process runs now (see `continuations`): it stands for them.
 */
export function withUnlisted(listed: Listed[], records: Live[], fronts: ReadonlySet<string> = new Set()): Listed[] {
  const seen = new Set(listed.map((a) => a.sessionId));
  const missing = records
    .filter((r) => r.kind === "interactive" && typeof r.sessionId === "string" && typeof r.cwd === "string" && !seen.has(r.sessionId))
    .filter((r) => !fronts.has(r.sessionId as string))
    .map(listedOf);
  return [...listed, ...missing];
}

/** A process record as `claude agents` lists a session. */
function listedOf(r: Live): Listed {
  return {
    pid: r.pid,
    sessionId: r.sessionId as string,
    name: typeof r.name === "string" && r.name ? r.name : (r.cwd as string).split("/").pop() || "",
    cwd: r.cwd as string,
    kind: "interactive",
    status: typeof r.status === "string" ? r.status : undefined,
  };
}

/** Where Claude Code keeps its running processes' records; KIKO_CLAUDE_SESSIONS points the tests at their own. */
const recordsDir = () => envVar("CLAUDE_SESSIONS") ?? `${homedir()}/.claude/sessions`;

/** Every process record in ~/.claude/sessions whose process is still running. */
function liveRecords(): Live[] {
  const dir = recordsDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  return files.flatMap((f) => {
    const pid = Number(f.slice(0, -5));
    try {
      process.kill(pid, 0);
    } catch (err: any) {
      if (err?.code !== "EPERM") return [];
    }
    try {
      return [{ ...JSON.parse(readFileSync(`${dir}/${f}`, "utf8")), pid }];
    } catch {
      return [];
    }
  });
}

/**
 * The name given with /rename, from Claude Code's record of the running process
 * (~/.claude/sessions/<pid>.json): `nameSource` is "user" once it's renamed, "derived" while the
 * name is made up from the folder ("clipkit-ad"). "" when it isn't renamed or there's no record.
 */
function userNamed(record: PidRecord | null): string {
  return record && record.nameSource === "user" && typeof record.name === "string" ? record.name.trim() : "";
}

type PidRecord = {
  sessionId?: string;
  name?: unknown;
  nameSource?: string;
  entrypoint?: string;
  kind?: string;
  cwd?: string;
  status?: string;
  /** A background process's job ("b5d81f3a"). */
  jobId?: unknown;
  /** A terminal session's: the background job its turns were moved into. */
  parkedJobId?: unknown;
  /** When its process started, as `ps -o lstart=` says it in C and UTC: tells it from a later one with the same pid. */
  procStart?: unknown;
};

/** Claude Code's record of a running session's process (~/.claude/sessions/<pid>.json), if it's this session's. */
function pidRecord(agent: Listed): PidRecord | null {
  if (!Number.isInteger(agent.pid)) return null;
  try {
    const record = JSON.parse(readFileSync(`${recordsDir()}/${agent.pid}.json`, "utf8"));
    return record?.sessionId === agent.sessionId ? record : null;
  } catch {
    return null;
  }
}

/** Each session's process as `claude agents` listed it last (a terminal session's, a background job's): by session ID. */
const listedPids = new Map<string, number>();

/**
 * A session's process status as its own record says it now (~/.claude/sessions/<pid>.json, one small
 * file read; `claude agents` reads the same): "waiting" while a dialog is open in its window (a
 * permission prompt), "busy", "idle". Looked for at each of `pids` (its hook's parent, which may be a
 * shell Claude Code ran the hook in), then at the process `claude agents` listed it with last; only
 * a record that is this session's counts. Null when none says.
 */
export function recordStatus(sessionId: string, pids: readonly (number | undefined)[] = []): string | null {
  for (const pid of new Set([...pids, listedPids.get(sessionId)])) {
    if (!Number.isInteger(pid)) continue;
    try {
      const record = JSON.parse(readFileSync(`${recordsDir()}/${pid}.json`, "utf8"));
      if (record?.sessionId === sessionId && typeof record.status === "string") return record.status;
    } catch {}
  }
  return null;
}

/** When its process started (ms epoch), from its record's `procStart` (`ps -o lstart=`, in UTC); 0 when it doesn't say. */
export function startedAt(record: PidRecord | null): number {
  if (typeof record?.procStart !== "string") return 0;
  const at = Date.parse(`${record.procStart.replace(/\s+/g, " ").trim()} UTC`);
  return Number.isFinite(at) ? at : 0;
}

/** `claude -p` and Agent SDK runs have an sdk-* entrypoint ("sdk-cli", "sdk-ts"); terminal sessions "cli". */
export function headless(entrypoint: string | undefined) {
  return Boolean(entrypoint?.startsWith("sdk"));
}

/** Why a session another Claude started is left out of the list (`hiddenWhy`). */
type Hidden = "agent-scratch" | "started-by-claude";

/**
 * Why a session is left out: the list has only the Claude Code sessions you started yourself in a
 * terminal, never ones another Claude started to try something ("probe" sessions an agent ran in a
 * private tmux server were once listed as outside sessions). Null to list it.
 * - "agent-scratch": in a background job's scratch folder (`agentScratch`), whatever its kind.
 * - "started-by-claude": an interactive one started from a program a Claude Code process runs (its
 *   Bash tool's shell: `startedInClaude`). Not asked of background jobs: they're all their
 *   supervisor's children, whoever asked for them, so their ancestry says nothing; nor of the
 *   desktop app's, whose processes are its own.
 * Not caught: one an agent started where its process left the agent's (a detached tmux server,
 * whose parent is launchd then) outside the scratch folder, and a `claude --bg` an agent ran.
 * `startedIn(pid)`: whether that process was started inside a Claude (see `leftOut`).
 */
export function hiddenWhy(s: { cwd: string; kind: string; pid?: number; entrypoint?: string }, startedIn: (pid: number) => boolean, home = homedir()): Hidden | null {
  if (agentScratch(s.cwd, home)) return "agent-scratch";
  if (s.kind !== "interactive" || fromDesktop(s.entrypoint) || !Number.isInteger(s.pid)) return null;
  return startedIn(s.pid!) ? "started-by-claude" : null;
}

/**
 * A background job's scratch folder, ~/.claude/jobs/<id>/tmp (or one inside it), where its agents
 * try things out: no session of yours runs there.
 */
export function agentScratch(cwd: string, home = homedir()): boolean {
  const jobs = `${home.replace(/\/+$/, "")}/.claude/jobs/`;
  return cwd.startsWith(jobs) && /^[^/]+\/tmp(?:\/|$)/.test(cwd.slice(jobs.length));
}

type Proc = { ppid: number; comm: string };

/** `ps -A -o pid=,ppid=,comm=` read: each process's parent and executable, by pid. */
export function processes(ps: string): Map<number, Proc> {
  const table = new Map<number, Proc>();
  for (const line of ps.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3] });
  }
  return table;
}

/**
 * Whether a process's executable (`ps -o comm=`) is Claude Code's: "claude" (a terminal session,
 * the launcher in ~/.local/bin, the app bundle's), "claude bg-pty-host" and the like (titles its
 * background processes set), or a version the native install keeps (…/claude/versions/2.1.314:
 * a background job's own process).
 */
export function claudeProcess(comm: string): boolean {
  const name = comm.split("/").pop() ?? "";
  return name === "claude" || name.startsWith("claude ") || /\/claude\/versions\/[^/]+$/.test(comm);
}

/**
 * Whether a process was started from a program a Claude Code process runs: a Claude Code process
 * among its ancestors above some other one (a shell: an agent's Bash tool running `claude`). The
 * Claude Code processes right above it are its own (a background job's supervisor), so they don't
 * count. A session in a terminal app or a tmux server has none: their parent is launchd.
 */
export function startedInClaude(pid: number, procs: ReadonlyMap<number, Proc>): boolean {
  let other = false;
  let at = procs.get(pid)?.ppid;
  for (let hops = 0; at !== undefined && at > 1 && hops < 64; hops++) {
    const proc = procs.get(at);
    if (!proc) return false;
    if (!claudeProcess(proc.comm)) other = true;
    else if (other) return true;
    at = proc.ppid;
  }
  return false;
}

// Whether each interactive process was started inside a Claude, by pid and session: a process's
// ancestry is asked of `ps` once (only executables, never command lines).
const insideClaude = new Map<string, boolean>();
// The sessions the last listing left out, by every ID they go by, and those already logged.
let leftOutIds = new Map<string, Hidden>();
const logged = new Set<string>();

/**
 * Why a session's hooks are let go (never held, never heard): one the last listing left out
 * (`hiddenWhy`), or one in an agent's scratch folder, listed or not. Null for any other.
 */
export function hiddenSession(sessionId: string, cwd: unknown): Hidden | null {
  return leftOutIds.get(sessionId) ?? (typeof cwd === "string" && agentScratch(cwd) ? "agent-scratch" : null);
}

/** Logs a session left out (`session_hidden`), once for each. */
export function tellHidden(sessionId: string, reason: Hidden, cwd: string, pid?: number) {
  if (logged.has(sessionId)) return;
  if (logged.size > 500) logged.clear();
  logged.add(sessionId);
  log("session_hidden", { sessionId, reason, cwd, ...(Number.isInteger(pid) ? { pid } : {}) });
}

/**
 * The sessions to leave out (`hiddenWhy`), with why, by ID; each logged once (`session_hidden`).
 * Asked of what the window shows: for a background process running a terminal session's turns,
 * that terminal session (`front`). `ps` is run only for a process not asked about before; when it
 * fails, nothing is left out for its ancestry.
 */
async function leftOut(rows: Array<{ a: Listed; record: PidRecord | null; front: Live | null }>): Promise<Map<string, Hidden>> {
  const shown = rows.map(({ a, record, front }) => ({
    a,
    front,
    cwd: a.cwd,
    kind: front ? "interactive" : a.kind,
    pid: front ? front.pid : a.pid,
    entrypoint: front ? front.entrypoint : record?.entrypoint,
  }));
  const key = (s: { a: Listed; pid?: number }) => `${s.pid}:${s.a.sessionId}`;
  const unasked = shown.filter((s) => s.kind === "interactive" && Number.isInteger(s.pid) && !insideClaude.has(key(s)) && !agentScratch(s.cwd));
  if (unasked.length) {
    const procs = await processTable();
    if (insideClaude.size > 500) insideClaude.clear();
    if (procs) for (const s of unasked) insideClaude.set(key(s), startedInClaude(s.pid!, procs));
  }
  const why = new Map<string, Hidden>();
  const ids = new Map<string, Hidden>();
  for (const s of shown) {
    const reason = hiddenWhy(s, () => insideClaude.get(key(s)) ?? false);
    if (!reason) continue;
    why.set(s.a.sessionId, reason);
    ids.set(s.a.sessionId, reason);
    if (s.front?.sessionId) ids.set(s.front.sessionId as string, reason);
    tellHidden(s.a.sessionId, reason, s.cwd, s.pid);
  }
  leftOutIds = ids;
  return why;
}

/** Every process's parent and executable (`processes`); null when `ps` fails. */
async function processTable(): Promise<Map<number, Proc> | null> {
  try {
    const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,comm="], { maxBuffer: 16 * 1024 * 1024 });
    return processes(stdout);
  } catch {
    return null;
  }
}

/** Sessions the Claude desktop app runs (its Code tab, or its agent mode) have this entrypoint. */
export function fromDesktop(entrypoint: string | undefined) {
  return Boolean(entrypoint?.startsWith("claude-desktop") || entrypoint === "local-agent");
}

// The desktop app runs a session started without a folder in a made-up one, like
// ~/Library/Application Support/Claude/scratch-workspaces/<id>/<id>/scratch-2026-10-26-16dc10.
const DESKTOP_SCRATCH = /\/Application Support\/Claude\/(?:scratch-workspaces|local-agent-mode-sessions)\//;

/** A desktop session started without a folder, in a made-up one: it goes by its title. */
export const inScratch = (cwd: string) => DESKTOP_SCRATCH.test(cwd);

// ── Ending a session from outside its terminal (Agent.end) ──

/** What `endProcess` reaches: the process records' folder (~/.claude/sessions), `ps`, `claude stop` and signals (a test's own, in tests). */
export type Reach = ProcessReach & {
  /** `claude stop <job>`: a background job asked to stop; not ok, with why, when it wasn't. */
  stop(job: string): Promise<{ ok: true } | { ok: false; why: string }>;
};

const firstLine = (text: string) => text.trim().split("\n")[0].slice(0, 200);

export const reach: Reach = {
  dir: `${homedir()}/.claude/sessions`,
  ps: systemReach.ps,
  async stop(job) {
    try {
      const { stdout, stderr } = await run("claude", ["stop", job]);
      // An interactive session's ID, or a job that's gone: "No job matching …".
      const said = `${stdout}\n${stderr}`.trim();
      return /no job matching/i.test(said) ? { ok: false, why: firstLine(said) } : { ok: true };
    } catch (err: any) {
      return { ok: false, why: firstLine(String(err?.stderr || err?.message || err)) };
    }
  },
  kill: systemReach.kill,
};

const recordOf = (dir: string, pid: number) => recordIn(dir, pid) as PidRecord | null;

/** Claude Code's executable, as `ps -o comm=` names it: `claude`, or the versioned binary a background job runs (…/.local/share/claude/versions/2.1.314). */
export const claudeProgram = (comm: string) => comm.split("/").pop() === "claude" || /\/\.local\/share\/claude\/versions\/[^/]+$/.test(comm);

/**
 * Why not to signal process `pid` for `session`, checked right before (../process-check.ts): its
 * record (~/.claude/sessions/<pid>.json) must be this session's (or an alias's), not a headless
 * run's nor the desktop app's; its `procStart` the process's own start (a pid taken again by
 * another process is never signalled); and the process Claude Code. Null when all hold.
 */
export function checkProcess(session: Endable, pid: number, via: Reach = reach): Promise<string | null> {
  return checkSessionProcess(session, pid, via, { name: "Claude Code", is: claudeProgram }, (record) => {
    const entrypoint = typeof record.entrypoint === "string" ? record.entrypoint : undefined;
    if (headless(entrypoint)) return "it's a headless run";
    if (fromDesktop(entrypoint)) return "it runs in the Claude desktop app";
    return null;
  });
}

/**
 * Ends a session from outside its terminal (Agent.end), cleanly: Claude Code exits on SIGTERM as on
 * /exit (it saves its conversation and runs its SessionEnd hook; its shell says how to resume it; a
 * reply half-streamed is lost). A background job is `claude stop`'s; a terminal session parked into
 * one (`continued`) has the job stopped and its own process signalled. Its process is checked first
 * (`checkProcess`), and nothing is sent when that fails. SIGINT would end it too (it doesn't
 * interrupt the turn); SIGKILL never: no SessionEnd, nothing saved.
 */
export async function endProcess(session: Endable, via: Reach = reach): Promise<Signalled> {
  const no = (why: string): Signalled => ({ sent: false, why });
  if (session.desktop) return no("it runs in the Claude desktop app");
  const interactive = session.kind === "interactive";
  const pid = Number.isInteger(session.pid) ? session.pid! : null;
  if (interactive && pid === null) return no("its process isn't known");
  if (!interactive && !session.jobId) return no("its background job isn't known");
  if (pid !== null) {
    const why = await checkProcess(session, pid, via);
    if (why) return no(why);
  }
  if (session.jobId) {
    const stopped = await via.stop(session.jobId);
    if (!stopped.ok) return no(`claude stop didn't take it: ${stopped.why}`);
  } else if (interactive) {
    // Parked into a job the listing didn't show (`continuations` found none): stopped too, if it's
    // still there; a job gone already doesn't keep its terminal from closing.
    const parked = recordOf(via.dir, pid!)?.parkedJobId;
    if (typeof parked === "string" && parked) await via.stop(parked);
  }
  // Gone between the check and now: it has ended all the same (terminate).
  if (interactive) return terminate(pid!, via);
  return { sent: true, pids: pid === null ? [] : [pid] };
}
