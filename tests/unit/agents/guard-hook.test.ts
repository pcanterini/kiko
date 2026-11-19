// The safety gate end to end, for real hook scripts (hooks/claude-code-hook.mjs, hooks/codex-hook.mjs)
// against the app's real hook server (src/agents/claude-code/hooks.ts, and Codex's adapter through it)
// on a socket in this test's own folder, never /tmp/kiko*.sock:
//   - a session in bypass mode (or dontAsk, or with an allow rule: the hook sees the same event, and
//     Claude Code applies its rules after the hook's "ask") is asked about `git push`: the hook prints
//     permissionDecision "ask", and the PermissionRequest that follows is the gate's card;
//   - ordinary commands pass at once, without reaching the app;
//   - with the app not running (no socket, a stale one, an app that closes without a verdict) the
//     hook passes and the session behaves as configured; an app that takes the call but is slow
//     still asks;
//   - Codex: the hook holds the call; yes runs it, no or no answer denies it;
//   - the gate's own rules throwing: Claude Code's hook asks, Codex's denies (never a silent pass);
//   - the gate off in Settings (the default: fresh settings): both hooks pass at once, without
//     loading the rules or reaching the app; turned on, they ask as above.
// Every hook here reads a settings file of this test's own (KIKO_SETTINGS), never ~/.config/kiko*.
// And how long it all takes.
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { checkCommand } from "../../../hooks/guard.mjs";
import { decideGuard, forgetPending, guardOf, noteGuard, type GuardCheck } from "../../../src/core/guard.ts";
import { checkWaits, SLOW } from "../../support/until.ts";

const CLAUDE_HOOK = new URL("../../../hooks/claude-code-hook.mjs", import.meta.url).pathname;
const CODEX_HOOK = new URL("../../../hooks/codex-hook.mjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "kiko-guard-"));
const SOCKET = join(dir, "app.sock");
/** Settings with the gate turned on: what every test here runs with unless it says otherwise. */
const GATE_ON = join(dir, "settings-on.json");
writeFileSync(GATE_ON, JSON.stringify({ guard: true }));
/** A settings file of this test's own with `saved` in it. */
let settingsCount = 0;
function settingsFile(saved: string) {
  const path = join(dir, `settings-${++settingsCount}.json`);
  writeFileSync(path, saved);
  return path;
}

/** The environment without any of the app's own variables, with the app at `socket` and the gate on. */
function env(socket: string, extra: Record<string, string> = {}) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^KIKO_/.test(k)) out[k] = v;
  return { ...out, CLAUDE_CODE_ENTRYPOINT: "cli", KIKO_SOCKET: socket, KIKO_SETTINGS: GATE_ON, KIKO_CODEX_SESSIONS: join(dir, "codex-sessions"), ...extra };
}

/** Runs a hook with `input` on stdin: what it printed, its exit code, how long it took. */
function run(hook: string, input: object, socket = SOCKET, extra: Record<string, string> = {}) {
  const start = performance.now();
  return new Promise<{ out: string; code: number | null; ms: number }>((resolve) => {
    const child = spawn(process.execPath, [hook], { env: env(socket, extra), stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ out, code, ms: performance.now() - start }));
    child.stdin.end(JSON.stringify(input));
  });
}

/** How long Node takes to start and end a script doing nothing, now: what every hook pays before it does anything. */
function bare() {
  const start = performance.now();
  return new Promise<number>((resolve) => spawn(process.execPath, ["-e", ""], { stdio: "ignore" }).on("close", () => resolve(performance.now() - start)));
}

const CWD = "/Users/me/git/kiko-project";
/** PreToolUse as Claude Code 2.1.316 sent it in the live check (bypass mode). */
const pre = (command: string, over: Record<string, unknown> = {}) => ({
  session_id: "b5d86d8b-3a51-4a8d-8bc6-cb5058458c73",
  transcript_path: "/nowhere/b5d86d8b.jsonl",
  cwd: CWD,
  prompt_id: "c5b1aafb",
  permission_mode: "bypassPermissions",
  effort: { level: "medium" },
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command, description: "Push" },
  tool_use_id: "toolu_01QxbGQQN6TWJh4DZisTxC81",
  ...over,
});
/** The PermissionRequest that followed the hook's "ask" in that check: no tool_use_id, no suggestions. */
const permission = (command: string, over: Record<string, unknown> = {}) => ({
  session_id: "b5d86d8b-3a51-4a8d-8bc6-cb5058458c73",
  transcript_path: "/nowhere/b5d86d8b.jsonl",
  cwd: CWD,
  permission_mode: "bypassPermissions",
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command, description: "Push" },
  ...over,
});

