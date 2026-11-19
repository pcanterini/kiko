// A phone's socket on the home network, as the iPhone app opens one (protocol/README.md, "Encrypted
// at home"), shaped like the `ws` package's WebSocket so a test written against a plain socket only
// changes its constructor: "open", "message" (data, isBinary), "close" (code, reason) and "error";
// send(), close(), terminate().
//
// Its handshake is picked as the app picks it: a phone that has its keys for this token (from an
// earlier welcome here) opens with them (Noise IK); otherwise the first message it's given says how:
// `pair` opens with the code (CPace), `hello` with the token (CPace); given a QR code's secret, `pair`
// opens with it instead (CPace, the qr way: its id, then its share). Each adds the phone's static key
// to that first message, as the app does, and keeps the Mac's from welcome. After the handshake,
// everything is a sealed record; the Mac's pings are answered. A refusal in the clear (before the
// tunnel) comes as a text "message", as it would on a plain socket.
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { CPACE_CI, cpaceInitiate, qrIdOf, sessionOf, tokenIdOf, tokenSecret } from "../../src/remote/cpace.ts";
import { closeOf, initiate, LOCAL_OPEN, LOCAL_PROLOGUE, openRecord, RECORD, sealRecord, x25519Pair, type Session, type X25519Pair } from "../../src/remote/tunnel.ts";

/** What a phone keeps for a Mac, by its token: its own static key and the Mac's. */
const kept = new Map<string, { key: X25519Pair; macKey: Buffer }>();
/** The last Mac key a welcome gave: a phone that says something else first opens with a key of its own to it. */
let lastMacKey: Buffer | null = null;

export type LocalPhoneOptions = {
  /** Open with these keys (Noise IK) whatever is said first. */
  keys?: { key: X25519Pair; macKey: Buffer };
  /** Don't add the phone's key to the first message (an app that doesn't send one). */
  noKey?: boolean;
  /** Leave the keys kept for its token aside: a phone that lost them opens with its token. */
  forget?: boolean;
  /** Pair from a QR code: `pair` opens with this secret (the qr way), named by `id` (its own id unless said: a wrong one to test). */
  qr?: { secret: Buffer; id?: Buffer };
};

