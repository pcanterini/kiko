// Quick tasks (src/core/quick-task.ts): the `claude -p` arguments and environment, how its JSON becomes
// an outcome, the runner with spawn mocked (no claude runs), and the "Voice can" gate in the router
// (fetch stubbed) and in decide().
import "../../setup.ts";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { PassThrough } from "node:stream";
import { after, before, describe, test } from "node:test";
import { config } from "../../../src/core/config.ts";
import { decide, needsChanges, type DecideDeps, type DecideState } from "../../../src/core/decide.ts";
import {
  allowedTools,
  buildArgs,
  childEnv,
  DENIED_TOOLS,
  mcpConfigFor,
  parseResult,
  PERMISSION_SERVER,
  PERMISSION_TOOL,
  READ_ONLY_COMMANDS,
  runQuickTask,
  TOOLS,
  type Spawn,
} from "../../../src/core/quick-task.ts";
import { Router, type Action } from "../../../src/core/router.ts";
import { CHANGE_REQUEST, QUICK_CANCEL, voiceAllows } from "../../../src/core/routing-rules.ts";
import { CAST, makeWorld, type VoiceCan } from "../../support/fixtures.ts";

const ARGS = buildArgs({ model: "haiku", maxTurns: 8, maxBudgetUsd: 0.25 });
/** The values after a flag, up to the next flag. */
const valuesOf = (flag: string) => {
  const i = ARGS.indexOf(flag);
  assert.ok(i >= 0, `${flag} missing`);
  const rest = ARGS.slice(i + 1);
  const end = rest.findIndex((a) => a.startsWith("--"));
  return end < 0 ? rest : rest.slice(0, end);
};

