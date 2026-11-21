// What the sessions bring to you: a finished turn read out (announce: the classifier's verdict, a summary, the
// reply window), auto mode's blocks, permission prompts and Claude's questions asked and answered
// (by voice, the Mac's card, a phone), "repeat that" and "tell me more".
import { homedir } from "node:os";
import { config } from "../core/config.ts";
import { phoneLive } from "../core/env.ts";
import { flat, shortPath } from "../core/text.ts";
import { promptKey } from "../core/dictated.ts";
import type { Voice } from "../core/summarizer.ts";
import { feedbackEvent, feedbackKind, replyIdOf } from "../core/summary-feedback.ts";
import type { Said } from "../core/unplayed.ts";
import { findSession, folderName, idsOf, sessionName, spoken, type Session } from "../core/sessions.ts";
import { classifierEnabled } from "../core/classifier.ts";
import { readOnlyAllowed } from "../core/auto-allow.ts";
import { decideRisk, decideStop, describeTool, type ApprovalDecision } from "../core/decisions.ts";
import { Asking, askWhat, ASK_TOOL, matchAnswer, spokenAnswer, type Answer } from "../core/ask.ts";
import { matchByModel } from "../core/ask-model.ts";
import type { Decision, Target } from "../core/decide.ts";
import type { Unheard } from "../core/floor.ts";
import { isQuickCheck, QUICK_ALWAYS_FILE, quickAskLine } from "../core/quick-ask.ts";
import { voiceAllows } from "../core/routing-rules.ts";
import { reachOf } from "../core/reach.ts";
import type { Entry } from "../core/timeline.ts";
import { agentOf, mainAgent } from "../agents/index.ts";
import type { Held } from "../agents/types.ts";
import { terminalOf } from "../terminals/index.ts";
import { isTrust, trustLine, type TrustQuestion } from "../core/trust-prompt.ts";
import { ui } from "../core/ui-store.ts";
import { blockedLine, type Blocked } from "../core/permission-mode.ts";
import { BlockOverride, isOverride, modeWords, overridable, overrideAsk, retryLine, switchMode, switchTarget } from "../core/block-override.ts";
import { guardLine, guardOf } from "../core/guard.ts";
import { NAME } from "../core/name.ts";
import { plainPermissionLine, spokenWhat } from "../core/spoken-permission.ts";
import { log, totals } from "../core/log.ts";
import { replyTimingLine } from "../core/cost-lines.ts";
import { writeState } from "./status.ts";
import { idsFor, promptId } from "./phone.ts";
import { quickAsked } from "./quick-task.ts";
import { allowed, turnOnVoice } from "./session-ops.ts";
import { TURN_ON } from "../core/voice-off.ts";
import { modelName } from "./settings/voice.ts";
import { cue, openSpeech, speakLine, ttsCost } from "./speech.ts";
import { answeredLate, closedStanding, noteAsked, noteHeld, standing, standsFor, turnEnded, watchHeld } from "./standing.ts";
import { answerTrustCard, getSessions } from "./starting.ts";
import {
  ASKED_MAX,
  OWN_TYPING_MS,
  QUIET_NEEDS_USER,
  QUIET_WORTH,
  RISKY,
  arrivals,
  asking,
  audio,
  currentName,
  dictated,
  explainer,
  floor,
  heldReplies,
  heldWhere,
  linesOf,
  nameOf,
  now,
  ownTyping,
  refOf,
  say,
  secs,
  shown,
  state,
  summarizer,
  talks,
  textOnly,
  timeline,
  unplayed,
  whatOf,
} from "./state.ts";

/** Recent conversation with one session, for its summary: `held` is its finished turn. */
export function contextFor(sessionId: string, folder: string, held: Held) {
  const lines = linesOf(timeline.recent(4, sessionId));
  if (lines.length) return lines;
  const asked = held.lastAsked();
  return asked ? [`you → ${folder}: ${flat(asked, 200)}`] : [];
}

/**
 * Your words to a session during the turn it just finished, for its summary to answer first: from
 * its own record, which has words typed by hand and sent while it was busy too; else what the app
 * sent it since its last turn. The last few, each cut short.
 */
export function askedOf(sessionId: string, held: Held) {
  const said = held.saidThisTurn() ?? timeline.sentSinceTurn(sessionId).map((e) => e.text);
  return said.slice(-ASKED_MAX).map((text) => flat(text, 300));
}

// ── Sessions that finished ──────────────────────────────────────────────────

