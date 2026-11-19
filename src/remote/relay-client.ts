// The Mac's end of the relay (relay/ in this repo; protocol/README.md, "Relay"): how a phone away from
// home reaches the phone server with nothing to set up. On only while Settings → Phone is on and
// KIKO_RELAY_URL names a relay (no default yet: wss://relay.kiko.sh is deployed, and becomes the default with phase 2).
//
// The Mac connects out to its room on the relay (named after its signing key: relay-identity.ts) and
// signs the room's challenge to open it. It registers its phones' relay credentials there (only their
// hashes), again whenever one is set up or forgotten. Each phone that joins the room is a channel:
// its first frame is the tunnel's handshake (tunnel.ts, Noise IK), which names the phone by its
// static key; one the Mac doesn't know is let go. After that the channel is a socket like the `ws`
// package's (TunnelSocket), handed to the phone server (adopt), so everything the server does
// (hello and its token, missed, Opus, presence) works through it unchanged. Every frame either way
// is sealed: the relay sees only how big they are and when they go.
//
// The relay's socket is watched, so the Mac never sits "connected" on a socket nothing gets through
// (2026-11-13; before, a ping every 25 s whose pong was only looked for at the next one: a VPN
// turned on left the Mac unreachable for 75 s, on a socket dialled while the VPN was coming up):
// - a ping every 10 s (the room answers without waking up, and counts none against its limits),
//   whose pong must come within 5 s: a dead socket is noticed within 15 s (25 s in all while frames
//   are still waiting to go, the ping behind them: a slow uplink in the middle of a reply's audio);
// - as the Mac's network changes or the Mac wakes (network-watch.ts: once the change has settled,
//   and once more a few seconds later), a ping at once whose pong must come within 3 s (`check`);
// - a dial that hasn't signed in within 15 s is given up (a connect on a dead route hangs for over
//   a minute otherwise); one in the air for more than 3 s as the network changes is made again.
// A socket dropped for no pong is dialled again at once; one that goes any other way, or a dial that
// fails, with a growing wait as before (cut short by a network change), so a relay that's down is
// never hammered. Its phones are let go meanwhile (they dial again too). Logged: relay_checked (`why`:
// "network changed" or "wake"; `result`: "pong" with `pongMs`, "no pong", or what became of a dial:
// "dialled", "dialling", "dial stuck"), and relay_disconnected's `why` ("no pong", "network changed",
// "wake", "dial timed out", or the close's code).
//
// Pairing by the QR code from away (protocol/README.md, "Pairing through the relay"): while a code is
// up, and only with a relay that says it takes it (`ready` with `pairing`), the Mac registers a
// one-time credential drawn from the code's secret with its room (its hash: Pairing.qrRelay), and
// drops it as the code stops working. A phone that joins with it comes on a channel marked
// `pairing`, whose first frame is the qr opening exactly as at home (local.ts): CPace with the
// secret, the code named by its id. A code used already or expired is said with the channel's close
// (qr_used, qr_expired), which the relay passes on. Once open, the tunnel is the server's as any, for
// `pair` (and then relay_pair, so the phone is set up for the relay on the same connection). One
// that ends without pairing while the code still works opens the way in again (the relay lets in one
// phone per registration).
//
// The relay pass (protocol/README.md, Relay, "The pass"): while the plan includes the phone (Kiko Pro
// or the free trial, core/account/phone-plan.ts), the Mac shows its room's relay a pass the account
// server signed: in `auth` as it signs in, and `{"type":"pass","pass":"<jws>"}` on the open socket
// whenever it's renewed (setPass). The relay says what came of it (`ready`'s and `pass`'s `pass`
// status), logged. With none, nothing is sent; a relay with its pass check on then refuses the
// room's phones (`plan_required`, 4014) and tells the Mac (`phone_refused`, with its pass's status),
// which the app says once a day. `revoked`: the pass was issued before its access ended (a sign-out,
// a ban, a plan's end, on the relay's revocation list): the app asks for a new one (app/phone.ts).
// Since 2026-11-19 the pass also goes in the upgrade's Kiko-Relay-Pass header, so the room lets this
// Mac in ahead of strangers waiting there (relay/src/index.ts), and the first dial waits a few seconds
// for the pass (`passFirstMs`). A relay with requirePass on refuses the sign-in itself without a good
// pass (`error` plan_required before `ready`, 4014): the Mac then waits for a new pass before it dials
// again (or PLAN_RETRY_MS), instead of dialling every minute for nothing.
//
// The relay isn't trusted with more than it has to be (L6 of the 2026-11-19 review): it can't read or
// forge the tunnel, but it says when a phone joins and when one was refused. So: at most MAX_CHANNELS
// channels at once and new ones at OPEN_RATE (more are closed at once, each a handshake's work), a
// `phone_refused` is heard only on a signed-in socket and acted on once a minute per pass status (the
// app's reaction is a line said once a day and a new pass asked for), and the lines a relay can make
// the Mac log are capped per minute.
import { WebSocket, type RawData } from "ws";
import { type Clock, unrefClock } from "../core/clock.ts";
import { log } from "../core/log.ts";
import { online } from "../core/online.ts";
import { CPACE_CI, cpaceRespond, sessionOf } from "./cpace.ts";
import type { LocalWay } from "./local.ts";
import { NetworkWatch, type NetworkWatchOptions, type NetworkWhy } from "./network-watch.ts";
import type { Pairing, QrRefusal } from "./pairing.ts";
import type { RelayIdentity } from "./relay-identity.ts";
import type { PhoneSocket } from "./server.ts";
import { TunnelSocket, type TunnelLink } from "./tunnel-socket.ts";

