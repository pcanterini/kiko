// The helper app killed mid-run (macOS's own "Quit & Reopen" does, after a permission is turned on:
// the user's first run, 2026-11-03): the mic and the talk key's helpers come back by themselves,
// through the app started again, logged (helper_app_restarted, mic_restarted, hotkey_restarted) and
// never said; only one that doesn't come back is said, in plain words. Against the fake app of
// tests/support/fake-broker.ts (shell scripts for helpers): nothing real is started or asked of macOS.
import "../../../setup.ts";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Broker, type BrokerDeps, startAgain } from "../../../../src/platform/macos/helper-app.ts";
import { Hotkey } from "../../../../src/platform/macos/hotkey.ts";
import { Mic } from "../../../../src/platform/macos/mic.ts";
import { FakeBroker } from "../../../support/fake-broker.ts";
import { checkWaits } from "../../../support/until.ts";

const dir = mkdtempSync(join(tmpdir(), "har-"));

function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const helpers = {
  // "mic": ready on stderr (as mic.swift), then each line of its input back on stdout (its "audio"). Told a
  // device, it holds it open and says so, as mic.swift does for a Bluetooth mic you chose; told the system default
  // ("device" alone), the same as the default (2026-11-14: a Bluetooth system default is held too).
  mic: script(
    "mic",
    `echo ready >&2; while read l; do case "$l" in device) echo 'hold {"default":true,"name":"AirPods","on":true,"uid":"bt-1:input","why":"default"}' >&2;; "device "*) echo 'hold {"name":"AirPods","on":true,"uid":"bt-1:input","why":"chosen"}' >&2;; esac; echo "$l"; done`,
  ),
  // "hotkey": ready, then the key pressed (and held), listening until killed.
  hotkey: script("hotkey", "echo ready; sleep 0.1; echo down; while :; do sleep 1; done"),
};
/** Run directly (the app couldn't be started again): a helper that can't start (no permission: exits 1 before ready). */
const broken = script("broken", "exit 1");

let n = 0;
const fakes: FakeBroker[] = [];
after(async () => {
  for (const f of fakes) await f.close().catch(() => {});
});

type Setup = { broker: Broker; logs: Array<[string, Record<string, unknown>]>; said: string[]; launches: number; fake: FakeBroker; failLaunch: boolean };

/** A Broker for a fake app already running; `launch` (Launch Services) starts another, unless failLaunch. */
async function setup(): Promise<Setup> {
  const id = `r${++n}`;
  const socket = join(dir, id, "broker.sock");
  mkdirSync(join(dir, id), { recursive: true });
  const path = join(dir, id, `App ${id}.app`);
  mkdirSync(join(path, "Contents"), { recursive: true });
  writeFileSync(join(path, "Contents", "Info.plist"), "<plist><dict><key>BrokerBuild</key><string>b1</string></dict></plist>");
  const start = async () => {
    const fake = new FakeBroker({ socket, build: "b1", bundlePath: path, helpers });
    fakes.push(fake);
    await fake.listen();
    s.fake = fake;
  };
  const s = { logs: [], said: [], launches: 0, failLaunch: false } as unknown as Setup;
  await start();
  const deps: BrokerDeps = {
    wanted: () => true,
    spec: () => ({ name: `App ${id}`, id: `test.${id}`, path, socket }),
    prepare: async () => null,
    launch: async () => {
      s.launches++;
      if (s.failLaunch) throw new Error("LSOpenURLsWithRole() failed with error -10810");
      await start();
    },
    log: (event, fields) => s.logs.push([event, fields]),
    startMs: 2000,
    directPath: () => broken,
  };
  s.broker = new Broker(deps);
  return s;
}

const events = (s: Setup) => s.logs.map(([e]) => e);
const until = checkWaits(5000, 20);