describe("Claude Code's hook and the app (HookServer)", () => {
  let server: any;
  let checks: GuardCheck[] = [];
  let requests: any[] = [];
  // An app slow to answer: the verdict waits for this (let go by the test, once the hook is done).
  let slow: Promise<void> | null = null;

  before(async () => {
    process.env.KIKO_SOCKET = SOCKET;
    const hooks = await import("../../../src/agents/claude-code/hooks.ts");
    server = new hooks.HookServer();
    // The app's part (src/app/guard.ts), without its logs: the verdict, then the mark for the prompt.
    server.onGuard = async (check: GuardCheck) => {
      checks.push(check);
      if (slow) await slow;
      const verdict = await decideGuard(check, { on: true, off: [] });
      noteGuard(check, verdict);
      return verdict;
    };
    server.onRequest = (r: any) => requests.push(r);
    await server.start();
  });
  after(() => server.stop());

  test("bypass mode: git push is asked about; the prompt that follows is the gate's card", async () => {
    forgetPending();
    checks = [];
    requests = [];
    const { out, code } = await run(CLAUDE_HOOK, pre("git push origin main"));
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(out), {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "Kiko asks first: this posts (push to its git remote)." },
    });
    assert.equal(checks.length, 1);
    assert.deepEqual([checks[0].agent, checks[0].mode, checks[0].hits[0].rule], ["claude-code", "bypassPermissions", "git push"]);
    // Claude Code then asks: its PermissionRequest reaches the app as a held prompt, marked.
    const held = run(CLAUDE_HOOK, permission("git push origin main"));
    await waitFor(() => requests.length === 1);
    const request = requests[0];
    assert.equal(request.isPermission, true);
    assert.equal(request.canAllowAlways, false, "allowed once only");
    assert.deepEqual(guardOf(request), { kind: "posts", what: "push to its git remote", rule: "git push", by: "rule", agent: "claude-code" });
    request.allow(false);
    assert.deepEqual(JSON.parse((await held).out), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  });

  test("any mode, an allow rule or not: the hook's ask is the same (Claude Code applies its rules after it)", async () => {
    for (const mode of ["bypassPermissions", "dontAsk", "auto", "acceptEdits", "default", "plan"]) {
      const { out } = await run(CLAUDE_HOOK, pre("npm publish", { permission_mode: mode }));
      assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask", mode);
    }
  });

  test("a denied card tells Claude why; the next push is asked again (no 'always')", async () => {
    forgetPending();
    requests = [];
    assert.match((await run(CLAUDE_HOOK, pre("git push --force"))).out, /"ask"/);
    const held = run(CLAUDE_HOOK, permission("git push --force"));
    await waitFor(() => requests.length === 1);
    assert.equal(guardOf(requests[0])?.kind, "posts");
    requests[0].deny("The user said no by voice");
    assert.equal(JSON.parse((await held).out).hookSpecificOutput.decision.behavior, "deny");
    assert.match((await run(CLAUDE_HOOK, pre("git push --force"))).out, /"ask"/);
  });

  test("MCP tools: by name", async () => {
    const { out } = await run(CLAUDE_HOOK, pre("", { tool_name: "mcp__claude_ai_Slack__slack_send_message", tool_input: { channel: "C1", text: "hi" } }));
    assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecisionReason, "Kiko asks first: this sends (use Slack's slack send message).");
  });

  test("fresh settings (the default): the gate is off; git push passes at once, printing nothing, without reaching the app", async () => {
    checks = [];
    const off = [
      join(dir, "no-settings.json"),
      settingsFile("{}"),
      settingsFile('{"voiceCan":"everything","sounds":false}'),
      settingsFile('{"guard":false}'),
      settingsFile('{"guard":false,"guardOff":["pays"]}'),
    ];
    for (const path of off) {
      for (const command of ["git push origin main", "rm -rf ~/x", "npm publish"]) {
        const { out, code } = await run(CLAUDE_HOOK, pre(command), SOCKET, { KIKO_SETTINGS: path });
        assert.deepEqual([out, code], ["", 0], `${path}: ${command}`);
      }
      const { out } = await run(CLAUDE_HOOK, pre("", { tool_name: "mcp__claude_ai_Slack__slack_send_message", tool_input: { channel: "C1", text: "hi" } }), SOCKET, { KIKO_SETTINGS: path });
      assert.equal(out, "", path);
    }
    assert.equal(checks.length, 0, "the app is never asked");
  });

  test("turned on in Settings: asks as before; so does a gate whose kinds were set by hand while it was on by default", async () => {
    checks = [];
    for (const saved of ['{"guard":true}', '{"guardOff":["pays"]}']) {
      const { out } = await run(CLAUDE_HOOK, pre("git push origin main"), SOCKET, { KIKO_SETTINGS: settingsFile(saved) });
      assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask", saved);
    }
    assert.equal(checks.length, 2);
  });

  test("settings caught being written (not JSON yet): the app, which has the setting in hand, decides", async () => {
    checks = [];
    const { out } = await run(CLAUDE_HOOK, pre("git push"), SOCKET, { KIKO_SETTINGS: settingsFile('{"guard":tr') });
    assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
    assert.equal(checks.length, 1);
  });

  test("ordinary commands pass at once, printing nothing, without reaching the app", async () => {
    checks = [];
    for (const command of ["ls -la", "pnpm test", "git status && git diff", "rm -rf node_modules", "echo 'git push'", "grep -rn deploy src"]) {
      const { out, code } = await run(CLAUDE_HOOK, pre(command));
      assert.deepEqual([out, code], ["", 0], command);
    }
    assert.equal(checks.length, 0);
  });

  test("a session another Claude started (an agent's scratch session) isn't asked: nobody here could answer it", async () => {
    checks = [];
    const { out } = await run(CLAUDE_HOOK, pre("git push", { cwd: join(homedir(), ".claude", "jobs", "abc123", "tmp", "x") }));
    assert.equal(out, "");
    assert.equal(checks.length, 0);
  });

  test("headless runs (claude -p, the Agent SDK) aren't gated: nobody is there to ask", async () => {
    const { out } = await run(CLAUDE_HOOK, pre("git push"), SOCKET, { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" });
    assert.equal(out, "");
  });

  test("an app that takes the call but is slow: asked all the same, when the hook's wait runs out", async () => {
    // The app answers only once the hook is done: it can only have asked when its own wait ran out.
    let answer = () => {};
    slow = new Promise<void>((resolve) => (answer = resolve));
    checks = [];
    try {
      const { out } = await run(CLAUDE_HOOK, pre("wrangler deploy"), SOCKET, { KIKO_GUARD_WAIT_MS: "300" });
      assert.deepEqual(JSON.parse(out).hookSpecificOutput.permissionDecisionReason, "Kiko asks first: deploy with Wrangler.");
      await waitFor(() => checks.length === 1, "the call reaching the app, which hadn't answered");
    } finally {
      answer();
      slow = null;
    }
  });

  test("timing: off, or an ordinary command, adds only the hook's start; a flagged one a round trip", async () => {
    // Each beside Node's own start, taken in turn round by round, so a busy moment weighs on them all alike: what's
    // measured is what the hook adds to it (the median of five).
    const runs = {
      node: bare,
      off: async () => (await run(CLAUDE_HOOK, pre("git push"), SOCKET, { KIKO_SETTINGS: join(dir, "no-settings.json") })).ms,
      ordinary: async () => (await run(CLAUDE_HOOK, pre("pnpm test"))).ms,
      flagged: async () => (await run(CLAUDE_HOOK, pre("git push"))).ms,
      stop: async () => (await run(CLAUDE_HOOK, { hook_event_name: "SessionEnd", session_id: "x", cwd: "/x", reason: "other" }, join(dir, "nobody.sock"))).ms,
    };
    const ms: Record<keyof typeof runs, number[]> = { node: [], off: [], ordinary: [], flagged: [], stop: [] };
    for (let round = 0; round < 5; round++) for (const [name, once] of Object.entries(runs)) ms[name as keyof typeof runs].push(await once());
    const median = (all: number[]) => all.sort((a, b) => a - b)[2]!;
    const [node, off, ordinary, flagged, stop] = [ms.node, ms.off, ms.ordinary, ms.flagged, ms.stop].map(median) as [number, number, number, number, number];
    console.log(
      `# hook medians: node alone ${node.toFixed(0)}ms, no app ${stop.toFixed(0)}ms, gate off (git push) ${off.toFixed(0)}ms, ordinary command ${ordinary.toFixed(0)}ms, flagged ${flagged.toFixed(0)}ms`,
    );
    assert.ok(off - node < 300 * SLOW, `off ${off}ms, node alone ${node}ms`);
    assert.ok(ordinary - node < 300 * SLOW, `ordinary ${ordinary}ms, node alone ${node}ms`);
    assert.ok(flagged - node < 500 * SLOW, `flagged ${flagged}ms, node alone ${node}ms`);
  });
});

