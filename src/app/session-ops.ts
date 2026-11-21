// What the app does to a session: stop (interrupt) it, end it, rename it, type into it, and say
// when your words didn't reach it; and whether Voice can allows it (allowed).
import { config } from "../core/config.ts";
import { findSession, idsOf, isStarting, sessionName, spoken, type Session } from "../core/sessions.ts";
import { noteRename } from "../core/renames.ts";
import type { Target } from "../core/decide.ts";
import { voiceAllows } from "../core/routing-rules.ts";
import { cantReach, didntType } from "../core/reach.ts";
import { byAgent } from "../core/can.ts";
import { agentOf } from "../agents/index.ts";
import { terminalOf } from "../terminals/index.ts";
import type { Mapping, Typed } from "../terminals/types.ts";
import type { By } from "../core/starting.ts";
import { closeGracefully, closeSteps, endFromOutside, endSteps, type Closed, type Ended, type Tidied } from "../core/close.ts";
import { flat } from "../core/text.ts";
import type { Short } from "../core/arrived.ts";
import { DICTATED_QUEUED_MS, DICTATED_WITHIN_MS } from "../core/dictated.ts";
import { ui } from "../core/ui-store.ts";
import { VOICE_CAN } from "../core/settings-options.ts";
import { log } from "../core/log.ts";
import { noteTyped } from "./announce.ts";
import { landed, waitFor } from "./deliver.ts";
import { applySetting, labelIn } from "./settings-screen.ts";
import { VOICE_ON, voiceOffLine, voiceOffShown } from "../core/voice-off.ts";
import type { Held } from "../agents/types.ts";
import { cue, speakLine } from "./speech.ts";
import { standsFor } from "./standing.ts";
import { checkStarting, getSessions, holdForStart, starting } from "./starting.ts";
import { KEY_UP_WAIT_MS, dictated, floor, nameOf, pendingRenames, state, talks, timeline } from "./state.ts";

/**
 * Interrupts a session's current turn, like pressing Escape in it. Its background agents carry on.
 * `by` "window": asked for in the Kiko window (its right-click menu): not a voice action, so the
 * Voice can setting doesn't apply, and what happened is shown, not said. "phone": a session screen's
 * Interrupt on the phone, the same, shown there (`told`), the interrupt too.
 */
export async function stopSession(session: Session, by: By = "voice", told?: (line: string) => void) {
  if (by === "voice" && !(await allowed("stop", { to: session, then: () => stopSession(session, by, told) }))) return;
  const tell = (line: string) => (by === "voice" ? speakLine(line) : told ? told(line) : state.windowGlue?.note(line));
  if (isStarting(session)) return tell(`${by === "voice" ? spoken(sessionName(session)) : sessionName(session)} is still starting.`);
  // Its agent interrupts it itself (T3 Code: through its server): no key.
  if (byAgent(session, "interrupt")) return interruptByAgent(session, by, tell);
  if (!session.place?.keys) return tell(cantReach(session, "stop it", false));
  const pressed = await interrupt(session);
  if (!pressed.sent) return tell(didntType(session, "stop it", pressed.why));
  if (by === "voice") await speakLine(`Interrupted ${spoken(sessionName(session))}'s current turn. Anything it started in the background keeps running.`);
  if (by === "phone") void tell(`Interrupted ${sessionName(session)}'s current turn.`);
}

/** Interrupt through the session's agent itself (Agent.interrupt: T3 Code stops its thread's run), said or shown as stopSession does. */
async function interruptByAgent(session: Session, by: By, tell: (line: string) => unknown) {
  const name = sessionName(session);
  const its = agentOf(session);
  const done = await its.interrupt!(session);
  if (!done.done) {
    ui.info(`(not interrupted: ${done.why})`);
    log("interrupt_failed", { sessionId: session.sessionId, name, why: done.why, agent: its.id });
    return tell(`I couldn't stop ${by === "voice" ? spoken(name) : name}: ${done.why}.`);
  }
  log("interrupted", { sessionId: session.sessionId, agent: its.id, by });
  timeline.add({ who: "app", sessionId: session.sessionId, folder: name, text: `interrupted ${name}'s current turn` });
  ui.info(`→ interrupted ${name} (${its.name})`);
  if (by === "voice") await speakLine(`Interrupted ${spoken(name)}'s current turn.`);
  if (by === "phone") tell(`Interrupted ${name}'s current turn.`);
}