export { TunnelSocket };
import { authMessage, ed25519Sign, LOCAL_OPEN, openRecord, prologueOf, respond, sealRecord, TUNNEL_VERSION, TunnelError, type RecordType, type Session } from "./tunnel.ts";
import { NAME } from "../core/name.ts";

/** The wait before dialling the relay again: doubling from the first, up to the last, give or take a fifth. */
const RETRY_MS = { min: 1_000, max: 60_000 };
/**
 * How often the relay's socket is pinged, and how long its pong may take: a dead socket is noticed
 * within their sum, 15 s. (25 s and "by the next ping" until 2026-11-13: up to 50 s, and 75 s in the
 * log, on a socket made as a VPN came up.) Well inside the relay's 90 s for a quiet socket
 * (relay/src/limits.ts idleMs); the room answers pings without waking, and counts none against its
 * rate limit (protocol/README.md, Relay, "Limits").
 */
const PING_MS = 10_000;
const PONG_MS = 5_000;
/** How long the pong may take when the network just changed or the Mac woke (`check`). */
const CHECK_MS = 3_000;
/**
 * With frames still waiting to go (a reply's audio to a phone, up to the server's 1 MiB, on a slow
 * uplink) the ping is behind them, not lost: its pong is waited for this long in all, the old
 * allowance, so a slow link that works isn't cut in the middle of a reply.
 */
const BACKLOG_MS = 25_000;
/**
 * A dial has this long to sign in (the relay gives a socket 10 s of it, signInMs). Without it, a
 * connect sent down a route that's gone waits for the system to give up, over a minute.
 */
const DIAL_MS = 15_000;
/** A phone has this long, from joining, to finish the tunnel's handshake. */
const HANDSHAKE_MS = 10_000;
/** The header the upgrade shows the relay pass in (relay/src/pass.ts PASS_HEADER). */
export const PASS_HEADER = "Kiko-Relay-Pass";
/** Channels open at once: the relay's 10 phones in a room, and one more for a pairing. */
export const MAX_CHANNELS = 11;
/** New channels the relay may open (a token bucket): a burst for every phone coming back at once, then one a second. */
const OPEN_RATE = { perSecond: 1, burst: 20 };
/**
 * Refused at sign-in for the plan: the next dial waits for a new pass, or this long (a pass that
 * couldn't be checked, unverified: the usual wait). With no pass at all, longer: nothing will change
 * until the plan does, and a pass then dials at once.
 */
export const PLAN_RETRY_MS = { pass: 10 * 60_000, none: 60 * 60_000 };
/** A `phone_refused`, by its pass status, acted on at most this often. */
const REFUSED_EVERY_MS = 60_000;
/** Lines the relay can make this Mac log (refusals), per event per minute; the rest counted. */
const LOG_EVERY = { lines: 20, ms: 60_000 };

