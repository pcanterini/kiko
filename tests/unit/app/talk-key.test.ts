// The talk key's start in the app (src/app/talk-key.ts): its helper stopping at once (no Input
// Monitoring for the terminal app) is said plainly, with where to turn it on, and the app goes on.
// Its helper listening while macOS hasn't let it hear yet (its prompt up, maybe behind the window:
// 2026-11-03) is said too, and stays on the window's line until it's on.
// Fakes only: no helper runs, no permission is looked at.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { startTalkKey, talkKeyBar, talkKeyLine, unheardLine } from "../../../src/app/talk-key.ts";
import type { Permission } from "../../../src/platform/types.ts";

const PANE = "Privacy & Security → Input Monitoring";

function fakeKey(fails: string | null) {
  const calls = { started: 0, stopped: 0 };
  return {
    calls,
    hotkey: {
      start: async () => {
        calls.started++;
        if (fails) throw new Error(fails);
      },
      stop: () => void calls.stopped++,
    },
  };
}

function run(fails: string | null, input: Permission | "throws") {
  const said: string[] = [];
  const logged: string[] = [];
  const waits: (string | null)[] = [];
  const { hotkey, calls } = fakeKey(fails);
  const started = startTalkKey(hotkey, {
    key: "Right Option",
    waits: (line) => void waits.push(line),
    input: async () => {
      if (input === "throws") throw new Error("no helper");
      return input;
    },
    app: "Ghostty",
    pane: PANE,
    menu: "Ctrl+Space",
    say: (line) => void said.push(line),
    log: (event, fields) => void logged.push(`${event} ${JSON.stringify(fields)}`),
  });
  return { started, said, logged, calls, waits };
}

