// The safety gate's rules for MCP tools (../guard.mjs), by name (`mcp__<server>__<tool>`, split into
// words): a read verb first is nothing; pay, delete, send and deploy words are hits; any other write
// verb is unclear, except on servers that only work on this Mac.
import { wordsOf } from "./rules-scripts.mjs";

// ── MCP tools ───────────────────────────────────────────────────────────────

/** An MCP server's name as said: "plugin_vercel_vercel" → "vercel", "claude_ai_Gmail" → "Gmail". */
export function serverName(server) {
  const s = server.replace(/^plugin_/, "").replace(/^claude_ai_/, "");
  const parts = s.split("_");
  const half = parts.length % 2 === 0 ? parts.length / 2 : 0;
  if (half && parts.slice(0, half).join("_") === parts.slice(half).join("_")) return parts.slice(0, half).join("_");
  if (parts.length === 2 && parts[0] === parts[1]) return parts[0];
  return parts.length > 1 && server.startsWith("plugin_") ? parts[parts.length - 1] : s;
}

const READ_VERBS = new Set([
  "get",
  "list",
  "search",
  "read",
  "fetch",
  "query",
  "find",
  "describe",
  "show",
  "view",
  "lookup",
  "look",
  "check",
  "count",
  "aggregate",
  "retrieve",
  "inspect",
  "browse",
  "preview",
  "explain",
  "analyze",
  "whoami",
  "status",
  "download",
  "export",
  "validate",
  "verify",
  "filter",
  "resolve",
  "diff",
  "compare",
  "summarize",
  "summarise",
  "guide",
  "docs",
  "help",
  "ping",
  "test",
  "watch",
  "snapshot",
  "screenshot",
  "wait",
  "hover",
  "navigate",
  "tabs",
  "console",
  "network",
  "evaluate",
  "emulate",
  "resize",
  "close",
  "authenticate",
  "complete",
  "select",
  "click",
  "type",
  "press",
  "drag",
  "drop",
  "fill",
  "file",
  "handle",
  "run",
]);
const WRITE_VERBS = new Set([
  "create",
  "update",
  "edit",
  "set",
  "add",
  "patch",
  "put",
  "upsert",
  "replace",
  "write",
  "modify",
  "change",
  "assign",
  "move",
  "approve",
  "accept",
  "execute",
  "trigger",
  "start",
  "stop",
  "cancel",
  "pause",
  "unpause",
  "invalidate",
  "restore",
  "rerequest",
  "activate",
  "enable",
  "disable",
  "authorize",
  "issue",
  "upload",
  "attach",
  "batch",
  "import",
  "submit",
  "apply",
  "save",
  "rename",
  "schedule",
  "archive",
  "close",
  "open",
  "rotate",
  "grant",
]);
/** Servers that only work on this Mac or the user's own documents: their writes are none of the gate's (deletes still are). */
const LOCAL_SERVERS = /^(filesystem|memory|playwright|puppeteer|ide|sequential|sequentialthinking|context7|claude_docs|chrome_devtools|browser|git|time|fetch)$/i;

/** An MCP tool's verdict (guardCheck's), from its name: `mcp__<server>__<tool>`. */
export function checkMcp(toolName, input) {
  const m = toolName.match(/^mcp__(.+?)__(.+)$/);
  if (!m) return null;
  const server = serverName(m[1]);
  const tool = m[2];
  const words = wordsOf(tool);
  if (!words.length) return null;
  const said = `use ${server}'s ${words.join(" ")}`;
  const rule = `mcp:${tool}`;
  const has = (...w) => words.some((x) => w.includes(x));
  const verb = words[0];
  const hits = [];
  const hit = (kind, what = said) => hits.push({ kind, rule, what });
  // A read first ("get_domain_price", "list_payments"): nothing, whatever follows.
  if (READ_VERBS.has(verb) && !has("send", "delete", "remove", "destroy", "purge", "pay", "buy", "deploy", "publish")) return null;
  if (has("buy", "purchase", "pay", "payment", "payments", "charge", "refund", "payout", "checkout") || (has("domain", "domains") && has("register", "transfer", "renew"))) hit("pays");
  else if (has("delete", "remove", "destroy", "drop", "purge", "erase", "wipe", "uninstall", "unpublish", "revoke", "trash")) hit("deletes");
  else if (
    has("send", "email", "reply", "forward", "notify", "sms", "dm", "invite") ||
    (has("message", "messages", "comment", "comments", "reaction") && has("post", "create", "add", "write", "send"))
  )
    hit("sends");
  else if (
    has("deploy", "deployment", "redeploy", "publish", "release", "promote", "rollback", "merge", "push", "tweet", "toot", "rolling", "dns") ||
    (has("record", "records") && has("create", "update", "replace", "add", "edit", "set")) ||
    (has("pull") && has("request", "requests") && (verb === "create" || verb === "open")) ||
    (verb === "post" && words.length > 1)
  ) {
    if (!LOCAL_SERVERS.test(m[1]) && !LOCAL_SERVERS.test(server)) hit("posts");
  }
  if (hits.length) return { hits, unclear: [] };
  if (WRITE_VERBS.has(verb) && !LOCAL_SERVERS.test(m[1].replace(/^claude_ai_/, "")) && !LOCAL_SERVERS.test(server)) {
    return { hits: [], unclear: [{ rule, what: said, args: argsShown(input) }] };
  }
  return null;
}

/** An MCP call's arguments, short, for the classifier. */
function argsShown(input) {
  try {
    const text = JSON.stringify(input ?? {});
    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
  } catch {
    return "";
  }
}
