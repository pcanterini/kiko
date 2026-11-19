// Kiko's phone relay: how a phone reaches its Mac from anywhere, with nothing to set up. The Mac
// and each phone connect out to it over a WebSocket, and it passes what one side sends to the other.
// It never sees what they say: the phone and the Mac run an end-to-end encrypted tunnel through it
// (protocol/README.md, "Relay"), keyed at pairing on the home network, so to the relay every frame
// after a phone joins is opaque bytes.
//
// One Durable Object per Mac (a room), named by the room id, which is derived from the Mac's own
// signing key: only the Mac holding that key can open its room, by signing a fresh challenge. The Mac
// tells its room the hashes of the credentials it gave its phones; a phone presents one to join. The
// WebSocket Hibernation API keeps an idle room from costing anything: what each socket is (the Mac,
// a phone, signed in or not) is kept in its attachment, so the object can be evicted between frames.
//
// Pairing from away (protocol/README.md, "Pairing through the relay"): while the Mac shows its pairing
// QR code, it registers one more credential's hash, drawn from the code's secret, for at most five
// minutes. It lets one phone in per registration (the Mac registers it again if that one didn't
// pair), on a channel marked `pairing`, and is spent once the Mac says so; a phone that comes with a
// spent or expired one hears why (qr_used, qr_expired), as the Mac's close of a pairing channel can
// say too. The relay can't pair with it: the pairing itself is CPace with the secret, end to end.
//
// The relay pass (protocol/README.md, "Relay": the pass; src/pass.ts): the iPhone app needs Kiko Pro
// or the free trial (decided 2026-11-04). The Mac shows its room a pass from our account server: in
// the upgrade's Kiko-Relay-Pass header (since 2026-11-19), in `auth` as it signs in, or later
// (`pass`). A pass is for one room (its `room`): one for another, or one without `room`, is invalid.
// With RELAY_LIMITS' requirePass on (the default since 2026-11-19, so a missing or malformed
// RELAY_LIMITS fails closed; off only when set so, for development and tests), a Mac signs in only
// with a good pass (else plan_required, 4014), so only a holder of a good pass for the room can claim
// it or displace the Mac there; and a phone joins only a room whose Mac's pass is good. The last good
// JWKS is kept in PASS_KEYS (KV), so an account server outage never locks a phone out, and a pass is
// never taken unchecked. A pass lives 24 hours; access that ends sooner (a ban, a deletion, a
// sign-out, a plan's end) is on the revocation list (src/revoked.ts, the PASS_REVOKED namespace
// the account service writes), read at sign-in and join, and again about once a minute while phones are in
// the room: a pass issued before its entry is refused (plan_required, the Mac told `revoked`), and the
// phones already in are let go. KV not answering fails closed after a short window (src/revoked.ts).
// A pass that only runs out cuts nobody off (the Mac renews it; an outage shouldn't end a session).
//
// Who may wait in a room (M8 of the 2026-11-19 review: anyone who knows a room id, it's in the
// pairing QR code, could keep its Mac out by holding every waiting slot): each role has a budget of
// its own (`pending` phones, `macPending` Macs), the oldest waiting socket let go for a new one; an
// address holds at most `pendingPerIp` waiting sockets in a room and opens new ones at `ipRate`; and
// a Mac with a good pass for the room in its upgrade waits outside all of that (one per account).
//
// New rooms (src/limiter.ts, shared state): a Mac's upgrade with a good pass counts against its
// account's rooms (roomsPerAccount a day); one without, against its address's (roomsPerIpHour).
import { DurableObject } from "cloudflare:workers";
import type { Limiter } from "./limiter.ts";
import { limitsOf, type Limits } from "./limits.ts";
import { addressOf } from "./address.ts";
import { checkPass, PASS_HEADER, type KeyStore, type PassCheck, type PassStatus } from "./pass.ts";
import { RevokedList, type RevokedStore } from "./revoked.ts";

export { Limiter } from "./limiter.ts";

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  /** The shared counts of rooms opened, per address and per account (src/limiter.ts). */
  LIMITER?: DurableObjectNamespace<Limiter>;
  /**
   * Where the relay pass's keys are (src/pass.ts): JWKS URLs, comma-separated. Unset in production
   * (our account server's, in the code); tests point it at their own.
   */
  PASS_JWKS_URL?: string;
  /**
   * The last good JWKS, kept with no expiry (src/pass.ts): a KV namespace, so the pass is checked
   * against the keys last fetched while the account server is away. Local in tests (nothing kept).
   */
  PASS_KEYS?: KVNamespace & KeyStore;
  /**
   * The relay pass's revocation list (src/revoked.ts): a KV namespace the account service writes and the relay
   * only reads, at join. Local and empty in tests unless they write to it first.
   */
  PASS_REVOKED?: KVNamespace & RevokedStore;
  /**
   * The abuse limits, a JSON object over the defaults (src/limits.ts; README.md, "Limits"): a secret in
   * production, so its numbers aren't in the code. Tests set their own (smaller numbers, shorter windows).
   */
  RELAY_LIMITS?: string;
}

/** A room id: the first 16 bytes of SHA-256 of the Mac's Ed25519 public key, in lowercase hex. */
const ROOM = /^[0-9a-f]{32}$/;
/** What the Mac signs, before the room id and the nonce. */
const AUTH_CONTEXT = "kiko relay mac v1";
/** Phones in a room at once (too_many, 4004), and credentials a Mac may register: the protocol's, fixed. */
const MAX_PHONES = 10;
const MAX_CREDENTIALS = 32;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

