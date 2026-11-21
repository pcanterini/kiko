// Quick tasks (core/quick-task.ts): "how much disk space do I have?" checked by a one-off,
// read-only Claude Code run in the background, its answer said when it's done, and its permission
// prompts asked like a session's.

import { config } from "../core/config.ts";
import { flat, shortPath } from "../core/text.ts";
import type { Said } from "../core/unplayed.ts";
import { needsChanges, NEEDS_CHANGES_SEND } from "../core/decide.ts";
import { allowedTools, runQuickTask } from "../core/quick-task.ts";
import { HAND_OFF_LINE, loadQuickAlways, offersHandOff, QUICK_ALWAYS_FILE, QuickAsk, quickVerdict, rememberQuickAlways } from "../core/quick-ask.ts";
import { envVar, SOCKET_PATH } from "../core/name.ts";
import type { Held } from "../agents/types.ts";
import { ui } from "../core/ui-store.ts";
import { offersMode } from "../agents/claude-code/modes-offered.ts";
import { log, totals } from "../core/log.ts";
import { quickCostNote } from "../core/cost-lines.ts";
import { writeState } from "./status.ts";
import { landed } from "./deliver.ts";
import { allowed } from "./session-ops.ts";
import { openSpeech, speakLine, ttsCost } from "./speech.ts";
import { QUICK_ASK_WAIT_MS, answerer, floor, secs, state, timeline, whatOf } from "./state.ts";

// ── Quick tasks ─────────────────────────────────────────────────────────────

type Quick = NonNullable<typeof state.quick>;
/** The quick task whose answer isn't said yet: still running, or done and waiting for you to stop talking. */
let unsaid: Quick | null = null;
/** Quick tasks a correction took off the app (dropQuickTask): their answer is never said. */
const dropped = new WeakSet<Quick>();

/**
 * "How much disk space do I have?": a one-off, read-only Claude Code run (quick-task.ts) in the
 * background, while the app goes on listening and announcing. Its answer is spoken when it's done.
 */
export async function startQuickTask(task: string, cwd: string, said: string) {
  if (!(await allowed("check", { then: () => startQuickTask(task, cwd, said) }))) return;
  if (state.quick) return speakLine("I'm still checking the last thing. Say cancel to stop it.");
  // What it isn't allowed is asked of you through the hooks socket (quick-ask.ts), within this long.
  const ask = { socket: envVar("SOCKET") ?? SOCKET_PATH, waitMs: QUICK_ASK_WAIT_MS };
  // Auto mode where this claude offers it (read once a run from its --help): plain read-only surveys
  // aren't asked. Else Manual, as before. Read-only either way (core/quick-task.ts).
  const auto = await offersMode("auto").catch(() => false);
  const mode = auto ? ("auto" as const) : ("default" as const);
  if (state.quick) return speakLine("I'm still checking the last thing. Say cancel to stop it.");
  const options = { task, cwd, model: config.quickTaskModel, maxTurns: config.quickTaskMaxTurns, timeoutMs: config.quickTaskTimeoutMs, ask, mode };
  state.handOff = null;
  const mine = { task, cwd, startedAt: Date.now(), run: runQuickTask(options) };
  state.quick = mine;
  unsaid = mine;
  landed(null);
  ui.task(`${task} (in ${shortPath(cwd)}, ${config.quickTaskModel}, read-only)`);
  log("quick_task_start", { said, ...options, allowedTools: allowedTools(), ...(auto ? {} : { autoUnavailable: true }) });
  void finishQuickTask(mine, said);
  await speakLine("Checking.");
}

/** Says what the quick task found, once you're not talking and your words aren't being dealt with. */
async function finishQuickTask(mine: Quick, said: string) {
  try {
    await sayQuickResult(mine, said);
  } finally {
    if (unsaid === mine) unsaid = null;
  }
}

