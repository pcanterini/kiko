// The helper app's client (src/platform/macos/helper-app.ts) against a fake app of the test's own
// (tests/support/fake-broker.ts: the real one's protocol, a socket in this test's temp folder, shell
// scripts for helpers): a helper's output, input, exit code and kill through it; and each way it
// falls back to running the helper directly (turned off, not built, Launch Services refusing, the app
// refusing a spawn, another build in use by another `kiko`), a build that isn't the bundle's quit and
// started again, the app going away mid-run. Nothing here starts the real app or any macOS helper.
import "../../../setup.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Broker, type BrokerDeps, brokerSocket, bundleBuild, helperAppWanted, runHelper, spawnHelper } from "../../../../src/platform/macos/helper-app.ts";
import { FakeBroker } from "../../../support/fake-broker.ts";

const dir = mkdtempSync(join(tmpdir(), "ha-"));

/** A bundle on disk saying `build` (only its Info.plist: the fake doesn't run it). */
function bundle(name: string, build: string): string {
  const path = join(dir, `${name}.app`);
  mkdirSync(join(path, "Contents"), { recursive: true });
  writeFileSync(join(path, "Contents", "Info.plist"), `<plist><dict><key>BrokerBuild</key><string>${build}</string></dict></plist>`);
  return path;
}

function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const helpers = {
  // "permissions": what it was asked, on stdout; a line on stderr.
  permissions: script("permissions", 'echo "{\\"args\\":\\"$*\\"}"; echo note >&2'),
  // "mic": its input back, upper-cased, until its input ends; exits 3.
  mic: script("mic", "tr a-z A-Z; exit 3"),
  // "hotkey": waits until killed.
  hotkey: script("hotkey", "echo ready; while :; do sleep 1; done"),
};
const direct = {
  permissions: script("direct-permissions", 'echo "{\\"direct\\":\\"$*\\"}"'),
  mic: script("direct-mic", "cat"),
  hotkey: script("direct-hotkey", "echo ready-direct; while :; do sleep 1; done"),
};

let n = 0;
type Setup = { broker: Broker; logs: Array<[string, Record<string, unknown>]>; launches: string[]; fake: FakeBroker | null; socket: string };
const fakes: FakeBroker[] = [];
after(async () => {
  for (const f of fakes) await f.close().catch(() => {});
});

/**
 * A Broker for a fake app: `running` starts one before (saying `runningBuild`), and `launch` (what
 * Launch Services would start) starts one saying the bundle's build, unless `launchFails`.
 */
async function setup(
  o: { build?: string; running?: boolean; runningBuild?: string; otherClients?: number; refuse?: boolean; launchFails?: boolean; wanted?: boolean; notReady?: string } = {},
): Promise<Setup> {
  const id = `t${++n}`;
  const socket = join(dir, `${id}.sock`);
  const build = o.build ?? "b1";
  const path = bundle(id, build);
  const s: Setup = { broker: null as unknown as Broker, logs: [], launches: [], fake: null, socket };
  const start = async (says: string, otherClients = 0) => {
    const fake = new FakeBroker({ socket, build: says, bundlePath: path, helpers, otherClients, refuse: o.refuse });
    fakes.push(fake);
    await fake.listen();
    fake.relaunched(() => void start(build).then((f) => (s.fake = f)));
    s.fake = fake;
    return fake;
  };
  if (o.running) await start(o.runningBuild ?? build, o.otherClients);
  const deps: BrokerDeps = {
    wanted: () => o.wanted ?? true,
    spec: () => ({ name: `App ${id}`, id: `test.${id}`, path, socket }),
    prepare: async () => o.notReady ?? null,
    launch: async (p) => {
      s.launches.push(p);
      if (o.launchFails) throw new Error("LSOpenURLsWithRole() failed with error -10810");
      await start(build);
    },
    log: (event, fields) => s.logs.push([event, fields]),
    startMs: 2000,
    directPath: (name) => direct[name as keyof typeof direct],
  };
  s.broker = new Broker(deps);
  return s;
}

