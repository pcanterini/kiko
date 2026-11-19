// Ducking (src/platform/macos/duck.ts): the Mac's volume goes down while you talk and back up after, only if it's still what
// we set. The volume here is a number (tests/support/volume.ts); osascript never runs, the real volume never moves.
import "../../../setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import { Duck, leftoverDuck } from "../../../../src/platform/macos/duck.ts";
import { fakeMac, type Mac } from "../../../support/volume.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(init: Partial<Mac> = {}, opts: { enabled?: boolean; level?: number; againMs?: number[] } = {}) {
  const { mac, run } = fakeMac(init);
  let changes = 0;
  const duck = new Duck({ enabled: () => opts.enabled ?? true, level: () => opts.level ?? 20, run, againMs: opts.againMs ?? [] });
  duck.onChange = () => changes++;
  return { mac, duck, changes: () => changes };
}

/** This run's log lines for one event (setup.ts runs the tests in a temp folder: logs/ is there). */
function logged(event: string) {
  const file = readdirSync("logs")
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .at(-1)!;
  return readFileSync(`logs/${file}`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === event);
}

describe("while you talk", () => {
  test("down to the level, then back to exactly where it was", async () => {
    const { mac, duck, changes } = setup({ volume: 60 });
    await duck.duck();
    assert.equal(mac.volume, 12);
    assert.deepEqual(duck.ducked(), { from: 60, to: 12 });
    await duck.restore();
    assert.equal(mac.volume, 60);
    assert.equal(duck.ducked(), null);
    assert.equal(changes(), 2, "the state file is told both times");
    const down = logged("duck").at(-1);
    assert.equal(down.volume, 60);
    assert.equal(down.ducked, 12);
    assert.equal(typeof down.ms, "number");
    const up = logged("unduck").at(-1);
    assert.equal(up.restored, true);
    assert.equal(up.volume, 60);
  });

  test("off: never runs", async () => {
    const { mac, duck } = setup({ volume: 60 }, { enabled: false });
    await duck.duck();
    await duck.restore();
    assert.equal(mac.volume, 60);
    assert.deepEqual(mac.runs, []);
  });

  test("muted: left alone, and nothing to put back", async () => {
    const { mac, duck } = setup({ volume: 60, muted: true });
    await duck.duck();
    await duck.restore();
    assert.equal(mac.volume, 60);
    assert.deepEqual(
      mac.runs.map((r) => r.out),
      ["muted"],
    );
    assert.equal(logged("duck").at(-1).skipped, "muted");
  });

  test("an output with no volume (HDMI): left alone", async () => {
    const { mac, duck } = setup({ volume: null });
    await duck.duck();
    await duck.restore();
    assert.equal(mac.volume, null);
    assert.deepEqual(
      mac.runs.map((r) => r.op),
      ["lower"],
    );
  });

  test("at 0 already: nothing lower to go to", async () => {
    const { mac, duck } = setup({ volume: 0 });
    await duck.duck();
    await duck.restore();
    assert.deepEqual(
      mac.runs.map((r) => r.out),
      ["too_low"],
    );
  });

  test("so low its share would be 0 (1%, 2%): left alone, never to 0, which macOS takes as muted", async () => {
    for (const volume of [1, 2]) {
      const { mac, duck } = setup({ volume });
      await duck.duck();
      await duck.restore();
      assert.deepEqual(
        mac.runs.map((r) => r.out),
        ["too_low"],
      );
      assert.equal(mac.volume, volume);
    }
    // 4% still ducks, to 1.
    const { mac, duck } = setup({ volume: 4 });
    await duck.duck();
    assert.equal(mac.volume, 1);
    await duck.restore();
    assert.equal(mac.volume, 4);
  });

  test("you changed the volume meanwhile: it stays where you put it", async () => {
    const { mac, duck } = setup({ volume: 60 });
    await duck.duck();
    mac.volume = 40;
    await duck.restore();
    assert.equal(mac.volume, 40);
    assert.deepEqual(duck.ducked(), { from: 60, to: 12 }, "kept aside, not retried: ours again only if it reads 12");
    const up = logged("unduck").at(-1);
    assert.equal(up.restored, false);
    assert.equal(up.why, "changed");
    assert.equal(up.now, 40);
    assert.equal(up.aside, true);
    // The next press lowers from yours, 40, not from what was kept aside.
    await duck.duck();
    assert.equal(mac.volume, 8);
    await duck.restore();
    assert.equal(mac.volume, 40);
  });

  test("you changed it, looked at again a few times: still yours, left where you put it", async () => {
    const { mac, duck } = setup({ volume: 60 }, { againMs: [10, 10] });
    await duck.duck();
    mac.volume = 40;
    await duck.restore();
    assert.deepEqual(duck.ducked(), { from: 60, to: 12 }, "kept while it's looked at again");
    await wait(80);
    assert.equal(mac.volume, 40);
    assert.deepEqual(duck.ducked(), { from: 60, to: 12 }, "kept aside after the last look, no more looks");
    assert.deepEqual(
      mac.runs.map((r) => r.out),
      ["60,12", "changed,40", "changed,40", "changed,40"],
    );
  });

  // 2026-11-12: AirPods at 13, ducked to 3; their mic opened put them in the call profile, whose volume read 50 at
  // release, so 3 was left, then the next press took it to 1 and the video stayed nearly silent.
  test("a headset's call profile reads another volume at release: put back once it reads ours again", async () => {
    const { mac, duck } = setup({ volume: 13 }, { againMs: [20, 20, 20] });
    await duck.duck();
    assert.equal(mac.volume, 3);
    mac.volume = 50; // the call profile's own
    await duck.restore();
    assert.equal(mac.volume, 50);
    // Pressed again while it's still in the call profile: already down, not lowered from 50 (nor again from 3).
    await duck.duck();
    assert.equal(mac.runs.filter((r) => r.op === "lower").length, 1);
    mac.volume = 3; // back to A2DP, where it's still what we set
    await duck.restore();
    await wait(80);
    assert.equal(mac.volume, 13, "back where it was");
    assert.equal(duck.ducked(), null);
    const up = logged("unduck").at(-1);
    assert.equal(up.restored, true);
    assert.ok(up.looks >= 1, "after a look again");
  });

  // 2026-11-13: AirPods at 25 ducked to 5; the call profile read 43 at release and at every look after, so the
  // restore gave up. Back in A2DP they were still at 5: the next press lowered that to 1, the one after was
  // "too_low", and two spoken replies played at 1, unheard.
  test("the call profile outlasts every look: kept aside; the next press finds ours and doesn't lower again", async () => {
    const { mac, duck } = setup({ volume: 25 }, { againMs: [10, 10] });
    await duck.duck();
    assert.equal(mac.volume, 5);
    mac.volume = 43; // the call profile's own
    await duck.restore();
    await wait(60);
    assert.equal(mac.volume, 43, "never raised from the other profile's volume");
    mac.volume = 5; // back in A2DP, still at ours
    await duck.duck();
    assert.equal(mac.volume, 5, "not 1: a duck never starts from a level Kiko left");
    assert.deepEqual(duck.ducked(), { from: 25, to: 5 });
    assert.equal(logged("duck").at(-1).kept, true);
    await duck.restore();
    assert.equal(mac.volume, 25, "and back to yours at release");
    assert.equal(duck.ducked(), null);
    assert.deepEqual(
      mac.runs.map((r) => r.op),
      ["lower", "raise", "raise", "raise", "lower", "raise"],
    );
  });

  test("before speaking: a volume still at the level Kiko left it comes back first", async () => {
    const { mac, duck } = setup({ volume: 25 }, { againMs: [] });
    await duck.duck();
    mac.volume = 43;
    await duck.restore(); // kept aside
    mac.volume = 5;
    await duck.beforeSpeech();
    assert.equal(mac.volume, 25);
    assert.equal(duck.ducked(), null);
    const up = logged("unduck").at(-1);
    assert.equal(up.by, "speech");
    assert.equal(up.restored, true);
  });

  test("before speaking: at or below that level (lowered again from it), back to where Kiko found it", async () => {
    const { mac, duck } = setup({ volume: 25 }, { againMs: [] });
    await duck.duck();
    mac.volume = 43;
    await duck.restore();
    mac.volume = 1; // below ours: a duck from before this fix took 5 to 1
    await duck.beforeSpeech();
    assert.equal(mac.volume, 25);
  });

  test("before speaking: still looking again after a release, and it reads ours: back at once", async () => {
    const { mac, duck } = setup({ volume: 25 }, { againMs: [60_000] });
    await duck.duck();
    mac.volume = 43;
    await duck.restore(); // a look again due in a minute
    mac.volume = 5;
    await duck.beforeSpeech();
    assert.equal(mac.volume, 25);
    assert.equal(duck.ducked(), null);
  });

  test("before speaking: above our level, it's yours (or another profile's): left alone", async () => {
    const { mac, duck } = setup({ volume: 25 }, { againMs: [] });
    await duck.duck();
    mac.volume = 43;
    await duck.restore();
    await duck.beforeSpeech();
    assert.equal(mac.volume, 43);
    assert.deepEqual(duck.ducked(), { from: 25, to: 5 }, "still kept aside");
  });

  test("before speaking with nothing of ours down: the volume isn't even read", async () => {
    const { mac, duck } = setup({ volume: 25 });
    await duck.beforeSpeech();
    await duck.duck();
    await duck.restore();
    await duck.beforeSpeech();
    assert.deepEqual(
      mac.runs.map((r) => r.op),
      ["lower", "raise"],
    );
  });

  test("while you talk, speech doesn't raise the duck you're in", async () => {
    const { mac, duck } = setup({ volume: 25 });
    await duck.duck();
    await duck.beforeSpeech();
    assert.equal(mac.volume, 5);
    await duck.restore();
    assert.equal(mac.volume, 25);
  });

  test("on exit, a duck kept aside that reads ours again: put back", async () => {
    const { mac, duck } = setup({ volume: 25 }, { againMs: [] });
    await duck.duck();
    mac.volume = 43;
    await duck.restore();
    mac.volume = 5;
    await duck.finish();
    assert.equal(mac.volume, 25);
  });

  test("on exit while it waits to look again: one last look at once", async () => {
    const { mac, duck } = setup({ volume: 13 }, { againMs: [60_000] });
    await duck.duck();
    mac.volume = 50;
    await duck.restore();
    mac.volume = 3;
    await duck.finish();
    assert.equal(mac.volume, 13);
  });

  test("the Mac rounds what it's set to: what it reads back is what counts as ours", async () => {
    const { mac, duck } = setup({ volume: 75, step: 6.25 });
    await duck.duck(); // 15 → 13 (two steps of 6.25, read back as an integer)
    assert.equal(mac.volume, 13);
    assert.deepEqual(duck.ducked(), { from: 75, to: 13 });
    await duck.restore();
    assert.equal(mac.volume, 75);
  });

  test("released before the duck has run: they don't cross, and it ends back up", async () => {
    const { mac, duck } = setup({ volume: 60, delayMs: 20 });
    const down = duck.duck();
    const up = duck.restore();
    await Promise.all([down, up]);
    assert.deepEqual(
      mac.runs.map((r) => r.op),
      ["lower", "raise"],
    );
    assert.equal(mac.volume, 60);
  });

  test("released and pressed again while it goes back up: down again after it, then up once at the end", async () => {
    const { mac, duck } = setup({ volume: 60, delayMs: 10 });
    await duck.duck();
    void duck.restore();
    await duck.duck(); // pressed again while the restore runs
    assert.equal(mac.volume, 12);
    assert.deepEqual(duck.ducked(), { from: 60, to: 12 }, "from your volume, not from one on its way up");
    await duck.restore();
    assert.equal(mac.volume, 60);
    assert.deepEqual(
      mac.runs.map((r) => r.op),
      ["lower", "raise", "lower", "raise"],
    );
  });

  test("a press while already down doesn't lower it twice", async () => {
    const { mac, duck } = setup({ volume: 60 });
    await duck.duck();
    await duck.duck();
    assert.equal(mac.volume, 12);
    assert.equal(mac.runs.length, 1);
  });

  test("osascript fails: logged, never thrown; the restore is tried again later", async () => {
    const { mac, duck } = setup({ volume: 60 });
    await duck.duck();
    mac.fail = new Error("osascript died");
    await duck.restore();
    assert.deepEqual(duck.ducked(), { from: 60, to: 12 }, "the note stays for the next try");
    assert.ok(logged("error").some((l) => l.where === "unduck" && l.message === "osascript died"));
    mac.fail = null;
    await duck.restore();
    assert.equal(mac.volume, 60);
  });

  test("a failed duck: nothing to put back", async () => {
    const { mac, duck } = setup({ volume: 60, fail: new Error("nope") });
    await duck.duck();
    mac.fail = null;
    await duck.restore();
    assert.equal(mac.volume, 60);
    assert.equal(duck.ducked(), null);
  });
});

