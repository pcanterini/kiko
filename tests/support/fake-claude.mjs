#!/usr/bin/env node
// A stand-in for `claude -p` in a quick task (src/core/quick-task.ts), for the tests: never the real
// Claude. It reads the task on stdin, then wants one tool that isn't allowed (FAKE_CLAUDE_ASK, a JSON
// {tool_name, input}; `whois pebble.com` by default) and asks for it the way Claude Code does
// with --permission-prompt-tool: it starts the MCP server in --mcp-config (stdio, JSON-RPC), and calls
// the tool named there with {tool_name, input, tool_use_id}. Without a permission tool, it's denied
// (as --permission-prompts none would). It prints a `result` line as `--output-format json` does:
// an answer when it was allowed, what it couldn't check (and permission_denials) when it wasn't.
// FAKE_CLAUDE_RECORD: a file it writes what it was given and answered to, for a test to read.
// With --settings, it runs the PreToolUse hooks there first, as Claude Code does (the quick check's
// guard, hooks/quick-guard.mjs): a deny is denied before anything else; an ask goes to the permission
// tool. In --permission-mode auto, anything the hooks don't deny or ask about is let through, as the
// most permissive classifier would: what a quick check can't do must be stopped before it.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const wanted = process.env.FAKE_CLAUDE_ASK ? JSON.parse(process.env.FAKE_CLAUDE_ASK) : { tool_name: "Bash", input: { command: "whois pebble.com" } };

let task = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (task += c));
process.stdin.on("end", () => void main().catch((err) => finish({ type: "result", subtype: "error_during_execution", is_error: true, result: String(err?.message ?? err) })));

async function main() {
  const configPath = valueOf("--mcp-config");
  const promptTool = valueOf("--permission-prompt-tool");
  const settingsPath = valueOf("--settings");
  const hook = settingsPath ? await preToolUse(settingsPath) : null;
  let decision;
  if (hook?.permissionDecision === "deny") decision = { behavior: "deny", message: hook.permissionDecisionReason ?? "", by: "hook" };
  else if (hook?.permissionDecision !== "ask" && valueOf("--permission-mode") === "auto") decision = { behavior: "allow", by: "auto" };
  else decision = configPath && promptTool ? { ...(await askThrough(configPath, promptTool)), by: "prompt" } : { behavior: "deny", message: "No permission prompt tool." };
  const record = { args, task, decision };
  if (process.env.FAKE_CLAUDE_RECORD) writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify(record));
  const base = { type: "result", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0.001 };
  if (decision.behavior === "allow") {
    finish({ ...base, result: "pebble.com is registered; pebble.dev and pebble.io look free.", permission_denials: [] });
  } else {
    finish({
      ...base,
      result: "I couldn't check whether pebble.com is registered: running whois was denied.",
      permission_denials: [{ tool_name: wanted.tool_name, tool_use_id: "toolu_fake_1", tool_input: wanted.input }],
    });
  }
}

/** The PreToolUse hooks in the settings file, run as Claude Code runs them (a shell command, the event on stdin); the strictest answer. */
async function preToolUse(settingsPath) {
  const entries = JSON.parse(readFileSync(settingsPath, "utf8")).hooks?.PreToolUse ?? [];
  const event = {
    hook_event_name: "PreToolUse",
    session_id: "fake",
    cwd: process.cwd(),
    permission_mode: valueOf("--permission-mode"),
    tool_name: wanted.tool_name,
    tool_input: wanted.input,
    tool_use_id: "toolu_fake_1",
  };
  const rank = { allow: 1, ask: 2, deny: 3 };
  let strictest = null;
  for (const entry of entries) {
    if (entry.matcher && entry.matcher !== "*" && !new RegExp(`^(${entry.matcher})$`).test(wanted.tool_name)) continue;
    for (const h of entry.hooks ?? []) {
      const out = await new Promise((resolve) => {
        const child = spawn("sh", ["-c", h.command], { stdio: ["pipe", "pipe", "inherit"] });
        let text = "";
        child.stdout.on("data", (c) => (text += c));
        child.on("close", (code) => resolve({ code, text }));
        child.stdin.end(JSON.stringify(event));
      });
      const said = out.code === 2 ? { permissionDecision: "deny", permissionDecisionReason: "exit 2" } : out.text.trim() ? JSON.parse(out.text).hookSpecificOutput : null;
      if (said?.permissionDecision && (rank[said.permissionDecision] ?? 0) > (rank[strictest?.permissionDecision] ?? 0)) strictest = said;
    }
  }
  return strictest;
}

function finish(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

/** Asks the permission tool on the MCP server in the config, as Claude Code does; its decision. */
async function askThrough(configPath, promptTool) {
  const [, serverName, toolName] = promptTool.match(/^mcp__(.+?)__(.+)$/) ?? [];
  const server = JSON.parse(readFileSync(configPath, "utf8")).mcpServers?.[serverName];
  if (!server) return { behavior: "deny", message: `The permission prompt tool's server ${serverName} isn't in the config.` };
  const child = spawn(server.command, server.args ?? [], { env: { ...process.env, ...(server.env ?? {}) }, stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const m = JSON.parse(line);
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  });
  let id = 0;
  const request = (method, params) =>
    new Promise((resolve) => {
      const mine = ++id;
      pending.set(mine, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: mine, method, params })}\n`);
    });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const listed = await request("tools/list", {});
  if (!listed.result?.tools?.some((t) => t.name === toolName)) throw new Error(`no ${toolName} on ${serverName}`);
  const called = await request("tools/call", { name: toolName, arguments: { tool_name: wanted.tool_name, input: wanted.input, tool_use_id: "toolu_fake_1" } });
  child.stdin.end();
  const content = called.result?.content;
  if (!Array.isArray(content) || content.length !== 1 || content[0].type !== "text") throw new Error("the permission prompt tool returned an invalid result");
  return JSON.parse(content[0].text);
}
