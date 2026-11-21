// What you said, dealt with: decided (core/decide.ts: a reply, words for a session, a question to
// the app, a new session, ...) and carried out: sent (now, held a moment when unsure, or after the
// turn it answers is read out), answered, undone, sent again, or said not to have gone anywhere.
import { homedir } from "node:os";
import { config } from "../core/config.ts";
import { PHONE_NOT_OUT, phoneLive, proOnSale } from "../core/env.ts";
import { andList, flat } from "../core/text.ts";
import { SILENT } from "../core/speech-lock.ts";
import { findSession, idsOf, isStarting, sessionName, spoken, type Session } from "../core/sessions.ts";
import { newProjectRoot } from "../core/projects.ts";
import { classifierEnabled } from "../core/classifier.ts";
import { decideApproval, decideUtterance } from "../core/decisions.ts";
import type { SessionNote } from "../core/router.ts";
import { trimForClaude } from "../core/trim.ts";
import { leadingName } from "../core/wake.ts";
import { cleanUp, leftOut } from "../core/cleanup.ts";
import { loadDictionary } from "../core/dictionary.ts";
import { decide, handledBy, type Act, type Cleaned, type Decision, type Question, type Sent, type Target, type Trimmed } from "../core/decide.ts";
import { Hold } from "../core/hold.ts";
import type { Asked } from "../core/question.ts";
import { APP_QUESTION_MS, asksPhone, asksYou, bareReply, JUST_SPOKE_MS, REDIRECT_WITHIN_MS, RETRY_MS, UNDO_WITHIN_MS, voiceAllows } from "../core/routing-rules.ts";
import { agent, agentOf, agents } from "../agents/index.ts";
import type { Held } from "../agents/types.ts";
import { ui } from "../core/ui-store.ts";
import { log, totals } from "../core/log.ts";
import { routeCostLine } from "../core/cost-lines.ts";
import { backLine, gaveUpLine, sentLine, STALE_MS, staleLine, withoutClassifierLine } from "../core/fallback.ts";
import { asThen, KEPT_MS, type KeptContext, type KeptEntry } from "../core/kept.ts";
import type { Entry } from "../core/timeline.ts";
import { appEnv } from "../core/env.ts";
import { networkCode, serviceName } from "../core/online.ts";
import { classifierDown, openrouterService, routerDown } from "../core/services.ts";
import { writeState } from "./status.ts";
import { answerPermission, answerQuestion, askedOf, contextFor, heardLast, noteSummaryFeedback, repeatFor, tellMore } from "./announce.ts";
import { knownProjects, startInApp, startSession } from "./new-session.ts";
import { cancelQuickTask, dropQuickTask, offerHandOff, startQuickTask } from "./quick-task.ts";
import { allowed, interrupt, renameSession, stopSession, turnOnVoice, typeInto } from "./session-ops.ts";
import { VOICE_CAN_SAID } from "../core/voice-off.ts";
import { addWord, removeWord } from "./settings/dictionary.ts";
import { addSaying, forgetSaying } from "./settings/pronunciation.ts";
import { modelName } from "./settings/voice.ts";
import { cue, openSpeech, openTts, speakLine, ttsCost } from "./speech.ts";
import { getSessions, trustScratch } from "./starting.ts";
import { startCheckout } from "./upgrade.ts";
import {
  KEY_UP_WAIT_MS,
  RECENT,
  ROUTED_MS,
  TOPICS,
  askedWhere,
  currentName,
  floor,
  heldReplies,
  holdOptions,
  inLine,
  keptWords,
  laterWords,
  linesOf,
  nameOf,
  refOf,
  router,
  shown,
  state,
  talks,
  timeline,
  whatOf,
} from "./state.ts";

/**
 * What each session was last asked and said: from the timeline, else its transcript. And the topics
 * you asked it about before, past the recent conversation the models see (`recent` entries).
 */
function notesFor(sessions: Session[], recent: number): Map<string, SessionNote> {
  return new Map(
    sessions.map((s) => {
      const asked = timeline.last("you", idsOf(s))?.text ?? agent.lastAsked(s);
      const said = timeline.last("claude", idsOf(s))?.text ?? agent.lastSaid(s);
      const topics = timeline.topics(idsOf(s), { count: TOPICS, recent, skip: bareReply });
      return [s.sessionId, { asked, said, ...(topics.length ? { topics } : {}) }];
    }),
  );
}

// ── What you said ───────────────────────────────────────────────────────────

/**
 * Works out who you're talking to and what you meant (decide.ts), then acts on it, in the order you
 * said them (in-line.ts): once the words before are sent or held. `press`: their press's number
 * (floor.ts keyUp). `to`: said in that session's screen on the phone, so it's for that session.
 */
export async function deliver(text: string, press: number, to: Target | null = null, heardAt = Date.now()) {
  const turn = await inLine.enter();
  if (turn.late) log("in_line_late", { text, waitedMs: turn.waitedMs });
  try {
    await decideAndAct(text, press, to, turn.done, heardAt);
  } finally {
    turn.done();
  }
}

/**
 * Words kept routed again (retryOne): `entry`, taken off the list; `stale` "ask": a send long after
 * they were said is asked about first; "hold": kept for "send it" instead (newer words are going).
 */
type Retrying = { entry: KeptEntry; stale: "ask" | "hold" };

/**
 * deliver(), once it's these words' turn. `onTheirWay`: they're sent or held, and the next words may
 * be decided. `heardAt`: when they were heard, for the router's log line (how long Kiko took to ask it).
 * `retrying`: words kept when the router couldn't answer, routed again: "failed" back when it still
 * can't, and nothing said then.
 */
