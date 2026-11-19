// First-run setup, run for real (`kiko setup`; start.ts runs it on the first start, with nothing set
// up: `node src/onboard.ts --in-window`): the steps core/onboarding.ts picks, drawn by ui/onboarding.ts
// (@clack/prompts' look), doing what they say here. What each step finishes is saved as it goes (the
// settings' setupDone, agentAnswers, hotkey; the key in the Keychain), so stopping keeps what was done.
// Pocket's download starts in the background as setup opens, unless install.sh started it already
// (core/pocket-prep.ts); the voice step waits for it, showing how far along it is. While it draws,
// nothing else reaches the terminal: the helpers' stderr and anything printed go to the log.
//
// `--all`: every step, done or not. `--in-window`: run by start.ts in the Kiko window, the app
// starting after it. `--need-key`: only the last step, run by start.ts when the app found no model
// key: the key asked for there, then the app. Exits 0 when the last step was left (Enter or Esc),
// NO_KEY_EXIT when it was left with no model key, 130 when stopped (Ctrl+C twice).
// KIKO_PRETEND_NO_MIC=1: as on a Mac with no input device (to see that path on one that has one).
// First: a checkout's .env's KIKO_ values, before anything reads one (core/dev-env.ts).
import "./core/dev-env.ts";
import { execFileSync } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import tty from "node:tty";
import { BIN_LINK, APP_ROOT, INSTALLED, running } from "./core/app-root.ts";
import { answerCard, answersOf, cardSaid, foundRows, notInstalledLine, SETUPS, statusOf } from "./agents/setup.ts";
import { config, keys as keyFill } from "./core/config.ts";
import { proOnSale, settingEnv } from "./core/env.ts";
import { accountRunsModels, appAccount } from "./core/account/app-account.ts";
import { openInBrowser, overSsh, pairedPhones, setupAccount } from "./account-cli.ts";
import { checkKey, hasModel, KEYS, keysInUse, MODEL_KEYS, without } from "./core/keys.ts";
import { holdKey } from "./core/key-values.ts";
import { log } from "./core/log.ts";
import { shortPath } from "./core/text.ts";
import { micChoice, micSetting } from "./core/mic-device.ts";
import { COMMAND, envVar, NAME, spokenName, TITLE } from "./core/name.ts";
import { carriedLine, helloVoice, missingLines, setupCommand, setupPlan, terminalApp, terminalDevice, tryLines, withDone, type DoneStep, type StepId } from "./core/onboarding.ts";
import { pocketPrepState, prepWatcher, type PrepNow } from "./core/pocket-prep.ts";
import { NO_KEY_EXIT } from "./core/running.ts";
import { startPocket, voiceChosen } from "./pocket-start.ts";
import { PocketTts } from "./core/pocket-tts.ts";
import { keyLabel } from "./core/settings-options.ts";
import { loadSettings, rememberAgents, rememberSettings, rememberSpokenName } from "./core/settings.ts";
import { acceptedNow, termsNotice } from "./core/terms.ts";
import { levelOf, nameWarning } from "./core/wake.ts";
import { platform } from "./platform/index.ts";
import { helperStderrTo } from "./platform/macos/native.ts";
import { keyStore } from "./platform/keys.ts";
import { decideKey, keyWords } from "./terminals/tmux/keys.ts";
import { runSetup, type MicHeard, type SetupDeps, type SetupEnd } from "./ui/onboarding.ts";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** `p`, or `fallback` once `ms` have gone by. */
const within = <T>(p: Promise<T>, ms: number, fallback: T) => Promise.race([p, sleep(ms).then(() => fallback)]);

/**
 * Pocket's download, started when the voice is the macOS one because nothing was chosen (no voice
 * picked, no Cartesia key): it's what speaks once it's there. install.sh started it already, most
 * likely: then it's running. Kept in the settings (pocketSetup), so the app says once if it failed.
 */
function prepPocket() {
  const did = startPocket();
  log("pocket_prep", { did, by: "setup" });
  if (did === "started" || did === "running") rememberSettings({ pocketSetup: "started" });
}