describe("with Kiko not running, the session behaves as configured", () => {
  test("no socket: exits 0 at once, printing nothing", async () => {
    const { out, code, ms } = await run(CLAUDE_HOOK, pre("git push"), join(dir, "nobody.sock"));
    assert.deepEqual([out, code], ["", 0]);
    const node = await bare();
    assert.ok(ms - node < 700 * SLOW, `${ms}ms, node alone ${node}ms`);
  });

  test("a socket file left over from a crash (nobody listening): the same", async () => {
    const stale = join(dir, "stale.sock");
    const s = createServer();
    await new Promise<void>((r) => s.listen(stale, r));
    // Closed without removing its file: what a crash leaves.
    (s as any)._handle?.close?.();
    writeFileSync(join(dir, "plain.sock"), "");
    for (const path of [stale, join(dir, "plain.sock")]) {
      const { out, code } = await run(CLAUDE_HOOK, pre("git push"), path);
      assert.deepEqual([out, code], ["", 0], path);
    }
  });

  test("not a socket of this user's at the app's path (a link to one, B5): passed over, the app never reached", async () => {
    const real = join(dir, "real.sock");
    let reached = 0;
    const s = createServer((conn) => {
      reached++;
      conn.end('{"guard":{"ask":true,"reason":"from a link"}}\n');
    });
    await new Promise<void>((r) => s.listen(real, r));
    const link = join(dir, "link.sock");
    symlinkSync(real, link);
    try {
      for (const hook of [CLAUDE_HOOK, CODEX_HOOK]) {
        const { out, code } = await run(hook, hook === CLAUDE_HOOK ? pre("git push") : codexPre("git push"), link);
        assert.deepEqual([out, code], ["", 0], hook);
      }
      assert.equal(reached, 0);
      // The socket itself, the same user's: reached.
      await run(CLAUDE_HOOK, pre("git push"), real);
      assert.equal(reached, 1);
    } finally {
      s.close();
    }
  });

  test("an app from before the gate (closes without a verdict): passes", async () => {
    const old = join(dir, "old.sock");
    const s = createServer((conn) => conn.once("data", () => conn.end()));
    await new Promise<void>((r) => s.listen(old, r));
    try {
      const { out } = await run(CLAUDE_HOOK, pre("git push"), old);
      assert.equal(out, "");
    } finally {
      s.close();
    }
  });

  test("Codex's hook: the same, and keeps no record for it", async () => {
    const { out, code } = await run(CODEX_HOOK, codexPre("git push"), join(dir, "nobody.sock"));
    assert.deepEqual([out, code], ["", 0]);
  });
});

