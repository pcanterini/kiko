// The phone (src/remote/): what it asks of the app (phoneHub: its talk button and typed words, as
// presses in talk.ts; permission answers, catch-up, a new session, a session's menu), the server on
// and off, who plays what's said (Play on this Mac, checkHeard), and the Phone rows of the settings
// screen, with Pair a phone (its QR code: pairPhone).
//
// While Kiko Pro is on sale, the iPhone app comes with Pro or the free trial (core/account/phone-plan.ts;
// ./phone-plan.ts): without either, Pair a phone carries a PRO badge and offers them instead of the QR
// code (./phone-offer.ts), going on to the QR code once the plan is there; the server turns a phone
// away at connect (plan_required), and the Mac says so once a day; the relay is shown a pass.
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { aiUseNow, config } from "../core/config.ts";
import { findSession, idsOf } from "../core/sessions.ts";
import { checkAnswers } from "../core/ask.ts";
import type { Target } from "../core/decide.ts";
import { loadSettings, saveSettings, SETTINGS_FILE } from "../core/settings.ts";
import { NAME } from "../core/name.ts";
import type { Held } from "../agents/types.ts";
import { platform } from "../platform/index.ts";
import { CatchUp } from "../remote/catch-up.ts";
import { spokenMessage } from "../remote/chat.ts";
import { encodeQr } from "../core/qr.ts";
import { hostsFor, pairUrl } from "../remote/pair-link.ts";
import { RelayClient } from "../remote/relay-client.ts";
import { fileKeyStore, loadIdentity, type RelayIdentity } from "../remote/relay-identity.ts";
import { cpaceSelfCheck } from "../remote/cpace.ts";
import { selfCheck as tunnelSelfCheck } from "../remote/tunnel.ts";
import { PhoneServer, type PhoneHub } from "../remote/server.ts";
import { accountStatus } from "../remote/account-status.ts";
import { appAccount } from "../core/account/app-account.ts";
import { keyOf } from "../core/key-values.ts";
import type { Phone } from "../remote/pairing.ts";
import { keyStore } from "../platform/keys.ts";
import { ui, type SettingRow } from "../core/ui-store.ts";
import { log, totals } from "../core/log.ts";
import { settlePermission, settleQuestions } from "./announce.ts";
import { phoneNewSession, phoneSessionOptions } from "./new-session.ts";
import { renameSession, stopSession } from "./session-ops.ts";
import { applySetting, refreshSettings } from "./settings-screen.ts";
import { PHONE_WORDS } from "../core/account/phone-plan.ts";
import { phoneLive, proOnSale } from "../core/env.ts";
import { planForPhone, type OfferPick } from "./phone-offer.ts";
import { keepRelayPass, phoneIncludedNow, phonePlanNow, phoneRefused, trialOfferable } from "./phone-plan.ts";
import { openUrl, refreshPlan } from "./settings/account.ts";
import { macSignIn, phoneOpenedSignIn } from "./mac-sign-in.ts";
import { openSpeech, stopTalking, ttsCost } from "./speech.ts";
import { standing } from "./standing.ts";
import { answerTrustCard, trustCards } from "./starting.ts";
import { audio, catchUpWriter, floor, heldWhere, macPlays, pairing, say, speaker, state } from "./state.ts";
import { phoneListen, phoneListenAudio, phoneListenPlaying, phoneListeners, phoneTalkAudio, phoneTalkEnd, phoneTalkStart, phoneTyped, phoneVoiceHolds } from "./talk.ts";

// ── The phone ───────────────────────────────────────────────────────────────

/**
 * What the phone does, handled as the Mac's own key and keys are (src/remote/server.ts only
 * translates): its talk button holds the floor like the push-to-talk key, its audio goes through
 * the same speech-to-text, and its words, spoken or typed, through act() like any others.
 */