const used = (s: Setup) => s.logs.filter(([e]) => e === "helper_app").map(([, f]) => f);

describe("the helper app's client", () => {
  test("a helper's output and exit code come through the app; it's started through Launch Services once", async () => {
    const s = await setup();
    const r = await runHelper("permissions", ["status"], 5000, s.broker);
    assert.deepEqual(r, { code: 0, signal: null, stdout: '{"args":"status"}\n', stderr: "note\n" });
    assert.equal(s.launches.length, 1);
    assert.equal(used(s)[0].path, "app");
    assert.equal(used(s)[0].launched, true);
    // The second one: the same app, nothing started again.
    assert.equal((await runHelper("permissions", ["x"], 5000, s.broker)).stdout, '{"args":"x"}\n');
    assert.equal(s.launches.length, 1);
    assert.equal(used(s).length, 1);
  });

  test("its input goes to it (after the spawn), its end ends the helper's input", async () => {
    const s = await setup({ running: true });
    const p = spawnHelper("mic", [], {}, s.broker);
    p.stdin!.write("hello ");
    p.stdin!.end("there\n");
    let out = "";
    p.stdout!.on("data", (d) => (out += d));
    const [code, signal] = await new Promise<[number | null, string | null]>((r) => p.on("exit", (c, sg) => r([c, sg])));
    assert.equal(out, "HELLO THERE\n");
    assert.deepEqual([code, signal], [3, null]);
    assert.equal(p.via, "app");
    assert.equal(s.launches.length, 0, "running already: not started");
  });

  test("kill reaches it through the app, before it's started too", async () => {
    const s = await setup({ running: true });
    const p = spawnHelper("hotkey", ["61"], { stdin: "ignore" }, s.broker);
    p.kill(); // asked at once: sent once it's spawned
    const [code, signal] = await new Promise<[number | null, string | null]>((r) => p.on("exit", (c, sg) => r([c, sg])));
    assert.deepEqual([code, signal], [null, "SIGTERM"]);
    assert.ok(s.fake!.ops.some((o) => o.op === "kill" && o.signal === 15));
  });

  test("helpers that need no permission never go through it", async () => {
    const s = await setup({ running: true });
    const r = await runHelper("player", [], 5000, { ...s.broker, d: { ...s.broker.d, directPath: () => direct.permissions } } as unknown as Broker);
    assert.equal(r.stdout, '{"direct":""}\n');
    assert.equal(s.fake!.ops.length, 0);
  });

  test("turned off (KIKO_HELPER_APP), not macOS, not built: the helper runs directly, and why is logged", async () => {
    assert.equal(helperAppWanted("off", "darwin", false), false);
    assert.equal(helperAppWanted("on", "linux", false), false);
    assert.equal(helperAppWanted("", "darwin", false), true, "on by default (not said)");
    assert.equal(helperAppWanted("", "darwin", true), false, "never under the test runner…");
    assert.equal(helperAppWanted("on", "darwin", true), true, "…unless asked");
    for (const [o, why] of [
      [{ wanted: false }, "off"],
      [{ notReady: "its build failed: swiftc" }, "its build failed: swiftc"],
    ] as const) {
      const s = await setup(o);
      const r = await runHelper("permissions", ["status"], 5000, s.broker);
      assert.equal(r.stdout, '{"direct":"status"}\n');
      assert.deepEqual(
        used(s).map((f) => [f.path, f.why]),
        [["direct", why]],
      );
      assert.equal(s.launches.length, 0);
    }
  });

  test("Launch Services refusing (no GUI session: SSH): direct, with why", async () => {
    const s = await setup({ launchFails: true });
    const p = spawnHelper("hotkey", ["61"], { stdin: "ignore" }, s.broker);
    const line = await new Promise<string>((r) => p.stdout!.once("data", (d) => r(String(d))));
    assert.equal(line, "ready-direct\n");
    assert.equal(p.via, "direct");
    p.kill();
    assert.match(String(used(s)[0].why), /^Launch Services couldn't start it \(LSOpenURLsWithRole\(\) failed/);
    // Decided once: the next helper runs directly too, without asking Launch Services again.
    assert.equal((await runHelper("permissions", ["again"], 5000, s.broker)).stdout, '{"direct":"again"}\n');
    assert.equal(s.launches.length, 1);
  });

  test("a spawn the app refuses runs directly instead, its input kept", async () => {
    const s = await setup({ running: true, refuse: true });
    const p = spawnHelper("mic", [], {}, s.broker);
    p.stdin!.end("kept\n");
    let out = "";
    p.stdout!.on("data", (d) => (out += d));
    await new Promise((r) => p.on("exit", r));
    assert.equal(out, "kept\n");
    assert.equal(p.via, "direct");
    assert.ok(s.logs.some(([e, f]) => e === "helper_spawn_failed" && f.via === "app"));
  });

  test("another build running (an update, a rebuild) is quit and this one started", async () => {
    const s = await setup({ running: true, runningBuild: "old", build: "new" });
    const old = s.fake!;
    const r = await runHelper("permissions", ["status"], 5000, s.broker);
    assert.equal(r.stdout, '{"args":"status"}\n', JSON.stringify(s.logs));
    assert.equal(old.quits, 1);
    assert.equal(s.launches.length, 1);
    assert.equal(used(s)[0].build, "new");
  });

  test("another build in use by another kiko: left alone, direct", async () => {
    const s = await setup({ running: true, runningBuild: "old", build: "new", otherClients: 1 });
    const r = await runHelper("permissions", ["status"], 5000, s.broker);
    assert.equal(r.stdout, '{"direct":"status"}\n');
    assert.equal(s.fake!.quits, 0);
    assert.match(String(used(s)[0].why), /uses .* build old, not new/);
  });

  test("the app gone mid-run: the helper's exit is told, and the next one starts the app again", async () => {
    const s = await setup({ running: true });
    const p = spawnHelper("hotkey", ["61"], { stdin: "ignore" }, s.broker);
    await new Promise((r) => p.stdout!.once("data", r));
    await s.fake!.close();
    const [, signal] = await new Promise<[number | null, string | null]>((r) => p.on("exit", (c, sg) => r([c, sg])));
    assert.ok(signal === "SIGKILL" || signal === "SIGTERM", `ended by ${signal}`);
    const r = await runHelper("permissions", ["again"], 5000, s.broker);
    assert.equal(r.stdout, '{"args":"again"}\n');
    assert.equal(s.launches.length, 1);
  });

  test("relaunch: the app asked to start again, and used again once it's back", async () => {
    const s = await setup({ running: true });
    await runHelper("permissions", ["status"], 5000, s.broker);
    const first = s.fake!;
    assert.equal(await s.broker.relaunch(), true);
    assert.equal(first.relaunches, 1);
    assert.notEqual(s.fake, first);
    assert.equal((await runHelper("permissions", ["after"], 5000, s.broker)).stdout, '{"args":"after"}\n');
    assert.ok(s.logs.some(([e]) => e === "helper_app_relaunched"));
  });

  test("relaunch with no app (direct): false, so the caller says to reopen the terminal", async () => {
    const s = await setup({ wanted: false });
    assert.equal(await s.broker.relaunch(), false);
  });

  test("a bundle's build is read from its Info.plist; the socket is in the app's own Caches folder", () => {
    assert.equal(bundleBuild(bundle("plist", "dev-0123")), "dev-0123");
    assert.equal(bundleBuild(join(dir, "none.app")), null);
    assert.equal(brokerSocket("sh.kiko.dev.helper", "/Users/x"), "/Users/x/Library/Caches/sh.kiko.dev.helper/broker.sock");
  });
});
