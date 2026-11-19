// Which device the mic helper opens (native/macos/mic.swift choose): the mic you chose if it's there, else the
// system default, whatever macOS has (2026-11-14: a Bluetooth default is used as it is; from 2026-11-12 until then
// the built-in mic stood in for it). The same cases go through the helper (built into
// this test's own folder, as the app builds it, and run as `mic --choose`: it asks Core Audio nothing and
// never opens a mic) and through src/core/mic-device.ts resolveMic, which mirrors it for the settings and the log.
// And when the helper sets its device up anew rather than reusing the last press's (mic.swift fresh, 2026-11-13,
// run as `mic --fresh`): only for its own device changing, never for others' (AirPods switching profile).
// And which mic it holds open between presses (mic.swift held, 2026-11-13, in `--choose`'s answer as "hold";
// mic-device.ts heldMic mirrors it): the mic in use while it's a Bluetooth one, chosen or the system default
// (2026-11-14), and no other. And what counts as
// a press's first sound (mic.swift Press, run as `mic --started`): for a Bluetooth mic, the first buffer that
// isn't all exact zeros (zeros mean its call link isn't up yet), the zeros before it never sent on.
import "../../../setup.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { heldMic, micChoice, resolveMic, type MicChoice, type MicDevice } from "../../../../src/core/mic-device.ts";
import { buildNative } from "../../../../src/platform/macos/native.ts";