async function sayQuickResult(mine: Quick, said: string) {
  const r = await mine.run.result;
  if (state.quick === mine) state.quick = null;
  writeState();
  // What the run reports (claude's own, on your Claude plan or key): none on Kiko's subscription either (core/dollars.ts).
  const cost = quickCostNote(r.costUsd);
  ui.task(`${r.outcome} in ${secs(r.durationMs)}${cost}${r.numTurns ? ` · ${r.numTurns} turns` : ""}${r.text ? `: ${r.text}` : ""}`);
  if (r.denied.length) ui.info(`(denied: ${r.denied.map((d) => flat(d, 60)).join("; ")})`);
  log("quick_task", {
    said,
    task: mine.task,
    cwd: mine.cwd,
    model: config.quickTaskModel,
    allowedTools: allowedTools(),
    outcome: r.outcome,
    durationMs: r.durationMs,
    // What the run reports; on a Claude plan it comes out of the plan's Agent SDK credit, not the API.
    costUsd: r.costUsd,
    numTurns: r.numTurns,
    subtype: r.subtype,
    denied: r.denied,
    text: r.text,
  });
  if (r.outcome === "cancelled") return; // cancelQuickTask said so
  while (floor.pressed || floor.replying) await new Promise((resolve) => setTimeout(resolve, 100));
  // "That was for Rowan": the words went there instead, and what was found here isn't said.
  if (dropped.has(mine)) return;
  // What it ends with is said as the check's result: the phone keeps it as "Kiko checked: <task>".
  const checked = { checked: mine.task };
  if (r.outcome === "timeout") return speakLine("That took too long, so I stopped checking.", true, undefined, checked);
  // Something it couldn't check, or needing changes: offered to a session, once.
  const offer = offersHandOff(r);
  if (r.outcome === "failed") return speakLine(offer ? offerHandOff(mine, HAND_OFF_LINE) : "I couldn't check that.", true, undefined, checked);
  // Nothing was changed; it offers a session that can.
  if (r.outcome === "needs_changes") return speakLine(offerHandOff(mine, needsChanges(ui.state.sessions, mine.cwd)), true, undefined, checked);
  // In a sentence or two, and never command output read out.
  const answer: Said = { sessionId: null, name: null, kind: "line", text: "" };
  const speech = await openSpeech(undefined, undefined, answer);
  let text = "";
  try {
    const result = await answerer.answer({ question: said, found: r.text }, (delta) => speech.push(delta));
    if (!result) return speech.cancel(); // a press cut it
    text = result.text.trim();
    totals.llm += result.costUsd;
  } catch (err) {
    log("error", { where: "quick_answer", message: err instanceof Error ? err.message : String(err) });
  }
  // Without a summary, what the run said: it's asked for short plain sentences.
  if (!text) {
    text = r.text;
    speech.push(text);
  }
  speech.end();
  ttsCost(speech.chars());
  state.lastSpoken = answer.text = text;
  timeline.add({ who: "app", sessionId: null, folder: null, text });
  ui.voice(text, checked);
  if (offer) await speakLine(offerHandOff(mine, HAND_OFF_LINE));
}

/**
 * The offer of a session for a quick task (`line`), kept so that a yes to it starts one with the task
 * (decide.ts handOff). needsChanges offering a session already there is left to the router, as before.
 */
export function offerHandOff(task: { task: string; cwd: string }, line: string) {
  state.handOff = line.startsWith(NEEDS_CHANGES_SEND) ? null : { task: task.task, cwd: task.cwd, line };
  log("quick_hand_off", { task: task.task, cwd: task.cwd, line });
  return line;
}

/**
 * A quick task asks to use a tool it isn't allowed (quick-ask.ts): denied outright when it would
 * change things, allowed when you allowed that command for good, else held and asked like a
 * session's prompt (the card, voice, the phone) while the task's clock stops. Only while one runs.
 */
export function quickAsked(request: Held): QuickAsk | null {
  const tool = request.tool;
  if (!state.quick) {
    log("quick_ask", { tool: tool?.name, verdict: "deny", why: "no quick check running" });
    request.deny("No quick check is running.");
    return null;
  }
  const v = quickVerdict(tool, loadQuickAlways());
  log("quick_ask", { tool: tool?.name, what: whatOf(request), verdict: v.verdict, ...("why" in v ? { why: v.why } : {}) });
  if (v.verdict === "deny") {
    request.deny(v.why);
    ui.info(`(quick check: denied ${whatOf(request)}: ${v.why})`);
    return null;
  }
  if (v.verdict === "allow") {
    request.allow(false);
    ui.info(`(quick check: allowed ${whatOf(request)}, as you said always)`);
    return null;
  }
  const resume = state.quick.run.pause();
  return new QuickAsk(request, {
    remember: (command) => {
      if (!rememberQuickAlways(command)) ui.info(`(couldn't keep "${command}" for good in ${QUICK_ALWAYS_FILE})`);
    },
    done: resume,
  });
}

/**
 * "Send that to Rowan", "that was for Rowan" right after a quick check (decide.ts handledBy): the
 * words go to that session instead, so the check stops if it's still running, and what it found
 * isn't said if it's done but not yet read out (2026-11-20: it was read out after the words went).
 * True when there was one to stop or keep quiet; false when its answer was said already.
 */
export function dropQuickTask(said: string): boolean {
  const mine = unsaid;
  if (!mine) return false;
  unsaid = null;
  dropped.add(mine);
  const running = state.quick === mine;
  log("quick_task_dropped", { said, task: mine.task, running, afterMs: Date.now() - mine.startedAt });
  if (running) {
    mine.run.cancel();
    state.quick = null;
    writeState();
  }
  return true;
}

/** "Stop", "cancel that" while a quick task runs. */
export async function cancelQuickTask(said: string) {
  timeline.add({ who: "you", sessionId: null, folder: null, text: said });
  if (!state.quick) return speakLine("Nothing's being checked.");
  log("quick_task_cancel", { said, task: state.quick.task, afterMs: Date.now() - state.quick.startedAt });
  state.quick.run.cancel();
  state.quick = null;
  writeState();
  await speakLine("Stopped checking.");
}
