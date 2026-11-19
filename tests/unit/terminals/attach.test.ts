// What a tmux client attached by `kiko` gets for its stdin (src/terminals/tmux/attach.ts), and the
// keys kept out of what Kiko starts (src/core/key-values.ts, src/terminals/tmux/tmux.ts envLaunch):
// 2026-11-02, `curl -fsSL https://kiko.sh | sh` ran setup with its terminal opened read-only, and
// "Open Kiko" attached tmux to it, which drew nothing; and the app setup started got setup's keys,
// read from the Keychain, in its environment. With stand-in descriptors and a fake terminal (no
// real tmux, terminal, Keychain or settings), plus /dev/null opened each way for the real check.
import "../../setup.ts";
import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ATTACH_FAILED, attachInput, deviceOf, NO_TERMINAL, realAttachDeps, type AttachDeps } from "../../../src/terminals/tmux/attach.ts";
import { holdKey, keyOf, withoutHeldKeys } from "../../../src/core/key-values.ts";
import { KEY_NAMES } from "../../../src/core/keys.ts";
import { cleanEnv, envLaunch, sessionEnv } from "../../../src/terminals/tmux/tmux.ts";

/** A terminal and descriptors as `kiko` might find them: fd 0 a terminal or not, writable or not; the device it'd open. */
function fake(o: { tty0: boolean; writable0: boolean; device: string | null; opens?: "tty" | "not-tty" | "fails" }) {
  const opened: string[] = [];
  const closed: number[] = [];
  const deps: AttachDeps = {
    isTty: (fd) => (fd === 0 ? o.tty0 : o.opens !== "not-tty"),
    writable: (fd) => (fd === 0 ? o.writable0 : true),
    device: () => o.device,
    open(path) {
      if (o.opens === "fails") throw new Error("EACCES");
      opened.push(path);
      return 42;
    },
    close: (fd) => void closed.push(fd),
  };
  return { deps, opened, closed };
}

describe("the terminal a tmux client attaches with", () => {
  test("this terminal, open for reading and writing (plain `kiko`, `kiko setup`): its own stdin, nothing opened", () => {
    const f = fake({ tty0: true, writable0: true, device: "/dev/ttys003" });
    const input = attachInput(f.deps);
    assert.equal(input?.stdin, "inherit");
    assert.deepEqual(f.opened, []);
  });

  test('this terminal opened read-only (install.sh\'s `<"$term"`): the terminal opened again, by its own name, for both; closed after', () => {
    const f = fake({ tty0: true, writable0: false, device: "/dev/ttys003" });
    const input = attachInput(f.deps);
    assert.equal(input?.stdin, 42);
    assert.deepEqual(f.opened, ["/dev/ttys003"]);
    input!.close();
    assert.deepEqual(f.closed, [42]);
  });

  test("input from a pipe, output to a terminal: that terminal, opened for both", () => {
    const f = fake({ tty0: false, writable0: false, device: "/dev/ttys007" });
    assert.equal(attachInput(f.deps)?.stdin, 42);
    assert.deepEqual(f.opened, ["/dev/ttys007"]);
  });

  test("no terminal at all, or one that can't be opened or isn't one: null (kiko says what to run instead of attaching)", () => {
    assert.equal(attachInput(fake({ tty0: false, writable0: false, device: null }).deps), null);
    assert.equal(attachInput(fake({ tty0: true, writable0: false, device: "/dev/ttys003", opens: "fails" }).deps), null);
    const notTty = fake({ tty0: false, writable0: false, device: "/dev/ttys003", opens: "not-tty" });
    assert.equal(attachInput(notTty.deps), null);
    assert.deepEqual(notTty.closed, [42], "what was opened is closed again");
  });

  test("what's said then names the command to run", () => {
    assert.match(NO_TERMINAL, /Run kiko(-dev)? in a terminal to see it\.$/);
    assert.match(ATTACH_FAILED, /Run kiko(-dev)? to open it\.$/);
  });

  test("the device from ps: ttys003 is /dev/ttys003; none (??) is null", () => {
    assert.equal(deviceOf("ttys003\n"), "/dev/ttys003");
    assert.equal(deviceOf(" ttys012 "), "/dev/ttys012");
    assert.equal(deviceOf("??"), null);
    assert.equal(deviceOf(""), null);
  });

  test("writable, for real: a descriptor opened read-only isn't (what tmux couldn't draw on); one opened for both is", () => {
    const ro = openSync("/dev/null", "r");
    const rw = openSync("/dev/null", "r+");
    try {
      assert.equal(realAttachDeps.writable(ro), false);
      assert.equal(realAttachDeps.writable(rw), true);
    } finally {
      closeSync(ro);
      closeSync(rw);
    }
  });
});