export function onRequest(request: Held) {
  // A call that only reads (core/auto-allow.ts): allowed now, this once, never said, carded or sent
  // to a phone; a line on Kiko's page says so. Whatever Permissions by voice is: it's not asked at all.
  if (request.isPermission && config.autoAllowReads && allowReadOnly(request)) return;
  if (request.isPermission && !config.voicePermissions) {
    request.release();
    return;
  }
  // Claude's questions that can't be read can't be answered here: asking "Allow?" of them answers
  // nothing (an allow without answers leaves them in the terminal anyway), so they go there now.
  if (request.tool?.name === ASK_TOOL && !request.questions) {
    log("ask_unreadable", { sessionId: request.sessionId });
    request.release();
    return;
  }
  if (isQuickCheck(request.sessionId)) {
    const asked = quickAsked(request);
    if (!asked) return;
    request = asked;
  }
  noteHeld(request);
  // Answered in its own window meanwhile (Claude Code's dialog beside its held hook): taken down (app/standing.ts).
  watchHeld(request);
  request.onClosed = () => {
    // Standing after its window (app/standing.ts): taken down from the Mac and every phone (as
    // answered in its terminal when its agent said so: OpenCode's permission.replied).
    if (closedStanding(request)) return;
    floor.closed(request, `(${nameOf(refOf(request))} stopped waiting)`);
    // One still in line is gone from the phone's cards too (permission_prompt queued).
    if (request.isPermission) writeState();
  };
  // One the safety gate asked, let go unanswered (its window ran out): logged (Claude Code then asks
  // in its window; Codex's hook denies it).
  const gated = guardOf(request);
  if (gated) {
    log("guard_held", { agent: gated.agent, sessionId: request.sessionId, kind: gated.kind, rule: gated.rule });
    const release = request.release.bind(request);
    request.release = () => {
      const letGo = release();
      if (letGo) log("guard_answer", { agent: gated.agent, sessionId: request.sessionId, kind: gated.kind, rule: gated.rule, answer: "none" });
      return letGo;
    };
  }
  // Phone words typed into it while it was busy and taken in during this turn have started; every
  // phone talk this turn worked on has its reply (talk_status replied: the phone stops waiting).
  if (!request.isPermission) talks.turnEnded(idsFor(request.sessionId), () => request.saidThisTurn());
  // Dictated words typed into it while it was busy that it took in as the turn went: no prompt hook
  // came for those, and none will (core/dictated.ts reached).
  if (!request.isPermission) dictated.reached(idsFor(request.sessionId), () => request.saidThisTurn());
  if (!request.isPermission) watchTyping(request);
  // Its turn went on past any prompt of its still standing (answered in its window): those are over.
  if (!request.isPermission) turnEnded(request.sessionId);
  // In line; a permission prompt ahead of finished turns, taking over from one waiting out its window.
  floor.add(request);
  // A prompt that only went in line (a reply being read out, another asked) is on the phone at once all the same.
  if (request.isPermission) writeState();
}

/**
 * Allows a prompt whose call only reads, once (never "don't ask again"), and says so on Kiko's page:
 * true when it did. One that might have been but wasn't is logged with why (`auto_allow_skipped`),
 * so a reader that still asks can be found and added.
 */
function allowReadOnly(request: Held) {
  const read = readOnlyAllowed(request, (why) => log("auto_allow_skipped", { sessionId: request.sessionId, agent: request.agent, tool: request.tool?.name, why }));
  if (!read || !request.allow(false)) return false;
  log("auto_allowed", { sessionId: request.sessionId, agent: request.agent, tool: request.tool?.name, what: read.what, why: read.why });
  ui.info(`${nameOf(refOf(request))}: allowed, only reads: ${flat(read.what, 80)}`);
  return true;
}

/**
 * While the app holds a finished turn (queued, or waiting out its window), what you type into that
 * session sits in Claude Code's queue until the hook lets go. So once you do, it lets go: you've
 * moved on, and an announcement not made yet isn't.
 */
function watchTyping(request: Held) {
  const id = request.sessionId;
  request.watchTyped((content) => {
    if (!request.open || typedByApp(id, content)) return;
    const name = nameOf(refOf(request));
    log("typed_in", { sessionId: id, announced: floor.current === request, text: content });
    state.phone?.sessionReplied(id);
    state.phone?.macUsed("typed");
    floor.typedIn(request, `you typed in ${name}; let it go`);
  });
}

/** Remembers words the app types into a session, so their queued prompt isn't taken for yours. */
export function noteTyped(sessionId: string, text: string) {
  // Watched too, whichever terminal it goes through: whether it comes in whole (core/arrived.ts).
  arrivals.typing(sessionId, text);
  const recent = (ownTyping.get(sessionId) ?? []).filter((t) => Date.now() - t.at < OWN_TYPING_MS);
  recent.push({ text: promptKey(text), at: Date.now() });
  ownTyping.set(sessionId, recent);
}

/**
 * Whether a queued prompt is words the app typed in lately; each counts once. Compared as the
 * dictated note is (core/dictated.ts promptKey): a long dictation comes back between Claude Code's
 * <pasted_content> lines, and is still the app's.
 */
function typedByApp(sessionId: string, content: string) {
  const recent = ownTyping.get(sessionId) ?? [];
  const key = promptKey(content);
  const i = recent.findIndex((t) => Date.now() - t.at < OWN_TYPING_MS && t.text === key);
  if (i < 0) return false;
  recent.splice(i, 1);
  return true;
}

/**
 * Starts an announcement (a new turn), tracked until it makes a sound (floor.ts deferUnheard),
 * noting what it's about to change: put back before it's heard, it's as if it was never made.
 */
function startUnheard(request: Held, entry: Entry | null): Unheard<Held> {
  const id = request.sessionId;
  const before = { target: state.target, lastAnnounced: state.lastAnnounced, lastSpoken: state.lastSpoken };
  return floor.announcing(request, () => {
    // Nothing was heard from it, so it's named when it's made again, isn't where your words go by
    // default, and "repeat that" isn't it.
    if (state.target?.sessionId === id) state.target = before.target;
    if (state.lastAnnounced === id) state.lastAnnounced = before.lastAnnounced;
    state.lastSpoken = before.lastSpoken;
    if (entry) delete entry.spoken;
  });
}

