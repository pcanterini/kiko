#!/usr/bin/env node
// Claude Code hook (Stop, PermissionRequest, SessionStart, SessionEnd, UserPromptSubmit, PermissionDenied, PreToolUse) for Kiko (src/core/name.ts).
// Stop: the app speaks a summary of what Claude just said and listens briefly for a spoken reply,
// which comes back as additional context, so Claude carries on with it in the same session.
// PermissionRequest: the app asks you out loud ("Atlas agents wants to run the tests. Allow?") and
// your yes or no comes back as the decision. Claude's multiple-choice questions (AskUserQuestion)
// come this way too: their answers come back as the tool's input with `answers` added.
// SessionStart, SessionEnd: the app lists its sessions again now rather than at its next look.
// PermissionDenied: auto mode blocked a tool call (no prompt, so nothing else would tell you), and
// the app says so. These are told and not waited for: the hook is gone within a second, whatever
// happens, and prints nothing (SessionStart's output would go into Claude's context;
// PermissionDenied's could tell Claude to retry, which is never asked for).
// UserPromptSubmit: the session took a prompt in and starts its turn (the phone shows words it sent
// as started). Since 2026-11-14 the app answers it, at once, with one line: {"voice":true} when the
// prompt is your dictated words that the app just typed into this session, and then the hook prints
// one line of context for Claude beside the prompt (lib.mjs VOICE_PROMPT; nothing is added to the
// prompt's own text, and Claude Code shows none of it), as a reply through Stop has always said it
// was spoken. Anything else (a prompt typed by hand, no answer within a second, an app from before
// this): nothing printed, and the prompt goes in as it is. Gone within a second either way.
// PreToolUse: Kiko's safety gate (hooks/guard.mjs; core/guard.ts), off unless turned on in Settings:
// off, the hook reads that in the settings file and passes at once (lib.mjs guardSaved). Its rules look at a shell
// command or MCP call in code; one that sends, deletes, pays or posts (or might: the app's classifier
// decides those) goes to the app, which answers {"guard":{"ask":true,"reason":…}} or {"guard":{"ask":false}},
// and an ask is printed as permissionDecision "ask": Claude Code then asks, whatever the session's
// mode or allow rules (bypassPermissions included; checked on 2.1.316), and its prompt comes back as
// an ordinary PermissionRequest, a card. Anything else, and every call while the app isn't running,
// passes with nothing printed, at once: the session behaves as configured. Settings register it only
// for Bash, Monitor and MCP tools (./settings.ts), so reads and edits never start it.
// Every event passes on the session's permission mode (`permission_mode`, where Claude Code gives it):
// the app shows a session in another mode than the one it starts sessions in.
// With the app off, or no answer, the hook prints nothing and exits 0, and Claude Code behaves
// exactly as it would without it (for a permission, the normal prompt shows).
import { existsSync } from "node:fs";
import { appEnv, clipInput, converse, guardSaved, MAX_PROMPT, MAX_STRING, NAME, send, socketPaths, TELL_MS, tell, terminalEnv, VOICE_PROMPT, VOICE_REPLY } from "./lib.mjs";

const SOCKETS = socketPaths();
// Told and not waited for (TELL_MS at most); UserPromptSubmit's one line back is read, within the same time.
const SESSION_EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PermissionDenied"];
// The safety gate: how long the app has to give its verdict once it took the event (its classifier
// has 2.5 s of it). No verdict by then, with the app there: asked all the same.
const GUARD_WAIT_MS = Number(appEnv("GUARD_WAIT_MS")) > 0 ? Number(appEnv("GUARD_WAIT_MS")) : 6000;

// Headless runs (claude -p from scripts, Agent SDK apps) have an sdk-* entrypoint; interactive
// sessions have "cli". Nobody is listening to those, so don't announce or hold them.
if ((process.env.CLAUDE_CODE_ENTRYPOINT ?? "").startsWith("sdk")) process.exit(0);

