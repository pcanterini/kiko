// The helper app for real (scripts/build-helper-app.sh, native/macos/app/host.swift,
// src/platform/macos/helper-app.ts): built into this test's own folder under a name and bundle id
// of its own ("<NAME> Test <random>", <IDENTIFIER>.test.helper-<random>: never Kiko's or Kiko Dev's,
// so no permission of theirs is touched), signed ad hoc, then
//   - run directly with a socket of the test's own: the real helpers through it, asking nothing of
//     macOS (`permissions status`, `mic --list`), input and exit codes through its sockets, kill;
//   - started through Launch Services (`open -g -j`), as `kiko` starts it: its own responsible
//     process (so macOS would ask for its permissions, by its name), a relaunch, a quit; then
//     unregistered from Launch Services (lsregister -u) and its socket folder in ~/Library/Caches removed;
//   - a second instance on the same socket quits quietly (the lock); killed mid-run (as macOS's
//     "Quit & Reopen" does) with another instance forced beside its restart (`open -n`, as macOS's
//     Reopen may be): the mic helper comes back through one app, nothing said, the stray gone.
// Nothing here asks macOS for a permission (no prompt), nor touches the real app, its socket or its grants.
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { IDENTIFIER, NAME } from "../../../src/core/name.ts";
import { Broker, BrokerConn, type BrokerDeps, brokerSocket, bundleBuild, connectTo, runHelper, spawnHelper, unregisterApp } from "../../../src/platform/macos/helper-app.ts";
import { Mic } from "../../../src/platform/macos/mic.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const has = (program: string) => spawnSync("/bin/sh", ["-c", `command -v ${program}`]).status === 0;
const skip = process.platform !== "darwin" ? "macOS only" : !has("swiftc") ? "needs swiftc" : false;

const tag = randomBytes(3).toString("hex");
const name = `${NAME} Test ${tag}`;
const id = `${IDENTIFIER}.test.helper-${tag}`;
const dir = realpathSync(mkdtempSync(join(tmpdir(), "hal-")));
const app = join(dir, `${name}.app`);
const lsSocket = brokerSocket(id);
let host: ChildProcess | null = null;

const deps = (socket: string, launch: BrokerDeps["launch"]): BrokerDeps => ({
  wanted: () => true,
  spec: () => ({ name, id, path: app, socket }),
  prepare: async () => null,
  launch,
  log: () => {},
  directPath: () => "/usr/bin/false",
});