export async function announce(request: Held) {
  const id = request.sessionId;
  const name = nameOf(refOf(request));
  const titled = name !== folderName(request.cwd);
  const reply = request.text;
  // Made again after a press put it back: already in the timeline and on screen.
  const seen = shown.get(request);
  const context = seen?.context ?? contextFor(id, name, request);
  const asked = seen ? (seen.asked ?? []) : askedOf(id, request);
  const entry = seen?.entry ?? timeline.add({ who: "claude", sessionId: id, folder: name, text: reply });
  const mine = startUnheard(request, entry);
  const myTurn = mine.turn;
  state.target = refOf(request);
  const nameSession = state.lastAnnounced !== id;
  state.lastAnnounced = id;
  floor.spokeLast = null;
  if (!request.continued) heldReplies.set(id, 0);
  writeState();
  const record = seen ?? { entry, context, asked };
  if (!seen) shown.set(request, record);
  if (!record.onScreen) {
    record.onScreen = true;
    ui.session({ name, sessionId: id }, reply);
  }

  const start = now();
  let firstToken = 0;
  let firstSound = 0;
  let gateOpen = false;
  // Only its own sound counts as it being heard: not that of a line of the app's still playing ahead
  // of it (gateOpen waits for those), or a press during that line would take it as heard and cut it.
  // Another turn's sound (a permission prompt asked since) is that turn's own, as before.
  audio.onPlaying = say.onStart = () => {
    const own = gateOpen || myTurn !== floor.turn;
    if (myTurn === floor.turn && !firstSound && own) firstSound = now();
    floor.playing(own);
  };

  // How a reply gets there once the window closes, for the note it closes with.
  const reach = getSessions().then((sessions) => reachOf(findSession(sessions, id), request.desktop));
  // Who spoke, as its summary and the classifier put it: "Claude" for Claude Code, "Codex", "it" where its agent can't tell (T3 Code).
  const its = agentOf(request);
  const voice: Voice = { agent: its.name, speaker: its.speaker ?? "" };
  // The classifier (is this worth reading out? is Claude waiting on you?) and Haiku's summary run together;
  // the summary is held back until the classifier answers, so a quiet turn never makes a sound. Made again,
  // The classifier's verdict from the first time.
  const verdict = (record.verdict ??= classifierEnabled()
    ? decideStop({ claudeReply: reply, context, speaker: voice.speaker }).catch((err) => {
        log("error", { where: "classify_stop", message: err instanceof Error ? err.message : String(err) });
        return null;
      })
    : Promise.resolve(null));
  const said: Said = { sessionId: id, name, kind: "reply", text: "", replyId: replyIdOf(reply) };
  const speech = await openSpeech(undefined, undefined, said);
  mine.speech = speech;
  // A permission prompt came in meanwhile and put it back: let the voice go to it.
  if (mine.deferred) return speech.cancel();
  const held: string[] = [];
  // Its summary was shown, then a press cut it before a sound: the same words again, not new ones
  // (unless it's to be named now and wasn't then, or the other way round).
  const shownSummary = record.summary?.nameSession === nameSession ? record.summary.text : null;
  // The classifier's read goes to the summary too: an offer with no "?" is only asked if the classifier agrees you're waited on (claudeAsked).
  const needsUser = verdict.then((v) => v?.needsUser ?? null);
  if (shownSummary) {
    firstToken = now();
    held.push(shownSummary);
  }
  const summary = shownSummary
    ? Promise.resolve({ text: shownSummary, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 })
    : summarizer
        .summarize({ name, titled, nameSession, context, asked, claudeReply: reply, voice, needsUser }, (delta) => {
          if (myTurn !== floor.turn) return;
          firstToken ||= now();
          if (gateOpen) speech.push(delta);
          else held.push(delta);
        })
        .catch((err) => {
          ui.error("summary", err);
          log("error", { where: "summary", message: err instanceof Error ? err.message : String(err) });
          return null;
        });

  const v = await verdict;
  const r = await reach; // done long before the classifier: listing sessions is quicker
  const windowMs = floor.judged(request, r, v?.needsUser ?? null);
  if (v && !record.classifierShown) {
    record.classifierShown = true;
    totals.classifier += v.costUsd;
    ui.info(`Classifier: worth saying ${v.worthSaying.toFixed(2)} · needs you ${v.needsUser.toFixed(2)} (${v.ms}ms)`);
  }
  // A press during all this is a reply already; keyUp takes it from here.
  if (myTurn !== floor.turn) return;
  const quiet = v && v.needsUser < QUIET_NEEDS_USER && (config.announce === "needs_you" || (config.announce === "results" && v.worthSaying < QUIET_WORTH));
  if (quiet) {
    floor.forget(mine);
    floor.dropped(request, `announce_${config.announce}`);
    summarizer.cancel();
    speech.cancel();
    floor.release(request, config.announce === "needs_you" ? "doesn't need you; the session stopped" : "not worth saying; the session stopped");
    floor.drain();
    return;
  }
  // A line of the app's still being said ahead of it (what didn't reach a session, say): heard to
  // its end first, on its own, with the announcement after it rather than run on from it. Otherwise
  // a "your words weren't typed in" line runs straight into the next session's announcement, which
  // takes it as its own first sound.
  await audio.clearAhead(said, (ahead) => ahead.kind === "line");
  if (mine.deferred) return speech.cancel();
  if (myTurn !== floor.turn) return;
  gateOpen = true;
  for (const delta of held) speech.push(delta);

  const result = await summary;
  if (myTurn !== floor.turn) return;
  if (!result?.text) {
    floor.forget(mine); // nothing to hear: a press is a reply, as before
    speech.cancel();
    floor.startReplyTimer();
    return;
  }
  speech.end();
  state.lastSpoken = said.text = result.text;
  entry.spoken = result.text; // what you heard, with its question at the end
  floor.spokeLast = { sessionId: id, at: Date.now() }; // onIdle moves this to when the speech ends
  if (!shownSummary) ui.spoken(result.text, { name, sessionId: id });
  record.summary = { text: result.text, nameSession };
  if (textOnly()) floor.forget(mine); // nothing said: the text on screen is the announcement
  floor.startReplyTimer(); // restarted once the speech ends; covers speech that never starts

  totals.turns++;
  const llmCost = result.costUsd;
  totals.llm += llmCost;
  const voiceCost = ttsCost(speech.chars());
  const deadline = now() + 5000;
  while (!firstSound && myTurn === floor.turn && now() < deadline) await new Promise((r) => setTimeout(r, 10));
  if (mine.deferred) return; // a press put it back before it made a sound: made again, logged then
  const since = (at: number) => (at ? secs(at - start) : "—");
  const u = result.usage;
  ui.timing(replyTimingLine(`first token ${since(firstToken)} · first sound ${since(firstSound)}`, llmCost + voiceCost + (v?.costUsd ?? 0), modelName(), u, sessionCost()));
  writeState();
  log("announce", {
    sessionId: id,
    folder: name,
    // The reply's id, as summary_feedback and the summary eval's cases name it.
    replyId: replyIdOf(reply),
    worthSaying: v?.worthSaying ?? null,
    needsUser: v?.needsUser ?? null,
    // Its own: by now another session may be the one waiting.
    reach: r,
    windowMs,
    firstTokenMs: firstToken ? Math.round(firstToken - start) : null,
    firstSoundMs: firstSound ? Math.round(firstSound - start) : null,
    usage: u,
    llmCost,
    ttsCost: voiceCost,
    ttsChars: speech.chars(),
  });
}

