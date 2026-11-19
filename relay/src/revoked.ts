// The relay pass's revocation list (protocol/README.md, "Relay": the pass; README.md, "The revocation
// list"): access that ended before the pass ran out. When an account is banned or deleted, signs out
// everywhere, or its plan ends (the trial over, Pro ended), our account server writes an entry under
// the account (`sub:<sub>`); when one Mac signs out or is signed out from the account page, under the
// account and that Mac's room (`room:<sub>:<room>`). An entry is the time of the event: any pass
// issued before it (`iat` earlier) is refused at join, and a pass issued after (signed in again,
// subscribed again) works at once.
//
// The list is a KV namespace, PASS_REVOKED, that the account service writes and the relay only reads (both
// Workers bind the same namespace id). Each entry is `{"at": <Unix s>, "until": <Unix s>}` and expires
// on its own at `until` (KV's expiration): by then every pass issued before `at` has run out anyway
// (a pass lives at most the relay's passMaxLifeMs, which `until` - `at` is never shorter than). An
// entry read past its `until` counts for nothing (KV removes it soon after).
//
// Read only when a phone joins a room whose Mac's pass is otherwise good, with one bulk get of the
// two keys, and kept in the room's memory for revokedCacheMs (about a minute): a revocation takes at
// most that, plus KV's own spread across locations (up to a minute), to reach a room that read the
// list just before. KV not answering: a read of the same keys from within `staleMs` (10 minutes)
// still stands; with none that recent, the answer is "unknown", and the relay refuses the pass
// (unverified) rather than take it unchecked: the list fails closed, open for at most `staleMs` of
// an outage and only for a room that read the list just before. (The check of a room already open,
// to cut its phones on a revocation, does nothing on "unknown": an outage never cuts anyone off.)
// No imports, so the tests can load it in Node as it is.

/** The list's keys for a Mac's pass: the account's, and the account's on this room. */
export function revokedKeys(sub: string, room: string): [string, string] {
  return [`sub:${sub}`, `room:${sub}:${room}`];
}

/** KV's bulk get, as the relay reads the list (production: the PASS_REVOKED namespace). */
export type RevokedStore = { get(keys: string[], type: "text"): Promise<Map<string, string | null>> };

type Entry = { at: number; until: number };
/** One read of a pass's two keys: their entries, and when they were read (ms). */
type Read = { entries: Entry[]; readAt: number };

/** What the list says of a pass: on it, not on it, or not known (KV not answering, nothing recent to go by). */
export type Revocation = "revoked" | "clear" | "unknown";

/** An entry as kept: `{"at": s, "until": s}`; null when it isn't one. */
function entryOf(raw: string | null | undefined): Entry | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Entry>;
    if (typeof v?.at !== "number" || !Number.isFinite(v.at) || typeof v.until !== "number" || !Number.isFinite(v.until)) return null;
    return { at: v.at, until: v.until };
  } catch {
    return null;
  }
}

/**
 * A room's view of the list: what it read, per account and room, kept for `cacheMs`, and used for up
 * to `staleMs` while KV doesn't answer. One per Room object, in memory only (a room evicted from
 * memory reads again).
 */
export class RevokedList {
  private reads = new Map<string, Read>();
  private store: RevokedStore | undefined;
  private cacheMs: number;
  private staleMs: number;

  constructor(store: RevokedStore | undefined, cacheMs: number, staleMs = 10 * 60_000) {
    this.store = store;
    this.cacheMs = cacheMs;
    this.staleMs = Math.max(staleMs, cacheMs);
  }

  /**
   * Whether a pass for `sub` and `room`, issued at `iat` (Unix s), was revoked since: an entry that
   * hasn't expired, with its `at` after `iat`. No store (a relay run without the namespace): clear.
   * The store not answering: what was read within `staleMs`, else unknown.
   */
  async check(sub: string, room: string, iat: number, now = Date.now()): Promise<Revocation> {
    const read = await this.read(sub, room, now);
    if (!read) return "unknown";
    const nowS = now / 1000;
    return read.entries.some((e) => e.until > nowS && iat < e.at) ? "revoked" : "clear";
  }

  private async read(sub: string, room: string, now: number): Promise<Read | null> {
    const keys = revokedKeys(sub, room);
    const key = keys[1];
    const held = this.reads.get(key);
    if (held && now - held.readAt < this.cacheMs) return held;
    if (!this.store) return { entries: [], readAt: now };
    let got: Map<string, string | null>;
    try {
      got = await this.store.get(keys, "text");
    } catch {
      // KV away: the last read while it's recent enough, else not known (and the next check asks again).
      return held && now - held.readAt < this.staleMs ? held : null;
    }
    const entries = keys.map((k) => entryOf(got.get(k))).filter((e): e is Entry => e !== null);
    const read = { entries, readAt: now };
    // Only a few accounts ever show a room their pass (its Mac's): the oldest go past a handful.
    this.reads.delete(key);
    this.reads.set(key, read);
    while (this.reads.size > 8) this.reads.delete(this.reads.keys().next().value!);
    return read;
  }
}
