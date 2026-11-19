// The phone's connection on the home network (or Tailscale), encrypted end to end as the relay's is
// (protocol/README.md, "Encrypted at home"). Each direct WebSocket opens with a handshake, and after
// it every frame either way is one sealed record (tunnel.ts), exactly as through the relay: the
// server gets a TunnelSocket (tunnel-socket.ts) and sees the same connection either way.
//
// The phone's first frame says how it opens the tunnel (tunnel.ts LOCAL_OPEN):
// - keys: Noise IK to this Mac's static key, as through the relay (the phone knows it from pairing),
//   with its own prologue. The Mac learns the phone's static key from it.
// - code: pairing, CPace (cpace.ts) with the code the Mac's settings show; the phone's `pair` and
//   everything after it go sealed under the keys that gives.
// - token: a phone paired before the connection was encrypted, which has its token but no keys: CPace
//   with its token's hash as the password, the phone named by an id drawn from that hash. Its hello
//   carries its new static key, and welcome the Mac's: from then on it opens with `keys`.
// - qr: pairing from the QR code (pair-link.ts): CPace with the code's one-time secret, the code named
//   by an id drawn from it, so one used already or expired is refused as such before any CPace.
// Each CPace way is confirmed by the phone's first record: one that doesn't open is a wrong code
// (counted, as `pair` with a wrong code was), a token the Mac doesn't have, or a QR secret that
// isn't the code's (not counted: 128 bits aren't guessed).
//
// Before the tunnel is open, a refusal can only go in the clear: a text frame, an `error` as the
// protocol has it, and the socket closes. None of them says anything secret, and the phone doesn't
// act on one beyond showing it (anyone on the network could send one): what changes its pairing
// (`unauthorized`) comes only inside the tunnel. An app from before this, which says hello or pair in
// the clear, is told to update (`version`) and nothing it sent is read.
import type { WebSocket } from "ws";
import { log } from "../core/log.ts";
import { CPACE_CI, cpaceRespond, sessionOf } from "./cpace.ts";
import type { Pairing } from "./pairing.ts";
import { TunnelSocket, type TunnelLink } from "./tunnel-socket.ts";
import { LOCAL_OPEN, LOCAL_PROLOGUE, openRecord, respond, sealRecord, TunnelError, type RecordType, type Session, type X25519Pair } from "./tunnel.ts";

/** A phone has this long, from connecting, to open the tunnel (the server's own hello timer starts after). */
const HANDSHAKE_MS = 10_000;

/** How the phone opened its tunnel: what the server lets in on it. */
export type LocalWay =
  /** Noise IK: `key` is the phone's static key; `phoneId` the paired phone with that key, null for none. */
  | { mode: "keys"; key: Buffer; phoneId: string | null }
  /** CPace with the pairing code: `pair` only. */
  | { mode: "code" }
  /** CPace with this phone's token: its hello only. */
  | { mode: "token"; phoneId: string }
  /** CPace with the QR code's secret: `pair` only, for that code (`id`). */
  | { mode: "qr"; id: Buffer };

/** The refusals said in the clear, before the tunnel is open. */
export type ClearRefusal = "version" | "pairing_closed" | "too_many_attempts" | "bad_code" | "stale_key" | "unknown_phone" | "qr_used" | "qr_expired";

type LocalOptions = {
  /** This Mac's static key: the IK handshake is to it. */
  identity: { static: X25519Pair };
  pairing: Pairing;
  /** Where the phone connected from, for the log. */
  address: string;
  /** The tunnel is open: the server takes it as a connection. */
  adopt(socket: TunnelSocket, way: LocalWay): void;
  /** What a refusal says (the server's words for its error codes). */
  message(code: ClearRefusal): string;
  /** Pairing closed after too many wrong codes: for the settings screen. */
  changed?(): void;
  handshakeMs?: number;
};