export const phoneHub: PhoneHub = {
  talkStart(sessionId, phoneId, talkId, dictate) {
    const to = phoneTarget(sessionId);
    if (to === undefined) return "no_session";
    return phoneTalkStart(to, phoneId, talkId, dictate);
  },
  talkAudio: (pcm) => phoneTalkAudio(pcm),
  talkEnd(cancel) {
    if (!state.phoneHolds) return;
    void phoneTalkEnd(cancel);
  },
  type(text, sessionId, phoneId, talkId) {
    const to = phoneTarget(sessionId);
    if (to === undefined) return "no_session";
    return phoneTyped(text, to, phoneId, talkId);
  },
  permission(id, decision, phoneId) {
    // A trust card up, whether or not it's the one shown now (it stays up until it's settled).
    const trust = trustCards.up().find((q) => promptIds.get(q) === id);
    if (trust) {
      stopTalking("phone_permission", { causeSessionId: trust.sessionId });
      state.pressAt = `phone:${phoneId}`;
      log("phone_permission", { sessionId: trust.sessionId, decision });
      answerTrustCard(trust, decision === "allow", "phone", decision === "deny" ? "No." : "Yes.");
      return null;
    }
    const asked = floor.waiting;
    // The one being asked, else one held waiting its turn or standing after its window
    // (permission_prompt `queued`): answered as it is, without cutting what's being said meanwhile.
    const waiting = asked?.isPermission && promptIds.get(asked) === id ? asked : queuedPrompt(id);
    if (!waiting) return "prompt_gone";
    const queued = waiting !== asked;
    const stood = standing.has(waiting);
    if (!queued) stopTalking("phone_permission", { causeSessionId: waiting.sessionId });
    state.pressAt = `phone:${phoneId}`;
    log("phone_permission", { sessionId: waiting.sessionId, decision, ...(queued ? { queued: true } : {}), ...(stood ? { standing: true } : {}) });
    // Questions take answers, not a yes: an app that only knows Allow leaves them in the terminal.
    if (waiting.questions && decision === "allow") {
      if (stood) {
        standing.release(waiting, "left");
        return null;
      }
      if (queued) return null; // not asked yet: they're asked in their turn
      floor.release(waiting, `the questions are waiting ${heldWhere(waiting)}`);
      floor.drain();
      return null;
    }
    // Always: for good where it can be (the prompt said canAlways), else once, as the Mac's `a` on its card.
    settlePermission(waiting, decision === "always" ? "allow_always" : decision, decision === "deny" ? "No." : "Yes.", "phone");
    return null;
  },
  // Up though maybe not the one shown: a trust card, or a prompt standing after its window.
  promptUp: (id) => [...trustCards.up(), ...standing.list()].some((q) => promptIds.get(q) === id),
  answers(id, answers, phoneId) {
    const asked = floor.waiting;
    const waiting = asked?.questions && promptIds.get(asked) === id ? asked : queuedPrompt(id);
    if (!waiting?.questions) return "prompt_gone";
    const checked = checkAnswers(waiting.questions, answers);
    if (!checked) return "bad_answers";
    if (waiting === asked) stopTalking("phone_answers", { causeSessionId: waiting.sessionId });
    state.pressAt = `phone:${phoneId}`;
    log("phone_answers", { sessionId: waiting.sessionId, answers: checked });
    settleQuestions(waiting, checked);
    return null;
  },
  talking: () => state.phoneHolds,
  playOnMac(on, phoneId) {
    if (on === config.playOnMac) return;
    saveSettings({ ...loadSettings(), playOnMac: on });
    setPlayOnMac(on, { by: "phone", phoneId });
    refreshSettings();
  },
  // Each waits its turn in the speech lock, in order, behind whatever is being said; a press
  // (stopTalking) cuts the one playing and drops the rest, and so does the phone's Stop. Not on
  // screen again: they were then.
  catchUp(lines) {
    ui.info(`(phone: catching up, ${lines.length} ${lines.length === 1 ? "line" : "lines"})`);
    catchingUp.lines(lines);
  },
  catchUpSummary(items) {
    ui.info(`(phone: catching up on ${items.length} ${items.length === 1 ? "update" : "updates"})`);
    catchingUp.summary(items);
  },
  catchUpStop() {
    const stopped = catchingUp.stop();
    if (stopped) ui.info("(phone: catch-up stopped)");
    return stopped;
  },
  newSessionOptions: () => phoneSessionOptions(),
  newSession: (ask, phoneId, heard) => phoneNewSession(ask, phoneId, heard),
  // A session's screen: its menu's Interrupt, Rename and Close, as the window's menus do them (the
  // server checked canDo); shown, not said, and what came of it told to that phone.
  sessionAction(sessionId, action, name, phoneId) {
    const session = findSession(ui.state.sessions, sessionId);
    if (!session) return "no_session";
    const tell = (line: string) => state.phone?.sessionNote(phoneId, session.sessionId, line);
    if (action === "interrupt") void stopSession(session, "phone", tell);
    else if (action === "rename") void renameSession(session, name ?? "", "phone", tell);
    else if (!state.windowGlue) tell(`Close works while ${NAME}'s window is open on the Mac.`);
    else void state.windowGlue.close(session.sessionId, tell);
    return null;
  },
  // A message's Hear it again: as a missed line's play button, its words through the usual speech
  // (Markdown's marks and code left out), behind whatever is being said.
  hear(text) {
    const line = spokenMessage(text);
    if (!line) return;
    ui.info("(phone: hearing a message again)");
    catchingUp.lines([line]);
  },
  // Its Hands-free: the Mac's hands-free on what that phone's mic hears (talk.ts phoneListeners).
  async listen(phoneId, on, why) {
    const error = await phoneListen(phoneId, on, why);
    if (!error && (on || why === "phone")) ui.info(on ? "(phone: hands-free on)" : "(phone: hands-free off)");
    return error;
  },
  listenAudio: (phoneId, pcm) => phoneListenAudio(phoneId, pcm),
  listenPlaying: (phoneId, playing) => phoneListenPlaying(phoneId, playing),
  voiceFrom: () => phoneVoiceHolds(),
};