/**
 * Escape in a session's terminal, quietly: the caller says what happened. Not pressed (tmux found
 * its pane changed) says why, and nothing's noted.
 */
export async function interrupt(session: Session): Promise<Typed> {
  const name = sessionName(session);
  const place = session.place!;
  const pressed = await terminalOf(place)!.key!(place, agentOf(session).interruptKey);
  if (!pressed.sent) {
    ui.info(`(not interrupted: ${pressed.why})`);
    log("interrupt_failed", { sessionId: session.sessionId, name, why: pressed.why });
    return pressed;
  }
  timeline.add({ who: "app", sessionId: session.sessionId, folder: name, text: `interrupted ${name}'s current turn` });
  ui.info(`→ interrupted ${name} (Escape)`);
  return pressed;
}

/**
 * The Kiko window's Close (either menu), before its tmux session is closed (`tidy`): Claude Code
 * asked to exit, as if you typed /exit, through its terminal's checked typing; Escape first when
 * it's mid-turn; killed only when that doesn't work (core/close.ts). Held by Kiko (a finished turn
 * waiting for your reply): let go first, as renaming does.
 */
export async function endSession(session: Session, tidy: () => Promise<Tidied>): Promise<Closed> {
  const place = session.place!;
  const terminal = terminalOf(place);
  const name = sessionName(session);
  const held = [floor.waiting?.sessionId === session.sessionId && !floor.waiting.isPermission ? floor.waiting : null, floor.heldStop(session.sessionId)];
  let released = false;
  for (const h of new Set(held)) {
    if (!h) continue;
    floor.release(h, `closing ${name}; the waiting session stopped`);
    released = true;
  }
  if (released) await new Promise((r) => setTimeout(r, 500));
  const busy = session.status === "busy" || session.status === "blocked" || floor.holds(session.sessionId) || standsFor(session.sessionId);
  const its = agentOf(session);
  const refuse = isStarting(session) ? "it's still starting" : !terminal ? "nothing reaches its terminal" : !its.exitCommand ? `${its.name} has no command to end it` : null;
  const steps = closeSteps(
    { sessionId: session.sessionId, ids: idsOf(session), place, busy, refuse },
    {
      terminal: terminal ?? { type: async () => ({ sent: false, why: "nothing reaches its terminal" }) },
      interruptKey: its.interruptKey,
      exitCommand: its.exitCommand,
      tidy,
      typing: (text) => noteTyped(session.sessionId, text),
    },
  );
  const closed = await closeGracefully(steps);
  // One still starting, closed here: it ended (its trust card, if up, goes from everywhere now).
  if (isStarting(session)) void checkStarting();
  timeline.add({ who: "app", sessionId: session.sessionId, folder: name, text: closed.how === "exit" ? `closed ${name} (/exit)` : `closed ${name} (ended: ${closed.why})` });
  ui.info(closed.how === "exit" ? `→ closed ${name} (/exit)` : `→ closed ${name} (ended it: ${closed.why})`);
  return closed;
}

/**
 * The Kiko window's Close for a session outside Kiko's tmux (Ghostty, Warp, iTerm, your own
 * tmux, a background job): nothing types /exit into it there, so its agent ends it where it runs
 * (Agent.end: Claude Code's SIGTERM, which it takes as /exit, or `claude stop`), checking first that
 * its process is still that session's; then a wait for it to go (core/close.ts endFromOutside).
 * Never the desktop app's. Held by Kiko: let go first, as endSession does.
 */