const MiB = 1024 * 1024;

/** Usage is written to storage at most once per this many bytes (and when a room goes over, or a socket closes). */
const SAVE_EVERY = MiB;

/** Close codes, each with the error code sent just before it (protocol/README.md, "Relay"). */
export const CLOSE = {
  replaced: 4000,
  unauthorized: 4001,
  mac_gone: 4002,
  mac_offline: 4003,
  too_many: 4004,
  timeout: 4005,
  bad_message: 4006,
  // 4007 (ticket_required) was the account check's placeholder before the pass: retired, never sent.
  too_big: 4008,
  rate_limited: 4009,
  over_quota: 4010,
  idle: 4011,
  qr_used: 4012,
  qr_expired: 4013,
  plan_required: 4014,
  // 4015 is the phone server's own (signed_in, at home): never the relay's.
  too_many_rooms: 4016,
} as const;
type CloseWhy = keyof typeof CLOSE;

/**
 * `seen`: the last time the socket sent anything (written now and then, so it survives hibernation).
 * `ip`: a short hash of the address it came from (its /64 for IPv6), for the per-address limits; never
 * logged. `pass`: what came of the Mac's relay pass (none shown: missing); `passExp` (ms), while it's
 * good, and its account (`passSub`) and `passIat` (Unix s), for the revocation list. `early`: the
 * account of a good pass shown in the upgrade (such a Mac waits outside the budgets).
 */
type MacTag = {
  role: "mac";
  room: string;
  at: number;
  nonce: string;
  authed: boolean;
  ip?: string;
  early?: string;
  seen?: number;
  pass?: PassStatus;
  passExp?: number;
  passSub?: string;
  passIat?: number;
};
/** `pairing`: joined with the pairing QR code's credential (none of the Mac's list: changes to it don't touch this phone). */
type PhoneTag = { role: "phone"; room: string; at: number; channel: number | null; credential: string | null; pairing?: boolean; ip?: string; seen?: number };
type Tag = MacTag | PhoneTag;

/**
 * The pairing QR code's way in, as the Mac last said (storage "pairing"): its credential's hash, until
 * when it works, and whether it lets a phone in now (open), let one in already (used: the Mac says
 * again if that one didn't pair), or was shut by the Mac (a code that stopped working); `joins`, the
 * phones it let in over its life. Kept once shut until another replaces it, so a phone hears why.
 */
type Pairing = { hash: string; until: number; state: "open" | "used" | "shut"; joins: number };

/** A room's traffic: each window's start and bytes, and when a room over its budget may pass frames again. */
type Usage = { win: number; winBytes: number; day: number; dayBytes: number; blockedUntil: number };

/** What a socket did lately, kept in memory only (a room that wakes from hibernation starts each bucket full). */
type Live = { tokens: number; at: number; seen: number; saved: number };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = url.pathname.match(/^\/v1\/(mac|phone)\/([^/]+)$/);
    if (!route) return new Response("Not found", { status: 404 });
    if (!ROOM.test(route[2])) return new Response("Not a room", { status: 400 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    if (route[1] === "mac") {
      const refused = await admitMac(request, env, route[2]);
      if (refused) return refused;
    }
    const room = env.ROOMS.get(env.ROOMS.idFromName(route[2]));
    return room.fetch(request);
  },
} satisfies ExportedHandler<Env>;

/**
 * A Mac's upgrade, before any room is made (M7 of the 2026-11-19 review: else anyone can make room
 * after room, each a Durable Object). With a good pass for the room in the header, it's counted
 * against the pass's account (roomsPerAccount distinct rooms in roomsPerAccountMs); without (a Mac
 * from before the header, or one with no plan), against its address (roomsPerIpHour new rooms an
 * hour: first this isolate's map, then the shared count). A room already counted always passes.
 * The shared count not answering: refused (503), never let through uncounted.
 */
async function admitMac(request: Request, env: Env, room: string): Promise<Response | null> {
  const limits = limitsOf(env);
  const given = request.headers.get(PASS_HEADER);
  if (given) {
    const pass = await checkPass(env, given, { room, requireRoom: true, maxLifeMs: limits.passMaxLifeMs });
    if (pass.status === "valid") {
      const ok = await admitted(env, `sub:${pass.sub}`, room, limits.roomsPerAccount, limits.roomsPerAccountMs);
      if (ok === "error") return new Response("Try again soon", { status: 503 });
      return ok ? null : new Response("Too many rooms for this account today", { status: 429 });
    }
    // A pass that isn't good: as if none was shown (the room says why at sign-in).
  }
  const ip = addressOf(request.headers.get("CF-Connecting-IP"));
  if (!roomAllowed(ip, room, Date.now(), limits)) return new Response("Too many new rooms from this address: try again in an hour", { status: 429 });
  const ok = await admitted(env, `ip:${ip}`, room, limits.roomsPerIpHour, HOUR);
  if (ok === "error") return new Response("Try again soon", { status: 503 });
  return ok ? null : new Response("Too many new rooms from this address: try again in an hour", { status: 429 });
}

/** Rooms this isolate saw let in lately, by name and room: not asked of the shared count again for a while. */
const admittedHere = new Map<string, number>();
const ADMITTED_MS = 10 * 60_000;

/**
 * Whether `room` may open under `name` (`ip:<address>` or `sub:<account>`): the shared count's say
 * (src/limiter.ts), cached here once yes. "error": it didn't answer. A relay run without the
 * binding has no shared count (true).
 */