// The phone's Catch me up (src/remote/catch-up.ts), through the usual speech.
export const catchingUp = new CatchUp({
  open: () => openSpeech(),
  summarize: async (updates, onText) => {
    const r = await catchUpWriter.catchUp(updates, onText);
    if (r) totals.llm += r.costUsd;
    return r;
  },
  cancelSummary: () => catchUpWriter.cancel(),
  // As a press: an announcement waiting behind it that wasn't heard yet is made again after.
  cut: () => {
    floor.deferUnheard("preview");
    floor.bump();
    stopTalking("phone_stop");
  },
  quiet: () => audio.quiet(),
  changed: (on) => ui.set({ catchingUp: on }),
  voiceCost: (speech) => ttsCost(speech.chars()),
  log,
});

// Each permission prompt's id, for the phone's answer to say which one it answers.
const promptIds = new WeakMap<Held, string>();
/**
 * A prompt Kiko holds open but isn't asking now (in line, behind a reply being read out, or standing
 * after its window: ./standing.ts), by the id the phone has for it. Null: gone (prompt_gone).
 */
function queuedPrompt(id: string): Held | null {
  return [floor.current, ...floor.queue, ...standing.list()].find((r) => r?.open && r.isPermission && promptIds.get(r) === id) ?? null;
}

export function promptId(request: Held) {
  let id = promptIds.get(request);
  if (!id) promptIds.set(request, (id = randomUUID()));
  return id;
}

/** The session a phone screen talks in: null for none (the home screen), undefined when it isn't running. */
function phoneTarget(sessionId: string | null): Target | null | undefined {
  if (sessionId === null) return null;
  const session = findSession(ui.state.sessions, sessionId);
  return session ? { sessionId: session.sessionId, cwd: session.cwd } : undefined;
}