export async function endOutside(session: Session): Promise<Ended> {
  const name = sessionName(session);
  const its = agentOf(session);
  const refuse = session.desktop ? "it runs in the Claude desktop app" : !its.end ? `${its.name} can't end it from here` : null;
  if (!refuse) {
    const held = [floor.waiting?.sessionId === session.sessionId && !floor.waiting.isPermission ? floor.waiting : null, floor.heldStop(session.sessionId)];
    for (const h of new Set(held)) if (h) floor.release(h, `closing ${name}; the waiting session stopped`);
  }
  const busy = session.status === "busy" || session.status === "blocked";
  log("close_outside", { sessionId: session.sessionId, kind: session.kind, busy, ...(session.jobId ? { job: session.jobId } : {}), ...(session.place ? { via: session.place.via } : {}) });
  const ended = await endFromOutside(endSteps({ sessionId: session.sessionId, ids: idsOf(session), refuse }, { end: () => its.end!(session) }));
  if (ended.how === "refused") {
    ui.info(`(not closed: ${ended.why})`);
    return ended;
  }
  timeline.add({ who: "app", sessionId: session.sessionId, folder: name, text: ended.how === "ended" ? `closed ${name} (ended where it runs)` : `asked ${name} to end; ${ended.why}` });
  ui.info(ended.how === "ended" ? `→ closed ${name} (ended where it runs)` : `→ asked ${name} to end; ${ended.why}`);
  return ended;
}

/**
 * Renames a session by typing Claude Code's /rename in where a terminal adapter reaches it: its
 * terminal. Mid-turn, a slash command
 * would sit in Claude Code's queue or reach Claude as a message, so a busy session is renamed
 * once it's idle (renameWhenIdle); one waiting for your reply is let go first, like sendTo does.
 * `by` as in stopSession: "phone" shows what came of it on the phone (`told`).
 */