/**
 * Pocket's download as the voice step shows it: state "none" when it isn't what will speak (a voice
 * chosen, a Cartesia key), so there's nothing to wait for. Ready here: heard in setup, so the app
 * has nothing to say about it at its start (pocketNote).
 */
const pocketWatch = prepWatcher();
async function pocketNow(): Promise<PrepNow> {
  if (config.tts !== "say" || voiceChosen()) return { state: "none", fraction: 0, phase: "install" };
  const now = await pocketWatch();
  if (now.state === "ready" && loadSettings().pocketSetup === "started") rememberSettings({ pocketSetup: "noted" });
  return now;
}

/**
 * Says `text` in the voice the app will speak with: Pocket or Cartesia when chosen and there; with
 * nothing chosen, Pocket once its download is ready (the voice step waits for it; a replay after it
 * finished too: helloVoice), else the macOS voice. Pocket or Cartesia not working: the macOS voice.
 */
async function sayHello(text: string) {
  const voice = helloVoice(config.tts, voiceChosen(), pocketPrepState());
  log("setup_hello", { voice });
  if (voice === "say") return platform.voice.sample(text, config.sayVoice, config.sayRate);
  const speaker = platform.speaker.create();
  await speaker.start();
  try {
    const engine = voice === "pocket" ? new PocketTts({ voice: config.pocketVoice }) : new (await import("./core/cartesia.ts")).Cartesia();
    try {
      await within(
        engine.connect().then(() => true),
        30_000,
        false,
      ).then((up) => {
        if (!up) throw new Error("the voice didn't start in time");
      });
      await new Promise<void>((resolve) => {
        let played = false;
        const timeout = setTimeout(resolve, 20_000);
        speaker.onPlaying = () => (played = true);
        speaker.onIdle = () => {
          if (!played) return;
          clearTimeout(timeout);
          resolve();
        };
        void engine.open({ onAudio: (pcm) => speaker.write(pcm), onDone: () => {} }).then((tts) => {
          tts.push(text);
          tts.end();
        }, resolve);
      });
    } finally {
      engine.close();
    }
  } catch (err) {
    // Pocket or Cartesia not working: the macOS voice says it.
    log("setup_hello_fallback", { voice, message: message(err) });
    await platform.voice.sample(text, config.sayVoice, config.sayRate);
  } finally {
    speaker.shutdown();
  }
}

/** As on a Mac with no input device (KIKO_PRETEND_NO_MIC=1). */
const pretendNoMic = () => envVar("PRETEND_NO_MIC") === "1";

/**
 * The mic open for `ms`, its levels, and what Apple's speech-to-text heard (when that's what
 * listens). Speech-to-text failing is only logged: the level still says whether the mic works.
 */
async function micTest(ms: number, onLevel: (level: number) => void, onHeard: (text: string) => void): Promise<MicHeard> {
  if (pretendNoMic()) return { peak: 0, heard: "", noDevice: true };
  const mic = platform.mic.create();
  await mic.start();
  // Plugged out since setup looked: nothing to listen with.
  if (!mic.devices.length) {
    mic.stop();
    return { peak: 0, heard: "", noDevice: true };
  }
  mic.setDevice(micChoice(config.mic, config.micName));
  let error: string | undefined;
  let stt: ReturnType<typeof platform.speech.create> | null = config.stt === "apple" ? platform.speech.create() : null;
  if (stt) {
    const s = stt;
    s.onInterim = onHeard;
    // Its first start may download the model: the level alone then.
    const up = await within(
      s.connect().then(
        () => true,
        (err) => ((error = message(err)), false),
      ),
      10_000,
      false,
    );
    if (up) s.begin();
    else {
      s.close();
      stt = null;
    }
  }
  let peak = 0;
  let last = 0;
  mic.open((chunk) => {
    stt?.send(chunk);
    const level = levelOf(chunk);
    peak = Math.max(peak, level);
    if (Date.now() - last > 80) {
      last = Date.now();
      onLevel(level);
    }
  });
  await sleep(ms);
  mic.close();
  let heard = "";
  try {
    heard = stt ? (await within(stt.finish(), 10_000, "")).trim() : "";
  } catch (err) {
    error = message(err);
  }
  stt?.close();
  mic.stop();
  if (error) log("setup_stt_error", { message: error });
  return { peak, heard };
}

