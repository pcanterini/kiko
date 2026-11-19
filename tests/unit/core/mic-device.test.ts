// Which microphone to use (src/core/mic-device.ts): the chosen device by UID, else by name (a USB mic's UID
// changes with the port), else the system default as a fallback, said once when it goes and once when
// it's back; never said for a Bluetooth mic, which comes and goes (2026-11-14). The device lists are the
// shapes native/macos/mic.swift prints; nothing opens a mic.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  bluetoothChoice,
  fallbackNote,
  findMic,
  heldMic,
  micChoice,
  micChoices,
  micHeader,
  micSetting,
  micValue,
  MicWatch,
  noLinkAfter,
  notStartedLine,
  parseDevices,
  parseHold,
  parseHoldLost,
  parseUsing,
  resolveMic,
  type MicDevice,
} from "../../../src/core/mic-device.ts";

const USB_MIC: MicDevice = { uid: "AppleUSBAudioEngine:Example Inc:Example Mic:1000000:2,1", name: "USB Mic", isDefault: true };
const BUILT_IN: MicDevice = { uid: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", isDefault: false };
const IPHONE: MicDevice = { uid: "00000000-0000-4000-8000-000000000003", name: "iPhone Microphone", isDefault: false };
const ALL = [IPHONE, USB_MIC, BUILT_IN];
/** The same devices after macOS made the iPhone the default (Continuity). */
const IPHONE_DEFAULT = ALL.map((d) => ({ ...d, isDefault: d === IPHONE }));
/** The USB mic unplugged: macOS moved the default to the built-in mic. */
const UNPLUGGED = [IPHONE, { ...BUILT_IN, isDefault: true }];
const usbMic = micChoice(USB_MIC.uid, USB_MIC.name);

describe("choosing the mic", () => {
  test("nothing chosen: the system default, whatever it is now", () => {
    assert.deepEqual(resolveMic(null, ALL), { device: USB_MIC, fallback: false, wanted: null });
    assert.equal(resolveMic(null, IPHONE_DEFAULT).device?.uid, IPHONE.uid, "follows macOS, iPhone included");
  });

  test("a chosen mic is used even when macOS moved the default elsewhere", () => {
    assert.deepEqual(resolveMic(usbMic, IPHONE_DEFAULT), { device: IPHONE_DEFAULT[1], fallback: false, wanted: usbMic });
  });

  test("found by name when its UID changed (another USB port)", () => {
    const moved = [IPHONE, { ...USB_MIC, uid: "AppleUSBAudioEngine:Example Inc:Example Mic:20000000:2,1" }, BUILT_IN];
    assert.equal(resolveMic(usbMic, moved).device?.uid, moved[1].uid);
    assert.equal(resolveMic(usbMic, moved).fallback, false);
  });

  test("KIKO_MIC can be a name: it matches as either", () => {
    assert.equal(findMic(micChoice("MacBook Pro Microphone"), ALL), BUILT_IN);
    assert.equal(findMic(micChoice("BuiltInMicrophoneDevice"), ALL), BUILT_IN);
    assert.equal(micChoice(""), null, "empty is the system default");
    assert.equal(micChoice(undefined), null);
  });

  test("an empty name never matches a device by name", () => {
    assert.equal(findMic({ uid: "gone", name: "" }, [{ uid: "x", name: "", isDefault: true }]), null);
  });
});

describe("the chosen mic unplugged", () => {
  test("falls back to the system default, and says which and why", () => {
    const inUse = resolveMic(usbMic, UNPLUGGED);
    assert.deepEqual(inUse, { device: UNPLUGGED[1], fallback: true, wanted: usbMic });
    assert.equal(fallbackNote(inUse), "USB Mic isn't connected: using MacBook Pro Microphone, the system default, until it's back");
    assert.equal(micValue(inUse), "USB Mic (not connected)");
    assert.deepEqual(micHeader(inUse), { text: "🎙 MacBook Pro Microphone (USB Mic missing)", warn: true });
  });

  test("no mic at all: said, not silent", () => {
    const inUse = resolveMic(usbMic, []);
    assert.equal(inUse.device, null);
    assert.equal(fallbackNote(inUse), "USB Mic isn't connected: and there's no other mic");
    assert.deepEqual(micHeader(resolveMic(null, [])), { text: "🎙 no mic", warn: true });
  });

  test("the system default never falls back", () => {
    assert.equal(fallbackNote(resolveMic(null, UNPLUGGED)), null);
  });

  test("said once when it goes, once when it's back, and again if it goes again", () => {
    const watch = new MicWatch();
    assert.equal(watch.update(resolveMic(usbMic, ALL)), null);
    assert.equal(watch.update(resolveMic(usbMic, UNPLUGGED)), "fallback");
    assert.equal(watch.update(resolveMic(usbMic, UNPLUGGED)), null, "not again while it's away");
    assert.equal(watch.update(resolveMic(usbMic, [...UNPLUGGED, BUILT_IN])), null);
    assert.equal(watch.update(resolveMic(usbMic, ALL)), "back");
    assert.equal(watch.update(resolveMic(usbMic, ALL)), null);
    assert.equal(watch.update(resolveMic(usbMic, UNPLUGGED)), "fallback");
  });

  test("choosing another mic (or the default) while one is away isn't 'back'", () => {
    const watch = new MicWatch();
    watch.update(resolveMic(usbMic, UNPLUGGED));
    assert.equal(watch.update(resolveMic(null, UNPLUGGED)), null);
    assert.equal(watch.update(resolveMic(usbMic, UNPLUGGED)), "fallback", "chosen again while away: said again");
    assert.equal(watch.update(resolveMic(micChoice(IPHONE.uid, IPHONE.name), UNPLUGGED)), null);
  });

  test("a chosen mic missing from the start is said at once", () => {
    assert.equal(new MicWatch().update(resolveMic(usbMic, UNPLUGGED)), "fallback");
  });
});

describe("the setting", () => {
  test("the system default first, naming it, then every input device", () => {
    assert.deepEqual(
      micChoices(ALL, null).map((c) => [c.value, c.label]),
      [
        ["", "System default (USB Mic)"],
        [IPHONE.uid, "iPhone Microphone"],
        [USB_MIC.uid, "USB Mic"],
        [BUILT_IN.uid, "MacBook Pro Microphone"],
      ],
    );
  });

  test("the chosen mic stays listed while it's away, marked", () => {
    const options = micChoices(UNPLUGGED, usbMic);
    assert.deepEqual(options.at(-1), { value: USB_MIC.uid, label: "USB Mic", hint: "not connected" });
    assert.equal(options[0].label, "System default (MacBook Pro Microphone)");
  });

  test("its value: the default names what it is now", () => {
    assert.equal(micValue(resolveMic(null, IPHONE_DEFAULT)), "System default (iPhone Microphone)");
    assert.equal(micValue(resolveMic(usbMic, ALL)), "USB Mic");
    assert.deepEqual(micHeader(resolveMic(usbMic, ALL)), { text: "🎙 USB Mic", warn: false });
  });
});

// AirPods the system default (2026-11-14: used as macOS has them, and held open; from 2026-11-12 until then the
// built-in mic stood in). Which device is opened is tested case by case, here and in the helper itself, in
// tests/unit/platform/macos/mic-choose.test.ts; this is how the setting and the lines say it.
const AIRPODS: MicDevice = { uid: "18-3F-70-00-00-01:input", name: "AirPods", isDefault: true, transport: "bluetooth" };
const MAC: MicDevice = { ...BUILT_IN, transport: "built-in" };
const ON_AIRPODS = [AIRPODS, MAC];
/** The AirPods in their case: gone from the list, and macOS's default back on the Mac's own mic. */
const IN_CASE = [{ ...MAC, isDefault: true }];
const airpods = micChoice(AIRPODS.uid, AIRPODS.name);

describe("a Bluetooth system default", () => {
  test("it's the mic in use, as macOS has it, and the setting says its mic stays on", () => {
    assert.deepEqual(resolveMic(null, ON_AIRPODS), { device: AIRPODS, fallback: false, wanted: null });
    const options = micChoices(ON_AIRPODS, null);
    assert.deepEqual(options[0], { value: "", label: "System default (AirPods, mic stays on)", hint: "follows what macOS uses" });
    assert.equal(micValue(resolveMic(null, ON_AIRPODS)), "System default (AirPods, mic stays on)");
    assert.equal(micChoices([{ ...AIRPODS, name: "Jabra Elite 85t" }, MAC], null)[0].label, "System default (Jabra Elite 85t, mic stays on)");
    assert.deepEqual(micHeader(resolveMic(null, ON_AIRPODS)), { text: "🎙 AirPods", warn: false });
    assert.equal(heldMic(null, ON_AIRPODS), AIRPODS, "held open while it's the default");
  });

  test("macOS moves its default elsewhere (the AirPods go, or leave your ears): followed, nothing held, nothing to say", () => {
    for (const devices of [
      IN_CASE,
      [
        { ...AIRPODS, isDefault: false },
        { ...MAC, isDefault: true },
      ],
    ]) {
      const inUse = resolveMic(null, devices);
      assert.deepEqual([inUse.device?.name, inUse.fallback], ["MacBook Pro Microphone", false]);
      assert.equal(micValue(inUse), "System default (MacBook Pro Microphone)");
      assert.equal(fallbackNote(inUse), null);
      assert.deepEqual(micHeader(inUse), { text: "🎙 MacBook Pro Microphone", warn: false });
      assert.equal(heldMic(null, devices), null);
      assert.equal(new MicWatch().update(inUse), null, "the system default is never 'missing'");
    }
  });

  test("listed still, but it gave no link: the built-in mic stands in, said nowhere", () => {
    const inUse = resolveMic(null, ON_AIRPODS, AIRPODS.uid);
    assert.deepEqual(inUse, { device: MAC, fallback: false, wanted: null, noLink: true });
    assert.equal(micValue(inUse), "System default (MacBook Pro Microphone)");
    assert.equal(fallbackNote(inUse), null);
    assert.deepEqual(micHeader(inUse), { text: "🎙 MacBook Pro Microphone", warn: false });
    assert.equal(heldMic(null, ON_AIRPODS, AIRPODS.uid), null, "not held open for nothing");
    assert.equal(resolveMic(null, [AIRPODS], AIRPODS.uid).device, AIRPODS, "no other mic: the AirPods all the same");
  });

  test("the choices: each Bluetooth mic says what using it does, and the Mac's own mic is there to pick instead", () => {
    assert.deepEqual(
      micChoices(ON_AIRPODS, null).map((o) => o.label),
      ["System default (AirPods, mic stays on)", "AirPods (mic stays on: instant, call-quality sound)", "MacBook Pro Microphone"],
    );
    const own = micChoice(MAC.uid, MAC.name);
    assert.deepEqual([resolveMic(own, ON_AIRPODS).device, heldMic(own, ON_AIRPODS)], [MAC, null], "picked: full-quality sound on the AirPods, nothing held");
    assert.equal(micValue(resolveMic(own, ON_AIRPODS)), "MacBook Pro Microphone");
  });

  test("a wired mic you chose, unplugged, the AirPods the default: they stand in (held), and it's still said", () => {
    const inUse = resolveMic(usbMic, ON_AIRPODS);
    assert.deepEqual([inUse.device, inUse.fallback, inUse.bluetooth], [AIRPODS, true, undefined]);
    assert.equal(fallbackNote(inUse), "USB Mic isn't connected: using AirPods, the system default, until it's back");
    assert.equal(micValue(inUse), "USB Mic (not connected)");
    assert.equal(heldMic(usbMic, ON_AIRPODS), AIRPODS);
    // The AirPods giving no link then: the built-in mic, not called the default.
    assert.equal(fallbackNote(resolveMic(usbMic, ON_AIRPODS, AIRPODS.uid)), "USB Mic isn't connected: using MacBook Pro Microphone until it's back");
  });
});

// 2026-11-13: a Bluetooth mic you chose is held open while it's connected (mic.swift held), so a press starts at once.
// 2026-11-14: taking the AirPods out showed them as missing. They aren't expected to be connected: when they are,
// it just works, seamlessly, and nothing says they're missing when they aren't.
describe("a Bluetooth mic you chose", () => {
  test("connected: used and held open, and the setting says its mic stays on", () => {
    const options = micChoices(ON_AIRPODS, null);
    assert.equal(micValue(resolveMic(airpods, ON_AIRPODS)), "AirPods (mic stays on)");
    assert.deepEqual(resolveMic(airpods, ON_AIRPODS), { device: AIRPODS, fallback: false, wanted: airpods, bluetooth: true });
    assert.equal(heldMic(airpods, ON_AIRPODS), AIRPODS);
    assert.deepEqual(micSetting(AIRPODS.uid, ON_AIRPODS, options[1].label), { mic: AIRPODS.uid, micName: "AirPods" }, "saved by its name, not the option's words");
    assert.equal(heldMic(micChoice("bt-old:input", "AirPods"), ON_AIRPODS), AIRPODS, "found by name");
    assert.equal(heldMic(airpods, [{ ...AIRPODS, transport: undefined }, MAC]), null, "how it's connected not said (an old helper): not held");
  });

  test("away (in their case): the system default stands in, with no notice, no 'missing', no 'not connected'", () => {
    const inUse = resolveMic(airpods, IN_CASE);
    assert.deepEqual(inUse, { device: IN_CASE[0], fallback: true, wanted: airpods, bluetooth: true });
    assert.equal(fallbackNote(inUse), null, "nothing to show or say");
    assert.deepEqual(micHeader(inUse), { text: "🎙 MacBook Pro Microphone", warn: false }, "the header names the mic in use, not in yellow");
    assert.equal(micValue(inUse), "AirPods when connected (MacBook Pro Microphone now)");
    assert.equal(heldMic(airpods, IN_CASE), null, "nothing to hold");
    assert.deepEqual(micChoices(IN_CASE, airpods).at(-1), { value: AIRPODS.uid, label: "AirPods", hint: "used when connected" }, "still listed, to see it's the one picked");
    assert.equal(micValue(resolveMic(airpods, [])), "AirPods when connected (no mic now)");
    assert.doesNotMatch([micValue(inUse), micHeader(inUse).text, micChoices(IN_CASE, airpods).at(-1)?.hint].join(" "), /missing|not connected|isn't/);
  });

  test("it's still told apart, for the log: gone and back once each, at the start too", () => {
    const watch = new MicWatch();
    assert.equal(watch.update(resolveMic(airpods, IN_CASE)), "fallback", "away from the start");
    assert.equal(watch.update(resolveMic(airpods, ON_AIRPODS)), "back");
    assert.equal(watch.update(resolveMic(airpods, IN_CASE)), "fallback");
    assert.equal(watch.update(resolveMic(airpods, IN_CASE)), null);
  });

  test("listed still, but it gave no link (out of your ears, with the iPhone): as away", () => {
    // The default too (as macOS has it while they're connected): the built-in mic. Moved to the Mac's mic: it.
    for (const devices of [
      ON_AIRPODS,
      [
        { ...AIRPODS, isDefault: false },
        { ...MAC, isDefault: true },
      ],
    ]) {
      const inUse = resolveMic(airpods, devices, AIRPODS.uid);
      assert.deepEqual([inUse.device?.name, inUse.fallback, inUse.bluetooth, inUse.noLink], ["MacBook Pro Microphone", true, true, true]);
      assert.equal(fallbackNote(inUse), null);
      assert.equal(micValue(inUse), "AirPods when connected (MacBook Pro Microphone now)");
      assert.deepEqual(micHeader(inUse), { text: "🎙 MacBook Pro Microphone", warn: false });
      assert.equal(heldMic(airpods, devices, AIRPODS.uid), null);
    }
  });

  test("known for a Bluetooth one while it's away: by its UID (an address), or seen as one in this run", () => {
    assert.equal(bluetoothChoice(airpods, IN_CASE), true, "18-3F-70-00-00-01:input");
    assert.equal(bluetoothChoice(micChoice("AC-DE-48-00-11-22:input", "Buds"), []), true);
    assert.equal(bluetoothChoice(usbMic, UNPLUGGED), false, "a USB mic");
    assert.equal(bluetoothChoice(micChoice(IPHONE.uid, IPHONE.name), []), false, "the iPhone's mic (Continuity): said when it's out of reach");
    assert.equal(bluetoothChoice(micChoice(BUILT_IN.uid, BUILT_IN.name), ON_AIRPODS), false);
    assert.equal(bluetoothChoice(null, ON_AIRPODS), false, "the system default is no choice");
    // KIKO_MIC by name: nothing in it says Bluetooth until it's been seen listed.
    const byName = micChoice("Jabra Elite 85t");
    assert.equal(bluetoothChoice(byName, IN_CASE), false);
    assert.equal(fallbackNote(resolveMic(byName, IN_CASE)), "Jabra Elite 85t isn't connected: using MacBook Pro Microphone, the system default, until it's back");
    assert.equal(bluetoothChoice(byName, [{ uid: "jabra-le", name: "Jabra Elite 85t", isDefault: false, transport: "bluetooth" }, ...IN_CASE]), true);
    assert.equal(fallbackNote(resolveMic(byName, IN_CASE)), null, "gone after that: nothing said");
    // A wired mic whose UID looks like nothing in particular, listed: what the list says wins.
    assert.equal(bluetoothChoice(micChoice("AC-DE-48-00-11-33:input", "Odd USB"), [{ uid: "AC-DE-48-00-11-33:input", name: "Odd USB", isDefault: true, transport: "usb" }]), false);
  });

  test("the mic that gave no link, kept from the hold's lines until it's really back", () => {
    const hold = (more: object) => ({ on: true, uid: AIRPODS.uid, name: "AirPods", ...more });
    assert.equal(noLinkAfter(hold({ why: "connected" }), null), null);
    assert.equal(noLinkAfter(hold({ on: false, why: "no link" }), null), AIRPODS.uid);
    assert.equal(noLinkAfter(hold({ on: false, why: "cannot open" }), null), AIRPODS.uid);
    assert.equal(noLinkAfter(hold({ why: "press", retry: true }), AIRPODS.uid), AIRPODS.uid, "only tried again: not back yet");
    assert.equal(noLinkAfter(hold({ on: false, why: "no link" }), AIRPODS.uid), AIRPODS.uid, "gave none again");
    assert.equal(noLinkAfter(hold({ live: true, ms: 1900, retry: true }), AIRPODS.uid), null, "its link is up: back");
    assert.equal(noLinkAfter(hold({ why: "connected" }), AIRPODS.uid), null, "connected anew: tried afresh");
    assert.equal(noLinkAfter(hold({ on: false, why: "disconnected" }), null), null);
    assert.equal(noLinkAfter(hold({ on: false, why: "disconnected" }), AIRPODS.uid), AIRPODS.uid, "left to the device list (app/settings/mic.ts micInUse)");
  });
});

describe("the mic didn't start in time", () => {
  test("said with the mic's name, and what to do", () => {
    assert.equal(notStartedLine("AirPods"), "The AirPods mic didn't start in time. Hold the key a little longer.");
    assert.equal(notStartedLine("Alex's AirPods Pro"), "Alex's AirPods Pro mic didn't start in time. Hold the key a little longer.");
    assert.equal(notStartedLine("MacBook Pro Microphone"), "The MacBook Pro Microphone didn't start in time. Hold the key a little longer.");
    assert.equal(notStartedLine(null), "The mic didn't start in time. Hold the key a little longer.");
    assert.equal(notStartedLine("AirPods", true), "The AirPods mic didn't start in time. Give it a moment before you talk.");
  });
});

describe("what the helper says", () => {
  test("how each device is connected", () => {
    assert.deepEqual(parseDevices('[{"isDefault":true,"name":"AirPods","transport":"bluetooth","uid":"bt-1"}]'), [{ uid: "bt-1", name: "AirPods", isDefault: true, transport: "bluetooth" }]);
  });

  test("a helper from before 2026-11-14 (the built-in mic for a Bluetooth default): what it added is left out", () => {
    assert.deepEqual(
      parseUsing('{"fallback":false,"instead":{"name":"AirPods","uid":"bt-1"},"name":"MacBook Pro Microphone","switched":false,"uid":"BuiltInMicrophoneDevice","why":"default is bluetooth"}'),
      { uid: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", fallback: false, switched: false, wanted: null },
    );
  });

  test("its device list", () => {
    const line =
      '[{"isDefault":false,"name":"iPhone Microphone","uid":"00000000-0000-4000-8000-000000000003"},{"isDefault":true,"name":"USB Mic","uid":"AppleUSBAudioEngine:Example Inc:Example Mic:1000000:2,1"}]';
    assert.deepEqual(parseDevices(line), [IPHONE, USB_MIC]);
    assert.deepEqual(parseDevices("not json"), []);
    assert.deepEqual(parseDevices('{"uid":"x"}'), []);
    assert.deepEqual(parseDevices('[{"name":"no uid"},{"uid":"u"}]'), [{ uid: "u", name: "u", isDefault: false }]);
  });

  test("what it opened", () => {
    assert.deepEqual(parseUsing('{"fallback":true,"name":"MacBook Pro Microphone","switched":false,"uid":"BuiltInMicrophoneDevice","wanted":{"name":"USB Mic","uid":"usb-1"}}'), {
      uid: "BuiltInMicrophoneDevice",
      name: "MacBook Pro Microphone",
      fallback: true,
      switched: false,
      wanted: { uid: "usb-1", name: "USB Mic" },
    });
    assert.equal(parseUsing('{"fallback":false,"name":"USB Mic","switched":true,"uid":"u"}')?.wanted, null);
    assert.equal(parseUsing("nope"), null);
  });

  test("the mic held open (2026-11-13): a press on it says so, and whether its link was up", () => {
    const held = parseUsing('{"fallback":false,"held":true,"live":true,"name":"AirPods","switched":false,"uid":"bt-1:input","wanted":{"name":"AirPods","uid":"bt-1:input"}}');
    assert.deepEqual([held?.held, held?.live], [true, true]);
    assert.deepEqual([parseUsing('{"fallback":false,"held":true,"live":false,"name":"AirPods","switched":false,"uid":"bt-1:input"}')?.live], [false]);
    assert.equal("held" in parseUsing('{"fallback":false,"name":"MacBook Pro Microphone","switched":false,"uid":"BuiltInMicrophoneDevice"}')!, false);
    // The chosen mic listed but giving no link: another stands in, and says why.
    const stoodIn = parseUsing('{"fallback":true,"name":"MacBook Pro Microphone","noLink":true,"switched":false,"uid":"BuiltInMicrophoneDevice","wanted":{"name":"AirPods","uid":"bt-1:input"}}');
    assert.deepEqual([stoodIn?.fallback, stoodIn?.noLink, stoodIn?.wanted?.name], [true, true, "AirPods"]);
  });

  test("the hold: begun, its link up, ended; and what changed under it", () => {
    assert.deepEqual(parseHold('{"name":"AirPods","on":true,"uid":"bt-1:input","why":"chosen"}'), { on: true, uid: "bt-1:input", name: "AirPods", why: "chosen" });
    assert.deepEqual(parseHold('{"live":true,"ms":2054,"name":"AirPods","on":true,"outRate":24000,"uid":"bt-1:input"}'), {
      on: true,
      uid: "bt-1:input",
      name: "AirPods",
      live: true,
      ms: 2054,
      outRate: 24000,
    });
    assert.deepEqual(parseHold('{"heldMs":36002,"name":"AirPods","on":false,"uid":"bt-1:input","why":"disconnected"}'), {
      on: false,
      uid: "bt-1:input",
      name: "AirPods",
      why: "disconnected",
      heldMs: 36002,
    });
    assert.deepEqual(parseHold('{"name":"AirPods","on":true,"retry":true,"uid":"bt-1:input","why":"press"}'), { on: true, uid: "bt-1:input", name: "AirPods", why: "press", retry: true });
    assert.equal(parseHold('{"heldMs":10021,"name":"AirPods","on":false,"uid":"bt-1:input","why":"no link"}')?.why, "no link");
    // Held as the system default (2026-11-14), and what ends that.
    assert.deepEqual(parseHold('{"default":true,"name":"AirPods","on":true,"uid":"bt-1:input","why":"default"}'), { on: true, uid: "bt-1:input", name: "AirPods", why: "default", default: true });
    assert.deepEqual(parseHold('{"default":true,"heldMs":812,"name":"AirPods","on":false,"uid":"bt-1:input","why":"default changed"}'), {
      on: false,
      uid: "bt-1:input",
      name: "AirPods",
      why: "default changed",
      default: true,
      heldMs: 812,
    });
    assert.equal(parseHold("nope"), null);
    assert.equal(parseHold('{"name":"AirPods"}'), null);
    assert.deepEqual(parseHoldLost('{"from":24000,"name":"AirPods","to":48000,"uid":"bt-1:input","wasLive":true,"what":"output format"}'), {
      what: "output format",
      uid: "bt-1:input",
      name: "AirPods",
      from: 24000,
      to: 48000,
      wasLive: true,
    });
    assert.equal(parseHoldLost('{"name":"AirPods"}'), null);
  });

  test("set up anew (2026-11-13): how long that took; a warm one says nothing of it", () => {
    assert.equal(parseUsing('{"fallback":false,"fresh":"first","name":"MacBook Pro Microphone","setupMs":46,"switched":false,"uid":"BuiltInMicrophoneDevice"}')?.setupMs, 46);
    assert.equal("setupMs" in parseUsing('{"fallback":false,"name":"MacBook Pro Microphone","switched":false,"uid":"BuiltInMicrophoneDevice"}')!, false);
  });
});

describe("the mic picked, as the settings keep it (Settings → Listening and setup's mic step)", () => {
  test("by UID, with its name", () => {
    assert.deepEqual(micSetting(USB_MIC.uid, ALL), { mic: USB_MIC.uid, micName: "USB Mic" });
  });
  test("the system default: neither kept", () => {
    assert.deepEqual(micSetting("", ALL), { mic: undefined, micName: undefined });
  });
  test("one not listed now: the option's label, else its UID", () => {
    assert.deepEqual(micSetting("gone", ALL, "Old Mic"), { mic: "gone", micName: "Old Mic" });
    assert.deepEqual(micSetting("gone", ALL), { mic: "gone", micName: "gone" });
  });
  test("read back, it's the same mic", () => {
    const kept = micSetting(BUILT_IN.uid, ALL);
    assert.equal(resolveMic(micChoice(kept.mic, kept.micName), ALL).device, BUILT_IN);
  });
});
