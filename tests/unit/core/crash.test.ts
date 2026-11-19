// A throw or a rejection nothing caught (src/core/crash.ts, installed by src/app.ts): logged as
// crash_caught with its message and stack, the keys taken out, and the app kept running (a flood
// too, without the stacks), but stopped when it's already stopping. And core/log.ts never throws. A child process of its own for the real process events; temp folders only.
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { crashCatcher, crashFields, FLOOD_COUNT, FLOOD_MS, fatalWhy } from "../../../src/core/crash.ts";
import { LOG_FILE, log } from "../../../src/core/log.ts";

const src = join(import.meta.dirname, "..", "..", "..", "src");

function catcher(o: { stopping?: boolean; secrets?: string[] } = {}) {
  const logged: Array<{ event: string; data: Record<string, unknown> }> = [];
  const stopped: string[] = [];
  let t = 0;
  const caught = crashCatcher({
    log: (event, data) => logged.push({ event, data }),
    stop: (line) => stopped.push(line),
    stopping: () => o.stopping ?? false,
    secrets: () => o.secrets ?? [],
    now: () => (t += 1000),
  });
  return { caught, logged, stopped };
}

describe("a throw or rejection nothing caught", () => {
  test("a rejection is logged with its message and stack, and the app keeps running", () => {
    const { caught, logged, stopped } = catcher();
    caught("rejection", new Error("reconnect failed"));
    assert.equal(logged.length, 1);
    assert.equal(logged[0].event, "crash_caught");
    const d = logged[0].data;
    assert.equal(d.kind, "rejection");
    assert.equal(d.message, "reconnect failed");
    assert.match(String(d.stack), /^Error: reconnect failed\n {4}at /);
    assert.equal(d.then, "kept running");
    assert.deepEqual(stopped, []);
  });

  test("anything thrown: an error's code; a string or an object as text", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    assert.equal(crashFields(err).code, "ECONNREFUSED");
    assert.deepEqual(crashFields("plain"), { message: "plain" });
    assert.deepEqual(crashFields(null), { message: "null" });
    assert.deepEqual(crashFields(Object.create(null)), { message: "[object Object]" });
  });

  test("the keys are taken out, and anything sent as a bearer token; never the environment", () => {
    const key = "sk-or-v1-0123456789abcdef";
    const { caught, logged } = catcher({ secrets: [key] });
    caught("exception", new Error(`401 for ${key}: Authorization: Bearer abcdefgh12345678`));
    const text = JSON.stringify(logged[0].data);
    assert.ok(!text.includes(key) && !text.includes("abcdefgh12345678"), text);
    assert.match(String(logged[0].data.message), /401 for \[redacted\]: Authorization: Bearer \[redacted\]/);
    assert.deepEqual(Object.keys(logged[0].data).sort(), ["count", "kind", "message", "name", "stack", "then"]);
  });

  test("while stopping, it stops at once: a half-done shutdown would never exit", () => {
    const { caught, logged, stopped } = catcher({ stopping: true });
    caught("exception", new Error("speaker gone"));
    assert.equal(logged[0].data.then, "stopping (while stopping)");
    assert.equal(stopped.length, 1);
    assert.match(stopped[0], /^Stopped after an error \(while stopping\): Error: speaker gone/);
  });

  test("a flood keeps running, each logged, their stacks left out until it calms down", () => {
    const flood = catcher(); // one a second
    for (let i = 0; i < FLOOD_COUNT + 5; i++) flood.caught("exception", new Error("again"));
    assert.deepEqual(flood.stopped, []);
    assert.equal(flood.logged.length, FLOOD_COUNT + 5);
    assert.ok(flood.logged.slice(0, FLOOD_COUNT).every((l) => l.data.stack && !l.data.flood));
    const after = flood.logged.slice(FLOOD_COUNT);
    assert.ok(after.every((l) => !l.data.stack && l.data.message === "again" && l.data.then === "kept running"));
    assert.match(String(after[0].data.flood), new RegExp(`^${FLOOD_COUNT + 1} in ${FLOOD_MS / 1000} s, stacks not logged$`));
    assert.equal(fatalWhy({ stopping: false }), null);
    // One every 10 seconds: never a flood.
    const logged: Array<Record<string, unknown>> = [];
    let t = 0;
    const spread = crashCatcher({ log: (_e, d) => logged.push(d), stop: () => assert.fail("stopped"), stopping: () => false, now: () => (t += 10_000) });
    for (let i = 0; i < 30; i++) spread("rejection", new Error("now and then"));
    assert.equal(logged.length, 30);
    assert.ok(logged.every((d) => d.stack && !d.flood));
  });

  test("a log that throws doesn't lose it: said on stderr instead", () => {
    const said: string[] = [];
    const caught = crashCatcher({
      log: () => {
        throw new Error("disk full");
      },
      say: (line) => said.push(line),
      stop: () => {},
      stopping: () => false,
    });
    caught("rejection", new Error("boom"));
    assert.match(said[0], /crash_caught \(rejection\) not logged: disk full: Error: boom/);
  });

  test("in a real process: a rejection and a throw from a timer are logged, and it goes on to the end", () => {
    const dir = mkdtempSync(join(tmpdir(), "crash-"));
    const script = join(dir, "run.mjs");
    writeFileSync(
      script,
      [
        `import { crashCatcher } from ${JSON.stringify(pathToFileURL(join(src, "core", "crash.ts")).href)};`,
        `import { log, LOG_FILE } from ${JSON.stringify(pathToFileURL(join(src, "core", "log.ts")).href)};`,
        `const caught = crashCatcher({ log, stop: () => process.exit(3), stopping: () => false });`,
        `process.on("uncaughtException", (err) => caught("exception", err));`,
        `process.on("unhandledRejection", (reason) => caught("rejection", reason));`,
        `void Promise.reject(new Error("cartesia reconnect failed"));`,
        `setTimeout(() => { throw new Error("a listener threw"); }, 10);`,
        `setTimeout(() => { log("still_running"); console.log(LOG_FILE); }, 50);`,
      ].join("\n"),
    );
    const logs = join(dir, "logs");
    const r = spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8", env: { ...process.env, KIKO_LOG_DIR: logs }, timeout: 20_000 });
    assert.equal(r.status, 0, r.stderr);
    const lines = readFileSync(join(logs, r.stdout.trim()), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      lines.map((l) => [l.event, l.kind, l.message]),
      [
        ["crash_caught", "rejection", "cartesia reconnect failed"],
        ["crash_caught", "exception", "a listener threw"],
        ["still_running", undefined, undefined],
      ],
    );
  });
});