describe("the keys Kiko finds stay out of what it starts", () => {
  const OR = "sk-or-v1-test-not-real-0000";
  const ANT = "sk-ant-test-not-real-0000";

  test("a key Kiko holds is read by keyOf; yours from the environment wins", () => {
    const held: Record<string, string> = {};
    holdKey("OPENROUTER_API_KEY", OR, held);
    assert.equal(keyOf("OPENROUTER_API_KEY", {}, held), OR);
    assert.equal(keyOf("OPENROUTER_API_KEY", { OPENROUTER_API_KEY: "yours" }, held), "yours");
    assert.equal(keyOf("OPENROUTER_API_KEY", { OPENROUTER_API_KEY: "  " }, held), OR, "a blank one is no key");
    assert.equal(keyOf("ANTHROPIC_API_KEY", {}, held), "");
  });

  test("a launch's environment: never a key Kiko holds; one your shell exports is yours and stays", () => {
    const held: Record<string, string> = { OPENROUTER_API_KEY: OR, ANTHROPIC_API_KEY: ANT };
    // As if something had put the held keys in process.env: taken out again for the launch.
    const env = { HOME: "/h", OPENROUTER_API_KEY: OR, ANTHROPIC_API_KEY: "your-own-export", PATH: "/usr/bin" };
    assert.deepEqual(withoutHeldKeys(env, KEY_NAMES, held), { HOME: "/h", ANTHROPIC_API_KEY: "your-own-export", PATH: "/usr/bin" });
  });

  test("the app's launch file (envLaunch) holds no key Kiko holds: the app reads the Keychain itself", () => {
    const held: Record<string, string> = { OPENROUTER_API_KEY: OR };
    const env = withoutHeldKeys({ HOME: "/h", PATH: "/usr/bin", OPENROUTER_API_KEY: OR }, KEY_NAMES, held);
    const dir = mkdtempSync(join(tmpdir(), "attach-env-"));
    try {
      const launch = envLaunch(env, dir, "/bin/true", []);
      const file = launch.argv[4];
      const lines = readFileSync(file, "utf8");
      launch.discard();
      assert.match(lines, /export HOME='\/h'/);
      assert.ok(!lines.includes("OPENROUTER_API_KEY") && !lines.includes(OR), "no key in the launch file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.ok(!sessionEnv(env, "/x").includes(OR));
  });

  test("tmux (its server, so every session in it) never gets a key, even one in the environment", () => {
    const env = { HOME: "/h", PATH: "/usr/bin", LANG: "en_US.UTF-8", OPENROUTER_API_KEY: OR, ANTHROPIC_API_KEY: ANT, DEEPGRAM_API_KEY: "dg", CARTESIA_API_KEY: "c" };
    const clean = cleanEnv(env);
    for (const name of KEY_NAMES) assert.equal(clean[name], undefined, name);
    assert.deepEqual(Object.keys(clean).sort(), ["HOME", "LANG", "PATH"]);
  });

  test("config read at start: the Keychain's and .env's keys aren't in process.env (only the test's own environment key is)", async () => {
    // tests/setup.ts sets ANTHROPIC_API_KEY (the environment's) and deletes OPENROUTER_API_KEY: no
    // Keychain under the test runner, so nothing is held; what's in process.env is only that one.
    await import("../../../src/core/config.ts");
    const inEnv = KEY_NAMES.filter((name) => process.env[name] !== undefined);
    assert.deepEqual(inEnv, ["ANTHROPIC_API_KEY"]);
  });
});