async function decideAndAct(text: string, press: number, to: Target | null, onTheirWay: () => void, heardAt: number, retrying?: Retrying): Promise<"failed" | "done"> {
  // Words kept, routed again: decided with the conversation as it stood when they were said (`then`,
  // kept.ts asThen), never what came since. The session waiting for them then, only while it still
  // is; one waiting now that wasn't then isn't what they answer.
  const then = retrying?.entry.context ?? null;
  const waiting = then ? (floor.waiting && !floor.waiting.isPermission && floor.waiting.sessionId === then.waitingId ? floor.waiting : null) : floor.waiting;
  // The app asked to pair or set up the phone while the iPhone app isn't out (core/env.ts
  // phoneLive): one plain line, nothing done. Not with a session waiting for these words.
  if (!retrying && !waiting && !to && !phoneLive() && asksPhone(leadingName(text).rest || text)) {
    timeline.add({ who: "you", sessionId: null, folder: null, text });
    log("phone_not_live", { text });
    talks.routed(null);
    await speakLine(PHONE_NOT_OUT);
    return "done";
  }
  // The router's service known to be down (core/online.ts): no model on it is asked, so nothing
  // waits out a time limit for one; decide() asks again as it goes, since it can go down meanwhile.
  // The classifier's service is its own: down, only the classifier is skipped.
  const down = routerDown();
  const offline = () => {
    const d = routerDown();
    return d ? { detail: d.detail, ...(d.service ? { service: serviceName(d.service) } : {}) } : null;
  };
  const classifierOffline = () => classifierDown()?.detail ?? null;
  // The clean-up of your words starts first, before the sessions are listed (decide() only waits
  // for it when your words go to a session). Not for a permission prompt's yes or no, nor words
  // kept (cleaned up already).
  const cleaning = config.cleanUp && !waiting?.isPermission && !down && !retrying ? cleanUp(text) : null;
  void cleaning?.then((c) => (totals.llm += c.costUsd));
  // A permission prompt takes your words as its answer: no sessions or notes needed for that.
  const asWas = then && asThen(then, await getSessions(), waiting?.sessionId ?? null);
  const sessions = asWas ? asWas.sessions : waiting?.isPermission ? [] : await getSessions();
  // Nothing waiting, but a session was read out moments before you started talking (its window
  // had just closed): your words most likely answer it, so the classifier and the router take it like the one waiting.
  const spokeLast = floor.spokeLast;
  const sinceSpoke = spokeLast ? Math.max(0, floor.pressedAt - spokeLast.at) : Infinity;
  const justSpoke = asWas ? asWas.justSpoke : !waiting && spokeLast && sinceSpoke < JUST_SPOKE_MS ? { id: spokeLast.sessionId, secondsAgo: Math.round(sinceSpoke / 1000) } : null;
  // What "skip that" skips: the announcement your press put back before you heard it, or the next in line.
  const skippable = floor.skippable(Boolean(justSpoke));
  const lastEntry = timeline.recent(1)[0];
  // A send held while you pressed: what these words correct, cancel or let go (hold.ts settleWith).
  // Not for words kept, routed again: they aren't what you said next.
  const held = !retrying && state.holding && !state.holding.settled && (state.holding.pressed || state.holding.asking) ? state.holding : null;
  // What "no, that was for clipkit" corrects: a send only while it's the latest thing the app did for you.
  const sent = timeline.lastSent(REDIRECT_WITHIN_MS, true);
  // Or a repeat, when that was the app's answer to your last words.
  const lastRepeat = Boolean(timeline.recent(8).findLast((e) => e.who === "you" || e.repeated)?.repeated);
  // The app's last words asked you something, moments ago. Not what words kept, routed again, answer.
  const appAsked = !retrying && lastEntry?.who === "app" && !lastEntry.repeated && asksYou(lastEntry.text) && Date.now() - lastEntry.at < APP_QUESTION_MS;
  // The app's "which session?" question: these words answer it or move on, either way it's settled now.
  // Not words for a permission prompt; nor, once you'd moved on from it, words for a send held now or
  // for a newer question ("Stop which one?"); nor words kept, routed again.
  const asked = retrying ? null : takeQuestion(Boolean(waiting?.isPermission), Boolean(held) || appAsked);
  // Moved on from already: decide() takes it for a plain pick only.
  const question = asked && (asked.told ? { ...asked.question, told: true } : asked.question);
  // Your words as the router was asked them, noted in the conversation then.
  const noted: { entry?: Entry } = {};
  const lastId = asWas ? asWas.lastId : (state.target?.sessionId ?? null);
  const heardFrom = asWas ? asWas.heardFrom : (heardLast()?.sessionId ?? null);
  // What the models are told of the conversation: as it stands now, or for words kept, as it stood then.
  const context: KeptContext = asWas
    ? asWas
    : {
        sessions,
        notes: notesFor(sessions, RECENT),
        // The held words as if sent, as the models would see them once they had been.
        recent: linesOf([
          ...timeline.recent(RECENT),
          ...(held?.kind === "send" || held?.kind === "ask" ? [{ at: held.startedAt, who: "you" as const, sessionId: held.to.sessionId, folder: held.name, text: held.text }] : []),
        ]),
        waitingId: waiting?.sessionId ?? null,
        justSpoke,
        lastId,
        heardFrom,
      };
  const decision = await decide(
    {
      text,
      sessions,
      notes: context.notes,
      recent: context.recent,
      waiting: waiting && {
        sessionId: waiting.sessionId,
        cwd: waiting.cwd,
        ...(waiting.isPermission ? { permission: whatOf(waiting) } : {}),
        ...(waiting.questions ? { questions: true } : {}),
      },
      justSpoke,
      lastId,
      // A repeat ending in a session's question isn't the app asking.
      appAsked,
      lastSent: held
        ? held.last
        : sent?.sessionId
          ? {
              sessionId: sent.sessionId,
              folder: currentName(sent.sessionId) ?? sent.folder ?? "",
              text: sent.text,
              also: timeline.sentWith(sent).map((e) => ({ sessionId: e.sessionId!, folder: currentName(e.sessionId!) ?? e.folder ?? "" })),
              ...(sent.notSent ? { notSent: true } : {}),
              ...(sent.undone ? { undone: true } : {}),
            }
          : sent?.handled
            ? // Your words the app dealt with itself (a quick check, its answer): sent to no session.
              { sessionId: "", folder: "", text: sent.text, app: sent.handled }
            : null,
      holding: Boolean(held),
      skippable: Boolean(skippable),
      lastRepeat,
      heardFrom,
      voiceCan: config.voiceCan,
      quickTask: state.quick && { task: state.quick.task },
      // The app just offered a session for a quick task: a yes to it starts one with the task.
      handOff: appAsked && state.handOff && lastEntry?.text === state.handOff.line ? { task: state.handOff.task, cwd: state.handOff.cwd } : null,
      // The app just offered to turn Voice can up: a yes turns it on and does what it stopped.
      voiceOffer: Boolean(state.voiceOffer && !state.voiceOffer.request && lastEntry?.who === "app" && lastEntry.text === state.voiceOffer.line && Date.now() - lastEntry.at < APP_QUESTION_MS),
      retry: state.unsent && Date.now() - state.unsent.at < RETRY_MS ? { session: state.unsent.to, text: state.unsent.text } : null,
      classifierMinConfidence: config.classifierMinConfidence,
      proOnSale: proOnSale(),
      projects: () => knownProjects(sessions),
      newProjectRoot: newProjectRoot(config.projectsRoot, homedir()),
      dictionary: loadDictionary(),
      to,
      question,
      heardAt,
      kept: retrying ? null : keptWords.pending(),
    },
    {
      // Not for words kept, routed again: the router alone, at once (the classifier only adds its 4s
      // when its service is the one that's down).
      utterance: classifierEnabled() && !retrying ? decideUtterance : null,
      approval: classifierEnabled() && !classifierOffline() ? decideApproval : null,
      route: (input) => router.route(input, () => {}),
      trim: down ? null : trimForClaude,
      clean: cleaning && (() => cleaning),
      beforeRoute: (words) => {
        // Words kept are in the conversation already, from when they were said.
        if (!retrying) noted.entry = timeline.add({ who: "you", sessionId: null, folder: null, text: words });
      },
      offline,
      classifierOffline,
    },
  );
  // A correction the app could only ask about ("That already went to Kiko project. Which session
  // was it for?"): set aside, so the answer ("Rowan.") still resends the words it was about.
  if (noted.entry && decision.actions.some((a) => a.type === "say" && a.why === "resend_same")) noted.entry.aside = "asked";
  // Your words the app dealt with itself (a quick check, its own answer, a session it opened):
  // "that was for Rowan" next sends them there (timeline.ts latestSend). Not under a held send: that's what's latest.
  const how = noted.entry && !held ? handledBy(decision) : null;
  if (noted.entry && how) noted.entry.handled = how;
  report(decision);
  if (retrying) {
    const r = await retried(retrying, decision);
    if (r) return r;
  }
  // The words kept before, taken: sent now, or decided again. Once: they're kept no longer.
  if (decision.keptUsed) {
    const taken = keptWords.take();
    log("kept_taken", { how: decision.keptUsed, texts: taken.map((e) => e.text), to: decision.actions.find(isSend)?.session.sessionId ?? null });
  }
  if (decision.keep) keep(decision.keep.text, heardAt, true, context);
  // New words for a session while words kept wait for a retry, and the router answers again: those
  // go first, in the order said (each routed as it would have been), never after newer ones.
  if (!retrying && !decision.keptUsed && !decision.fallback && decision.actions.some(isSend) && keptWords.retrying && !routerDown()) await flushKept();
  // The phone's talk: nothing to send is Kiko's to deal with (a send says where as it goes: holdIf).
  if (!decision.actions.some(isSend)) talks.routed(null);
  // The router gave no answer: the phone shows what was said, as the Mac says it.
  const fallbackLine = decision.fallback && decision.actions.find((a): a is Act & { type: "say" } => a.type === "say" && (a.why ?? "").startsWith("route_fallback"));
  if (fallbackLine) talks.failed(fallbackLine.text);
  // Only "I don't see a session called Dozer.": the words went nowhere, and the phone says so.
  const notFound = decision.actions.find((a): a is Act & { type: "say" } => a.type === "say" && NOT_FOUND.has(a.why ?? ""));
  if (notFound && !decision.actions.some(isSend)) talks.failed(notFound.text);
  // "Kiko." with words kept for a pick (act() lets it through), and no session it picks.
  if (decision.step === "name-only") ui.info(`(only "${text.trim()}": nothing sent)`);
  // Your words as decided on: "Kiko, …" without the name (wake.ts).
  const words = decision.text;
  if (!retrying) noteSummaryFeedback(words, decision, waiting && !waiting.isPermission ? waiting.sessionId : (justSpoke?.id ?? null));
  // A press while the app decided (a press while the router thought used to drop these words, and
  // nothing said so). What it decided still happens: a send waits for the new
  // words, held (holdIf), so they can cancel or redirect it; otherwise it goes first.
  if (floor.presses !== press) {
    log("pressed_while_deciding", { text: words, router: Boolean(decision.router), actions: decision.actions.map((a) => a.type), keyDown: floor.pressed });
  }
  // Words heard and nothing done with them: no action, nothing said, no question asked. Logged,
  // shown, said, and failed on the phone: never silently.
  if (!held && !decision.actions.length && !decision.question && decision.step !== "name-only") await nothingDone(words, decision);
  // Every send decided ends sent, held, or logged and said why not (notSent): never silently.
  const sends = decision.actions.filter(isSend);
  const handed = new Set<Act>();
  let why = "not carried out";
  try {
    // Words the question was about, gone now or kept: said once, before what's said now when that
    // asks you something (the question has to be the last thing you heard), else after it.
    let unsent = settleQuestion(asked, decision, text, sessions);
    const asking = decision.question?.kind === "asked" || decision.actions.some((a) => a.type === "say" && asksYou(a.text));
    const actions = held && !held.settled ? await held.settleWith(decision, words, () => timeline.add({ who: "you", sessionId: null, folder: null, text: words })) : decision.actions;
    for (const action of actions) {
      handed.add(action);
      // A line isn't said over a press that came meanwhile: once the key is up.
      if (action.type === "say" && floor.pressed) await waitFor(() => !floor.pressed, KEY_UP_WAIT_MS);
      if (unsent && asking && action.type === "say") {
        await notSentAnywhere(unsent.question, "now", unsent.why);
        unsent = null;
      }
      await carryOutOrSay(action, decision, words, waiting, skippable, { press, onTheirWay });
    }
    if (unsent) await notSentAnywhere(unsent.question, "now", unsent.why);
  } catch (err) {
    why = err instanceof Error ? err.message : String(err);
    ui.error("reply", err);
    log("error", { where: "deliver", message: why });
  }
  for (const action of sends) if (!handed.has(action)) notSent(action, "send_dropped", why);
  return "done";
}