describe("the helper app killed mid-run", () => {
  test("the mic comes back, open again as it was: logged, nothing said", async () => {
    const s = await setup();
    const mic = new Mic({ via: s.broker, log: (e, f) => s.logs.push([e, f]), say: (l) => s.said.push(l), againMs: [50, 50, 50] });
    await mic.start();
    let heard = "";
    mic.open((chunk) => (heard += chunk));
    await until(() => heard.includes("start"));
    const first = s.fake;
    await first.close(); // killed: its children with it, its connection gone
    heard = "";
    // Back, through a new app, and open again (its "start" line heard through the new helper).
    await until(() => events(s).includes("mic_restarted") && heard.includes("start"));
    assert.notEqual(s.fake, first);
    assert.equal(s.launches, 1);
    const died = s.logs.find(([e]) => e === "mic_died")![1];
    assert.equal(died.open, true);
    const restarted = s.logs.find(([e]) => e === "mic_restarted")![1];
    assert.equal(restarted.via, "app");
    assert.ok((restarted.ms as number) < 5000);
    const app = s.logs.find(([e]) => e === "helper_app_restarted")![1];
    assert.equal(app.ok, true);
    assert.equal(app.why, "gone");
    assert.equal(typeof app.ms, "number");
    assert.deepEqual(s.said, [], "nothing said: it came back by itself");
    mic.stop();
  });

  // 2026-11-13: a Bluetooth mic you chose is held open by the helper (mic.swift held). A helper that dies takes its
  // hold with it, and can't say so; the one started again is told the choice again, and holds again.
  // 2026-11-14: the helper is told the choice as it starts whatever it is, the system default too: that's what has
  // it hold a Bluetooth default (before, nothing was sent for the system default).
  test("a held mic: its hold is said ended for the helper that died, and the one started again holds again", async () => {
    const s = await setup();
    const mic = new Mic({ via: s.broker, log: (e, f) => s.logs.push([e, f]), say: (l) => s.said.push(l), againMs: [50, 50, 50] });
    const holds: Array<[boolean, string | undefined]> = [];
    mic.onHold = (h) => holds.push([h.on, h.why]);
    await mic.start();
    await until(() => holds.length === 1);
    assert.deepEqual([holds[0], mic.hold?.default], [[true, "default"], true], "told the system default as it starts");
    mic.setDevice({ uid: "bt-1:input", name: "AirPods" });
    await until(() => holds.length === 2);
    assert.deepEqual([mic.hold?.uid, mic.hold?.name], ["bt-1:input", "AirPods"]);
    await s.fake.close();
    await until(() => holds.length === 4);
    assert.deepEqual(holds.slice(1), [
      [true, "chosen"],
      [false, "the helper died"],
      [true, "chosen"],
    ]);
    assert.equal(mic.hold?.uid, "bt-1:input", "held again");
    mic.stop();
    assert.deepEqual(holds.at(-1), [false, "quit"], "and ended as the app quits");
    assert.equal(mic.hold, null);
  });

  test("the talk key comes back and keeps working; a key held as it died is let go", async () => {
    const s = await setup();
    const key = new Hotkey("right_option", { via: s.broker, log: (e, f) => s.logs.push([e, f]), say: (l) => s.said.push(l), againMs: [50, 50, 50] });
    let downs = 0;
    let ups = 0;
    key.onDown = () => downs++;
    key.onUp = () => ups++;
    await key.start();
    await until(() => downs === 1);
    assert.equal(ups, 0, "held");
    await s.fake.close();
    // Let go as it died (no press left open), then the new helper's press heard: the key works again, with nobody restarting anything.
    await until(() => downs === 2);
    assert.equal(ups, 1);
    assert.ok(events(s).includes("hotkey_died"));
    assert.ok(events(s).includes("hotkey_restarted"));
    assert.ok(events(s).includes("helper_app_restarted"));
    assert.deepEqual(s.said, []);
    key.stop();
  });

  test("both at once: the app started again once, both back, nothing said", async () => {
    const s = await setup();
    const log = (e: string, f: Record<string, unknown>) => s.logs.push([e, f]);
    const mic = new Mic({ via: s.broker, log, say: (l) => s.said.push(l), againMs: [50, 50] });
    const key = new Hotkey("right_option", { via: s.broker, log, say: (l) => s.said.push(l), againMs: [50, 50] });
    await Promise.all([mic.start(), key.start()]);
    await s.fake.close();
    await until(() => events(s).includes("mic_restarted") && events(s).includes("hotkey_restarted"));
    assert.equal(s.launches, 1, "one app started again, for both");
    assert.equal(events(s).filter((e) => e === "helper_app_restarted").length, 1);
    assert.deepEqual(s.said, []);
    mic.stop();
    key.stop();
  });

  test("not coming back: said once, in plain words, after the tries", async () => {
    const s = await setup();
    const log = (e: string, f: Record<string, unknown>) => s.logs.push([e, f]);
    const mic = new Mic({ via: s.broker, log, say: (l) => s.said.push(l), againMs: [20, 20, 20] });
    const key = new Hotkey("right_option", { via: s.broker, log, say: (l) => s.said.push(l), againMs: [20, 20, 20] });
    await Promise.all([mic.start(), key.start()]);
    s.failLaunch = true; // Launch Services refusing: direct, and the direct helper can't start
    await s.fake.close();
    await until(() => s.said.length === 2);
    assert.ok(
      s.said.some((l) => /^The microphone stopped and didn't come back: mic helper exited \(1\)\. Restart Kiko Dev to try again\.$/.test(l)),
      s.said.join("\n"),
    );
    assert.ok(
      s.said.some((l) => /^The talk key stopped and didn't come back: hotkey helper exited \(1\)\. Restart Kiko Dev to try again\.$/.test(l)),
      s.said.join("\n"),
    );
    const failed = s.logs.find(([e]) => e === "mic_restart_failed")![1];
    assert.equal(failed.tries, 3);
    assert.equal(s.logs.find(([e]) => e === "helper_app_restarted")![1].ok, false);
    mic.stop();
    key.stop();
  });

  test("stopped meanwhile: not started again, nothing said", async () => {
    const s = await setup();
    const mic = new Mic({ via: s.broker, log: (e, f) => s.logs.push([e, f]), say: (l) => s.said.push(l), againMs: [200] });
    await mic.start();
    await s.fake.close();
    await until(() => events(s).includes("mic_died"));
    mic.stop();
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(!events(s).includes("mic_restarted"));
    assert.equal(s.launches, 0);
    assert.deepEqual(s.said, []);
  });

  test("its pid is written beside the socket, so the app brought to the front by macOS stays quiet", async () => {
    const s = await setup();
    const mic = new Mic({ via: s.broker, log: () => {}, againMs: [] });
    await mic.start();
    const file = join(s.broker.d.spec().socket, "..", "client.pid");
    assert.ok(existsSync(file));
    assert.equal(readFileSync(file, "utf8").trim(), String(process.pid));
    mic.stop();
  });

  test("startAgain: tries until one works; null once stopped", async () => {
    let calls = 0;
    const r = await startAgain(
      async () => {
        if (++calls < 3) throw new Error(`no ${calls}`);
      },
      { stopped: () => false, delays: [1, 1, 1, 1] },
    );
    assert.deepEqual([r?.ok, r?.tries], [true, 3]);
    const failed = await startAgain(
      async () => {
        throw new Error("never");
      },
      { stopped: () => false, delays: [1, 1] },
    );
    assert.deepEqual(failed && !failed.ok ? [failed.why, failed.tries] : null, ["never", 2]);
    assert.equal(await startAgain(async () => {}, { stopped: () => true, delays: [1] }), null);
  });
});