// ── Auto mode's blocks ──────────────────────────────────────────────────────

// Auto mode blocks a risky tool call with no prompt (no card, nothing on the phone), and "go ahead"
// in the chat isn't an approval: a session's deploy was blocked twice in a row, and nothing said so. Claude Code's PermissionDenied hook tells of each one
// (only in auto mode); OpenCode's service tells of a call its deny rules stopped. Where it can be
// allowed anyway (auto mode's, in Kiko's tmux: core/block-override.ts), it's a permission card,
// "Auto mode blocked Lacy from running wrangler deploy. Allow it?", and a yes takes the session out of
// auto mode and asks it to try again (overrideBlock); elsewhere it's said like any update of a
// session's, on the Mac and the phone, with why it can't be allowed from here.
/** Blocks of one session this close together are one: the first said (or asked), the others shown and logged. */
const BLOCK_QUIET_MS = 30_000;
const blockSaid = new Map<string, number>();

/** "Auto mode blocked Lacy from running wrangler deploy. Allow it?", or said with why not, for a session it blocked (agent.onBlocked). */
export async function blocked(b: Blocked) {
  // Where it is now (a second old at most): whether it can be offered depends on its pane.
  const session = findSession(await getSessions(1000).catch(() => ui.state.sessions), b.sessionId) ?? findSession(ui.state.sessions, b.sessionId);
  const id = session?.sessionId ?? b.sessionId;
  const name = nameOf({ sessionId: id, cwd: session?.cwd ?? b.cwd });
  const can = overridable(b, {
    listed: Boolean(session) && agentOf(session!) === mainAgent,
    inTmux: session?.place?.via === "tmux" && session.place.keys,
    desktop: session?.desktop,
    cards: config.voicePermissions,
  });
  const line = `${blockedLine(spoken(name), b)}${can.ok ? "" : ` ${can.why}`}`;
  const last = blockSaid.get(id) ?? 0;
  const quiet = Date.now() - last < BLOCK_QUIET_MS;
  log("auto_mode_blocked", {
    sessionId: id,
    name,
    tool: b.tool.name,
    what: describeTool(b.tool.name, b.tool.input),
    reason: b.reason,
    text: line,
    said: !quiet,
    by: b.by ?? "auto",
    offered: !quiet && can.ok,
    ...(b.mode ? { mode: b.mode } : {}),
  });
  timeline.add({ who: "app", sessionId: id, folder: name, text: `${blockedLine(name, b)}${b.reason ? ` (${flat(b.reason, 120)})` : ""}` });
  if (quiet) return ui.info(`(${blockedLine(name, b)})`);
  blockSaid.set(id, Date.now());
  // Asked like any permission prompt: the card, voice, the phone; its window as theirs.
  if (can.ok) return onRequest(new BlockOverride(id, { ...b, sessionId: id, cwd: session?.cwd ?? b.cwd }, (card) => void overrideBlock(card)));
  await sayAbout({ sessionId: id, cwd: session?.cwd ?? b.cwd }, name, line);
}

/** A line about one session, as its updates are: the phone shows it under it, and your words go there next. */
async function sayAbout(to: Target, name: string, line: string) {
  state.target = to;
  writeState();
  state.lastSpoken = line;
  ui.spoken(line, { name, sessionId: to.sessionId });
  const speech = await openSpeech(undefined, undefined, { sessionId: to.sessionId, name, kind: "line", text: line });
  speech.push(line);
  speech.end();
  ttsCost(speech.chars());
}

/**
 * Yes to a block's card (core/block-override.ts): the session taken out of auto mode with Shift+Tab
 * in its pane, its screen read back after each press, then asked to try again, typed in as the app
 * types. Claude Code then asks for the call with an ordinary permission prompt, a card like any
 * other: nothing is allowed for you here. Never while it's asking something else. It's left in
 * accept edits (manual mode if a turn is running: switchTarget), said, and never put back in auto.
 */