let input = "";
let hookEvent = "";
// The tool's input as Claude Code gave it, whole: answered questions go back as it plus `answers`.
let toolInput;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", forward);
process.stdin.on("error", () => process.exit(0));

function forward() {
  const sockets = SOCKETS.filter((path) => existsSync(path));
  if (!sockets.length) process.exit(0);
  let event;
  try {
    const hook = JSON.parse(input);
    hookEvent = hook.hook_event_name;
    if (hookEvent === "PreToolUse") return void guard(hook, sockets).catch(guardFailed);
    toolInput = hook.tool_input;
    // "default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"; missing on SessionStart.
    const mode = typeof hook.permission_mode === "string" ? { permission_mode: hook.permission_mode } : {};
    const common = {
      hook_event_name: hook.hook_event_name,
      session_id: hook.session_id,
      cwd: hook.cwd,
      transcript_path: hook.transcript_path,
      ...mode,
      // "claude-desktop" sessions have no terminal: the app reaches them only through this hook.
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
      // The process that ran this hook: Claude Code's (or a shell it ran the hook in), so a session
      // ID that's strange (a parked job's) can be traced to its process and its pane.
      pid: process.ppid,
      // The terminal it runs in (lib.mjs terminalEnv): the app scripts Ghostty only for sessions there.
      terminal: terminalEnv(),
    };
    event = SESSION_EVENTS.includes(hookEvent)
      ? {
          hook_event_name: hook.hook_event_name,
          session_id: hook.session_id,
          cwd: hook.cwd,
          transcript_path: hook.transcript_path,
          ...mode,
          // SessionStart: startup, resume, clear or compact, and the process (as for Stop). SessionEnd: clear, logout, prompt_input_exit, …
          // PermissionDenied: the tool call (its long fields cut) and why ("[Data Exfiltration]").
          ...(hookEvent === "SessionStart"
            ? { source: hook.source, pid: process.ppid, terminal: terminalEnv() }
            : hookEvent === "UserPromptSubmit"
              ? { prompt: typeof hook.prompt === "string" ? hook.prompt.slice(0, MAX_PROMPT) : "", terminal: terminalEnv() }
              : hookEvent === "PermissionDenied"
                ? { tool_name: hook.tool_name, tool_input: clipInput(hook.tool_input), tool_use_id: hook.tool_use_id, reason: typeof hook.reason === "string" ? hook.reason.slice(0, MAX_STRING) : "" }
                : { reason: hook.reason }),
        }
      : hookEvent === "PermissionRequest"
        ? {
            ...common,
            tool_name: hook.tool_name,
            tool_input: clipInput(hook.tool_input),
            permission_suggestions: hook.permission_suggestions,
            // A subagent's prompt: its own transcript has the call (Kiko watches it for an answer
            // given in Claude Code's dialog). Claude Code gives PermissionRequest no tool_use_id.
            ...(typeof hook.agent_id === "string" ? { agent_id: hook.agent_id } : {}),
          }
        : { ...common, stop_hook_active: hook.stop_hook_active, last_assistant_message: hook.last_assistant_message };
  } catch {
    process.exit(0);
  }

  if (!SESSION_EVENTS.includes(hookEvent)) return send(event, sockets, finish);
  // SessionStart, SessionEnd, PermissionDenied: nothing printed (SessionStart's output would go
  // into Claude's context). UserPromptSubmit: the app's answer, if it comes in time (finish).
  setTimeout(() => process.exit(0), TELL_MS);
  if (hookEvent === "UserPromptSubmit") return send(event, sockets, finish);
  tell(event, sockets);
}

