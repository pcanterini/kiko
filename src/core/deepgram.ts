import WebSocket from "ws";
import { MIC_SAMPLE_RATE } from "./config.ts";
import { log } from "./log.ts";

const KEEPALIVE_MS = 4000;
const FINALIZE_TIMEOUT_MS = 2000;
/**
 * A socket that dropped connects again this long after: doubling from the first after each attempt
 * that fails (offline, a revoked key), up to the last, back to the first once one opens (as cartesia.ts).
 */
const RETRY_MS = { min: 500, max: 30_000 };

type DeepgramOptions = {
  /** The waits, and what waits them (setTimeout): the tests' own. */
  retryMs?: { min: number; max: number };
  wait?: (then: () => void, ms: number) => NodeJS.Timeout;
};
// Audio that comes while it's down waits, in order, and goes out first once it's back: up to this
// many seconds of it. Past that the oldest goes, and the log says how much (deepgram_dropped).
const BACKLOG_SECONDS = 5;
// finish() waits this long for a socket that's coming back, then takes what it has.
const REOPEN_WAIT_MS = 3000;

const DEEPGRAM_URL = "wss://api.deepgram.com/v1/listen";

/**
 * One Deepgram live socket held open between presses (KeepAlive while idle).
 * A press streams audio; key up sends Finalize and resolves with the transcript
 * once Deepgram answers with `from_finalize`. If the socket drops mid-press, it connects again and
 * what you said meanwhile is held and sent first, in order: the Mac's key and the phone alike.
 */
export class Deepgram {
  private ws: WebSocket | null = null;
  private ready: Promise<void> = Promise.resolve();
  private keepAlive: NodeJS.Timeout | null = null;
  private finals: string[] = [];
  private interim = "";
  private pending: ((text: string) => void) | null = null;
  private bytesSent = 0;
  // Keyterm prompting (stt-hints.ts): words to expect, sent with the socket and updated in place.
  private keyterms: string[] = [];
  // Audio held while the socket is down, and how much of this press's had to go (bytes).
  private backlog: Buffer[] = [];
  private backlogBytes = 0;
  private dropped = 0;
  // The wait before the next attempt, and how many attempts in a row failed.
  private retry: NodeJS.Timeout | null = null;
  private failures = 0;

  private apiKey: string;
  private url: string;
  private readonly o: DeepgramOptions;

  onInterim: (text: string) => void = () => {};

  /** `url`: Deepgram's, unless a test has its own. */
  constructor(apiKey: string, url = DEEPGRAM_URL, o: DeepgramOptions = {}) {
    this.apiKey = apiKey;
    this.url = url;
    this.o = o;
  }

