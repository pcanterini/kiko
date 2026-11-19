// Whether each Claude Code session is in a turn: what "working" means in the list, the bottom line,
// the voice side and the phone. `claude agents --json` says "busy" for as long as anything of the
// session's runs, a background shell or subagent too: one left over (a `until ! pgrep -f …` loop
// that matched itself) kept "Kiko project" busy for hours while it sat at its prompt. So its
// hooks come first: UserPromptSubmit opens a turn, Stop ends it (whatever still runs in the
// background), a permission prompt or a blocked tool call means it's in one. `claude agents` only
// fills the gaps: a session no hook has spoken for since Kiko started (it restarted mid-turn,
// the session started before its hooks were in). And the transcript catches what the hooks don't
// say: a turn a background task's notification starts (no UserPromptSubmit), one interrupted with
// Esc (no Stop), and, with no hook at all, a busy session whose last turn ended. What still runs
// in the background is shown apart, quietly (./background.ts). Kept for this run only.

/** A session's turn as its hooks last said it: open or not, and when (ms epoch). */
export type Turn = { open: boolean; at: number };

/** A transcript as `transcriptTurn` reads it (./transcripts.ts): when it was last written, whether its last turn ended. */
type TranscriptTurn = { at: number; ended: boolean | null };

const turns = new Map<string, Turn>();
/** The most kept: the oldest go first (a session that ended without its SessionEnd). */
const MAX = 200;

/**
 * How long a turn the hooks opened outlasts `claude agents` saying "idle": a listing made just as it
 * opened may not show it yet. Past that, an idle process has no turn (its Stop was missed).
 */
export const OPEN_GRACE_MS = 15_000;

function set(sessionId: unknown, open: boolean, at: number) {
  if (typeof sessionId !== "string" || !sessionId) return false;
  const was = turns.get(sessionId);
  turns.delete(sessionId);
  turns.set(sessionId, { open, at });
  if (turns.size > MAX) turns.delete(turns.keys().next().value!);
  return was?.open !== open;
}

/**
 * A Claude Code hook, as it bears on the session's turn: UserPromptSubmit opens one; a permission
 * prompt (PermissionRequest) or a tool call auto mode blocked (PermissionDenied) happens in one;
 * Stop ends it; a session starting (SessionStart, but not "compact": that comes mid-turn too) has
 * none yet; SessionEnd forgets it. Whether that changed it (open or not), for the list to be drawn again.
 */
export function noteHook(kind: unknown, sessionId: unknown, source?: unknown, at = Date.now()): boolean {
  switch (kind) {
    case "UserPromptSubmit":
    case "PermissionRequest":
    case "PermissionDenied":
      return set(sessionId, true, at);
    case "Stop":
      return set(sessionId, false, at);
    case "SessionStart":
      return source === "compact" ? false : set(sessionId, false, at);
    case "SessionEnd":
      return typeof sessionId === "string" && turns.delete(sessionId);
    default:
      return false;
  }
}

/** A held Stop answered with your reply: the turn goes on with it (no UserPromptSubmit says so). */
export const turnResumed = (sessionId: string, at = Date.now()) => set(sessionId, true, at);

/** A session's turn as its hooks last said it; undefined while none has, this run. */
export const turnOf = (sessionId: string): Turn | undefined => turns.get(sessionId);

/** Forgets every session's turn (for the tests). */
export const forgetTurns = () => turns.clear();

/**
 * Whether a session is in a turn: true or false, or null to go by `claude agents` (`listedBusy`: it
 * says "busy"; false: "idle"; null: something else, a dialog waiting).
 * - Its hooks said a turn opened: in it, unless its transcript, written since, says it ended
 *   (interrupted with Esc: no Stop comes), or `claude agents` says idle well after it opened.
 * - Its hooks said it ended: not in one, unless its transcript, written since, is in one again: a
 *   background task's notification starts a turn with no UserPromptSubmit (its Stop ends it).
 * - No hook this run: `claude agents`' word, except that a busy one whose transcript ended its last
 *   turn isn't in one: it's busy with background work. (A transcript still being written adds
 *   nothing: `claude agents` says busy then already. And one it says is idle is idle.)
 */
export function inTurn(turn: Turn | undefined, transcript: TranscriptTurn | null, listedBusy: boolean | null, now = Date.now()): boolean | null {
  const since = (t: Turn) => transcript !== null && transcript.at > t.at;
  if (turn?.open) {
    if (since(turn) && transcript!.ended === true) return false;
    if (listedBusy === false && now - turn.at > OPEN_GRACE_MS) return false;
    return true;
  }
  if (turn) return since(turn) && transcript!.ended === false;
  return listedBusy === true && transcript?.ended === true ? false : null;
}