async function admitted(env: Env, name: string, room: string, max: number, windowMs: number): Promise<boolean | "error"> {
  const key = `${name}|${room}`;
  const now = Date.now();
  const at = admittedHere.get(key);
  if (at !== undefined && now - at < ADMITTED_MS) return true;
  if (!env.LIMITER) return true;
  let ok: boolean;
  try {
    ok = await env.LIMITER.get(env.LIMITER.idFromName(name)).admit(room, max, windowMs);
  } catch {
    return "error";
  }
  if (ok) {
    admittedHere.delete(key);
    admittedHere.set(key, now);
    while (admittedHere.size > 10_000) admittedHere.delete(admittedHere.keys().next().value!);
  }
  return ok;
}

/**
 * New rooms per address per hour, in this isolate's memory: a free first check in front of the
 * shared one (admitted), so a flood from one address mostly stops here. A room already seen from the
 * address (the Mac reconnecting) always passes.
 */
const roomsByIp = new Map<string, { since: number; rooms: Set<string> }>();
function roomAllowed(ip: string, room: string, now: number, limits: Limits) {
  let e = roomsByIp.get(ip);
  if (!e || now - e.since >= HOUR) {
    roomsByIp.delete(ip);
    e = { since: now, rooms: new Set() };
    roomsByIp.set(ip, e);
    // Oldest first (a Map keeps insertion order): the map never outgrows a few MB.
    while (roomsByIp.size > limits.ipsTracked) roomsByIp.delete(roomsByIp.keys().next().value!);
  }
  if (e.rooms.has(room)) return true;
  if (e.rooms.size >= limits.roomsPerIpHour) return false;
  e.rooms.add(room);
  return true;
}

export class Room extends DurableObject<Env> {
  private limits: Limits;
  /** Each socket's message bucket and last sign of life, while the room is awake. */
  private live = new Map<WebSocket, Live>();
  /** The room's traffic, read from storage once per wake; `unsaved`: bytes counted since it was last written. */
  private usage: Usage | null = null;
  private unsaved = 0;
  /** When the Mac was last told the room is over its budget (it's told once per block). */
  private toldMac = 0;
  private lastSweep = 0;
  /** The revocation list as this room last read it (src/revoked.ts), kept revokedCacheMs. */
  private revokedList: RevokedList;
  /** When the Mac's pass was last looked up on the list while phones were in (sweep: they go if it's revoked). */
  private lastPassLook = 0;
  /** New sockets per address (a token bucket each, `ipRate`), in memory only. */
  private arrivals = new Map<string, { tokens: number; at: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.limits = limitsOf(env);
    this.revokedList = new RevokedList(env.PASS_REVOKED, this.limits.revokedCacheMs, this.limits.revokedStaleMs);
    // Keepalives answered without waking the room: either side sends "ping" now and then.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const [, role, room] = new URL(request.url).pathname.match(/^\/v1\/(mac|phone)\/([0-9a-f]{32})$/)!;
    const now = Date.now();
    const ip = await addressTag(request.headers.get("CF-Connecting-IP"));
    // A Mac showing a good pass for this room in its upgrade waits outside every budget: strangers
    // holding the waiting slots can't keep it out. One such per account: a newer one replaces it.
    const early = role === "mac" ? await this.earlyPass(request, room) : null;
    const waiting = this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN && !signedIn(tagOf(ws)));
    if (early) {
      for (const ws of waiting) if (earlyOf(tagOf(ws)) === early.sub) refuse(ws, "timeout");
    } else {
      // Per address: how fast it opens sockets here, and how many it holds waiting.
      if (!this.arrived(ip, now)) return new Response("Too many new sockets from this address", { status: 429 });
      const counted = waiting.filter((ws) => !earlyOf(tagOf(ws)));
      if (counted.filter((ws) => tagOf(ws)?.ip === ip).length >= this.limits.pendingPerIp) return new Response("Too many sockets waiting from this address", { status: 429 });
      // The role's own budget: full, its oldest waiting socket goes for this one.
      const mine = counted.filter((ws) => tagOf(ws)?.role === role).sort((a, b) => (tagOf(a)?.at ?? 0) - (tagOf(b)?.at ?? 0));
      const budget = role === "mac" ? this.limits.macPending : this.limits.pending;
      while (mine.length >= budget) refuse(mine.shift()!, "timeout");
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [role]);
    if (role === "mac") {
      const nonce = base64(crypto.getRandomValues(new Uint8Array(32)));
      tag(server, { role: "mac", room, at: now, nonce, authed: false, ip, ...(early ? { early: early.sub, ...passFields(early) } : {}) });
      server.send(JSON.stringify({ type: "challenge", nonce }));
    } else {
      tag(server, { role: "phone", room, at: now, channel: null, credential: null, ip });
    }
    await this.alarmBy(now + this.limits.signInMs);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** The pass in a Mac's upgrade, if it's a good one for this room (else null: the socket waits as any). */
  private async earlyPass(request: Request, room: string) {
    const given = request.headers.get(PASS_HEADER);
    if (!given) return null;
    const pass = await checkPass(this.env, given, this.passFor(room));
    return pass.status === "valid" ? pass : null;
  }

