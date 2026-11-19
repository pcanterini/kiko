// Kiko's safety gate, the rules: whether a tool call an agent is about to
// make sends, deletes, pays or posts, read from the call itself in code, with no model and nothing
// read from the network. The hooks run it before every shell command and MCP tool call
// (claude-code-hook.mjs and codex-hook.mjs, PreToolUse); only a call it flags goes to the app, which
// then asks you (core/guard.ts), whatever the session's permission mode or allow rules.
//
// A call is one of:
//   hits       a rule matched for sure: "git push" is posts, "rm -rf ~/x" deletes, "stripe charges
//              create" pays, "curl -d … https://hooks.slack.com/…" sends
//   unclear    it looks risky but code can't tell ("./deploy.sh", "pnpm run release", an MCP tool
//              that writes somewhere): the app's classifier decides, and when it can't, asks
//   nothing    the rest: reads, edits, builds, tests, ordinary local commands (most calls)
// Shell commands are parsed, not grepped: `a && b; c | d`, subshells, $(…) and backticks, `bash -c`,
// `eval`, `ssh host cmd`, heredocs, and the prefixes that only run what follows (sudo, env and
// VAR=x, npx, xargs, nohup, time, …), so "echo 'git push'" and "grep deploy" are nothing, and
// "cd x && sudo -E NODE_ENV=prod npx wrangler deploy" is a hit.
//
// The parser is guard/parse.mjs; the rules are guard/rules-*.mjs: what reaches another machine
// (remote: git, gh, curl, mail, scp), files and databases (local), deploys and publishes (deploy),
// risky names and inline code (scripts), and MCP tools (mcp). Few files: each costs the hook's start
// about 0.15 ms to load.
//
// Imports only node:path and its own files (no src/): it runs inside the hook, on every shell
// command, so it stays small and fast; the app imports it too for its tests and its Settings words.
import { basename } from "node:path";
import { afterOptions, MAX_DEPTH, parseShell, SHELLS, unwrap } from "./guard/parse.mjs";
import { CLOUD_RULES, PACKAGE_RULES } from "./guard/rules-deploy.mjs";
import { DATA_RULES, FILE_RULES } from "./guard/rules-local.mjs";
import { checkMcp } from "./guard/rules-mcp.mjs";
import { GIT_RULES, NETWORK_RULES } from "./guard/rules-remote.mjs";
import { genericRule, READ_ONLY, SCRIPT, SCRIPT_RULES, scriptRule } from "./guard/rules-scripts.mjs";

export { checkMcp, parseShell, unwrap };
export { safeToRemove } from "./guard/rules-local.mjs";
export { serverName } from "./guard/rules-mcp.mjs";

/** The kinds, in the order they're shown and said. */
export const KINDS = ["sends", "deletes", "pays", "posts"];

/** Each kind's words, for Settings and the card. */
export const KIND_INFO = {
  sends: { label: "Sends", covers: "email, messages, Slack, webhooks, POSTs to other hosts, GitHub comments" },
  deletes: { label: "Deletes", covers: "rm -r outside build folders, dropped tables, deleted branches, cloud resources" },
  pays: { label: "Pays", covers: "payment APIs, Stripe changes, purchases, domain registration" },
  posts: { label: "Posts", covers: "git push, PR merges, deploys, npm and PyPI publishes, releases, DNS changes" },
};

/** The longest command looked at; anything past it is cut (a heredoc writing a big file, say). */
const MAX_COMMAND = 200_000;

// ── The verdict ──────────────────────────────────────────────────────────────

/**
 * What the gate makes of one tool call: `hits` (kind, rule, what: "push to GitHub"), `unclear`
 * (rule, what, and the kind its words suggest, `hint`, when they do), or null when it's nothing.
 * `toolName`/`toolInput` as the agent gives them (Claude Code's and Codex's `Bash` {command}, an MCP
 * tool's name and arguments); `cwd` the session's folder (for "inside the project" and git's remote).
 */
export function guardCheck(toolName, toolInput, cwd = "") {
  if (typeof toolName !== "string") return null;
  if (toolName === "Bash" || toolName === "Monitor" || toolName === "shell" || toolName === "exec_command") {
    const command = commandOf(toolInput);
    return command ? checkCommand(command, cwd) : null;
  }
  if (toolName.startsWith("mcp__")) {
    const found = checkMcp(toolName, toolInput);
    // An MCP tool that runs a shell command (`…__run_shell {cmd}`): the command's own verdict too.
    const command = /(^|_)(shell|bash|zsh|terminal|exec|command|run_command|execute_command)(_|$)/i.test(toolName.replace(/^mcp__.+?__/, "")) ? commandOf(toolInput) : "";
    const inner = command ? checkCommand(command, cwd) : null;
    if (!inner) return found;
    if (!found) return inner;
    return { hits: dedupe([...found.hits, ...inner.hits]), unclear: dedupe([...found.unclear, ...inner.unclear]) };
  }
  return null;
}

