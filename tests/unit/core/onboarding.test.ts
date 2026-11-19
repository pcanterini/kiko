// First-run setup's logic (src/core/onboarding.ts): which steps show, the terminal app permissions
// go to, its words; Pocket's background download (src/core/pocket-prep.ts) with a throwaway venv
// (its setup.sh a fake that fails: nothing downloads, no server starts); and what the
// permissions helper says, read (src/platform/macos/permissions.ts).
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import {
  carriedLine,
  helloText,
  helloVoice,
  missingLines,
  NO_MIC,
  setupCommand,
  setupPlan,
  staleDone,
  staleLine,
  stepsFor,
  terminalApp,
  terminalDevice,
  tryLines,
  VOICE_WORDS,
  voiceBar,
  whereToTurnOn,
  withDone,
  withoutDone,
  type SetupFacts,
} from "../../../src/core/onboarding.ts";
import { PREP_BYTES, prepBytes, prepFraction, PrepProgress, prepPhase, prepWatcher, prepWhy, pocketMissingLine, pocketNote, pocketPrepState, startPocketPrep } from "../../../src/core/pocket-prep.ts";
import { pocketInstalled, pocketPreparing, prepFile } from "../../../src/core/pocket-tts.ts";
import { parsePermissions } from "../../../src/platform/macos/permissions.ts";
import { checkWaits } from "../../support/until.ts";

const row = { id: "codex", name: "Codex", state: "not connected" as const, detail: "adds hooks", ask: true };
const fresh: SetupFacts = { agents: [row], modelKey: false, mic: "unknown", input: "unknown", done: [] };
const allDone: SetupFacts = { agents: null, modelKey: true, mic: "granted", input: "granted", done: ["mic", "talkKey", "name", "hello"] };

describe("which steps show", () => {
  test("a fresh Mac: every step, in order, ending on what to try", () => {
    assert.deepEqual(stepsFor(fresh), ["agents", "key", "mic", "talkKey", "name", "hello", "try"]);
  });

  test("everything done: only what to try", () => {
    assert.deepEqual(stepsFor(allDone), ["try"]);
  });

  test("each one left out when it's done", () => {
    assert.deepEqual(stepsFor({ ...fresh, agents: null }).includes("agents"), false, "no agent to offer");
    assert.deepEqual(stepsFor({ ...fresh, modelKey: true }).includes("key"), false, "a model key there");
    assert.deepEqual(stepsFor({ ...fresh, signedIn: true }).includes("key"), false, "signed in to an account: the choice is made");
    assert.deepEqual(stepsFor({ ...fresh, signedIn: true }, true).includes("key"), true, "--all: shown all the same");
    assert.deepEqual(stepsFor({ ...allDone, done: ["talkKey", "name", "hello"] }), ["mic", "try"], "mic granted but never tried");
    assert.deepEqual(stepsFor({ ...allDone, done: ["mic", "talkKey", "hello"] }), ["name", "try"], "the name never kept");
    assert.deepEqual(stepsFor({ ...allDone, mic: "denied" }), ["mic", "try"], "tried, then turned off");
    assert.deepEqual(stepsFor({ ...allDone, input: "unknown" }), ["talkKey", "try"], "Input Monitoring gone");
    assert.deepEqual(stepsFor({ ...allDone, done: ["mic", "talkKey", "name"] }), ["hello", "try"]);
  });

  test("--all: every step again (agents only with one to offer)", () => {
    assert.deepEqual(stepsFor(allDone, true), ["key", "mic", "talkKey", "name", "hello", "try"]);
    assert.deepEqual(stepsFor({ ...allDone, agents: [row] }, true), ["agents", "key", "mic", "talkKey", "name", "hello", "try"]);
  });

  test("picking up at the talk key (the terminal app reopened): it, then only what comes after it", () => {
    assert.deepEqual(stepsFor({ ...fresh, resume: "talkKey" }), ["talkKey", "name", "hello", "try"], "the agents, key and mic not asked again");
    assert.deepEqual(stepsFor({ ...allDone, input: "granted", resume: "talkKey" }), ["talkKey", "try"], "even granted by now: the key pressed once");
    assert.deepEqual(stepsFor({ ...fresh, resume: "talkKey" }, true), stepsFor(fresh, true), "--all: every step");
    assert.deepEqual(stepsFor({ ...fresh, resume: "nonsense" as never }), stepsFor(fresh), "a value it doesn't know: ignored");
  });

  test("setupDone keeps each step once, and ignores what isn't a step's name", () => {
    assert.deepEqual(withDone(undefined, "mic"), ["mic"]);
    assert.deepEqual(withDone(["mic", 3, "hello"], "mic"), ["mic", "hello"]);
  });
});