const isSend = (a: Act): a is Act & { type: "send" | "ask" | "resend" } => a.type === "send" || a.type === "ask" || a.type === "resend";

/** decide()'s lines that say your words found no session to go to (decide.ts notFoundLine). */
const NOT_FOUND = new Set(["unknown_session", "session_starting"]);

/** Your words, and nothing decided for them (`d`): logged as nothing_done, shown and said with a short reason. */
async function nothingDone(text: string, d: Decision) {
  const why = d.step === "router" && !d.router ? "you pressed again before I'd decided" : d.router ? "I couldn't work out what to do with it" : `nothing came of it (${d.step})`;
  log("nothing_done", { text, step: d.step, why, ...(d.router?.dropped?.length ? { dropped: d.router.dropped } : {}) });
  talks.failed(`Nothing done: ${why}`);
  ui.info(`(nothing done with that: ${why})`);
  if (floor.pressed) await waitFor(() => !floor.pressed, KEY_UP_WAIT_MS);
  await speakLine(`I didn't do anything with that: ${why}.`);
}

/** carryOut(); a send it couldn't carry out is logged and said (send_failed), not only in the error log. */
async function carryOutOrSay(action: Act, d: Decision, text: string, waiting: Held | null, skippable: Held | null, mine: Mine) {
  try {
    await carryOut(action, d, text, waiting, skippable, mine);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ui.error("reply", err);
    if (isSend(action)) return notSent(action, "send_failed", message);
    log("error", { where: `carry out ${action.type}`, message });
  }
}

/** A send decided that didn't go: logged (`event`, with why), and said, so you know to say it again. */
function notSent(action: Act & { type: "send" | "ask" | "resend" }, event: "send_failed" | "send_dropped", why: string) {
  const to = { sessionId: action.session.sessionId, cwd: action.session.cwd };
  const text = action.type === "send" ? action.text : action.type === "ask" ? action.message : action.last.text;
  const name = nameOf(to);
  log(event, { sessionId: to.sessionId, name, text, kind: action.type, why });
  talks.failed(`Not sent to ${name}: ${flat(why, 120)}`);
  ui.info(`(not sent to ${name}: ${why})`);
  void speakLine(`I couldn't send that to ${spoken(name)}.`);
}

/**
 * The app's "which session?" question, for your words now to answer: taken, so it's answered once
 * (settleQuestion puts it back when they move on). Left alone for words that answer a permission
 * prompt (`permission`), and, once you've moved on from it, for words that something newer waits for
 * (`newer`: a held send, or another question the app asked since): they're for that.
 */
function takeQuestion(permission: boolean, newer: boolean): Asked | null {
  const pending = askedWhere.pending;
  if (!pending || permission || (pending.told && newer)) return null;
  return askedWhere.take();
}

/**
 * What your words did with the app's "which session?" question (`asked`, the one they could
 * answer): a new one is kept; one answered or cancelled is logged. One your words moved on from is
 * kept, for a plain pick, and the app says once that its words weren't sent; one a new question
 * replaced is gone, and said too. What to say, and why, is returned for decideAndAct to say in its
 * place. Words read in code (no router) are noted in the conversation here, as the router's are when
 * it's asked.
 */