// ── Codex ──

const codexPre = (command: string, over: Record<string, unknown> = {}) => ({
  session_id: "11111111-2222-3333-4444-555555555555",
  cwd: CWD,
  transcript_path: "/nowhere/rollout.jsonl",
  model: "m",
  permission_mode: "default",
  hook_event_name: "PreToolUse",
  turn_id: "t1",
  tool_name: "Bash",
  tool_input: { command },
  tool_use_id: "call_1",
  ...over,
});

describe("Codex's hook holds a flagged call itself", () => {
  // A stand-in for the app's side of Codex's gate (src/agents/codex/index.ts): the verdict line, then the decision.
  let reply: (event: any, conn: Socket) => void = () => {};
  const got: any[] = [];
  const socket = join(dir, "codex.sock");
  let server: Server;
  before(async () => {
    server = createServer((conn) => {
      conn.setEncoding("utf8");
      let buf = "";
      conn.on("data", (c) => {
        buf += c;
        if (!buf.includes("\n")) return;
        const event = JSON.parse(buf.split("\n")[0]);
        got.push(event);
        reply(event, conn);
      });
    });
    await new Promise<void>((r) => server.listen(socket, r));
  });
  after(() => server.close());

  test("asked, then allowed: it runs (nothing printed)", async () => {
    reply = (_e, conn) => {
      conn.write('{"guard":{"ask":true}}\n');
      setTimeout(() => conn.end('{"decision":{"behavior":"allow"}}\n'), 50);
    };
    const { out, code } = await run(CODEX_HOOK, codexPre("git push"), socket);
    assert.deepEqual([out, code], ["", 0]);
    const e = got.at(-1);
    assert.deepEqual([e.agent, e.hook_event_name, e.tool_name, e.guard.hits[0].rule], ["codex", "PreToolUse", "Bash", "git push"]);
  });

  test("asked, then denied: Codex's deny, with why", async () => {
    reply = (_e, conn) => {
      conn.write('{"guard":{"ask":true}}\n');
      conn.end('{"decision":{"behavior":"deny","message":"The user said no by voice: \\"no\\""}}\n');
    };
    const { out } = await run(CODEX_HOOK, codexPre("npm publish"), socket);
    assert.deepEqual(JSON.parse(out), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: 'The user said no by voice: "no"' } });
  });

  test("asked, then let go (no answer), or the app gone: denied, never run", async () => {
    for (const then of ['{"decision":null}\n', ""]) {
      reply = (_e, conn) => {
        conn.write('{"guard":{"ask":true}}\n');
        conn.end(then);
      };
      const { out } = await run(CODEX_HOOK, codexPre("git push"), socket);
      assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny", JSON.stringify(then));
    }
  });

  test("a pass, an app from before the gate, or an ordinary command: runs, nothing printed", async () => {
    reply = (_e, conn) => conn.end('{"guard":{"ask":false}}\n');
    assert.equal((await run(CODEX_HOOK, codexPre("git push"), socket)).out, "");
    reply = (_e, conn) => conn.end();
    assert.equal((await run(CODEX_HOOK, codexPre("git push"), socket)).out, "");
    const before_ = got.length;
    assert.equal((await run(CODEX_HOOK, codexPre("ls"), socket)).out, "");
    assert.equal(got.length, before_, "an ordinary command never reaches the app");
  });

  test("the gate off (fresh settings, the default): a push runs at once, nothing printed, the app never asked", async () => {
    reply = (_e, conn) => conn.write('{"guard":{"ask":true}}\n');
    const before_ = got.length;
    for (const path of [join(dir, "no-settings.json"), settingsFile('{"guard":false}')]) {
      const { out, code } = await run(CODEX_HOOK, codexPre("git push"), socket, { KIKO_SETTINGS: path });
      assert.deepEqual([out, code], ["", 0], path);
    }
    assert.equal(got.length, before_);
    // Its questions are still told with the gate off.
    reply = () => {};
    await run(CODEX_HOOK, codexPre("", { tool_name: "request_user_input", tool_input: { questions: [] } }), socket, { KIKO_SETTINGS: join(dir, "no-settings.json") });
    // Told, not answered: the hook may be seen gone before its line is read here.
    await waitFor(() => got.length > before_, "the question told");
    assert.equal(got.at(-1).tool_name, "request_user_input");
  });

  test("its questions (request_user_input) are still only told", async () => {
    reply = () => {};
    const before_ = got.length;
    const { out, code } = await run(CODEX_HOOK, codexPre("", { tool_name: "request_user_input", tool_input: { questions: [] } }), socket);
    assert.deepEqual([out, code], ["", 0]);
    await waitFor(() => got.length > before_, "the question told");
    assert.equal(got.at(-1).tool_name, "request_user_input");
    assert.equal(got.at(-1).guard, undefined);
  });
});