// The helper app renamed (Fala to Kiko, 2026-11-03: its grants were the old bundle id's), tccutil
// reset, or a permission turned off: setupDone still says the mic and the talk key are done.
describe("a step marked done whose permission is gone", () => {
  test("the mic without the microphone: asked again, and out of setupDone", () => {
    for (const mic of ["denied", "unknown", "restricted"] as const) {
      const plan = setupPlan({ ...allDone, mic });
      assert.deepEqual(plan.steps, ["mic", "try"], mic);
      assert.deepEqual(plan.stale, ["mic"], mic);
      assert.deepEqual(plan.setupDone, ["talkKey", "name", "hello"], mic);
    }
  });

  test("the talk key without Input Monitoring: asked again, and out of setupDone", () => {
    const plan = setupPlan({ ...allDone, input: "unknown" });
    assert.deepEqual(plan.steps, ["talkKey", "try"]);
    assert.deepEqual(plan.stale, ["talkKey"]);
    assert.deepEqual(plan.setupDone, ["mic", "name", "hello"]);
  });

  test("both gone at once (the rename): both asked again, in order; the name and hello still left out", () => {
    const plan = setupPlan({ ...allDone, mic: "unknown", input: "unknown" });
    assert.deepEqual(plan.steps, ["mic", "talkKey", "try"]);
    assert.deepEqual(plan.stale, ["mic", "talkKey"]);
    assert.deepEqual(plan.setupDone, ["name", "hello"]);
  });

  test("granted: left out as before, setupDone untouched", () => {
    assert.deepEqual(setupPlan(allDone), { steps: ["try"], stale: [], setupDone: null });
    assert.deepEqual(setupPlan({ ...allDone, mic: "denied" }).steps.includes("talkKey"), false, "Input Monitoring still on");
    assert.deepEqual(setupPlan({ ...allDone, input: "denied" }).steps.includes("mic"), false, "the microphone still on");
  });

  test("the name and hello are never asked again, whatever the permissions", () => {
    for (const mic of ["granted", "denied", "unknown"] as const)
      for (const input of ["granted", "denied", "unknown"] as const) {
        const plan = setupPlan({ ...allDone, mic, input });
        assert.ok(!plan.steps.includes("name") && !plan.steps.includes("hello"), `${mic}/${input}`);
        assert.ok(plan.setupDone === null || (plan.setupDone.includes("name") && plan.setupDone.includes("hello")), `${mic}/${input}`);
      }
  });

  test("not done before: asked as ever, nothing called stale, setupDone untouched", () => {
    const plan = setupPlan({ ...allDone, mic: "denied", done: ["talkKey", "name", "hello"] });
    assert.deepEqual([plan.steps, plan.stale, plan.setupDone], [["mic", "try"], [], null]);
  });

  test("picking up at the talk key: the mic's entry still goes, but only the talk key is said to be asked again", () => {
    const plan = setupPlan({ ...allDone, mic: "denied", input: "denied", resume: "talkKey" });
    assert.deepEqual(plan.steps, ["talkKey", "try"]);
    assert.deepEqual(plan.stale, ["talkKey"]);
    assert.deepEqual(plan.setupDone, ["name", "hello"]);
  });

  test("--all: every step as before, nothing called stale, setupDone left alone", () => {
    const plan = setupPlan({ ...allDone, mic: "denied", input: "unknown" }, true);
    assert.deepEqual(plan, { steps: stepsFor({ ...allDone, mic: "denied", input: "unknown" }, true), stale: [], setupDone: null });
  });

  test("setupDone as the settings file has it: anything that isn't a list is none; other entries kept", () => {
    assert.deepEqual(setupPlan({ ...allDone, mic: "denied", done: "mic" }).setupDone, null);
    assert.deepEqual(setupPlan({ ...allDone, mic: "denied", done: ["mic", 3, "hello", "later"] }).setupDone, ["hello", "later"]);
    assert.deepEqual(staleDone({ mic: "denied", input: "denied", done: ["name", "hello"] }), []);
    assert.deepEqual(withoutDone(["mic", "talkKey", "name"], ["talkKey"]), ["mic", "name"]);
  });

  test("the line said before it, by whose permission it is", () => {
    assert.equal(staleLine("mic", "Kiko Dev"), "The microphone was set up before, but macOS doesn't allow it for Kiko Dev now.");
    assert.equal(staleLine("talkKey", "Kiko Dev"), "The talk key was set up before, but macOS doesn't allow Input Monitoring for Kiko Dev now.");
  });
});

