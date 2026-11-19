// What the app is doing, told to the UI (ui-store.ts) and written for the status line add-on
// (statusline/kiko-status.mjs, STATE_FILE): listening, speaking, the session waiting and its
// window, the permission card shown, your words being dealt with.
import { guardOf } from "../core/guard.ts";
import { randomBytes } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { config } from "../core/config.ts";
import { shortPath } from "../core/text.ts";
import { listedId } from "../core/sessions.ts";
import { spokenName } from "../core/name.ts";
import { isTrust, trustMeans } from "../core/trust-prompt.ts";
import { isQuickCheck, quickCardName } from "../core/quick-ask.ts";
import { ui, type WindowPhase } from "../core/ui-store.ts";
import { isOverride } from "../core/block-override.ts";
import { toolDetail } from "../core/decisions.ts";
import type { Permission } from "../core/ui-store.ts";
import type { Held } from "../agents/types.ts";
import { sessionCost } from "./announce.ts";
import { costShown } from "../core/dollars.ts";
import { promptId } from "./phone.ts";
import { cardShown, trustCards } from "./starting.ts";
import { standing } from "./standing.ts";
import { STATE_FILE, asking, duck, floor, nameOf, refOf, state, whatOf } from "./state.ts";

/**
 * Where the waiting session's window is: counting down (`until`, its end), or not started or held
 * while you talk, your words are dealt with, or the app speaks (`until` null: no seconds shown).
 */
function windowPhase(): WindowPhase {
  return floor.pressed ? "listening" : floor.replying || state.deciding ? "deciding" : floor.speaking ? "speaking" : "waiting";
}

/**
 * A prompt as the card and the phone show it. `classified`: the risk classifier read it as risky
 * (known only for the one being asked: it's read as it's asked). One the safety gate asked
 * (core/guard.ts) is risky from the start (its "allow it"), and allowed once.
 */
function permissionOf(held: Held, classified: boolean): Permission {
  // A trust question's: what trusting means (Codex's hooks: the phone shows it under the question; a folder's is the phone's own).
  const detail = isTrust(held) ? (held.kind === "hooks" ? trustMeans(held) : null) : held.questions ? null : toolDetail(held.tool?.name, held.tool?.input);
  // Kiko's quick check: what it's for, not only the command ("Kiko's quick check, for: disk space").
  const checkFor = isQuickCheck(held.sessionId) ? state.quick?.task : undefined;
  return {
    id: promptId(held),
    sessionId: listedId(ui.state.sessions, held.sessionId),
    name: checkFor ? quickCardName(checkFor) : nameOf(refOf(held)),
    ...(checkFor ? { checkFor } : {}),
    what: whatOf(held),
    risky: isTrust(held) ? false : classified || Boolean(guardOf(held)),
    ...(held.questions ? { questions: held.questions, asking: asking.get(held)?.at ?? 0 } : {}),
    // A folder's trust (the phone's trust card: deny ends the session); a hooks question is a plain permission there.
    ...(isTrust(held) && held.kind === "folder" ? { folder: shortPath(held.folder, homedir()) } : {}),
    ...(isTrust(held) ? { means: trustMeans(held) } : {}),
    // A block allowed anyway is allowed once: no "always" on its card.
    ...(isOverride(held) || guardOf(held) ? { once: true } : {}),
    // For good, where its agent offers it: the phone's Always (a trust card, questions and a block allowed once never).
    ...(held.canAllowAlways && !isTrust(held) && !isOverride(held) && !guardOf(held) && !held.questions ? { canAlways: true } : {}),
    ...(detail ? { detail } : {}),
  };
}

/**
 * Every other prompt Kiko holds open, in the order they'd be asked: in line behind the one asked (or
 * behind a reply being read out), prompts standing after their window, and trust cards up that aren't
 * the one shown. The phone shows each
 * as a card it can answer (2026-11-04: kiko-dev's prompt waited two minutes behind a reply whose
 * speech kept stalling, never asked, so the phone had "kiko-dev needs you" and nothing to answer).
 */