/** Every ID the session a hook names goes by: as named, and as listed (a talk was delivered to that). */
export function idsFor(sessionId: string) {
  const session = findSession(ui.state.sessions, sessionId);
  return session ? [sessionId, ...idsOf(session)] : [sessionId];
}

/**
 * Turns the phone server on or off (the setting, and on start). Says so when it can't listen.
 * Never on while the iPhone app isn't out (core/env.ts phoneLive): no server, relay or Bonjour.
 */
export async function setPhone(on: boolean) {
  if (on && !phoneLive()) {
    log("phone_off", { why: "not_live" });
    return;
  }
  if (on && !state.phone) {
    passKeeper?.stop();
    passKeeper = null;
    const identity = await phoneIdentity();
    if (!identity) {
      if (ui.state.pairQr?.phase === "starting") closePairQr("phone_off");
      return refreshSettings();
    }
    if (state.phone || !config.phone) {
      // On already (raced): Pair a phone's code now; off again meanwhile: setPhone(false) closed it.
      if (state.phone && ui.state.pairQr?.phase === "starting") showPairQr();
      return refreshSettings();
    }
    // Whether you're at the Mac, read as a line goes to a phone that's away: then it doesn't buzz.
    const atComputer = () => platform.presence.atComputer();
    const server = new PhoneServer({
      identity,
      hub: phoneHub,
      pairing,
      port: config.phonePort,
      host: config.phoneHost,
      changed: phonesChanged,
      paired: phonePaired,
      missedFile: join(dirname(SETTINGS_FILE), "missed.json"),
      atComputer,
      // Said out loud here (a line said while you're at the Mac was seen here: remote/seen-on-mac.ts).
      macHears: () => macPlays() && !state.muted,
      // The plan and trial status, as Settings → Account has it; none while accounts aren't open.
      account: phoneAccount,
      // The iPhone app comes with Kiko Pro or the trial, while Pro is on sale: asked at each connect.
      phonePlan: () => phonePlanNow(),
      planRefused: (phone, plan) => {
        if (phone) phoneRefused(plan.trialAvailable, { reason: plan.reason });
      },
      // Signed out: a paired phone turned away can sign this Mac in (app/mac-sign-in.ts, shared with Enter here).
      macSignIn,
      signInOpened: () => phoneOpenedSignIn(),
    });
    state.phone = server;
    try {
      await startRelay(server, identity);
      await server.start();
    } catch (err) {
      relay?.stop();
      relay = null;
      state.phone = null;
      const message = err instanceof Error ? err.message : String(err);
      log("error", { where: "phone_server", message });
      ui.error("phone", `Couldn't listen for the phone on port ${config.phonePort}: ${message}`);
      if (ui.state.pairQr?.phase === "starting") closePairQr("phone_off");
      return refreshSettings();
    }
    // Turned off again meanwhile.
    if (!config.phone) return setPhone(false);
    // No phone yet: the code to pair the first one, at once (only with the plan for it: a phone couldn't pair without).
    if (!pairing.list().length && phoneIncludedNow()) openPairing();
    await refreshAddresses();
    ui.info(`Phone: on. Connect to ${connectLine()}; pair in Settings → Phone → Pair a phone.`);
    // Pair a phone turned it on: its QR code now.
    if (ui.state.pairQr?.phase === "starting") showPairQr();
  } else if (!on && state.phone) {
    passKeeper?.stop();
    passKeeper = null;
    relay?.stop();
    relay = null;
    phoneListeners.stopAll();
    state.phone.stop();
    state.phone = null;
    pairing.close();
    if (ui.state.pairQr) closePairQr("phone_off");
    ui.info("Phone: off.");
  } else if (!on && ui.state.pairQr) {
    closePairQr("phone_off"); // turned off while it was still turning on
  }
  refreshSettings();
  checkHeard();
}

