// A stand-in for the relay (relay/src/index.ts) in the hub's own unit tests, on 127.0.0.1 with a
// port of its own: the same paths, challenge, sign-in, credentials and channel framing, kept small
// and in this process so the hub's tests need none of relay/'s dependencies. The real Worker's own
// tests, and the end-to-end one through it, are in relay/test/. With the pairing QR code's way in
// (one phone per registration, its close saying qr_used or qr_expired), unless `oldRelay`: a relay
// from before it, whose ready says nothing of it and which answers `pairing` with bad_message.
import { createHash, randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { authMessage, ed25519Verify, roomOf } from "../../src/remote/tunnel.ts";

type Phone = { ws: WebSocket; channel: number; credential: string; pairing: boolean };

export class FakeRelay {
  private wss: WebSocketServer | null = null;
  mac: WebSocket | null = null;
  credentials: string[] = [];
  phones = new Map<number, Phone>();
  private next = 0;
  /** Every Mac sign-in that passed. */
  signIns = 0;
  port = 0;
  /** The pairing QR code's way in, as the Mac last said; and every `pairing` message it sent. */
  pairing: { hash: string; until: number; state: "open" | "used" | "shut" } | null = null;
  pairingSaid: any[] = [];
  /** Every relay pass the Mac showed (`pass`), in order; with `requirePass`, a phone joins only once one was. */
  passes: string[] = [];
  requirePass = false;
  /** Passes on the revocation list (as the relay's PASS_REVOKED would say): the last shown being one, a phone is refused, the Mac told `revoked`. */
  revoked = new Set<string>();
  /** A Mac's socket whose pings go unanswered from now, as on one gone half-open (the Mac's network changed under it). */
  deafTo: WebSocket | null = null;
  private oldRelay: boolean;

  constructor(o: { oldRelay?: boolean } = {}) {
    this.oldRelay = o.oldRelay ?? false;
  }

  async start() {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    this.wss = wss;
    this.port = (wss.address() as { port: number }).port;
    wss.on("connection", (ws, req) => {
      const m = req.url?.match(/^\/v1\/(mac|phone)\/([0-9a-f]{32})$/);
      if (!m) return ws.close(1008);
      if (m[1] === "mac") this.macCame(ws, m[2]);
      else this.phoneCame(ws);
    });
    return `ws://127.0.0.1:${this.port}`;
  }

  stop() {
    for (const c of this.wss?.clients ?? []) c.terminate();
    this.wss?.close();
  }

  /** Drops the Mac's socket, as a relay restart would. */
  dropMac() {
    this.mac?.terminate();
  }

  private macCame(ws: WebSocket, room: string) {
    const nonce = randomBytes(32);
    let authed = false;
    ws.send(JSON.stringify({ type: "challenge", nonce: nonce.toString("base64") }));
    ws.on("message", (data, binary) => {
      const buf = data as Buffer;
      if (!binary && buf.toString() === "ping") return this.deafTo === ws ? undefined : ws.send("pong");
      if (!authed) {
        const m = JSON.parse(buf.toString());
        const key = Buffer.from(m.key, "base64");
        if (roomOf(key) !== room || !ed25519Verify(key, authMessage(room, nonce), Buffer.from(m.sig, "base64"))) {
          ws.send(JSON.stringify({ type: "error", code: "unauthorized" }));
          return ws.close(4001);
        }
        authed = true;
        this.signIns++;
        if (typeof m.pass === "string") this.passes.push(m.pass);
        this.mac?.close(4000);
        this.mac = ws;
        ws.send(JSON.stringify(this.oldRelay ? { type: "ready" } : { type: "ready", pairing: true }));
        return;
      }
      if (binary) return this.phones.get(buf.readUInt32BE(0))?.ws.send(buf.subarray(4));
      const m = JSON.parse(buf.toString());
      if (m.type === "phones") {
        this.credentials = m.credentials;
        for (const p of this.phones.values()) if (!p.pairing && !this.credentials.includes(p.credential)) p.ws.close(4001);
      }
      if (m.type === "pass") this.passes.push(m.pass);
      if (m.type === "pairing" && this.oldRelay) return ws.send(JSON.stringify({ type: "error", code: "bad_message" }));
      if (m.type === "pairing") {
        this.pairingSaid.push(m);
        if (m.credential === null) {
          if (this.pairing) this.pairing.state = m.used ? "used" : "shut";
        } else this.pairing = { hash: m.credential, until: Date.now() + Math.min(m.ttl, 300) * 1000, state: "open" };
      }
      if (m.type === "close") {
        const p = this.phones.get(m.channel);
        if (p && (m.code === "qr_used" || m.code === "qr_expired")) {
          p.ws.send(JSON.stringify({ type: "error", code: m.code }));
          p.ws.close(m.code === "qr_used" ? 4012 : 4013);
        } else p?.ws.close(1000);
      }
    });
    ws.on("close", () => {
      if (this.mac !== ws) return;
      this.mac = null;
      for (const p of this.phones.values()) p.ws.close(4002);
    });
  }

  private phoneCame(ws: WebSocket) {
    let me: Phone | null = null;
    ws.on("message", (data, binary) => {
      const buf = data as Buffer;
      if (!me) {
        const m = JSON.parse(buf.toString());
        const hash = createHash("sha256").update(Buffer.from(m.credential, "base64")).digest("hex");
        const refuse = (code: string, close: number) => {
          ws.send(JSON.stringify({ type: "error", code }));
          ws.close(close);
        };
        const pairing = !this.credentials.includes(hash) && this.pairing?.hash === hash ? this.pairing : null;
        if (!this.credentials.includes(hash) && !pairing) return refuse("unauthorized", 4001);
        if (pairing && (pairing.state === "shut" || Date.now() >= pairing.until)) return refuse("qr_expired", 4013);
        if (pairing?.state === "used") return refuse("qr_used", 4012);
        if (!this.mac) return refuse("mac_offline", 4003);
        // The relay pass (the room's Mac showed none, or one revoked since): refused, and the Mac told.
        const last = this.passes.at(-1);
        if (this.requirePass && !pairing && (!last || this.revoked.has(last))) {
          this.mac.send(JSON.stringify({ type: "phone_refused", code: "plan_required", pass: last ? "revoked" : "missing" }));
          return refuse("plan_required", 4014);
        }
        if (pairing) pairing.state = "used";
        me = { ws, channel: ++this.next, credential: hash, pairing: Boolean(pairing) };
        this.phones.set(me.channel, me);
        ws.send(JSON.stringify({ type: "joined" }));
        this.mac.send(JSON.stringify({ type: "open", channel: me.channel, ...(pairing ? { pairing: true } : {}) }));
        return;
      }
      if (!binary) return;
      const head = Buffer.alloc(4);
      head.writeUInt32BE(me.channel);
      this.mac?.send(Buffer.concat([head, buf]));
    });
    ws.on("close", () => {
      if (!me) return;
      this.phones.delete(me.channel);
      this.mac?.send(JSON.stringify({ type: "closed", channel: me.channel }));
    });
  }
}
