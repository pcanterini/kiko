#!/usr/bin/env node
// Kiko's quick checks ask you before they use a tool they aren't allowed (src/core/quick-task.ts).
// A quick check is `claude -p`, which has nobody to ask, so it runs with
// `--permission-prompt-tool mcp__kiko__permission` and this as that MCP server (stdio, one tool):
// Claude Code calls `permission` with the tool it wants and its input ({tool_name, input,
// tool_use_id}), and takes back one text block holding {"behavior":"allow","updatedInput":…} or
// {"behavior":"deny","message":…}.
// Each call is sent on to the running app over its socket as the voice hook sends a session's
// permission prompt (hooks/claude-code-hook.mjs), with session_id "kiko": the app asks it like any
// session's ("Kiko's quick check wants to run whois kiko.dev. Allow?"), by voice, on its
// card and on the phone, and its answer comes back here.
// Never hangs: no socket (the app isn't running), a socket nobody answers on, a connection that
// closes without an answer, or no answer within KIKO_QUICK_ASK_MS, and it's denied.
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { appEnv, clipInput, NAME, SLUG, socketPaths } from "./lib.mjs";

// The app's socket: KIKO_SOCKET, which the app sets in the run's MCP config, else the usual one.
const [SOCKET] = socketPaths();
// The longest a call waits for the app (its own permission window comes first, once it's asked).
const WAIT_MS = Number(appEnv("QUICK_ASK_MS")) > 0 ? Number(appEnv("QUICK_ASK_MS")) : 180_000;
// What the app knows the quick check's requests by (src/core/quick-ask.ts QUICK_CHECK_ID).
const SESSION_ID = SLUG;
const TOOL = "permission";

const deny = (message) => ({ behavior: "deny", message });
const NOBODY = "Nobody allowed it, so it wasn't run. Don't try it again: answer with what you found, and say what you couldn't check.";

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message || typeof message !== "object" || message.id === undefined || message.id === null) return; // a notification
  void handle(message).then(
    (result) => write({ jsonrpc: "2.0", id: message.id, result }),
    (err) => write({ jsonrpc: "2.0", id: message.id, error: { code: err.code ?? -32603, message: err.message ?? String(err) } }),
  );
});
lines.on("close", () => process.exit(0));

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle({ method, params }) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: SLUG, version: "1.0.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: [
          {
            name: TOOL,
            description: `${NAME} asks the user whether the quick check may use a tool. Claude Code calls it; never call it yourself.`,
            inputSchema: {
              type: "object",
              properties: {
                tool_name: { type: "string", description: "The tool asking to run" },
                input: { type: "object", description: "Its input" },
                tool_use_id: { type: "string", description: "The tool call's id" },
              },
              required: ["tool_name", "input"],
            },
          },
        ],
      };
    case "tools/call": {
      if (params?.name !== TOOL) throw Object.assign(new Error(`Unknown tool: ${params?.name}`), { code: -32602 });
      const decision = await decide(params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(decision) }] };
    }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

/** The answer for one tool call: allowed with its input as it was, or denied with why. */
async function decide(args) {
  const toolName = typeof args.tool_name === "string" ? args.tool_name : "";
  const input = args.input && typeof args.input === "object" ? args.input : {};
  // Asking about this very tool: the model called it itself. Nothing to ask anyone.
  if (!toolName || toolName.startsWith(`mcp__${SLUG}__`)) return deny("Not a tool to call.");
  if (!existsSync(SOCKET)) return deny(`${NAME} isn't running, so nobody can allow it. ${NOBODY}`);
  const answer = await ask({
    hook_event_name: "PermissionRequest",
    session_id: SESSION_ID,
    cwd: process.cwd(),
    tool_name: toolName,
    // Long fields are cut for the app; the run gets the input back whole when it's allowed.
    tool_input: clipInput(input),
  });
  const decision = answer?.decision;
  if (decision?.behavior === "allow") return { behavior: "allow", updatedInput: input };
  if (decision?.behavior === "deny") return deny(`${typeof decision.message === "string" && decision.message ? `${decision.message} ` : ""}${NOBODY}`);
  return deny(NOBODY);
}

/** Sends the request and waits for the app's one line; null when there's none (closed, refused, too slow). */
function ask(event) {
  return new Promise((resolve) => {
    let answer = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), WAIT_MS);
    const socket = connect(SOCKET, () => socket.write(`${JSON.stringify(event)}\n`));
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      answer += chunk;
      if (answer.includes("\n")) finish(parse(answer));
    });
    socket.on("close", () => finish(parse(answer)));
    socket.on("error", () => finish(null));
  });
}

function parse(text) {
  try {
    return JSON.parse(text.split("\n")[0]);
  } catch {
    return null;
  }
}
