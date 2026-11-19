/**
 * Voice for Claude Code and the other coding agents. When any session finishes a turn, its Stop hook
 * (hooks/claude-code-hook.mjs) hands what it said to this app. The classifier decides whether it's worth reading
 * out; Haiku turns it into a short spoken summary, and the session waits briefly for a push-to-talk
 * reply. Everything you say goes through the classifier first: words for a session are passed on as said (as
 * the waiting session's reply, or typed in by a terminal adapter: a session's pane in Kiko's
 * tmux, its Ghostty terminal or its T3 Code thread), while requests to the app itself, or unclear
 * ones, go to Haiku, which answers, relays, stops or starts sessions.
 *
 * This file is the app's entry (start.ts runs it by this path; core/log.ts knows it by it): what
 * the window, its menu and the settings screen ask (onAction), starting up (main), shutting down,
 * and the wiring. The parts are in src/app/ (ARCHITECTURE.md): state.ts, talk.ts (your presses),
 * deliver.ts (your words), announce.ts (the sessions' turns and prompts), speech.ts, session-ops.ts,
 * new-session.ts, starting.ts, quick-task.ts, phone.ts, settings-screen.ts (with its sections in
 * settings/), status.ts.
 */
// First: a checkout's .env's KIKO_ values, before anything reads one (core/dev-env.ts).
import "./core/dev-env.ts";
// Second: with start.ts painting the splash, a crash as the app loads takes the screen from it first.
import "./app/splash-guard.ts";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { config, enginesFor, keyFallbacks, keys as keyFill, noModelKey, pocketWanted } from "./core/config.ts";
import { fallbackLine, keysInUse, NO_MODEL_KEY, without } from "./core/keys.ts";
import { crashCatcher } from "./core/crash.ts";
import { keyStore } from "./platform/keys.ts";
import { noLinkAfter } from "./core/mic-device.ts";
import { pocketMissingLine, pocketNote, pocketPrepState, prepWhy, startPocketPrep } from "./core/pocket-prep.ts";
import { acceptedNow, TERMS_DATE, termsNotice } from "./core/terms.ts";
import { PocketTts, pocketInstalled } from "./core/pocket-tts.ts";
import { findSession, listedId, sessionName } from "./core/sessions.ts";
import { classifierEnabled } from "./core/classifier.ts";
import { voiceAllows } from "./core/routing-rules.ts";
import { loadSettings, rememberSettings, SETTINGS_FILE } from "./core/settings.ts";
import { onSetAside, type SetAside, setAsideLine, setAsideSince } from "./core/json-file.ts";
import { COMMAND, envVar, spokenName, TITLE } from "./core/name.ts";
import { agent } from "./agents/index.ts";
import { SETUPS, statusOf } from "./agents/setup.ts";
import type { Held } from "./agents/types.ts";
import { platform } from "./platform/index.ts";
import { terminalOf, terminals } from "./terminals/index.ts";
import { sessionEnded } from "./core/close.ts";
import { ui, type Action, type UiState } from "./core/ui-store.ts";
import { keepPage, pagePath } from "./core/page.ts";
import { keyLabel, VOICE_CAN } from "./core/settings-options.ts";
import { startPlain } from "./ui/plain.ts";
import { LOGO_MS } from "./ui/logo.ts";
import { splashFits, splashSoonest, splashTimer, type SplashTimer } from "./ui/splash.ts";
import { splashArg, takeScreen, type Take } from "./ui/splash-handoff.ts";
import { realClock } from "./core/clock.ts";
import type { startTui } from "./ui/tui.ts";
import { currentKey, keyWords, menuKeyName } from "./terminals/tmux/keys.ts";
import { checkMic } from "./app/mic-permission.ts";
import { startTalkKey } from "./app/talk-key.ts";
import { startOverlay } from "./app/overlay.ts";
import { terminalApp } from "./core/onboarding.ts";
import { insideServer, sweepLaunches, tmuxRunner } from "./terminals/tmux/tmux.ts";
import { STEPS, type Step } from "./terminals/tmux/window.ts";
import { HelperBuildError } from "./platform/macos/native.ts";
import { lockHeldWords, NO_KEY_EXIT, otherRunningWords, SAID_EXIT, takeLock, whoElseRuns } from "./core/running.ts";
import { log, sessionSummary, totals } from "./core/log.ts";
import { showsDollars } from "./core/dollars.ts";
import { writeState } from "./app/status.ts";
import { announce, answerQuestion, askPermission, askQuestions, blocked, onRequest, repeatLast, settlePermission } from "./app/announce.ts";
import { backOnline, gaveUp, notSentAnywhere, retryKept } from "./app/deliver.ts";
import { online } from "./core/online.ts";
import { guardFor } from "./app/guard.ts";
import { agentAnswered, openPicker, pickedPlace, setWindow, startFromWindow } from "./app/new-session.ts";
import { checkHeard, idsFor, pairPhone, promptId, refreshAddresses, setPhone } from "./app/phone.ts";
import { endOutside, endSession, renameSession, renameWhenIdle, stopSession } from "./app/session-ops.ts";
import { applySetting, captureHotkey, labelIn, refreshSettings } from "./app/settings-screen.ts";
import { answerAgents, checkAgents, safeHealth, upgradeAgentHooks } from "./app/settings/agents.ts";
import { addWord, refreshHints, removeWord } from "./app/settings/dictionary.ts";
import { keySettings } from "./app/settings/keys.ts";
import { startPruningLogs } from "./app/settings/logs.ts";
import { forgetAccountConfirm, signInFromPrompt, startAccountCheck } from "./app/settings/account.ts";
import { modelCalls } from "./core/model-route.ts";
import { micFields, micInUse, refreshMic, testMic } from "./app/settings/mic.ts";
import { addSaying, removeSaying, testSaying } from "./app/settings/pronunciation.ts";
import { restartWhenHeard, updateChanged, updater } from "./app/settings/updates.ts";
import { modelName, previewVoice, voiceName } from "./app/settings/voice.ts";
import { heardNow, onBack, onIdle, onPlaying, onStalled, speakLine, stopTalking } from "./app/speech.ts";
import { agentDictated, checkStarting, getSessions, loginWatch, loginWatched, starting, trustScratch } from "./app/starting.ts";
import { sessionsListed, standing, standingCard, stands } from "./app/standing.ts";
import {
  PHONES_BACK_MS,
  STATE_FILE,
  applyMute,
  asking,
  audio,
  cartesia,
  connectCartesia,
  connectPocket,
  connectStt,
  dim,
  duck,
  floor,
  heldWhere,
  macPlays,
  mic,
  pocket,
  say,
  speaker,
  speechLock,
  state,
  sttEngine,
  talks,
  usePocket,
  wireHooks,
  keptWords,
} from "./app/state.ts";
import { watchPocket } from "./app/pocket-switch.ts";
import { startParts } from "./app/start-parts.ts";
import { keyOffers } from "./app/key-offer.ts";
import { keyDown, keyUp, micLive, phoneListeners, setListening } from "./app/talk.ts";

