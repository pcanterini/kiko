// Quick tasks: a one-off Claude Code run (`claude -p`) for questions that need the computer ("how
// much disk space do I have?", "is anything running on port 3000?"). Read-only: it gets the file
// reading and search tools and Bash limited to an allowlist of commands that only look, which run
// without asking. Anything else it wants is asked of you through the app, as a session's permission
// prompt is (`--permission-prompt-tool`: hooks/quick-permission.mjs, and core/quick-ask.ts), except
// what changes things, which is denied outright. Changes go to a real session.
//
// It runs in Claude Code's auto mode where the installed claude offers it (the caller asks
// agents/claude-code/modes-offered.ts), so plain read-only surveys (a for loop over `git status`,
// `docker ps`, `find`) aren't asked; else in Manual (`default`), as before. Either way it stays
// read-only without counting on the permission prompt, which auto mode's classifier can skip:
//   - the editing tools aren't in the run at all (`--tools`), and are denied besides;
//   - deny rules (`--disallowedTools`) for git writing and the plainest changes (rm, mv, docker rm,
//     ssh, …), which Claude Code applies in every mode, before any allow rule or classifier;
//   - its own PreToolUse hook (hooks/quick-guard.mjs, in the run's `--settings` file), which reads
//     every tool call before the mode does: a change (a write with >, rm, docker prune, git push,
//     curl -d, kill, an install, …) is denied; what code can't tell (python -c, a script, curl's GET)
//     and the web are sent to the permission prompt (you), never to the classifier; only what it
//     reads as looking is left to the mode. Kiko's answer to a prompt denies the same changes
//     (quick-ask.ts deniedOutright), so they're never even asked.
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { appFile, scriptArgv } from "./app-root.ts";
import { shellQuote } from "./shell.ts";
import { ENV_PREFIX, SLUG } from "./name.ts";

/** Commands a quick task may run, with any arguments: they only read the machine's state. */
export const READ_ONLY_COMMANDS = [
  // Time, the machine, the user
  "date",
  "cal",
  "uptime",
  "whoami",
  "hostname",
  "id",
  "sw_vers",
  "uname",
  "pwd",
  "which",
  // Disks and files
  "df",
  "du",
  "ls",
  "stat",
  "file",
  "wc",
  "head",
  "grep",
  "diskutil list",
  "diskutil info",
  "mdfind",
  // Processes, ports, memory, battery
  "ps",
  "pgrep",
  "lsof",
  "netstat",
  "vm_stat",
  "top -l 1",
  "pmset -g",
  "sysctl -n",
  "system_profiler",
  "ipconfig getifaddr",
  "defaults read",
  // Names on the internet: who registered a domain, where it points. They only ask; nothing changes.
  "whois",
  "dig",
  "host",
  "nslookup",
  // A project's git state
  "git status",
  "git log",
  "git diff",
  "git show",
  "git rev-parse",
  "git branch --show-current",
  "git remote -v",
  "git stash list",
] as const;

/** Tools a quick task may use: read and search, and the commands above. */
export function allowedTools(commands: readonly string[] = READ_ONLY_COMMANDS) {
  // Claude Code's rule syntax: `Bash(df)` is the bare command, `Bash(df *)` with arguments (the
  // space keeps `ls *` from matching `lsof`). Compound commands are checked part by part.
  return ["Read", "Grep", "Glob", ...commands.flatMap((c) => [`Bash(${c})`, `Bash(${c} *)`])];
}

// git's commands that change a repository, its working tree or its settings, or write a file.
const GIT_WRITES = [
  "add",
  "commit",
  "push",
  "pull",
  "fetch",
  "clone",
  "init",
  "checkout",
  "switch",
  "restore",
  "reset",
  "rm",
  "mv",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "clean",
  "tag",
  "apply",
  "am",
  "config",
  "worktree",
  "submodule",
  "gc",
  "prune",
  "update-ref",
  "notes",
  "format-patch",
  "archive",
  "bundle",
  "stash push",
  "stash pop",
  "stash apply",
  "stash drop",
  "stash clear",
  "stash save",
  "stash store",
  "stash branch",
];