describe("claude -p arguments", () => {
  test("print mode, JSON, the model, a turn cap and a budget cap", () => {
    assert.equal(ARGS[0], "-p");
    assert.deepEqual(valuesOf("--output-format"), ["json"]);
    assert.deepEqual(valuesOf("--model"), ["haiku"]);
    assert.deepEqual(valuesOf("--max-turns"), ["8"]);
    assert.deepEqual(valuesOf("--max-budget-usd"), ["0.25"]);
    assert.ok(!buildArgs({ model: "haiku", maxTurns: 3 }).includes("--max-budget-usd"));
  });
  test("read and search tools, Bash, and the web (asked for, never allowed by itself)", () => {
    assert.deepEqual(valuesOf("--tools"), ["Read,Grep,Glob,Bash,WebFetch,WebSearch"]);
    assert.equal(TOOLS, "Read,Grep,Glob,Bash,WebFetch,WebSearch");
    assert.ok(!allowedTools().some((r) => /^Web/.test(r)), "the web is never allowed outright");
  });
  test("denied outright, never asked: the editing tools and git writing", () => {
    assert.deepEqual(valuesOf("--disallowedTools"), DENIED_TOOLS);
    for (const tool of ["Edit", "Write", "NotebookEdit", "Bash(git * --output*)", "Bash(git commit *)", "Bash(git push)", "Bash(git reset *)", "Bash(git stash pop *)", "Bash(git stash)"]) {
      assert.ok(DENIED_TOOLS.includes(tool), tool);
    }
    for (const tool of ["WebFetch", "WebSearch"]) assert.ok(!DENIED_TOOLS.includes(tool), `${tool} is asked for`);
    // A deny rule wins over an allow rule: none may catch what the allowlist lets look.
    for (const read of ["git status", "git log", "git diff", "git stash list", "git branch --show-current", "git remote -v"]) {
      assert.ok(!DENIED_TOOLS.some((d) => d === `Bash(${read})` || d === `Bash(${read} *)` || d === `Bash(${read.split(" ").slice(0, 2).join(" ")} *)`), read);
    }
  });
  test("without the app to ask: never asks, denies what isn't allowed", () => {
    assert.deepEqual(valuesOf("--permission-mode"), ["dontAsk"]);
    assert.deepEqual(valuesOf("--permission-prompts"), ["none"]);
    assert.ok(!ARGS.includes("--permission-prompt-tool") && !ARGS.includes("--mcp-config"));
  });
  test("with it: Claude Code's default mode, asking the permission tool from the MCP config file", () => {
    const args = buildArgs({ model: "haiku", maxTurns: 8 }, "/tmp/x/mcp.json");
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    assert.equal(after("--permission-mode"), "default");
    assert.equal(after("--mcp-config"), "/tmp/x/mcp.json");
    assert.equal(after("--permission-prompt-tool"), "mcp__kiko__permission");
    assert.equal(PERMISSION_TOOL, "mcp__kiko__permission");
    assert.ok(!args.includes("--permission-prompts"), "the default (host) asks the tool");
    assert.ok(!args.includes("dontAsk"));
    for (const flag of ["--restricted", "--strict-mcp-config"]) assert.ok(args.includes(flag), flag);
  });
  test("the MCP config: the server run by this Node, the socket and wait in its environment", () => {
    const config = mcpConfigFor({ socket: "/tmp/test.sock", waitMs: 1234 });
    assert.deepEqual(config, {
      mcpServers: {
        kiko: { type: "stdio", command: process.execPath, args: [PERMISSION_SERVER], env: { KIKO_SOCKET: "/tmp/test.sock", KIKO_QUICK_ASK_MS: "1234" } },
      },
    });
    assert.match(PERMISSION_SERVER, /\/hooks\/quick-permission\.mjs$/);
  });
  test("ignores the user's settings (hooks, permission rules), no MCP, nothing saved", () => {
    for (const flag of ["--restricted", "--strict-mcp-config", "--no-session-persistence"]) assert.ok(ARGS.includes(flag), flag);
    assert.ok(!ARGS.some((a) => /skip-permissions|bypassPermissions|acceptEdits/.test(a)));
  });
  test("the task isn't in the arguments (it goes on stdin, so a rule list can't swallow it)", () => {
    assert.ok(!ARGS.some((a) => /disk space/i.test(a)));
  });
  test("allowed: Read, Grep, Glob, and each read-only command bare and with arguments", () => {
    assert.deepEqual(valuesOf("--allowedTools"), allowedTools());
    const rules = allowedTools();
    assert.deepEqual(rules.slice(0, 3), ["Read", "Grep", "Glob"]);
    for (const rule of ["Bash(df)", "Bash(df *)", "Bash(pmset -g *)", "Bash(lsof *)", "Bash(git status *)", "Bash(date)", "Bash(sw_vers)", "Bash(du *)"]) {
      assert.ok(rules.includes(rule), rule);
    }
    assert.equal(rules.length, 3 + READ_ONLY_COMMANDS.length * 2);
  });
  test("name lookups (whois, dig, host, nslookup) are allowed, with any arguments: they only ask", () => {
    const rules = allowedTools();
    for (const cmd of ["whois", "dig", "host", "nslookup"]) {
      assert.ok(rules.includes(`Bash(${cmd})`), cmd);
      assert.ok(rules.includes(`Bash(${cmd} *)`), cmd);
    }
    // "host *" with its space: never "hostname"'s rule taken for it, nor the other way round.
    assert.ok(rules.includes("Bash(hostname)"));
  });
  test("the instructions allow the name lookups and keep other network access out", () => {
    const [prompt] = valuesOf("--append-system-prompt");
    assert.match(prompt, /network access other than the name lookups you're allowed: whois, dig, host, nslookup/);
    assert.doesNotMatch(prompt, /committing, network requests\)/);
  });
  test("nothing that changes things is allowed", () => {
    const words = (rule: string) => rule.replace(/^Bash\(|\)$|\s\*$/g, "").split(" ");
    const WRITERS =
      /^(rm|mv|cp|touch|mkdir|rmdir|chmod|chown|ln|kill|killall|pkill|sudo|curl|wget|tee|echo|printf|sed|awk|dd|npm|pnpm|bun|brew|pip|open|osascript|launchctl|shutdown|reboot|find|xargs|sh|bash|zsh|node|python3?)$/;
    for (const rule of allowedTools().filter((r) => r.startsWith("Bash("))) {
      const [cmd, sub] = words(rule);
      assert.doesNotMatch(cmd, WRITERS, rule);
      if (cmd === "git") assert.match(sub, /^(status|log|diff|show|rev-parse|branch|remote|stash)$/, rule);
      if (cmd === "git" && sub === "branch") assert.equal(rule.replace(/ \*\)$/, ")"), "Bash(git branch --show-current)");
      if (cmd === "git" && sub === "stash") assert.ok(rule.startsWith("Bash(git stash list"), rule);
      if (cmd === "diskutil") assert.match(words(rule)[1], /^(list|info)$/, rule);
      if (cmd === "pmset") assert.equal(words(rule)[1], "-g", rule);
      if (cmd === "defaults") assert.equal(words(rule)[1], "read", rule);
    }
    assert.ok(!allowedTools().includes("Bash"), "never all of Bash");
    assert.ok(!allowedTools().some((r) => r === "Bash(*)" || r === "Bash( *)"));
  });
});