/** What the client uses of the relay's socket (the `ws` package's): a test gives one of its own. */
export type RelayWire = {
  readyState: number;
  bufferedAmount: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message", listener: (data: RawData, binary: boolean) => void): unknown;
  on(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
};

const connect = (url: string, headers?: Record<string, string>): RelayWire => new WebSocket(url, { maxPayload: 2 * 1024 * 1024, ...(headers ? { headers } : {}) });

/** Why the Mac itself let the relay's socket go (relay_disconnected's `why`). */
type Drop = NetworkWhy | "no pong" | "dial timed out";

type RelayClientOptions = {
  /** The relay, e.g. wss://relay.example.com (KIKO_RELAY_URL). */
  url: string;
  identity: RelayIdentity;
  pairing: Pairing;
  /**
   * Where each phone's tunnel goes once it's open: the phone server. `phoneId`, the paired phone its
   * key named; null for a pairing by the QR code, whose `way` says which code.
   */
  server: { adopt(socket: PhoneSocket, phoneId: string | null, way?: LocalWay): void };
  /**
   * A phone the relay turned away for the room's plan (its `phone_refused`, with the pass's status):
   * for the Mac's line. `macRefused`: the Mac itself was, at sign-in (no phone tried: nothing to say,
   * but a revoked pass is asked for again all the same).
   */
  planRefused?: (pass: string | null, o?: { macRefused?: boolean }) => void;
  /** Wait this long for the pass (setPass) before the first dial (the app's, while Pro is on sale): it goes in the upgrade. */
  passFirstMs?: number;
  /** Shorter waits for tests. */
  retryMs?: { min: number; max: number };
  pingMs?: number;
  pongMs?: number;
  checkMs?: number;
  backlogMs?: number;
  dialMs?: number;
  handshakeMs?: number;
  /** For tests: time moved by hand, and a socket that isn't one. */
  clock?: Clock;
  connect?: (url: string, headers?: Record<string, string>) => RelayWire;
  /** The watch on the Mac's network (network-watch.ts): its options, for tests; false for none (`check` is then the test's to call). */
  network?: NetworkWatchOptions | false;
};

type RelayStatus = "off" | "connecting" | "connected";

export class RelayClient {
  private o: RelayClientOptions;
  private clock: Clock;
  private ws: RelayWire | null = null;
  private channels = new Map<number, Channel>();
  private stopped = true;
  private attempts = 0;
  private retry: unknown = null;
  private watch: NetworkWatch | null = null;
  /** When the socket was dialled, and what gives up on it if it hasn't signed in by then. */
  private dialledAt = 0;
  private dialTimer: unknown = null;
  /** The next ping's timer. */
  private beat: unknown = null;
  /** Pings sent and not answered yet (pongs come in the order of their pings). */
  private owed = 0;
  /** The last ping's pong, waited for: since when, what drops the socket if it doesn't come, and the check it's for (null: the regular ping). */
  private waiting: { timer: unknown; since: number; check: NetworkWhy | null } | null = null;
  private connectedAt = 0;
  /** This relay takes a QR code's way in (its `ready` said `pairing`): an older one doesn't, and is sent none. */
  takesPairing = false;
  /** The QR code's credential hash registered on this connection, if any. */
  private qrSent: string | null = null;
  /** The relay pass to show the room (null: none, the plan doesn't include the phone), and the one shown on this connection. */
  private pass: string | null = null;
  private passSent: string | null = null;
  /** Whether setPass was called yet (the first dial waits for it, passFirstMs). */
  private passGiven = false;
  /**
   * Why no dial is made now but the retry's: the first pass (passFirstMs), or a new one after the
   * relay refused the sign-in for the plan (`refused`: the pass it refused; null: none was held).
   */
  private holding: { for: "first-pass" } | { for: "new-pass"; refused: string | null; code: string } | null = null;
  /** The sign-in on this socket refused for the plan (its error said so): what closed() waits on. */
  private refusedHere: { refused: string | null; code: string; pass: string | null } | null = null;
  /** Each `phone_refused` pass status, when it was last acted on. */
  private refusedSaid = new Map<string, number>();
  /** New channels' bucket. */
  private opens = { tokens: OPEN_RATE.burst, at: 0 };
  /** The refusal lines logged this minute, per event. */
  private logged = new Map<string, { since: number; lines: number; dropped: number }>();
  status: RelayStatus = "off";

  constructor(options: RelayClientOptions) {
    this.o = options;
    this.clock = options.clock ?? unrefClock;
  }

  get room() {
    return this.o.identity.room;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.o.pairing.onRelayChange = () => this.sync();
    this.o.pairing.onQrChange = () => this.syncQr();
    log("relay_on", { room: this.room, relay: hostOf(this.o.url) });
    if (this.o.network !== false) {
      this.watch = new NetworkWatch((why) => this.check(why), { clock: this.clock, ...this.o.network });
      this.watch.start();
    }
    // The pass goes in the upgrade: the first dial waits a little for it (none comes: dialled without).
    if (this.o.passFirstMs && !this.passGiven) {
      this.status = "connecting";
      this.holding = { for: "first-pass" };
      this.retry = this.clock.setTimeout(() => {
        this.retry = null;
        this.holding = null;
        this.dial();
      }, this.o.passFirstMs);
      return;
    }
    this.dial();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.o.pairing.onRelayChange) this.o.pairing.onRelayChange = null;
    if (this.o.pairing.onQrChange) this.o.pairing.onQrChange = null;
    this.watch?.stop();
    this.watch = null;
    this.clock.clearTimeout(this.retry);
    this.retry = null;
    this.holding = null;
    this.unwatched();
    this.dropAll();
    this.ws?.close(1000, `${NAME}'s relay client stopped`);
    this.ws = null;
    this.status = "off";
    log("relay_off", {});
    online.relayOff();
  }

  /** The phones' credentials (their hashes), to the room: as it opens, and as one is set up or forgotten. */
  sync() {
    if (this.status !== "connected") return;
    this.control({ type: "phones", credentials: this.o.pairing.relayCredentials() });
  }

  /**
   * The relay pass (null: none): shown to the room now if it's open and it's a new one, and again as
   * each connection opens. None is never sent: the relay goes by the last pass, until it runs out.
   */
  setPass(pass: string | null) {
    this.pass = pass;
    this.passGiven = true;
    // Waiting for it: the first pass (or word there's none), or a new one after a refusal: dialled now.
    const h = this.holding;
    if (!this.stopped && !this.ws && this.retry && h && (h.for === "first-pass" || (pass !== null && pass !== h.refused))) {
      this.clock.clearTimeout(this.retry);
      this.retry = null;
      this.holding = null;
      return this.dial();
    }
    this.sendPass();
  }

  private sendPass() {
    if (this.status !== "connected" || !this.pass || this.pass === this.passSent) return;
    this.passSent = this.pass;
    this.control({ type: "pass", pass: this.pass });
    log("relay_pass", { shown: true });
  }

  /**
   * The pairing QR code's way in, to the room: its credential's hash while a code works (for the time
   * it has left), dropped as it stops (`used` when it paired a phone). `again`: registered anew though
   * it was already (a pairing channel ended without pairing: the relay let in one phone for it).
   */
  syncQr(again = false) {
    if (this.status !== "connected" || !this.takesPairing) return;
    const open = this.o.pairing.qrRelay();
    if (open && (again || open.hash !== this.qrSent)) {
      const ttl = Math.ceil((open.until - Date.now()) / 1000);
      if (ttl <= 0) return;
      this.qrSent = open.hash;
      this.control({ type: "pairing", credential: open.hash, ttl });
      log("relay_pairing", { open: true, ttl, again });
    } else if (!open && this.qrSent) {
      const used = this.o.pairing.qrUsed(this.qrSent);
      this.qrSent = null;
      this.control({ type: "pairing", credential: null, ...(used ? { used: true } : {}) });
      log("relay_pairing", { open: false, used });
    }
  }

  private dial() {
    this.passSent = null;
    this.holding = null;
    this.refusedHere = null;
    if (this.stopped) return;
    this.status = "connecting";
    // The pass in the upgrade too: the room lets a Mac with a good one in ahead of strangers waiting there.
    const headers = this.pass ? { [PASS_HEADER]: this.pass } : undefined;
    const ws = (this.o.connect ?? connect)(`${this.o.url.replace(/\/+$/, "")}/v1/mac/${this.room}`, headers);
    this.ws = ws;
    this.dialledAt = this.clock.now();
    // Not signed in by then: given up, and dialled again after the usual wait.
    this.dialTimer = this.clock.setTimeout(() => this.drop(ws, "dial timed out", false), this.o.dialMs ?? DIAL_MS);
    ws.on("message", (data, binary) => {
      if (this.ws !== ws) return;
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (binary) this.frame(buf);
      else this.text(buf.toString());
    });
    ws.on("close", (code, reason) => this.closed(ws, code, reason.toString()));
    ws.on("error", (err) => {
      if (this.ws !== ws) return;
      log("relay_error", { message: err.message });
      // "getaddrinfo ENOTFOUND relay.kiko.sh": the Mac is offline, not only the relay (core/online.ts).
      online.relayError(err);
    });
  }

  /** The relay's own messages: its challenge, ready, a phone joining or leaving, a refusal. */
  private text(text: string) {
    if (text === "pong") return this.pong();
    let m: any;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    switch (m?.type) {
      case "challenge": {
        const nonce = Buffer.from(String(m.nonce), "base64");
        const sig = ed25519Sign(this.o.identity.signing.seed, authMessage(this.room, nonce));
        // The pass, if one is held, shown as it signs in.
        this.passSent = this.pass;
        return this.control({ type: "auth", key: this.o.identity.signing.public.toString("base64"), sig: sig.toString("base64"), ...(this.pass ? { pass: this.pass } : {}) });
      }
      case "ready":
        this.status = "connected";
        this.attempts = 0;
        this.connectedAt = this.clock.now();
        this.clock.clearTimeout(this.dialTimer);
        this.dialTimer = null;
        this.takesPairing = m.pairing === true;
        this.qrSent = null;
        log("relay_connected", { room: this.room, relay: hostOf(this.o.url), pairing: this.takesPairing, ...passOf(m) });
        online.relayConnected();
        // A pass that came while it signed in (none was in auth): shown now.
        this.sendPass();
        this.sync();
        this.syncQr();
        return this.pingNext();
      case "open":
        if (this.status !== "connected" || !Number.isInteger(m.channel) || m.channel < 0 || this.channels.has(m.channel)) return;
        // More than a room holds, or faster than phones come: closed at once (each is a handshake's work).
        if (this.channels.size >= MAX_CHANNELS || !this.takeOpen()) {
          this.logSome("relay_channel_refused", { why: this.channels.size >= MAX_CHANNELS ? "too_many" : "too_fast" });
          return this.control({ type: "close", channel: m.channel });
        }
        this.channels.set(m.channel, new Channel(this, m.channel, this.o, m.pairing === true));
        return;
      case "closed":
        return this.channels.get(m.channel)?.gone("phone_left");
      case "pass":
        return log("relay_pass_status", passOf(m));
      case "phone_refused": {
        // Only a signed-in room's (a sign-in refused says so in its error; before that, it's for older Macs).
        if (this.status !== "connected") return;
        const pass = typeof m.pass === "string" ? m.pass.slice(0, 20) : null;
        this.logSome("relay_phone_refused", { code: String(m.code).slice(0, 40), ...(pass ? { pass } : {}) });
        if (m.code === "plan_required") this.refusedForPlan(pass);
        return;
      }
      case "error": {
        const code = String(m.code).slice(0, 40);
        const pass = typeof m.pass === "string" ? m.pass.slice(0, 20) : null;
        this.logSome("relay_refused", { code, ...(pass ? { pass } : {}) });
        // The sign-in refused for the plan (relay/src/index.ts, requirePass): the next dial waits for a new pass.
        if (this.status !== "connected" && (code === "plan_required" || code === "too_many_rooms")) {
          this.refusedHere = { refused: this.passSent, code, pass };
          if (code === "plan_required") this.refusedForPlan(pass, true);
        }
        return;
      }
    }
  }

  /** The relay said the plan's missing (a phone refused, or this Mac's sign-in): told to the app, once a minute per pass status. */
  private refusedForPlan(pass: string | null, macRefused = false) {
    const now = this.clock.now();
    const key = `${macRefused ? "mac" : "phone"}:${pass}`;
    const last = this.refusedSaid.get(key);
    if (last !== undefined && now - last < REFUSED_EVERY_MS) return;
    this.refusedSaid.set(key, now);
    this.o.planRefused?.(pass, macRefused ? { macRefused: true } : undefined);
  }

  /** One more channel opened: false once the bucket is empty. */
  private takeOpen() {
    const now = this.clock.now();
    const b = this.opens;
    b.tokens = Math.min(OPEN_RATE.burst, b.tokens + ((now - b.at) / 1000) * OPEN_RATE.perSecond);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** A line the relay can cause (a refusal): at most LOG_EVERY.lines a minute per event, then counted and said once the minute's over. */
  logSome(event: string, fields: Record<string, unknown>) {
    const now = this.clock.now();
    let e = this.logged.get(event);
    if (!e || now - e.since >= LOG_EVERY.ms) {
      if (e?.dropped) log(event, { suppressed: e.dropped });
      e = { since: now, lines: 0, dropped: 0 };
      this.logged.set(event, e);
    }
    if (e.lines < LOG_EVERY.lines) {
      e.lines++;
      log(event, fields);
    } else e.dropped++;
  }

  /** A phone's frame: 4 bytes of its channel, then the frame. */
  private frame(buf: Buffer) {
    if (buf.length < 4) return;
    this.channels.get(buf.readUInt32BE(0))?.frame(buf.subarray(4));
  }

  /** A frame to a phone, behind its channel. */
  toPhone(channel: number, frame: Buffer) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const head = Buffer.alloc(4);
    head.writeUInt32BE(channel);
    this.ws.send(Buffer.concat([head, frame]));
  }

  /** What's waiting to go to the relay: the phone server holds audio back behind too much. */
  buffered() {
    return this.ws?.bufferedAmount ?? 0;
  }

  /** A channel let go of by the Mac: the relay closes the phone's socket (saying `code`, a QR code's refusal, when there is one). */
  letGo(channel: number, code?: QrRefusal) {
    this.channels.delete(channel);
    this.control({ type: "close", channel, ...(code ? { code } : {}) });
  }

  forgetChannel(channel: number) {
    this.channels.delete(channel);
  }

  private control(m: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  /**
   * The Mac's network changed, or the Mac woke (network-watch.ts, once it has settled and once more
   * after): is the relay still there? Connected, a ping whose pong must come within CHECK_MS, or the
   * socket is dropped and dialled again at once. Waiting to dial again, it's dialled now: what failed
   * may have been the network as it was. A dial in the air is left if it's young, and made again if
   * it's been CHECK_MS already (sent out on the network as it was, it could hang for a minute). So
   * however many changes come, each brings one ping or one dial at most: a check still waiting for
   * its pong, or a dial just made, takes the next change as its own.
   */
  check(why: NetworkWhy) {
    if (this.stopped) return;
    const ws = this.ws;
    if (!ws) {
      // Waiting for a new pass (the relay refused the plan): a network change changes nothing.
      if (!this.retry || this.holding?.for === "new-pass") return;
      this.clock.clearTimeout(this.retry);
      this.retry = null;
      log("relay_checked", { why, result: "dialled" });
      return this.dial();
    }
    if (this.status !== "connected") {
      const dialMs = this.clock.now() - this.dialledAt;
      if (dialMs < (this.o.checkMs ?? CHECK_MS)) return log("relay_checked", { why, result: "dialling", dialMs });
      log("relay_checked", { why, result: "dial stuck", dialMs });
      return this.drop(ws, why, true);
    }
    if (!this.waiting?.check) this.ping(why);
  }

  /** The next regular ping, PING_MS from now, and so on. One still waiting for its pong (a check's) is this one too. */
  private pingNext() {
    this.clock.clearTimeout(this.beat);
    this.beat = this.clock.setTimeout(() => {
      if (!this.waiting) this.ping(null);
      this.pingNext();
    }, this.o.pingMs ?? PING_MS);
  }

  /** A ping, whose pong must come within PONG_MS (a check's: CHECK_MS), or the socket is dropped and dialled again. */
  private ping(check: NetworkWhy | null) {
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) return;
    this.clock.clearTimeout(this.waiting?.timer);
    this.owed++;
    this.waiting = { timer: this.clock.setTimeout(() => this.noPong(ws), this.pongWait(check)), since: this.clock.now(), check };
    ws.send("ping");
  }

  private pongWait(check: NetworkWhy | null) {
    return check ? (this.o.checkMs ?? CHECK_MS) : (this.o.pongMs ?? PONG_MS);
  }

  /**
   * The relay's pong. Only the last ping's counts: one sent before a check's says nothing of the
   * network since. It isn't passed to core/online.ts as a sign the network's back: "back" there sends
   * kept words again, and with the models unreachable but the relay not, every pong would. What it
   * gets is the socket's end, sooner than before (closed: relayDisconnected).
   */
  private pong() {
    if (this.owed > 0) this.owed--;
    const w = this.waiting;
    if (!w || this.owed > 0) return;
    this.clock.clearTimeout(w.timer);
    this.waiting = null;
    if (w.check) log("relay_checked", { why: w.check, result: "pong", pongMs: this.clock.now() - w.since });
  }

  /** The pong didn't come in time: the socket is half-open (the network changed under it, the relay's gone). Dropped, and dialled again at once. */
  private noPong(ws: RelayWire) {
    const w = this.waiting;
    if (this.ws !== ws || !w) return;
    const waitedMs = this.clock.now() - w.since;
    // Frames still waiting to go: the ping is behind them (BACKLOG_MS). Looked at again.
    if (ws.bufferedAmount > 0 && waitedMs < (this.o.backlogMs ?? BACKLOG_MS)) return void (w.timer = this.clock.setTimeout(() => this.noPong(ws), this.pongWait(w.check)));
    if (w.check) log("relay_checked", { why: w.check, result: "no pong", waitedMs });
    this.drop(ws, w.check ?? "no pong", true);
  }

  /**
   * The Mac lets the socket go itself: over here and now (a half-open socket's own close can take as
   * long as it likes), then ended. `now`: dialled again at once.
   */
  private drop(ws: RelayWire, why: Drop, now: boolean) {
    if (this.ws !== ws) return;
    this.closed(ws, 1006, "", { why, now });
    ws.terminate();
  }

  /** The socket's timers: its regular ping, a pong waited for, its dial's time limit. */
  private unwatched() {
    for (const t of [this.beat, this.waiting?.timer, this.dialTimer]) this.clock.clearTimeout(t);
    this.beat = this.dialTimer = this.waiting = null;
    this.owed = 0;
  }

  /**
   * The socket is over: the relay closed it, it failed, or the Mac dropped it (`dropped`). Dialled
   * again after a wait that grows with each failure in a row; at once after a drop that says so (no
   * pong, the network changed), which counts as no failure: the dial it makes, failing, waits.
   */
  private closed(ws: RelayWire, code: number, reason: string, dropped?: { why: Drop; now: boolean }) {
    if (this.ws !== ws) return;
    this.ws = null;
    this.unwatched();
    const was = this.status;
    this.status = this.stopped ? "off" : "connecting";
    this.dropAll();
    if (this.stopped) return;
    log("relay_disconnected", { code, reason: reason.slice(0, 60), why: dropped?.why ?? String(code), ...(was === "connected" ? { connectedMs: this.clock.now() - this.connectedAt } : {}) });
    online.relayDisconnected();
    if (dropped?.now) return this.dial();
    // Refused for the plan at sign-in: dialled again with a new pass (setPass), or after a long wait.
    // A pass the relay couldn't check (unverified: its side) waits as any failure.
    const refused = this.refusedHere;
    this.refusedHere = null;
    if (refused && refused.pass !== "unverified") {
      this.holding = { for: "new-pass", refused: refused.refused, code: refused.code };
      const wait = refused.refused ? PLAN_RETRY_MS.pass : PLAN_RETRY_MS.none;
      log("relay_waiting_for_pass", { code: refused.code, ...(refused.pass ? { pass: refused.pass } : {}), waitMs: wait });
      this.retry = this.clock.setTimeout(() => {
        this.retry = null;
        this.holding = null;
        this.dial();
      }, wait);
      return;
    }
    const { min, max } = this.o.retryMs ?? RETRY_MS;
    const wait = Math.min(max, min * 2 ** this.attempts++) * (0.8 + Math.random() * 0.4);
    this.retry = this.clock.setTimeout(() => {
      this.retry = null;
      this.dial();
    }, wait);
  }

  private dropAll() {
    for (const ch of [...this.channels.values()]) ch.gone("relay_gone");
    this.channels.clear();
  }
}