  /** One more socket from this address: false once its bucket is empty. */
  private arrived(ip: string, now: number) {
    const rate = this.limits.ipRate;
    let b = this.arrivals.get(ip);
    if (!b) {
      b = { tokens: rate.burst, at: now };
      while (this.arrivals.size >= 256) this.arrivals.delete(this.arrivals.keys().next().value!);
    }
    this.arrivals.delete(ip);
    this.arrivals.set(ip, b);
    b.tokens = Math.min(rate.burst, b.tokens + ((now - b.at) / 1000) * rate.perSecond);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const t = tagOf(ws);
    if (!t) return;
    const text = typeof message === "string";
    const size = text ? message.length : message.byteLength;
    const inRoom = signedIn(t);
    // Before signing in only one small text message is expected; after it, text stays small and frames up to a tunnel record.
    if (size > (inRoom && !text ? this.limits.frameBytes : this.limits.textBytes)) return this.kick(ws, "too_big");
    if (!this.take(ws, t)) return this.kick(ws, "rate_limited");
    if (Date.now() - this.lastSweep >= this.limits.idleMs / 2) await this.sweep();
    if (message === "pong") return; // the other end's answer to our ping, if it ever sends one
    if (t.role === "mac") return t.authed ? this.fromMac(ws, message) : this.signIn(ws, t, message);
    return t.channel === null ? this.join(ws, t, message) : this.fromPhone(ws, t, message);
  }

  async webSocketClose(ws: WebSocket, code: number) {
    this.gone(ws, code);
    await this.saveUsage();
  }

  async webSocketError(ws: WebSocket) {
    this.gone(ws, 1011);
    await this.saveUsage();
  }

  /** Sockets that haven't signed in or joined in time, and half-open ones, are let go (sweep). */
  async alarm() {
    await this.sweep(true);
  }

  // ── Limits ────────────────────────────────────────────────────────────────

  /** One message from this socket: false once its bucket is empty (it sent too many, too fast). */
  private take(ws: WebSocket, t: Tag) {
    const now = Date.now();
    const rate = t.role === "mac" ? this.limits.macRate : this.limits.phoneRate;
    let l = this.live.get(ws);
    if (!l) this.live.set(ws, (l = { tokens: rate.burst, at: now, seen: now, saved: t.seen ?? t.at }));
    l.tokens = Math.min(rate.burst, l.tokens + ((now - l.at) / 1000) * rate.perSecond);
    l.at = now;
    l.seen = now;
    // Its last sign of life, kept in the attachment now and then, so a sweep after hibernation knows it.
    if (now - l.saved >= this.limits.idleMs / 4) {
      l.saved = now;
      tag(ws, { ...t, seen: now });
    }
    if (l.tokens < 1) return false;
    l.tokens -= 1;
    return true;
  }

  /** When the socket last sent anything, a ping answered by the runtime included. */
  private lastSign(ws: WebSocket, t: Tag) {
    const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    return Math.max(this.live.get(ws)?.seen ?? 0, t.seen ?? t.at, pinged);
  }

  /**
   * Lets go of sockets that haven't signed in or joined within signInMs (timeout), and of signed-in
   * ones that have shown no sign of life for idleMs (idle: half-open, their other end long gone). Runs
   * on the alarm, which is set only while a socket is waiting to sign in or a phone is in the room
   * (a room holding only its Mac sleeps undisturbed), and whenever the room is awake anyway: a phone
   * joining checks the Mac is really there.
   */
  private async sweep(fromAlarm = false) {
    const now = Date.now();
    this.lastSweep = now;
    let next = Infinity;
    for (const ws of this.ctx.getWebSockets()) {
      const t = tagOf(ws);
      if (!t || ws.readyState !== WebSocket.OPEN) continue;
      if (!signedIn(t)) {
        if (now - t.at >= this.limits.signInMs) refuse(ws, "timeout");
        else next = Math.min(next, t.at + this.limits.signInMs);
        continue;
      }
      const last = this.lastSign(ws, t);
      if (now - last >= this.limits.idleMs) {
        // Out of the room at once: the close may never come back from a half-open socket.
        this.kick(ws, "idle");
      } else if (t.role === "phone") next = Math.min(next, last + this.limits.idleMs);
    }
    // From the alarm itself, the one that just went off may still read as set: the next is set regardless.
    if (next < Infinity) await (fromAlarm ? this.ctx.storage.setAlarm(next) : this.alarmBy(next));
    // Phones in: the Mac's pass looked up on the revocation list again now and then (the alarm comes
    // at least every idleMs while they're in), so a revocation cuts the phones already in too.
    if (this.limits.requirePass && now - this.lastPassLook >= this.limits.revokedCacheMs && this.phones().length > 0) await this.recheckPass(now);
  }

  /**
   * The Mac's pass, revoked since it was checked: the Mac's tag says so (no phone joins until it shows
   * a new one), the Mac hears it as it would at a join (`phone_refused`, `revoked`: it asks for a new
   * pass), and every phone in goes (plan_required). Only a revocation does this: a pass that ran out
   * (the account server away, the Mac unable to renew) cuts nobody off, and neither does the list not
   * answering ("unknown").
   */
  private async recheckPass(now: number) {
    this.lastPassLook = now;
    const mac = this.authedMac();
    if (!mac) return;
    const t = tagOf(mac) as MacTag;
    if (passNow(t, now) !== "valid" || !t.passSub || typeof t.passIat !== "number") return;
    if ((await this.revokedList.check(t.passSub, t.room, t.passIat, now)) !== "revoked") return;
    // Still that Mac, with that pass, after the read.
    const still = tagOf(mac) as MacTag | null;
    if (mac.readyState !== WebSocket.OPEN || !still?.authed || still.passIat !== t.passIat || still.passSub !== t.passSub) return;
    tag(mac, { ...still, pass: "revoked", passExp: undefined, passSub: undefined, passIat: undefined });
    mac.send(JSON.stringify({ type: "phone_refused", code: "plan_required", pass: "revoked" }));
    for (const phone of this.phones()) this.kick(phone, "plan_required");
  }