describe("the terminal app the permissions go to", () => {
  test("by its bundle id first (it passes through tmux), then TERM_PROGRAM, then its own variables", () => {
    assert.equal(terminalApp({ __CFBundleIdentifier: "com.mitchellh.ghostty", TERM_PROGRAM: "tmux" }), "Ghostty");
    assert.equal(terminalApp({ __CFBundleIdentifier: "com.apple.Terminal" }), "Terminal");
    assert.equal(terminalApp({ TERM_PROGRAM: "iTerm.app" }), "iTerm");
    assert.equal(terminalApp({ TERM_PROGRAM: "WarpTerminal" }), "Warp");
    assert.equal(terminalApp({ TERM_PROGRAM: "tmux", GHOSTTY_RESOURCES_DIR: "/x" }), "Ghostty");
    assert.equal(terminalApp({ TERM_PROGRAM: "tmux", LC_TERMINAL: "iTerm2" }), "iTerm");
    assert.equal(terminalApp({ TERM_PROGRAM: "tmux" }), null);
  });

  test("where to turn one on, with or without the app's name", () => {
    assert.equal(whereToTurnOn("Privacy & Security → Microphone", "Ghostty"), "System Settings → Privacy & Security → Microphone → Ghostty");
    assert.equal(whereToTurnOn("Privacy & Security → Input Monitoring", null), "System Settings → Privacy & Security → Input Monitoring → your terminal app");
  });
});

