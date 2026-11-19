#!/usr/bin/env node
// Codex CLI hook (Stop, PermissionRequest, SessionStart, SessionEnd, UserPromptSubmit, Interrupt,
// and PreToolUse for its questions) for Kiko: the Codex flavour of claude-code-hook.mjs. Codex runs it
// as `$SHELL -lc "node …/codex-hook.mjs"` with the event as JSON on stdin (codex-rs/hooks/src/schema.rs).
// It reaches the same socket as Claude Code's hook, each line marked "agent": "codex", and Kiko's
// Codex adapter answers it (src/agents/codex/hooks.ts):
//   Stop               held for your reply, which comes back as {"decision":"block","reason":…}: Codex
//                      carries on in the same turn with it as your message.
//   PermissionRequest  held for your yes or no: {"hookSpecificOutput":{…,"decision":{"behavior":…}}}.
//                      Codex has no "allow always" for a hook (updatedPermissions fails its hook).
//   UserPromptSubmit   told, and since 2026-11-14 the app's one line back is read, within the same
//                      second: {"voice":true} when the prompt is your dictated words that the app just
//                      typed into this session, and then Codex gets one line of context beside the
//                      prompt (lib.mjs VOICE_PROMPT, as hookSpecificOutput.additionalContext: a
//                      developer message after it in the rollout; checked on 0.167.0), so it's told the
//                      words were spoken, as a reply through Stop says. Anything else: nothing printed.
//   the others         told and not waited for (gone within a second); nothing printed.
//   PreToolUse         its questions (request_user_input): told. A shell command or MCP call: Kiko's
//                      safety gate (hooks/guard.mjs), when it's turned on in Settings (off, the
//                      default: it runs at once, lib.mjs guardSaved). Codex can't be told to ask from a hook (its
//                      "ask" is unsupported and lets the call run), so the hook asks Kiko itself:
//                      one the rules flag goes to the app, which answers {"guard":{"ask":false}} (it
//                      runs) or {"guard":{"ask":true}} and then holds it as a permission card; your yes
//                      lets it run (nothing printed), your no, no answer, or the app going away denies
//                      it (permissionDecision "deny", which Codex honours in every sandbox and approval
//                      mode). Anything else, and every call while Kiko isn't running, runs at once.
// Codex rejects any field its schema doesn't know, so only those are ever printed. With the app
// off, or no answer, it prints nothing and exits 0, and Codex behaves as without it.
//
// Codex keeps no record of its running sessions' processes (Claude Code's ~/.claude/sessions has
// one), so this keeps one for Kiko: <pid>.json in ~/.config/kiko/codex-sessions (Kiko Dev's
// ~/.config/kiko-dev/: lib.mjs CONFIG_DIR; or
// KIKO_CODEX_SESSIONS), written on every event, whether Kiko runs or not, with the session,
// its folder, its rollout, its status and when its process started (to tell it from a later one
// with the same pid). The pid is the Codex TUI's: the first `codex` process above this one that has
// a terminal. One whose hooks run in Codex's shared app-server daemon (no terminal above: every
// session from Codex 0.166.0 on) is kept by its session instead, with no pid; Kiko finds its tmux
// pane by its program and folder (src/terminals/tmux byProgram). SessionEnd removes it. Codex runs
// no hook before a session's first turn (SessionStart comes with it).
//
// A session another app runs Codex for (T3 Code's threads, Codex's desktop app, its IDE extension)
// isn't Kiko's Codex session: that app has it (T3 Code's through its own adapter) and answers its
// prompts. Codex runs these hooks for it all the same, so one whose rollout says another app started
// it (`originator` in its first line, not the CLI's) is left alone: nothing kept, nothing sent,
// nothing printed, exit 0 at once. The rule is src/agents/codex/origin.ts's; keep the two in step.
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appEnv, CONFIG_DIR, clipInput, converse, guardSaved, MAX_PROMPT, NAME, send, socketPaths, TELL_MS, tell, VOICE_PROMPT, VOICE_REPLY } from "./lib.mjs";