const can = process.platform === "darwin" && spawnSync("swiftc", ["--version"]).status === 0;
const dir = mkdtempSync(join(tmpdir(), "mic-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const AIRPODS: MicDevice = { uid: "18-3F-70-00-00-01:input", name: "AirPods", isDefault: false, transport: "bluetooth" };
const BUILT_IN: MicDevice = { uid: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", isDefault: false, transport: "built-in" };
const USB_MIC: MicDevice = { uid: "AppleUSBAudioEngine:Example Inc:Example Mic:1000000:2,1", name: "USB Mic", isDefault: false, transport: "usb" };
const def = (devices: MicDevice[], uid: string) => devices.map((d) => ({ ...d, isDefault: d.uid === uid }));

/** `hold`: the mic held open between presses (its UID); absent: none. */
type Case = { name: string; devices: MicDevice[]; wanted: MicChoice; uid: string; fallback: boolean; hold?: string };
const CASES: Case[] = [
  // 2026-11-14: the default is whatever macOS has as its default.
  {
    name: "default Bluetooth, a built-in mic there: the Bluetooth one, as macOS has it, held open",
    devices: def([AIRPODS, BUILT_IN], AIRPODS.uid),
    wanted: null,
    uid: AIRPODS.uid,
    fallback: false,
    hold: AIRPODS.uid,
  },
  { name: "a Bluetooth mic chosen: it, held open", devices: def([AIRPODS, BUILT_IN], AIRPODS.uid), wanted: micChoice(AIRPODS.uid, AIRPODS.name), uid: AIRPODS.uid, fallback: false, hold: AIRPODS.uid },
  {
    name: "a Bluetooth mic chosen, not the default: still it, held open",
    devices: def([AIRPODS, BUILT_IN], BUILT_IN.uid),
    wanted: micChoice(AIRPODS.uid, AIRPODS.name),
    uid: AIRPODS.uid,
    fallback: false,
    hold: AIRPODS.uid,
  },
  {
    name: "a Bluetooth mic chosen, found by name (its UID changed): held open",
    devices: def([{ ...AIRPODS, uid: "18-3F-70-00-00-02:input" }, BUILT_IN], BUILT_IN.uid),
    wanted: micChoice(AIRPODS.uid, AIRPODS.name),
    uid: "18-3F-70-00-00-02:input",
    fallback: false,
    hold: "18-3F-70-00-00-02:input",
  },
  {
    name: "a Bluetooth mic chosen, away (in its case, with the iPhone): the system default, nothing held",
    devices: def([USB_MIC, BUILT_IN], USB_MIC.uid),
    wanted: micChoice(AIRPODS.uid, AIRPODS.name),
    uid: USB_MIC.uid,
    fallback: true,
  },
  {
    name: "a Bluetooth mic chosen, away, another Bluetooth one the default: the default, held open while it stands in",
    devices: def([{ ...AIRPODS, uid: "bt-other:input", name: "Jabra Elite" }, BUILT_IN], "bt-other:input"),
    wanted: micChoice(AIRPODS.uid, AIRPODS.name),
    uid: "bt-other:input",
    fallback: true,
    hold: "bt-other:input",
  },
  {
    name: "a USB mic chosen, AirPods the default: it, nothing held",
    devices: def([AIRPODS, USB_MIC, BUILT_IN], AIRPODS.uid),
    wanted: micChoice(USB_MIC.uid, USB_MIC.name),
    uid: USB_MIC.uid,
    fallback: false,
  },
  {
    name: "the built-in mic chosen, AirPods the default: it, nothing held (full-quality sound on the AirPods)",
    devices: def([AIRPODS, BUILT_IN], AIRPODS.uid),
    wanted: micChoice(BUILT_IN.uid, BUILT_IN.name),
    uid: BUILT_IN.uid,
    fallback: false,
  },
  {
    name: "default Bluetooth, no built-in mic (a Mac mini, a closed lid): the Bluetooth one, held open",
    devices: def([AIRPODS, USB_MIC], AIRPODS.uid),
    wanted: null,
    uid: AIRPODS.uid,
    fallback: false,
    hold: AIRPODS.uid,
  },
  { name: "default built-in, AirPods connected: the built-in one, nothing held", devices: def([AIRPODS, BUILT_IN], BUILT_IN.uid), wanted: null, uid: BUILT_IN.uid, fallback: false },
  { name: "default USB: it, Bluetooth or not around", devices: def([AIRPODS, USB_MIC, BUILT_IN], USB_MIC.uid), wanted: null, uid: USB_MIC.uid, fallback: false },
  {
    name: "the chosen mic away, the default Bluetooth: the default stands in, held open",
    devices: def([AIRPODS, BUILT_IN], AIRPODS.uid),
    wanted: micChoice(USB_MIC.uid, USB_MIC.name),
    uid: AIRPODS.uid,
    fallback: true,
    hold: AIRPODS.uid,
  },
  {
    name: "the chosen mic found by name (its UID changed)",
    devices: def([AIRPODS, { ...USB_MIC, uid: "usb-2" }, BUILT_IN], AIRPODS.uid),
    wanted: micChoice(USB_MIC.uid, USB_MIC.name),
    uid: "usb-2",
    fallback: false,
  },
  {
    name: "no transport said (a helper before 2026-11-12): the default, nothing held",
    devices: def(
      [
        { ...AIRPODS, transport: undefined },
        { ...BUILT_IN, transport: undefined },
      ],
      AIRPODS.uid,
    ),
    wanted: null,
    uid: AIRPODS.uid,
    fallback: false,
  },
  { name: "no devices at all", devices: [], wanted: null, uid: "", fallback: false },
];

describe("the mic's device, in the app (mic-device.ts resolveMic)", () => {
  for (const c of CASES)
    test(c.name, () => {
      const inUse = resolveMic(c.wanted, c.devices);
      assert.deepEqual({ uid: inUse.device?.uid ?? "", fallback: inUse.fallback }, { uid: c.uid, fallback: c.fallback });
      assert.equal(heldMic(c.wanted, c.devices)?.uid, c.hold, "held open, or not (heldMic)");
    });
});

describe("the mic's device, in the helper (mic.swift choose)", { skip: !can && "needs macOS and swiftc" }, () => {
  let helper = "";
  before(() => {
    helper = buildNative("mic", { into: join(dir, "bin") });
  });
  for (const c of CASES)
    test(c.name, () => {
      const given = JSON.stringify({ devices: c.devices, wanted: c.wanted });
      const out = JSON.parse(execFileSync(helper, ["--choose", given], { encoding: "utf8", timeout: 10_000 }));
      assert.deepEqual(out, { uid: c.uid, fallback: c.fallback, hold: c.hold ?? null });
    });
});

// 2026-11-13: a Bluetooth mic that's listed but gave no link (out of your ears, or with the iPhone, which leaves it
// listed): the helper gives up on it and it counts as away. 2026-11-14: the same for a Bluetooth system default,
// and what stands in is a mic that works: the system default if that's another device, else the built-in mic.
// The app is told which one by the hold's lines (mic-device.ts noLinkAfter), and resolveMic decides the same way.
const AWAY: Case[] = [
  {
    name: "the chosen AirPods listed but giving no link, the default too: the built-in mic stands in, nothing held",
    devices: def([AIRPODS, BUILT_IN], AIRPODS.uid),
    wanted: micChoice(AIRPODS.uid, AIRPODS.name),
    uid: BUILT_IN.uid,
    fallback: true,
  },
  {
    name: "the chosen AirPods listed but giving no link, macOS moved its default to the built-in mic: it, nothing held",
    devices: def([AIRPODS, BUILT_IN], BUILT_IN.uid),
    wanted: micChoice(AIRPODS.uid, AIRPODS.name),
    uid: BUILT_IN.uid,
    fallback: true,
  },
  { name: "giving no link, a USB mic the default: it", devices: def([AIRPODS, USB_MIC, BUILT_IN], USB_MIC.uid), wanted: micChoice(AIRPODS.uid, AIRPODS.name), uid: USB_MIC.uid, fallback: true },
  {
    name: "nothing chosen, the default AirPods giving no link: the built-in mic stands in, nothing held",
    devices: def([AIRPODS, USB_MIC, BUILT_IN], AIRPODS.uid),
    wanted: null,
    uid: BUILT_IN.uid,
    fallback: false,
  },
  {
    name: "nothing chosen, the default AirPods giving no link, no built-in mic: the AirPods all the same, not held",
    devices: def([AIRPODS, USB_MIC], AIRPODS.uid),
    wanted: null,
    uid: AIRPODS.uid,
    fallback: false,
  },
  {
    name: "a USB mic chosen and away, the default AirPods giving no link: the built-in mic stands in",
    devices: def([AIRPODS, BUILT_IN], AIRPODS.uid),
    wanted: micChoice(USB_MIC.uid, USB_MIC.name),
    uid: BUILT_IN.uid,
    fallback: true,
  },
];
/** The mic that gave no link in an AWAY case: the one that would be used. */
const awayIn = (c: Case) => resolveMic(c.wanted, c.devices).device?.uid;

describe("a mic that gave no link, in the app (mic-device.ts resolveMic and heldMic, away)", () => {
  for (const c of AWAY)
    test(c.name, () => {
      const inUse = resolveMic(c.wanted, c.devices, awayIn(c));
      assert.deepEqual({ uid: inUse.device?.uid ?? "", fallback: inUse.fallback, noLink: inUse.noLink }, { uid: c.uid, fallback: c.fallback, noLink: c.uid === awayIn(c) ? undefined : true });
      assert.equal(heldMic(c.wanted, c.devices, awayIn(c)), null, "never held");
    });
});

describe("a mic that gave no link, in the helper (mic.swift choose and held, away)", { skip: !can && "needs macOS and swiftc" }, () => {
  let helper = "";
  before(() => {
    helper = buildNative("mic", { into: join(dir, "bin") });
  });
  for (const c of AWAY)
    test(c.name, () => {
      const given = JSON.stringify({ devices: c.devices, wanted: c.wanted, away: true });
      const out = JSON.parse(execFileSync(helper, ["--choose", given], { encoding: "utf8", timeout: 10_000 }));
      assert.deepEqual(out, { uid: c.uid, fallback: c.fallback, hold: null });
    });
});

// What's done about a held mic whose link isn't up (mic.swift linkStep), and whether a press waits for it (pressWaits).
const LINK: Array<{ name: string; given: { waitedMs: number; kicked?: boolean; lost?: boolean; retry?: boolean }; step: string; pressWaits: boolean }> = [
  { name: "just chosen or connected, its link coming up: waited for, and a press waits with it ('connecting…')", given: { waitedMs: 300 }, step: "wait", pressWaits: true },
  { name: "a slow link (3 s was the slowest measured): still waited for", given: { waitedMs: 3100 }, step: "wait", pressWaits: true },
  { name: "nothing after 5 s: asked for once more", given: { waitedMs: 5000 }, step: "kick", pressWaits: true },
  { name: "asked again, waiting again", given: { waitedMs: 2000, kicked: true }, step: "wait", pressWaits: true },
  { name: "nothing after that either: given up on (the mic counts as away)", given: { waitedMs: 5200, kicked: true }, step: "give up", pressWaits: true },
  { name: "its link was up and went (silent, stalled): a press doesn't wait for it", given: { waitedMs: 800, lost: true }, step: "wait", pressWaits: false },
  { name: "tried again after it gave no link: a press doesn't wait for it", given: { waitedMs: 800, retry: true }, step: "wait", pressWaits: false },
];

describe("a held mic whose link isn't up, in the helper (mic.swift linkStep, pressWaits)", { skip: !can && "needs macOS and swiftc" }, () => {
  let helper = "";
  before(() => {
    helper = buildNative("mic", { into: join(dir, "bin") });
  });
  for (const c of LINK)
    test(c.name, () => {
      const out = JSON.parse(execFileSync(helper, ["--link", JSON.stringify(c.given)], { encoding: "utf8", timeout: 10_000 }));
      assert.deepEqual([out.step, out.pressWaits], [c.step, c.pressWaits]);
    });
  test("given up on, it's tried again no sooner than 30 s later, twice that each time in a row (to 8 min): never a loop", () => {
    const after = (gaveUps: number) => JSON.parse(execFileSync(helper, ["--link", JSON.stringify({ gaveUps })], { encoding: "utf8", timeout: 10_000 })).retryAfterMs;
    assert.deepEqual([1, 2, 3, 4, 5, 6, 20].map(after), [30_000, 60_000, 120_000, 240_000, 480_000, 480_000, 480_000]);
  });
});

// What a mic's unit gives, buffer by buffer: Z is all exact zeros (a Bluetooth link not up yet), S has sound.
const Z = [0, 0, 0, 0];
const S = [0, 0.01, -0.02, 0];
const STARTED: Array<{ name: string; waits: boolean; buffers: number[][]; started: number | null; sent: number[] }> = [
  { name: "a Bluetooth mic, its link up (held open): started at the first buffer", waits: true, buffers: [S, S, S], started: 0, sent: [0, 1, 2] },
  { name: "a Bluetooth mic, its link not up yet: zeros aren't a start and aren't sent; started at the first sound", waits: true, buffers: [Z, Z, Z, S, S], started: 3, sent: [3, 4] },
  { name: "a Bluetooth mic that never gives sound: never started, nothing sent", waits: true, buffers: [Z, Z, Z, Z], started: null, sent: [] },
  { name: "one sample that isn't zero is sound", waits: true, buffers: [Z, [0, 0, 0.00003, 0], Z], started: 1, sent: [1, 2] },
  { name: "once started, silence is sent on like anything else", waits: true, buffers: [S, Z, Z, S], started: 0, sent: [0, 1, 2, 3] },
  { name: "any other mic: started at its first buffer, zeros or not (one muted at its own switch isn't 'connecting')", waits: false, buffers: [Z, Z, S], started: 0, sent: [0, 1, 2] },
  { name: "no buffers at all: not started", waits: false, buffers: [], started: null, sent: [] },
];

describe("a press's first sound, in the helper (mic.swift Press)", { skip: !can && "needs macOS and swiftc" }, () => {
  let helper = "";
  before(() => {
    helper = buildNative("mic", { into: join(dir, "bin") });
  });
  for (const c of STARTED)
    test(c.name, () => {
      const out = JSON.parse(execFileSync(helper, ["--started", JSON.stringify({ waits: c.waits, buffers: c.buffers })], { encoding: "utf8", timeout: 10_000 }));
      assert.deepEqual(out, { started: c.started, sent: c.sent });
    });
});

type Fresh = { device: number; rate: number; channels: number };
const BUILT_IN_48K: Fresh = { device: 7, rate: 48000, channels: 1 };
const FRESH: Array<{ name: string; had: Fresh | null; now: Fresh; fresh: string | null }> = [
  { name: "nothing set up yet: set up", had: null, now: BUILT_IN_48K, fresh: "first" },
  { name: "the same device, as it was: kept warm", had: BUILT_IN_48K, now: { ...BUILT_IN_48K }, fresh: null },
  { name: "another device: set up for it", had: BUILT_IN_48K, now: { ...BUILT_IN_48K, device: 9 }, fresh: "device" },
  { name: "its rate changed (another app set it): set up again", had: BUILT_IN_48K, now: { ...BUILT_IN_48K, rate: 44100 }, fresh: "format" },
  { name: "its channels changed: set up again", had: BUILT_IN_48K, now: { ...BUILT_IN_48K, channels: 2 }, fresh: "format" },
];

describe("the mic's warm setup, in the helper (mic.swift fresh)", { skip: !can && "needs macOS and swiftc" }, () => {
  let helper = "";
  before(() => {
    helper = buildNative("mic", { into: join(dir, "bin") });
  });
  for (const c of FRESH)
    test(c.name, () => {
      const out = JSON.parse(execFileSync(helper, ["--fresh", JSON.stringify({ had: c.had, now: c.now })], { encoding: "utf8", timeout: 10_000 }));
      assert.deepEqual(out, { fresh: c.fresh });
    });
});