describe("the run's environment", () => {
  const env = childEnv({
    PATH: "/usr/bin",
    HOME: "/Users/x",
    CLAUDE_CONFIG_DIR: "/Users/x/.claude",
    ANTHROPIC_API_KEY: "secret",
    ANTHROPIC_WORKSPACE_ID: "ws",
    DEEPGRAM_API_KEY: "d",
    CARTESIA_API_KEY: "c",
    OPENROUTER_API_KEY: "o",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_SESSION_ID: "s",
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/x.sock",
    CLAUDE_PID: "1",
  });
  test("keeps the user's login and paths", () => assert.deepEqual(Object.keys(env).sort(), ["CLAUDE_CONFIG_DIR", "HOME", "PATH"]));
  test("no app keys: a workspace-less API key would fail the run, and it uses the Claude login", () => {
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  });
  test("not marked as part of the session that started the app (its hooks would take it for that one)", () => {
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
    assert.equal(env.CLAUDECODE, undefined);
  });
});

const json = (o: Record<string, unknown>) => JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0.0017, ...o });

describe("parseResult", () => {
  test("an answer", () => {
    const r = parseResult(json({ result: "311 GB free of 1.8 TB." }), 3900);
    assert.deepEqual(r, { outcome: "answered", text: "311 GB free of 1.8 TB.", durationMs: 3900, costUsd: 0.0017, numTurns: 2, denied: [], subtype: "success" });
  });
  test("NEEDS_CHANGES: needs a real session", () => {
    const r = parseResult(json({ result: "NEEDS_CHANGES: the old screenshots would have to be deleted." }), 1);
    assert.equal(r.outcome, "needs_changes");
    assert.equal(r.text, "the old screenshots would have to be deleted.");
  });
  test("denied tool calls, by what they tried", () => {
    const r = parseResult(
      json({
        result: "Couldn't.",
        permission_denials: [
          { tool_name: "Bash", tool_input: { command: "rm -rf ~/x" } },
          { tool_name: "Edit", tool_input: { file_path: "/a/b" } },
        ],
      }),
      1,
    );
    assert.deepEqual(r.denied, ["Bash: rm -rf ~/x", "Edit: /a/b"]);
  });
  test("an edit denied and nothing said: needs changes", () => {
    assert.equal(parseResult(json({ result: "", permission_denials: [{ tool_name: "Write", tool_input: { file_path: "/a" } }] }), 1).outcome, "needs_changes");
  });
  test("out of turns, an error, or not JSON: failed", () => {
    assert.equal(parseResult(json({ subtype: "error_max_turns", result: "" }), 1).outcome, "failed");
    assert.equal(parseResult(json({ is_error: true, result: "API Error" }), 1).outcome, "failed");
    assert.equal(parseResult("Error: not logged in", 1).outcome, "failed");
  });
});

/** A child process that answers the way `claude -p` would, or hangs (`out` null). */
function fakeSpawn(out: string | null, record: { args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string; killed?: string[] } = {}): Spawn {
  return ((_cmd: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    let input = "";
    stdin.on("data", (c) => (input += c));
    stdin.on("finish", () => {
      record.stdin = input;
      if (out !== null) setTimeout(() => (stdout.end(out), child.emit("close", 0, null)), 5);
    });
    Object.assign(record, { args, cwd: options.cwd, env: options.env, killed: [] });
    Object.assign(child, {
      stdout,
      stderr: new PassThrough(),
      stdin,
      exitCode: null,
      signalCode: null,
      kill: (signal: string) => {
        record.killed!.push(signal);
        setTimeout(() => child.emit("close", null, signal), 5);
        return true;
      },
    });
    return child;
  }) as unknown as Spawn;
}