// The Mac's end of the relay, while Phone is on and KIKO_RELAY_URL names one, and its pass kept (while Pro is on sale).
let relay: RelayClient | null = null;
let passKeeper: { stop(): void; kick(): void } | null = null;
/** When a pass the relay said was revoked was last asked for afresh. */
let revokedAskedAt = 0;

/**
 * This Mac's keys for the phone (relay-identity.ts): every phone's connection is encrypted to its
 * static key, at home and through the relay. From the Keychain (made there the first time), or with
 * the Keychain off from a file of its own next to phones.json. Null (said, and logged) when they
 * can't be had or this runtime's crypto can't run the tunnel: Phone stays off, since a phone could
 * only be turned away.
 */
async function phoneIdentity(): Promise<RelayIdentity | null> {
  const store = keyStore ?? fileKeyStore(join(dirname(SETTINGS_FILE), "device-key.json"));
  let identity: RelayIdentity | null;
  try {
    identity = await loadIdentity(store);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("phone_off", { why: "keychain", message });
    ui.error("phone", `Phone stays off: couldn't read this Mac's phone key from ${store.where} (${message}). The phone's connection is encrypted with it.`);
    return null;
  }
  // This runtime's crypto runs the whole tunnel, or nothing would connect (0.2.0 on Bun, with no
  // ChaCha20-Poly1305 in its node:crypto, refused every phone through the relay).
  const broken = tunnelSelfCheck() ?? cpaceSelfCheck();
  if (broken || !identity) {
    log("phone_off", { why: "crypto", message: broken ?? "no key" });
    ui.error("phone", `Phone stays off: this Mac can't encrypt the phone's connection (${broken ?? "no key"}). Update ${NAME}.`);
    return null;
  }
  return identity;
}

/** The relay, when KIKO_RELAY_URL names one: this Mac's room opened with its keys. */
async function startRelay(server: PhoneServer, identity: RelayIdentity) {
  const url = config.relayUrl;
  if (!url) return;
  if (!/^wss?:\/\/[^/]+/.test(url)) return log("relay_off", { why: "bad_url" });
  if (state.phone !== server) return; // turned off meanwhile
  server.setRelay({ url, room: identity.room, macKey: identity.static.public.toString("base64"), signingKey: identity.signing.public.toString("base64") });
  const client = new RelayClient({
    url,
    identity,
    pairing,
    server,
    // The relay turned a phone away for the plan: said as a refusal at home is (only when the plan,
    // as this Mac knows it, really is missing: the relay's word alone changes nothing). A pass the
    // relay's revocation list refused (issued before a sign-out, a ban, a plan's end): asked for
    // afresh, once a minute at most, since one issued now works if the account has the plan again
    // (the one held is kept until a new one comes). The Mac's own sign-in refused: no phone tried, so
    // nothing is said.
    planRefused: (pass, o) => {
      if (pass === "revoked" && Date.now() - revokedAskedAt >= 60_000) {
        revokedAskedAt = Date.now();
        appAccount()?.forgetPass();
        passKeeper?.kick();
      }
      if (o?.macRefused) return;
      const plan = phonePlanNow();
      if (plan && !plan.ok) phoneRefused(plan.trialAvailable, { reason: plan.reason });
    },
    // The pass goes in the upgrade (the room lets a Mac with one in first): the first dial waits a
    // little for it, while there's one to wait for.
    ...(proOnSale() ? { passFirstMs: 5_000 } : {}),
  });
  relay = client;
  // Asked for first, so the first dial can carry it.
  passKeeper = keepRelayPass(identity.room, (pass) => client.setPass(pass));
  relay.start();
}

