// T3 Code's WebSocket speaks Effect RPC (effect 4's RpcSerialization.layerJson): one JSON message
// per WebSocket frame (an array of them is read the same), nothing else on top. Read from T3's
// source at v0.1.5 (apps/server/src/ws.ts, effect's rpc/RpcMessage.ts), never guessed:
//
//   → {"_tag":"Request","id":"1","tag":"orchestration.subscribeShell","payload":{},"headers":[]}
//   ← {"_tag":"Chunk","requestId":"1","values":[…]}         a stream's items, some at a time
//   → {"_tag":"Ack","requestId":"1"}                         after every Chunk: the server waits for it
//   ← {"_tag":"Exit","requestId":"1","exit":{"_tag":"Success","value":…}}
//   ← {"_tag":"Exit","requestId":"1","exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":…}]}}
//   → {"_tag":"Interrupt","requestId":"1"}                   ends a stream we no longer want
//   → {"_tag":"Ping"}   ← {"_tag":"Pong"}                    is it still there?
//   ← {"_tag":"Defect","defect":…}                           every request on the socket failed
//
// The socket is opened by client.ts, with a one-time ticket in its URL: that URL is never logged.
import { inspect } from "node:util";
import WebSocket from "ws";
import { NAME } from "../../core/name.ts";

/** An RPC that ended in failure, or a socket that went away under it. `message` never holds a secret. */
class RpcError extends Error {
  /** The server's error, as it sent it (its `_tag` says which); null for a socket that closed. */
  readonly error: unknown;
  constructor(message: string, error: unknown = null) {
    super(message);
    this.error = error;
  }
}

/** Why the socket wouldn't open: the HTTP status T3 answered the upgrade with (426: another protocol), and its body. */
export class UpgradeRefused extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`T3 Code refused the connection (HTTP ${status})`);
    this.status = status;
    this.body = body;
  }
}

type Pending = { resolve(value: unknown): void; reject(err: Error): void };
type Streaming = { onItem(item: unknown): void; onEnd(err: Error | null): void };

const PING_MS = 15_000;
const PONG_MS = 10_000;

export class RpcSocket {
  private next = 1;
  private readonly calls = new Map<string, Pending>();
  private readonly streams = new Map<string, Streaming>();
  private ping: ReturnType<typeof setInterval> | null = null;
  private pong: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** It closed (T3 quit, restarted, or stopped answering): `why` says which, for the log. */
  onClose: (why: string) => void = () => {};

  private readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => this.receive(String(data)));
    ws.on("close", (code) => this.end(`closed (${code})`));
    ws.on("error", (err) => this.end(`error: ${err.message}`));
    this.ping = setInterval(() => this.sendPing(), PING_MS);
    this.ping.unref?.();
  }

  /** Opens the socket at `url` (its ticket in it): resolves once open; rejects with UpgradeRefused, or why it couldn't connect. */
  static open(url: string, timeoutMs = 5000): Promise<RpcSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
      const fail = (err: Error) => {
        ws.removeAllListeners();
        ws.on("error", () => {});
        ws.terminate();
        reject(err);
      };
      ws.once("unexpected-response", (_req, res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk.slice(0, 4096 - body.length)));
        res.on("end", () => {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(body);
          } catch {}
          fail(new UpgradeRefused(res.statusCode ?? 0, parsed));
        });
      });
      // The ws library's message can carry the URL it tried: only its code is kept.
      ws.once("error", (err: NodeJS.ErrnoException) => fail(new Error(err.code ?? "connection failed")));
      ws.once("open", () => {
        ws.removeAllListeners();
        resolve(new RpcSocket(ws));
      });
    });
  }

  /** One request and its one answer. */
  request<T>(tag: string, payload: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError("not connected"));
    const id = String(this.next++);
    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ _tag: "Request", id, tag, payload, headers: [] });
    });
  }

  /**
   * A stream: `onItem` gets each item as it comes; `onEnd` once, when the server ends it (null) or
   * it fails. stop() ends it from here (onEnd isn't called then).
   */
  stream(tag: string, payload: unknown, onItem: (item: unknown) => void, onEnd: (err: Error | null) => void = () => {}): { stop(): void } {
    const id = String(this.next++);
    if (this.closed) {
      queueMicrotask(() => onEnd(new RpcError("not connected")));
      return { stop() {} };
    }
    this.streams.set(id, { onItem, onEnd });
    this.send({ _tag: "Request", id, tag, payload, headers: [] });
    return {
      stop: () => {
        if (!this.streams.delete(id)) return;
        this.send({ _tag: "Interrupt", requestId: id });
      },
    };
  }

  /** Printed or inspected, it shows nothing of its socket: the socket's URL has its ticket. */
  [inspect.custom]() {
    return `RpcSocket { ${this.closed ? "closed" : "open"} }`;
  }

  close() {
    this.end(`closed by ${NAME}`);
    this.ws.close();
  }

  private send(message: unknown) {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  private sendPing() {
    if (this.pong) return;
    this.send({ _tag: "Ping" });
    this.pong = setTimeout(() => {
      this.end("no answer to a ping");
      this.ws.terminate();
    }, PONG_MS);
    this.pong.unref?.();
  }

  private receive(text: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) this.handle(message as Record<string, any>);
  }

  private handle(m: Record<string, any>) {
    switch (m?._tag) {
      case "Pong":
        if (this.pong) clearTimeout(this.pong);
        this.pong = null;
        return;
      case "Ping":
        return this.send({ _tag: "Pong" });
      case "Chunk": {
        const id = String(m.requestId);
        const s = this.streams.get(id);
        // Acked even when we've stopped it: the server may wait for that before it sees the Interrupt.
        this.send({ _tag: "Ack", requestId: m.requestId });
        if (!s) return;
        for (const item of Array.isArray(m.values) ? m.values : []) {
          if (!this.streams.has(id)) return;
          s.onItem(item);
        }
        return;
      }
      case "Exit": {
        const id = String(m.requestId);
        const exit = m.exit ?? {};
        const failure = exit._tag === "Failure" ? failureOf(exit.cause) : null;
        const call = this.calls.get(id);
        if (call) {
          this.calls.delete(id);
          return failure ? call.reject(failure) : call.resolve(exit.value);
        }
        const s = this.streams.get(id);
        if (s) {
          this.streams.delete(id);
          s.onEnd(failure);
        }
        return;
      }
      case "Defect":
        return this.failAll(new RpcError("T3 Code had a defect", m.defect));
    }
  }

  private failAll(err: Error) {
    for (const call of this.calls.values()) call.reject(err);
    this.calls.clear();
    const streams = [...this.streams.values()];
    this.streams.clear();
    for (const s of streams) s.onEnd(err);
  }

  private end(why: string) {
    if (this.closed) return;
    this.closed = true;
    if (this.ping) clearInterval(this.ping);
    if (this.pong) clearTimeout(this.pong);
    this.failAll(new RpcError(`T3 Code connection ${why}`));
    this.onClose(why);
  }
}

/** An Exit's failure, as an error: the first Fail's error (T3's tagged error, with its message), else a defect or an interrupt. */
function failureOf(cause: unknown): RpcError {
  const parts = Array.isArray(cause) ? cause : [];
  const fail = parts.find((p) => p?._tag === "Fail");
  if (fail) {
    const e = fail.error;
    const what = typeof e?._tag === "string" ? e._tag : "error";
    return new RpcError(typeof e?.message === "string" ? `${what}: ${e.message}` : what, e);
  }
  if (parts.some((p) => p?._tag === "Die")) return new RpcError("T3 Code failed (defect)");
  return new RpcError("interrupted");
}
