// A fake phone that reaches the Mac through the relay, as the iPhone app will (protocol/README.md,
// "Relay"): it joins the Mac's room with its credential, runs the tunnel's handshake to the Mac's
// static key, then speaks the protocol inside it: every message it gets is opened, checked against
// the schema, and kept for `next`. The tunnel's pings are answered as the app must. Used with the
// fake relay here (fake-relay.ts) and with the real Worker in relay/test/. Given a QR code's secret
// (`qr`), it pairs from away instead (protocol/README.md, "Pairing through the relay"): it joins with
// the credential drawn from the secret and opens the qr way (CPace), as at home.
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { CPACE_CI, cpaceInitiate, qrIdOf, qrRelayCredentialOf, sessionOf } from "../../src/remote/cpace.ts";
import { invalid } from "../../src/remote/schema.ts";
import { closeOf, initiate, LOCAL_OPEN, openRecord, prologueOf, RECORD, sealRecord, TUNNEL_VERSION, x25519Pair, type Session, type X25519Pair } from "../../src/remote/tunnel.ts";

export type RelayPhoneOptions = {
  /** The relay, ws://127.0.0.1:<port>. */
  url: string;
  room: string;
  /** base64, as relay_paired gave it (or, pairing by a QR code, the one drawn from its secret unless given). */
  credential?: string;
  /** The Mac's static X25519 public key (not needed to pair by a QR code). */
  macKey?: Buffer;
  /** The phone's own static key pair (made for it if not given). */
  key?: X25519Pair;
  /** The handshake's prologue, to play an app that speaks another (prologueOf(room) otherwise). */
  prologue?: Buffer;
  /** Pair by a QR code: CPace with this secret, the code named by `id` (its own unless said: a wrong one to test). */
  qr?: { secret: Buffer; id?: Buffer };
};

export class RelayPhone {
  readonly ws: WebSocket;
  private session: Session | null = null;
  private got: any[] = [];
  private binary: Buffer[] = [];
  private waiting: Array<() => void> = [];
  /** What the relay said (joined, error) before the tunnel. */
  readonly relaySaid: any[] = [];
  /** The tunnel's close record, when the Mac closed it. */
  closedBy: { code: number; reason: string } | null = null;
  /** The relay's socket closed: its code. */
  closeCode: number | null = null;
  pings = 0;
  private finish: ((answer: Buffer) => Session) | null = null;
  private o: RelayPhoneOptions;

  constructor(o: RelayPhoneOptions) {
    this.o = { ...o, key: o.key ?? x25519Pair(), credential: o.credential ?? (o.qr ? qrRelayCredentialOf(o.qr.secret).toString("base64") : undefined) };
    this.ws = new WebSocket(`${o.url}/v1/phone/${o.room}`);
    this.ws.on("message", (data, isBinary) => this.frame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer), isBinary));
    this.ws.on("close", (code) => {
      this.closeCode = code;
      this.wake();
    });
    this.ws.on("error", () => {});
  }

  /** Joins the room and runs the handshake; resolves once the tunnel is open. */
  async open(o: { ticket?: string } = {}) {
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
    this.ws.send(JSON.stringify({ type: "join", credential: this.o.credential, ...(o.ticket ? { ticket: o.ticket } : {}) }));
    const said = await this.until(() => this.relaySaid.find((m) => m.type === "joined" || m.type === "error"));
    if (said.type === "error") throw new Error(`relay refused: ${said.code}`);
    if (this.o.qr) {
      const id = this.o.qr.id ?? qrIdOf(this.o.qr.secret);
      const a = cpaceInitiate({ prs: this.o.qr.secret, ci: CPACE_CI.qr, ada: id });
      this.finish = (answer) => sessionOf(a.finish(answer), "phone");
      this.ws.send(Buffer.concat([Buffer.from([LOCAL_OPEN.qr]), id, a.share]));
      await this.until(() => this.session);
      return;
    }
    const hs = initiate({ prologue: this.o.prologue ?? prologueOf(this.o.room), local: this.o.key!, remote: this.o.macKey! });
    this.finish = (answer) => hs.finish(answer);
    this.ws.send(Buffer.concat([Buffer.from([TUNNEL_VERSION]), hs.message]));
    await this.until(() => this.session);
  }

  private frame(data: Buffer, isBinary: boolean) {
    if (!isBinary) {
      if (data.toString() !== "pong") this.relaySaid.push(JSON.parse(data.toString()));
      return this.wake();
    }
    if (!this.session) {
      this.session = this.finish!(data);
      return this.wake();
    }
    const record = openRecord(this.session.receive, data);
    if (record.type === RECORD.text) {
      const m = JSON.parse(record.body.toString());
      assert.equal(invalid(m, "hub"), null, JSON.stringify(m));
      this.got.push(m);
    } else if (record.type === RECORD.binary) this.binary.push(record.body);
    else if (record.type === RECORD.ping) {
      this.pings++;
      this.ws.send(sealRecord(this.session.send, RECORD.pong, record.body));
    } else if (record.type === RECORD.close) this.closedBy = closeOf(record.body);
    this.wake();
  }

  /** A protocol message, sealed into the tunnel (v added). */
  send(m: Record<string, unknown>) {
    this.ws.send(sealRecord(this.session!.send, RECORD.text, Buffer.from(JSON.stringify({ v: 1, ...m }))));
  }

  /** One record sealed as it would go, not sent (binary frames, tampering, replay). */
  seal(type: (typeof RECORD)[keyof typeof RECORD], body: Buffer) {
    return sealRecord(this.session!.send, type, body);
  }

  /** Its static key: the one it was given, or made for it. */
  get key(): X25519Pair {
    return this.o.key!;
  }

  /** What the Mac sent that hasn't been taken by `next` yet. */
  left(): any[] {
    return [...this.got];
  }

  /** The next message of this type the Mac sent (waiting for it), taken out of what's kept. */
  async next(type: string): Promise<any> {
    return this.until(() => {
      const i = this.got.findIndex((m) => m.type === type);
      return i >= 0 ? this.got.splice(i, 1)[0] : undefined;
    });
  }

  /** Waits until `check` gives something, the socket closes, or 5 s pass. */
  async until<T>(check: () => T | undefined | null | false, ms = 5_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = check();
      if (v) return v;
      if (this.closeCode !== null) throw new Error(`closed (${this.closeCode}) waiting`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timed out waiting");
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiting.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  /** Resolves with the relay socket's close code. */
  async closed(ms = 5_000) {
    const deadline = Date.now() + ms;
    while (this.closeCode === null) {
      if (Date.now() > deadline) throw new Error("not closed");
      await new Promise((r) => setTimeout(r, 10));
    }
    return this.closeCode;
  }

  private wake() {
    for (const w of this.waiting.splice(0)) w();
  }

  close() {
    this.ws.close();
  }
}