describe("the log never throws", () => {
  test("its folder deleted: made again, the line written", () => {
    const dir = process.env.KIKO_LOG_DIR as string; // this test process's own (tests/setup.ts)
    rmSync(dir, { recursive: true, force: true });
    log("after_delete", { n: 1 });
    assert.ok(existsSync(join(dir, LOG_FILE)));
    assert.match(readFileSync(join(dir, LOG_FILE), "utf8"), /"event":"after_delete"/);
  });

  test("yours only: the file 0600, a folder it makes 0700 (what was said and tool inputs are in it: B10)", () => {
    const dir = process.env.KIKO_LOG_DIR as string;
    rmSync(dir, { recursive: true, force: true });
    log("private", { n: 1 });
    assert.equal(statSync(join(dir, LOG_FILE)).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });

  test("a value JSON can't take: no throw", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    const write = process.stderr.write;
    const said: string[] = [];
    process.stderr.write = ((s: string) => said.push(s) > 0) as typeof process.stderr.write;
    try {
      assert.doesNotThrow(() => log("loop", loop));
      assert.doesNotThrow(() => log("loop", loop));
    } finally {
      process.stderr.write = write;
    }
    // Said once, not once a line.
    assert.equal(said.length, 1);
    assert.match(said[0], /^The log couldn't be written/);
  });
});
