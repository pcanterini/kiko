// The microphone's permission at the app's start (src/app/mic-permission.ts), as the talk key's is
// (talk-key.test.ts): not allowed for the app the helpers run in (renamed, reset, turned off), it's
// said plainly with where to turn it on, logged, and kept on the window's line until it's on.
// Fakes only: no helper runs, no permission is looked at.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkMic, micBar, micLine } from "../../../src/app/mic-permission.ts";
import type { Permission } from "../../../src/platform/types.ts";

const PANE = "Privacy & Security → Microphone";
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(mic: () => Permission | "throws", o: { app?: string; refresh?: () => Promise<boolean> } = {}) {
  const said: string[] = [];
  const logged: string[] = [];
  const waits: (string | null)[] = [];
  const allowed = checkMic({
    mic: async () => {
      const now = mic();
      if (now === "throws") throw new Error("no helper");
      return now;
    },
    app: o.app ?? "Ghostty",
    pane: PANE,
    say: (line) => void said.push(line),
    waits: (line) => void waits.push(line),
    log: (event, fields) => void logged.push(`${event} ${JSON.stringify(fields)}`),
    ...(o.refresh ? { refresh: o.refresh } : {}),
    watchMs: 20,
  });
  return { allowed, said, logged, waits };
}

describe("the microphone at the app's start", () => {
  test("allowed: nothing said, nothing on the line", async () => {
    const r = run(() => "granted");
    assert.equal(await r.allowed, true);
    assert.deepEqual([r.said, r.logged, r.waits], [[], [], []]);
  });

  test("unreadable (no permissions helper): nothing said, it may well hear", async () => {
    const r = run(() => "throws");
    assert.equal(await r.allowed, true);
    assert.deepEqual([r.said, r.logged, r.waits], [[], [], []]);
  });

  test("turned off for the terminal app: where to turn it on, then restart; logged, and on the window's line", async () => {
    const r = run(() => "denied");
    assert.equal(await r.allowed, false);
    assert.deepEqual(r.said, [
      "The microphone is off for Ghostty: turn it on in System Settings → Privacy & Security → Microphone → Ghostty, then restart Kiko (or run kiko-dev setup: it asks for it again).",
    ]);
    assert.deepEqual(r.logged, [`mic_unallowed ${JSON.stringify({ mic: "denied", app: "Ghostty" })}`]);
    assert.deepEqual(r.waits, ["The mic isn't allowed: turn it on in System Settings → Privacy & Security → Microphone → Ghostty"]);
  });

  test("never asked for the helper app (renamed): macOS asks, its dialog maybe behind the window; watched for, and cleared once it's on, nothing restarted", async () => {
    let mic: Permission = "unknown";
    let refreshed = 0;
    const r = run(() => mic, { app: "Kiko Dev", refresh: async () => (refreshed++, true) });
    assert.equal(await r.allowed, false);
    assert.deepEqual(r.said, [
      "macOS hasn't allowed the microphone for Kiko Dev yet: allow it when macOS asks (its dialog may be behind this window), or turn it on in System Settings → Privacy & Security → Microphone → Kiko Dev, and Kiko hears you once it's on.",
    ]);
    await settle(80);
    assert.equal(r.waits.length, 1, "still on the line while it's off");
    mic = "granted";
    for (let i = 0; i < 50 && r.waits.at(-1) !== null; i++) await settle(20);
    assert.equal(r.waits.at(-1), null, "the window's line cleared");
    assert.equal(r.said.at(-1), "The microphone is allowed now.");
    assert.equal(refreshed, 0, "allowed in macOS's dialog: the press that asked isn't cut off");
    assert.ok(r.logged.some((l) => l === `mic_allowed ${JSON.stringify({ after: "watch", was: "unknown", restarted: false })}`));
    const saidOnce = r.said.length;
    await settle(80);
    assert.equal(r.said.length, saidOnce, "no longer watched");
  });

  test("turned off for the helper app, then on in System Settings: the helper app started again", async () => {
    let mic: Permission = "denied";
    let refreshed = 0;
    const r = run(() => mic, { app: "Kiko Dev", refresh: async () => (refreshed++, true) });
    assert.equal(await r.allowed, false);
    assert.match(r.said[0], /^The microphone is off for Kiko Dev: turn it on in System Settings → Privacy & Security → Microphone → Kiko Dev, and Kiko hears you once it's on\.$/);
    mic = "granted";
    for (let i = 0; i < 50 && r.waits.at(-1) !== null; i++) await settle(20);
    await settle(20);
    assert.equal(refreshed, 1);
    assert.ok(r.logged.some((l) => l === `mic_allowed ${JSON.stringify({ after: "watch", was: "denied", restarted: true })}`));
  });

  test("the terminal's permission: not watched (it's restarted by hand)", async () => {
    let looks = 0;
    const r = run(() => (looks++, "denied"));
    await r.allowed;
    await settle(80);
    assert.equal(looks, 1);
  });

  test("no app known: said generically", () => {
    assert.equal(micBar({ app: null, pane: PANE }), "The mic isn't allowed: turn it on in System Settings → Privacy & Security → Microphone → your terminal app");
    assert.match(micLine({ mic: "denied", app: null, pane: PANE }), /^The microphone is off for your terminal app: /);
  });
});
