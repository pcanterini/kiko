// A start of its own (run.sh runs it after test-app.ts, in out/start/): the app as a fresh clone of the repo finds
// it when its settings are shared with another checkout that has Pocket. Pocket chosen (KIKO_TTS=pocket) but not
// installed in this copy (KIKO_POCKET_VENV: a folder with no venv in it), and the mic's helper failing to start
// (HARNESS_MIC_FAILS: stubs/platform/macos/mic.ts). It used to stop at once ("Pocket TTS is not installed").
// Now it starts all the same: the macOS voice speaks, Pocket's download is started once (KIKO_POCKET_SETUP: a
// stand-in for pocket/setup.sh that only notes it ran, then fails, so nothing switches to a real Pocket), each
// said once, and the rest of the app runs. Nothing real is installed or downloaded.
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const RAN = `${process.cwd()}/pocket-setup-ran`;
writeFileSync(process.env.KIKO_POCKET_SETUP!, `#!/bin/sh\necho "$POCKET_VENV" >> '${RAN}'\nexit 1\n`);
chmodSync(process.env.KIKO_POCKET_SETUP!, 0o755);

// Importing it starts the app.
const { config, lines, logEntries, until } = await import("./driver.ts");
const { pocketPrepState } = await import("../../src/core/pocket-prep.ts");

try {
  console.log("\n# Pocket chosen but not installed in this copy, and the mic failing: the app starts all the same");
  await until(() => lines.some((l) => l.text.startsWith("Ready.")), 10_000, "the app to be ready");
  assert.equal(config.tts, "say", "the macOS voice speaks this run");
  const setting = lines.filter((l) => l.text.includes("Setting up Pocket, the free voice, for this copy"));
  assert.equal(setting.length, 1, "Pocket's setup is said once");
  assert.match(setting[0].text, /the macOS voice speaks until it's ready\. Settings → Voice changes it\.\)$/);
  const preps = logEntries().filter((l) => l.event === "pocket_prep");
  assert.deepEqual(
    preps.map((l) => [l.did, l.by, l.before]),
    [["started", "app", "none"]],
    "its download started once, by the app",
  );
  // The stand-in ran once, for this copy's venv, and failed: nothing to switch to.
  await until(() => pocketPrepState() === "failed", 5000, "the stand-in setup to finish");
  assert.deepEqual(readFileSync(RAN, "utf8").trim().split("\n"), [process.env.KIKO_POCKET_VENV]);
  assert.ok(!logEntries().some((l) => l.event === "pocket_switched"), "never switched to Pocket");
  // The mic: said once with what to do, logged, and the app went on to Ready.
  const mic = lines.filter((l) => l.text.includes("The microphone couldn't start"));
  assert.equal(mic.length, 1, "the mic's failure is said once");
  assert.match(mic[0].text, /mic helper exited \(1\).*Restart .+ to try again\./);
  assert.ok(logEntries().some((l) => l.event === "error" && l.where === "mic_start"));
  assert.ok(!logEntries().some((l) => l.event === "crash_caught"), "nothing went uncaught");
  console.log("ok: started with the macOS voice, Pocket's download started once, the mic's failure said once");
  // run.sh puts out/refused-bin first on PATH: each program there writes its name to out/refused and fails.
  assert.ok(!existsSync("../refused"), "the app ran a real program run.sh refuses");
} catch (err) {
  console.error("\nstart: FAILED in the case above:", err);
  process.exit(1);
}
console.log("\nstart: all passed");
process.exit(0);
