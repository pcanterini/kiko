// The relay pass (protocol/README.md, "Relay": the pass): Kiko's iPhone app needs Kiko Pro or the free
// trial (decided 2026-11-04). The Mac asks our account server for a pass (POST /v1/relay/pass, a
// compact JWS, EdDSA, for its own room; 24 hours since 2026-11-04, 7 days before) and shows it to its
// room as it signs in, or later on the same socket. This checks one: our issuer, the relay's audience,
// the room it's for, not expired, no longer-lived than maxLifeMs from its `iat`, and a signature from
// a key in our JWKS, fetched from the account server, cached per isolate, and fetched again for a key
// id it hasn't seen (keys rotate). No call to the account server per pass. Access that ended before a
// pass ran out (a ban, a sign-out, a plan's end) is the revocation list's, read at join (revoked.ts).
//
// The last good JWKS is kept in durable storage too (PASS_KEYS, a KV namespace; no expiry), so an
// account server outage never locks a phone out: a fresh isolate that can't fetch the JWKS checks
// passes against the keys last fetched. Only when no JWKS was ever fetched (nothing kept anywhere)
// can a pass not be checked: it's `unverified`, and refused like any pass that isn't good, so nobody
// can forge one during an outage.
//
// The room: a pass names the room it's for (`room`, the Mac's room id). One for another room is
// `invalid`, so a copied pass opens no other room. One without `room` (asked for before the Mac sent
// its room) is taken only while requirePass is off; at launch every pass must carry it.
// No imports, so the tests can load it in Node as it is.

export const PASS = {
  issuer: "https://account.kiko.sh",
  audience: "relay.kiko.sh",
  /** Our JWKS, tried in order: the account server answers /v1 on both its hostnames. */
  jwks: ["https://account.kiko.sh/v1/jwks", "https://api.kiko.sh/v1/jwks"],
  /** How long a fetched JWKS is used before it's fetched again (a failed fetch keeps the old one). */
  ttlMs: 60 * 60_000,
  /** A key id not in the JWKS fetches it again, at most this often (so made-up ids can't flood the account server). */
  refetchMs: 10_000,
  /** Each fetch of the JWKS gives up after this. */
  fetchMs: 3_000,
  /**
   * The longest pass taken, `exp` from its `iat` (RELAY_LIMITS passMaxLifeMs sets another): the account
   * server's 24 hours and a margin. Never longer than the revocation list's entries live (their
   * `until`, 26 hours after the event), so no pass outlives the entry that refuses it. A pass from
   * before 2026-11-04 (7 days) is invalid: the Mac asks again.
   */
  maxLifeMs: 26 * 60 * 60_000,
} as const;

/** The header a Mac's upgrade shows its relay pass in (since 2026-11-19; it shows it in `auth` too, for a relay from before it). */
export const PASS_HEADER = "Kiko-Relay-Pass";

export type PassStatus = "valid" | "unverified" | "missing" | "invalid" | "expired" | "revoked";
/**
 * A pass checked: while it's good (valid), `exp` (ms), its plan, and its account (`sub`) and `iat`
 * (Unix s) for the revocation list. Anything else is refused once requirePass is on. ("revoked" is the
 * list's word, at join: never checkPass's.)
 */
export type PassCheck = { status: "valid"; exp: number; plan: string; sub: string; iat: number } | { status: "missing" | "invalid" | "expired" | "unverified" };

/** Where the last good JWKS is kept, KV's own get and put (production: the PASS_KEYS namespace). */
export type KeyStore = { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> };
export type PassEnv = { PASS_JWKS_URL?: string; PASS_KEYS?: KeyStore };
/** The key it's kept under. */
const STORE_KEY = "jwks";

/**
 * A JWKS, its keys read. `raw`: the keys as kept in the store (each kid and x, sorted). `kept`: read
 * from the store because the account server couldn't be reached (it's fetched again soon).
 */