/**
 * The account, for the key step's choice: only while accounts are open and there's a Keychain to
 * keep a sign-in in. Signing in is `kiko login`'s flow (account-cli.ts): the browser opened at the
 * code, unless this is an SSH session.
 */
async function accountDeps(): Promise<SetupDeps["account"]> {
  const account = keyStore ? appAccount() : null;
  if (!account) return undefined;
  const phones = (await pairedPhones().catch(() => [] as string[])).length;
  return setupAccount(account, { open: openInBrowser, remote: overSsh(), phones: () => phones, sale: proOnSale() });
}

/** What the screens do, for real. */
async function realDeps(inWindow: boolean): Promise<SetupDeps> {
  const saved = loadSettings();
  let talk = settingEnv("hotkey") ?? saved.hotkey ?? config.hotkey;
  const menu = keyWords(decideKey({ env: envVar("KEY"), setting: saved.menuKey }).key);
  const initial = await platform.permissions.status();
  // The helper app's name when the permissions are its own (the helpers run in it), else the terminal's.
  const holder = await platform.permissions.holder();
  const info = KEYS.find((k) => k.id === "openrouter")!;
  const agents: SetupDeps["agents"] = {
    rows: null, // set by onboard()
    notInstalled: notInstalledLine(),
    answer(connect) {
      // Every agent listed is answered (a connected one unticked: disconnected); later (Esc), only
      // the ones offered: the rest stay as they are.
      const rows = agents.rows ?? [];
      const card = { offered: rows.filter((r) => connect !== "later" || r.ask).map((r) => r.id), connect: connect === "later" ? [] : connect, later: connect === "later" };
      const { outcomes, answers } = answerCard(card);
      rememberAgents(answers);
      // What the step came to (the release test on 2026-11-01 couldn't tell whether it was answered).
      log("setup_agents", {
        offered: card.offered,
        later: card.later,
        connect: card.connect,
        outcomes: outcomes.map((o) => ({ agent: o.id, did: o.did, ...(o.changed ? { events: o.changed.events, file: shortPath(o.changed.file) } : {}), ...(o.error ? { error: o.error } : {}) })),
      });
      // What changed, then (a line under it) what's left to do.
      const { said, todo } = cardSaid(card, outcomes);
      return [said, todo].filter(Boolean).join("\n");
    },
  };
  return {
    app: holder ?? terminalApp(),
    ownApp: holder !== null,
    missing: missingLines(SETUPS.filter((s) => statusOf(s).state !== "not installed").map((s) => s.name)),
    permissions: {
      initial,
      status: platform.permissions.status,
      request: platform.permissions.request,
      pane: platform.permissions.pane,
      open: platform.permissions.open,
      refresh: platform.permissions.refresh,
    },
    agents,
    key: {
      // Whether the app will find one: the same question it asks (config.ts noModelKey), of the same
      // environment (the Keychain's keys read into it as this loaded; one saved here put in too).
      // A plan on the account (the trial started here) counts: its AI needs no key.
      has: () => hasModel(keysInUse(), accountRunsModels()),
      store: Boolean(keyStore),
      unread: keyFill.error ?? null,
      check: (key) => checkKey("openrouter", key),
      async save(key) {
        try {
          await keyStore!.set(info.env, key);
          // Held for this run, never in process.env (core/key-values.ts): the app it opens reads the Keychain itself.
          holdKey(info.env, key);
          return null;
        } catch (err) {
          return without(message(err), key);
        }
      },
    },
    account: await accountDeps(),
    micInputs: () => (pretendNoMic() ? Promise.resolve([]) : platform.mic.inputs()),
    micTest,
    micPick: {
      current: () => micChoice(config.mic, config.micName),
      save(uid, inputs) {
        // As Settings → Listening keeps it (micSetting); the next test listens on it (micTest reads config).
        const picked = micSetting(uid, inputs);
        config.mic = picked.mic ?? "";
        config.micName = picked.micName ?? "";
        rememberSettings(picked);
      },
    },
    talkKey: {
      label: () => keyLabel(talk),
      listen(onDown, onFail) {
        let hotkey: ReturnType<typeof platform.hotkey.create>;
        try {
          hotkey = platform.hotkey.create(talk);
        } catch (err) {
          onFail(message(err));
          return () => {};
        }
        hotkey.onDown = onDown;
        hotkey.start().catch((err) => onFail(message(err)));
        return () => hotkey.stop();
      },
      capture: () => Promise.race([platform.hotkey.capture(), sleep(20_000).then(() => Promise.reject(new Error("no key pressed")))]),
      quiet: (name) => name in platform.hotkey.keys,
      labelOf: keyLabel,
      save(name) {
        talk = name;
        rememberSettings({ hotkey: name });
      },
      menu,
    },
    name: { current: spokenName, warning: nameWarning, save: rememberSpokenName },
    hello: {
      say: sayHello,
      voice: pocketNow,
    },
    done: (step: DoneStep) => rememberSettings({ setupDone: withDone(loadSettings().setupDone, step) }),
    resume: {
      save: (step: StepId | null) => rememberSettings({ setupResume: step ?? undefined }),
      command: setupCommand({ installed: INSTALLED, binLink: existsSync(BIN_LINK) ? BIN_LINK : null, executable: process.execPath, appRoot: APP_ROOT }),
    },
    tryLines: () => tryLines({ talk: keyLabel(talk), menu, voiceCan: config.voiceCan }),
    end: inWindow ? { label: `Start ${TITLE}`, later: `${TITLE} starts now.` } : { label: `Open ${TITLE}`, later: `Run ${COMMAND} when you're ready.` },
    log,
  };
}