describe("the helper app, built and run", { skip }, () => {
  before(() => {
    const built = spawnSync("sh", [join(REPO, "scripts/build-helper-app.sh"), "--out", dir, "--name", name, "--id", id, "--command", "kiko-test", "--build", `test-${tag}`, "--identity", "-"], {
      encoding: "utf8",
    });
    assert.equal(built.status, 0, built.stderr);
    assert.equal(built.stdout.trim().split("\n").pop(), app);
  });

  after(() => {
    host?.kill("SIGKILL");
    // Whatever Launch Services started, gone; and forgotten.
    spawnSync("pkill", ["-x", name]);
    unregisterApp(app);
    rmSync(dirname(lsSocket), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  test("the bundle: its executable named after it, the helpers inside, the build, signed with the hardened runtime", () => {
    const plist = readFileSync(join(app, "Contents", "Info.plist"), "utf8");
    assert.match(plist, new RegExp(`<key>CFBundleExecutable</key><string>${name}</string>`));
    assert.match(plist, new RegExp(`<key>CFBundleIdentifier</key><string>${id.replace(/\./g, "\\.")}</string>`));
    assert.match(plist, /<key>LSUIElement<\/key><true\/>/);
    assert.match(plist, /<key>NSMicrophoneUsageDescription<\/key><string>[^<]+<\/string>/);
    // The reason under macOS's "wants access to control Ghostty" (the AppleScripts it runs: op osascript).
    assert.match(plist, /<key>NSAppleEventsUsageDescription<\/key><string>[^<]*Ghostty[^<]*<\/string>/);
    assert.equal(bundleBuild(app), `test-${tag}`);
    for (const h of ["mic", "hotkey", "speech", "permissions"]) assert.ok(existsSync(join(app, "Contents", "Helpers", h)), h);
    assert.ok(existsSync(join(app, "Contents", "MacOS", name)));
    assert.ok(existsSync(join(app, "Contents", "Resources", "AppIcon.icns")));
    assert.equal(spawnSync("codesign", ["--verify", "--deep", "--strict", app]).status, 0);
    const info = spawnSync("codesign", ["-dvv", app], { encoding: "utf8" }).stderr;
    assert.match(info, new RegExp(`Identifier=${id.replace(/\./g, "\\.")}\\n`));
    assert.match(info, /flags=0x\w+\(adhoc,runtime\)/);
    const ent = spawnSync("codesign", ["-d", "--entitlements", "-", "--xml", join(app, "Contents", "Helpers", "mic")], { encoding: "utf8" }).stdout;
    assert.match(ent, /com\.apple\.security\.device\.audio-input/);
    const appEnt = spawnSync("codesign", ["-d", "--entitlements", "-", "--xml", app], { encoding: "utf8" }).stdout;
    assert.match(appEnt, /com\.apple\.security\.device\.audio-input/);
    assert.match(appEnt, /com\.apple\.security\.automation\.apple-events/);
  });

  test("run directly: the real helpers through it, asking nothing", async () => {
    const socket = join(dir, "direct.sock");
    host = spawn(join(app, "Contents", "MacOS", name), ["--socket", socket, "--idle", "60"], { stdio: "ignore" });
    const broker = new Broker(
      deps(socket, async () => {
        for (let i = 0; i < 50 && !existsSync(socket); i++) await new Promise((r) => setTimeout(r, 100));
      }),
    );
    const status = await runHelper("permissions", ["status"], 10_000, broker);
    assert.equal(status.code, 0, status.stderr);
    const perms = JSON.parse(status.stdout);
    for (const k of ["mic", "speech", "input"]) assert.match(perms[k], /^(granted|denied|restricted|unknown)$/);
    const list = await runHelper("mic", ["--list"], 10_000, broker);
    assert.equal(list.code, 0, list.stderr);
    assert.ok(Array.isArray(JSON.parse(list.stdout)));
    // A usage error: its stderr and exit code back.
    const bad = await runHelper("hotkey", [], 10_000, broker);
    assert.deepEqual([bad.code, bad.stderr], [2, "usage: hotkey <virtual keycode> | hotkey capture\n"]);
    // The mic helper, never told to start (so it opens nothing), stopped with kill.
    const mic = spawnHelper("mic", [], {}, broker);
    let err = "";
    mic.stderr!.on("data", (d) => (err += d));
    await new Promise<void>((r) => {
      const t = setInterval(() => err.includes("ready") && (clearInterval(t), r()), 50);
    });
    assert.equal(mic.via, "app");
    mic.stdin!.write("stop\n"); // input reaches it (a no-op while it isn't open)
    mic.kill();
    const [, signal] = await new Promise<[unknown, unknown]>((r) => mic.on("exit", (c, s) => r([c, s])));
    assert.equal(signal, "SIGTERM");
    host.kill();
    host = null;
  });

  test("started through Launch Services: its own responsible process; relaunched; quit", async () => {
    const logs: Array<[string, Record<string, unknown>]> = [];
    const broker = new Broker({
      ...deps(lsSocket, async (path) => {
        const r = spawnSync("/usr/bin/open", ["-g", "-j", path], { encoding: "utf8" });
        if (r.status !== 0) throw new Error(r.stderr.trim());
      }),
      log: (e, f) => logs.push([e, f]),
    });
    const r = await runHelper("permissions", ["status"], 10_000, broker);
    assert.equal(r.code, 0, r.stderr);
    const used = logs.find(([e]) => e === "helper_app")?.[1];
    assert.equal(used?.path, "app", JSON.stringify(logs));
    assert.equal(used?.launched, true);
    assert.equal(used?.ownResponsible, true, "macOS would ask for its permissions, not this terminal's");
    assert.equal(used?.told, 0, 'started in the background: it never came to the front (its "works from the terminal" alert)');
    const pid = used?.pid;
    assert.equal(await broker.relaunch(), true);
    const again = logs.filter(([e]) => e === "helper_app").at(-1)?.[1];
    assert.notEqual(again?.pid, pid);
    assert.equal(again?.ownResponsible, true);
    assert.equal(again?.told, 0);
    // A moment later still: never brought to the front (no alert), and its own responsible process.
    await new Promise((r) => setTimeout(r, 1000));
    const s = await connectTo(lsSocket);
    assert.ok(s);
    const late = await new BrokerConn(s, lsSocket).sayHello(null);
    s.destroy();
    assert.deepEqual([late?.told, late?.responsible.self], [0, true]);
    assert.equal(await broker.quit(), true);
    for (let i = 0; i < 50 && existsSync(lsSocket); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(existsSync(lsSocket), false, "its socket goes with it");
  });

  test("a second instance on the same socket quits quietly; the first goes on serving", async () => {
    const socket = join(dir, "single.sock");
    const exe = join(app, "Contents", "MacOS", name);
    const first = spawn(exe, ["--socket", socket, "--idle", "60"], { stdio: "ignore" });
    try {
      for (let i = 0; i < 50 && !existsSync(socket); i++) await new Promise((r) => setTimeout(r, 100));
      const started = Date.now();
      const second = spawnSync(exe, ["--socket", socket, "--idle", "60"], { stdio: "ignore", timeout: 15_000 });
      assert.equal(second.status, 0, "quit, quietly");
      assert.ok(Date.now() - started < 10_000);
      assert.equal(first.exitCode, null, "the first still running");
      const s = await connectTo(socket);
      assert.ok(s, "the first still answers");
      const hello = await new BrokerConn(s, socket).sayHello(null);
      s.destroy();
      assert.equal(hello?.pid, first.pid);
    } finally {
      first.kill("SIGKILL");
    }
  });

  test("killed mid-run (macOS's Quit & Reopen), another forced beside: the mic comes back through one app, nothing said", async () => {
    const logs: Array<[string, Record<string, unknown>]> = [];
    const said: string[] = [];
    const open = (path: string, extra: string[] = []) => {
      const r = spawnSync("/usr/bin/open", [...extra, "-g", "-j", path], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr.trim());
    };
    const broker = new Broker({ ...deps(lsSocket, async (path) => open(path)), log: (e, f) => logs.push([e, f]) });
    const mic = new Mic({ via: broker, log: (e, f) => logs.push([e, f]), say: (l) => said.push(l) });
    // Started, never opened: it opens nothing, asks nothing.
    await mic.start();
    const pid = logs.find(([e]) => e === "helper_app")?.[1].pid as number;
    assert.ok(pid > 0, JSON.stringify(logs));
    process.kill(pid, "SIGKILL");
    // As macOS's Reopen may: another instance, beside the one `kiko` starts.
    open(app, ["-n"]);
    for (let i = 0; i < 150 && !logs.some(([e]) => e === "mic_restarted" || e === "mic_restart_failed"); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(
      logs.some(([e]) => e === "mic_restarted"),
      JSON.stringify(logs),
    );
    const back = logs.find(([e]) => e === "helper_app_restarted")?.[1];
    assert.equal(back?.ok, true);
    assert.notEqual(back?.pid, pid);
    assert.deepEqual(said, []);
    // The stray (whichever lost the lock) gone within its wait for the lock: one instance left.
    for (let i = 0; i < 60 && (spawnSync("pgrep", ["-x", name], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).length ?? 0) > 1; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(spawnSync("pgrep", ["-x", name], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).length, 1);
    const s = await connectTo(lsSocket);
    assert.ok(s);
    const hello = await new BrokerConn(s, lsSocket).sayHello(null);
    s.destroy();
    assert.equal(hello?.told, 0, "never said it works from the terminal");
    mic.stop();
    assert.equal(await broker.quit(), true);
    for (let i = 0; i < 50 && existsSync(lsSocket); i++) await new Promise((r) => setTimeout(r, 100));
  });
});