/** One phone in the room: its handshake, then its tunnel. */
class Channel implements TunnelLink {
  private client: RelayClient;
  readonly id: number;
  private o: RelayClientOptions;
  /** It joined with the pairing QR code's credential: it opens with the qr way, to pair. */
  private pairing: boolean;
  private session: Session | null = null;
  private socket: TunnelSocket | null = null;
  private phoneId: string | null = null;
  /** The QR code it opened with, until the phone's first record confirms the secret (then the server's). */
  private qr: LocalWay | null = null;
  private timer: NodeJS.Timeout | null;
  private over = false;

  constructor(client: RelayClient, id: number, o: RelayClientOptions, pairing = false) {
    this.client = client;
    this.id = id;
    this.o = o;
    this.pairing = pairing;
    this.timer = setTimeout(() => this.refuse("handshake_timeout"), o.handshakeMs ?? HANDSHAKE_MS);
    this.timer.unref();
  }

  frame(frame: Buffer) {
    if (!this.session) return this.pairing ? this.qrOpening(frame) : this.handshake(frame);
    let record;
    try {
      record = openRecord(this.session.receive, frame);
    } catch (err) {
      // The phone's first record after the qr opening didn't open: not the code's secret.
      if (!this.socket) return this.refuse("bad_code");
      log("relay_tunnel_broken", { phoneId: this.phoneId, channel: this.id, why: err instanceof TunnelError ? err.code : "error" });
      return this.drop();
    }
    if (!this.socket) this.confirmed();
    const closed = this.socket!.received(record);
    if (closed) {
      log("relay_phone_closed", { phoneId: this.phoneId, channel: this.id, code: closed.code });
      this.client.letGo(this.id);
      this.socket!.ended(closed.code, closed.reason);
    }
  }