// Denied outright, whatever any settings allow, never asked: the editing tools, and git writing.
// (The app denies the rest of what changes things without asking you: core/quick-ask.ts.)
// And the plainest changes, as rules too: a second layer under the hook (quick-guard.mjs), which
// catches them and far more however they're written.
const PLAIN_CHANGES = ["rm", "rmdir", "mv", "cp", "dd", "ln", "mkdir", "touch", "chmod", "chown", "truncate", "shred", "srm", "sudo", "killall", "pkill", "ssh", "scp", "sftp", "rsync", "sendmail"];
const DOCKER_CHANGES = ["docker rm *", "docker rmi *", "docker kill *", "docker stop *", "docker push *", "docker run *", "docker exec *", "docker * prune", "docker * prune *", "docker * rm *"];
export const DENIED_TOOLS = [
  "Edit",
  "Write",
  "NotebookEdit",
  "Bash(git * --output*)",
  "Bash(git stash)",
  ...GIT_WRITES.flatMap((c) => [`Bash(git ${c})`, `Bash(git ${c} *)`]),
  ...PLAIN_CHANGES.flatMap((c) => [`Bash(${c})`, `Bash(${c} *)`]),
  ...DOCKER_CHANGES.map((c) => `Bash(${c})`),
];

/** The built-in tools a quick task has: reading, searching, Bash, and the web (asked for, never allowed by itself). */
export const TOOLS = "Read,Grep,Glob,Bash,WebFetch,WebSearch";

/** The run's own PreToolUse hook, which keeps it read-only in any mode (hooks/quick-guard.mjs). */
export const GUARD_HOOK = appFile("hooks/quick-guard.mjs");

/**
 * The run's `--settings`: only its PreToolUse hook, on every tool (this Node runs it, as the
 * permission server). Your settings files aren't read (`--restricted`), so it's the run's only hook.
 */
export function settingsFor() {
  return {
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: scriptArgv("hooks/quick-guard.mjs").map(shellQuote).join(" "), timeout: 15 }] }],
    },
  };
}

/** The permission modes a quick check runs in: auto where it's offered, else Manual (`default`). */
export type QuickMode = "auto" | "default";

/** The MCP server that asks the app (hooks/quick-permission.mjs), and the tool Claude Code calls. */
export const PERMISSION_SERVER = appFile("hooks/quick-permission.mjs");
export const PERMISSION_TOOL = `mcp__${SLUG}__permission`;

/** The first line of a reply that means the task needs changes, which a quick task can't make. */
export const NEEDS_CHANGES = "NEEDS_CHANGES:";

const INSTRUCTIONS = `You are answering a quick question from someone talking to a voice assistant on their computer. You can only look: read files, search, and run the read-only commands you're allowed. Never try to change anything.
- If answering needs any change (creating, editing, moving or deleting files, installing or updating software, killing or starting processes, changing settings, committing, or network access other than the name lookups you're allowed: whois, dig, host, nslookup), don't attempt it: reply with exactly "${NEEDS_CHANGES}" and one short sentence on what would have to change.
- Otherwise answer in two or three short plain sentences with the key facts and numbers (rounded, with units). No markdown, tables or raw command output.
- Anything else you need may be asked of the user; if it's denied, don't try it again: say what you couldn't check.`;

type QuickTaskOptions = {
  task: string;
  cwd: string;
  model: string;
  maxTurns: number;
  timeoutMs: number;
  maxBudgetUsd?: number;
  /** auto where the installed claude offers it (fewer questions); else Manual, as before. Only with `ask`. */
  mode?: QuickMode;
  /**
   * Ask the app at `socket` (its hooks socket) about tools that aren't allowed, waiting at most
   * `waitMs` for each answer. Without it nothing is asked: anything not allowed is denied.
   */
  ask?: { socket: string; waitMs: number } | null;
};

/**
 * The `claude` arguments for a quick task. The task itself goes in on stdin. `mcpConfig`: the file
 * with the permission server (mcpConfigFor), which the run asks through; without it, it asks nobody.
 * `settings`: the file with its guard hook (settingsFor).
 */