describe("Codex's adapter: the verdict, then a card", () => {
  let server: any;
  const held: any[] = [];
  const socket = join(dir, "codex-app.sock");
  before(async () => {
    process.env.KIKO_SOCKET = socket;
    // A second copy of the server's module, so it reads this socket (its SOCKET is read once, on import).
    const fresh = "../../../src/agents/claude-code/hooks.ts?codex-app";
    const { HookServer } = await import(fresh);
    const { codex } = await import("../../../src/agents/codex/index.ts");
    codex.onGuard = async (check) => {
      const verdict = await decideGuard(check, { on: true, off: ["deletes"] });
      noteGuard(check, verdict);
      return verdict;
    };
    codex.onHeld = (r) => held.push(r);
    server = new HookServer();
    await server.start();
  });
  after(() => server.stop());

  test("an ask: held as a permission card, marked as the gate's; yes runs it", async () => {
    forgetPending();
    const result = run(CODEX_HOOK, codexPre("vercel --prod"), socket);
    await waitFor(() => held.length === 1);
    const card = held[0];
    assert.deepEqual([card.isPermission, card.canAllowAlways, card.tool.name, card.tool.input.command], [true, false, "Bash", "vercel --prod"]);
    assert.deepEqual(guardOf(card), { kind: "posts", what: "deploy to production on Vercel", rule: "vercel", by: "rule", agent: "codex" });
    card.allow(false);
    assert.equal((await result).out, "");
  });

  test("let go (its window ran out): denied", async () => {
    held.length = 0;
    const result = run(CODEX_HOOK, codexPre("npm publish"), socket);
    await waitFor(() => held.length === 1);
    held[0].release();
    assert.equal(JSON.parse((await result).out).hookSpecificOutput.permissionDecision, "deny");
  });

  test("a kind turned off: passes, no card", async () => {
    held.length = 0;
    const { out } = await run(CODEX_HOOK, codexPre("rm -rf ~/old"), socket);
    assert.equal(out, "");
    assert.equal(held.length, 0);
  });
});