  /** An alarm at `at` at the latest (one already sooner stays). */
  private async alarmBy(at: number) {
    const set = await this.ctx.storage.getAlarm();
    if (set === null || set > at) await this.ctx.storage.setAlarm(at);
  }

  private async loadUsage(now: number): Promise<Usage> {
    const u = (this.usage ??= (await this.ctx.storage.get<Usage>("usage")) ?? { win: now, winBytes: 0, day: now, dayBytes: 0, blockedUntil: 0 });
    if (now - u.win >= this.limits.windowMs) Object.assign(u, { win: now, winBytes: 0 });
    if (now - u.day >= this.limits.dayMs) Object.assign(u, { day: now, dayBytes: 0 });
    return u;
  }

  /**
   * Counts a frame against the room's budget: null when it may pass, else the seconds until the room
   * may pass frames again. A frame that would take either window over its budget doesn't pass, and
   * neither does any after it until that window is over.
   */
  private async spend(bytes: number): Promise<number | null> {
    const now = Date.now();
    const u = await this.loadUsage(now);
    if (now < u.blockedUntil) return Math.ceil((u.blockedUntil - now) / 1000);
    const overWindow = u.winBytes + bytes > this.limits.windowBytes;
    const overDay = u.dayBytes + bytes > this.limits.dayBytes;
    if (overWindow || overDay) {
      u.blockedUntil = Math.max(overWindow ? u.win + this.limits.windowMs : 0, overDay ? u.day + this.limits.dayMs : 0);
      this.unsaved = SAVE_EVERY;
      await this.saveUsage();
      return Math.ceil((u.blockedUntil - now) / 1000);
    }
    u.winBytes += bytes;
    u.dayBytes += bytes;
    this.unsaved += bytes;
    if (this.unsaved >= SAVE_EVERY) await this.saveUsage();
    return null;
  }

  /** The usage, written down (so a room evicted from memory keeps its day's count), if anything changed. */
  private async saveUsage() {
    if (!this.usage || this.unsaved === 0) return;
    this.unsaved = 0;
    await this.ctx.storage.put("usage", this.usage);
  }

  /** Over budget: every phone is let go with when to try again, and the Mac is told (once); it stays signed in. */
  private overQuota(retryIn: number) {
    for (const phone of this.phones()) this.kick(phone, "over_quota", { retryIn });
    const mac = this.authedMac();
    if (mac && this.toldMac !== this.usage?.blockedUntil) {
      this.toldMac = this.usage?.blockedUntil ?? 0;
      mac.send(JSON.stringify({ type: "error", code: "over_quota", retryIn }));
    }
  }

  // ── The Mac ───────────────────────────────────────────────────────────────

  /**
   * The Mac's answer to the challenge: its public key, which must be the one the room is named after,
   * and its signature over the context, the room id and the nonce. With requirePass on, its pass too
   * (the one in `auth`, else a good one from the upgrade): good for this room, not revoked, and its
   * account under its rooms' cap; else it's refused, and the Mac signed in before stays. A Mac that
   * signs in replaces one signed in before (the same Mac reconnecting): that one and its phones are
   * let go.
   */
  private async signIn(ws: WebSocket, t: MacTag, message: string | ArrayBuffer) {
    const m = parse(message);
    if (m?.type !== "auth" || typeof m.key !== "string" || typeof m.sig !== "string") return refuse(ws, "bad_message");
    const key = unbase64(m.key);
    const sig = unbase64(m.sig);
    if (key?.length !== 32 || sig?.length !== 64 || (await roomOf(key)) !== t.room) return refuse(ws, "unauthorized");
    const signed = concat(new TextEncoder().encode(`${AUTH_CONTEXT}\0${t.room}\0`), unbase64(t.nonce)!);
    const verifier = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
    if (!(await crypto.subtle.verify({ name: "Ed25519" }, verifier, sig, signed))) return refuse(ws, "unauthorized");
    // Its relay pass: the one in auth, else the upgrade's (a Mac from before the pass shows none: missing).
    const shown = m.pass !== undefined && m.pass !== null && m.pass !== "";
    const pass: PassFields = shown ? passFields(await checkPass(this.env, m.pass, this.passFor(t.room))) : t.early ? heldPass(t) : passFields({ status: "missing" });
    if (this.limits.requirePass) {
      const now = Date.now();
      let status: PassStatus = passNow({ ...t, ...pass }, now);
      if (status === "valid" && pass.passSub && typeof pass.passIat === "number") status = await this.revokedStatus(pass.passSub, t.room, pass.passIat, now);
      if (status === "valid" && pass.passSub !== t.early) {
        // Counted against its account's rooms here (the Worker counted one shown in the upgrade).
        const ok = await admitted(this.env, `sub:${pass.passSub}`, t.room, this.limits.roomsPerAccount, this.limits.roomsPerAccountMs);
        if (ok === "error") return refuse(ws, "rate_limited");
        if (!ok) return refuse(ws, "too_many_rooms");
      }
      if (status !== "valid") {
        // A Mac from before this refusal hears `revoked` only as a phone's: it asks for a new pass then.
        if (status === "revoked") send(ws, { type: "phone_refused", code: "plan_required", pass: "revoked" });
        await this.macRefused(now);
        return refuse(ws, "plan_required", { pass: status });
      }
    }
    // Gone meanwhile (the checks above wait on the network).
    if (ws.readyState !== WebSocket.OPEN) return;
    for (const other of this.macs()) {
      if (other === ws) continue;
      // Not signed in any more, so its close (which comes later) takes nothing with it.
      tag(other, { ...(tagOf(other) as MacTag), authed: false });
      refuse(other, "replaced");
    }
    for (const phone of this.phones()) refuse(phone, "mac_gone");
    tag(ws, { ...t, authed: true, seen: Date.now(), ...pass });
    this.toldMac = 0;
    if (this.limits.requirePass) await this.ctx.storage.delete("macRefused");
    // `pairing`: this relay takes a pairing QR code's way in (an older one says nothing, and the Mac registers none).
    // `pass`: what came of its relay pass; `passRequired`: whether phones need one to join now.
    ws.send(JSON.stringify({ type: "ready", pairing: true, ...passAnswer(pass), passRequired: this.limits.requirePass }));
  }