export function buildArgs(o: Pick<QuickTaskOptions, "model" | "maxTurns" | "maxBudgetUsd" | "mode">, mcpConfig?: string, settings?: string) {
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    o.model,
    "--max-turns",
    String(o.maxTurns),
    ...(o.maxBudgetUsd ? ["--max-budget-usd", String(o.maxBudgetUsd)] : []),
    // Only these built-in tools exist in the run; of those, the allowed rules run, the denied ones
    // never do, and anything else is asked of the permission tool (Claude Code's default mode in
    // print mode: denied when there's none).
    "--tools",
    TOOLS,
    "--allowedTools",
    ...allowedTools(),
    "--disallowedTools",
    ...DENIED_TOOLS,
    ...(mcpConfig
      ? ["--permission-mode", o.mode ?? "default", "--mcp-config", mcpConfig, "--permission-prompt-tool", PERMISSION_TOOL]
      : ["--permission-mode", "dontAsk", "--permission-prompts", "none"]),
    // Its guard hook: what changes things is denied before the mode, or auto mode's classifier, decides.
    ...(settings ? ["--settings", settings] : []),
    // Ignores the user's settings files: their permission rules, hooks (so the run is never
    // announced or held by this app) and plugins. No MCP servers but the permission one.
    "--restricted",
    "--strict-mcp-config",
    // Not saved: nothing to resume, and nothing left in the transcripts the app reads.
    "--no-session-persistence",
    "--append-system-prompt",
    INSTRUCTIONS,
  ];
}

// The app's keys from .env aren't the run's business (and a workspace-less API key would fail it:
// without them it uses the user's Claude login). Variables Claude Code sets for its own child
// processes would make the run look like part of the session that started the app.
const STRIP =
  /^(ANTHROPIC_API_KEY|ANTHROPIC_WORKSPACE_ID|DEEPGRAM_API_KEY|CARTESIA_API_KEY|OPENROUTER_API_KEY|CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|MESSAGING_\w+|EXECPATH|SSE_PORT))$/;

/** The environment for the run: the app's, minus keys and the parent session's markers. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !STRIP.test(k)));
}

/**
 * The MCP config for the run: the permission server (this Node runs it, wherever `node` is on the
 * PATH or not; an installed copy's executable), told the app's socket and how long to wait in its
 * environment, never on a command line.
 */
export function mcpConfigFor(ask: { socket: string; waitMs: number }) {
  const permissionServer = scriptArgv("hooks/quick-permission.mjs");
  return {
    mcpServers: {
      [SLUG]: {
        type: "stdio",
        command: permissionServer[0],
        args: permissionServer.slice(1),
        env: { [`${ENV_PREFIX}SOCKET`]: ask.socket, [`${ENV_PREFIX}QUICK_ASK_MS`]: String(ask.waitMs) },
      },
    },
  };
}

type QuickTaskOutcome = "answered" | "needs_changes" | "failed" | "timeout" | "cancelled";

type QuickTaskResult = {
  outcome: QuickTaskOutcome;
  /** The answer, or for needs_changes what would have to change; for a failure, why. */
  text: string;
  durationMs: number;
  costUsd: number | null;
  numTurns: number | null;
  /** Tool calls that were denied, as "Bash: rm -rf x". */
  denied: string[];
  /** Claude Code's result subtype ("success", "error_max_turns", …), when it got that far. */
  subtype: string | null;
};

export type Spawn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;

type ResultJson = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  permission_denials?: Array<{ tool_name?: string; tool_input?: Record<string, unknown> }>;
};

/** What a run printed, as a result. */
export function parseResult(stdout: string, durationMs: number): QuickTaskResult {
  let json: ResultJson | null = null;
  try {
    json = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
  } catch {}
  if (!json || json.type !== "result") {
    return { outcome: "failed", text: stdout.trim().slice(0, 300) || "no output", durationMs, costUsd: null, numTurns: null, denied: [], subtype: null };
  }
  const denied = (json.permission_denials ?? []).map((d) => {
    const input = d.tool_input ?? {};
    const what = [input.command, input.file_path, input.url, input.query].find((v): v is string => typeof v === "string") ?? "";
    return `${d.tool_name ?? "?"}${what ? `: ${what}` : ""}`;
  });
  const text = (json.result ?? "").trim();
  const base = { durationMs, costUsd: json.total_cost_usd ?? null, numTurns: json.num_turns ?? null, denied, subtype: json.subtype ?? null };
  if (text.startsWith(NEEDS_CHANGES)) return { ...base, outcome: "needs_changes", text: text.slice(NEEDS_CHANGES.length).trim() };
  // Tried to change something and was stopped: it needs a real session, whatever it says.
  if (denied.some((d) => /^(Edit|Write|NotebookEdit)\b/.test(d)) && !text) return { ...base, outcome: "needs_changes", text: "" };
  if (json.is_error || json.subtype !== "success" || !text) return { ...base, outcome: "failed", text: text || json.subtype || "error" };
  return { ...base, outcome: "answered", text };
}