const SOCKETS = socketPaths();
const RECORDS = appEnv("CODEX_SESSIONS") || join(CONFIG_DIR, "codex-sessions");
const TOLD = ["SessionStart", "SessionEnd", "UserPromptSubmit", "Interrupt", "PreToolUse"];
// The safety gate's longest wait for your answer: under the entry's timeout (codex/setup.ts, 300 s),
// since a hook Codex times out lets the call run.
const GUARD_HOLD_MS = Number(appEnv("GUARD_HOLD_MS")) > 0 ? Number(appEnv("GUARD_HOLD_MS")) : 280_000;
// What each event leaves the session doing, as Kiko lists it ("" leaves it as it was).
const STATUS = { SessionStart: "busy", UserPromptSubmit: "busy", PermissionRequest: "blocked", Stop: "idle", Interrupt: "idle", PreToolUse: "" };

let input = "";
let hook;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", main);
process.stdin.on("error", () => process.exit(0));

function main() {
  try {
    hook = JSON.parse(input);
  } catch {
    process.exit(0);
  }
  const kind = hook?.hook_event_name;
  if (typeof kind !== "string" || typeof hook.session_id !== "string") process.exit(0);
  // Any other tool before it runs: the safety gate's (below); its questions (request_user_input) are told.
  if (kind === "PreToolUse" && hook.tool_name !== "request_user_input") return void guard().catch(guardFailed);
  // Another app's session (T3 Code's): none of Kiko's.
  if (otherApp(hook.transcript_path)) process.exit(0);
  let pid;
  try {
    pid = keepRecord(kind);
  } catch {}
  const sockets = SOCKETS.filter((path) => existsSync(path));
  if (!sockets.length) process.exit(0);
  const event = {
    agent: "codex",
    hook_event_name: kind,
    session_id: hook.session_id,
    cwd: hook.cwd,
    transcript_path: hook.transcript_path ?? undefined,
    turn_id: hook.turn_id,
    ...(Number.isInteger(pid) ? { pid } : {}),
    ...(kind === "SessionStart" ? { source: hook.source } : {}),
    ...(kind === "SessionEnd" ? { reason: hook.reason } : {}),
    ...(kind === "UserPromptSubmit" ? { prompt: typeof hook.prompt === "string" ? hook.prompt.slice(0, MAX_PROMPT) : "" } : {}),
    ...(kind === "PermissionRequest" || kind === "PreToolUse" ? { tool_name: hook.tool_name, tool_input: clipInput(hook.tool_input) } : {}),
    ...(kind === "Stop" ? { stop_hook_active: hook.stop_hook_active, last_assistant_message: hook.last_assistant_message ?? "" } : {}),
  };
  if (!TOLD.includes(kind)) return send(event, sockets, finish);
  // The told ones: nothing printed, but for a prompt the app says is your dictated words (finish).
  setTimeout(() => process.exit(0), TELL_MS);
  if (kind === "UserPromptSubmit") return send(event, sockets, finish);
  tell(event, sockets);
}

// ── Another app's session (src/agents/codex/origin.ts) ──

// Codex's own CLI: "codex-tui" (its TUI), "codex_cli_rs" (an older one's); tui or cli as a word.
const CLI = /(?:^|[-_ ])(?:tui|cli)(?:[-_ ]|$)/i;