/**
 * The Mac's plan and trial status for the phones (remote/account-status.ts): the account as last
 * known (account.json), whether your own OpenRouter key runs Kiko's AI, and the Mac's own words
 * for the plan and the keys in use (config.ts aiUseNow, plan-words.ts aiWords). Null while accounts
 * aren't open (core/env.ts accountsLive): nothing is sent then.
 */
function phoneAccount() {
  const a = appAccount();
  return a ? accountStatus(a.view(), Boolean(keyOf("OPENROUTER_API_KEY").trim()), Date.now(), { use: aiUseNow(), ...(proOnSale() ? { phone: phoneIncludedNow() } : {}) }) : null;
}

/** Phones came or went, paired, were forgotten, or switched Play on phone. */
function phonesChanged() {
  refreshSettings();
  checkHeard();
  // The typed code under the QR code: closed meanwhile (too many wrong tries), it isn't shown.
  const shown = ui.state.pairQr;
  if (shown?.phase === "showing" && shown.code && !pairing.current()) ui.set({ pairQr: { ...shown, code: null } });
}

// ── Pair a phone: the QR code ───────────────────────────────────────────────

/** How long "✓ <phone> paired" stays before the pairing screen closes. */
const PAIRED_SHOWN_MS = 2_500;
let pairQrTimer: NodeJS.Timeout | null = null;

/**
 * Settings → Phone → Pair a phone: "open" shows a QR code to pair a phone with nothing typed
 * (src/remote/pair-link.ts), the 6-digit code beneath it for a phone without a camera; "close" (Esc)
 * closes it, and the code stops working. Phone off: turned on first (the settings screen does that),
 * and the code shows once it's listening.
 */
export function pairPhone(value: string) {
  if (!phoneLive()) return closePairQr("phone_off");
  if (value === "trial" || value === "month" || value === "year") return void offerThenPair(value);
  if (value !== "open") return closePairQr("closed");
  // Without the plan (Pro on sale): the offer, never the QR code (the row's choices are the offer).
  if (!phoneIncludedNow()) return ui.info(`(${PHONE_WORDS.offer})`);
  if (state.phone) return showPairQr();
  ui.set({ pairQr: { phase: "starting" } });
}

/** The offer being carried out (signing in, the trial, the checkout): Esc stops it. */
let offer: AbortController | null = null;

/**
 * Pair a phone's offer picked: the trial started or Pro bought (./phone-offer.ts) on the pairing
 * screen, then straight on to the QR code (Phone turned on first if it's off), or why not, there.
 */
async function offerThenPair(pick: OfferPick) {
  const a = appAccount();
  if (!a) return;
  offer?.abort();
  const stop = new AbortController();
  offer = stop;
  ui.set({ pairQr: { phase: "plan", step: pick === "trial" ? "trial" : "checkout" } });
  const end = await planForPhone(pick, {
    account: a,
    open: openUrl,
    show: (step) => {
      if (offer === stop) ui.set({ pairQr: step });
    },
    phones: () => pairing.list().length,
    signal: stop.signal,
  }).catch((err) => ({ ok: false as const, said: err instanceof Error ? err.message : String(err) }));
  log("phone_offer", { pick, ok: end.ok, stopped: stop.signal.aborted });
  refreshPlan(a);
  state.phone?.accountChanged();
  passKeeper?.kick();
  refreshSettings();
  if (offer !== stop) return; // closed (Esc), or another pick
  offer = null;
  if (!end.ok) {
    if (end.said) ui.set({ pairQr: { phase: "plan", step: "failed", line: end.said } });
    else ui.set({ pairQr: null });
    return;
  }
  if (state.phone) return showPairQr();
  ui.set({ pairQr: { phase: "starting" } });
  if (!config.phone) applySetting("phone", true);
}