/** While setup draws: what's printed (console.*) and the helpers' stderr go to the log, never the screen. Returns the undo. */
function quietWhileDrawing(): () => void {
  const kept = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const toLog =
    (level: string) =>
    (...args: unknown[]) =>
      log("setup_console", { level, text: args.map(String).join(" ") });
  console.log = toLog("log");
  console.error = toLog("error");
  console.warn = toLog("warn");
  console.info = toLog("info");
  helperStderrTo((helper, line) => log("helper_stderr", { helper, line }));
  return () => {
    Object.assign(console, kept);
    helperStderrTo(null);
  };
}

/**
 * A terminal to read keys from: this one, or, drawing on a terminal with a pipe for input (`curl … |
 * sh` runs `kiko setup`), the terminal itself, by its own name (core/onboarding.ts
 * terminalDevice: an installed copy reads nothing from /dev/tty). Neither (output to a pipe too): null.
 */
function keyboard(): NodeJS.ReadStream | null {
  if (process.stdin.isTTY) return process.stdin;
  if (!process.stdout.isTTY) return null;
  try {
    const device = terminalDevice(execFileSync("ps", ["-o", "tty=", "-p", String(process.pid)], { encoding: "utf8" }));
    return device ? (new tty.ReadStream(openSync(device, "r")) as unknown as NodeJS.ReadStream) : null;
  } catch {
    return null;
  }
}

/**
 * Runs setup: "open" (Enter on the last step: on to the app), "later" (Esc there), "no-key" (left
 * on the last step with no model key: what to do said), "quit" (Ctrl+C twice), or "no-terminal"
 * (nothing to read keys from). `needKey`: the last step only (start.ts, the app having found no key). Picks up where the last one asked to
 * (setupResume: the talk key, once the terminal app was reopened), unless `all`.
 */
