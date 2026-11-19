// Whether you're at the Mac when a line goes to an away phone (TODO "No phone buzz while the user is
// at the Mac", a release blocker). Decided when the line is said, not where the request came from:
//   - at the Mac: keyboard or mouse input in the last AT_MAC_IDLE_MS, and its screen neither locked
//     nor asleep. The phone gets the line quietly (missed_line `quiet`): in its list and its badge,
//     no notification. Its permission questions too (permission_prompt `quiet`).
//   - away: idle longer, locked or asleep, or the Mac can't tell. Notified as before.
// Asking from the Mac and leaving with the phone in a pocket is covered: the reply minutes later
// finds the Mac idle. Reading at the Mac for over 2 minutes without touching anything gives an extra
// buzz, never a missed reply.
import type { AtComputer } from "../platform/types.ts";

/** Input this recent means you're at the Mac. */
export const AT_MAC_IDLE_MS = 2 * 60_000;
/** A reading this fresh is used again: a question and its spoken line ask once. */
const FRESH_MS = 1500;

export type AtMac = { atMac: boolean; reading: AtComputer | null };

/** At the Mac by this reading: recent input, the screen unlocked and awake. Not when it can't tell. */
export function atMac(reading: AtComputer | null): boolean {
  return reading !== null && !reading.locked && !reading.asleep && reading.idleMs < AT_MAC_IDLE_MS;
}

/**
 * Reads whether you're at the Mac, at most once per FRESH_MS (calls meanwhile share one reading).
 * `latest`: a fresh enough answer without reading again, else null.
 */
export class MacPresence {
  private last: { at: number; value: AtMac } | null = null;
  private reading: Promise<AtMac> | null = null;
  private read: () => Promise<AtComputer | null>;
  private now: () => number;

  constructor(read: () => Promise<AtComputer | null>, now: () => number = Date.now) {
    this.read = read;
    this.now = now;
  }

  latest(): AtMac | null {
    return this.last && this.now() - this.last.at < FRESH_MS ? this.last.value : null;
  }

  check(): Promise<AtMac> {
    const fresh = this.latest();
    if (fresh) return Promise.resolve(fresh);
    this.reading ??= this.read()
      .catch(() => null)
      .then((reading) => {
        const value = { atMac: atMac(reading), reading };
        this.last = { at: this.now(), value };
        this.reading = null;
        return value;
      });
    return this.reading;
  }
}

/** What a log line says of whether you were at the Mac: nothing when it wasn't asked. */
export function atMacLog(at: AtMac | null) {
  if (!at) return {};
  const r = at.reading;
  return { atMac: at.atMac, ...(r ? { idleS: Math.round(r.idleMs / 1000), ...(r.locked ? { locked: true } : {}), ...(r.asleep ? { asleep: true } : {}) } : { unknown: true }) };
}
