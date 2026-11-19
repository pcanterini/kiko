// A quick task's permission prompts (hooks/quick-permission.mjs, src/core/quick-task.ts): the MCP
// server Claude Code calls with --permission-prompt-tool, against a stand-in for the app's socket
// (allow, deny, no answer, no socket, too slow), and a whole quick task run with a fake `claude`
// (tests/support/fake-claude.mjs) that asks through it. Never the real Claude, nor the app's socket.
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, test } from "node:test";
import { buildArgs, PERMISSION_SERVER, PERMISSION_TOOL, runQuickTask, type Spawn } from "../../../src/core/quick-task.ts";

const FAKE_CLAUDE = new URL("../../support/fake-claude.mjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "qp-"));
let n = 0;
const socketPath = () => join(dir, `app-${++n}.sock`);

/** The app's socket, stood in for: each request it gets, and how it answers (null: never). */
function fakeApp(path: string, answer: ((event: any) => object | null) | null) {
  const got: any[] = [];
  const closed: number[] = [];
  const server: Server = createServer((conn: Socket) => {
    conn.on("error", () => {});
    conn.on("close", () => closed.push(Date.now()));
    createInterface({ input: conn }).once("line", (line) => {
      const event = JSON.parse(line);
      got.push(event);
      const reply = answer?.(event);
      if (reply === null) return conn.end(); // closes without an answer
      if (reply) conn.end(`${JSON.stringify(reply)}\n`);
    });
  });
  const listening = new Promise<void>((resolve) => server.listen(path, resolve));
  return { got, closed, listening, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** The MCP server, run as Claude Code runs it, with JSON-RPC requests in and their answers out. */
function mcp(env: Record<string, string>) {
  const child: ChildProcess = spawn(process.execPath, [PERMISSION_SERVER], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map<number, (m: any) => void>();
  createInterface({ input: child.stdout! }).on("line", (line) => {
    const m = JSON.parse(line);
    pending.get(m.id)?.(m);
  });
  let id = 0;
  const request = (method: string, params: object = {}) =>
    new Promise<any>((resolve) => {
      const mine = ++id;
      pending.set(mine, resolve);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: mine, method, params })}\n`);
    });
  /** What the permission tool answers for a tool use: its decision, parsed. */
  const ask = async (tool_name: string, input: object) => {
    const r = await request("tools/call", { name: "permission", arguments: { tool_name, input, tool_use_id: "toolu_1" } });
    assert.equal(r.result.content.length, 1);
    assert.equal(r.result.content[0].type, "text");
    return JSON.parse(r.result.content[0].text);
  };
  return { child, request, ask, end: () => child.stdin!.end() };
}

const running: Array<{ end: () => void }> = [];
const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const r of running.splice(0)) r.end();
  for (const s of servers.splice(0)) await s.close();
});

describe("the permission MCP server", () => {
  test("introduces itself, with one tool taking the tool's name and input", async () => {
    const m = mcp({ KIKO_SOCKET: socketPath() });
    running.push(m);
    const init = await m.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.deepEqual(init.result.capabilities, { tools: {} });
    const list = await m.request("tools/list");
    assert.deepEqual(
      list.result.tools.map((t: any) => t.name),
      ["permission"],
    );
    assert.deepEqual(list.result.tools[0].inputSchema.required, ["tool_name", "input"]);
    assert.equal(PERMISSION_TOOL, "mcp__kiko__permission");
    assert.equal((await m.request("no/such")).error.code, -32601);
  });

  test("allow: the app is asked as for a session's prompt (session 'kiko'), and the input comes back whole", async () => {
    const path = socketPath();
    const app = fakeApp(path, () => ({ decision: { behavior: "allow" } }));
    servers.push(app);
    await app.listening;
    const m = mcp({ KIKO_SOCKET: path });
    running.push(m);
    const input = { command: "whois pebble.com", description: "x".repeat(2500) };
    assert.deepEqual(await m.ask("Bash", input), { behavior: "allow", updatedInput: input });
    const [event] = app.got;
    assert.equal(event.hook_event_name, "PermissionRequest");
    assert.equal(event.session_id, "kiko");
    assert.equal(event.tool_name, "Bash");
    assert.equal(event.tool_input.command, "whois pebble.com");
    assert.equal(event.tool_input.description.length, 2001, "long fields cut for the app");
  });

  test("deny: denied with the app's why, and told not to try again", async () => {
    const path = socketPath();
    const app = fakeApp(path, () => ({ decision: { behavior: "deny", message: 'The user said no by voice: "No."' } }));
    servers.push(app);
    await app.listening;
    const m = mcp({ KIKO_SOCKET: path });
    running.push(m);
    const d = await m.ask("WebFetch", { url: "https://pebble.com" });
    assert.equal(d.behavior, "deny");
    assert.match(d.message, /^The user said no by voice: "No\." /);
    assert.match(d.message, /Don't try it again/);
  });

  test("let go without an answer, or the connection closed: denied", async () => {
    const path = socketPath();
    let i = 0;
    const app = fakeApp(path, () => (i++ === 0 ? { decision: null } : null));
    servers.push(app);
    await app.listening;
    const m = mcp({ KIKO_SOCKET: path });
    running.push(m);
    assert.equal((await m.ask("Bash", { command: "curl -I https://pebble.com" })).behavior, "deny");
    assert.equal((await m.ask("Bash", { command: "curl -I https://pebble.dev" })).behavior, "deny");
  });

  test("no socket (the app isn't running): denied at once", async () => {
    const m = mcp({ KIKO_SOCKET: join(dir, "nobody.sock") });
    running.push(m);
    const at = Date.now();
    const d = await m.ask("Bash", { command: "whois pebble.com" });
    assert.equal(d.behavior, "deny");
    assert.match(d.message, /Kiko isn't running/);
    assert.ok(Date.now() - at < 1000);
  });

  test("a socket file nobody listens on (left from a crash): denied at once", async () => {
    const path = socketPath();
    const app = fakeApp(path, null);
    await app.listening;
    // Closing leaves no listener; a file of that name is put back, as a crash would leave it.
    await app.close();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, "");
    const m = mcp({ KIKO_SOCKET: path });
    running.push(m);
    assert.equal((await m.ask("Bash", { command: "whois pebble.com" })).behavior, "deny");
  });

  test("no answer within KIKO_QUICK_ASK_MS: denied, and the app's end is closed", async () => {
    const path = socketPath();
    const app = fakeApp(path, () => undefined as unknown as object); // takes it, never answers
    servers.push(app);
    await app.listening;
    const m = mcp({ KIKO_SOCKET: path, KIKO_QUICK_ASK_MS: "200" });
    running.push(m);
    const at = Date.now();
    const d = await m.ask("Bash", { command: "whois pebble.com" });
    const took = Date.now() - at;
    assert.equal(d.behavior, "deny");
    assert.ok(took >= 180 && took < 2000, `${took}ms`);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(app.closed.length, 1, "the app sees it go away");
  });

  test("asked about itself (the model calling it): denied, nobody asked", async () => {
    const path = socketPath();
    const app = fakeApp(path, () => ({ decision: { behavior: "allow" } }));
    servers.push(app);
    await app.listening;
    const m = mcp({ KIKO_SOCKET: path });
    running.push(m);
    assert.equal((await m.ask("mcp__kiko__permission", { tool_name: "Bash", input: {} })).behavior, "deny");
    assert.equal(app.got.length, 0);
  });
});

describe("a quick task asking through it (fake claude)", () => {
  const OPTS = { task: "Are pebble.com, .dev and .io available?", cwd: dir, model: "haiku", maxTurns: 8, timeoutMs: 10_000 };
  const fake = (record: string): Spawn =>
    ((_cmd: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) =>
      spawn(process.execPath, [FAKE_CLAUDE, ...args], { ...options, env: { ...options.env, FAKE_CLAUDE_RECORD: record } })) as Spawn;
  const leftovers = () => readdirSync(tmpdir()).filter((f) => f.startsWith("kiko-quick-"));

  test("allowed: it answers; the MCP config was passed by file, and is gone after", async () => {
    const path = socketPath();
    const app = fakeApp(path, () => ({ decision: { behavior: "allow" } }));
    servers.push(app);
    await app.listening;
    const record = join(dir, "allowed.json");
    const r = await runQuickTask({ ...OPTS, ask: { socket: path, waitMs: 5000 } }, fake(record)).result;
    assert.equal(r.outcome, "answered");
    assert.match(r.text, /pebble\.com is registered/);
    assert.deepEqual(r.denied, []);
    assert.equal(app.got[0].tool_input.command, "whois pebble.com");
    const { args, task } = JSON.parse(readFileSync(record, "utf8"));
    assert.equal(task, OPTS.task);
    const config = args[args.indexOf("--mcp-config") + 1];
    assert.match(config, /kiko-quick-[^/]+\/mcp\.json$/);
    const settings = args[args.indexOf("--settings") + 1];
    assert.match(settings, /kiko-quick-[^/]+\/settings\.json$/);
    assert.deepEqual(args, buildArgs(OPTS, config, settings));
    assert.ok(!args.some((a: string) => a.includes(path)), "the socket's path isn't on the command line");
    assert.deepEqual(leftovers(), []);
  });

  test("denied: it says what it couldn't check, and the denial is reported", async () => {
    const path = socketPath();
    const app = fakeApp(path, () => ({ decision: { behavior: "deny", message: "No." } }));
    servers.push(app);
    await app.listening;
    const r = await runQuickTask({ ...OPTS, ask: { socket: path, waitMs: 5000 } }, fake(join(dir, "denied.json"))).result;
    assert.equal(r.outcome, "answered");
    assert.match(r.text, /couldn't check/);
    assert.deepEqual(r.denied, ["Bash: whois pebble.com"]);
  });

  test("no app: denied at once, and the run still ends", async () => {
    const at = Date.now();
    const r = await runQuickTask({ ...OPTS, ask: { socket: join(dir, "gone.sock"), waitMs: 5000 } }, fake(join(dir, "none.json"))).result;
    assert.deepEqual(r.denied, ["Bash: whois pebble.com"]);
    assert.ok(Date.now() - at < 5000);
  });
});

describe("read-only whatever the mode: the run's own guard hook (fake claude runs it as Claude Code does)", () => {
  const OPTS = { task: "What's using the disk?", cwd: dir, model: "haiku", maxTurns: 8, timeoutMs: 15_000 };
  // The hook runs in the run's environment: none of the terminal's REX_* in it.
  const noRex = (e: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith("REX_")));
  const fake = (record: string, wanted: object): Spawn =>
    ((_cmd: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) =>
      spawn(process.execPath, [FAKE_CLAUDE, ...args], { ...options, env: { ...noRex(options.env), FAKE_CLAUDE_RECORD: record, FAKE_CLAUDE_ASK: JSON.stringify(wanted) } })) as Spawn;
  /** One quick check wanting `tool`, in `mode`, with an app that allows everything it's asked (the worst case). */
  const run = async (mode: "auto" | "default", tool: { tool_name: string; input: Record<string, unknown> }) => {
    const path = socketPath();
    const app = fakeApp(path, () => ({ decision: { behavior: "allow" } }));
    servers.push(app);
    await app.listening;
    const record = join(dir, `guard-${++n}.json`);
    const r = await runQuickTask({ ...OPTS, mode, ask: { socket: path, waitMs: 5000 } }, fake(record, tool)).result;
    return { r, app, decision: JSON.parse(readFileSync(record, "utf8")).decision };
  };
  const bash = (command: string) => ({ tool_name: "Bash", input: { command } as Record<string, unknown> });

  const CHANGES = [
    bash("echo hi > ~/notes.txt"),
    bash("cat <<EOF >> ~/.zshrc\nalias x=y\nEOF"),
    bash("rm -rf ~/Downloads/old"),
    bash("cd ~/code && find . -name '*.log' -exec rm {} \\;"),
    bash("docker rm -f web"),
    bash("docker system prune -af"),
    bash("docker image prune"),
    bash("git push origin main"),
    bash("curl -X POST -d @report.json https://example.com/upload"),
    bash("curl -F file=@notes.txt https://example.com"),
    bash(`osascript -e 'tell application "Messages" to send "hi" to buddy "Ana"'`),
    bash("ssh box 'rm -rf /srv/old'"),
    bash("bash -c 'ls; rm x'"),
    bash("sed -i '' s/a/b/ notes.txt"),
    { tool_name: "Write", input: { file_path: "/tmp/x", content: "y" } },
    { tool_name: "Edit", input: { file_path: "/tmp/x", old_string: "a", new_string: "b" } },
  ];
  for (const mode of ["auto", "default"] as const) {
    for (const tool of CHANGES) {
      const what = typeof tool.input.command === "string" ? tool.input.command : tool.tool_name;
      test(`${mode}: denied before anyone is asked, even by an app that would allow it: ${what.replace(/\n/g, "⏎")}`, async () => {
        const { r, app, decision } = await run(mode, tool);
        assert.equal(decision.behavior, "deny");
        assert.equal(decision.by, "hook");
        assert.match(decision.message, /only looks|can't change files/);
        assert.equal(app.got.length, 0, "never asked");
        assert.equal(r.denied.length, 1);
      });
    }
  }

  test("auto: a read-only survey (a loop, docker ps, find, git status) runs without asking", async () => {
    const survey = bash(
      `cd ~; ls -la; docker ps -a --format '{{.Names}}' 2>&1 | head -50; for r in code/*/; do n=$(git -C "$r" status --porcelain 2>/dev/null | wc -l); echo "$n $r"; done; find code -maxdepth 4 -name node_modules -prune -print 2>/dev/null | head`,
    );
    const { r, app, decision } = await run("auto", survey);
    assert.equal(decision.behavior, "allow");
    assert.equal(decision.by, "auto");
    assert.equal(app.got.length, 0);
    assert.equal(r.outcome, "answered");
  });
  test("auto: what code can't tell (python -c) is still asked of you, never left to the classifier", async () => {
    const { app, decision } = await run("auto", bash("python3 -c 'print(1)'"));
    assert.equal(decision.by, "prompt");
    assert.equal(app.got.length, 1);
    assert.equal(app.got[0].session_id, "kiko");
  });
  test("auto: the web is asked every time", async () => {
    const { app, decision } = await run("auto", { tool_name: "WebFetch", input: { url: "https://kiko.sh" } });
    assert.equal(decision.by, "prompt");
    assert.equal(app.got.length, 1);
  });
  test("Manual (auto not offered): a read is asked as before, unless the allow rules cover it", async () => {
    const { app, decision } = await run("default", bash("docker ps"));
    assert.equal(decision.by, "prompt");
    assert.equal(app.got.length, 1);
  });
});