const OPTS = { task: "How much free disk space is there?", cwd: "/Users/x", model: "haiku", maxTurns: 8, timeoutMs: 2000 };

describe("runQuickTask (spawn mocked)", () => {
  test("runs claude in the folder with the task on stdin, and answers", async () => {
    const rec: Parameters<typeof fakeSpawn>[1] = {};
    const r = await runQuickTask(OPTS, fakeSpawn(json({ result: "311 GB free." }), rec)).result;
    assert.equal(r.outcome, "answered");
    assert.equal(r.text, "311 GB free.");
    assert.equal(rec.stdin, OPTS.task);
    assert.equal(rec.cwd, "/Users/x");
    const settings = rec.args![rec.args!.indexOf("--settings") + 1];
    assert.match(settings, /kiko-quick-[^/]+\/settings\.json$/);
    assert.deepEqual(rec.args, buildArgs(OPTS, undefined, settings));
    assert.equal(rec.env!.CLAUDE_CODE_ENTRYPOINT, undefined);
  });
  test("no folder: home", async () => {
    const rec: Parameters<typeof fakeSpawn>[1] = {};
    await runQuickTask({ ...OPTS, cwd: "" }, fakeSpawn(json({ result: "ok" }), rec)).result;
    assert.equal(rec.cwd, homedir());
  });
  test("past the time limit: stopped", async () => {
    const rec: Parameters<typeof fakeSpawn>[1] = {};
    const r = await runQuickTask({ ...OPTS, timeoutMs: 30 }, fakeSpawn(null, rec)).result;
    assert.equal(r.outcome, "timeout");
    assert.deepEqual(rec.killed, ["SIGTERM"]);
  });
  test("cancelled: stopped, and says so", async () => {
    const rec: Parameters<typeof fakeSpawn>[1] = {};
    const running = runQuickTask(OPTS, fakeSpawn(null, rec));
    running.cancel();
    running.cancel();
    const r = await running.result;
    assert.equal(r.outcome, "cancelled");
    assert.deepEqual(rec.killed, ["SIGTERM"]);
  });
  test("paused while you're asked: the time limit stops, and goes on after", async () => {
    const rec: Parameters<typeof fakeSpawn>[1] = {};
    const running = runQuickTask({ ...OPTS, timeoutMs: 80 }, fakeSpawn(null, rec));
    const resume = running.pause();
    const again = running.pause(); // two at once: it waits for both
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(rec.killed, [], "not while paused");
    resume();
    resume(); // once only
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(rec.killed, [], "still one asking");
    again();
    const r = await running.result;
    assert.equal(r.outcome, "timeout");
    assert.deepEqual(rec.killed, ["SIGTERM"]);
  });
  test("claude missing: failed, never throws", async () => {
    const missing = (() => {
      throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    }) as unknown as Spawn;
    const r = await runQuickTask(OPTS, missing).result;
    assert.equal(r.outcome, "failed");
    assert.match(r.text, /ENOENT/);
  });
});