describe("exit and crashes", () => {
  test("on exit: put back before going", async () => {
    const { mac, duck } = setup({ volume: 60 });
    await duck.duck();
    await duck.finish();
    assert.equal(mac.volume, 60);
  });

  test("on exit with a duck still running: waits for it, then puts it back", async () => {
    const { mac, duck } = setup({ volume: 60, delayMs: 20 });
    void duck.duck();
    await duck.finish();
    assert.equal(mac.volume, 60);
  });

  test("on exit, osascript hangs: gives up after the cap", async () => {
    const { duck } = setup({ volume: 60 });
    const hung = new Duck({ enabled: () => true, level: () => 20, run: () => new Promise(() => {}) });
    void hung.duck();
    const started = Date.now();
    await hung.finish(50);
    assert.ok(Date.now() - started < 500);
    await duck.finish(); // nothing down: at once
  });

  const deadPid = () => spawnSync("true").pid!;

  test("a crashed run's note is put back on the next start", async () => {
    const file = "state-crashed.json";
    writeFileSync(file, JSON.stringify({ pid: deadPid(), updatedAt: Date.now(), ducked: { from: 70, to: 14 } }));
    const left = leftoverDuck(file);
    assert.deepEqual(left, { from: 70, to: 14 });
    const { mac, duck } = setup({ volume: 14 });
    await duck.adopt(left!);
    assert.equal(mac.volume, 70);
    assert.equal(logged("unduck").at(-1).leftover, true);
  });

  test("a crashed run's note, but you changed the volume since: left as it is", async () => {
    const { mac, duck } = setup({ volume: 45 });
    await duck.adopt({ from: 70, to: 14 });
    assert.equal(mac.volume, 45);
    assert.equal(duck.ducked(), null);
  });

  test("no note, a clean exit's missing file, or a run that's still going: nothing to put back", () => {
    writeFileSync("state-clean.json", JSON.stringify({ pid: deadPid(), updatedAt: Date.now(), ducked: null }));
    assert.equal(leftoverDuck("state-clean.json"), null);
    assert.equal(leftoverDuck("state-missing.json"), null);
    writeFileSync("state-live.json", JSON.stringify({ pid: process.ppid, ducked: { from: 70, to: 14 } }));
    assert.equal(leftoverDuck("state-live.json"), null, "that run puts its own back");
    writeFileSync("state-junk.json", "{not json");
    assert.equal(leftoverDuck("state-junk.json"), null);
  });
});