  /**
   * A Mac turned away for its pass, noted (at most every few minutes): a phone joining while no Mac is
   * in hears plan_required, not mac_offline, for a day or until a Mac signs in (a Mac with no plan
   * waits for a pass before it dials again).
   */
  private async macRefused(now: number) {
    const was = (await this.ctx.storage.get<number>("macRefused")) ?? 0;
    if (now - was >= 5 * 60_000) await this.ctx.storage.put("macRefused", now);
  }

  /** The list's say on a good pass: still valid, revoked, or unverified (the list not answering: fails closed). */
  private async revokedStatus(sub: string, room: string, iat: number, now: number): Promise<PassStatus> {
    const r = await this.revokedList.check(sub, room, iat, now);
    return r === "clear" ? "valid" : r === "revoked" ? "revoked" : "unverified";
  }

  /**
   * From a signed-in Mac: the credentials its phones may join with (their hashes), a phone to let go,
   * or a frame for one: 4 bytes of the phone's channel (big-endian), then the frame as it goes.
   */
  private async fromMac(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") {
      if (message.byteLength < 4) return;
      const retryIn = await this.spend(message.byteLength);
      if (retryIn !== null) return this.overQuota(retryIn);
      const channel = new DataView(message).getUint32(0);
      this.phoneOn(channel)?.send(message.slice(4));
      return;
    }
    const m = parse(message);
    if (m?.type === "phones" && Array.isArray(m.credentials)) {
      const credentials = m.credentials.filter((c: unknown): c is string => typeof c === "string" && /^[0-9a-f]{64}$/.test(c)).slice(0, MAX_CREDENTIALS);
      await this.ctx.storage.put("credentials", credentials);
      // A phone the Mac forgot goes at once (not one in on the pairing code: the Mac lets it go itself).
      for (const phone of this.phones()) {
        const p = tagOf(phone) as PhoneTag;
        if (p.credential && !p.pairing && !credentials.includes(p.credential)) refuse(phone, "unauthorized");
      }
    } else if (m?.type === "pairing") {
      await this.pairingFromMac(m);
    } else if (m?.type === "pass") {
      await this.passFromMac(ws, m.pass);
    } else if (m?.type === "close" && Number.isInteger(m.channel)) {
      const phone = this.phoneOn(m.channel);
      // A pairing channel refused for its QR code (used already, or expired): the phone hears which.
      if (phone && (m.code === "qr_used" || m.code === "qr_expired")) this.kick(phone, m.code);
      else phone?.close(1000, "closed by the Mac");
    } else if (m?.type !== "pong") {
      ws.send(JSON.stringify({ type: "error", code: "bad_message" }));
    }
  }

  /**
   * The pairing QR code's way in: `{ credential: <hash>, ttl: <seconds> }` opens it (for one phone,
   * and no longer than pairingMs from when this hash was first registered), `{ credential: null }`
   * shuts it (`used: true`: the code paired a phone). Only one at a time: a new hash replaces it.
   */
  private async pairingFromMac(m: any) {
    const now = Date.now();
    const was = (await this.ctx.storage.get<Pairing>("pairing")) ?? null;
    if (m.credential === null) {
      if (was) await this.ctx.storage.put("pairing", { ...was, state: m.used === true ? "used" : "shut" } satisfies Pairing);
      return;
    }
    if (typeof m.credential !== "string" || !/^[0-9a-f]{64}$/.test(m.credential) || !Number.isFinite(m.ttl) || m.ttl <= 0) return;
    const until = now + Math.min(m.ttl * 1000, this.limits.pairingMs);
    // The same code again (its phone didn't pair): open once more, within the life it had and the joins it has left.
    const same = was?.hash === m.credential ? was : null;
    await this.ctx.storage.put("pairing", { hash: m.credential, until: same ? Math.min(same.until, until) : until, state: "open", joins: same?.joins ?? 0 } satisfies Pairing);
  }

  /**
   * A pass shown on an open socket (the Mac renewed it): it replaces the one held if it's good, else
   * the one held stays (a good one isn't lost to a bad renewal). Answered with what came of it.
   */
  private async passFromMac(ws: WebSocket, given: unknown) {
    const was = tagOf(ws);
    if (was?.role !== "mac" || !was.authed) return;
    const pass = passFields(await checkPass(this.env, given, this.passFor(was.room)));
    const t = tagOf(ws);
    if (t?.role !== "mac" || !t.authed) return;
    if (pass.pass === "valid") tag(ws, { ...t, ...pass });
    ws.send(JSON.stringify({ type: "pass", ...passAnswer(pass), passRequired: this.limits.requirePass }));
  }

  /**
   * How a pass is checked here: for this room, and only one naming it (a pass without `room` is
   * invalid, whether requirePass is on or off: L10 of the 2026-11-19 review); no longer-lived than
   * passMaxLifeMs.
   */
  private passFor(room: string) {
    return { room, requireRoom: true, maxLifeMs: this.limits.passMaxLifeMs };
  }

  /**
   * The Mac's pass at join: as passNow says, and with requirePass on, a good one looked up on the
   * revocation list (one bulk KV get, kept about a minute): issued before an entry for its account,
   * or its account on this room, it's revoked; the list not answering (and nothing read lately),
   * unverified. Off, the list isn't read (nobody would be refused).
   */
  private async passAtJoin(t: MacTag, now: number): Promise<PassStatus> {
    const pass = passNow(t, now);
    if (pass !== "valid" || !this.limits.requirePass) return pass;
    // A pass from before the revocation list (no sub or iat kept): the Mac shows a new one within the day.
    if (!t.passSub || typeof t.passIat !== "number") return pass;
    return this.revokedStatus(t.passSub, t.room, t.passIat, now);
  }

  // ── Phones ────────────────────────────────────────────────────────────────

  /**
   * A phone's first message: the credential its Mac gave it at pairing. Checked against the hashes
   * the Mac registered, then the Mac's relay pass, then the Mac is told of the new channel.
   */
  private async join(ws: WebSocket, t: PhoneTag, message: string | ArrayBuffer) {
    const m = parse(message);
    if (m?.type !== "join" || typeof m.credential !== "string") return refuse(ws, "bad_message");
    const raw = unbase64(m.credential);
    if (raw?.length !== 32) return refuse(ws, "unauthorized");
    const hash = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)));
    const known = (await this.ctx.storage.get<string[]>("credentials")) ?? [];
    // Not one of the Mac's phones: maybe the pairing QR code's, for one phone while the code works.
    let pairing: Pairing | null = null;
    if (!known.includes(hash)) {
      pairing = (await this.ctx.storage.get<Pairing>("pairing")) ?? null;
      if (pairing?.hash !== hash) return refuse(ws, "unauthorized");
      if (Date.now() >= pairing.until || pairing.state === "shut" || pairing.joins >= this.limits.pairingJoins) return refuse(ws, "qr_expired");
      if (pairing.state === "used") return refuse(ws, "qr_used");
    }
    // A Mac (or phones) gone half-open is let go first: the phone isn't told the Mac is there when it isn't.
    await this.sweep();
    const mac = this.authedMac();
    if (!mac) {
      // Its Mac was turned away for its plan lately: the phone hears that, not that the Mac is off.
      if (this.limits.requirePass && Date.now() - ((await this.ctx.storage.get<number>("macRefused")) ?? 0) < DAY) return refuse(ws, "plan_required");
      return refuse(ws, "mac_offline");
    }
    // The relay pass: checked here, at join (a phone in already stays when the pass runs out; a
    // revocation lets it go: sweep).
    const pass = await this.passAtJoin(tagOf(mac) as MacTag, Date.now());
    // The Mac gone while the list was read.
    if (mac.readyState !== WebSocket.OPEN || !(tagOf(mac) as MacTag).authed) return refuse(ws, "mac_offline");
    if (pass !== "valid") {
      if (this.limits.requirePass) {
        // The Mac hears it too, so it can say so (an older Mac ignores a message it doesn't know).
        mac.send(JSON.stringify({ type: "phone_refused", code: "plan_required", pass, ...(pairing ? { pairing: true } : {}) }));
        return refuse(ws, "plan_required");
      }
      // Off: let in as ever, and only noted (nothing identifying: not the room, not the address).
      console.log(`kiko-relay: a phone joined without a good pass (${pass}); requirePass is off`);
    }
    if (this.phones().length >= MAX_PHONES) return refuse(ws, "too_many");
    const now = Date.now();
    const u = await this.loadUsage(now);
    if (now < u.blockedUntil) return refuse(ws, "over_quota", { retryIn: Math.ceil((u.blockedUntil - now) / 1000) });
    // The pairing code lets this one phone in: spent until the Mac opens it again.
    if (pairing) await this.ctx.storage.put("pairing", { ...pairing, state: "used", joins: pairing.joins + 1 } satisfies Pairing);
    const channel = ((await this.ctx.storage.get<number>("channel")) ?? 0) + 1;
    await this.ctx.storage.put("channel", channel);
    tag(ws, { ...t, channel, credential: hash, ...(pairing ? { pairing: true } : {}), seen: now });
    ws.send(JSON.stringify({ type: "joined" }));
    mac.send(JSON.stringify({ type: "open", channel, ...(pairing ? { pairing: true } : {}) }));
    // The room has a phone in it now: the alarm watches for it going half-open.
    await this.alarmBy(now + this.limits.idleMs);
  }

  /** A joined phone's frame, to the Mac behind its channel. Text after joining is only ping. */
  private async fromPhone(ws: WebSocket, t: PhoneTag, message: string | ArrayBuffer) {
    if (typeof message === "string") return;
    const mac = this.authedMac();
    if (!mac) return;
    const retryIn = await this.spend(message.byteLength);
    if (retryIn !== null) {
      return this.overQuota(retryIn);
    }
    const out = new Uint8Array(4 + message.byteLength);
    new DataView(out.buffer).setUint32(0, t.channel!);
    out.set(new Uint8Array(message), 4);
    mac.send(out);
  }

  /** Out of the room (without waiting for its close to come back), then told why and closed. */
  private kick(ws: WebSocket, why: CloseWhy, more: Record<string, unknown> = {}) {
    this.leave(ws);
    refuse(ws, why, more);
  }

  /** A socket closed: it leaves the room, and its end is closed too. */
  private gone(ws: WebSocket, code: number) {
    this.leave(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {
      // Already closed.
    }
  }

  /**
   * A socket leaves the room, once (marked out first, so its close event, coming after a sweep let it
   * go, finds nothing more to do): a Mac takes its phones with it; a phone's Mac is told.
   */
  private leave(ws: WebSocket) {
    const t = tagOf(ws);
    this.live.delete(ws);
    if (!t) return;
    if (t.role === "mac" && t.authed) {
      tag(ws, { ...t, authed: false });
      if (this.macs().some((x) => x !== ws && (tagOf(x) as MacTag).authed)) return;
      for (const phone of this.phones()) refuse(phone, "mac_gone");
    } else if (t.role === "phone" && t.channel !== null) {
      tag(ws, { ...t, channel: null });
      const mac = this.macs().find((x) => x !== ws && (tagOf(x) as MacTag).authed);
      mac?.send(JSON.stringify({ type: "closed", channel: t.channel }));
    }
  }

  private macs() {
    return this.ctx.getWebSockets("mac").filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  private authedMac() {
    return this.macs().find((x) => (tagOf(x) as MacTag).authed);
  }

  /** The phones that have joined (open, with a channel). */
  private phones() {
    return this.ctx.getWebSockets("phone").filter((ws) => ws.readyState === WebSocket.OPEN && (tagOf(ws) as PhoneTag | null)?.channel != null);
  }

  private phoneOn(channel: number) {
    return this.phones().find((ws) => (tagOf(ws) as PhoneTag).channel === channel);
  }
}

/** Whether the socket is in the room: the Mac signed in, or a phone joined. */
function signedIn(t: Tag | null) {
  return !!t && (t.role === "mac" ? t.authed : t.channel !== null);
}

/** A checked pass, as the Mac's tag keeps it. */
type PassFields = Pick<MacTag, "pass" | "passExp" | "passSub" | "passIat">;
function passFields(p: PassCheck): PassFields {
  return p.status === "valid" ? { pass: p.status, passExp: p.exp, passSub: p.sub, passIat: p.iat } : { pass: p.status, passExp: undefined, passSub: undefined, passIat: undefined };
}

/** The pass a socket's tag holds (the upgrade's, for a Mac that showed one there). */
function heldPass(t: MacTag): PassFields {
  return { pass: t.pass, passExp: t.passExp, passSub: t.passSub, passIat: t.passIat };
}

/** A checked pass, as the Mac is told (`ready`, `pass`): its status, and until when while it's good. */
function passAnswer(p: PassFields) {
  return { pass: p.pass ?? "missing", ...(p.pass === "valid" ? { passExpiresAt: p.passExp } : {}) };
}

/** The account of the good pass a waiting Mac showed in its upgrade, if it did. */
function earlyOf(t: Tag | null) {
  return t?.role === "mac" ? t.early : undefined;
}

/** A short hash of the address (addressOf), for the per-address limits in a room: the address itself is never kept. */
async function addressTag(ip: string | null) {
  const bytes = new TextEncoder().encode(`kiko relay address\0${addressOf(ip)}`);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).slice(0, 8));
}

