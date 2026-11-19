// Permission prompts that stand after their voice window (core/standing.ts), in the app: which ones
// may (stands), what's shown as one stands, comes down or is let go at its hold limit, and the card
// they make on the Mac and every phone (standingCard, status.ts queuedPermissions). Nothing here
// depends on a terminal adapter: a standing prompt is only its hook held open, and letting it go is
// its own release() (its agent then asks wherever it runs: tmux, Ghostty, Rex, iTerm, Terminal, any
// other terminal, the desktop app, Codex's TUI, OpenCode's, T3 Code's window).
import { HOOK_TIMEOUTS } from "../agents/claude-code/settings.ts";
import { agentOf } from "../agents/index.ts";
import type { Held } from "../agents/types.ts";
import { isOverride } from "../core/block-override.ts";
import { appEnv } from "../core/env.ts";
import { log } from "../core/log.ts";
import { isQuickCheck } from "../core/quick-ask.ts";
import { findSession, LeftTheList, type Session } from "../core/sessions.ts";
import { type AnsweredHow, StandingPrompts } from "../core/standing.ts";
import { isTrust } from "../core/trust-prompt.ts";
import { ui } from "../core/ui-store.ts";
import { promptId } from "./phone.ts";
import { standingTrust } from "./starting.ts";
import { floor, nameOf, refOf, state, whatOf } from "./state.ts";
import { writeState } from "./status.ts";

/**
 * How long a standing prompt is held, from when its hook came in: 30 s under the installed hook's
 * own timeout (Claude Code's and Codex's PermissionRequest, 3600 s), so it's let go here, with its
 * card taken down, before the agent gives up on the hook. An install whose hooks still have an older
 * Kiko's shorter timeout (the start's upgrade raises it) has its hook go first: settled as gone.
 */
export const STAND_LIMIT_MS = Number(appEnv("TEST_STAND_LIMIT_MS") ?? (HOOK_TIMEOUTS.PermissionRequest - 30) * 1000);

/**
 * Off only in the faked-app harness (tests/harness/run.sh, KIKO_TEST_STAND=off): its cases were
 * written for a prompt let go at its window's end, with that line. Standing ones are tested in
 * tests/unit (core/standing.test.ts, app/standing-phone.test.ts).
 */
const STANDS = appEnv("TEST_STAND") !== "off";

// When each prompt's hook came in, and when it was first asked out loud.
const heldAt = new WeakMap<Held, number>();
const askedAt = new WeakMap<Held, number>();

/** Its hook came in (announce.ts onRequest). */
export const noteHeld = (request: Held) => void (heldAt.has(request) || heldAt.set(request, Date.now()));

/** It's asked out loud (askPermission, askQuestions): the first time counts, not one after a press put it back. */
export const noteAsked = (request: Held) => void (askedAt.has(request) || askedAt.set(request, Date.now()));

/** A Codex call the safety gate holds (its PreToolUse): let go, its hook denies it. */
const codexGate = (request: Held) => Boolean((request as { guarded?: unknown }).guarded);

/** Its agent's own place for it: its terminal, the desktop app, or its agent's own app. */
function ownWindow(request: Held) {
  if (request.desktop) return "the Claude app";
  const a = agentOf(request);
  return a.ownApp ? a.name : "its terminal";
}

/** "its card, your phone and its terminal": everywhere a standing prompt can be answered. */
function answerableOn(request: Held) {
  // A Codex permission prompt (its own, or a safety-gate ask) has no dialog of Codex's beside it
  // while its hook is held (`onlyHere`: Codex asks only once the hook gives no decision): only Kiko's cards.
  const places = ["its card", ...(state.phone ? ["your phone"] : []), ...(codexGate(request) || request.onlyHere ? [] : [ownWindow(request)])];
  return places.length > 1 ? `${places.slice(0, -1).join(", ")} and ${places.at(-1)}` : places[0];
}

export const standing = new StandingPrompts<Held>({
  holdLimitMs: STAND_LIMIT_MS,
  stood(request) {
    ui.info(`(no answer yet; still on ${answerableOn(request)})`);
    writeState();
  },
  settled(request, how) {
    const name = nameOf(refOf(request));
    if (how.kind === "released" && how.how !== "shutdown") {
      // Not gone silently from a phone: what it missed of it becomes a note with nothing to press,
      // until the session moves on. Not a Codex safety-gate ask: let go, it's denied.
      const where = `in ${ownWindow(request)}`;
      if (!codexGate(request)) state.phone?.promptLetGo(promptId(request), request.sessionId, name, `${name} asked to ${whatOf(request)} — waiting ${where}`);
      const held = how.how === "hold_limit" ? "held as long as it can be, so " : "";
      ui.info(codexGate(request) ? `(${held}${name}'s call wasn't run)` : `(${held}${name}'s prompt is waiting ${where})`);
    } else if (how.kind === "gone") ui.info(`(${name} stopped waiting)`);
    writeState();
  },
  log,
});

/**
 * Its voice window ran out (the floor's `stand`): true when it's taken off the floor without being
 * let go there. A permission prompt of an agent's, held in its hook (or by its agent's own server:
 * OpenCode, T3 Code), stands, whether or not you're at the Mac (core/standing.ts stand); never a
 * trust card (those stay up anyway), a block allowed anyway (Kiko's own card), or the quick check's
 * (it goes on without it). One answered in its own window during its voice window (its session
 * listed blocked since its hook came in, and not now) is over already: its hook let go, nothing
 * said, nothing stands.
 */