describe("the 'Voice can' gate", () => {
  test("only at everything", () => {
    assert.equal(voiceAllows("everything", "check"), true);
    assert.equal(voiceAllows("messages", "check"), false);
    assert.equal(voiceAllows("replies", "check"), false);
  });

  // The router, its model stubbed (OpenRouter path, as in router-tools.test.ts).
  let offered: string[][] = [];
  let systems: string[] = [];
  let reply: Array<{ name: string; arguments: object }> = [];
  const realFetch = globalThis.fetch;
  const realLlm = config.llm;
  before(() => {
    config.llm = "test/no-network";
    process.env.OPENROUTER_API_KEY = "unit-test-no-network";
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      offered.push(body.tools.map((t: any) => t.function.name));
      systems.push(body.messages[0].content);
      const completion = {
        choices: [{ message: { content: "", tool_calls: reply.map((r) => ({ function: { name: r.name, arguments: JSON.stringify(r.arguments) } })) } }],
        usage: { prompt_tokens: 1000, completion_tokens: 20, cost: 0.0001 },
      };
      return new Response(JSON.stringify(completion), { status: 200 });
    }) as typeof fetch;
  });
  after(() => {
    globalThis.fetch = realFetch;
    config.llm = realLlm;
    delete process.env.OPENROUTER_API_KEY;
  });
  const world = makeWorld([CAST.voice, CAST.clipkit]);
  const route = (voiceCan: VoiceCan, calls: typeof reply) => {
    offered = [];
    systems = [];
    reply = calls;
    return new Router().route({ sessions: world.sessions, notes: world.notes, waitingId: null, justSpoke: null, lastId: null, recent: [], text: "how much disk space do I have", voiceCan }, () => {});
  };

  for (const level of ["replies", "messages"] as const) {
    test(`${level}: quick_task offered all the same (the app refuses it, with the setting's path and the offer to turn it on), and the prompt never says checking is off`, async () => {
      await route(level, [{ name: "say", arguments: { text: "ok" } }]);
      assert.ok(offered[0].includes("quick_task"));
      assert.match(systems[0], /call quick_task/);
      assert.doesNotMatch(systems[0], /is turned off/);
    });
  }
  test("everything: offered, with when to use it and when a change needs a session", async () => {
    await route("everything", [{ name: "say", arguments: { text: "ok" } }]);
    assert.ok(offered[0].includes("quick_task"));
    assert.match(systems[0], /call quick_task/);
    assert.match(systems[0], /a quick check can only look\. Want me to start a session in the scratch folder to do it\?/);
    // Work that's no project's opens in a scratch folder, not ~.
    assert.match(systems[0], /opens in a scratch folder: start_session with project "", never "home" unless they ask for their home folder/);
    assert.doesNotMatch(systems[0], /start a session in your home folder/);
  });
  test("quick_task: home, or a running session's folder", async () => {
    const r = await route("everything", [
      { name: "quick_task", arguments: { task: "How much free disk space is there?", folder: "home" } },
      { name: "quick_task", arguments: { task: "What's the git status?", folder: "clipkit" } },
    ]);
    assert.deepEqual(r!.actions, [
      { name: "quick_task", task: "How much free disk space is there?", cwd: homedir() },
      { name: "quick_task", task: "What's the git status?", cwd: world.byName.get("clipkit")!.cwd },
    ]);
  });
  test("start_session can start in the home folder when asked for", async () => {
    const r = await route("everything", [{ name: "start_session", arguments: { project: "home", new_project: false, name: "", prompt: "Delete the old screenshots." } }]);
    assert.deepEqual(r!.actions, [{ name: "start_session", project: "home", newProject: false, sessionName: "", prompt: "Delete the old screenshots." }]);
    const d = await decideWith("everything", r!.actions, "Yes, open one in my home folder.");
    assert.deepEqual(d.actions, [{ type: "start", where: { kind: "home", cwd: homedir() }, name: "", prompt: "Delete the old screenshots." }]);
  });

  // decide(): the guard on the router's call, and "stop" while one runs.
  const decideWith = (voiceCan: VoiceCan, actions: Action[], text = "how much disk space do I have", quickTask: DecideState["quickTask"] = null) => {
    let routed = 0;
    const deps: DecideDeps = {
      utterance: null,
      approval: null,
      route: async () => {
        routed++;
        return { text: "", actions, claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
      },
      trim: null,
    };
    const state: DecideState = {
      text,
      sessions: world.sessions,
      notes: world.notes,
      recent: [],
      waiting: null,
      justSpoke: null,
      lastId: null,
      appAsked: false,
      lastSent: null,
      lastRepeat: false,
      voiceCan,
      quickTask,
      classifierMinConfidence: 0.75,
    };
    return decide(state, deps).then((d) => ({ ...d, routed }));
  };
  const QUICK: Action = { name: "quick_task", task: "How much free disk space is there?", cwd: homedir() };
  test("decide: at everything, the quick task", async () => {
    const d = await decideWith("everything", [QUICK]);
    assert.deepEqual(d.actions, [{ type: "quick_task", task: QUICK.task, cwd: homedir() }]);
  });
  test("decide: below everything (changed since the router was asked), refused", async () => {
    // Kept: a yes to "turn it on" runs it then.
    assert.deepEqual((await decideWith("messages", [QUICK])).actions, [{ type: "refused", what: "check", then: { type: "quick_task", task: QUICK.task, cwd: homedir() } }]);
  });
  test("decide: a change asked for (the eval's 'kill whatever's on port 3000'): the offer of a session in the scratch folder, no run", async () => {
    const kill: Action = { name: "quick_task", task: "Kill whatever process is running on port 3000.", cwd: homedir() };
    const line = "That would change something on your Mac, and a quick check can only look. Want me to start a session in the scratch folder to do it?";
    assert.deepEqual((await decideWith("everything", [kill], "Kill whatever's running on port 3000.")).actions, [
      { type: "say", text: line, why: "quick_task_needs_changes", offer: { task: kill.task, cwd: homedir() } },
    ]);
    // Your words ask for the change even when the router wrote the task as a question.
    const d = await decideWith("everything", [{ ...QUICK, task: "Which files in Downloads are older than a month?" }], "Can you delete everything in my Downloads older than a month?");
    assert.equal(d.actions[0].type, "say");
  });
  test("needsChanges: a session already in that folder is offered instead", () => {
    const clipkit = world.byName.get("clipkit")!;
    assert.equal(needsChanges(world.sessions, clipkit.cwd), "A quick check can only look, and that needs a change. Want me to send it to clipkit?");
    assert.equal(needsChanges(world.sessions, `${homedir()}/Downloads`), "That would change something, and a quick check can only look. Want me to start a session in Downloads to do it?");
  });
  test("decide: 'Could you turn the screen brightness down to half?': the scratch folder offered, with why", async () => {
    const volume: Action = { name: "quick_task", task: "Set the screen brightness to 50%.", cwd: homedir() };
    const d = await decideWith("everything", [volume], "Could you turn the screen brightness down to half?");
    assert.equal(d.actions[0].type, "say");
    const said = d.actions[0] as Extract<(typeof d.actions)[0], { type: "say" }>;
    assert.match(said.text, /change something on your Mac, and a quick check can only look\. Want me to start a session in the scratch folder/);
    assert.doesNotMatch(said.text, /home folder/);
    assert.deepEqual(said.offer, { task: volume.task, cwd: homedir() });
  });
  test("decide: 'stop' while one runs cancels it, without the router", async () => {
    const d = await decideWith("everything", [], "Okay, stop.", { task: QUICK.task });
    assert.equal(d.step, "quick-cancel");
    assert.deepEqual(d.actions, [{ type: "cancel_quick" }]);
    assert.equal(d.routed, 0);
  });
  test("decide: 'stop' with nothing running goes on as before", async () => {
    const d = await decideWith("everything", [], "Okay, stop.");
    assert.notEqual(d.step, "quick-cancel");
  });
});

