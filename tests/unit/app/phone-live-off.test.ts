// The phone while the iPhone app isn't out (core/env.ts phoneLive off: KIKO_PHONE_LIVE=0 here, as
// the release has it while name.ts PHONE_LIVE is false): no Phone rows in Settings, the phone server
// (and with it the relay and Bonjour) never started even with `phone: true` saved, which is kept;
// Play on this Mac on whatever was saved; nothing about the phone in `kiko --help`, setup's
// microphone step, the trust card's line or the sign-out warning; and the voice asking to pair it
// told the app isn't out. The phone's own tests (tests/unit/remote, the harness's phone cases) run
// with it on, as Kiko Dev has it. Nothing listens on a port here: the server is never made.
import "../../setup.ts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

process.env.KIKO_PHONE_LIVE = "0";
// A relay named (tests/setup.ts has none), so "no relay" below is the phone being off, not the address
// missing. Nothing listens there: had it started, it would only fail to connect.
const RELAY = "ws://127.0.0.1:1";
process.env.KIKO_RELAY_URL = RELAY;
const SETTINGS = join(process.cwd(), "phone-saved.json");
process.env.KIKO_SETTINGS = SETTINGS;
writeFileSync(SETTINGS, JSON.stringify({ phone: true, playOnMac: false }));

const { PHONE_LIVE } = await import("../../../src/core/name.ts");
const { PHONE_NOT_OUT, phoneLive } = await import("../../../src/core/env.ts");
const { config } = await import("../../../src/core/config.ts");
const { ui } = await import("../../../src/core/ui-store.ts");
const { state } = await import("../../../src/app/state.ts");
const { setPhone, pairPhone, phoneRows } = await import("../../../src/app/phone.ts");
const { applySetting, refreshSettings } = await import("../../../src/app/settings-screen.ts");
const { PHONE_KEYS, SETTING_GROUPS } = await import("../../../src/core/settings-options.ts");
const { USAGE } = await import("../../../src/cli-args.ts");
const { NO_MIC } = await import("../../../src/core/onboarding.ts");
const { trustLine } = await import("../../../src/core/trust-prompt.ts");
const { pairedPhones } = await import("../../../src/account-cli.ts");

describe("PHONE_LIVE off", () => {
  test("off in the release (name.ts), on in Kiko Dev; KIKO_PHONE_LIVE=0 off, 1 on", () => {
    assert.equal(PHONE_LIVE, false, "the release hides the phone until the iPhone app is out");
    assert.equal(phoneLive({}, "release"), false);
    assert.equal(phoneLive({}, "dev"), true, "a checkout shows it");
    assert.equal(phoneLive({ KIKO_PHONE_LIVE: "0" }, "dev"), false);
    assert.equal(phoneLive({ KIKO_PHONE_LIVE: "off" }, "dev"), false);
    assert.equal(phoneLive({ KIKO_PHONE_LIVE: "1" }, "release"), true);
    assert.equal(phoneLive({ KIKO_PHONE_LIVE: "true" }, "release"), true);
    assert.equal(phoneLive(), false, "this test's: KIKO_PHONE_LIVE=0");
  });

  test("a saved phone: true is kept, but Phone is off; Play on this Mac is on whatever was saved", () => {
    assert.equal(config.phone, false);
    assert.equal(config.playOnMac, true);
    const saved = JSON.parse(readFileSync(SETTINGS, "utf8"));
    assert.equal(saved.phone, true);
    assert.equal(saved.playOnMac, false);
  });

  test("Settings has no Phone section: no rows, so no heading", () => {
    assert.deepEqual(phoneRows(), []);
    refreshSettings();
    const keys = ui.state.settings.map((r) => r.key);
    assert.ok(keys.includes("sounds"), "the other rows are there");
    assert.deepEqual(
      keys.filter((k) => PHONE_KEYS.has(k)),
      [],
    );
    assert.deepEqual([...PHONE_KEYS], SETTING_GROUPS.find((g) => g.title === "Phone")?.keys);
  });

  test("the server never starts, from the setting or Pair a phone; changes refused, said, nothing saved", async () => {
    const errors: string[] = [];
    const error = ui.error;
    ui.error = (_where: string, err: unknown) => void errors.push(String(err));
    try {
      await setPhone(true);
      assert.equal(state.phone, null);
      applySetting("phone", true);
      applySetting("phonePair", "open");
      applySetting("phones", "forget:all");
      pairPhone("open");
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(config.relayUrl, RELAY, "a relay is named");
      assert.equal(state.phone, null, "no server, so no relay and no Bonjour");
      assert.ok(!ui.state.pairQr, "no QR code");
      assert.equal(config.phone, false);
      assert.deepEqual(errors, [PHONE_NOT_OUT, PHONE_NOT_OUT, PHONE_NOT_OUT]);
      // Turning it off isn't saved either: what was saved before stays for when the app is out.
      applySetting("phone", false);
      assert.equal(JSON.parse(readFileSync(SETTINGS, "utf8")).phone, true);
    } finally {
      ui.error = error;
    }
  });

  test("nothing about the phone in the help, setup's microphone step, the trust card or signing out", async () => {
    assert.doesNotMatch(USAGE, /\bi?phone/i, "microphone aside");
    assert.match(USAGE, /^ {2}logout {16}sign this Mac out$/m);
    assert.equal(NO_MIC, "This Mac has no microphone: plug one in (AirPods work), or skip for now.");
    const line = trustLine("pixie", { kind: "folder", folder: "/x/pixie", agentName: "Claude Code" }, "/x", { spoken: false, byVoice: false });
    assert.doesNotMatch(line, /\bi?phone/i);
    assert.match(line, /Answer on its card\.$/);
    assert.deepEqual(await pairedPhones(), []);
  });
});