function settleQuestion(taken: Asked | null, d: Decision, said: string, sessions: Session[]): { question: Question; why: string } | null {
  const q = d.question;
  const name = (id: string) => {
    const session = findSession(sessions, id);
    return session ? sessionName(session) : (currentName(id) ?? id);
  };
  const names = (ids: string[]) => ids.map(name);
  const asked = taken?.question ?? null;
  if (q?.kind === "asked") {
    // Words kept from before, a question asked now about others: these are gone.
    const replaced = askedWhere.set(q.question) ?? (taken && taken.question.text !== q.question.text ? taken : null);
    log("question_pending", {
      text: q.question.text,
      offered: names(q.question.offered),
      line: q.question.line,
      ...(q.question.offer ? { offer: true } : {}),
      ...(asked && asked.text === q.question.text ? { again: true } : {}),
    });
    if (!replaced) return null;
    log("question_dropped", { text: replaced.question.text, line: replaced.question.line, why: "replaced", said, told: replaced.told });
    return replaced.told ? (ui.info(notSentNote(replaced.question, "a new question replaced it")), null) : { question: replaced.question, why: "a new question replaced it" };
  }
  if (!asked) return null;
  if (q && !d.router) timeline.add({ who: "you", sessionId: null, folder: null, text: said });
  if (q?.kind === "answered") {
    log("question_answered", { text: asked.text, sessionId: q.sessionId, name: name(q.sessionId), how: q.how, said, ...(q.added ? { added: q.added } : {}) });
    // Words kept, asked about as a retry found them late ("Still send …?"): they go now, kept no longer.
    if (asked.kept) keptWords.remove(asked.text);
    return null;
  }
  if (q?.kind === "cancelled") {
    log("question_cancelled", { text: asked.text, said });
    // "No." to "Still send …?": dropped.
    if (asked.kept && keptWords.remove(asked.text)) log("kept_dropped", { text: asked.text, said });
    return null;
  }
  // An offer ("Want me to send that to Bobby?") moved on from: let go, only shown. The new words went
  // where they would have; the app only offered, so there's nothing to keep or say. Unless it asked
  // about words kept ("Still send …?"): those are still kept, for "send it" or a name.
  if (asked.offer) {
    log("question_dropped", { text: asked.text, line: asked.line, why: "moved on", offer: true, said, ...(asked.kept ? { kept: true } : {}) });
    const still = asked.kept && keptWords.list().some((e) => e.text === asked.text);
    ui.info(still ? keptNote(asked.text) : notSentNote(asked, "you moved on from the offer"));
    return null;
  }
  // Moved on: kept, for a plain pick. Said once; after that it waits out its time quietly.
  if (taken!.told) {
    askedWhere.restore(taken!);
    log("question_kept", { text: asked.text, said, told: true });
    return null;
  }
  askedWhere.set(asked, true);
  log("question_kept", { text: asked.text, line: asked.line, why: "moved on", said });
  return { question: asked, why: "you moved on" };
}

/**
 * Words the app asked "which session?" about went nowhere (`why`): shown, and said once (`say`:
 * "now", or "after" what you're saying or what's being decided; null, only shown: you've heard it
 * already). Said, it's a line like any other: a phone away from the app gets it in what it missed.
 */
export async function notSentAnywhere(question: Question, say: "now" | "after" | null, why: string) {
  const kept = askedWhere.pending?.question.text === question.text;
  ui.info(notSentNote(question, why, kept));
  if (!say) return;
  if (say === "after") await waitFor(() => !floor.pressed && !floor.replying, KEY_UP_WAIT_MS);
  else if (floor.pressed) await waitFor(() => !floor.pressed, KEY_UP_WAIT_MS);
  await speakLine(`I didn't send "${firstWords(question.text)}" anywhere.`);
}

function notSentNote(question: Question, why: string, kept = false) {
  return kept ? `(not sent anywhere yet: "${flat(question.text, 80)}"; ${why}. Name a session to send it)` : `(not sent anywhere: "${flat(question.text, 80)}"; ${why})`;
}

// ── Words kept when the router couldn't answer (2026-11-12) ─────────────────

/** What Kiko's page shows for words kept (core/kept.ts): what's waiting, and what sends it. */
function keptNote(text: string, retrying = false) {
  const how = retrying ? "trying again by itself; a session's name sends it there now" : `say send it, or a session's name, within ${Math.round(KEPT_MS / 60_000)} minutes`;
  return `(kept, not sent: "${flat(text, 80)}". ${how.charAt(0).toUpperCase()}${how.slice(1)})`;
}

/**
 * Words to keep (decide()'s, said `at`): kept, logged and shown on Kiko's page. `retry`: routed again
 * by themselves; `context`: the conversation as it stood then, which they're routed again with.
 */
export function keep(text: string, at: number, retry = true, context?: KeptContext) {
  const dropped = keptWords.keep(text, { at, retry, ...(context ? { context } : {}) });
  log("words_kept", { text, retry, kept: keptWords.list().length });
  for (const e of dropped) log("kept_expired", { text: e.text, why: "too many" });
  ui.info(keptNote(text, retry));
}

// A retry this long after the words were said asks first (fallback.ts STALE_MS); the harness shortens it.
const staleMs = () => Number(appEnv("TEST_STALE_MS") ?? STALE_MS);

/**
 * What a retry's decision means (decideAndAct): the router still can't answer ("failed", put back for
 * the next retry, nothing said); words long after they were said, asked about first ("Still send
 * "Nice, this one reads…" to Rowan?": the session may have moved on) or, with newer words going, held for
 * "send it"; otherwise null, and it's carried out as decided, each send said as it goes ("Sent to
 * Rowan.") and not held: the router picked, as it would have when they were said.
 */
async function retried(r: Retrying, d: Decision): Promise<"failed" | "done" | null> {
  const { entry } = r;
  const ageMs = Date.now() - entry.at;
  if (d.fallback) {
    log("kept_retry", { text: entry.text, ok: false, why: d.fallback.why, error: d.fallback.error, ageMs });
    keptWords.failed(entry);
    return "failed";
  }
  keptWords.sent(entry);
  log("kept_retry", { text: entry.text, ok: true, ageMs, actions: d.actions.map((a) => a.type) });
  const sends = d.actions.filter(isSend);
  if (sends.length && ageMs > staleMs()) {
    const first = sends[0];
    const words = first.type === "send" ? first.text : first.type === "ask" ? first.message : first.last.text;
    keptWords.hold(words, entry.at);
    if (r.stale === "hold") {
      log("kept_held", { text: words, why: "stale, newer words going", ageMs });
      ui.info(keptNote(words));
      return "done";
    }
    const line = staleLine(firstWords(entry.text), spoken(nameOf(first.session)));
    const question: Question = { text: words, offered: [first.session.sessionId], line, offer: true, kept: true };
    const replaced = askedWhere.set(question);
    log("question_pending", { text: words, offered: [nameOf(first.session)], line, offer: true, kept: true });
    if (replaced) log("question_dropped", { text: replaced.question.text, line: replaced.question.line, why: "replaced", told: replaced.told });
    if (floor.pressed) await waitFor(() => !floor.pressed, KEY_UP_WAIT_MS);
    await speakLine(line);
    return "done";
  }
  d.actions = d.actions.map((a) => (a.type === "send" ? { ...a, unsure: undefined, line: sentLine(spoken(nameOf(a.session))) } : a));
  return null;
}

/**
 * A retry of the words kept (core/kept.ts onDue, or the network back): each routed again, oldest
 * first, in line with your words (in-line.ts), until one still can't be. Known offline, none is
 * tried, and that counts as a try.
 */
let retryRunning = false;
export async function retryKept() {
  if (retryRunning) return;
  retryRunning = true;
  try {
    while (keptWords.retrying) {
      const down = routerDown();
      if (down) {
        log("kept_retry", { ok: false, why: "offline", error: down.detail, skipped: true });
        return keptWords.failedAgain();
      }
      const turn = await inLine.enter();
      let r: "failed" | "done" = "done";
      try {
        const entry = keptWords.next();
        if (!entry) return;
        r = await decideAndAct(entry.text, floor.presses, null, turn.done, entry.at, { entry, stale: "ask" });
      } finally {
        turn.done();
      }
      if (r === "failed") return;
    }
  } finally {
    retryRunning = false;
  }
}