/** The app a session's rollout says started it when that isn't Codex's CLI ("T3 Code"), else null (the CLI's, none recorded, or no rollout yet). */
function otherApp(rollout) {
  if (typeof rollout !== "string" || !rollout) return null;
  let fd;
  try {
    fd = openSync(rollout, "r");
    // Its first line, session_meta (about 22 KB): read up to 1 MB of it.
    const buffer = Buffer.alloc(1024 * 1024);
    const n = readSync(fd, buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, n).indexOf(0x0a);
    if (end < 0) return null;
    const line = JSON.parse(buffer.subarray(0, end).toString("utf8"));
    const originator = line?.type === "session_meta" ? line.payload?.originator : undefined;
    return typeof originator === "string" && originator.trim() && !CLI.test(originator) ? originator : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ── The record Kiko lists Codex's sessions by ──

/** The record for this session's process, written (or removed, on SessionEnd); its pid, when there's one. */
function keepRecord(kind) {
  mkdirSync(RECORDS, { recursive: true, mode: 0o700 });
  const mine = readdirSync(RECORDS)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ f, r: read(join(RECORDS, f)) }))
    .find(({ r }) => r?.sessionId === hook.session_id);
  let pid = mine && Number.isInteger(mine.r.pid) && alive(mine.r.pid) ? mine.r.pid : undefined;
  let procStart = pid ? mine.r.procStart : undefined;
  if (!pid && (!mine || kind === "SessionStart")) {
    pid = tuiPid();
    procStart = pid ? started(pid) : undefined;
  }
  const file = join(RECORDS, pid ? `${pid}.json` : `${hook.session_id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  if (kind === "SessionEnd") {
    rmSync(file, { force: true });
    if (mine) rmSync(join(RECORDS, mine.f), { force: true });
    return pid;
  }
  const status = STATUS[kind] || mine?.r.status || "idle";
  const record = {
    ...(pid ? { pid, procStart } : {}),
    sessionId: hook.session_id,
    cwd: typeof hook.cwd === "string" ? hook.cwd : mine?.r.cwd,
    transcriptPath: typeof hook.transcript_path === "string" ? hook.transcript_path : mine?.r.transcriptPath,
    status,
    at: Date.now(),
  };
  // Written whole, then moved in place: Kiko never reads half a record.
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
  renameSync(temp, file);
  // The same session kept under another name before (by its session, or an old pid): gone now.
  if (mine && join(RECORDS, mine.f) !== file) rmSync(join(RECORDS, mine.f), { force: true });
  return pid;
}

function read(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/** The Codex TUI above this hook: the first process named codex with a terminal (its parent's shell, then codex). */
function tuiPid() {
  const table = new Map();
  // Executables and terminals only, never command lines.
  const ps = execFileSync("ps", ["-A", "-o", "pid=,ppid=,tty=,comm="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  for (const line of ps.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), tty: m[3], comm: m[4] });
  }
  let at = process.ppid;
  for (let hops = 0; at > 1 && hops < 32; hops++) {
    const proc = table.get(at);
    if (!proc) return undefined;
    if (proc.comm.split("/").pop() === "codex") return proc.tty === "??" || proc.tty === "-" ? undefined : at;
    at = proc.ppid;
  }
  return undefined;
}

/** When `pid` started, as `ps -o lstart=` says it in C and UTC (Kiko checks it before ending the session). */
function started(pid) {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } })
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return undefined;
  }
}

// ── Kiko ──

// The held ones: Kiko answers with one line, or just closes. Stop: {"reply": "..."} or {"reply": null}.
// PermissionRequest: {"decision": {"behavior": "allow"}} / {"decision": {"behavior": "deny", "message": …}} or {"decision": null}.
// UserPromptSubmit (not held: a second at most): {"voice": true} or {"voice": false}.
let finished = false;

function finish(answer) {
  if (finished) return;
  finished = true;
  let parsed = {};
  try {
    parsed = JSON.parse(answer.split("\n")[0]);
  } catch {}
  const kind = hook.hook_event_name;
  if (kind === "PermissionRequest") {
    const d = parsed.decision;
    if (d?.behavior === "allow") {
      print({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
      status("busy");
    } else if (d?.behavior === "deny") {
      const message = typeof d.message === "string" && d.message.trim() ? d.message.trim() : "The user said no.";
      print({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message } } });
      status("busy");
    }
  } else if (kind === "Stop" && typeof parsed.reply === "string" && parsed.reply.trim()) {
    // The same turn carries on with this as your message (Codex adds it as a hook prompt).
    print({ decision: "block", reason: `${VOICE_REPLY}${parsed.reply.trim()}` });
    status("busy");
  } else if (kind === "UserPromptSubmit" && parsed.voice === true) {
    // Your dictated words, typed in by the app: Codex is told so, beside the prompt (its own text stays as typed).
    print({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: VOICE_PROMPT } });
  }
  process.exit(0);
}

function print(output) {
  process.stdout.write(JSON.stringify(output));
}

/** The session's record, its status changed after Kiko's answer. */
function status(now) {
  try {
    for (const f of readdirSync(RECORDS)) {
      if (!f.endsWith(".json")) continue;
      const path = join(RECORDS, f);
      const r = read(path);
      if (r?.sessionId !== hook.session_id) continue;
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ ...r, status: now, at: Date.now() }), { mode: 0o600 });
      renameSync(temp, path);
    }
  } catch {}
}

// ── The safety gate (PreToolUse) ──

/** A shell command or MCP call checked by the gate's rules; one they flag is Kiko's to allow. */
/**
 * The gate's own code failed (its rules threw, or couldn't be loaded): denied, as when you're asked
 * and nobody answers, never let through unchecked (Codex's hook has no "ask"). Said on stderr too.
 */
function guardFailed(err) {
  const why = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${NAME}'s safety gate failed: ${why}\n`);
  print({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `${NAME}'s safety check failed on this call, so it wasn't run. Tell the user; don't try it again unless they ask you to.`,
    },
  });
  process.exit(0);
}