/** A message, if the socket is still there. */
function send(ws: WebSocket, m: Record<string, unknown>) {
  try {
    ws.send(JSON.stringify(m));
  } catch {
    // Already closed.
  }
}

/** The Mac's pass at `now`: "valid" while one it showed is good, else why not (unverified: it couldn't be checked). */
function passNow(t: MacTag, now: number): PassStatus {
  if (t.pass === "valid") return (t.passExp ?? 0) > now ? "valid" : "expired";
  return t.pass === "invalid" || t.pass === "expired" || t.pass === "unverified" || t.pass === "revoked" ? t.pass : "missing";
}

/** Says why (an error frame, with anything more to say: over_quota's retryIn), then closes with the code for it. */
function refuse(ws: WebSocket, why: CloseWhy, more: Record<string, unknown> = {}) {
  try {
    ws.send(JSON.stringify({ type: "error", code: why, ...more }));
    ws.close(CLOSE[why], why);
  } catch {
    // Already closed.
  }
}

function tag(ws: WebSocket, t: Tag) {
  try {
    ws.serializeAttachment(t);
  } catch {
    // A socket already gone keeps what it had.
  }
}

function tagOf(ws: WebSocket): Tag | null {
  return (ws.deserializeAttachment() as Tag | null) ?? null;
}

function parse(message: string | ArrayBuffer): any {
  if (typeof message !== "string") return null;
  try {
    return JSON.parse(message);
  } catch {
    return null;
  }
}

async function roomOf(key: Uint8Array) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", key)).slice(0, 16));
}

function hex(bytes: Uint8Array) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

/** Standard base64 with padding, or null for anything else. */
function unbase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function concat(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