async function overrideBlock(card: BlockOverride) {
  const name = nameOf(refOf(card));
  const to = refOf(card);
  const done = (ok: boolean, line: string, more: Record<string, unknown> = {}) => {
    log("block_override", { sessionId: card.sessionId, name, tool: card.tool.name, ok, said: line, ...more });
    timeline.add({ who: "app", sessionId: card.sessionId, folder: name, text: line });
    return sayAbout(to, name, line);
  };
  const session = findSession(await getSessions(0), card.sessionId);
  const place = session?.place;
  const terminal = place ? terminalOf(place) : null;
  if (!session) return done(false, `${spoken(name)} has closed, so nothing changed.`);
  if (!place || place.via !== "tmux" || !place.keys || !terminal?.screen || !terminal.key) {
    return done(false, `${spoken(name)} isn't in ${NAME}'s tmux any more, so it stays blocked. Allow it in its window.`);
  }
  // A prompt of its own up (held here, or open in its window): no key goes in while one is.
  if (floor.heldPermission(card.sessionId) || standsFor(card.sessionId) || session.status === "blocked") {
    return done(false, `${spoken(name)} is asking you something else, so I left it alone and it stays blocked.`, { why: "asking" });
  }
  const switched = await switchMode(
    {
      screen: () => terminal.screen!(place.id),
      press: () => terminal.key!(place, "shift+tab"),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    switchTarget(session.status),
  );
  const how = { from: switched.from, now: switched.now, presses: switched.presses };
  if (!switched.ok) {
    const now = switched.presses && switched.now ? ` It's in ${modeWords(switched.now)} now.` : "";
    return done(false, `I couldn't take ${spoken(name)} out of auto mode: ${switched.why}. It stays blocked.${now}`, { ...how, why: switched.why });
  }
  // Its retry, typed in as the app types (noted as the app's, not yours). A finished turn of it the
  // app holds is let go, as when you type there: what's typed waits in Claude Code's queue till then.
  const retry = retryLine(card.tool);
  noteTyped(card.sessionId, retry);
  const typed = await terminal.type(place, retry);
  const stop = floor.heldStop(card.sessionId);
  if (typed.sent && stop) floor.typedIn(stop, `asked ${name} to try again; let it go`);
  if (!typed.sent) {
    return done(false, `${spoken(name)} is in ${modeWords(switched.now!)} now, but I couldn't ask it to try again (${typed.why}). Ask it yourself.`, { ...how, retry: false, why: typed.why });
  }
  return done(true, `${spoken(name)} is in ${modeWords(switched.now!)} now, and I asked it to try again.`, { ...how, retry: true, ...(stop ? { letGo: true } : {}) });
}

/** "Atlas agents wants to run the tests. Allow?" */
export async function askPermission(request: Held) {
  if (isTrust(request)) return askTrust(request);
  const mine = startUnheard(request, null);
  const myTurn = mine.turn;
  const id = request.sessionId;
  const tool = request.tool;
  const name = nameOf(refOf(request));
  const titled = name !== folderName(request.cwd);
  const quickCheck = isQuickCheck(id);
  const what = whatOf(request);
  noteAsked(request);
  if (!quickCheck) state.target = refOf(request); // the quick check isn't a session your words can go to
  const nameSession = state.lastAnnounced !== id;
  state.lastAnnounced = id;
  floor.spokeLast = null;
  state.currentRisky = false;
  // Asked again after a press put it back: already in the timeline and on screen.
  if (!shown.has(request)) {
    const entry = timeline.add({ who: "claude", sessionId: id, folder: name, text: `asks permission to ${what}`, permission: true });
    shown.set(request, { entry, context: [], onScreen: true });
    ui.permission({ name, sessionId: id }, what);
  }
  writeState();

  // A block offered to be allowed anyway (core/block-override.ts): worded here, never by a model; its
  // risk rated as the same call asked as a prompt would be.
  const override = isOverride(request) ? request : null;
  // One the safety gate asked (core/guard.ts): worded here, never by a model, and risky by its kind.
  const gated = guardOf(request);
  // The classifier rates the risk while Haiku words the question.
  const risk =
    !gated && classifierEnabled()
      ? decideRisk({ request: override ? describeTool(tool?.name, tool?.input) : what }).catch((err) => {
          log("error", { where: "classify_risk", message: err instanceof Error ? err.message : String(err) });
          return null;
        })
      : Promise.resolve(null);
  const said: Said = { sessionId: id, name, kind: "question", text: "" };
  const speech = await openSpeech(undefined, undefined, said);
  // A quick check's question is always the same few words: no model needed.
  const result =
    quickCheck || override || gated
      ? null
      : await summarizer
          .describePermission({ name, titled, nameSession, tool: tool?.name ?? "", input: tool?.input }, (delta) => {
            if (myTurn === floor.turn) speech.push(delta);
          })
          .catch((err) => {
            log("error", { where: "permission_wording", message: err instanceof Error ? err.message : String(err) });
            return null;
          });
  const r = await risk;
  if (myTurn !== floor.turn) return;
  if (r) {
    totals.classifier += r.costUsd;
    ui.info(`Classifier: risky ${r.risky.toFixed(2)} (${r.ms}ms)`);
  }
  state.currentRisky = Boolean(gated) || (r?.risky ?? 0) >= RISKY;
  let text = result?.text.trim() ?? "";
  // No model's words: never the command read out, only what it's for or a plain phrase (spoken-permission.ts;
  // the quick check once read a whole shell pipeline aloud). The card keeps `what`.
  // A block offered to be allowed anyway says what was blocked by the same rules (blockedDoing).
  const plain = !text;
  if (plain) {
    const who = nameSession ? (titled ? `The ${name} session` : spoken(name)) : "It";
    text = quickCheck
      ? quickAskLine(spokenWhat(tool))
      : override
        ? overrideAsk(spoken(name), override.blocked)
        : gated
          ? guardLine(titled ? `The ${name} session` : spoken(name), gated.what)
          : plainPermissionLine(who, tool);
    speech.push(text);
  }
  if (state.currentRisky && !gated) {
    const extra = " This one's risky, so say allow it to approve.";
    speech.push(extra);
    text += extra;
  }
  speech.end();
  state.lastSpoken = said.text = text;
  ui.spoken(text, { name, sessionId: id });
  if (textOnly()) floor.forget(mine); // nothing said: the text on screen is the question
  writeState();
  totals.turns++;
  const llmCost = result?.costUsd ?? 0;
  totals.llm += llmCost;
  const voiceCost = ttsCost(speech.chars());
  log("ask_permission", {
    sessionId: id,
    tool: tool?.name,
    what,
    ...(plain ? { spokenWhat: spokenWhat(tool) } : {}),
    risky: gated ? 1 : (r?.risky ?? null),
    ...(gated ? { guard: gated.kind } : {}),
    text,
    llmCost,
    ttsCost: voiceCost,
  });
  floor.startReplyTimer();
}

/**
 * A session still starting, at Claude Code's trust question: "Dozer wants to trust its folder
 * ~/Kiko/scratch/2026-10-29-dozer. Claude Code will be able to read, edit and run files there.
 * Allow?" (said with the folder's name, not its path). Worded here, never by a model, and not rated
 * for risk. Where Voice can doesn't start sessions, it says to answer on its card instead.
 */
async function askTrust(request: TrustQuestion) {
  const mine = startUnheard(request, null);
  const id = request.sessionId;
  const name = nameOf(refOf(request));
  const what = whatOf(request);
  state.target = refOf(request);
  state.lastAnnounced = id;
  floor.spokeLast = null;
  state.currentRisky = false;
  if (!shown.has(request)) {
    const entry = timeline.add({ who: "claude", sessionId: id, folder: name, text: `asks permission to ${what}`, permission: true });
    shown.set(request, { entry, context: [], onScreen: true });
    ui.permission({ name, sessionId: id }, what);
  }
  writeState();
  const byVoice = voiceAllows(config.voiceCan, "manage");
  const said: Said = { sessionId: id, name, kind: "question", text: "" };
  const speech = await openSpeech(undefined, undefined, said);
  if (mine.turn !== floor.turn) return;
  const text = trustLine(spoken(name), request, homedir(), { spoken: true, byVoice });
  speech.push(text);
  speech.end();
  state.lastSpoken = said.text = text;
  ui.spoken(trustLine(name, request, homedir(), { spoken: false, byVoice }), { name, sessionId: id });
  if (textOnly()) floor.forget(mine); // nothing said: the text on screen is the question
  writeState();
  totals.turns++;
  log("ask_permission", { sessionId: id, tool: request.tool.name, what, risky: null, text, llmCost: 0, ttsCost: ttsCost(speech.chars()) });
  floor.startReplyTimer();
}

/** Your yes or no to the permission prompt being asked, as decide() read it. */
export async function answerPermission(request: Held, text: string, answer: ApprovalDecision["answer"]) {
  log("permission_answer", { text, answer, risky: state.currentRisky });
  // The offer to turn Voice can on, made about this trust prompt (below): a yes, or "turn it on",
  // turns it on and answers the prompt as you first did; a no leaves the prompt on its card.
  const offer = state.voiceOffer?.request === request ? state.voiceOffer : null;
  if (offer) {
    if (TURN_ON.test(text) || answer === "allow" || answer === "allow_always") return turnOnVoice();
    state.voiceOffer = null;
    if (answer === "deny") return speakLine(`Okay, it stays as it is. Tap it on its card${phoneLive() ? " or on your phone" : ""}.`);
  }
  // A folder's trust starts or ends a session: by voice only where Voice can starts and stops them.
  if (isTrust(request) && (answer === "allow" || answer === "allow_always" || answer === "deny")) {
    const off = `Trusting ${request.kind === "hooks" ? "hooks" : "a folder"} by voice is off: tap it on its card${phoneLive() ? " or on your phone" : ""}.`;
    if (!(await allowed("trust", { to: refOf(request), off, request, then: () => answerPermission(request, text, answer) }))) return;
  }

  // Repeats and unclear answers keep the prompt open; keyUp restarts its window.
  if (answer === "repeat") return repeatLast();
  if (answer === "unclear") return speakLine(state.currentRisky ? "Say allow it to approve, or no." : "Should it go ahead? Say yes or no.");
  if (answer === "deny") return settlePermission(request, "deny", text, "voice");
  if (state.currentRisky && !/\b(allow|approve)/i.test(text)) {
    const gated = guardOf(request);
    return speakLine(gated ? `${NAME} asks first for anything that ${gated.kind}. Say allow it, or no.` : "This one's risky. Say allow it to approve, or no.");
  }
  settlePermission(request, answer, text, "voice");
}

/**
 * Claude asks you questions (AskUserQuestion, core/ask.ts), one at a time: "Kiko has 3 questions.
 * First, Install tmux: … One: Yes, install it, recommended. Two: No, I'll install it." Then the
 * permission window, as for any prompt: running out leaves them in the terminal.
 */
export async function askQuestions(request: Held) {
  const mine = startUnheard(request, null);
  const id = request.sessionId;
  const questions = request.questions!;
  const name = nameOf(refOf(request));
  const titled = name !== folderName(request.cwd);
  state.target = refOf(request);
  const nameSession = state.lastAnnounced !== id;
  state.lastAnnounced = id;
  floor.spokeLast = null;
  state.currentRisky = false;
  noteAsked(request);
  let walk = asking.get(request);
  if (!walk) asking.set(request, (walk = new Asking(questions)));
  // Asked again after a press put it back: already in the timeline and on screen.
  if (!shown.has(request)) {
    const asks = questions.map((q) => `${q.question} (${q.options.map((o) => o.label).join(" / ") || "own words"})`).join(" ");
    const entry = timeline.add({ who: "claude", sessionId: id, folder: name, text: `asks: ${flat(asks, 600)}`, permission: true });
    shown.set(request, { entry, context: [], onScreen: true });
    ui.permission({ name, sessionId: id }, askWhat(questions));
  }
  writeState();
  const text = walk.start(nameSession ? (titled ? `The ${name} session` : spoken(name)) : "It");
  const speech = await openSpeech();
  // A press put it back meanwhile: it's asked again once your words are dealt with.
  if (mine.deferred) return speech.cancel();
  speech.push(text);
  speech.end();
  state.lastSpoken = text;
  ui.spoken(text, { name, sessionId: id });
  if (textOnly()) floor.forget(mine); // nothing said: the text on screen is the question
  totals.turns++;
  const voiceCost = ttsCost(speech.chars());
  log("ask_questions", { sessionId: id, count: questions.length, at: walk.at, text, ttsCost: voiceCost });
  floor.startReplyTimer();
}

/**
 * Your words to the question being asked: matched to its options in code, else by a quick model call
 * (checked against them), then the next question, asking again once, or leaving it at the Mac. After
 * the last, the session gets all the answers. keyUp restarts the window for the next one.
 */
export async function answerQuestion(request: Held, text: string) {
  const walk = asking.get(request);
  if (!walk || !request.open) return questionsGone(request, text);
  const q = walk.current;
  const at = walk.at;
  let match = matchAnswer(q, text);
  let by = "code";
  if (match.kind === "unclear" && q.options.length) {
    const m = await matchByModel(q, text);
    totals.llm += m.costUsd;
    match = m.match;
    by = "model";
  }
  // Answered in its terminal while the app worked it out.
  if (!request.open) return questionsGone(request, text);
  const step = walk.take(match);
  log("question_answer", {
    sessionId: request.sessionId,
    at,
    text,
    match: match.kind,
    ...(match.kind === "pick" ? { picks: match.picks.map((i) => q.options[i].label) } : {}),
    by,
    ...(step.leave ? { leave: step.leave } : {}),
    done: Boolean(step.done),
  });
  writeState();
  await speakLine(step.say);
  if (step.done) settleQuestions(request, step.done);
  else if (step.leave) {
    // Standing on its card (app/standing.ts): let go from there.
    if (standing.has(request)) {
      ui.info(`(${step.leave}; the questions are waiting ${heldWhere(request)})`);
      standing.release(request, "left");
    } else floor.release(request, `${step.leave}; the questions are waiting ${heldWhere(request)}`);
    floor.drain();
  }
}

/** Your answer came after the questions went away (answered in the terminal, or the hook's timeout): said, not dropped silently. */
function questionsGone(request: Held, text: string) {
  log("question_answer_late", { sessionId: request.sessionId, text });
  return speakLine(`Those questions aren't waiting any more, so that answer didn't go to ${spoken(nameOf(refOf(request)))}.`);
}

/** All the questions answered (by voice, or on a phone): the session gets them, and goes on. */
export function settleQuestions(request: Held, answers: Answer[]) {
  const name = nameOf(refOf(request));
  floor.drop(request);
  floor.unqueue(request); // answered from the phone before their turn: not asked after
  // Standing after its window (app/standing.ts): answered late, taken down.
  answeredLate(request, state.pressAt.startsWith("phone:") ? "phone" : "card");
  // A phone that missed the questions no longer needs them.
  state.phone?.promptSettled(promptId(request), request.sessionId, state.pressAt.startsWith("phone:") ? "answered_on_phone" : "answered_on_mac");
  request.answerQuestions(answers);
  const said = answers.map((a) => spokenAnswer(a)).join("; ");
  timeline.add({ who: "you", sessionId: request.sessionId, folder: name, text: `answered: ${said}`, permission: true });
  ui.info(`→ answered: ${said}`);
  log("questions_answered", { sessionId: request.sessionId, answers, by: state.pressAt });
  cue("sent", state.pressAt);
  writeState();
  floor.drain();
}

/** Answers a permission prompt (by voice, y / a / n on the Mac's card, or on a phone: `by`). */
export function settlePermission(request: Held, outcome: "allow" | "allow_always" | "deny", text: string, by: "voice" | "card" | "phone") {
  // A trust card: settled from everywhere, and its keys pressed in its pane.
  if (isTrust(request)) return void answerTrustCard(request, outcome !== "deny", by, text);
  const what = whatOf(request);
  const name = nameOf(refOf(request));
  floor.drop(request);
  // One still in line (answered from the phone before its turn): it's not asked after.
  floor.unqueue(request);
  // One standing after its window (app/standing.ts): answered late, through its hook still held.
  answeredLate(request, by);
  // One the safety gate asked: logged, and allowed this once only (never "don't ask again").
  const gated = guardOf(request);
  if (gated) log("guard_answer", { agent: gated.agent, sessionId: request.sessionId, kind: gated.kind, rule: gated.rule, answer: outcome === "deny" ? "deny" : "allow", by });
  // A phone that missed the question no longer needs it.
  state.phone?.promptSettled(promptId(request), request.sessionId, state.pressAt.startsWith("phone:") ? "answered_on_phone" : "answered_on_mac");
  if (outcome === "deny") {
    request.deny(`The user said no by voice: "${text}"`);
    timeline.add({ who: "you", sessionId: request.sessionId, folder: name, text: `no to ${what}: ${text}`, permission: true });
    ui.info("→ denied");
  } else {
    const always = outcome === "allow_always" && request.canAllowAlways && !gated;
    request.allow(always);
    timeline.add({ who: "you", sessionId: request.sessionId, folder: name, text: `yes to ${what}`, permission: true });
    ui.info(`→ allowed${always ? `, and won't ask again${isQuickCheck(request.sessionId) ? ` in quick checks (kept in ${shortPath(QUICK_ALWAYS_FILE)})` : ""}` : ""}`);
  }
  cue("sent", state.pressAt);
  writeState();
  floor.drain();
}

/**
 * "Repeat that", or "repeat the last clipkit message": that session's last summary. Noted in the
 * timeline, so a correction right after ("no, the clipkit one") is about the repeat, not an older send.
 */
export async function repeatFor(session: Session | null, text: string) {
  timeline.add({ who: "you", sessionId: null, folder: null, text });
  if (!session) {
    if (state.lastSpoken) timeline.add({ who: "app", sessionId: null, folder: null, text: state.lastSpoken, repeated: true });
    return repeatLast();
  }
  const name = sessionName(session);
  const heard = timeline.recent(100, idsOf(session)).findLast((e) => e.who === "claude" && e.spoken);
  log("repeat", { sessionId: session.sessionId, found: Boolean(heard) });
  if (!heard?.spoken) return speakLine(`I haven't read anything out from ${spoken(name)} yet.`);
  timeline.add({ who: "app", sessionId: session.sessionId, folder: name, text: heard.spoken, repeated: true });
  // You just heard it again: your next words most likely answer it.
  floor.spokeLast = { sessionId: session.sessionId, at: Date.now() };
  unplayed.repeated(heard.spoken); // asked for: not said again by itself once sound is back
  return speakLine(heard.spoken, false, { sessionId: session.sessionId, name, kind: "reply", text: heard.spoken });
}

/** The newest finished turn of a session's (any session's, with none given) whose summary you heard. */
export function heardLast(sessionId?: string) {
  return timeline.recent(300, sessionId ? idsFor(sessionId) : undefined).findLast((e) => e.who === "claude" && e.spoken);
}

/**
 * "More", "tell me more about the failing tests": a longer summary of that session's last reply you
 * heard summed up, or all it says about `topic` (Summarizer.more), streamed like an announcement. Its
 * reply window, if it's waiting, stays open: your next words still answer it. Logged as `more`, and
 * as `summary_feedback` (the summary didn't say enough), for the summary eval.
 */
export async function tellMore(sessionId: string, topic: string | null, text: string) {
  timeline.add({ who: "you", sessionId: null, folder: null, text });
  const heard = heardLast(sessionId);
  const session = findSession(ui.state.sessions, sessionId);
  const name = currentName(sessionId) ?? heard?.folder ?? "that session";
  if (!heard?.spoken) {
    log("more", { sessionId, topic, said: text, found: false });
    return speakLine(`I haven't read anything out from ${spoken(name)} yet.`);
  }
  const replyId = replyIdOf(heard.text);
  log("summary_feedback", feedbackEvent({ kind: topic ? "more_about" : "more", sessionId, name, reply: heard.text, summary: heard.spoken, said: text, went: ["more"] }));
  const its = agentOf(session ?? { sessionId });
  const said: Said = { sessionId, name, kind: "reply", text: "", replyId };
  const speech = await openSpeech(undefined, undefined, said);
  const start = now();
  let firstToken = 0;
  const result = await explainer
    .more(
      {
        name,
        titled: Boolean(session && name !== folderName(session.cwd)),
        claudeReply: heard.text,
        heard: heard.spoken,
        topic,
        voice: { agent: its.name, speaker: its.speaker ?? "" },
      },
      (delta) => {
        firstToken ||= now();
        speech.push(delta);
      },
    )
    .catch((err) => {
      ui.error("summary", err);
      log("error", { where: "more", message: err instanceof Error ? err.message : String(err) });
      return null;
    });
  if (!result?.text) return speech.cancel();
  speech.end();
  state.lastSpoken = said.text = result.text;
  timeline.add({ who: "app", sessionId, folder: name, text: result.text });
  ui.spoken(result.text, { name, sessionId });
  // You just heard about it: your next words most likely answer it, as after a repeat.
  floor.spokeLast = { sessionId, at: Date.now() };
  totals.llm += result.costUsd;
  log("more", { sessionId, name, replyId, topic, said: text, text: result.text, firstTokenMs: firstToken ? Math.round(firstToken - start) : null, usage: result.usage, costUsd: result.costUsd });
}

/**
 * Words right after a summary that say it fell short ("you missed…", "what about the tests?", a
 * question back about it) are logged as `summary_feedback`, for the summary eval; what they do is
 * decided as before. `about`: the session whose summary was just heard. "More" logs its own (tellMore).
 */
export function noteSummaryFeedback(said: string, d: Decision, about: string | null) {
  if (!about || d.actions.some((a) => a.type === "more")) return;
  const kind = feedbackKind(said);
  const heard = kind && heardLast(about);
  if (!kind || !heard?.spoken) return;
  log(
    "summary_feedback",
    feedbackEvent({ kind, sessionId: about, name: currentName(about) ?? heard.folder ?? "", reply: heard.text, summary: heard.spoken, said, went: d.actions.map((a) => a.type) }),
  );
}

/** "Repeat that": the last spoken line again, word for word. */
export function repeatLast() {
  if (!state.lastSpoken) return speakLine("I haven't said anything yet.", false);
  unplayed.repeated(state.lastSpoken);
  return speakLine(state.lastSpoken, false);
}

export function sessionCost() {
  return totals.llm + totals.classifier + totals.deepgram + totals.cartesia;
}