type KeySet = { keys: Map<string, CryptoKey>; at: number; raw: string; kept: boolean };
type Cache = {
  from: string;
  set: KeySet | null;
  lastRefetch: number;
  /** When a fetch last failed: none again for refetchMs (an outage doesn't make every check wait for timeouts). */
  failedAt: number;
  loading: Promise<boolean> | null;
  /** What the store holds, as last read or written by this isolate (undefined: not read yet). */
  stored: string | null | undefined;
};
let cache: Cache | null = null;

/** The JWKS URLs: PASS_JWKS_URL (comma-separated; tests set their own), else ours. */
function urlsOf(env: PassEnv): string[] {
  const given =
    env.PASS_JWKS_URL?.split(",")
      .map((u) => u.trim())
      .filter(Boolean) ?? [];
  return given.length ? given : [...PASS.jwks];
}

/** Ed25519 keys (each its `kid` and `x`), read; null when it isn't a list. */
async function keySet(list: unknown, kept: boolean): Promise<KeySet | null> {
  if (!Array.isArray(list)) return null;
  const keys = new Map<string, CryptoKey>();
  const raw: { kid: string; x: string }[] = [];
  for (const k of list as Record<string, unknown>[]) {
    if (typeof k?.x !== "string" || typeof k.kid !== "string") continue;
    try {
      keys.set(k.kid, await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: k.x }, { name: "Ed25519" }, false, ["verify"]));
      raw.push({ kid: k.kid, x: k.x });
    } catch {
      // A key this runtime can't read: skipped.
    }
  }
  raw.sort((a, b) => (a.kid < b.kid ? -1 : a.kid > b.kid ? 1 : 0));
  return { keys, at: Date.now(), raw: JSON.stringify(raw), kept };
}

async function fetchKeys(urls: string[]): Promise<KeySet | null> {
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(PASS.fetchMs) });
      if (!res.ok) continue;
      const body = (await res.json()) as { keys?: unknown };
      if (!Array.isArray(body.keys)) continue;
      return await keySet(
        body.keys.filter((k) => k?.kty === "OKP" && k.crv === "Ed25519"),
        false,
      );
    } catch {
      // Unreachable, timed out, not JSON: the next URL.
    }
  }
  return null;
}

/** The fetched keys, kept in the store when they changed (and only a set with keys: an empty one never replaces good ones). */
async function keep(c: Cache, store: KeyStore | undefined, set: KeySet) {
  if (!store || set.keys.size === 0) return;
  try {
    if (c.stored === undefined) c.stored = await store.get(STORE_KEY);
    if (c.stored === set.raw) return;
    await store.put(STORE_KEY, set.raw);
    c.stored = set.raw;
  } catch {
    // The store away: kept next time.
  }
}

/** The keys last kept in the store, or null (never fetched anywhere, or the store away). */
async function recall(store: KeyStore | undefined): Promise<KeySet | null> {
  if (!store) return null;
  try {
    const raw = await store.get(STORE_KEY);
    if (!raw) return null;
    const set = await keySet(JSON.parse(raw), true);
    return set && set.keys.size > 0 ? set : null;
  } catch {
    return null;
  }
}

/**
 * One fetch at a time per isolate. Fetched: used and kept in the store. Failed: what was cached stays;
 * with nothing cached, the keys last kept in the store (the account server away).
 */
function load(c: Cache, store: KeyStore | undefined, urls: string[]): Promise<boolean> {
  c.loading ??= (async () => {
    const fresh = await fetchKeys(urls);
    if (fresh) {
      c.set = fresh;
      await keep(c, store, fresh);
      return true;
    }
    c.failedAt = Date.now();
    if (!c.set) c.set = await recall(store);
    return false;
  })().finally(() => {
    c.loading = null;
  });
  return c.loading;
}