/** The words kept, routed again before newer words go (decideAndAct): late ones are held, not asked about, as those go. */
async function flushKept() {
  for (;;) {
    const entry = keptWords.next();
    if (!entry) return;
    if ((await decideAndAct(entry.text, floor.presses, null, () => {}, entry.at, { entry, stale: "hold" })) === "failed") return;
  }
}

/** The retries stopped with words unsent (core/kept.ts onGaveUp): said once; they stay kept for "send it" or a name. */
export async function gaveUp(left: readonly KeptEntry[]) {
  log("kept_gave_up", { texts: left.map((e) => e.text) });
  for (const e of left) ui.info(keptNote(e.text));
  if (floor.pressed) await waitFor(() => !floor.pressed, KEY_UP_WAIT_MS);
  await speakLine(gaveUpLine(left.length));
}

/**
 * The network is back (core/online.ts onBack): words kept waiting for a retry are retried now, and
 * say where they went as they go ("Sent to Rowan."). Ones the retries gave up on are only mentioned,
 * once ("I'm back online. Your last message is still waiting: …"). Otherwise nothing: being back is no news.
 */
export async function backOnline(service?: string) {
  // Back, but not the service the router needs (OpenRouter answering, Anthropic still not): nothing yet.
  const still = routerDown();
  log("online_back", { kept: keptWords.list().length, retrying: keptWords.retrying, ...(service ? { service } : {}), ...(still ? { routerDown: still.detail } : {}) });
  if (still) return;
  if (keptWords.retrying) return keptWords.now();
  if (!keptWords.pending()) return;
  if (floor.pressed) await waitFor(() => !floor.pressed, KEY_UP_WAIT_MS);
  // Sent or gone while the key was down.
  const left = keptWords.pending();
  if (left) await speakLine(backLine(left.texts.length));
}

/** The first few words, for a line that says which words it means: "quick test from the phone…". */
export function firstWords(text: string, max = 6) {
  const words = text
    .trim()
    .replace(/[.!?,;:]+$/, "")
    .split(/\s+/);
  return words.length > max
    ? `${words
        .slice(0, max)
        .join(" ")
        .replace(/[,;:]$/, "")}…`
    : words.join(" ");
}

/** Your words are being dealt with: the status line and the header show it once it takes a moment. */
export function startDeciding(text: string) {
  state.deciding = { text, startedAt: Date.now() };
  ui.set({ routed: null });
  writeState();
  return state.deciding;
}

/** Done with them: unless a press started on new words meanwhile. */
export function endDeciding(mine: typeof state.deciding) {
  if (state.deciding !== mine) return;
  state.deciding = null;
  writeState();
}

/**
 * Your words got to a session (`to`), or a quick task took them (null): "sent to <name>" on the
 * status line, and in the header where they went.
 */
export function landed(to: Target | null, later = false) {
  const name = to ? nameOf(to) : "a quick check";
  if (to) state.sent = { name, sessionId: to.sessionId, at: Date.now() };
  if (to && state.unsent?.to.sessionId === to.sessionId) state.unsent = null;
  // What a phone missed of it has been replied to.
  if (to) state.phone?.sessionReplied(to.sessionId);
  // A held send going out once you'd started on new words: its own words, and those keep deciding.
  // Words that waited for a reading were shown going when you said them.
  const words = later ? null : (state.landing ?? state.deciding);
  state.landing = null;
  if (words) {
    const routed = { text: words.text, to: name, sessionId: to?.sessionId ?? null, tookMs: Date.now() - words.startedAt, at: Date.now() };
    if (words === state.deciding) state.deciding = null;
    ui.set({ routed });
    setTimeout(() => ui.state.routed === routed && ui.set({ routed: null }), ROUTED_MS).unref();
  }
  writeState();
}

/** What decide() found out along the way: costs, the classifier's and the router's reads, failed model calls. */
function report(d: Decision) {
  totals.classifier += d.classifierCostUsd;
  totals.llm += d.llmCostUsd;
  for (const g of d.guards ?? []) log("guard", g);
  // A name said that's no session's, taken as one's ("Lazey" for Lacy): asked about, or the router's guess.
  if (d.guess) log("name_guess", { ...d.guess, name: currentName(d.guess.sessionId) ?? null });
  for (const e of d.errors) {
    // Its service not answering (a network error, out of time): said so plainly, the words routed without it.
    if (e.where === "classify_utterance") ui.error("classifier", unreachable(e.message) ? withoutClassifierLine(serviceName(openrouterService())) : e.message);
    log("error", e);
  }
  if (d.toApp) log("name_up_front", { text: d.text, said: d.nameSaid, ...(d.nameAlso?.length ? { alsoSession: d.nameAlso } : {}) });
  // The router gave no answer, or wasn't asked (offline): what the app knew, and did instead.
  if (d.fallback) log("route_fallback", { text: d.text, ...d.fallback, ...(d.offline ? { classifier: "skipped" } : {}) });
  if (d.approval) ui.info(`Classifier: ${d.approval.answer} ${d.approval.confidence.toFixed(2)} (${d.approval.ms}ms)`);
  if (d.utterance) {
    const who = d.utterance.audience === "app" ? "app" : sessionName(d.utterance.audience);
    // Named by the model that decided: "d1-ultra: clipkit 0.92 · message 0.97 (480ms)".
    const by = d.utterance.model
      .split("/")
      .pop()!
      .replace(/-\d{8}$/, "");
    ui.info(`${by}: ${who} ${d.utterance.audienceConfidence.toFixed(2)} · ${d.utterance.intent} ${d.utterance.intentConfidence.toFixed(2)} (${d.utterance.ms}ms)`);
  }
  if (d.router) {
    totals.turns++;
    const r = d.router;
    ui.info(routeCostLine(modelName(), r.costUsd, r.usage));
    log("route_turn", { llmCost: r.costUsd, said: r.text, actions: r.actions.length });
  }
}

/** A model call's error that says its service didn't answer: a network error, or out of time. */
const unreachable = (message: string) => networkCode(new Error(message)) !== null || /\btime(?:d)?[ -]?out\b|aborted/i.test(message);

/** Whose words an action carries out: their press's number, and what lets the next words be decided (deliver). */
type Mine = { press: number; onTheirWay: () => void };

/**
 * One action decide() chose. `waiting` is the session held (in its hook) when you started talking;
 * `skippable`, the announcement "skip that" skipped then (floor.ts skippable); `mine`, whose words.
 */