describe("the talk key's start in the app", () => {
  test("no Input Monitoring: the helper's exit is said plainly, with where to turn it on, and the app goes on", async () => {
    const r = run("hotkey helper exited (1)", "denied");
    assert.equal(await r.started, false, "resolved, not thrown");
    assert.deepEqual(r.said, [
      "The talk key needs Input Monitoring for Ghostty: turn it on in System Settings → Privacy & Security → Input Monitoring → Ghostty, then restart Kiko (or run kiko-dev setup: it picks up at the talk key). Ctrl+Space and typing still work.",
    ]);
    assert.deepEqual(r.logged, ['hotkey_failed {"why":"hotkey helper exited (1)","input":"denied"}']);
    assert.equal(r.calls.stopped, 1);
    assert.deepEqual(r.waits, ["Right Option isn't heard: turn on Ghostty in System Settings → Privacy & Security → Input Monitoring"]);
  });

  test("never asked (unknown) or unreadable: the same line", async () => {
    for (const input of ["unknown", "throws"] as const) {
      const r = run("hotkey helper exited (1)", input);
      assert.equal(await r.started, false);
      assert.match(r.said[0], /^The talk key needs Input Monitoring for Ghostty/);
    }
  });

  test("Input Monitoring on, and it still failed: why, not a permission it has", async () => {
    const r = run("couldn't build the hotkey helper", "granted");
    assert.equal(await r.started, false);
    assert.deepEqual(r.said, ["The talk key didn't start (couldn't build the hotkey helper). Ctrl+Space and typing still work."]);
  });

  test("started: nothing said", async () => {
    const r = run(null, "granted");
    assert.equal(await r.started, true);
    assert.deepEqual(r.said, []);
    assert.deepEqual(r.logged, []);
    assert.deepEqual(r.waits, []);
    assert.equal(r.calls.stopped, 0);
  });

  test("started but not let hear (macOS's prompt pending, maybe behind the window): said, logged, and on the window's line", async () => {
    const r = run(null, "unknown");
    assert.equal(await r.started, true, "its helper listens: the key is kept");
    assert.deepEqual(r.said, [
      "macOS is asking to let Ghostty hear Right Option: its dialog may be behind this window. Allow it there, or turn it on in System Settings → Privacy & Security → Input Monitoring → Ghostty, then restart Kiko. Ctrl+Space and typing still work.",
    ]);
    assert.deepEqual(r.logged, ['hotkey_unheard {"input":"unknown","app":"Ghostty"}']);
    assert.deepEqual(r.waits, ["Right Option isn't heard: allow Ghostty in macOS's dialog (maybe behind this window) or Settings → Input Monitoring"]);
    assert.equal(r.calls.stopped, 0);
  });

  test("started, and Input Monitoring can't be read: nothing said (it may well hear)", async () => {
    const r = run(null, "throws");
    assert.equal(await r.started, true);
    assert.deepEqual([r.said, r.logged, r.waits], [[], [], []]);
  });

  test("started unheard in the helper app: watched for; once it's on, the key stopped, the app restarted, the key started, the line cleared", async () => {
    const said: string[] = [];
    const logged: string[] = [];
    const waits: (string | null)[] = [];
    const order: string[] = [];
    let input: Permission = "unknown";
    let later = 0;
    const hotkey = { start: async () => void order.push("start"), stop: () => void order.push("stop") };
    const started = await startTalkKey(hotkey, {
      input: async () => input,
      key: "Right Option",
      app: "Kiko Dev",
      pane: PANE,
      menu: "Ctrl+Space",
      say: (line) => void said.push(line),
      waits: (line) => void waits.push(line),
      log: (event, fields) => void logged.push(`${event} ${JSON.stringify(fields)}`),
      refresh: async () => {
        order.push("refresh");
        return true;
      },
      later: () => void later++,
      watchMs: 20,
    });
    assert.equal(started, true);
    assert.deepEqual(said, [
      "macOS is asking to let Kiko Dev hear Right Option: its dialog may be behind this window. Allow it there, or turn it on in System Settings → Privacy & Security → Input Monitoring → Kiko Dev, and Right Option starts working by itself. Ctrl+Space and typing still work. macOS may offer to Quit & Reopen Kiko Dev: either button is fine, Kiko carries on by itself.",
    ]);
    assert.equal(waits.length, 1);
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(order, ["start"], "nothing restarted before it's on");
    input = "granted";
    for (let i = 0; i < 50 && !later; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(order, ["start", "stop", "refresh", "start"]);
    assert.equal(waits.at(-1), null, "the window's line cleared");
    assert.equal(said.at(-1), "Input Monitoring is on: the talk key works now.");
    assert.ok(logged[0].startsWith("hotkey_unheard"));
    assert.ok(logged.some((l) => l.startsWith("hotkey_started")));
  });

  test("the helper app holds it: watched for, and once it's on, the app restarted and the key started, nothing restarted by hand", async () => {
    const said: string[] = [];
    const logged: string[] = [];
    let input: Permission = "unknown";
    let fails = true;
    let refreshed = 0;
    let later = 0;
    const calls = { started: 0, stopped: 0 };
    const hotkey = {
      start: async () => {
        calls.started++;
        if (fails) throw new Error("hotkey helper exited (1)");
      },
      stop: () => void calls.stopped++,
    };
    const started = await startTalkKey(hotkey, {
      input: async () => input,
      key: "Right Option",
      app: "Kiko Dev",
      pane: PANE,
      menu: "Ctrl+Space",
      say: (line) => void said.push(line),
      log: (event, fields) => void logged.push(`${event} ${JSON.stringify(fields)}`),
      refresh: async () => {
        refreshed++;
        fails = false; // the relaunched app's tap is let in
        return true;
      },
      later: () => void later++,
      watchMs: 20,
    });
    assert.equal(started, false);
    assert.deepEqual(said, [
      "The talk key needs Input Monitoring for Kiko Dev: turn it on in System Settings → Privacy & Security → Input Monitoring → Kiko Dev, and it starts by itself. Ctrl+Space and typing still work. macOS may offer to Quit & Reopen Kiko Dev: either button is fine, Kiko carries on by itself.",
    ]);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(refreshed, 0, "not before it's on");
    input = "granted";
    for (let i = 0; i < 50 && !later; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([refreshed, later, calls.started], [1, 1, 2]);
    assert.equal(said.at(-1), "Input Monitoring is on: the talk key works now.");
    assert.ok(logged.some((l) => l.startsWith("hotkey_started")));
  });

  test("no terminal app known: said generically", () => {
    assert.match(unheardLine({ app: null, key: "F13", pane: PANE, menu: "Ctrl+Space" }), /^macOS is asking to let your terminal app hear F13:/);
    assert.match(talkKeyBar({ app: null, key: "F13", asking: false }), /turn on your terminal app in System Settings/);
    assert.match(
      talkKeyLine({ input: "denied", app: null, pane: PANE, menu: "Ctrl+Space", why: "" }),
      /Input Monitoring for your terminal app: turn it on in System Settings → Privacy & Security → Input Monitoring → your terminal app,/,
    );
  });
});