  /**
   * The phone's first frame: the tunnel's version, then Noise IK's first message. The key it names
   * must be a paired phone's (relay_pair); then the answer goes back and the tunnel is the server's.
   * A refusal is logged with why (relay_phone_refused): version, unknown_key (a key no paired phone
   * has), or handshake with the step that failed (tunnel.ts HandshakeStep; error: this Mac's own
   * crypto failed, with its code), never a key.
   */
  private handshake(frame: Buffer) {
    if (frame[0] !== TUNNEL_VERSION) return this.refuse("version", { version: frame[0] ?? null });
    const first = frame.subarray(1);
    let read;
    try {
      read = respond({ prologue: prologueOf(this.o.identity.room), local: this.o.identity.static, message: first });
    } catch (err) {
      return this.refuse("handshake", this.whyRefused(err));
    }
    const phone = this.o.pairing.byRelayKey(read.remote);
    if (!phone) return this.refuse("unknown_key");
    const { message, session } = read.answer();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.session = session;
    this.phoneId = phone.id;
    this.client.toPhone(this.id, message);
    this.socket = new TunnelSocket(this);
    log("relay_phone_connected", { phoneId: phone.id, channel: this.id });
    this.o.server.adopt(this.socket, phone.id);
  }

  /**
   * The first frame on a pairing channel: the qr opening, as at home (protocol/README.md, "Pairing
   * with a QR code"): 0x04, the code's id (16 bytes), the phone's CPace share (32). A code used already
   * or expired (or this Mac's restarted since) is said with the close; a share that isn't one, or any
   * other opening, just closes it. Our share goes back; the phone's first record confirms the secret.
   */
  private qrOpening(frame: Buffer) {
    if (frame[0] !== LOCAL_OPEN.qr || frame.length !== 49) return this.refuse("version", { opening: frame[0] ?? null });
    const id = Buffer.from(frame.subarray(1, 17));
    const open = this.o.pairing.qrFor(id);
    if (!open.ok) return this.refuse(open.code, {}, open.code);
    let made;
    try {
      made = cpaceRespond({ prs: open.secret, ci: CPACE_CI.qr, ada: id, theirs: frame.subarray(17) });
    } catch (err) {
      return this.refuse("handshake", this.whyRefused(err));
    }
    this.session = sessionOf(made.isk, "mac");
    this.qr = { mode: "qr", id };
    this.client.toPhone(this.id, made.share);
  }