async function guard() {
  const sockets = SOCKETS.filter((path) => existsSync(path));
  if (!sockets.length) process.exit(0);
  // Off in Settings (the default): runs now, the rules not even loaded, the app not asked.
  if (!guardSaved()) process.exit(0);
  const { guardCheck } = await import("./guard.mjs");
  const check = guardCheck(hook.tool_name, hook.tool_input, typeof hook.cwd === "string" ? hook.cwd : "");
  if (!check) process.exit(0);
  // Another app's session (T3 Code's): that app answers its own.
  if (otherApp(hook.transcript_path)) process.exit(0);
  const event = {
    agent: "codex",
    hook_event_name: "PreToolUse",
    session_id: hook.session_id,
    cwd: hook.cwd,
    transcript_path: hook.transcript_path ?? undefined,
    turn_id: hook.turn_id,
    tool_name: hook.tool_name,
    tool_input: clipInput(hook.tool_input),
    tool_use_id: hook.tool_use_id,
    guard: check,
  };
  let asked = false;
  let done = false;
  const runs = () => {
    if (done) return;
    done = true;
    process.exit(0);
  };
  const deny = (message) => {
    if (done) return;
    done = true;
    print({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: message } });
    process.exit(0);
  };
  const NOBODY = `${NAME} asked the user and nobody allowed it, so it wasn't run. Don't try it again unless the user asks you to.`;
  converse(event, sockets, {
    onConnect: () => setTimeout(() => (asked ? deny(NOBODY) : runs()), GUARD_HOLD_MS).unref(),
    onLine: (line) => {
      let parsed = {};
      try {
        parsed = JSON.parse(line);
      } catch {}
      if (parsed.guard) {
        if (parsed.guard.ask === true) asked = true;
        else runs();
        return;
      }
      const d = parsed.decision;
      if (d?.behavior === "allow") return runs();
      if (d?.behavior === "deny") return deny(typeof d.message === "string" && d.message.trim() ? d.message.trim() : "The user said no.");
      deny(NOBODY);
    },
    // Gone without a decision once it asked: not allowed. Before any verdict (an app from before the gate): it runs.
    onClose: () => (asked ? deny(NOBODY) : runs()),
  });
}