/** A shell tool's command: a string (Claude Code, Codex), or an argv (["bash", "-lc", "…"]). */
function commandOf(input) {
  const command = input?.command ?? input?.cmd;
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((w) => typeof w === "string")) {
    if (command.length >= 3 && SHELLS.has(basename(command[0])) && /^-[a-z]*c[a-z]*$/.test(command[1])) return command[2];
    return command.map(quote).join(" ");
  }
  return "";
}

const quote = (w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

/** A shell command's verdict (guardCheck's), from every simple command in it. */
export function checkCommand(command, cwd = "") {
  const hits = [];
  const unclear = [];
  const ctx = { cwd, gitHostCache: undefined };
  const cmds = parseShell(command.slice(0, MAX_COMMAND));
  for (const cmd of cmds) {
    const found = classify(cmd, ctx, 0);
    for (const f of found) (f.kind ? hits : unclear).push(f);
  }
  // What the parser couldn't read for sure (a ( inside a word, a quote never closed): a command
  // hidden there would be missed, so it's unclear, never nothing.
  if (cmds.rough.length) unclear.push(roughFinding(cmds.rough));
  if (!hits.length && !unclear.length) return null;
  return { hits: dedupe(hits), unclear: dedupe(unclear) };
}

const roughFinding = (rough) => ({ rule: "shell:unread", what: `run shell syntax the gate can't read for sure (${rough[0]})` });

/** The prefixes before a command that hand it words it never sees written (`… | xargs git`). */
const FEEDS = new Set(["xargs", "parallel"]);
/** CLIs whose command is their first word: named by an expansion (`git $(echo push)`), they're unclear. */
const WORDY = new Set(["git", "gh"]);
/** What xargs feeding words to is unclear: CLIs that reach another machine, and shells. */
const FED = new Set([...WORDY, ...SHELLS, "eval", ...Object.keys(GIT_RULES), ...Object.keys(NETWORK_RULES), ...Object.keys(CLOUD_RULES), ...Object.keys(PACKAGE_RULES)]);
/** Inline code that runs other commands, by language: its strings are read as commands too. */
const SHELL_OUT = {
  perl: /\b(system|exec|qx)\b|`|\bopen\s*\(?[^;]*\|/,
  ruby: /\b(system|exec|spawn|%x)\b|`|\bIO\.popen\b|\bOpen3\b/,
  python: /\bos\.(system|popen|exec\w*|spawn\w*)\b|\bsubprocess\b|\bpty\.spawn\b/,
  python3: /\bos\.(system|popen|exec\w*|spawn\w*)\b|\bsubprocess\b|\bpty\.spawn\b/,
  node: /\bchild_process\b|\b(execSync|execFileSync|spawnSync|execFile|spawn)\s*\(/,
  bun: /\bchild_process\b|\bBun\.(spawn|spawnSync|\$)|\b(execSync|spawnSync)\s*\(/,
  deno: /\bDeno\.(run|Command)\b/,
  php: /\b(system|exec|shell_exec|passthru|popen|proc_open)\s*\(|`/,
  osascript: /\bdo shell script\b/i,
};

const dedupe = (list) => list.filter((f, i) => list.findIndex((g) => g.rule === f.rule && g.what === f.what) === i);

// ── The rules ───────────────────────────────────────────────────────────────

/** git's options before its command that take a value. */
const GIT_GLOBAL = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix"]);

/** Each CLI's rule, by its name (classify's). */
const RULES = { ...GIT_RULES, ...NETWORK_RULES, ...FILE_RULES, ...DATA_RULES, ...CLOUD_RULES, ...PACKAGE_RULES, ...SCRIPT_RULES };

/**
 * Commands whose risky subcommands are known: a rule each (classify's). Everything else is looked
 * at only by name (scripts and package scripts with risky words in them: unclear).
 */
function classify(cmd, ctx, depth) {
  const w = unwrap(cmd.words);
  if (!w.length) return [];
  const name = basename(w[0]);
  const args = w.slice(1);
  const found = [];
  const hit = (kind, rule, what) => found.push({ kind, rule, what });
  const unsure = (rule, what, hint) => found.push({ rule, what, ...(hint ? { hint } : {}) });
  const inner = (script) => {
    if (depth >= MAX_DEPTH || typeof script !== "string") return;
    const cmds = parseShell(script, depth + 1);
    for (const c of cmds) found.push(...classify(c, ctx, depth + 1));
    if (cmds.rough.length) found.push(roughFinding(cmds.rough));
  };

  // A command named by an expansion (`$g push`, `$(echo git) push`), or git and gh with their
  // command from one (`git $(echo push)`): what runs isn't written. Unclear.
  if (w[0].includes("$")) {
    unsure("shell:dynamic", "run a command named by an expansion");
    return found;
  }
  const sub = name === "git" ? afterOptions(args, GIT_GLOBAL)[0] : args.find((a) => !a.startsWith("-"));
  if (WORDY.has(name) && sub?.includes("$")) unsure("shell:dynamic", `run ${name} with its command from an expansion`, "posts");
  // xargs handing git, gh or a shell their words (`echo push | xargs git`): unclear.
  const lead = cmd.words.slice(0, cmd.words.length - w.length).map((x) => basename(x));
  if (lead.some((x) => FEEDS.has(x)) && FED.has(name)) unsure(`xargs:${name}`, `run ${name} with words from xargs`);
  // git -c alias.x=… (or --config-env): a git command named on the command line.
  if (name === "git") {
    for (let i = 0; i < args.length && args[i].startsWith("-"); i++) {
      const a = args[i];
      const value = a === "-c" || a === "--config-env" ? (args[i + 1] ?? "") : a.replace(/^(-c|--config-env=)/, "");
      if ((a.startsWith("-c") || a.startsWith("--config-env")) && /^alias\./i.test(value)) {
        unsure("git:alias", "run a git alias set on the command line", "posts");
        break;
      }
    }
  }
  // Inline code that shells out (`perl -e 'system("git push")'`): each of its strings as a command.
  if (Object.hasOwn(SHELL_OUT, name)) {
    const flag = args.findIndex((a) => /^-[a-zA-Z]*[ce]$|^--eval$/.test(a));
    const code = flag >= 0 ? (args[flag + 1] ?? "") : (cmd.heredoc ?? "");
    if (SHELL_OUT[name].test(code)) {
      const before = found.length;
      for (const m of code.matchAll(/"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`([^`]*)`/g)) inner(m[1] ?? m[2] ?? m[3]);
      if (found.length === before) unsure(`inline:${name}`, `run ${name} code that runs other commands`);
    }
  }

  // A shell running a script: `bash -c "…"`, `sh -lc '…'`, `bash <<EOF`, `bash deploy.sh`.
  if (SHELLS.has(name)) {
    const flagC = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (flagC >= 0) inner(args[flagC + 1]);
    else if (cmd.heredoc !== undefined && !args.some((a) => !a.startsWith("-"))) inner(cmd.heredoc);
    else {
      const script = args.find((a) => !a.startsWith("-"));
      if (script) scriptRule(script, unsure);
    }
    return found;
  }
  if (name === "eval") {
    inner(args.join(" "));
    return found;
  }
  if (name === "ssh") {
    const rest = afterOptions(args, new Set(["-p", "-i", "-l", "-o", "-F", "-J", "-L", "-R", "-D", "-b", "-c", "-e", "-m", "-O", "-Q", "-S", "-W", "-w", "-E", "-B"]));
    const host = rest[0];
    const remote = rest.slice(1).join(" ") || (cmd.heredoc ?? "");
    if (host && remote) {
      const before = found.length;
      inner(remote);
      for (let k = before; k < found.length; k++) found[k] = { ...found[k], what: `${found[k].what} on ${host}`, rule: `ssh:${found[k].rule}` };
    }
    return found;
  }

  // curl -K reads its options from a file: a POST could be in it.
  if (name === "curl" && args.some((a) => /^(-K|--config)(=|$)|^-[a-zA-Z]*K/.test(a))) unsure("curl:config", "run curl with options from a file", "sends");

  const rule = RULES[name];
  if (rule) rule(args, { hit, unsure, cmd, ctx, inner, name, rules: RULES });
  else if (SCRIPT.test(w[0]) || w[0].startsWith("./") || w[0].startsWith("../")) scriptRule(w[0], unsure);
  else if (!READ_ONLY.has(name)) genericRule(name, args, unsure);
  return found;
}
