// Seen on the Mac: a line kept for a phone that wasn't there, but that you took in at the Mac, isn't
// left unread on the phone (away from the phone but at the computer, you've already seen them).
// It's settled `seen_on_mac`: dimmed in the phone's list, not in its badge, and left out of catch-ups, like any settled line.
//   - Said out loud on the Mac (Play on this Mac, or the Mac standing in, and not muted) while you
//     were at it: input in the last SEEN_IDLE_MS (90 s), the screen unlocked and awake, read as the
//     line is kept (it's shown as it's said). Seen at once.
//   - Only shown there (not said out loud: Play on this Mac off and a phone playing it, or muted;
//     or said while you'd been idle longer), with the screen unlocked and awake: seen once you use
//     Kiko on the Mac within SEEN_AFTER_MS (2 minutes) after it (MacUse below).
//   - Said while the screen was locked or asleep, or when the Mac can't tell: never by this. It stays
//     unread until it's settled as before (replied to, answered, superseded).
// Only a record, like missed.ts: nothing here changes what's said or where.
import type { AtComputer } from "../platform/types.ts";

/** Input this recent, as a line is said out loud, means you heard it at the Mac. */
export const SEEN_IDLE_MS = 90_000;
/** Using Kiko on the Mac this soon after a line it showed means you saw it there. */
export const SEEN_AFTER_MS = 2 * 60_000;
/**
 * A sign of use that might have come from elsewhere (a prompt a session took in: typed at the Mac,
 * or sent from another device) counts only with input at the Mac this recent.
 */
export const USED_INPUT_MS = 15_000;

/**
 * What counts as using Kiko on the Mac: its talk key (`key`), its window (`window`: an answer, a
 * click or key in its list, its menu, its settings), words typed into a session it holds
 * (`typed`), and, with input at the Mac just then (USED_INPUT_MS), a prompt a session took in
 * (`prompt`: typed into its terminal) or a question answered in a session's terminal (`terminal`).
 * Hands-free isn't: the name can be said, or misheard, from across the room.
 */
export type MacUse = "key" | "window" | "typed" | "prompt" | "terminal";
/** The uses that might not be the Mac's own, so they need input at the Mac to count. */
export const NEEDS_INPUT: readonly MacUse[] = ["prompt", "terminal"];

/** The screen could show it: unlocked and awake. Not when the Mac can't tell. */
export const shownOnMac = (r: AtComputer | null) => r !== null && !r.locked && !r.asleep;
/** Said out loud while you were at the Mac: shown, and input in the last SEEN_IDLE_MS. */
export const heardAtMac = (r: AtComputer | null) => shownOnMac(r) && r!.idleMs <= SEEN_IDLE_MS;
/** A use that needs input at the Mac (NEEDS_INPUT) has it: shown, and input in the last USED_INPUT_MS. */
export const usedAtMac = (r: AtComputer | null) => shownOnMac(r) && r!.idleMs <= USED_INPUT_MS;

type SeenOnMacOptions = {
  /**
   * These lines were seen on the Mac: settle them (`seen_on_mac`). `why`: `heard` (said out loud
   * while you were there), or the use that showed you'd seen them.
   */
  seen: (ids: number[], why: "heard" | MacUse) => void;
  now?: () => number;
};

/**
 * Decides which kept lines were seen on the Mac. `said` for each line as it's kept, with whether the
 * Mac said it out loud and the Mac's reading then; `used` as you use Kiko on the Mac.
 */
export class SeenOnMac {
  private o: SeenOnMacOptions;
  private now: () => number;
  // Lines shown on the Mac and not yet seen there (id → when said): seen on a use within SEEN_AFTER_MS.
  private shown = new Map<number, number>();
  private last: { at: number; by: MacUse } | null = null;

  constructor(options: SeenOnMacOptions) {
    this.o = options;
    this.now = options.now ?? Date.now;
  }

  /**
   * A line kept for a phone (`id`, said `at`): `aloud`, the Mac said it out loud; `reading`, whether
   * you were at the Mac then. True when it was seen there now.
   */
  said(id: number, at: number, aloud: boolean, reading: AtComputer | null): boolean {
    this.expire();
    if (aloud && heardAtMac(reading)) return this.mark([id], "heard");
    if (!shownOnMac(reading)) return false;
    // A use since it was said, while the reading was on its way, counts.
    if (this.last && this.last.at >= at && this.last.at - at <= SEEN_AFTER_MS) return this.mark([id], this.last.by);
    this.shown.set(id, at);
    return false;
  }

  /** You used Kiko on the Mac: the lines it showed in the last SEEN_AFTER_MS were seen. */
  used(by: MacUse) {
    const now = this.now();
    this.last = { at: now, by };
    const ids = [...this.shown].filter(([, at]) => at <= now && now - at <= SEEN_AFTER_MS).map(([id]) => id);
    this.shown.clear();
    if (ids.length) this.mark(ids, by);
  }

  /** Lines still waiting for a use (tests). */
  get waiting() {
    return [...this.shown.keys()];
  }

  private expire() {
    const now = this.now();
    for (const [id, at] of this.shown) if (now - at > SEEN_AFTER_MS) this.shown.delete(id);
  }

  private mark(ids: number[], why: "heard" | MacUse) {
    this.o.seen(ids, why);
    return true;
  }
}