export async function onboard(o: { all?: boolean; inWindow?: boolean; needKey?: boolean } = {}): Promise<SetupEnd | "no-terminal"> {
  const stdin = keyboard();
  if (!stdin) return "no-terminal";
  const loud = quietWhileDrawing();
  try {
    // Only the key asked for (start.ts, the app having found none): nothing else to get ready.
    if (!o.needKey) prepPocket();
    const deps = await realDeps(Boolean(o.inWindow));
    const saved = loadSettings();
    // --all: every agent found listed, even with none to offer (a connected one can be unticked there).
    const found = foundRows(o.all ? {} : answersOf(saved.agentAnswers));
    deps.agents.rows = (o.all ? found.length > 0 : found.some((r) => r.ask)) ? found : null;
    const resume = typeof saved.setupResume === "string" ? (saved.setupResume as StepId) : null;
    const modelKey = deps.key.has();
    const signedIn = deps.account?.signedIn() != null;
    const facts = { agents: deps.agents.rows, modelKey, signedIn, mic: deps.permissions.initial.mic, input: deps.permissions.initial.input, done: saved.setupDone, resume };
    // Marked done with its permission gone since (a rename, tccutil reset, turned off): asked again,
    // said why before it, and out of setupDone (core/onboarding.ts setupPlan).
    const plan = o.needKey ? { steps: ["try"] as StepId[], stale: [], setupDone: null } : setupPlan(facts, o.all);
    const { steps, stale } = plan;
    if (plan.setupDone) rememberSettings({ setupDone: plan.setupDone });
    deps.stale = stale;
    // Kiko's Terms, said once per version before the first step; going on past it accepts them (kept).
    const terms = termsNotice(saved.termsAccepted);
    deps.terms = terms ? { line: terms.line, accept: () => rememberSettings({ termsAccepted: acceptedNow() }) } : null;
    // Kiko's logo above it all, except where only the key is asked (the app found none).
    deps.header = !o.needKey;
    // A short setup says why (its agents, key and talk key are set up already).
    deps.carried =
      o.all || o.needKey
        ? null
        : carriedLine({
            agents: found.length > 0 && !steps.includes("agents"),
            key: modelKey && !steps.includes("key"),
            account: signedIn && !modelKey && !steps.includes("key"),
            talkKey: !steps.includes("talkKey"),
          });
    log("setup_start", {
      steps,
      resume,
      all: Boolean(o.all),
      inWindow: Boolean(o.inWindow),
      needKey: Boolean(o.needKey),
      ...(terms ? { terms: terms.kind } : {}),
      app: deps.app,
      mic: deps.permissions.initial.mic,
      input: deps.permissions.initial.input,
      ...(stale.length ? { stale } : {}),
    });
    // The key step left out: a model key is there already, and where it came from (never the key).
    if (modelKey && !steps.includes("key"))
      log("setup_key", { at: "left-out", ended: "kept", sources: Object.fromEntries(MODEL_KEYS.filter((n) => keyFill.sources[n]).map((n) => [n, keyFill.sources[n]])) });
    const ended = await runSetup(steps, deps, { input: stdin, output: process.stdout });
    log("setup_end", { ended });
    // Left at the end (a key or not): the settings exist from here on, so the first start doesn't
    // run setup again (with no key, `kiko` asks for just that).
    if (ended !== "quit") rememberSettings({});
    return ended;
  } finally {
    loud();
    if (stdin !== process.stdin) stdin.destroy();
  }
}

// Run by start.ts (core/app-root.ts programArgv("onboard"): `node src/onboard.ts --in-window` in a
// checkout, `kiko _run onboard --in-window` installed). Imported by cli.ts for `kiko setup`: not run then.
// Not import.meta.filename against argv[1]: in the installed executable both are its own path for
// every module, so an import ran it too (and its Enter on "Open Kiko" ended setup there).
if (running.program === "onboard" || (!running.program && import.meta.main)) {
  const ended = await onboard({ all: process.argv.includes("--all"), inWindow: process.argv.includes("--in-window"), needKey: process.argv.includes("--need-key") });
  if (ended === "no-terminal") console.error(`${NAME} setup needs a terminal to run in.`);
  process.exit(ended === "quit" ? 130 : ended === "no-terminal" ? 1 : ended === "no-key" ? NO_KEY_EXIT : 0);
}