/**
 * A key or click that answers a prompt carries the prompt it was drawn for (its id, and for
 * questions which one): the one waiting by now being another (a new prompt came as you clicked, the
 * next question), it's dropped, never given to that one. True when dropped (logged, and said on screen).
 */
function staleAnswer(waiting: Held, action: { type: string; id: string }, question?: number) {
  const at = asking.get(waiting)?.at ?? 0;
  if (action.id === promptId(waiting) && (question === undefined || question === at)) return false;
  log("answer_stale", { action: action.type, id: action.id, waitingId: promptId(waiting), ...(question !== undefined ? { question, asking: at } : {}), sessionId: waiting.sessionId });
  ui.info("(that one changed as you answered: look again)");
  return true;
}

/** What the window's list, its menu and the settings screen ask of the app (ui-store.ts Action). */
function onAction(action: Action) {
  // You're using the window: what it showed you lately was seen here (remote/seen-on-mac.ts).
  state.phone?.macUsed("window");
  // Anything asked of the window while the splash shows (a key: skipSplash; the menu's asks): the app at once.
  if (ui.state.splash && !ui.state.splash.leaving) splash?.skip();
  switch (action.type) {
    case "skipSplash":
      return;
    case "allow":
    case "deny": {
      // The card shown: the prompt the floor asks, or one that stays up (a trust card, a prompt standing
      // after its window: app/standing.ts). The id it was drawn for picks it exactly (staleAnswer).
      const waiting = floor.waiting?.isPermission ? floor.waiting : standingCard();
      if (!waiting?.isPermission) return ui.info("(nothing to answer)");
      if (staleAnswer(waiting, action)) return;
      // Questions take answers: say one, or answer them in the terminal. n still declines them.
      if (waiting.questions && action.type === "allow") return ui.info(`(say your answer, or answer ${heldWhere(waiting)})`);
      stopTalking("permission", { causeSessionId: waiting.sessionId });
      state.pressAt = "mac";
      const outcome = action.type === "deny" ? "deny" : action.always ? "allow_always" : "allow";
      return settlePermission(waiting, outcome, action.type === "deny" ? "No." : "Yes.", "card");
    }
    case "repeat":
      return void repeatLast();
    case "mute":
      state.muted = !state.muted;
      // Like a TV's: nothing stops, it goes silent (mute.ts). The macOS voice can't go silent
      // mid-line, so muting cuts what it's saying, as it always did.
      if (state.muted && !cartesia && !pocket) stopTalking("mute");
      applyMute();
      ui.set({ muted: state.muted });
      return ui.info(state.muted ? "muted" : "unmuted");
    case "talk":
      // Hands-free holding the floor: a tap takes it over, as a key press does.
      return void (floor.pressed && !state.voiceHolds ? keyUp() : keyDown());
    case "trustScratch":
      return void trustScratch("window");
    case "macSignIn":
      return signInFromPrompt();
    case "settings":
      // Updates as they are now (refreshSettings with it): a `kiko update`, or --rollback, since
      // the updater's last look shows here at once, Restart now with it, as that command says.
      updateChanged(updater.view());
      if (state.phone) void refreshAddresses();
      return ui.set({ screen: "settings", settingsAt: action.at ?? null, settingsPaste: false });
    case "addKey":
      // The window's offer (app/key-offer.ts): Settings → Keys → OpenRouter, its paste open.
      onAction({ type: "settings", at: "key:openrouter" });
      return ui.set({ settingsPaste: true });
    case "closeSettings":
      // A key that couldn't be checked and wasn't saved: gone with the screen; and a pairing QR code shown on it.
      keySettings.forget();
      forgetAccountConfirm();
      if (ui.state.pairQr) pairPhone("close");
      ui.set({ screen: "main", settingsPaste: false });
      if (ui.state.restartPending) void restartWhenHeard();
      return;
    case "set":
      return applySetting(action.key, action.value, action.label);
    case "apiKey": {
      // An option picked that needed this key (`then`): set once the key is saved, else left as it was.
      const then = action.then;
      return void keySettings
        .enter(action.id, action.key)
        .then((saved) => saved && then && applySetting(then.key, then.value, then.label))
        .catch((err) => ui.error("keys", without(err instanceof Error ? err.message : String(err), action.key)))
        .then(refreshSettings);
    }
    case "dictionary":
      return void (action.op === "add" ? addWord(action.heard, action.write, "settings") : removeWord(action.heard, "settings"));
    case "pronunciation":
      if (action.op === "add") return void addSaying(action.word, action.say, "settings");
      if (action.op === "remove") return removeSaying(action.id);
      return void testSaying(action.id).catch((err) => ui.error("pronunciation", err));
    case "preview":
      return void previewVoice(action.value, action.label).catch((err) => ui.error("preview", err));
    case "captureKey":
      return void captureHotkey();
    case "micTest":
      return void testMic();
    case "show":
      return void state.windowGlue?.show(action.page, action.focus ?? true);
    case "step":
      return void state.windowGlue?.step(action.by);
    case "last":
      return void state.windowGlue?.last(action.focus ?? true);
    case "focusStage":
      return void state.windowGlue?.focusStage();
    case "newSession":
      if (ui.state.screen === "settings") onAction({ type: "closeSettings" });
      return openPicker();
    case "closePicker":
      return void setWindow({ picker: null });
    case "start": {
      const where = pickedPlace(action.pick);
      setWindow({ picker: null });
      log("window_start", { pick: "scratch" in action.pick ? "scratch" : "project" in action.pick ? "project" : "new" });
      if (where) void startFromWindow(where).catch((err) => state.windowGlue?.note(`I couldn't start it: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    case "pickAgent":
      return agentAnswered(action.ask, action.agent);
    case "rowMenu":
      return void state.windowGlue?.rowMenu(action.sessionId, action.x, action.y);
    case "renaming": {
      const session = action.sessionId ? findSession(ui.state.sessions, action.sessionId) : undefined;
      setWindow({ renaming: session ? { sessionId: session.sessionId, name: sessionName(session) } : null, picker: null });
      if (session) void state.windowGlue?.focusList();
      return;
    }
    case "rename": {
      setWindow({ renaming: null });
      const session = findSession(ui.state.sessions, action.sessionId);
      if (!session) return state.windowGlue?.note("That session has ended.");
      return void renameSession(session, action.name, "window");
    }
    case "interrupt": {
      const session = findSession(ui.state.sessions, action.sessionId);
      if (!session) return state.windowGlue?.note("That session has ended.");
      return void stopSession(session, "window");
    }
    case "close":
      return void state.windowGlue?.close(action.sessionId);
    case "passKey": {
      // The Kiko key pressed twice: the key itself to the session shown, checked as every key Kiko types.
      const session = findSession(ui.state.sessions, action.sessionId);
      if (session?.place?.via !== "tmux") return;
      const name = sessionName(session);
      return void terminalOf(session.place)!.key!(session.place, currentKey()).then((passed) => {
        if (!passed.sent) state.windowGlue?.note(`I didn't pass ${menuKeyName()} on to ${name}: ${passed.why}`);
      });
    }
    case "detach":
      return void state.windowGlue?.detach();
    case "answer": {
      // Claude's question being asked (or standing on its card), answered by its option's number: as if it was said (ask.ts).
      const waiting = floor.waiting?.isPermission ? floor.waiting : (standingCard() ?? floor.waiting);
      if (!waiting?.questions) return ui.info("(no question to answer)");
      if (staleAnswer(waiting, action, action.asking)) return;
      stopTalking("answer", { causeSessionId: waiting.sessionId });
      state.pressAt = "mac";
      return void answerQuestion(waiting, String(action.option));
    }
    case "agents":
      return answerAgents(action);
    case "quit":
      return shutdown(0);
  }
}