/** A new QR code (the one before stops working), for QR_MS; the typed code opened beside it if it isn't. */
function showPairQr() {
  const server = state.phone;
  if (!server) return;
  const offer = pairing.openQr();
  if (!pairing.current()) openPairing();
  const hosts = hostsFor(server.addresses());
  const relay = server.relayInfo();
  // Nowhere a phone could reach: no code worth scanning, but the typed code still works over an address typed in.
  const qr = hosts.length ? encodeQr(pairUrl({ name: server.hubName, hosts, port: server.port, secret: offer.secret, macKey: server.macKey, ...(relay ? { relay } : {}) })) : null;
  ui.set({
    pairQr: {
      phase: "showing",
      qr,
      code: pairing.current()?.code ?? null,
      until: offer.until,
      ...(qr ? {} : { why: "This Mac isn't on a network the phone can reach (no Wi-Fi, Ethernet or Tailscale address)." }),
    },
  });
  // Never the secret, nor the code: only that one is up, for how long, and what it holds.
  log("phone_pairing_qr", { open: true, until: offer.until, hosts: hosts.length, relay: Boolean(relay), version: qr?.version ?? null });
  if (pairQrTimer) clearTimeout(pairQrTimer);
  pairQrTimer = setTimeout(() => closePairQr("expired"), Math.max(0, offer.until - Date.now()));
  pairQrTimer.unref();
  refreshSettings();
}

/** The pairing screen closes, and its QR code stops working (the typed code goes on as before). */
function closePairQr(why: "closed" | "expired" | "paired" | "phone_off") {
  // The offer being carried out (signing in, the checkout) stops with its screen.
  offer?.abort();
  offer = null;
  if (pairQrTimer) clearTimeout(pairQrTimer);
  pairQrTimer = null;
  pairing.closeQr();
  if (!ui.state.pairQr) return;
  ui.set({ pairQr: null });
  log("phone_pairing_qr", { open: false, why });
  if (why === "expired") ui.info("The pairing QR code expired after 5 minutes: Settings → Phone → Pair a phone shows a new one.");
}

/** A phone paired (by the QR code or the typed code): the pairing screen says so, then closes. */
function phonePaired(phone: Phone, how: "code" | "qr") {
  const shown = ui.state.pairQr;
  if (!shown || shown.phase === "paired") return;
  if (pairQrTimer) clearTimeout(pairQrTimer);
  pairing.closeQr();
  ui.set({ pairQr: { phase: "paired", phone: phone.name } });
  log("phone_pairing_qr", { open: false, why: "paired", how });
  pairQrTimer = setTimeout(() => {
    pairQrTimer = null;
    if (ui.state.pairQr?.phase === "paired") ui.set({ pairQr: null });
  }, PAIRED_SHOWN_MS);
  pairQrTimer.unref();
}

/** Play on this Mac, switched from a phone (the Mac has no setting for it): applies at once. Off, what the Mac is playing stops now. */
function setPlayOnMac(on: boolean, by: { by: "phone"; phoneId: string }) {
  config.playOnMac = on;
  if (!on) {
    speaker.silence();
    say.silence();
  }
  ui.set({ playOnMac: on });
  log("mac_play", { on, ...by });
  checkHeard();
}

/**
 * Says so once when the Mac stands in for the phone: Play on this Mac is off and no phone plays what's
 * said (none connected with Play on phone on, or its app in the background or locked), so the Mac
 * plays it (macPlays), from the next thing said; and once when a phone plays it again.
 */
export function checkHeard() {
  if (ui.state.macPlays !== macPlays()) ui.set({ macPlays: macPlays() }); // the header's "silent on this Mac"
  if (state.macStandsIn === null) return;
  const standIn = !config.playOnMac && !state.phone?.audible();
  if (standIn === state.macStandsIn) return;
  state.macStandsIn = standIn;
  log("mac_stands_in", { on: standIn, phones: state.phone?.connected().length ?? 0 });
  if (standIn) ui.info("Play on this Mac is off, but no phone is playing what's said, so the Mac plays it until one is back.");
  else if (!config.playOnMac) ui.info("A phone plays what's said again, so this Mac is quiet.");
}