// The app answers with one line, or just closes:
// Stop: {"reply": "..."} or {"reply": null}. PermissionRequest: {"decision": {...}} or {"decision": null};
// for AskUserQuestion (Claude's questions), {"decision": {"behavior": "allow"}, "answers": {question: answer}}.
// UserPromptSubmit: {"voice": true} or {"voice": false}.
function finish(answer) {
  let parsed = {};
  try {
    parsed = JSON.parse(answer.split("\n")[0]);
  } catch {}
  if (hookEvent === "PermissionRequest") {
    let decision = parsed.decision;
    // Questions answered: the tool's own input (unclipped) with the answers added, which Claude Code
    // takes as answered at its prompt. An allow without them it ignores for that tool.
    const answers = parsed.answers;
    if (decision?.behavior === "allow" && answers && typeof answers === "object" && toolInput && typeof toolInput === "object") {
      decision = { behavior: "allow", updatedInput: { ...toolInput, answers } };
    }
    if (decision && (decision.behavior === "allow" || decision.behavior === "deny")) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }));
    }
  } else if (hookEvent === "UserPromptSubmit") {
    // Your dictated words, typed in by the app: Claude is told so, beside the prompt (checked on
    // 2.1.325: kept in the transcript as a hook_additional_context attachment after the prompt,
    // whose own text stays as typed). Only on the app's word: any line printed here is context.
    if (parsed.voice === true) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: VOICE_PROMPT } }));
  } else if (typeof parsed.reply === "string" && parsed.reply.trim()) {
    // additionalContext rather than decision "block": the session continues the same way, but the
    // transcript shows it as hook feedback instead of a hook error.
    const additionalContext = `${VOICE_REPLY}${parsed.reply.trim()}`;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext } }));
  }
  process.exit(0);
}

// ── The safety gate (PreToolUse) ──

/**
 * The gate's own code failed (its rules threw, or couldn't be loaded): asked, as when the app gives
 * no verdict in time, never let through unchecked. Said on stderr too (Claude Code's debug log).
 */
function guardFailed(err) {
  const why = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${NAME}'s safety gate failed: ${why}\n`);
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: `${NAME} asks first: its safety check failed on this call.` } }),
  );
  process.exit(0);
}

/** A tool call checked by the gate's rules; one they flag goes to the app for its verdict. */
async function guard(hook, sockets) {
  // Off in Settings (the default): passes now, the rules not even loaded, the app not asked.
  if (!guardSaved()) process.exit(0);
  const { guardCheck } = await import("./guard.mjs");
  const check = guardCheck(hook.tool_name, hook.tool_input, typeof hook.cwd === "string" ? hook.cwd : "");
  if (!check) process.exit(0);
  const mode = typeof hook.permission_mode === "string" ? { permission_mode: hook.permission_mode } : {};
  const event = {
    hook_event_name: "PreToolUse",
    session_id: hook.session_id,
    cwd: hook.cwd,
    transcript_path: hook.transcript_path,
    ...mode,
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
    pid: process.ppid,
    tool_name: hook.tool_name,
    tool_input: clipInput(hook.tool_input),
    tool_use_id: hook.tool_use_id,
    ...(typeof hook.agent_id === "string" ? { agent_id: hook.agent_id } : {}),
    guard: check,
  };
  const first = check.hits[0] ?? check.unclear[0];
  let done = false;
  const ask = (reason) => {
    if (done) return;
    done = true;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } }));
    process.exit(0);
  };
  const pass = () => {
    if (done) return;
    done = true;
    process.exit(0);
  };
  converse(event, sockets, {
    // Taken: the app is there, so an ask reaches you. No verdict in time: ask all the same.
    onConnect: () => setTimeout(() => ask(`${NAME} asks first: ${first.what}.`), GUARD_WAIT_MS).unref(),
    onLine: (line) => {
      let verdict;
      try {
        verdict = JSON.parse(line)?.guard;
      } catch {}
      if (verdict?.ask === true) ask(typeof verdict.reason === "string" && verdict.reason ? verdict.reason : `${NAME} asks first: ${first.what}.`);
      else pass();
    },
    // Closed with no verdict: an app from before the gate. It passes, as without the gate.
    onClose: pass,
  });
}
