#!/usr/bin/env node
// Kiko's quick checks only look (src/core/quick-task.ts), whatever their permission mode: this is
// their PreToolUse hook, passed to the run alone in its own `--settings` file (the run ignores your
// settings files, so none of yours or Kiko's other hooks run there). Claude Code asks it before every
// tool call; it answers from the call itself (guard/read-only.mjs quickToolVerdict):
//   deny   what would change something or reach out (rm, a write with >, git push, docker rm or
//          prune, curl -d, ssh, kill, an install, an editing tool): blocked before any permission
//          rule, mode or auto mode's classifier is consulted
//   ask    what code can't tell (python -c, a script, curl's GET) and the web: sent to the permission
//          prompt (Kiko's, through --permission-prompt-tool), never left to auto mode's classifier
//   pass   what only looks: nothing said, so the mode decides (auto lets it through; Manual runs what
//          the allow rules cover and asks the rest)
// Fails closed: input it can't read, or anything going wrong, is a deny.
import { quickToolVerdict } from "./guard/read-only.mjs";

const decide = (decision, reason) => {
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } })}\n`);
  process.exit(0);
};

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const event = JSON.parse(input);
    const v = quickToolVerdict(event?.tool_name, event?.tool_input);
    if (v.decision === "deny") return decide("deny", `${v.why} Don't try it again: answer with what you found, or reply NEEDS_CHANGES: if it needs a change.`);
    if (v.decision === "ask") return decide("ask", v.why);
    process.exit(0);
  } catch (err) {
    decide("deny", `Kiko couldn't check this call (${err instanceof Error ? err.message : String(err)}), so it wasn't run.`);
  }
});
process.stdin.on("error", () => decide("deny", "Kiko couldn't read this call, so it wasn't run."));