function openPairing() {
  pairing.open();
  log("phone_pairing", { open: true });
}

/** Where the phone finds this Mac, for the settings screen. */
export async function refreshAddresses() {
  try {
    state.phoneAddresses = await platform.network.addresses();
  } catch {
    state.phoneAddresses = [];
  }
  refreshSettings();
}

const atPort = (address: string) => `${address}:${state.phone?.port || config.phonePort}`;

function connectLine() {
  const lan = state.phoneAddresses.find((a) => a.kind === "lan");
  const tailscale = state.phoneAddresses.find((a) => a.kind === "tailscale");
  const parts = [lan && atPort(lan.address), tailscale && `Tailscale ${atPort(tailscale.address)}`].filter(Boolean);
  return parts.length ? parts.join(" · ") : `port ${state.phone?.port || config.phonePort} (no network found)`;
}

/** The Phone section of the settings screen: none while the iPhone app isn't out (core/env.ts phoneLive). */
export function phoneRows(): SettingRow[] {
  if (!phoneLive()) return [];
  const code = pairing.current();
  const phones = pairing.list();
  const connected = new Set(state.phone?.connected().map((p) => p.id) ?? []);
  const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return [
    { key: "phone", label: "Phone", raw: config.phone, value: config.phone ? (state.phone ? `On (${connected.size} connected)` : "On (not listening)") : "Off", restart: false },
    pairRow(),
    {
      key: "phoneConnect",
      label: "Connect to",
      raw: JSON.stringify(
        state.phoneAddresses.map((a) => ({ value: atPort(a.address), label: atPort(a.address), hint: a.kind === "tailscale" ? "Tailscale, from anywhere" : `home network (${a.interface})` })),
      ),
      value: state.phone ? connectLine() : "Turn Phone on first",
      restart: false,
    },
    { key: "phonePairing", label: "Pairing code", raw: code?.code ?? "", value: code ? `${code.code} (until ${time(code.until)})` : "Closed", restart: false },
    {
      key: "phones",
      label: "Paired phones",
      raw: JSON.stringify(phones.map((p) => ({ id: p.id, name: p.name, pairedAt: p.pairedAt, connected: connected.has(p.id) }))),
      value: phones.length ? phones.map((p) => `${p.name}${connected.has(p.id) ? " ●" : ""}`).join(", ") : "None",
      restart: false,
    },
  ];
}

/**
 * Pair a phone: the QR code; without the plan for the phone (Pro on sale), a PRO badge and the offer
 * (its raw says so, and whether the trial can still start: settings-options.ts phonePair's choices).
 */
function pairRow(): SettingRow {
  const row: SettingRow = { key: "phonePair", label: "Pair a phone", raw: "", value: config.phone ? "QR code" : "QR code (turns Phone on)", restart: false };
  if (phoneIncludedNow()) return row;
  return { ...row, raw: JSON.stringify({ offer: true, trial: trialOfferable() }), value: `With ${NAME} Pro or the free trial`, tag: PHONE_WORDS.badge, note: PHONE_WORDS.offer };
}

/** Pairing and the paired phones, from the settings screen. */
export function phoneAction(key: "phoneConnect" | "phonePairing" | "phones", value: string) {
  if (!phoneLive()) return refreshSettings();
  if (key === "phonePairing") {
    if (value === "open") {
      if (!state.phone) return ui.info("(turn Phone on first)");
      if (!phoneIncludedNow()) return ui.info(`(${PHONE_WORDS.pairingCode})`);
      openPairing();
    } else {
      pairing.close();
      log("phone_pairing", { open: false });
    }
  } else if (key === "phones" && value.startsWith("forget:")) {
    const id = value.slice("forget:".length);
    if (state.phone) state.phone.forget(id);
    else log("phone_forgotten", { phoneIds: pairing.forget(id) });
  }
  refreshSettings();
}