/** The key for `kid`: a CryptoKey, "unknown" (the JWKS, fresh, hasn't it), or "unreachable" (no JWKS that could say). */
async function keyFor(env: PassEnv, kid: string, now: number): Promise<CryptoKey | "unknown" | "unreachable"> {
  const urls = urlsOf(env);
  const from = urls.join(",");
  if (cache?.from !== from) cache = { from, set: null, lastRefetch: 0, failedAt: -Infinity, loading: null, stored: undefined };
  const c = cache;
  let fetched = false;
  const stale = !c.set || c.set.kept || now - c.set.at >= PASS.ttlMs;
  if (stale && now - c.failedAt >= PASS.refetchMs) fetched = await load(c, env.PASS_KEYS, urls);
  if (!c.set) return "unreachable";
  const key = c.set.keys.get(kid);
  if (key) return key;
  // Only the kept keys, the account server away: a key id they lack can't be checked.
  if (c.set.kept) return "unreachable";
  // A key id we don't know: maybe a new key (they rotate). Fetched again, unless just fetched or lately.
  if (fetched || now - c.lastRefetch < PASS.refetchMs) return "unknown";
  c.lastRefetch = now;
  if (!(await load(c, env.PASS_KEYS, urls))) return "unreachable";
  return c.set.keys.get(kid) ?? "unknown";
}

/** Forgets the cached JWKS (tests). */
export function forgetKeys() {
  cache = null;
}

function unb64url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function json(bytes: Uint8Array | null): any {
  if (!bytes) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * A pass, checked for the room `room`: its form, `iss`, `aud`, `plan`, `room`, `iat` and `exp` (no
 * more than `maxLifeMs` apart; `nbf` too if it has one), then the signature against our JWKS. `missing`
 * when there's none. `requireRoom`: a pass without `room` is `invalid` (requirePass on); else it's
 * taken (passes from before the room claim).
 */
export async function checkPass(env: PassEnv, pass: unknown, o: { room: string; requireRoom: boolean; maxLifeMs?: number }, now = Date.now()): Promise<PassCheck> {
  if (pass === undefined || pass === null || pass === "") return { status: "missing" };
  if (typeof pass !== "string" || pass.length > 4096) return { status: "invalid" };
  const parts = pass.split(".");
  if (parts.length !== 3) return { status: "invalid" };
  const header = json(unb64url(parts[0]));
  const claims = json(unb64url(parts[1]));
  const sig = unb64url(parts[2]);
  if (!header || !claims || !sig || header.alg !== "EdDSA" || typeof header.kid !== "string") return { status: "invalid" };
  const aud = claims.aud;
  const audOk = aud === PASS.audience || (Array.isArray(aud) && aud.includes(PASS.audience));
  if (claims.iss !== PASS.issuer || !audOk || typeof claims.sub !== "string" || !claims.sub) return { status: "invalid" };
  if (claims.plan !== "trial" && claims.plan !== "pro") return { status: "invalid" };
  if (claims.room === undefined ? o.requireRoom : claims.room !== o.room) return { status: "invalid" };
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return { status: "invalid" };
  if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat)) return { status: "invalid" };
  const exp = claims.exp * 1000;
  const iat = claims.iat * 1000;
  const maxLife = o.maxLifeMs ?? PASS.maxLifeMs;
  // Longer-lived than the relay takes (from its iat, or from now), or issued in the future: never good.
  if (exp - iat > maxLife || exp - now > maxLife || iat > now + 60_000) return { status: "invalid" };
  if (typeof claims.nbf === "number" && claims.nbf * 1000 > now + 60_000) return { status: "invalid" };
  if (exp <= now) return { status: "expired" };
  const key = await keyFor(env, header.kid, now);
  if (key === "unknown") return { status: "invalid" };
  // No JWKS that could say, ever (or none with this key id while the server is away): never taken on trust.
  if (key === "unreachable") return { status: "unverified" };
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, sig, signed).catch(() => false);
  return ok ? { status: "valid", exp, plan: claims.plan, sub: claims.sub, iat: claims.iat } : { status: "invalid" };
}