describe("the words", () => {
  test("what to try: four short lines; starting a session by voice only when voice can", () => {
    const lines = tryLines({ talk: "Right Option", menu: "Ctrl+Space", voiceCan: "messages" });
    assert.equal(lines.length, 4);
    assert.match(lines[0], /^Ctrl\+Space then c starts a session/);
    assert.match(lines[1], /^Hold Right Option and say a session's name/);
    // A neutral session name, as the README's ("api, run the tests"): never a real project's.
    assert.match(lines[1], /“api, run the tests”/);
    assert.match(lines[3], /kiko-dev setup runs this again/);
    assert.match(tryLines({ talk: "fn", menu: "Ctrl+\\", voiceCan: "everything" })[0], /^Hold fn and say “start a session in”/);
  });

  test("a short setup says why: what's set up already", () => {
    const all = { agents: true, key: true, talkKey: true };
    assert.equal(carriedLine(all), "Your agents, key and talk key are set up already.");
    assert.equal(carriedLine({ agents: false, key: true, talkKey: false }), "Your key is set up already.");
    assert.equal(carriedLine({ agents: true, key: false, talkKey: false }), "Your agents are set up already.");
    assert.equal(carriedLine({ agents: true, key: true, talkKey: false }), "Your agents and key are set up already.");
    assert.equal(carriedLine({ agents: false, key: false, talkKey: true }), "Your talk key is set up already.");
    assert.equal(carriedLine({ agents: false, key: false, talkKey: false }), null, "nothing left out: nothing to say");
  });

  test("no coding agent: said first, with how to get one; one found: nothing", () => {
    const [line, ...rest] = missingLines([]);
    assert.equal(rest.length, 0);
    assert.match(line, /^No coding agent found\./);
    assert.match(line, /claude\.ai\/install\.sh/);
    assert.match(line, /brew install codex/);
    assert.deepEqual(missingLines(["Codex"]), []);
  });

  test("setup's command by its full path: the link on the PATH, else the executable; a checkout's bin/kiko-dev (Kiko Dev's command)", () => {
    const home = "/Users/you/.local";
    assert.equal(setupCommand({ installed: true, binLink: `${home}/bin/kiko`, executable: `${home}/share/kiko/versions/0.1.0/kiko`, appRoot: "/x" }), "/Users/you/.local/bin/kiko setup");
    assert.equal(setupCommand({ installed: true, binLink: null, executable: `${home}/share/kiko/versions/0.1.0/kiko`, appRoot: "/x" }), "/Users/you/.local/share/kiko/versions/0.1.0/kiko setup");
    assert.equal(setupCommand({ installed: false, binLink: null, executable: "/opt/node", appRoot: "/Users/you/git/kiko/" }), "/Users/you/git/kiko/bin/kiko-dev setup");
    assert.equal(setupCommand({ installed: false, binLink: null, executable: "/opt/node", appRoot: "/Users/you/My Code/kiko" }), "'/Users/you/My Code/kiko/bin/kiko-dev' setup");
  });

  test("no microphone: said plainly, with what to do", () => {
    assert.equal(NO_MIC, "This Mac has no microphone: plug one in (AirPods work), or skip and talk through the iPhone app.");
  });

  test("hello names the talk key", () => {
    assert.match(helloText("Right Option"), /^Hi, I'm Kiko\. Hold Right Option and talk to me/);
  });

  // Release test 2026-11-01: hello in the macOS voice, Pocket downloaded meanwhile, and Play it
  // again still used the macOS voice (the voice was fixed at setup's start).
  test("hello's voice, looked at each time: Pocket once its download is ready (a replay too), never waited for; a voice chosen wins", () => {
    assert.equal(helloVoice("say", false, "running"), "say", "still downloading: not waited for");
    assert.equal(helloVoice("say", false, "ready"), "pocket", "Play it again after it finished: Pocket");
    assert.equal(helloVoice("say", false, "failed"), "say");
    assert.equal(helloVoice("say", true, "ready"), "say", "the macOS voice chosen: kept");
    assert.equal(helloVoice("pocket", false, "none"), "pocket");
    assert.equal(helloVoice("cartesia", false, "ready"), "cartesia");
  });

  test("the voice's progress bar: filled by the share done, the percentage floored, clamped to 0–100", () => {
    assert.equal(voiceBar(0), "▱▱▱▱▱▱▱▱▱▱  0%");
    assert.equal(voiceBar(0.385), "▰▰▰▱▱▱▱▱▱▱  38%");
    assert.equal(voiceBar(0.999), "▰▰▰▰▰▰▰▰▰▱  99%", "never 100% before it's done");
    assert.equal(voiceBar(1), "▰▰▰▰▰▰▰▰▰▰  100%");
    assert.equal(voiceBar(1.7), "▰▰▰▰▰▰▰▰▰▰  100%");
    assert.equal(voiceBar(-0.2), "▱▱▱▱▱▱▱▱▱▱  0%");
    assert.equal(voiceBar(Number.NaN), "▱▱▱▱▱▱▱▱▱▱  0%");
  });

  test("the last step's line with the voice still downloading: the percentage, never 100", () => {
    assert.equal(VOICE_WORDS.stillGoing(0.62), "Kiko's voice is 62% downloaded: it takes over from the Mac voice by itself.");
    assert.match(VOICE_WORDS.stillGoing(1), /is 99% downloaded/);
  });
});

describe("Pocket's background download", () => {
  // A throwaway venv: its python there means setup.sh made it.
  const venvIn = () => {
    const venv = join(mkdtempSync(join(tmpdir(), "pocket-")), "venv");
    mkdirSync(join(venv, "bin"), { recursive: true });
    return venv;
  };
  const scripts = (venv: string, setup: string) => {
    const script = join(dirname(venv), "setup.sh");
    writeFileSync(script, setup);
    return { script, serve: join(dirname(venv), "serve.py") };
  };
  const waitFor = checkWaits(5000, 50);

  test("installed: the venv's python, setup.sh finished, and no download running", () => {
    const venv = venvIn();
    assert.equal(pocketInstalled(venv), false);
    writeFileSync(join(venv, "bin", "python"), "");
    writeFileSync(join(venv, ".installing"), "");
    assert.equal(pocketInstalled(venv), false, "setup.sh still installing");
    rmSync(join(venv, ".installing"));
    assert.equal(pocketInstalled(venv), true);
    writeFileSync(prepFile(venv, "preparing"), String(process.pid));
    assert.equal(pocketPreparing(venv), true);
    assert.equal(pocketInstalled(venv), false, "not while the download fetches the model");
    assert.equal(pocketPrepState(venv), "running");
    writeFileSync(prepFile(venv, "preparing"), "999999");
    assert.equal(pocketPreparing(venv), false, "a pid that's gone");
  });

  test("its state: none, ready (finished, or installed some other way), failed (stopped short)", () => {
    const venv = venvIn();
    assert.equal(pocketPrepState(venv), "none");
    writeFileSync(join(venv, "bin", "python"), "");
    assert.equal(pocketPrepState(venv), "ready", "set up by hand: no status file");
    writeFileSync(prepFile(venv, "status"), "running\n");
    assert.equal(pocketPrepState(venv), "failed", "running, but its process is gone");
    writeFileSync(prepFile(venv, "status"), "ready\n");
    assert.equal(pocketPrepState(venv), "ready");
  });

  test("started detached, with the venv passed to setup.sh; one that fails leaves it failed, and the log says why", async () => {
    const venv = venvIn();
    assert.equal(startPocketPrep(venv, { script: join(dirname(venv), "none.sh"), serve: "" }), "no-setup");
    const setup = scripts(venv, 'echo "into $POCKET_VENV"; echo "no network here"; exit 1\n');
    assert.equal(startPocketPrep(venv, setup), "started");
    await waitFor(() => pocketPrepState(venv) === "failed");
    assert.equal(pocketPrepState(venv), "failed");
    const log = readFileSync(prepFile(venv, "log"), "utf8");
    assert.match(log, new RegExp(`into ${venv}`));
    assert.match(log, /no network here/);
  });

  test("a second start while it runs (install.sh's, then setup's) starts nothing: its pid is written as it starts", () => {
    const venv = venvIn();
    const setup = scripts(venv, "sleep 20\n");
    assert.equal(startPocketPrep(venv, setup), "started");
    const pid = Number(readFileSync(prepFile(venv, "preparing"), "utf8"));
    try {
      assert.ok(pid > 0);
      assert.equal(readFileSync(prepFile(venv, "status"), "utf8").trim(), "running");
      assert.equal(pocketPrepState(venv), "running");
      assert.equal(startPocketPrep(venv, setup), "running", "at once after: not started again");
    } finally {
      // Its own process group (detached): the shell and its sleep.
      process.kill(-pid, "SIGTERM");
    }
  });

  test("installed already: nothing started", () => {
    const venv = venvIn();
    writeFileSync(join(venv, "bin", "python"), "");
    assert.equal(startPocketPrep(venv, scripts(venv, "exit 1\n")), "ready");
  });

  test("how far along: the install (venv or uv's cache, the larger) then the model, each capped at its size", () => {
    const { install, model } = PREP_BYTES;
    const total = install + model;
    assert.equal(prepFraction({ install: 0, model: 0, phase: "install" }), 0);
    assert.equal(prepFraction({ install: install / 2, model: 0, phase: "install" }), install / 2 / total);
    assert.equal(prepFraction({ install: install * 3, model: 0, phase: "install" }), install / total, "more than expected: capped");
    assert.equal(prepFraction({ install: 0, model: 0, phase: "voice" }), install / total, "the model's phase: the install counts as done");
    assert.equal(prepFraction({ install: install, model: model * 5, phase: "voice" }), 1);
    assert.equal(prepFraction({ install: -5, model: -5, phase: "install" }), 0);
  });

  test("the share shown never goes back, stays under 100% while it runs, and is 100% once ready", () => {
    const p = new PrepProgress();
    const { install, model } = PREP_BYTES;
    assert.equal(p.next("running", { install: install / 2, model: 0, phase: "install" }), install / 2 / (install + model));
    const half = p.next("running", { install: install / 2, model: 0, phase: "install" });
    assert.equal(p.next("running", { install: install / 4, model: 0, phase: "install" }), half, "less on disk (uv's cache cleaned up): not back");
    assert.equal(p.next("running", null), half, "couldn't be measured: kept");
    assert.equal(p.next("running", { install: install * 9, model: model * 9, phase: "voice" }), 0.99, "all there but not ready: 99%");
    assert.equal(p.next("failed", null), 0.99, "failed: where it got to");
    assert.equal(p.next("ready", null), 1);
  });

  test("measured on disk: the venv or pocket-uv/ (the larger), and pocket-hf/; its phase from the status", async () => {
    const venv = venvIn();
    const share = dirname(venv);
    const mb = (path: string, n: number) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.alloc(n * 1024 * 1024, 1));
    };
    mb(join(venv, "lib", "torch.so"), 3);
    mb(join(share, "pocket-uv", "cache", "torch.whl"), 5);
    mb(join(share, "pocket-hf", "hub", "model.safetensors"), 2);
    const b = await prepBytes(venv);
    const near = (got: number, want: number) => assert.ok(Math.abs(got - want) < 0.2 * 1024 * 1024, `${got} ≈ ${want}`);
    near(b.install, 5 * 1024 * 1024);
    near(b.model, 2 * 1024 * 1024);
    assert.equal(b.phase, "install");
    writeFileSync(prepFile(venv, "status"), "voice\n");
    assert.equal(prepPhase(venv), "voice");
    const none = await prepBytes(join(mkdtempSync(join(tmpdir(), "pocket-")), "venv"));
    assert.deepEqual(none, { install: 0, model: 0, phase: "install" }, "nothing there yet");
  });

  test("watched: running with its share and phase, never back; ready is 100%; failed says why from its log", async () => {
    const venv = venvIn();
    // Running: this process's pid stands in for the download's.
    writeFileSync(prepFile(venv, "preparing"), String(process.pid));
    writeFileSync(prepFile(venv, "status"), "running\n");
    writeFileSync(join(venv, "lib.bin"), Buffer.alloc(4 * 1024 * 1024, 1));
    const look = prepWatcher(venv);
    const first = await look();
    assert.equal(first.state, "running");
    assert.equal(first.phase, "install");
    assert.ok(first.fraction > 0 && first.fraction < 0.01, String(first.fraction));
    rmSync(join(venv, "lib.bin"));
    assert.equal((await look()).fraction, first.fraction, "less on disk: not back");
    writeFileSync(prepFile(venv, "status"), "voice\n");
    const voice = await look();
    assert.equal(voice.phase, "voice");
    assert.ok(voice.fraction >= PREP_BYTES.install / (PREP_BYTES.install + PREP_BYTES.model) - 1e-9, "the install done");
    rmSync(prepFile(venv, "preparing"));
    writeFileSync(prepFile(venv, "log"), "fetching\nPocket TTS: couldn't download uv from https://x (offline?)\n\n");
    assert.deepEqual(
      await look(),
      { state: "failed", fraction: voice.fraction, phase: "install", why: "Pocket TTS: couldn't download uv from https://x (offline?)" },
      "stopped in the model's phase: failed",
    );
    assert.equal(prepWhy(join(tmpdir(), "no-such-dir", "venv")), "");
    writeFileSync(prepFile(venv, "status"), "ready\n");
    assert.equal((await look()).fraction, 1);
  });

  test("said once at the app's start: ready and speaking, or failed; nothing while it runs or once said", () => {
    assert.match(pocketNote("started", "pocket", "ready") ?? "", /finished downloading: Kiko speaks with it now/);
    assert.match(pocketNote("started", "say", "failed", "/p/venv") ?? "", /couldn't be set up \(what happened: \/p\/pocket-prep\.log\)/);
    assert.equal(pocketNote("started", "say", "running"), null);
    assert.equal(pocketNote("noted", "pocket", "ready"), null);
    assert.equal(pocketNote(undefined, "pocket", "ready"), null);
  });

  test("Pocket the voice but not installed in this copy: said once as its download starts, the macOS voice meanwhile", () => {
    assert.equal(pocketMissingLine("none"), "Setting up Pocket, the free voice, for this copy of Kiko: the macOS voice speaks until it's ready. Settings → Voice changes it.");
    assert.equal(
      pocketMissingLine("failed", "Pocket TTS: couldn't download uv (offline?)"),
      "Setting up Pocket, the free voice, for this copy of Kiko: the macOS voice speaks until it's ready. It didn't finish last time (Pocket TTS: couldn't download uv (offline?)), so it's trying again. Settings → Voice changes it.",
    );
    assert.doesNotMatch(pocketMissingLine("failed"), /\(\)/, "no log line: no empty brackets");
  });
});

test("the permissions helper's answer, read; anything it didn't say is unknown", () => {
  assert.deepEqual(parsePermissions('{"input":"granted","mic":"denied","speech":"unknown"}\n'), { mic: "denied", speech: "unknown", input: "granted" });
  assert.deepEqual(parsePermissions('{"mic":"maybe"}'), { mic: "unknown", speech: "unknown", input: "unknown" });
  assert.deepEqual(parsePermissions("not json"), { mic: "unknown", speech: "unknown", input: "unknown" });
});

test("the terminal setup reads keys from with a pipe for input (curl … | sh): its own device, never /dev/tty", () => {
  assert.equal(terminalDevice("ttys003\n"), "/dev/ttys003");
  assert.equal(terminalDevice(" ttys019 "), "/dev/ttys019");
  assert.equal(terminalDevice("??"), null);
  assert.equal(terminalDevice(""), null);
  assert.equal(terminalDevice("../etc/passwd"), null);
});
