// The smoke of the built executable (scripts/ship/smoke.ts, `pnpm smoke:binary`, a step of `pnpm
// ship`), without building anything: how a run is judged, the environment each run gets (its own
// folders only, nothing of this shell's), and that no check is one that would start the app, a
// window or tmux. The build and the runs themselves are `pnpm smoke:binary`'s (about 13 s).
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { judge, type Run, type SmokeCheck, sandboxEnv, smokeChecks } from "../../../scripts/ship/smoke.ts";

const ran = (r: Partial<Run>): Run => ({ code: 0, stdout: "", stderr: "", ms: 40, timedOut: false, ...r });

describe("a run, judged", () => {
  const version: SmokeCheck = { name: "--version", args: ["--version"], code: 0, stdout: "0.3.2" };

  test("its exit code, its output, and nothing on stderr", () => {
    assert.equal(judge(version, ran({ stdout: "0.3.2\n" })), null);
    assert.match(judge(version, ran({ code: 1, stdout: "0.3.2" })) ?? "", /exit 1, not 0/);
    assert.match(judge(version, ran({ stdout: "0.3.1" })) ?? "", /stdout: "0\.3\.1"/);
    // Bun warning about something, or a crash's stack after the right line: a failure.
    assert.match(judge(version, ran({ stdout: "0.3.2", stderr: "ReferenceError: Cannot access 'A8' before initialization" })) ?? "", /stderr: "ReferenceError/);
  });

  test("an expected stderr, and output by pattern", () => {
    const unknown: SmokeCheck = { name: "unknown", args: ["x"], code: 2, stderr: /unknown command x/ };
    assert.equal(judge(unknown, ran({ code: 2, stderr: "X kiko: unknown command x" })), null);
    assert.match(judge(unknown, ran({ code: 2, stderr: "something else" })) ?? "", /stderr/);
    const help: SmokeCheck = { name: "help", args: ["--help"], code: 0, stdout: /^Usage: kiko / };
    assert.equal(judge(help, ran({ stdout: "Usage: kiko [options]" })), null);
    assert.match(judge(help, ran({ stdout: "" })) ?? "", /stdout/);
  });

  test("one that never exits fails, whatever it printed", () => {
    assert.match(judge(version, ran({ stdout: "0.3.2", timedOut: true, ms: 20_000, code: null })) ?? "", /didn't exit within 20s/);
  });
});

describe("what each run sees", () => {
  const root = "/tmp/kiko-smoke-x";
  const env = sandboxEnv(root);

  test("its own folders, under the smoke's", () => {
    for (const name of ["HOME", "TMPDIR", "TMUX_TMPDIR", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "KIKO_SOCKET", "KIKO_STATE", "KIKO_SETTINGS"])
      assert.ok(env[name]?.startsWith(`${root}/`), `${name}: ${env[name]}`);
    assert.equal(env.KIKO_KEYCHAIN, "off");
    assert.equal(env.KIKO_ACCOUNTS, "0");
    assert.equal(env.KIKO_TMUX_SERVER, "kiko-smoke");
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:9");
  });

  test("nothing of this shell's: no keys, no TMUX, no PATH but the system's", () => {
    const allowed = new Set(["PATH", "HOME", "USER", "LANG", "TMPDIR", "TMUX_TMPDIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy"]);
    for (const name of Object.keys(env)) assert.ok(allowed.has(name) || name.startsWith("XDG_") || name.startsWith("KIKO_"), name);
    assert.equal(env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
    assert.ok(!("TMUX" in env));
  });
});

describe("the checks", () => {
  const dir = "/tmp/kiko-smoke-x/install/kiko-0.3.2";
  const checks = smokeChecks(dir, "0.3.2");

  test("the version, the folder's check, and the scripts the agents run with it", () => {
    assert.equal(checks.find((c) => c.name === "--version")?.stdout, "0.3.2");
    assert.equal(checks.find((c) => c.name === "_verify-files")?.stdout, "0.3.2");
    const hooks = checks.filter((c) => c.args[0] === "hook").map((c) => c.args[1]);
    assert.ok(hooks.length >= 4);
    for (const script of hooks) assert.ok(script.startsWith(`${dir}/`) && script.endsWith(".mjs"), script);
  });

  test("none starts the window, an agent, tmux or one of the app's programs", () => {
    for (const c of checks) {
      assert.ok(c.args.length > 0, `${c.name}: plain kiko opens the window`);
      assert.ok(!["claude", "codex", "opencode", "attach", "ls", "trust-scratch", "update", "login", "upgrade", "_run"].includes(c.args[0]), `${c.name}: ${c.args[0]}`);
    }
  });
});
