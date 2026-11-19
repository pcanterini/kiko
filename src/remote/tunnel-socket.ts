// A phone's tunnel as the phone server sees a connection (server.ts PhoneSocket, as the `ws`
// package's socket): text and binary frames, pings and pongs, and close, each one sealed record
// (tunnel.ts). Under it is a link that carries the sealed records: a channel on the relay
// (relay-client.ts) or a WebSocket on the home network (local.ts). So the server does the same
// (hello and its token, missed, Opus, presence, pings) whichever way the phone came.
import { EventEmitter } from "node:events";
import type { PhoneSocket } from "./server.ts";
import { closeBody, closeOf, RECORD, type Record_, type RecordType } from "./tunnel.ts";

/** What carries a tunnel's records: seals and sends one, lets the phone go, says what's waiting to go. */
export interface TunnelLink {
  /** A record to the phone. False when it couldn't go (too big for one: logged, not sent). */
  send(type: RecordType, body?: Buffer): boolean;
  /** The Mac lets the phone go (its socket closes; "close" follows on the TunnelSocket). */
  drop(code?: number, reason?: string): void;
  buffered(): number;
}

export class TunnelSocket extends EventEmitter implements PhoneSocket {
  readonly OPEN = 1;
  readyState = 1;
  private link: TunnelLink;

  constructor(link: TunnelLink) {
    super();
    this.link = link;
  }

  get bufferedAmount() {
    return this.link.buffered();
  }

  send(data: string | Buffer) {
    if (this.readyState !== this.OPEN) return;
    if (typeof data === "string") this.link.send(RECORD.text, Buffer.from(data));
    else this.link.send(RECORD.binary, data);
  }

  ping() {
    if (this.readyState === this.OPEN) this.link.send(RECORD.ping);
  }

  /** Closed by the Mac: the close record (its code and reason, sealed), then the link goes. */
  close(code = 1000, reason = "") {
    if (this.readyState !== this.OPEN) return;
    this.link.send(RECORD.close, closeBody(code, reason));
    this.link.drop(code, reason);
  }

  terminate() {
    if (this.readyState !== this.OPEN) return;
    this.link.drop();
    this.ended(1006, "");
  }

  /**
   * A record from the phone, opened: a frame of the protocol goes to the server as the `ws`
   * package's would, a ping is answered, a pong counts. A close record is handed back (its code and
   * reason) for the link to end with; null for anything else.
   */
  received(record: Record_): { code: number; reason: string } | null {
    switch (record.type) {
      case RECORD.text:
        this.emit("message", record.body, false);
        return null;
      case RECORD.binary:
        this.emit("message", record.body, true);
        return null;
      case RECORD.ping:
        this.link.send(RECORD.pong, record.body);
        return null;
      case RECORD.pong:
        this.emit("pong");
        return null;
      case RECORD.close:
        return closeOf(record.body);
    }
    return null;
  }

  /** It's over, whichever side ended it: "close" once. */
  ended(code: number, reason: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }
}