function queuedPermissions(shown: Held | null): Permission[] {
  // Standing ones (asked already, held past their window: app/standing.ts) oldest first, ahead of those not asked yet.
  const held = [floor.current, ...standing.list(), ...floor.queue, ...trustCards.up()];
  const seen = new Set<Held>();
  const out: Permission[] = [];
  for (const h of held) {
    if (!h || !h.open || !h.isPermission || h === shown || seen.has(h)) continue;
    seen.add(h);
    out.push(permissionOf(h, false));
  }
  return out;
}

/** Tells the status line and the UI what the voice app is doing. */
export function writeState() {
  const phase = windowPhase();
  // The card shown: the prompt the floor is asking, else a trust card that stays up (no floor, no window).
  const current = cardShown();
  // Not one being read out with your words already waiting for it: no window, they're its reply.
  const held = floor.waiting;
  // A trust card has no window to show: it stays up until it's settled (its voice window isn't one).
  const until = held && isTrust(held) ? null : floor.until;
  // Hands-free: someone else was talking around the app's words, so a reply needs the name this time.
  const needsName = Boolean(state.handsFree?.replyNeedsName);
  const waiting = held
    ? {
        sessionId: listedId(ui.state.sessions, held.sessionId),
        name: nameOf(refOf(held)),
        kind: held.isPermission ? ("permission" as const) : ("reply" as const),
        phase,
        until,
        ...(needsName ? { needsName } : {}),
      }
    : null;
  ui.set({
    listening: floor.pressed,
    speaking: floor.speaking,
    targetId: state.target?.sessionId ?? null,
    waiting,
    permission: current?.open && current.isPermission ? permissionOf(current, state.currentRisky) : null,
    queuedPermissions: queuedPermissions(current),
    deciding: state.deciding,
    holding: state.holding && { text: state.holding.text, to: state.holding.name, sessionId: state.holding.to.sessionId, startedAt: state.holding.startedAt },
    checking: state.quick && { what: state.quick.task, startedAt: state.quick.startedAt },
    cost: costShown(sessionCost()),
  });
  const shared = {
    pid: process.pid,
    updatedAt: Date.now(),
    listening: floor.pressed,
    // Hands-free: on, and taking your words after the name (`by`), or a reply without it.
    // `replyWindow`: a session's reply window is counting down, and words without the name answer it.
    // `needsName`: it's counting down, but someone else was talking: a reply needs the name this time.
    handsFree: ui.state.handsFree.on
      ? {
          by: ui.state.handsFree.by,
          name: spokenName(),
          replyWindow: !needsName && config.replyWithoutName && Boolean(floor.waiting) && floor.until !== null,
          ...(needsName ? { needsName } : {}),
        }
      : null,
    speaking: floor.speaking,
    waiting: held
      ? {
          sessionId: held.sessionId,
          name: nameOf(refOf(held)),
          kind: held.isPermission ? "permission" : "reply",
          phase,
          until,
        }
      : null,
    target: state.target?.sessionId ?? null,
    // The status line shows "deciding…" and "checking…" once they've taken a moment, and
    // "sent to <name>" for a moment after `at`.
    deciding: state.deciding && { startedAt: state.deciding.startedAt },
    // "to <name>…" while a send the app wasn't sure of waits a moment before it goes.
    holding: state.holding && { name: state.holding.name, startedAt: state.holding.startedAt },
    checking: state.quick && { startedAt: state.quick.startedAt },
    sent: state.sent,
    // The volume while you talk, and what it goes back to: a run that crashed leaves this for the
    // next one to put back (leftoverDuck).
    ducked: duck.ducked(),
  };
  // A temp name of its own, made new ("wx"): /tmp is anyone's, and a fixed one could be a link
  // another user left there to a file of yours, written through.
  const temp = `${STATE_FILE}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(shared), { flag: "wx", mode: 0o600 });
    renameSync(temp, STATE_FILE);
  } catch {
    // the status line just won't show voice state
    rmSync(temp, { force: true });
  }
}