async function carryOut(action: Act, d: Decision, text: string, waiting: Held | null, skippable: Held | null, mine: Mine) {
  switch (action.type) {
    case "permission":
      return answerPermission(waiting!, text, action.answer);
    case "answer":
      return answerQuestion(waiting!, action.text);
    case "repeat":
      return repeatFor(action.session, text);
    case "wrap_up":
      return wrapUp(waiting, text);
    case "undo":
      return undo(waiting, text);
    case "skip":
      return skip(skippable, text);
    case "more":
      return tellMore(action.sessionId, action.topic, text);
    case "send":
      if (action.trimmed) trimmed(text, action.trimmed);
      if (action.cleaned) cleanedUp(action.text, action.cleaned);
      if (action.from) log("start_session_redirected", { cwd: action.session.cwd, sessionId: action.session.sessionId });
      return holdIf(action, mine, (said) => sendTo(action.session, action.text, said ? null : action.line));
    case "ask":
      return holdIf(action, mine, (said) => sendTo(action.session, action.message, said ? null : `Asking ${spoken(sessionName(action.session))}.`));
    case "resend": {
      // The router noted your words as it was asked; otherwise they're noted here.
      if (!d.router) timeline.add({ who: "you", sessionId: null, folder: null, text });
      // Words the app was checking itself: the check stops now (or its answer isn't said), before
      // any hold, so it can't be read out over the words going where they belong.
      const stoppedCheck = action.last.app === "quick_task" && dropQuickTask(text);
      // Held words nobody got: they just go there.
      return holdIf(action, mine, (said) => (action.last.held ? redirectHeld(action.session, action.last, said, action.text) : resend(action.session, action.last, action.text, stoppedCheck)));
    }
    case "stop":
      return stopSession(action.session);
    case "stop_ignored":
      return log("stop_ignored", { text, sessionId: action.session.sessionId });
    case "rename":
      return renameSession(action.session, action.name);
    case "start": {
      const app = action.app ? agents.find((a) => a.id === action.app && a.launches) : undefined;
      if (app) return startInApp(app, action.where, action.name, action.prompt, "voice", action.agent ?? "");
      return startSession(action.where, action.name, action.prompt, "voice", action.agent ?? "");
    }
    case "quick_task":
      return startQuickTask(action.task, action.cwd, text);
    case "cancel_quick":
      return cancelQuickTask(text);
    case "trust_scratch":
      return trustScratch("voice");
    case "upgrade":
      return startCheckout(action.interval);
    case "refused": {
      // What was asked, kept: a yes to the offer to turn Voice can on carries it out (turnOnVoice).
      const then = action.then;
      return void (await allowed(action.what, { ...(action.session ? { to: action.session } : {}), ...(then ? { then: () => carryOut(then, d, text, waiting, skippable, mine) } : {}) }));
    }
    case "voice_on":
      return turnOnVoice();
    case "dictionary":
      return action.op === "add" ? addWord(action.heard, action.write, "voice") : removeWord(action.heard, "voice");
    case "pronounce":
      return action.op === "add" ? addSaying(action.word, action.say, "voice") : forgetSaying(action.word);
    case "say":
      if (action.why) log(action.why, { text, said: action.text });
      return speakLine(action.offer ? offerHandOff(action.offer, action.text) : action.text);
  }
}

function trimmed(text: string, t: Trimmed) {
  const how = t.by === "phrase" ? "phrase" : `${modelName()} ${t.ms}ms`;
  log("trimmed", { text, kept: t.kept, dropped: t.dropped, how });
  ui.info(`(left out ${t.dropped.map((d) => `"${d}"`).join(", ")}: ${how})`);
}

/** Your words went cleaned up: the log has both, the screen what was left out. */
function cleanedUp(text: string, c: Cleaned) {
  const out = leftOut(c.said, text);
  log("cleaned", { said: c.said, sent: text, leftOut: out, ms: c.ms });
  ui.info(`(cleaned up${out.length ? `: left out ${out.map((w) => `"${w}"`).join(", ")}` : ""} · ${modelName()} ${c.ms}ms)`);
}

/**
 * Passes words to a session: as its reply when the app holds its finished turn, or typed into its
 * terminal. `line` is said first when it goes somewhere you didn't just hear from (default "To <session>.");
 * null says nothing (it was said already: holdIf's "To Lacy.", or the caller's). The "sent" beep is
 * for sends nothing was said about: after a line that names where it went, it's one sound too many.
 * A finished turn of that session you haven't heard yet is read out first (replyLater).
 */
async function sendTo(to: Target, text: string, line?: string | null) {
  const waiting = floor.waiting;
  floor.spokeLast = null;
  const name = nameOf(to);
  const switched = to.sessionId !== (waiting?.sessionId ?? state.target?.sessionId);
  // Its finished turn, still in line to be read out (its hook open or not). Typed in, your words
  // would sit in Claude Code's queue until the app let it go, and land after your next reply.
  const unread = floor.unread(to.sessionId);
  // The waiting session: your words are its reply.
  const held = !unread && waiting?.sessionId === to.sessionId ? waiting : null;
  // Not waiting for a reply: only typed in, which "Voice can" may not allow. The one that is waiting
  // keeps waiting.
  if (!held && !unread?.open && !(await allowed("message", { to, then: () => sendTo(to, text, line) }))) return;
  if (unread) return replyLater(unread, to, text, line !== null && Boolean(line || switched) ? (line ?? `To ${spoken(name)}.`) : null, line !== null);
  timeline.add({ who: "you", sessionId: to.sessionId, folder: name, text, turn: floor.turn });
  state.target = { sessionId: to.sessionId, cwd: to.cwd };

  if (held) {
    floor.drop(held);
    return replyThrough(held, to, text, line !== null);
  }
  floor.release(waiting, "moved on; the waiting session stopped");
  // Going somewhere you didn't just hear from: say where, so a wrong guess is obvious. Not when
  // it can't get there: typeInto says why instead.
  const session = findSession(await getSessions(1000), to.sessionId);
  // Not for one still starting: typeInto says it's holding them.
  const saying = line !== null && Boolean(line || switched) && Boolean(session?.place) && !isStarting(session!);
  // Named as just listed, not as the window's list has it: that's looked at every 4 seconds, so a
  // session new to it (or renamed) would be said by its folder ("To 2026 11 05 internal.") right
  // after the app named it ("Want me to send that to Bobby?").
  if (saying) void speakLine(line ?? `To ${spoken(sessionName(session!))}.`);
  await typeInto(to, text, line !== null && !saying);
}

/**
 * Words for a session whose finished turn you haven't heard yet (it finished while you asked it
 * something else): it's read out first, in its place in line, then they go to it
 * through its hook, typed in once that's gone, with no reply window in between: they're its reply.
 * Words for it again meanwhile go along with them, in order. Where they're going is said and shown
 * now (`say`), as for any send; `beep`: the "sent" beep once they've gone, when nothing is said.
 */
function replyLater(unread: Held, to: Target, text: string, say: string | null, beep: boolean) {
  const name = nameOf(to);
  // You've moved on from the one waiting, which you heard: let go as usual.
  floor.release(floor.waiting, "moved on; the waiting session stopped");
  if (!unread.continued) heldReplies.set(to.sessionId, 0);
  // In the timeline ahead of your words, as it's heard ahead of them; announce() doesn't add it
  // again. Unless its announcement was started (and put back by a press): it's there already.
  if (!shown.has(unread)) {
    const context = contextFor(to.sessionId, name, unread);
    const asked = askedOf(to.sessionId, unread);
    shown.set(unread, { entry: timeline.add({ who: "claude", sessionId: to.sessionId, folder: name, text: unread.text }), context, asked });
  }
  timeline.add({ who: "you", sessionId: to.sessionId, folder: name, text, turn: floor.turn });
  state.target = { sessionId: to.sessionId, cwd: to.cwd };
  if (say) void speakLine(say);
  const words = laterWords.get(unread);
  log("answered_held", { sessionId: to.sessionId, text, readFirst: true, hookOpen: unread.open, ...(words ? { after: words.texts.length } : {}) });
  ui.info(`(→ ${name} once its answer is read out)`);
  // The phone's talk waits too, and goes along with the words.
  const waiting = [...talks.held({ sessionId: to.sessionId, name }, `Waiting for ${name}'s answer to be read out`)];
  landed(to);
  if (words) {
    words.texts.push(text);
    words.talks.push(waiting);
    words.beep &&= beep && !say;
    return;
  }
  laterWords.set(unread, { texts: [text], beep: beep && !say, at: state.pressAt, talks: [waiting] });
  floor.replyAfter(unread, () => {
    const w = laterWords.get(unread);
    laterWords.delete(unread);
    if (!w?.texts.length) return;
    const all = w.texts.join("\n\n");
    log("held_reply", { sessionId: to.sessionId, text: all, hookOpen: unread.open });
    talks.run(w.talks.flat(), () =>
      replyThrough(unread, to, all, w.beep, true, w.at)
        // Several sent as one: each of their entries says it didn't go (typeInto marks only the whole).
        .then((went) => {
          if (!went) for (const text of w.texts) timeline.markNotSent(to.sessionId, text);
        })
        .catch((err) => {
          ui.error("reply", err);
          log("send_failed", { sessionId: to.sessionId, name: nameOf(to), text: all, why: err instanceof Error ? err.message : String(err), where: "held_reply" });
          for (const text of w.texts) timeline.markNotSent(to.sessionId, text);
          void speakLine(`I couldn't send that to ${spoken(nameOf(to))}.`);
        })
        .finally(() => talks.current().forEach((t) => t.finish(`Not sent to ${nameOf(to)}`))),
    );
  });
}