export class LocalPhone extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readonly ws: WebSocket;
  /** The tunnel's close record, when the Mac closed it. */
  closedBy: { code: number; reason: string } | null = null;
  /** How it opened: keys, code, token or qr (once it has). */
  way: "keys" | "code" | "token" | "qr" | null = null;
  private o: LocalPhoneOptions;
  private session: Session | null = null;
  private finish: ((answer: Buffer) => Session) | null = null;
  private waiting: Array<string | Buffer> = [];
  private key: X25519Pair;
  private token: string | null = null;

  constructor(url: string, o: LocalPhoneOptions = {}) {
    super();
    this.o = o;
    this.key = o.keys?.key ?? x25519Pair();
    this.ws = new WebSocket(url);
    this.ws.on("open", () => {
      this.emit("open");
      if (o.keys) this.start(null);
    });
    this.ws.on("message", (data, isBinary) => this.frame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer), isBinary));
    this.ws.on("close", (code, reason) => this.emit("close", code, reason));
    this.ws.on("error", (err) => this.emit("error", err));
  }

  get readyState() {
    return this.ws.readyState;
  }

  /** The `ws` socket's own, for tests that pause or destroy it (a half-open connection). */
  get _socket() {
    return (this.ws as unknown as { _socket: unknown })._socket;
  }

  send(data: string | Buffer) {
    if (this.session) return this.seal(data);
    this.waiting.push(data);
    if (this.waiting.length === 1 && !this.finish) this.start(typeof data === "string" ? data : null);
  }

  close(code?: number, reason?: string) {
    this.ws.close(code, reason);
  }

  terminate() {
    this.ws.terminate();
  }

  /** Opens the tunnel: with its keys, or as the first message says. */
  private start(first: string | null) {
    const m = first ? JSON.parse(first) : null;
    const token = m?.type === "hello" ? (m.token as string) : null;
    this.token = token;
    const keys = this.o.keys ?? (token && !this.o.forget ? kept.get(token) : undefined);
    if (keys) {
      this.key = keys.key;
      this.way = "keys";
      const hs = initiate({ prologue: LOCAL_PROLOGUE, local: keys.key, remote: keys.macKey });
      this.finish = (answer) => hs.finish(answer);
      return this.ws.send(Buffer.concat([Buffer.from([LOCAL_OPEN.keys]), hs.message]));
    }
    if (m?.type === "pair" && this.o.qr) {
      this.way = "qr";
      if (!this.o.noKey) this.waiting[0] = JSON.stringify({ ...m, key: this.key.public.toString("base64") });
      const id = this.o.qr.id ?? qrIdOf(this.o.qr.secret);
      const a = cpaceInitiate({ prs: this.o.qr.secret, ci: CPACE_CI.qr, ada: id });
      this.finish = (answer) => sessionOf(a.finish(answer), "phone");
      return this.ws.send(Buffer.concat([Buffer.from([LOCAL_OPEN.qr]), id, a.share]));
    }
    if (m?.type === "pair") {
      this.way = "code";
      if (!this.o.noKey) this.waiting[0] = JSON.stringify({ ...m, key: this.key.public.toString("base64") });
      const a = cpaceInitiate({ prs: Buffer.from(String(m.code)), ci: CPACE_CI.code });
      this.finish = (answer) => sessionOf(a.finish(answer), "phone");
      return this.ws.send(Buffer.concat([Buffer.from([LOCAL_OPEN.code]), a.share]));
    }
    if (token) {
      this.way = "token";
      if (!this.o.noKey) this.waiting[0] = JSON.stringify({ ...m, key: this.key.public.toString("base64") });
      const secret = tokenSecret(token);
      const id = tokenIdOf(secret);
      const a = cpaceInitiate({ prs: secret, ci: CPACE_CI.token, ada: id });
      this.finish = (answer) => sessionOf(a.finish(answer), "phone");
      return this.ws.send(Buffer.concat([Buffer.from([LOCAL_OPEN.token]), id, a.share]));
    }
    // Anything else first (a broken app): a key no phone has, to the last Mac seen, so it reaches the server.
    if (!lastMacKey) throw new Error("a LocalPhone opens with keys, pair or hello (or anything, once a welcome gave a Mac key)");
    this.way = "keys";
    const hs = initiate({ prologue: LOCAL_PROLOGUE, local: this.key, remote: lastMacKey });
    this.finish = (answer) => hs.finish(answer);
    this.ws.send(Buffer.concat([Buffer.from([LOCAL_OPEN.keys]), hs.message]));
  }

  private seal(data: string | Buffer) {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(typeof data === "string" ? sealRecord(this.session!.send, RECORD.text, Buffer.from(data)) : sealRecord(this.session!.send, RECORD.binary, data));
  }

  private frame(data: Buffer, isBinary: boolean) {
    // In the clear: a refusal before the tunnel (or anything a test sends that way).
    if (!isBinary) return void this.emit("message", data, false);
    if (!this.session) {
      this.session = this.finish!(data);
      const waiting = this.waiting;
      this.waiting = [];
      for (const w of waiting) this.seal(w);
      return;
    }
    const record = openRecord(this.session.receive, data);
    if (record.type === RECORD.text) {
      const m = JSON.parse(record.body.toString());
      if (m.type === "paired") this.token = m.token;
      if (m.type === "welcome" && m.macKey) lastMacKey = Buffer.from(m.macKey, "base64");
      if (m.type === "welcome" && m.macKey && this.token) kept.set(this.token, { key: this.key, macKey: Buffer.from(m.macKey, "base64") });
      this.emit("message", record.body, false);
    } else if (record.type === RECORD.binary) this.emit("message", record.body, true);
    else if (record.type === RECORD.ping) this.ws.send(sealRecord(this.session.send, RECORD.pong, record.body));
    else if (record.type === RECORD.close) this.closedBy = closeOf(record.body);
  }
}

/** A phone's socket to the Mac's phone server on the home network (`ws://…`), encrypted as the app's. */
export const phoneSocket = (url: string, o?: LocalPhoneOptions) => new LocalPhone(url, o);