export class LocalLink implements TunnelLink {
  private ws: WebSocket;
  private o: LocalOptions;
  private phase: "first" | "confirm" | "open" | "over" = "first";
  private session: Session | null = null;
  private way: LocalWay | null = null;
  private socket: TunnelSocket | null = null;
  private timer: NodeJS.Timeout | null;

  constructor(ws: WebSocket, o: LocalOptions) {
    this.ws = ws;
    this.o = o;
    this.timer = setTimeout(() => this.refuse(null, "handshake_timeout"), o.handshakeMs ?? HANDSHAKE_MS);
    this.timer.unref();
    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], binary: boolean) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      try {
        this.frame(buf, binary);
      } catch (err) {
        log("error", { where: "phone_tunnel", message: err instanceof Error ? err.message : String(err) });
        this.refuse(null, "error");
      }
    });
    ws.on("close", (code: number, reason: Buffer) => this.ended(code, String(reason)));
    ws.on("error", () => {});
  }

  private frame(data: Buffer, binary: boolean) {
    if (this.phase === "over") return;
    if (this.phase === "first") return binary ? this.opening(data) : this.refuse("version", "unencrypted");
    // Nothing comes in the clear once the handshake started: a text frame is someone else's, or a broken app.
    if (!binary) return this.broken("text_frame");
    let record;
    try {
      record = openRecord(this.session!.receive, data);
    } catch (err) {
      if (this.phase === "confirm") return this.unconfirmed();
      return this.broken(err instanceof TunnelError ? err.code : "error");
    }
    if (this.phase === "confirm") this.open();
    const closed = this.socket!.received(record);
    if (closed) this.drop(closed.code, closed.reason);
  }

  /** The phone's first frame: how it opens the tunnel, then that handshake's first message. */
  private opening(frame: Buffer) {
    const rest = frame.subarray(1);
    switch (frame[0]) {
      case LOCAL_OPEN.keys:
        return this.keys(rest);
      case LOCAL_OPEN.code:
        return this.code(rest);
      case LOCAL_OPEN.token:
        return this.token(rest);
      case LOCAL_OPEN.qr:
        return this.qr(rest);
      default:
        return this.refuse("version", "unknown_opening", { opening: frame[0] ?? null });
    }
  }

  /** Noise IK, as through the relay: the Mac answers any phone that holds the key it names; the server decides who that is. */
  private keys(message: Buffer) {
    let read;
    try {
      read = respond({ prologue: LOCAL_PROLOGUE, local: this.o.identity.static, message });
    } catch (err) {
      if (!(err instanceof TunnelError)) throw err;
      // Its key for this Mac isn't this Mac's (keys made again here, or another Mac at the address): it
      // drops it and opens with its token next. Anything else is a broken or altered handshake.
      if (err.step === "not_for_this_mac") return this.refuse("stale_key", "stale_key");
      if (err.step === "short") return this.refuse("version", "short_handshake");
      return this.refuse(null, "handshake", { step: err.step ?? "unknown" });
    }
    const phone = this.o.pairing.byRelayKey(read.remote);
    const { message: answer, session } = read.answer();
    this.session = session;
    this.way = { mode: "keys", key: read.remote, phoneId: phone?.id ?? null };
    this.ws.send(answer);
    this.open();
  }

  /** CPace with the pairing code, while pairing is open. */
  private code(share: Buffer) {
    if (share.length !== 32) return this.refuse("version", "short_handshake");
    const open = this.o.pairing.codeFor();
    if (!open.ok) return this.refuse(open.code, open.code);
    this.cpace({ prs: Buffer.from(open.code), ci: CPACE_CI.code, theirs: share }, { mode: "code" });
  }

  /** CPace with a paired phone's token: an id (16 bytes) naming the phone, then its share. */
  private token(rest: Buffer) {
    if (rest.length !== 48) return this.refuse("version", "short_handshake");
    const id = rest.subarray(0, 16);
    const found = this.o.pairing.byTokenId(id);
    if (!found) return this.refuse("unknown_phone", "unknown_token");
    // A phone whose key the Mac has opens with it: its token alone doesn't let it in any more
    // (one seen on the network before the connection was encrypted would).
    if (found.phone.relayKey) return this.refuse("unknown_phone", "token_after_key", { phoneId: found.phone.id });
    this.cpace({ prs: found.secret, ci: CPACE_CI.token, ada: id, theirs: rest.subarray(16) }, { mode: "token", phoneId: found.phone.id });
  }

  /** CPace with a QR code's secret: the code's id (16 bytes), then the share. Refused as it is when it doesn't work any more. */
  private qr(rest: Buffer) {
    if (rest.length !== 48) return this.refuse("version", "short_handshake");
    const id = rest.subarray(0, 16);
    const open = this.o.pairing.qrFor(id);
    if (!open.ok) return this.refuse(open.code, open.code);
    this.cpace({ prs: open.secret, ci: CPACE_CI.qr, ada: id, theirs: rest.subarray(16) }, { mode: "qr", id: Buffer.from(id) });
  }

  private cpace(inputs: { prs: Buffer; ci: Buffer; ada?: Buffer; theirs: Buffer }, way: LocalWay) {
    let made;
    try {
      made = cpaceRespond(inputs);
    } catch (err) {
      if (!(err instanceof TunnelError)) throw err;
      return this.refuse(null, "handshake", { step: "share" });
    }
    this.session = sessionOf(made.isk, "mac");
    this.way = way;
    this.phase = "confirm";
    this.ws.send(made.share);
  }

  /** The phone's first record didn't open under the keys CPace gave: not the same code (or token). */
  private unconfirmed() {
    if (this.way?.mode === "code") {
      const why = this.o.pairing.wrongCode();
      if (why === "too_many_attempts") this.o.changed?.();
      return this.refuse(why, why);
    }
    // Someone else's secret for this code's id: not the code on the Mac's screen.
    if (this.way?.mode === "qr") return this.refuse("bad_code", "qr_mismatch");
    return this.refuse("unknown_phone", "token_mismatch", { phoneId: this.way?.mode === "token" ? this.way.phoneId : null });
  }

  /** The tunnel is open: the server's from here. */
  private open() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.phase = "open";
    this.socket = new TunnelSocket(this);
    this.o.adopt(this.socket, this.way!);
  }

  /** A refusal in the clear (or, with no code, none: the socket just closes), logged with why. */
  private refuse(code: ClearRefusal | null, reason: string, more: Record<string, unknown> = {}) {
    if (this.phase === "over") return;
    log("phone_refused", { reason, address: this.o.address, phoneId: null, tunnel: this.way?.mode ?? null, ...more });
    if (code && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify({ v: 1, type: "error", code, message: this.o.message(code) }));
    this.drop(4001, code ?? "");
  }

  /** A record that didn't open once the tunnel was open: altered, replayed, reordered or dropped. It ends. */
  private broken(why: string) {
    log("phone_tunnel_broken", { phoneId: this.way && "phoneId" in this.way ? this.way.phoneId : null, tunnel: this.way?.mode ?? null, why });
    this.drop();
  }

  // ── TunnelLink ──────────────────────────────────────────────────────────

  send(type: RecordType, body?: Buffer) {
    if (!this.session || this.phase !== "open" || this.ws.readyState !== this.ws.OPEN) return false;
    try {
      this.ws.send(sealRecord(this.session.send, type, body));
      return true;
    } catch (err) {
      log("error", { where: "phone_tunnel_send", message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  drop(code = 1006, reason = "") {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.phase = "over";
    // A code a close frame can't carry (1006, …: the `ws` package's own rule) and the socket just goes.
    const sendable = (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999);
    if (sendable) this.ws.close(code, reason);
    else this.ws.terminate();
    this.socket?.ended(code, reason);
  }

  buffered() {
    return this.ws.bufferedAmount;
  }

  /** The socket closed, whichever side closed it. */
  private ended(code: number, reason: string) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.phase = "over";
    this.socket?.ended(code, reason);
  }
}