describe("QUICK_CANCEL", () => {
  for (const p of ["Stop.", "cancel", "Cancel that.", "Never mind.", "nevermind", "Okay, stop checking.", "Forget it", "actually cancel the check"]) {
    test(`matches ${JSON.stringify(p)}`, () => assert.ok(QUICK_CANCEL.test(p)));
  }
  for (const p of ["Stop clipkit.", "Cancel the deploy in atlas agents.", "How much disk space do I have?", "Don't stop."]) {
    test(`doesn't match ${JSON.stringify(p)}`, () => assert.ok(!QUICK_CANCEL.test(p)));
  }
});

describe("CHANGE_REQUEST: asks for a change, so no quick task", () => {
  for (const p of [
    "Kill whatever's running on port 3000.",
    "Can you delete everything in my Downloads folder?",
    "Please empty the trash",
    "uh, free up some disk space",
    "Go ahead and install the update",
    "Restart the dev server",
  ]) {
    test(`matches ${JSON.stringify(p)}`, () => assert.ok(CHANGE_REQUEST.test(p)));
  }
  for (const p of [
    "How much disk space do I have left?",
    "What could I delete to free up space?",
    "Is anything running on port 3000?",
    "What's the git status of clipkit?",
    "Which apps use the most memory?",
    "Settings: what's my battery at?",
  ]) {
    test(`doesn't match ${JSON.stringify(p)}`, () => assert.ok(!CHANGE_REQUEST.test(p)));
  }
});