// 2026-11-13: a headset keeps one volume for music and one for calls (measured on AirPods: 38 and 20), and the
// reading jumps from one to the other as their mic opens or closes. With the mic held open (mic.swift held) they're
// in the call profile for as long as they're the chosen mic: the jump comes when the hold begins and when it ends,
// not at each press. The duck is told which output the volume it reads is of (the player's: the device, and a
// Bluetooth one's rate) and never reads one profile's volume against a level it left on the other.
describe("across a headset's profiles (the output the volume is read on)", () => {
  const MUSIC = "AirPods@48000";
  const CALLS = "AirPods@24000";
  const SPEAKERS = "MacBook Pro Speakers";

  /** AirPods as the output: the volume read is the one of the profile they're in; `to` switches it (and tells the duck). */
  function headset(volumes: Record<string, number>, at: string, opts: { againMs?: number[] } = {}) {
    const { mac, run } = fakeMac({ volume: volumes[at] });
    let output = at;
    const duck = new Duck({ enabled: () => true, level: () => 20, run, againMs: opts.againMs ?? [], output: () => output });
    /** The output changes, as the player says it: the reading is now the other one's. `tell` false: the duck hasn't heard yet. */
    const to = async (next: string, tell = true) => {
      volumes[output] = mac.volume!;
      output = next;
      mac.volume = volumes[next];
      if (tell) await duck.outputChanged();
    };
    /** The volume of a profile, whichever is read now. */
    const volume = (of: string) => (of === output ? mac.volume : volumes[of]);
    const ops = () => mac.runs.map((r) => r.op);
    return { mac, duck, to, volume, ops };
  }

  test("held, the call profile all along: a press ducks and its release puts it back, as on any output", async () => {
    const { mac, duck, ops } = headset({ [MUSIC]: 38, [CALLS]: 20 }, CALLS);
    await duck.duck();
    assert.equal(mac.volume, 4);
    assert.deepEqual(duck.ducked(), { from: 20, to: 4, on: CALLS });
    await duck.restore();
    assert.equal(mac.volume, 20);
    assert.equal(duck.ducked(), null);
    await duck.duck();
    await duck.restore();
    assert.equal(mac.volume, 20, "press after press");
    assert.deepEqual(ops(), ["lower", "raise", "lower", "raise"]);
  });

  test("the hold begins or ends with nothing lowered: the jump in the reading is nobody's change, and nothing is run for it", async () => {
    const { mac, duck, to, volume, ops } = headset({ [MUSIC]: 38, [CALLS]: 20 }, MUSIC);
    await to(CALLS); // the hold begins: the reading drops 38 → 20
    await duck.beforeSpeech();
    assert.equal(mac.volume, 20);
    await to(MUSIC); // and ends: 20 → 38
    await duck.beforeSpeech();
    assert.deepEqual([volume(MUSIC), volume(CALLS)], [38, 20]);
    assert.deepEqual(ops(), [], "the volume not even read");
  });

  test("a level left on the music profile, then the hold begins and the call volume reads below it: never 'put back' to the music volume", async () => {
    const { mac, duck, to, volume } = headset({ [MUSIC]: 60, [CALLS]: 10 }, MUSIC, { againMs: [10, 10] });
    await duck.duck(); // music: 60 → 12
    await to(CALLS); // the mic opened under the press: the call profile, reading 10
    await duck.restore();
    await wait(60);
    assert.equal(mac.volume, 10, "the call volume isn't ours to raise: not to 60, though it reads below 12");
    assert.deepEqual(duck.ducked(), { from: 60, to: 12, on: MUSIC }, "kept aside for the music profile");
    const up = logged("unduck").at(-1);
    assert.deepEqual([up.restored, up.why, up.on, up.output, up.aside], [false, "output changed", MUSIC, CALLS, true]);
    await duck.beforeSpeech();
    assert.equal(mac.volume, 10, "nor before Kiko speaks");
    // Presses on the call profile duck from its own volume and come back to it.
    await duck.duck();
    assert.equal(mac.volume, 2);
    await duck.restore();
    assert.equal(mac.volume, 10);
    assert.equal(volume(MUSIC), 12, "the music profile's is still where Kiko left it");
    // The hold ends: back on the music profile, still at 12: put back.
    await to(MUSIC);
    assert.equal(mac.volume, 60, "back where it was, on the profile it was lowered on");
    assert.equal(duck.ducked(), null);
    assert.equal(volume(CALLS), 10);
  });

  test("the call volume reads exactly the level left on the music profile: a press doesn't take it for its own, and its release doesn't raise it to the music volume", async () => {
    const { mac, duck, to, volume } = headset({ [MUSIC]: 60, [CALLS]: 12 }, MUSIC);
    await duck.duck(); // music: 60 → 12
    await to(CALLS); // reads 12: the very level left on the other one
    await duck.restore();
    assert.equal(mac.volume, 12, "not raised to 60");
    await duck.duck();
    assert.equal(mac.volume, 2, "lowered from the call volume, as any press");
    assert.equal(logged("duck").at(-1).kept, undefined, "not 'ours already'");
    await duck.restore();
    assert.equal(mac.volume, 12, "and back to the call volume, not to 60");
    await to(MUSIC);
    assert.equal(volume(MUSIC), 60, "the music profile's comes back when it does");
  });

  test("lowered on the call profile, then the hold ends under the press: the music volume isn't touched; back in the call profile it's put back", async () => {
    const { mac, duck, to, volume } = headset({ [MUSIC]: 3, [CALLS]: 20 }, CALLS, { againMs: [10] });
    await duck.duck(); // calls: 20 → 4
    await to(MUSIC); // reads 3, below what was left on the call profile
    await duck.restore();
    await duck.beforeSpeech();
    await wait(40);
    assert.equal(mac.volume, 3, "yours, on another profile: left alone");
    assert.deepEqual(duck.ducked(), { from: 20, to: 4, on: CALLS });
    await to(CALLS);
    assert.equal(mac.volume, 20);
    assert.equal(volume(MUSIC), 3);
  });

  test("back on its output but you changed the volume there meanwhile: left as yours", async () => {
    const { mac, duck, to } = headset({ [MUSIC]: 60, [CALLS]: 20 }, MUSIC, { againMs: [] });
    await duck.duck();
    await to(CALLS);
    await duck.restore();
    await to(MUSIC, false);
    mac.volume = 30; // changed by hand on the music profile
    await duck.outputChanged();
    assert.equal(mac.volume, 30);
  });

  test("another device altogether: a headset's note is never read against the speakers' volume", async () => {
    const { mac, duck, to, volume } = headset({ [MUSIC]: 60, [SPEAKERS]: 12 }, MUSIC);
    await duck.duck(); // AirPods: 60 → 12
    await to(SPEAKERS); // they went back in their case: the speakers, at 12 as it happens
    await duck.restore();
    await duck.beforeSpeech();
    assert.equal(mac.volume, 12, "the speakers aren't raised to the AirPods' 60");
    await duck.duck();
    assert.equal(mac.volume, 2, "a press there lowers from the speakers' own");
    await duck.restore();
    assert.equal(mac.volume, 12);
    await to(MUSIC);
    assert.equal(volume(MUSIC), 60, "the AirPods' comes back when they do");
  });

  test("the duck hears of the change late (the volume read before the player said): the note waits, then is put back", async () => {
    const { mac, duck, to } = headset({ [MUSIC]: 60, [CALLS]: 20 }, MUSIC, { againMs: [60_000] });
    await duck.duck();
    await to(CALLS, false); // the reading changed, not said yet
    await duck.restore(); // reads 20, not 12: changed; a look again in a minute
    assert.equal(mac.volume, 20);
    await duck.outputChanged(); // now said: not this output's, set aside without another look
    assert.deepEqual(duck.ducked(), { from: 60, to: 12, on: MUSIC });
    await to(MUSIC);
    assert.equal(mac.volume, 60);
  });

  test("on exit on another profile: not touched, and the note goes to the state file with its output", async () => {
    const { mac, duck, to } = headset({ [MUSIC]: 60, [CALLS]: 12 }, MUSIC);
    await duck.duck();
    await to(CALLS); // reads 12 by chance
    await duck.restore();
    await duck.finish();
    assert.equal(mac.volume, 12, "not raised on the way out");
    assert.deepEqual(duck.ducked(), { from: 60, to: 12, on: MUSIC });
    writeFileSync("state-profile.json", JSON.stringify({ pid: spawnSync("true").pid, ducked: duck.ducked() }));
    assert.deepEqual(leftoverDuck("state-profile.json"), { from: 60, to: 12, on: MUSIC });
  });

  test("a crashed run's note from another profile: kept for it, put back once it's the output again", async () => {
    const { mac, duck, to, ops } = headset({ [MUSIC]: 12, [CALLS]: 12 }, CALLS);
    await duck.adopt({ from: 60, to: 12, on: MUSIC }); // the hold began at this start: the call profile, at 12 too
    assert.equal(mac.volume, 12, "not this profile's");
    assert.deepEqual(ops(), []);
    await to(MUSIC);
    assert.equal(mac.volume, 60);
  });

  test("the output not known (the player hasn't said, or a note from before): by the volume alone, as before", async () => {
    const { mac, run } = fakeMac({ volume: 60 });
    let output: string | null = null;
    const duck = new Duck({ enabled: () => true, level: () => 20, run, againMs: [], output: () => output });
    await duck.duck();
    assert.deepEqual(duck.ducked(), { from: 60, to: 12 });
    output = MUSIC;
    await duck.restore();
    assert.equal(mac.volume, 60);
    await duck.adopt({ from: 70, to: 60 }); // a note with no output said
    assert.equal(mac.volume, 70);
  });
});
