// The relay's limits (README.md, "Limits"), in two kinds:
//
// - The protocol's (PROTOCOL): what the Mac and the phone build on, written down in
//   protocol/README.md ("Relay"): the largest message, the time to sign in, how long a quiet socket
//   lives, the pairing QR code's rules. Fixed: production never changes them.
// - The abuse limits (DEFAULTS): how much a socket and a room may send, how many sockets may wait,
//   how many new rooms one address may open. Tunable, so they're not in the code: production sets its
//   own with the RELAY_LIMITS secret (README.md, "Deploying"), and the numbers below are only safe
//   defaults for a relay run without it.
//
// RELAY_LIMITS is a JSON object of any of these keys (the abuse limits in production; tests also
// shorten the protocol's timings to run quickly). It's read once per isolate. A key it leaves out,
// or gives a value that isn't valid, keeps its default; a key it doesn't know is ignored; anything
// that isn't a JSON object leaves every default in place. Every default fails closed: requirePass is
// on unless RELAY_LIMITS turns it off (`"requirePass": false`, for development and tests).
// No imports, so the tests can load it in Node as it is.

const MiB = 1024 * 1024;

/** A token bucket: `burst` messages, refilled at `perSecond`. */
export type Rate = { perSecond: number; burst: number };

/** The protocol's limits (protocol/README.md, "Relay"): the Mac and the phone depend on these. */
export const PROTOCOL = {
  /** A socket that hasn't signed in (the Mac) or joined (a phone) by then is closed (timeout, 4005). */
  signInMs: 10_000,
  /** The largest binary message passed along: the tunnel's largest record (1 MiB of plaintext, plus its type byte and 16-byte tag) behind 4 bytes of channel, with room to spare. */
  frameBytes: MiB + 1024,
  /** The largest text message: sign-in, join, the Mac's list of 32 credential hashes (~2.2 KB), a channel to close. */
  textBytes: 16 * 1024,
  /** A signed-in Mac or a joined phone with no sign of life this long is half-open: closed (idle, 4011). The Mac pings every 10 s, the hub pings each phone every 15 s. */
  idleMs: 90_000,
  /** The longest a pairing QR code's credential lets a phone in, from when the Mac first registered it (the code's own life on the Mac). */
  pairingMs: 5 * 60_000,
  /** Phones one pairing credential lets in over its life, however often the Mac registers it again. */
  pairingJoins: 5,
};

/**
 * The abuse limits: defaults; production sets its own (RELAY_LIMITS). Round numbers, well above
 * what a Mac and its phones send (README.md, "Limits"), and low enough that a room is no free tunnel.
 */
export const DEFAULTS = {
  /**
   * Sockets waiting in a room (not signed in or joined yet), each role with a budget of its own, so
   * strangers waiting as phones never keep the Mac out: `pending` phones and `macPending` Macs (those
   * without a good pass in the upgrade: a Mac with one has a way in of its own, src/index.ts). When a
   * role's budget is full, its oldest waiting socket is let go (timeout, 4005) for the new one: whoever
   * holds the slots must keep making new sockets, which the per-address limits below make slow.
   */
  pending: 10,
  macPending: 2,
  /** Waiting sockets one address may hold in a room at once (more: HTTP 429). IPv6 counts by its /64. */
  pendingPerIp: 3,
  /** New sockets one address may open to a room (a token bucket, in the room's memory; over: HTTP 429). */
  ipRate: { perSecond: 1, burst: 10 } as Rate,
  /** Messages a socket may send (a token bucket). The Mac's is bigger: it speaks to up to ten phones. */
  phoneRate: { perSecond: 100, burst: 500 } as Rate,
  macRate: { perSecond: 500, burst: 2000 } as Rate,
  /** Bytes a room passes, both ways together, in a window and in a day (each window starts with its first byte). */
  windowMs: 60 * 60_000,
  windowBytes: 500 * MiB,
  dayMs: 24 * 60 * 60_000,
  dayBytes: 2048 * MiB,
  /**
   * New rooms one address may open (as a Mac without a good pass in the upgrade) in an hour: counted
   * in shared state (the Limiter Durable Object for the address; IPv6 by its /64), with an in-memory
   * map per isolate in front of it. A room already seen from the address always passes.
   */
  roomsPerIpHour: 20,
  /** Addresses the per-isolate map keeps in memory at once (the oldest go first). */
  ipsTracked: 20_000,
  /**
   * Rooms one account (a pass's `sub`) may open in `roomsPerAccountMs`: the distinct rooms whose Mac
   * signed in with one of its passes in that time (a room seen again counts once). A pass is for one
   * room, so this caps how many Macs one subscription powers. Over: HTTP 429 at the upgrade, or
   * `too_many_rooms` (4016) at sign-in.
   */
  roomsPerAccount: 8,
  roomsPerAccountMs: 24 * 60 * 60_000,
  /**
   * The relay pass (src/pass.ts; protocol/README.md, "Relay": the pass). True (the default, so a
   * missing or malformed RELAY_LIMITS fails closed): a Mac signs in only with a good pass for its room
   * (else plan_required, 4014), and a phone joins only a room whose Mac's pass is good (plan_required).
   * False, set explicitly (development, tests): every room works without one, and a phone let in
   * without one is only logged.
   */
  requirePass: true as boolean,
  /**
   * The longest relay pass taken, `exp` from its `iat` (src/pass.ts): 26 hours, the account server's
   * 24 and a margin. Never more than the revocation list's entries live (26 hours: the account service's
   * relayPassHours plus 2), or a revoked pass could outlive its entry.
   */
  passMaxLifeMs: 26 * 60 * 60_000,
  /** How long a room keeps what it read of the revocation list (src/revoked.ts): about a minute. */
  revokedCacheMs: 60_000,
  /**
   * KV not answering: a read of the list this recent still stands (src/revoked.ts); with none, the
   * pass is refused (unverified). So the list fails closed, after at most this window open.
   */
  revokedStaleMs: 10 * 60_000,
};