  /** The phone's first record opened under the qr opening's keys: the same secret. The server's from here, for `pair`. */
  private confirmed() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.socket = new TunnelSocket(this);
    log("relay_phone_connected", { phoneId: null, channel: this.id, how: "qr" });
    this.o.server.adopt(this.socket, null, this.qr!);
  }

  /** A record to the phone. False when it couldn't go (too big for one: logged, not sent). */
  send(type: RecordType, body?: Buffer) {
    if (!this.session || (this.pairing && !this.socket)) return false;
    try {
      this.client.toPhone(this.id, sealRecord(this.session.send, type, body));
      return true;
    } catch (err) {
      log("error", { where: "relay_send", message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  buffered() {
    return this.client.buffered();
  }

  /** Why a handshake was refused, for the log: the step. */
  private whyRefused(err: unknown): Record<string, unknown> {
    if (!(err instanceof TunnelError)) {
      const code = (err as { code?: unknown })?.code;
      return { step: "error", error: typeof code === "string" ? code : err instanceof Error ? err.message.slice(0, 80) : "unknown" };
    }
    return { step: err.step ?? "unknown" };
  }

  /** Refused before the tunnel is the server's: logged with why (never a key or the code), and let go, saying a QR code's refusal (`said`). */
  private refuse(why: string, more: Record<string, unknown> = {}, said?: QrRefusal) {
    this.client.logSome("relay_phone_refused", { channel: this.id, why, ...(this.pairing ? { how: "qr" } : {}), ...more });
    this.drop(1006, "", said);
  }

  /** The Mac lets the phone go: the relay closes its socket. */
  drop(code = 1006, reason = "", said?: QrRefusal) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.client.letGo(this.id, said);
    this.socket?.ended(code, reason);
    this.ended();
  }

  /** The phone went (it left the room, or the relay went): its socket closes. */
  gone(why: string) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.client.forgetChannel(this.id);
    if (this.phoneId) log("relay_phone_disconnected", { phoneId: this.phoneId, channel: this.id, why });
    this.socket?.ended(1006, "");
    this.ended();
  }

  /** A pairing channel over, once: if its code still works (the phone didn't pair), the relay lets another phone in for it. */
  private ended() {
    if (this.over) return;
    this.over = true;
    if (this.pairing) this.client.syncQr(true);
  }
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
}

/** What the relay said of the pass shown (`ready`, `pass`): its status, until when, and whether it's required; for the log. */
function passOf(m: { pass?: unknown; passExpiresAt?: unknown; passRequired?: unknown }) {
  if (typeof m.pass !== "string") return {};
  return { pass: m.pass.slice(0, 20), ...(typeof m.passExpiresAt === "number" ? { passExpiresAt: m.passExpiresAt } : {}), passRequired: m.passRequired === true };
}