// What the floor, a hold, the question and a restart call in the parts (app/state.ts hooks).
wireHooks({ announce, askPermission, askQuestions, notSentAnywhere, speakLine, stopTalking, writeState, stands, shutdown });
mic.onStarted = (ms) => {
  // From the helper's "start" to its first sound, setup included (2026-11-13); setupMs when it set the device up anew.
  // `held`: the mic held open between presses (a Bluetooth one in use): a few ms then, its link up
  // (`linkUp` false: the press came before it was, and waited for it).
  const held = mic.using?.held ? { held: true, linkUp: mic.using.live === true } : {};
  log("mic_started", { msAfterKeyDown: ms, ...(mic.using?.setupMs !== undefined ? { setupMs: mic.using.setupMs } : {}), ...held, ...micFields() });
  micLive();
};
// The hold (mic.swift held): on as it begins, again with how long its link took to come up
// (`linkMs`), off as it ends; and whatever changed under it meanwhile (mic_hold_lost: the headset
// left its call profile, its mic went silent). What the by-ear test is judged by afterwards.
mic.onHold = (hold) => {
  const { on, uid, name, ms, ...rest } = hold;
  log("mic_hold", { on, device: name || null, uid: uid || null, ...(ms !== undefined ? { linkMs: ms } : {}), ...rest });
  // It gave no link (listed, but out of your ears or with the iPhone): presses take another mic
  // from here, until it's held again. Nothing shown or said either way (2026-11-14; before, "AirPods
  // gave no sound…" and "AirPods mic is back"): the header and the setting name the mic in use.
  const noLink = noLinkAfter(hold, state.micNoLink);
  if (noLink === state.micNoLink) return;
  state.micNoLink = noLink;
  refreshMic();
};
mic.onHoldLost = (lost) => {
  const { uid, name, ...rest } = lost;
  log("mic_hold_lost", { device: name || null, uid: uid || null, ...rest });
};
mic.onUsing = (using) => {
  // Open, it moved to another device: the chosen one came or went, or the default changed.
  if (using.switched) log("mic_switched", micFields());
  // "connecting to …" names the mic this press is really waiting on (2026-11-14): never the AirPods
  // once another mic stands in for them.
  if (ui.state.micConnecting && using.name && ui.state.micConnecting !== using.name) ui.set({ micConnecting: using.name });
};
mic.onDevices = refreshMic;
speaker.onPlaying = () => audio.playing();
speaker.onIdle = () => audio.idle();
speaker.onStalled = onStalled;
speaker.onBack = () => void onBack();
// The network back after Kiko took it as down (core/online.ts): words kept are retried at once.
online.onBack = () => void backOnline();
// Words kept when the router couldn't answer: routed again as each retry comes due, then given up on.
keptWords.onDue = () => void retryKept();
keptWords.onGaveUp = (left) => void gaveUp(left);
audio.onPlaying = say.onStart = onPlaying; // announce() wraps this to time its first sound
audio.onIdle = say.onEnd = onIdle;
duck.onChange = writeState;
agent.onHeld = onRequest;
ui.on("action", onAction);
// A prompt standing after its window, answered in its own window meanwhile: taken down (app/standing.ts).
ui.on("change", () => sessionsListed(ui.state.sessions));