  connect() {
    const params = new URLSearchParams({
      model: "nova-3",
      encoding: "linear16",
      sample_rate: String(MIC_SAMPLE_RATE),
      channels: "1",
      interim_results: "true",
      smart_format: "true",
      punctuate: "true",
    });
    for (const term of this.keyterms) params.append("keyterm", term);
    const ws = new WebSocket(`${this.url}?${params}`, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });
    this.ws = ws;
    const withSocket = this.keyterms.join("\n");
    let opened = false;
    this.ready = new Promise((resolve, reject) => {
      ws.once("open", () => {
        opened = true;
        this.failures = 0;
        // Hints that changed while it connected.
        if (this.keyterms.join("\n") !== withSocket) ws.send(JSON.stringify({ type: "Configure", keyterms: this.keyterms }));
        // What was said while it was down, before anything newer.
        for (const chunk of this.backlog.splice(0)) this.sendNow(ws, chunk);
        this.backlogBytes = 0;
        resolve();
      });
      ws.once("error", reject);
    });
    ws.on("message", (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        console.error("[deepgram] a message that isn't JSON:", (err as Error).message);
        return;
      }
      if (msg && typeof msg === "object") this.onMessage(msg);
    });
    ws.on("error", (err) => console.error("[deepgram]", err.message));
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // Words it hadn't made final are the best there is of them: the next socket starts afresh.
      if (this.interim) this.finals.push(this.interim);
      this.interim = "";
      this.pending?.(this.transcript());
      if (!opened) this.failures++;
      // Reconnect so the next press finds a warm socket, and the rest of this one goes out. Ready
      // (for finish()) once it's open again. A failed attempt closes too, and tries again, later.
      const { min, max } = this.o.retryMs ?? RETRY_MS;
      const ms = Math.min(max, min * 2 ** Math.max(0, this.failures - 1));
      this.ready = new Promise<void>((resolve, reject) => {
        const again = () => {
          this.retry = null;
          this.connect().then(resolve, (err: Error) => {
            log("deepgram_reconnect_failed", { error: err.message, failures: this.failures });
            reject(err);
          });
        };
        this.retry = this.o.wait ? this.o.wait(again, ms) : setTimeout(again, ms);
      });
      this.ready.catch(() => {});
    });

    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" }));
    }, KEEPALIVE_MS);
    return this.ready;
  }

  begin() {
    // A press before it that never got its audio out: it's over, so is its audio.
    this.dropBacklog("next_press");
    this.bytesSent = 0;
    this.finals = [];
    this.interim = "";
  }

  send(chunk: Buffer) {
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN && !this.backlog.length) return this.sendNow(ws, chunk);
    // Down (or coming back): held for when it's open.
    this.backlog.push(chunk);
    this.backlogBytes += chunk.length;
    while (this.backlogBytes > BACKLOG_SECONDS * MIC_SAMPLE_RATE * 2 && this.backlog.length > 1) {
      const old = this.backlog.shift()!;
      this.backlogBytes -= old.length;
      this.dropped += old.length;
    }
  }

  /** Flush buffered audio and resolve with the full transcript for this press. */
  async finish(): Promise<string> {
    // Down mid-press: wait for it to come back (a while), so what was held goes out first.
    if (this.ws?.readyState !== WebSocket.OPEN) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.ready.catch(() => {}), new Promise((r) => (timer = setTimeout(r, REOPEN_WAIT_MS)))]);
      clearTimeout(timer);
    }
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) {
      this.dropBacklog("not_reconnected");
      return this.transcript();
    }
    this.logDropped();
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(), FINALIZE_TIMEOUT_MS);
      const done = () => {
        clearTimeout(timer);
        this.pending = null;
        resolve(this.transcript());
      };
      this.pending = done;
      ws.send(JSON.stringify({ type: "Finalize" }));
    });
  }

  /**
   * The words to expect (Nova-3 keyterm prompting). Changed on the open socket with a Configure
   * message, which replaces the whole list; a reconnect sends them with the socket. Billed as an
   * add-on per minute of audio while there are any.
   */
  setHints(terms: string[]) {
    if (terms.join("\n") === this.keyterms.join("\n")) return;
    this.keyterms = [...terms];
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "Configure", keyterms: this.keyterms }));
  }

  hinted() {
    return this.keyterms.length > 0;
  }

  /** Seconds of audio sent since begin(); Deepgram bills streaming by audio duration. */
  audioSeconds() {
    return this.bytesSent / (MIC_SAMPLE_RATE * 2);
  }

  close() {
    if (this.keepAlive) clearInterval(this.keepAlive);
    // Closed while waiting to connect again: it doesn't.
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const ws = this.ws;
    this.ws = null;
    // Still connecting (offline): send would throw.
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
    ws?.close();
  }

  private sendNow(ws: WebSocket, chunk: Buffer) {
    ws.send(chunk);
    this.bytesSent += chunk.length;
  }

  /** What's held goes unsent (`why`); logged with anything dropped before. */
  private dropBacklog(why: string) {
    this.dropped += this.backlogBytes;
    this.backlog = [];
    this.backlogBytes = 0;
    this.logDropped(why);
  }

  /** Audio of this press that never reached Deepgram, if any: said once, in seconds. */
  private logDropped(why = "backlog_full") {
    if (!this.dropped) return;
    log("deepgram_dropped", { seconds: Math.round((this.dropped / (MIC_SAMPLE_RATE * 2)) * 100) / 100, why });
    this.dropped = 0;
  }

  private transcript() {
    return [...this.finals, this.interim].join(" ").replace(/\s+/g, " ").trim();
  }

  private onMessage(msg: any) {
    // Too many keyterms: Deepgram keeps the ones it had.
    if (msg.type === "ConfigureFailure") log("error", { where: "deepgram_keyterms", message: JSON.stringify(msg) });
    if (msg.type !== "Results") return;
    const text: string = msg.channel?.alternatives?.[0]?.transcript ?? "";
    if (msg.is_final) {
      if (text) this.finals.push(text);
      this.interim = "";
    } else {
      this.interim = text;
    }
    this.onInterim(this.transcript());
    if (msg.from_finalize) this.pending?.(this.transcript());
  }
}
