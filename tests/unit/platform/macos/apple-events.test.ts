// AppleScripts that control another app, run by the helper app so macOS asks whether Kiko may
// control Ghostty, not the terminal `kiko` was started from (src/platform/macos/apple-events.ts):
// against a fake app of the test's own (tests/support/fake-broker.ts, its osascript op answered by
// the test), and the fallback to `kiko`'s own osascript (a fake here) when the app can't be used.
// No real AppleScript runs, nor the real app.
import "../../../setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { appleEvents, runAppleScript, type AppleEventDeps } from "../../../../src/platform/macos/apple-events.ts";
import { BrokerConn, connectTo } from "../../../../src/platform/macos/helper-app.ts";
import { FakeBroker, type FakeBrokerOptions } from "../../../support/fake-broker.ts";

const dir = mkdtempSync(join(tmpdir(), "ae-"));
const fakes: FakeBroker[] = [];
const conns: BrokerConn[] = [];
after(async () => {
  for (const c of conns) c.close();
  for (const f of fakes) await f.close().catch(() => {});
});

let n = 0;
/** A fake app answering scripts with `scripts`, connected; a runner over it with a fake direct osascript. */
async function setup(scripts?: FakeBrokerOptions["scripts"], o: { app?: false; why?: string } = {}) {
  const socket = join(dir, `${++n}.sock`);
  const fake = new FakeBroker({ socket, build: "b", bundlePath: "/x", helpers: {}, scripts });
  fakes.push(fake);
  await fake.listen();
  const conn = new BrokerConn((await connectTo(socket))!, socket);
  conns.push(conn);
  const direct: Array<{ script: string; args: string[] }> = [];
  const logs: Array<Record<string, unknown>> = [];
  const deps: AppleEventDeps = {
    use: async () => (o.app === false ? { why: o.why ?? "off" } : { conn }),
    direct: async (script, args) => {
      direct.push({ script, args });
      return "direct out\n";
    },
    log: (event, fields) => logs.push({ event, ...fields }),
  };
  return { run: appleEvents(deps), fake, direct, logs };
}

const scripted = (fake: FakeBroker) => fake.ops.filter((m) => m.op === "osascript");

describe("AppleScript through the helper app", () => {
  test("the script, its arguments and its time limit go to the app; what it printed comes back; nothing runs here", async () => {
    const s = await setup((m) => ({ code: 0, stdout: `listed ${m.args.join(",")}\n` }));
    assert.equal(await s.run('tell application "Ghostty" to count terminals', ["a", "b"], 20_000), "listed a,b\n");
    const [op] = scripted(s.fake);
    assert.equal(op.script, 'tell application "Ghostty" to count terminals');
    assert.deepEqual(op.args, ["a", "b"]);
    assert.equal(op.timeout, 20);
    assert.equal(typeof op.token, "string");
    assert.deepEqual(s.direct, []);
    // Which way, logged once (the listing runs every few seconds).
    await s.run("x");
    assert.deepEqual(
      s.logs.filter((l) => l.event === "apple_events"),
      [{ event: "apple_events", via: "app" }],
    );
  });

  test("a script that fails there rejects with what osascript said, and isn't run again here (it may have typed)", async () => {
    const s = await setup(() => ({ code: 1, stderr: "execution error: Not authorized to send Apple events to Ghostty. (-1743)\n" }));
    await assert.rejects(s.run("x"), /Not authorized to send Apple events to Ghostty/);
    assert.deepEqual(s.direct, []);
  });

  test("the app gone before it answers: rejected, never run again here", async () => {
    const s = await setup(() => "vanish");
    await assert.rejects(s.run("x", [], 5000), /went away/);
    assert.deepEqual(s.direct, []);
  });

  test("the app couldn't start osascript: run here instead, and that's logged with why", async () => {
    const s = await setup(() => "refuse");
    assert.equal(await s.run("x", ["1"]), "direct out\n");
    assert.deepEqual(s.direct, [{ script: "x", args: ["1"] }]);
    const why = s.logs.find((l) => l.event === "apple_events");
    assert.equal(why?.via, "direct");
    assert.match(String(why?.why), /couldn't run it/);
  });
});

describe("AppleScript without the helper app", () => {
  test("the app can't be used: `kiko`'s own osascript, as before, logged once with why", async () => {
    const s = await setup(undefined, { app: false, why: "Launch Services couldn't start it" });
    assert.equal(await s.run("x", ["a"]), "direct out\n");
    assert.equal(await s.run("y"), "direct out\n");
    assert.deepEqual(
      s.direct.map((d) => d.script),
      ["x", "y"],
    );
    assert.deepEqual(scripted(s.fake), [], "nothing sent to the app");
    assert.deepEqual(
      s.logs.filter((l) => l.event === "apple_events"),
      [{ event: "apple_events", via: "direct", why: "Launch Services couldn't start it" }],
    );
  });

  test("the real runner never runs osascript under the test runner (the helper app is off here: tests/setup.ts)", async () => {
    await assert.rejects(runAppleScript('tell application "Ghostty" to activate'), /refused/);
  });
});