let tui: ReturnType<typeof startTui> | null = null;
/** The splash's timing, while it shows (startSplash). */
let splash: SplashTimer | null = null;
let lock: { release(): void } | null = null;
/** Stops watching Pocket's download (app/pocket-switch.ts). */
let stopPocketWatch = () => {};
// The Kiko window (`kiko`, src/ui/window-glue.ts): its bottom line and sessions' names, and its
// list, this app being in its list pane (start.ts --window).
const listPane = process.argv.includes("--window") && insideServer(process.env.TMUX) ? (process.env.TMUX_PANE ?? null) : null;
// Plain scrolling text instead of the list (ui/plain.ts): only for the faked-app harness, which
// runs the app outside the window.
const plain = process.argv.includes("--plain");
// The splash (start.ts --splash, a cold start): painted by start.ts from `splashSince` while the app
// loads (--splash=<since>), the screen taken from it before the app first writes to it: its frame
// kept for the app's splash to go on from, or cleared (ui/splash-handoff.ts). Undefined: no splash.
const splashSince = splashArg(process.argv);
const takeOver = (take: Take) => (typeof splashSince === "number" ? takeScreen(take) : null);

async function main() {
  // Kiko runs as its window: the app is started in the window's list pane (`kiko`), never
  // full-screen in a terminal of its own.
  if (!listPane && !plain) {
    process.stderr.write(`${TITLE} runs in its window: run ${COMMAND} (bin/${COMMAND}) to open it.\n`);
    process.exit(1);
  }
  // Every other key is optional (a free engine stands in), but with neither model key nothing can answer.
  if (noModelKey) {
    log("no_model_key", { keychain: keyStore ? "on" : "off", ...(keyFill.error ? { error: keyFill.error } : {}) });
    takeOver("clear");
    process.stderr.write(`${NO_MODEL_KEY}\n${keyFill.error ? `(The Keychain couldn't be read: ${keyFill.error})\n` : ""}`);
    // start.ts asks for the key right there in the window (NO_KEY_EXIT), so it never just closes.
    process.exit(NO_KEY_EXIT);
  }
  // One app at a time, decided before anything else (core/running.ts): nor beside the other flavour.
  // Said and stopped: start.ts keeps the window open on it (SAID_EXIT).
  const other = await whoElseRuns();
  if (other) {
    takeOver("clear");
    process.stderr.write(`${otherRunningWords(other)}\n`);
    process.exit(SAID_EXIT);
  }
  const locked = await takeLock();
  if ("heldBy" in locked) {
    takeOver("clear");
    process.stderr.write(`${lockHeldWords(locked.heldBy)}\n`);
    process.exit(SAID_EXIT);
  }
  lock = locked;
  // Launch files tmux never ran (tmux/tmux.ts envLaunch): each holds an environment, keys included.
  const swept = sweepLaunches();
  if (swept) log("launch_files_swept", { count: swept });
  // In the Kiko window's list pane, the TUI draws the list (ui/window-list.ts); --plain, scrolling text.
  if (listPane) ui.set({ window: { shown: null, note: "" } });
  // Kiko's page in the window: every line shown, kept in a private file its viewer follows.
  const page = pagePath();
  keepPage(page);
  // Loaded here, not imported at the top: Ink (and Yoga under it) starts with a top-level await, and
  // Bun's bundle (scripts/bundle.ts) can't take one in a module the parts in src/app/ import back
  // (an import cycle): "await can only be used inside an async function" (install-live.test.ts).
  const [{ startWindow }, { routeConsole, startTui }] = await Promise.all([import("./ui/window-glue.ts"), import("./ui/tui.ts")]);
  // Kiko's logo over the window as it opens (start.ts --splash: a cold start), the rest loading under it.
  const splashOn = Boolean(listPane && splashSince !== undefined && process.stdout.isTTY && splashFits(process.stdout.columns, process.stdout.rows));
  if (splashOn) startSplash(splashSince ?? Date.now());
  state.windowGlue = startWindow(tmuxRunner(), listPane, page, endSession, (line) => void speakLine(line), endOutside);
  if (plain) startPlain();
  else {
    routeConsole();
    tuiAfterSplash(startTui);
  }
  ui.set({
    about: { voice: voiceName(), model: modelName(), hotkey: config.hotkey, pttMode: config.pttMode, classifier: classifierEnabled() },
    icons: config.icons,
    newSessionMode: config.newSessionMode,
    playOnMac: config.playOnMac,
    macPlays: macPlays(),
  });
  log("start", {
    summaryModel: config.summaryModel,
    tts: config.tts,
    voice: config.cartesiaModel,
    replyWindowMs: config.replyWindowMs,
    projectsRoot: config.projectsRoot || null,
    scratchFolder: config.scratchFolder,
    hotkey: config.hotkey,
    classifier: classifierEnabled() ? config.classifierModel : null,
    listenMode: config.listenMode,
    utteranceModel: classifierEnabled() ? config.utteranceModel : null,
    voiceCan: config.voiceCan,
    duckLevel: config.duckMusic ? config.duckLevel : null,
    // The terminal adapters that can be used now, in the order they're asked (tmux: installed, and on).
    terminals: terminals.filter((t) => t.ready?.() ?? true).map((t) => t.id),
  });
  // The logs kept to Settings → Logs → Keep logs: pruned now, then once a day.
  startPruningLogs();
  // The Kiko account's plan, when it runs the model calls (core/model-route.ts): its notices (the
  // trial ended, today's share used, almost used up…), each shown and said once.
  // In the window, the trial's end and today's share used offer your own key there and then (app/key-offer.ts).
  keyOffers.wire({
    show: (line) => ui.info(line),
    say: (text, phone) => void speakLine(text, true, undefined, phone ? { phone } : undefined),
    log,
    window: () => Boolean(ui.state.window),
    closeSettings: () => onAction({ type: "closeSettings" }),
  });
  modelCalls.onNotice = (n) => keyOffers.notice(n);
  modelCalls.onPlanOk = () => keyOffers.planBack();
  // Signed in to an account (accounts open): asked now and twice a day, which keeps the session alive.
  startAccountCheck();
  // A config file that couldn't be read, set aside rather than saved over (core/json-file.ts): logged
  // and said, once each. Those set aside before this (as the app loaded), and the ones `kiko` set
  // aside as it started it (by their names in the folder, in the last half hour), too.
  const toldAside = new Set<string>();
  const sayAside = (s: SetAside) => {
    if (toldAside.has(s.aside ?? s.file)) return;
    toldAside.add(s.aside ?? s.file);
    log("file_set_aside", s);
    ui.info(`(${setAsideLine(s)})`);
  };
  onSetAside(sayAside);
  for (const s of setAsideSince(dirname(SETTINGS_FILE), Date.now() - 30 * 60_000)) sayAside(s);
  // Where each key came from (names only), and a Keychain that couldn't be read.
  log("keys", { sources: keyFill.sources, keychain: keyStore ? "on" : "off", ...(keyFill.error ? { error: keyFill.error } : {}) });
  if (keyFill.error) ui.info(`(The Keychain couldn't be read: ${keyFill.error}. Keys kept there are missing this run.)`);
  // A choice whose key is missing: a free engine (or the other provider's Haiku) stands in, said once.
  if (keyFallbacks.length) {
    log("key_fallback", { fallbacks: keyFallbacks });
    ui.info(`(${fallbackLine(keyFallbacks)})`);
  }
  // Kiko's Terms changed since they were accepted here (setup keeps which): said once, a notice only.
  const terms = loadSettings().termsAccepted;
  const termsSaid = terms ? termsNotice(terms) : null;
  if (termsSaid?.kind === "changed") {
    log("terms_changed", { accepted: terms?.version, now: TERMS_DATE });
    ui.info(`(${termsSaid.line})`);
    rememberSettings({ termsAccepted: acceptedNow() });
  }
  // Pocket the voice (chosen, or the free one with nothing chosen) but not installed in this copy: a
  // new clone or install, whose venv is its own while the settings are shared with the other copies
  // of this flavour, so setup (and its pocketSetup "noted") was another copy's. The macOS voice
  // speaks (keys.ts pickEngines), Pocket's download starts here as setup starts it (pocket-prep.ts),
  // said once, and the app switches when it's ready (the watch below). Running already (setup's, or
  // a run before this one): nothing more, nothing said.
  if (config.tts === "say" && !pocketInstalled() && pocketWanted()) {
    const before = pocketPrepState();
    const why = before === "failed" ? prepWhy() : "";
    const did = before === "running" ? "running" : startPocketPrep();
    log("pocket_prep", { did, by: "app", before });
    if (did === "started") ui.info(`(${pocketMissingLine(before, why)})`);
    if (did === "no-setup") ui.info("(Pocket, the free voice, isn't installed in this copy and can't be set up here (no pocket/setup.sh), so the macOS voice speaks. Settings → Voice changes it.)");
  }
  // Pocket, downloaded in the background by first-run setup: ready and speaking now, or failed, said once.
  const pocketSaid = pocketNote(loadSettings().pocketSetup, config.tts, pocketPrepState());
  if (pocketSaid) {
    log("pocket_setup", { tts: config.tts, state: pocketPrepState() });
    ui.info(`(${pocketSaid})`);
    rememberSettings({ pocketSetup: "noted" });
  }
  // The macOS voice only because Pocket is still downloading: Pocket from the line after it's ready.
  if (config.tts === "say") {
    stopPocketWatch = watchPocket({
      state: () => pocketPrepState(),
      wanted: () => enginesFor(loadSettings()).tts === "pocket",
      start: async () => {
        const engine = new PocketTts();
        try {
          await engine.connect();
          return engine;
        } catch (err) {
          engine.close();
          throw err;
        }
      },
      close: (engine) => engine.close(),
      busy: () => speechLock.busy,
      use: (engine) => {
        usePocket(engine);
        ui.set({ about: { voice: voiceName(), model: modelName(), hotkey: config.hotkey, pttMode: config.pttMode, classifier: classifierEnabled() } });
        ui.info("(Switched to Pocket's voice. Settings → Voice changes it.)");
        rememberSettings({ pocketSetup: "noted" });
      },
      log,
    });
  }
  void keySettings.readNames().then(() => ui.state.screen === "settings" && refreshSettings());
  // A run that crashed while you talked left the volume down: put it back, unless it was changed since.
  const left = platform.volume.leftover(STATE_FILE);
  if (left) void duck.adopt(left);
  // Another agent's news (T3 Code: it updated past what this Kiko knows), said once as it is.
  agent.onNotice = (line) => {
    ui.info(`(${line})`);
    void speakLine(line);
  };
  // What it's doing, said in the window's session area until it's ready (window-glue.ts starting).
  const step = (now: Step | null) => void state.windowGlue?.starting(now);
  step(STEPS.agents);
  await agent.start();
  // The dictionary's words and the app's own go with the first connection; session names follow.
  refreshHints([]);
  step(STEPS.voice);
  // Each on its own: one that doesn't start is said, with what to do, and the rest go on (app/start-parts.ts).
  const hadPocket = Boolean(pocket);
  await startParts(
    [
      {
        name: "mic",
        start: () => mic.start(),
        failed: (why) => ui.error("mic", `The microphone couldn't start (${why}), so talking on this Mac doesn't work this run (a paired phone's mic still does). Restart ${TITLE} to try again.`),
      },
      {
        name: "speaker",
        start: () => speaker.start(),
        failed: (why) => ui.error("speaker", `The sound player couldn't start (${why}), so replies and beeps may not play on this Mac this run. Restart ${TITLE} to try again.`),
      },
      { name: "stt", start: connectStt, failed: () => {} },
      { name: "cartesia", start: connectCartesia, failed: () => {} },
      { name: "pocket", start: connectPocket, failed: () => {} },
    ],
    { log, fatal: (err) => err instanceof HelperBuildError },
  );
  // Pocket didn't start (connectPocket): the macOS voice's name on the header.
  if (hadPocket && !pocket) ui.set({ about: { voice: voiceName(), model: modelName(), hotkey: config.hotkey, pttMode: config.pttMode, classifier: classifierEnabled() } });
  refreshMic();
  log("mic", { ...micFields(micInUse()), devices: mic.devices.length });
  upgradeAgentHooks();
  checkAgents();
  writeState();
  setInterval(writeState, 2000).unref(); // heartbeat: the status line treats a stale file as "app off"
  const refreshSessions = (maxAgeMs = 3000) =>
    getSessions(maxAgeMs).then((sessions) => {
      // A session listed under another ID now (its turns moved into a background process): the
      // same one, so your words still go to it.
      const moved = state.target && listedId(sessions, state.target.sessionId) !== state.target.sessionId;
      if (state.target && moved) state.target = { ...state.target, sessionId: listedId(sessions, state.target.sessionId) };
      ui.set({ sessions, sessionsLoaded: true });
      if (moved) writeState();
      if (starting.all().length) void checkStarting();
      renameWhenIdle(sessions);
      refreshHints(sessions);
      void state.windowGlue?.refresh();
    });
  step(STEPS.sessions);
  const firstLook = refreshSessions();
  setInterval(refreshSessions, 4000).unref();
  // An agent's hooks found not working while this runs (its setup's `health`: Codex's, a turn that no
  // hook told of): said once an agent, a run. One wrong at start was said then (startWarning).
  const healthSaid = new Set(SETUPS.filter((s) => s.health && safeHealth(s)).map((s) => s.id));
  const checkHealth = () => {
    for (const s of SETUPS) {
      if (!s.health || healthSaid.has(s.id) || statusOf(s).state === "not installed") continue;
      const problem = safeHealth(s);
      if (!problem) continue;
      healthSaid.add(s.id);
      log("hooks_silent", { agent: s.id, problem });
      const line = `${s.name}'s hooks aren't working: ${problem}.`;
      ui.info(`(${line})`);
      void speakLine(line);
    }
  };
  setInterval(checkHealth, Number(envVar("HEALTH_CHECK_MS") ?? 15_000)).unref();
  // An agent that says when a session starts or ends gets it listed at once (Claude Code: its
  // SessionStart and SessionEnd hooks); the look every 4 seconds is for sessions it didn't say.
  agent.onSessionsChanged = () => void refreshSessions(0);
  // One ended (Claude Code: its SessionEnd hook): a Close waiting for it goes on at once (core/close.ts).
  agent.onSessionEnded = (sessionId) => sessionEnded(sessionId);
  // Auto mode blocked one of a session's tool calls (Claude Code: its optional PermissionDenied hook): said.
  agent.onBlocked = (b) => void blocked(b);
  // A tool call the safety gate's rules flagged (core/guard.ts): its verdict, here.
  agent.onGuard = guardFor;
  // A session took a prompt in (Claude Code: its optional UserPromptSubmit hook): phone words typed
  // into it have started; and a Claude Code session's turn is watched for "Not logged in"
  // (core/login-check.ts; a T3 thread's prompt is told here too, and has no transcript to watch).
  // Asked first, by an agent whose hook can add to a prompt: whether it's your dictated words the app
  // just typed in there, or gave it as its first message (core/dictated.ts; app/starting.ts
  // agentDictated), so the agent is told they were spoken. Once each.
  agent.dictated = agentDictated;
  agent.onPromptSubmitted = (sessionId, prompt) => {
    talks.promptSubmitted(idsFor(sessionId), prompt);
    // Typed into its terminal, if the Mac had input just then (remote/seen-on-mac.ts).
    state.phone?.macUsed("prompt");
    if (loginWatched({ sessionId })) void loginWatch.watch(sessionId, prompt);
  };

  if (config.listenMode === "hands-free") await setListening("hands-free");
  if (config.phone) await setPhone(true);
  // What's installed already (a version `kiko update` put in), then a look at the feed when one's due: never waited for.
  updateChanged(updater.view());
  updater.start();
  const how =
    config.pttMode === "tap" ? (plain ? "Press Enter to start talking, Enter again to stop" : "Press space to start talking, space again to stop") : `Hold ${config.hotkey.replace(/_/g, " ")} to talk`;
  ui.info(`Ready. ${how}${state.handsFree?.on ? `, or say "${spokenName()}, …"` : ""}. Sessions speak up when they finish; your reply goes to the one that spoke last.`);
  ui.info(
    `Otherwise you're talking to the app: ask about sessions${voiceAllows(config.voiceCan, "message") ? ", pick one" : ""}${voiceAllows(config.voiceCan, "manage") ? ", or start one" : ""}. ` +
      `Voice can: ${labelIn(VOICE_CAN, config.voiceCan).toLowerCase()}. Classifier ${classifierEnabled() ? "on" : "off"}.`,
  );
  // Ready: the session area's starting state goes once the sessions have been looked at (Kiko's page in its place by then);
  // the splash goes then, the list drawn with them.
  void firstLook.then(() => state.windowGlue?.starting(null)).finally(() => splash?.ready());
  if (!config.playOnMac) ui.info("Play on this Mac is off (the phone app switches it): the voice plays on a phone with Play on phone on, and here while none is.");
  setTimeout(
    () => {
      state.macStandsIn = false;
      checkHeard();
    },
    config.phone ? PHONES_BACK_MS : 0,
  ).unref();
  if (config.pttMode === "tap" && plain) {
    const rl = createInterface({ input: process.stdin });
    rl.on("line", () => (floor.pressed && !state.voiceHolds ? keyUp() : keyDown()));
  }
  // The microphone not allowed for the app the helpers run in (renamed, reset, turned off): said, and
  // kept on the window's line until it is (app/mic-permission.ts), as the talk key's Input Monitoring is.
  // Whose permissions they are: the helper app's ("Kiko Dev"), else (null) the terminal app's.
  const holder = await platform.permissions.holder();
  // Kiko Dev's prototype of the Mac overlay (app/overlay.ts): off in the release.
  startOverlay(heardNow);
  void checkMic({
    mic: async () => (await platform.permissions.status()).mic,
    app: holder ?? terminalApp(),
    ...(holder ? { refresh: () => platform.permissions.refresh() } : {}),
    pane: platform.permissions.pane("mic"),
    say: (line) => {
      ui.info(line);
      state.windowGlue?.note(line);
    },
    waits: (line) => ui.set({ micOff: line }),
    log,
  });
  if (config.pttMode === "hold") {
    const hotkey = platform.hotkey.create(config.hotkey);
    state.hotkey = hotkey;
    hotkey.onDown = keyDown;
    hotkey.onUp = keyUp;
    // Without Input Monitoring it can't listen: said, and the app goes on (app/talk-key.ts). With
    // the helper app holding the permissions, it starts by itself once Input Monitoring is on.
    const started = await startTalkKey(hotkey, {
      input: async () => (await platform.permissions.status()).input,
      app: holder ?? terminalApp(),
      ...(holder ? { refresh: () => platform.permissions.refresh(), later: () => (state.hotkey = hotkey) } : {}),
      pane: platform.permissions.pane("input"),
      menu: keyWords(currentKey()),
      key: keyLabel(config.hotkey),
      say: (line) => {
        ui.info(line);
        state.windowGlue?.note(line);
      },
      // Stays on the window's line (and the header) until it's heard: a note under the list goes after a while.
      waits: (line) => ui.set({ talkKeyOff: line }),
      log,
    });
    if (!started) state.hotkey = null;
  }
}

/**
 * The TUI started (`startTui`), the screen taken from start.ts's splash for it (ui/splash-handoff.ts):
 * once the logo's effects are done there (`since` + LOGO_MS), so they play on in start.ts, smooth,
 * while the app gets through the rest of its start (busy: taken over at once, the TUI's next frame
 * came ~100 ms late, a visible stutter mid-sweep), and the TUI's first frame is the logo at rest, the
 * frame on the screen. At once without a splash painted there, when that's past, or when the splash
 * goes sooner (the window's menu); never once the app is stopping. A key pressed meanwhile waits
 * for the TUI, which takes it as a skip.
 */
function tuiAfterSplash(startTui: () => NonNullable<typeof tui>) {
  let timer: NodeJS.Timeout | undefined;
  const goes = (s: UiState) => {
    if (!s.splash || s.splash.leaving) show();
  };
  function show() {
    clearTimeout(timer);
    ui.off("change", goes);
    if (tui || exiting) return;
    // Its first frame the one on the screen (`drawn`); a splash already going: cleared for it.
    const s = ui.state.splash;
    const drawn = takeOver(s && !s.leaving ? "keep" : "clear");
    if (s && !s.leaving && drawn !== null) ui.set({ splash: { ...s, drawn } });
    tui = startTui();
  }
  const wait = typeof splashSince === "number" && ui.state.splash ? splashSince + LOGO_MS - Date.now() : 0;
  if (wait <= 0) return show();
  ui.on("change", goes);
  timer = setTimeout(show, wait);
}

/**
 * The splash (ui/splash.ts), from its first frame (`since`: start.ts painted it from then, while the
 * app loaded): drawn by the TUI (tui.ts Splash) over the whole window (window-zoom.ts), "Starting…"
 * under it once the app takes longer than the logo, and leaving when the app is ready (main), a key
 * is pressed (onAction) or it's been up long enough.
 */
function startSplash(since: number) {
  ui.set({ splash: { since, slow: Date.now() - since >= splashSoonest(), leaving: false } });
  splash = splashTimer(
    realClock,
    {
      slow() {
        const s = ui.state.splash;
        if (s && !s.leaving) ui.set({ splash: { ...s, slow: true } });
      },
      hide(why, ms) {
        log("splash", { why, ms });
        const s = ui.state.splash;
        if (s && !s.leaving) ui.set({ splash: { ...s, leaving: true } });
      },
    },
    { since },
  );
}

let exiting = false;
export function shutdown(code = 0) {
  if (exiting) process.exit(code); // a second Ctrl+C: go now (a lowered volume is put back next start)
  exiting = true;
  // Stopped before the TUI drew (Ctrl+C as it loads): the screen from start.ts's splash first.
  takeOver("clear");
  // Let every waiting session stop normally rather than hang until its hook times out.
  floor.releaseAll();
  standing.releaseAll();
  state.quick?.run.cancel();
  // Leave the TUI first, so the summary lands in the normal terminal.
  tui?.unmount();
  process.stdout.write(`${dim(sessionSummary(showsDollars()))}\n`);
  log("shutdown", { totals, code });
  agent.stop();
  state.phone?.stop();
  updater.stop();
  state.hotkey?.stop();
  state.handsFree?.stop();
  phoneListeners.stopAll();
  mic.stop();
  speaker.shutdown();
  say.stop();
  sttEngine.close();
  cartesia?.close();
  stopPocketWatch();
  pocket?.close();
  state.previewCartesia?.close();
  state.previewPocket?.close();
  // The volume back up before going (a moment, only if it's down); the state file keeps the note
  // until then, for the next start if this one is cut short. The Kiko window's bottom line says
  // it's stopped (unless the app is in it: start.ts closes the window then).
  void Promise.allSettled([duck.finish(), state.windowGlue?.stop()]).finally(() => {
    rmSync(STATE_FILE, { force: true });
    lock?.release();
    process.exit(code);
  });
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
// Its pane or terminal closed: stopped as on a quit (the waiting sessions let go, the volume put
// back, the lock released) rather than killed on the spot. Nothing can be shown any more, so a write
// to the terminal that fails on the way out is let be.
process.on("SIGHUP", () => {
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  shutdown(0);
});
// A throw or a rejection nothing caught (a listener, a timer, a `void` promise): logged as
// crash_caught, and the app keeps running; stopped as on a quit (exit 1) only when going on isn't
// safe: one that comes while it's already stopping (core/crash.ts fatalWhy).
const caught = crashCatcher({
  log,
  stopping: () => exiting,
  secrets: () => Object.values(keysInUse()),
  stop: (line) => {
    // Already stopping: the screen is the terminal's again, and shutdown(1) exits at once.
    if (!exiting) {
      tui?.unmount();
      takeOver("clear");
    }
    process.stderr.write(`${line}\n`);
    shutdown(1);
  },
});
process.on("uncaughtException", (err) => caught("exception", err));
process.on("unhandledRejection", (reason) => caught("rejection", reason));

main().catch((err) => {
  tui?.unmount();
  takeOver("clear");
  // A helper that won't build (a checkout's): one line, naming where swiftc's words are; anything else, its stack.
  const said = err instanceof HelperBuildError ? `${TITLE} ${err.message}.` : err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`${said}\n`);
  shutdown(1);
});