export const LIMITS = { ...PROTOCOL, ...DEFAULTS };
export type Limits = typeof LIMITS;

type Kind = "ms" | "count" | "rate" | "flag";
/** What each key takes: a time or a size (a positive number), a count (a positive whole number), a rate, or a flag (true or false). */
const KINDS: Record<keyof Limits, Kind> = {
  signInMs: "ms",
  frameBytes: "count",
  textBytes: "count",
  idleMs: "ms",
  pairingMs: "ms",
  pairingJoins: "count",
  pending: "count",
  macPending: "count",
  pendingPerIp: "count",
  ipRate: "rate",
  phoneRate: "rate",
  macRate: "rate",
  windowMs: "ms",
  windowBytes: "count",
  dayMs: "ms",
  dayBytes: "count",
  roomsPerIpHour: "count",
  ipsTracked: "count",
  roomsPerAccount: "count",
  roomsPerAccountMs: "ms",
  requirePass: "flag",
  passMaxLifeMs: "ms",
  revokedCacheMs: "ms",
  revokedStaleMs: "ms",
};

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const whole = (v: unknown): v is number => positive(v) && Number.isInteger(v);

/** One key's value, or undefined when it isn't valid (the default holds). A rate may give one half: the other keeps its default. */
function valid(kind: Kind, v: unknown, fallback: unknown): unknown {
  if (kind === "ms") return positive(v) ? v : undefined;
  if (kind === "count") return whole(v) ? v : undefined;
  if (kind === "flag") return typeof v === "boolean" ? v : undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const r = v as Partial<Rate>;
  const base = fallback as Rate;
  if ((r.perSecond !== undefined && !positive(r.perSecond)) || (r.burst !== undefined && !whole(r.burst))) return undefined;
  return { perSecond: r.perSecond ?? base.perSecond, burst: r.burst ?? base.burst };
}

/**
 * The limits, from RELAY_LIMITS's text over the defaults. `ignored`: the keys it set that weren't
 * valid (named, never their values), or "RELAY_LIMITS" when it isn't a JSON object at all.
 */
export function parseLimits(raw: string | undefined): { limits: Limits; ignored: string[] } {
  const limits: Limits = { ...LIMITS, phoneRate: { ...LIMITS.phoneRate }, macRate: { ...LIMITS.macRate }, ipRate: { ...LIMITS.ipRate } };
  if (raw === undefined || raw.trim() === "") return { limits, ignored: [] };
  let given: unknown;
  try {
    given = JSON.parse(raw);
  } catch {
    return { limits, ignored: ["RELAY_LIMITS"] };
  }
  if (!given || typeof given !== "object" || Array.isArray(given)) return { limits, ignored: ["RELAY_LIMITS"] };
  const ignored: string[] = [];
  for (const [key, v] of Object.entries(given)) {
    if (!Object.hasOwn(KINDS, key)) continue; // a key this relay doesn't know (maybe a newer one's)
    const k = key as keyof Limits;
    const ok = valid(KINDS[k], v, limits[k]);
    if (ok === undefined) ignored.push(key);
    else (limits as Record<string, unknown>)[k] = ok;
  }
  return { limits, ignored };
}

let parsed: { from: string | undefined; limits: Limits } | null = null;
/** The limits for this isolate: RELAY_LIMITS parsed the first time (again only if it changed). */
export function limitsOf(env: { RELAY_LIMITS?: string }): Limits {
  if (parsed && parsed.from === env.RELAY_LIMITS) return parsed.limits;
  const { limits, ignored } = parseLimits(env.RELAY_LIMITS);
  // Which keys, never their values (observability is off in production anyway).
  if (ignored.length) console.warn(`RELAY_LIMITS: ignored ${ignored.join(", ")} (the defaults hold)`);
  parsed = { from: env.RELAY_LIMITS, limits };
  return limits;
}