export function stands(request: Held): boolean {
  if (!STANDS || !request.isPermission || !request.open || isTrust(request) || isOverride(request) || isQuickCheck(request.sessionId)) return false;
  if (answeredThere(request, listedLast)) {
    request.release();
    log("permission_answered_there", { sessionId: request.sessionId });
    return true;
  }
  const now = Date.now();
  standing.stand(request, { askedAt: askedAt.get(request) ?? now, heldSince: heldAt.get(request) ?? now });
  return true;
}

// Held permission prompts whose session has been listed blocked (its own dialog up) while their hook was held.
const seenBlocked = new WeakSet<Held>();
let listedLast: readonly Session[] | null = null;
// The sessions of standing prompts that have left the list (their process ended).
const leftList = new LeftTheList();

/** Its session was listed blocked while its hook was held, and is listed, not blocked, now: its dialog was answered (or cancelled) there. */
function answeredThere(request: Held, sessions: readonly Session[] | null) {
  if (!sessions || !seenBlocked.has(request)) return false;
  const session = findSession(sessions, request.sessionId);
  return session !== undefined && session.status !== "blocked";
}

/**
 * The sessions as listed now (the store's `sessions`, on each change). Claude Code shows its own
 * dialog beside a held PermissionRequest hook, and answered there it leaves the hook running
 * (2.1.318, checked live 2026-11-05): so a standing prompt whose session was listed blocked while
 * its hook was held (in its voice window, or since it stood) and isn't any more was answered (or
 * cancelled) in its own window. Taken down, its hook let go. And one whose session has left the list
 * (core/sessions.ts LeftTheList: its process ended, with its hook left running, an orphan, as after a
 * kill -9) has nothing left to answer it: taken down as ended, so its card, the phone's and "needs
 * you" don't stay up until the hold limit.
 */
export function sessionsListed(sessions: readonly Session[]) {
  if (sessions === listedLast) return;
  listedLast = sessions;
  const up = standing.list();
  // Watched from when their hook comes in: one whose session ended in its voice window stands with it gone already.
  const held = [floor.current, ...floor.queue, ...up].filter((r): r is Held => Boolean(r?.isPermission && r.open));
  for (const request of held) if (findSession(sessions, request.sessionId)?.status === "blocked") seenBlocked.add(request);
  const ended = new Set(
    leftList.look(
      sessions,
      held.map((r) => r.sessionId),
    ),
  );
  for (const request of up) {
    if (ended.has(request.sessionId)) standing.gone(request, "session_ended");
    else if (answeredThere(request, sessions)) standing.gone(request, "terminal");
  }
}

/**
 * Its agent saw it answered (or cancelled) in its own window while its hook is held (Held
 * watchAnswered: Claude Code's transcript moved past its call, or its dialog came and went; `sign`
 * says which). Taken down as one the list finds answered there: its hook let go, the
 * `permission_answered_there` log, nothing said. Standing, it's gone (`terminal`). On the floor
 * (being asked out loud in its voice window, or still in line), it's dropped as one whose hook
 * closed: nothing more is asked aloud, and the next one in line goes on.
 */
export function answeredThereNow(request: Held, sign: string) {
  // Settled already (answered here, or its hook closed: whoever settled it takes it down).
  if (!request.open) return;
  if (standing.has(request)) {
    log("permission_answered_there", { sessionId: request.sessionId, sign, stood: true });
    standing.gone(request, "terminal");
    return;
  }
  if (!request.release()) return;
  log("permission_answered_there", { sessionId: request.sessionId, sign });
  floor.closed(request, `(${nameOf(refOf(request))} stopped waiting)`);
  writeState();
}

/** A permission prompt, watched from when its hook comes in for an answer given in its own window (announce.ts onRequest). */
export function watchHeld(request: Held) {
  if (request.isPermission && !isTrust(request) && !isOverride(request) && !isQuickCheck(request.sessionId)) request.watchAnswered?.((sign) => answeredThereNow(request, sign));
}

/**
 * Its hook went away by itself (Held.onClosed), or its agent said it was answered in its own window
 * (`closedHow`: OpenCode's permission.replied): taken down if it was standing. False when it wasn't.
 */
export const closedStanding = (request: Held) => standing.gone(request, request.closedHow ?? "hook_closed");

/** Its session finished a turn (a Stop came): any of its prompts still standing are over. */
export function turnEnded(sessionId: string) {
  for (const request of standing.list()) if (request.sessionId === sessionId) standing.gone(request, "turn_ended");
}

/** Whether a prompt of this session stands now: its hook held, so it's mid-turn, asking you. */
export const standsFor = (sessionId: string) => standing.list().some((r) => r.sessionId === sessionId);

/** Answered (the Mac's card, voice, a phone): taken down if it was standing. */
export const answeredLate = (request: Held, how: AnsweredHow) => standing.answered(request, how);

/** The card the Mac shows when the floor asks nothing: a trust card that stays up, else the oldest standing prompt. */
export function standingCard(): Held | null {
  return standingTrust() ?? standing.list()[0] ?? null;
}