export async function renameSession(session: Session, said: string, by: By = "voice", told?: (line: string) => void) {
  if (by === "voice" && !(await allowed("rename", { to: session, then: () => renameSession(session, said, by, told) }))) return;
  const tell = (line: string) => (by === "voice" ? speakLine(line) : told ? told(line) : state.windowGlue?.note(line));
  const called = sessionName(session);
  if (isStarting(session)) return tell(`${by === "voice" ? spoken(called) : called} is still starting: rename it once it's ready.`);
  // One line, no quotes or end punctuation: a newline would submit early.
  const name = said
    .replace(/\s+/g, " ")
    .replace(/^["'“‘\s]+|["'”’.,!?;:\s]+$/g, "")
    .slice(0, 80);
  if (!name) return tell("What should I call it?");
  // Its agent renames it itself (T3 Code: its thread's title), at any moment: nothing typed, no wait for idle.
  if (byAgent(session, "rename")) return renameByAgent(session, name, by, tell);
  // An agent with no command to type for it, and none of its own: renamed in its own app.
  if (!agentOf(session).renameCommand(name)) return tell(`${by === "voice" ? spoken(called) : called} is in ${agentOf(session).name}: rename it there.`);
  if (!session.place) return tell(cantReach(session, "rename it", false));
  const waiting = floor.waiting;
  if (waiting?.sessionId === session.sessionId && !waiting.isPermission) {
    floor.release(waiting, "renaming it; the waiting session stopped");
    await new Promise((r) => setTimeout(r, 500));
  } else if (!idle(session)) {
    pendingRenames.set(session.sessionId, { name, by });
    log("rename_pending", { sessionId: session.sessionId, name, status: session.status });
    ui.info(`(renaming ${called} to ${name} when it's idle)`);
    return tell(`${by === "voice" ? spoken(called) : called} is busy, so I'll rename it to ${name} when it finishes.`);
  }
  pendingRenames.delete(session.sessionId);
  const renamed = await typeRename(session, name);
  if (renamed && by === "voice") await speakLine(`Renamed ${spoken(called)} to ${name}.`);
  if (renamed && by === "phone") void tell(`Renamed ${called} to ${name}.`);
}

/** Renamed by its agent itself (Agent.rename), said or shown as renameSession does; noted as the app's name, as a typed /rename is. */
async function renameByAgent(session: Session, name: string, by: By, tell: (line: string) => unknown) {
  const called = sessionName(session);
  const its = agentOf(session);
  const done = await its.rename!(session, name);
  if (!done.done) {
    ui.info(`(not renamed: ${done.why})`);
    log("rename_failed", { sessionId: session.sessionId, name, why: done.why, agent: its.id });
    return tell(`I couldn't rename ${by === "voice" ? spoken(called) : called}: ${done.why}.`);
  }
  pendingRenames.delete(session.sessionId);
  noteRename(session.sessionId, name);
  log("renamed", { sessionId: session.sessionId, name, agent: its.id, by });
  timeline.add({ who: "app", sessionId: session.sessionId, folder: called, text: `renamed ${called} to ${name}` });
  ui.info(`→ renamed ${called} to ${name} (${its.name})`);
  // Listed by its new name once its agent says so (T3: the shell's thread.updated, which lists the sessions again).
  setTimeout(() => getSessions(0).then((sessions) => ui.set({ sessions })), 500).unref();
  if (by === "voice") await speakLine(`Renamed ${spoken(called)} to ${name}.`);
  if (by === "phone") tell(`Renamed ${called} to ${name}.`);
}

/** At its prompt: not mid-turn, not on a permission prompt, and not held in a hook by the app. */
function idle(session: Session) {
  if (session.status === "busy" || session.status === "blocked") return false;
  return !floor.holds(session.sessionId) && !standsFor(session.sessionId);
}

/** Types the renames that waited for a busy session; called with each session list refresh. */
export function renameWhenIdle(sessions: Session[]) {
  // Voice can no longer rename sessions (the setting changed since): forget the ones asked by voice.
  // A name given in the window or on the phone isn't voice's to drop.
  const byVoice = [...pendingRenames].filter(([, p]) => p.by === "voice").map(([id]) => id);
  if (byVoice.length && !voiceAllows(config.voiceCan, "manage")) {
    log("renames_dropped", { sessionIds: byVoice, voiceCan: config.voiceCan });
    for (const id of byVoice) pendingRenames.delete(id);
  }
  for (const [sessionId, { name }] of pendingRenames) {
    const session = findSession(sessions, sessionId);
    // An empty list is a failed listing, not every session closing.
    if (!session && sessions.length) pendingRenames.delete(sessionId);
    // Its agent renames it itself now (Codex, once its daemon has it): no keys, no wait for idle.
    if (session && byAgent(session, "rename")) {
      pendingRenames.delete(sessionId);
      void renameByAgent(session, name, "window", (line) => state.windowGlue?.note(line));
      continue;
    }
    // Nothing to type for it (OpenCode, renamed only through its service): kept until its agent can.
    if (!session?.place || !idle(session) || !agentOf(session).renameCommand(name)) continue;
    pendingRenames.delete(sessionId);
    typeRename(session, name).catch((err) => log("error", { where: "rename", message: err instanceof Error ? err.message : String(err) }));
  }
}

/** True once it's typed; a send that fails says why. */
async function typeRename(session: Session, name: string) {
  const called = sessionName(session);
  const place = session.place!;
  const command = agentOf(session).renameCommand(name);
  noteTyped(session.sessionId, command);
  const typed = await terminalOf(place)!.type(place, command);
  if (!typed.sent) {
    ui.info(`(not renamed: ${typed.why})`);
    await speakLine(`I couldn't rename ${spoken(called)}: ${typed.why}.`);
    return false;
  }
  // Claude Code records it like a rename you typed: noted, so the new name counts as the app's.
  noteRename(session.sessionId, name);
  timeline.add({ who: "app", sessionId: session.sessionId, folder: called, text: `renamed ${called} to ${name}` });
  ui.info(`→ renamed ${called} to ${name}`);
  // Claude Code writes the new name to the transcript, where the session list reads titles.
  setTimeout(() => getSessions(0).then((sessions) => ui.set({ sessions })), 1500).unref();
  return true;
}

/**
 * For a session that isn't waiting for a reply: typed in where a terminal adapter reaches it (its
 * pane in Kiko's tmux, its Ghostty terminal, its T3 Code thread). One none reaches (a terminal
 * none finds, the Claude desktop app, the background) isn't typed into: what wasn't sent is said,
 * and your entry in the timeline marked so (Entry.notSent). `beep`: the "sent" beep once it's in,
 * for a send nothing was said about (sendTo). True when they went in (or wait for it to start).
 */
export async function typeInto(to: Target, text: string, beep = true, later = false, at = state.pressAt): Promise<boolean> {
  if (!(await allowed("message", { to, then: () => typeInto(to, text, beep, later, at) }))) {
    timeline.markNotSent(to.sessionId, text);
    return false;
  }
  // Still starting (its trust prompt, say): held, typed in once it has started. Never typed into now.
  const waitingToStart = starting.get(to.sessionId);
  if (waitingToStart) {
    await holdForStart(waitingToStart, text);
    return true;
  }
  let session = findSession(await getSessions(1000), to.sessionId);
  if (!session) {
    state.target = null;
    log("send_failed", { sessionId: to.sessionId, name: nameOf(to), text, why: "session closed" });
    timeline.markNotSent(to.sessionId, text);
    talks.failed(`The ${nameOf(to)} session has closed`);
    await speakLine(`The ${spoken(nameOf(to))} session has closed.`);
    return false;
  }
  // Its window there but not told apart, or on Claude Code's agents list: listed once more, fresh
  // (a second old at most before), since a terminal's title changes as Claude Code goes.
  if (!session.place && RELIST.has(session.mapping)) {
    const fresh = findSession(await getSessions(0), to.sessionId);
    log("type_relisted", { sessionId: session.sessionId, mapping: session.mapping, now: fresh?.mapping ?? null, found: Boolean(fresh?.place) });
    if (fresh) session = fresh;
  }
  const name = sessionName(session);
  const place = session.place;
  const terminal = place && terminalOf(place);
  if (!place || !terminal) {
    // TODO queued instructions: an interactive session no adapter can type into, while
    // it's idle, could keep these words until its agent next holds a finished turn of it
    // (agent.onHeld), and give them as that turn's reply (answer), the way replyLater does for one
    // not read out yet, instead of refusing them.
    // Kept for "try again" when it's something you can put right (open the session there).
    const retry = RELIST.has(session.mapping);
    const line = `${cantReach(session, null, Boolean(timeline.last("claude", idsOf(session))))}${retry ? TRY_AGAIN_LINE : ""}`;
    log("type_failed", { sessionId: session.sessionId, kind: session.kind, mapping: session.mapping, desktop: session.desktop, text, said: line });
    ui.info(`(not sent to ${name}: nothing can type into it now)`);
    talks.failed(`Can't reach ${name} to type into it`);
    await notReached(session, text, line, retry, to.sessionId);
    return false;
  }
  noteTyped(session.sessionId, text);
  // Said, not typed on a phone's keyboard: its agent is told so as it takes them in (core/dictated.ts).
  // Noted before the typing: a session can take them in before `type` comes back. One busy (or held
  // by the app) queues them, and takes them in once its turn is over: waited for that long.
  const said = !talks.current().some((t) => t.typed);
  if (said) dictated.note(session.sessionId, text, idle(session) ? DICTATED_WITHIN_MS : DICTATED_QUEUED_MS);
  const typed = await terminal.type(place, text);
  if (said && !typed.sent) dictated.drop(session.sessionId, text);
  if (typed.sent) {
    if (beep) cue("sent", at);
    // Mid-turn, it takes them once it's done (or as it goes): queued.
    talks.delivered({ sessionId: session.sessionId, name }, text, { queued: !idle(session) });
    ui.info(terminal.label ? `→ ${name} (${terminal.label})` : `→ typed into ${name}`);
    landed(session, later);
    return true;
  }
  ui.info(`(not sent: ${typed.why}${typed.error ? ` (${flat(typed.error, 120)})` : ""})`);
  talks.failed(`Not sent: ${typed.why}`);
  const line = didntType(session, null, typed.why);
  log("send_failed", { sessionId: session.sessionId, name, text, via: place.via, why: typed.why, ...(typed.error ? { error: flat(typed.error, 300) } : {}), said: line });
  // Said as it is: tmux found its pane changed, T3 Code didn't take it.
  await notReached(session, text, line, false, to.sessionId);
  return false;
}

// Found, but not reachable this moment: worth listing again before giving up, and saying "try again" after.
const RELIST = new Set<Mapping>(["ambiguous", "agents"]);
const TRY_AGAIN_LINE = " Say try again to send it.";

/**
 * Your words didn't reach `session`: said out loud every time (after a press that's down, never
 * over it; a press while it's said cuts it, as any line), and with `retry`, kept for "try again"
 * (decide.ts `retry`), which sends them there as they were. Their timeline entry (under any of its
 * IDs, or `asId`, the one they were sent to) is marked not sent: the router, summaries and notes
 * never take them as delivered.
 */
export async function notReached(session: Session, text: string, line: string, retry: boolean, asId?: string) {
  timeline.markNotSent(asId ? [asId, ...idsOf(session)] : idsOf(session), text);
  if (retry) state.unsent = { to: { sessionId: session.sessionId, cwd: session.cwd }, text, at: Date.now() };
  if (floor.pressed) await waitFor(() => !floor.pressed, KEY_UP_WAIT_MS);
  await speakLine(line);
}

/**
 * Words the app typed into a session came in cut short (core/arrived.ts: the prompt it took in was
 * only their start or their end): logged loudly, shown, and said, never let pass as sent; kept for
 * "try again", which types them whole again (long words go in as one paste: src/terminals/paste.ts).
 */
export async function cutShort(sessionId: string, short: Short) {
  const session = findSession(ui.state.sessions, sessionId);
  const name = session ? sessionName(session) : "the session";
  const part = short.at === "end" ? "the end" : "the start";
  log("typed_short", { sessionId, typed: short.typed, got: short.got, at: short.at, text: short.text });
  ui.info(`(only ${part} of your words reached ${name}: ${short.got} of ${short.typed} characters)`);
  if (session) state.unsent = { to: { sessionId: session.sessionId, cwd: session.cwd }, text: short.text, at: Date.now() };
  if (floor.pressed) await waitFor(() => !floor.pressed, KEY_UP_WAIT_MS);
  await speakLine(`Only ${part} of your message reached ${session ? spoken(name) : name}.${session ? TRY_AGAIN_LINE.replace("send it", "send it whole") : ""}`);
}

/** What Voice can may stop: a message to a session that isn't waiting, a quick check, the dictionary, starting, stopping or renaming a session, a folder's trust. */
type Gated = "message" | "check" | "dictionary" | "start" | "stop" | "rename" | "trust";

/**
 * Whether the "Voice can" setting allows this. When it doesn't, it's logged and said: what's off,
 * where it's turned on (Settings → Control → Voice can → Everything, shown with the arrows), and
 * "Say turn it on, and I'll do it now.". Taking that (decide.ts voice_on: turnOnVoice) sets it to
 * Everything and carries out `then`, what was asked. `off`: the first sentence instead of the usual
 * one. "message" is sending to a session that isn't waiting for a reply; replies to one that is, and
 * permission answers, are always allowed and never come here.
 */
export async function allowed(action: Gated, { to, off, then, request }: { to?: Target; off?: string; then?: () => Promise<unknown>; request?: Held } = {}) {
  if (voiceAllows(config.voiceCan, action === "message" || action === "check" || action === "dictionary" ? action : "manage")) return true;
  log("not_allowed", { action, sessionId: to?.sessionId ?? null, voiceCan: config.voiceCan, offered: true, carriesOut: Boolean(then) });
  ui.info(`(voice can: ${labelIn(VOICE_CAN, config.voiceCan).toLowerCase()})`);
  ui.info(voiceOffShown(action));
  // "Atlas agents isn't waiting for a reply…" only while another one is; else nothing is.
  const name = action === "message" && to && floor.waiting && !floor.waiting.isPermission ? spoken(nameOf(to)) : undefined;
  const line = voiceOffLine(action, { name, off, carries: Boolean(then) });
  state.voiceOffer = { line, at: Date.now(), then: then ?? null, ...(request ? { request } : {}) };
  await speakLine(line);
  return false;
}

/**
 * "Turn it on" (or yes) after that offer: Voice can set to Everything (saved, as the settings screen
 * saves it, and logged), then what it stopped carried out; with nothing kept, you're asked to say it again.
 */
export async function turnOnVoice() {
  const offer = state.voiceOffer;
  state.voiceOffer = null;
  const from = config.voiceCan;
  applySetting("voiceCan", VOICE_ON);
  log("voice_can_raised", { from, to: VOICE_ON, by: "voice", carriesOut: Boolean(offer?.then) });
  if (!offer?.then) return speakLine("Done: your voice can do everything now. Say it again.");
  await speakLine("Done: your voice can do everything now.");
  await offer.then();
}