describe("the gate's own code fails (B4): asked or denied, never let through", () => {
  // A copy of the hooks whose rules throw: what a bug in them would do.
  const copy = join(dir, "broken-hooks");
  const socket = join(dir, "broken.sock");
  let server: Server;
  let reached = 0;
  before(async () => {
    cpSync(new URL("../../../hooks", import.meta.url).pathname, copy, { recursive: true });
    writeFileSync(join(copy, "guard.mjs"), 'export function guardCheck() { throw new TypeError("a bug in the rules"); }\n');
    server = createServer((conn) => {
      reached++;
      conn.end();
    });
    await new Promise<void>((r) => server.listen(socket, r));
  });
  after(() => server.close());

  test("Claude Code: asked, with why; the app not reached", async () => {
    const { out, code } = await run(join(copy, "claude-code-hook.mjs"), pre("git push"), socket);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(out), {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "Kiko asks first: its safety check failed on this call." },
    });
    assert.equal(reached, 0);
  });

  test("Codex (no ask of its own): denied, with why", async () => {
    const { out, code } = await run(join(copy, "codex-hook.mjs"), codexPre("git push"), socket);
    assert.equal(code, 0);
    const output = JSON.parse(out).hookSpecificOutput;
    assert.equal(output.permissionDecision, "deny");
    assert.match(output.permissionDecisionReason, /safety check failed/);
  });

  test("the gate off: still passes at once, the rules never loaded", async () => {
    const { out, code } = await run(join(copy, "claude-code-hook.mjs"), pre("git push"), socket, { KIKO_SETTINGS: join(dir, "no-settings.json") });
    assert.deepEqual([out, code], ["", 0]);
  });
});

describe("the rules' cost per call", () => {
  test("a thousand typical commands in well under a millisecond each", () => {
    const commands = [
      "ls -la",
      "pnpm test",
      "git status",
      "git diff --stat",
      "cat src/app.ts",
      "rg -n foo src",
      "node --test x.test.ts",
      "git push origin main",
      "rm -rf node_modules",
      "cd x && pnpm build",
    ];
    const start = performance.now();
    for (let i = 0; i < 1000; i++) checkCommand(commands[i % commands.length], CWD);
    const each = (performance.now() - start) / 1000;
    console.log(`# guardCheck: ${(each * 1000).toFixed(0)}µs a command`);
    assert.ok(each < 1, `${each}ms`);
  });
});

// Waits on a hook process: Node can take seconds to start on a busy machine.
const waitFor = checkWaits(15_000, 10);
