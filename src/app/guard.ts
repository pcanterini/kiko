// The safety gate in the app (core/guard.ts has the verdict, hooks/guard.mjs the rules): its
// settings, the classifier for calls the rules couldn't place, the logs, and the mark on the prompt
// that follows. Set on the agents together at start (src/app.ts: agent.onGuard).
//
// Logged: `guard_ask` (agent, session, kind, rule, by: rule / classifier / unsure, what: the call as the
// permission logs show it, ms) for every ask; `guard_pass` (why) for a flagged call that wasn't asked,
// so misses and false alarms can be checked against the logs; `guard_answer` once you answer one.
import { log, totals } from "../core/log.ts";
import { config } from "../core/config.ts";
import { classifierEnabled } from "../core/classifier.ts";
import { decideGuardKind, describeTool } from "../core/decisions.ts";
import { CLASSIFY_BUDGET_MS, decideGuard, noteGuard, type GuardCheck, type GuardVerdict } from "../core/guard.ts";

/** The gate's verdict on a call an agent's hook flagged, logged and noted for the prompt that follows. */
export async function guardFor(check: GuardCheck): Promise<GuardVerdict> {
  const start = performance.now();
  const base = { agent: check.agent, sessionId: check.sessionId, tool: check.tool.name, what: describeTool(check.tool.name, check.tool.input), ...(check.mode ? { mode: check.mode } : {}) };
  // Codex's held call is a card or nothing: with permission cards off, nothing could answer it but a
  // deny, so it runs as configured. (Claude Code's ask still shows its own prompt in its window.)
  if (check.agent === "codex" && !config.voicePermissions) {
    log("guard_pass", { ...base, why: "permission cards off", rule: check.hits[0]?.rule ?? check.unclear[0]?.rule });
    return { ask: false, why: "permission cards off" };
  }
  const verdict = await decideGuard(check, {
    on: config.guard,
    off: config.guardOff,
    classify: classifierEnabled()
      ? async (u, tool) => {
          const request = u.args ? `${u.what} with ${u.args}` : tool.name === "Bash" || tool.name === "Monitor" ? describeTool(tool.name, tool.input) : u.what;
          const r = await decideGuardKind({ request });
          totals.classifier += r.costUsd;
          log("guard_classified", { sessionId: check.sessionId, rule: u.rule, kind: r.kind, confidence: r.confidence, ms: r.ms });
          return { kind: r.kind, costUsd: r.costUsd, ms: r.ms };
        }
      : undefined,
    budgetMs: CLASSIFY_BUDGET_MS,
  });
  const ms = Math.round(performance.now() - start);
  if (verdict.ask) {
    noteGuard(check, verdict);
    log("guard_ask", { ...base, kind: verdict.kind, rule: verdict.rule, by: verdict.by, said: verdict.what, ms });
  } else {
    log("guard_pass", { ...base, why: verdict.why, rule: verdict.rule, ms });
  }
  return verdict;
}