/**
 * Words for a finished turn the app holds, as its reply through the hook: Claude carries on with them.
 * Near Claude Code's cap (or once its hook is gone) it's let stop, and they're typed in instead,
 * which is a real prompt and also resets the cap. Unless voice may only reply. `later`: they waited
 * for its reading, and your newer words aren't these (landed). True when they reached it.
 */
async function replyThrough(held: Held, to: Target, text: string, beep: boolean, later = false, at = state.pressAt) {
  const name = nameOf(to);
  const count = heldReplies.get(to.sessionId) ?? 0;
  if (count < agentOf(to).heldReplies && held.answer(text)) {
    if (beep) cue("sent", at);
    // Its reply: Claude carries on with it at once.
    talks.delivered({ sessionId: to.sessionId, name }, text, { started: true });
    heldReplies.set(to.sessionId, count + 1);
    ui.info(`→ ${name}`);
    landed(to, later);
    // Nobody waits now: the next in line (once your words are dealt with, when they still are).
    floor.drain();
    return true;
  }
  held.answer(null);
  floor.drain();
  const off = `I couldn't get that to ${spoken(name)} through its reply, and your voice can only answer a session that's waiting.`;
  if (!(await allowed("message", { to, off, then: () => typeInto(to, text, beep, later, at) }))) {
    timeline.markNotSent(to.sessionId, text);
    return false;
  }
  await new Promise((r) => setTimeout(r, 500));
  return typeInto(to, text, beep, later, at);
}

/**
 * Takes back your words still waiting for a session's finished turn to be read out ("never mind",
 * or a correction): nobody got them. `text`: only those words. True when there were.
 */
function takeBack(sessionId: string, text?: string) {
  for (const [request, words] of laterWords) {
    if (request.sessionId !== sessionId) continue;
    const i = text === undefined ? 0 : words.texts.lastIndexOf(text);
    if (i < 0) return false;
    const taken = text === undefined ? words.texts.splice(0) : words.texts.splice(i, 1);
    for (const t of (text === undefined ? words.talks.splice(0) : words.talks.splice(i, 1)).flat()) t.failed("Taken back: not sent");
    if (!words.texts.length) {
      laterWords.delete(request);
      floor.cancelReply(request);
    }
    log("held_reply_taken_back", { sessionId, text: taken });
    return true;
  }
  return false;
}

/**
 * Carries out a send, ask or resend (`go`), first holding it when the app had to guess where it
 * goes (decide's `unsure`) and "Hold unsure sends" is on: it says where ("To Lacy."), waits
 * HOLD_MS once that's heard, then `go(true)` (said: no "To Lacy." again). A press meanwhile keeps
 * it until your words are dealt with (hold.ts settleWith, keyUp). Not when it couldn't get there anyway:
 * then it says why at once, as before.
 *
 * Sure sends are held too when more words of yours come after these (`mine`: a press since, the key
 * still down or its words still dealt with): they settle it, so "cancel that" or "no, that's for
 * clipkit" still can; anything else lets it go first. Once held, the next words may be decided.
 */
async function holdIf(action: Act & { type: "send" | "ask" | "resend" }, mine: Mine, go: (said: boolean) => Promise<unknown>) {
  talks.routed({ sessionId: action.session.sessionId, name: nameOf(action.session) });
  const why = action.unsure ?? (floor.wordsAfter(mine.press) ? "pressed while deciding" : null);
  if (!why || !config.holdUnsure || !(await reachable(action.session))) return go(false);
  const h = startHold(action, why, floor.wordsAfter(mine.press));
  mine.onTheirWay();
  const verdict = await h.verdict;
  if (verdict !== "send") return;
  state.landing = h.words;
  try {
    await go(h.said);
  } finally {
    state.landing = null;
    h.done();
  }
}

/** Whether a send to this session would get there: its held turn's reply, else typed in, if voice may. */
async function reachable(to: Target) {
  const current = floor.waiting;
  if (floor.heldStop(to.sessionId) || (current && !current.isPermission && current.sessionId === to.sessionId)) return true;
  if (!voiceAllows(config.voiceCan, "message")) return false;
  const session = findSession(await getSessions(1000), to.sessionId);
  return Boolean(session?.place);
}

/**
 * Holds a send (`why`, for the log). `pressed`: words of yours come after these (a press while they
 * were dealt with, the key still down or its words not yet decided): it waits for them.
 */
function startHold(action: Act & { type: "send" | "ask" | "resend" }, why: string, pressed: boolean): Hold {
  const to = { sessionId: action.session.sessionId, cwd: action.session.cwd };
  const name = nameOf(to);
  const text = action.type === "send" ? action.text : action.type === "ask" ? action.message : action.last.text;
  const h = new Hold(
    {
      to,
      name,
      text,
      why,
      kind: action.type,
      last: action.type === "resend" ? action.last : { sessionId: to.sessionId, folder: name, text, held: true },
      words: state.deciding,
      pressed,
    },
    holdOptions,
  );
  // One held before still waiting (its own clock, or words not decided yet) isn't replaced, only
  // no longer the one the status line shows: it goes, or not, as it would have.
  if (state.holding && !state.holding.settled) log("send_held_meanwhile", { sessionId: state.holding.to.sessionId, text: state.holding.text, next: text });
  state.holding = h;
  log("send_held", { sessionId: to.sessionId, name, text, why: h.why, kind: h.kind, ...(pressed ? { waitingFor: "your next words" } : {}) });
  talks.held({ sessionId: to.sessionId, name }, `To ${name} in a moment`);
  ui.info(`(holding: → ${name}; talk now to change it)`);
  writeState();
  void (async () => {
    // Not said over a press: once the key is up. Your new words may settle it first; then it goes
    // with the usual "To Lacy." (go(said)).
    if (floor.pressed) await waitFor(() => !floor.pressed || h.settled, KEY_UP_WAIT_MS);
    if (h.settled) return;
    h.said = true;
    await sayWhere(h, action.type === "ask" ? `Asking ${spoken(name)}.` : `To ${spoken(name)}.`);
    h.heard();
  })();
  return h;
}

/**
 * Says where a held send is going, and resolves once it's been heard: played and quiet again (or
 * done without a sound: muted), cut, never started, or the hold is settled or you pressed.
 */
async function sayWhere(h: Hold, line: string) {
  ui.voice(line);
  state.lastSpoken = line;
  timeline.add({ who: "app", sessionId: null, folder: null, text: line });
  let done = false;
  let started = false;
  const speech = await openSpeech((handlers) => openTts({ ...handlers, onDone: () => ((done = true), handlers.onDone()) }));
  if (speech === SILENT) done = true;
  speech.push(line);
  speech.end();
  ttsCost(speech.chars());
  const at = Date.now();
  await waitFor(() => {
    started ||= floor.speaking;
    return h.settled || h.pressed || ((done || started) && !floor.speaking) || (!started && Date.now() - at > 3000);
  }, 15_000);
}