/**
 * A quick task under way: its result, and a way to stop it. `pause()` stops its clock while you're
 * asked something (a permission), and gives back what starts it again; several may overlap.
 */
export type Running = { result: Promise<QuickTaskResult>; cancel: () => void; pause: () => () => void };

/** Runs a quick task: never throws; a time limit, a failed start or a cancel come back as outcomes. */
export function runQuickTask(o: QuickTaskOptions, spawn: Spawn = nodeSpawn as Spawn): Running {
  const started = Date.now();
  let child: ChildProcess;
  let ended: QuickTaskOutcome | null = null;
  let finish: (r: QuickTaskResult) => void = () => {};
  const result = new Promise<QuickTaskResult>((resolve) => (finish = resolve));
  const fail = (outcome: QuickTaskOutcome, text: string) => finish({ outcome, text, durationMs: Date.now() - started, costUsd: null, numTurns: null, denied: [], subtype: null });
  const kill = (why: QuickTaskOutcome) => {
    if (ended) return;
    ended = why;
    child.kill("SIGTERM");
    // Claude Code ends its own commands on SIGTERM; a hung one gets SIGKILL.
    setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"), 2000).unref();
  };
  // The permission server's config and the guard hook's settings, in a folder only you can read, gone with the run.
  let folder: string | null = null;
  const tidy = () => {
    if (folder) rmSync(folder, { recursive: true, force: true });
    folder = null;
  };
  try {
    let mcpConfig: string | undefined;
    folder = mkdtempSync(join(tmpdir(), `${SLUG}-quick-`));
    const settings = join(folder, "settings.json");
    writeFileSync(settings, JSON.stringify(settingsFor()), { mode: 0o600 });
    if (o.ask) {
      mcpConfig = join(folder, "mcp.json");
      writeFileSync(mcpConfig, JSON.stringify(mcpConfigFor(o.ask)), { mode: 0o600 });
    }
    child = spawn("claude", buildArgs(o, mcpConfig, settings), { cwd: o.cwd || homedir(), env: childEnv() });
  } catch (err) {
    tidy();
    fail("failed", err instanceof Error ? err.message : String(err));
    return { result, cancel: () => {}, pause: () => () => {} };
  }
  // The time limit, which doesn't run while you're being asked something.
  let left = o.timeoutMs;
  let since = Date.now();
  let timer: NodeJS.Timeout | null = setTimeout(() => kill("timeout"), left);
  let paused = 0;
  let over = false;
  const stopClock = () => {
    over = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const pause = () => {
    if (paused++ === 0 && timer) {
      clearTimeout(timer);
      timer = null;
      left = Math.max(0, left - (Date.now() - since));
    }
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      if (--paused > 0 || ended || over) return;
      since = Date.now();
      timer = setTimeout(() => kill("timeout"), left);
    };
  };
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (c) => (stdout += c));
  child.stderr?.on("data", (c) => (stderr += c));
  child.on("error", (err) => {
    stopClock();
    tidy();
    fail("failed", err.message);
  });
  child.on("close", () => {
    stopClock();
    tidy();
    if (ended === "timeout") return fail("timeout", `no answer within ${Math.round(o.timeoutMs / 1000)}s`);
    if (ended === "cancelled") return fail("cancelled", "cancelled");
    const r = parseResult(stdout, Date.now() - started);
    finish(r.outcome === "failed" && !stdout.trim() && stderr.trim() ? { ...r, text: stderr.trim().slice(0, 300) } : r);
  });
  child.stdin?.on("error", () => {});
  child.stdin?.end(o.task);
  return { result, cancel: () => kill("cancelled"), pause };
}