/** Resolves once `cond` holds, or after `maxMs`. */
export async function waitFor(cond: () => boolean, maxMs: number) {
  const end = Date.now() + maxMs;
  while (!cond() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
}

/** A held send redirected ("no, that's for clipkit"): nobody got it, so it just goes there. */
async function redirectHeld(to: Target, last: Sent, said: boolean, text = last.text) {
  const line = said ? null : `To ${spoken(nameOf(to))} instead.`;
  // sendTo says nothing for a reply to the session waiting for one: say it here.
  const waiting = floor.waiting;
  const here = line && waiting && !waiting.isPermission && waiting.sessionId === to.sessionId;
  if (here) void speakLine(line);
  await sendTo(to, text, here ? null : line);
}

/** "No thanks", "that's all": nothing to send; the waiting session stops. */
function wrapUp(waiting: Held | null, text: string) {
  floor.spokeLast = null;
  timeline.add({ who: "you", sessionId: null, folder: null, text });
  log("wrap_up", { text, sessionId: waiting?.sessionId ?? null });
  if (waiting) floor.release(waiting, "wrapping up; nothing sent");
  else ui.info("(wrapping up; nothing sent)");
}

/**
 * "Skip that": the announcement your press put back before you heard it, or the next in line, isn't
 * made; its session is let go, as when its window runs out. Your words waiting for it still go.
 */
function skip(request: Held | null, text: string) {
  timeline.add({ who: "you", sessionId: null, folder: null, text });
  const name = request && nameOf(refOf(request));
  const skipped = Boolean(request && floor.skip(request, `skipped ${name}`));
  log("skip", { text, sessionId: request?.sessionId ?? null, skipped });
  if (!skipped) ui.info("(nothing to skip)");
}

/** "Never mind": stop the session that just got your words, if it's still on them. */
async function undo(waiting: Held | null, text: string) {
  const last = timeline.lastSent(UNDO_WITHIN_MS);
  floor.spokeLast = null;
  const said = timeline.add({ who: "you", sessionId: null, folder: null, text });
  log("undo", { text, lastSent: last ?? null });
  floor.release(waiting, "never mind; nothing sent");
  if (!last?.sessionId || last.sessionId === waiting?.sessionId) return;
  // Marked, so "that was for Rowan" next still means these words (timeline.ts latestSend), and the
  // resend knows they were taken back here: nothing to stop again.
  said.aside = "undo";
  // Taken back once already: nothing more to stop (a second Escape opens Claude Code's rewind menu).
  if (last.undone) return ui.info("(never mind: that was taken back already)");
  last.undone = true;
  // They never reached it (Entry.notSent): nothing to take back or stop, nor to "try again".
  if (last.notSent) {
    if (state.unsent?.to.sessionId === last.sessionId && state.unsent.text === last.text) state.unsent = null;
    return ui.info(`(never mind: nothing was sent to ${currentName(last.sessionId) ?? last.folder})`);
  }
  // Still waiting for its finished turn to be read out: it never gets them.
  if (takeBack(last.sessionId, last.text)) return ui.info(`(never mind: nothing sent to ${currentName(last.sessionId) ?? last.folder})`);
  const session = findSession(await getSessions(0), last.sessionId);
  if (!session) return;
  if (session.status !== "busy") return speakLine(`${spoken(sessionName(session))} already finished that.`);
  // Stopping it presses Escape in it: only when voice can do everything.
  const off = `Stopping sessions by voice is off, so ${spoken(sessionName(session))} will carry on with that.`;
  if (await allowed("stop", { to: session, off, then: () => stopSession(session) })) await stopSession(session);
}

/**
 * "No, that was for clipkit": what the app last sent went to the wrong session (or sessions, when
 * the router asked several). The same words go to the right one, as any message would, unless it
 * got them too. A wrong one still working on them is stopped, like "never mind" does, when voice
 * can do everything; one that finished, or moved on to something newer, is left alone. Nothing
 * more is typed into a wrong one: a note you didn't say ("ignore that") is a new instruction it
 * could act on in ways you can't see. `text`: the words that go, when not the same as sent
 * (decide.ts: without a name heard wrong up front, "Too rowing, …"). Words the app dealt with
 * itself (Sent.app: a quick check, its answer) went to no session, so nothing is stopped there;
 * `stoppedCheck`: the quick check they started was stopped (dropQuickTask), and said so.
 */
async function resend(to: Target, last: Sent, text = last.text, stoppedCheck = false) {
  log("redirect", { to: to.sessionId, lastSent: last, ...(text !== last.text ? { text } : {}) });
  const name = spoken(nameOf(to));
  // Words that never reached it (Sent.notSent), or that "no, cancel that" took back already
  // (Sent.undone: stopped, or taken off its queue): nothing to stop there, nor to say again.
  // Words the app dealt with itself (Sent.app) went to no session.
  const got = last.app ? [] : [...(last.notSent || last.undone ? [] : [{ sessionId: last.sessionId, folder: last.folder }]), ...(last.undone ? [] : (last.also ?? []))];
  const already = got.some((x) => x.sessionId === to.sessionId);
  const sessions = await getSessions(0);
  const stopped: string[] = [];
  const carrying: string[] = [];
  const done: string[] = [];
  let off = false;
  for (const wrong of got.filter((x) => x.sessionId !== to.sessionId)) {
    // Still waiting for its finished turn to be read out: taken back, nobody got them.
    if (takeBack(wrong.sessionId, last.text)) continue;
    const session = findSession(sessions, wrong.sessionId);
    const called = spoken(session ? sessionName(session) : wrong.folder);
    if (!session || !stillOn(session, last.text)) done.push(called);
    else if (!voiceAllows(config.voiceCan, "manage") || !session.place?.keys) {
      off ||= !voiceAllows(config.voiceCan, "manage");
      carrying.push(called);
    } else if ((await interrupt(session)).sent) {
      stopped.push(called);
    } else {
      carrying.push(called);
    }
  }
  const first = already
    ? stopped.length
      ? `${name} already has it; stopped ${andList(stopped)}.`
      : `That already went to ${name}.`
    : stopped.length
      ? `Stopped ${andList(stopped)} and sent it to ${name}.`
      : stoppedCheck
        ? `Stopped checking and sent it to ${name}.`
        : `Sent it to ${name} instead.`;
  const line = [
    first,
    done.length ? `${andList(done)} already got it too.` : "",
    carrying.length ? `${andList(carrying)} got it too, and will carry on with it.${off ? ` Stopping sessions by voice is off. ${VOICE_CAN_SAID}` : ""}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (stopped.length || carrying.length) log("redirect_stop", { stopped, carrying, done, voiceCan: config.voiceCan });
  if (already) return speakLine(line);
  // sendTo says nothing for a reply to the session waiting for one: say it here.
  const waiting = floor.waiting;
  const here = waiting && !waiting.isPermission && waiting.sessionId === to.sessionId;
  if (here) void speakLine(line);
  await sendTo(to, text, here ? null : line);
}

/**
 * Whether a session is still on `text`, the last thing the app sent it: busy, nothing sent to it
 * since, and no turn of its finished since. (Something you typed in its terminal yourself isn't seen.)
 */
function stillOn(session: Session, text: string) {
  if (session.status !== "busy") return false;
  const sent = timeline.last("you", idsOf(session));
  if (!sent || sent.text !== text) return false;
  const reply = timeline.last("claude", idsOf(session));
  return !reply || reply.at < sent.at;
}
