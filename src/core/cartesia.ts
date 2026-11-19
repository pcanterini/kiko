import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { config, TTS_SAMPLE_RATE } from "./config.ts";
import { log } from "./log.ts";

import type { VoiceTimings } from "./voice-marks.ts";

// marks: told the words' timestamps as they come (the phone's read-along, voice-marks.ts).
type Handlers = { onAudio: (pcm: Buffer) => void; onDone: () => void; marks?: VoiceTimings };

/**
 * The wait before connecting again once the socket closed: doubling from the first after each
 * attempt that fails, up to the last (as remote/relay-client.ts), back to the first once one opens.
 */
const RETRY_MS = { min: 500, max: 30_000 };

type CartesiaOptions = {
  /** The socket: the tests' stand-in, else a real one. */
  dial?: (url: string, headers: Record<string, string>) => WebSocket;
  /** The waits, and what waits them (setTimeout): the tests' own. */
  retryMs?: { min: number; max: number };
  wait?: (then: () => void, ms: number) => NodeJS.Timeout;
};

/**
 * One Cartesia TTS socket held open between turns. Each spoken reply is a
 * context: text is pushed as Haiku writes it (`continue: true`) and
 * closed with an empty final chunk.
 */
export class Cartesia {
  private ws: WebSocket | null = null;
  private ready: Promise<void> = Promise.resolve();
  private contexts = new Map<string, Handlers>();
  private retry: NodeJS.Timeout | null = null;
  private failures = 0;

  private readonly o: CartesiaOptions;

  constructor(o: CartesiaOptions = {}) {
    this.o = o;
  }

  connect() {
    const url = `wss://api.cartesia.ai/tts/websocket?cartesia_version=${config.cartesiaVersion}`;
    const headers = { "X-API-Key": config.cartesiaKey, "Cartesia-Version": config.cartesiaVersion };
    const ws = this.o.dial ? this.o.dial(url, headers) : new WebSocket(url, { headers });
    this.ws = ws;
    let opened = false;
    this.ready = new Promise((resolve, reject) => {
      ws.once("open", () => {
        opened = true;
        this.failures = 0;
        resolve();
      });
      ws.once("error", reject);
    });
    ws.on("message", (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        console.error("[cartesia] a message that isn't JSON:", (err as Error).message);
        return;
      }
      this.onMessage(msg);
    });
    ws.on("error", (err) => console.error("[cartesia]", err.message));
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const h of this.contexts.values()) h.onDone();
      this.contexts.clear();
      if (!opened) this.failures++;
      this.reconnect();
    });
    return this.ready;
  }

  /**
   * Connects again, after a wait. Its promise was once dropped, so an attempt that failed (offline,
   * just after waking) was an unhandled rejection, every 500 ms;
   * now it's logged, and the failed socket's close tries again, a longer wait each time.
   */
  private reconnect() {
    const { min, max } = this.o.retryMs ?? RETRY_MS;
    const ms = Math.min(max, min * 2 ** Math.max(0, this.failures - 1));
    const again = () => {
      this.retry = null;
      this.connect().catch((err: Error) => log("cartesia_reconnect_failed", { error: err.message, failures: this.failures }));
    };
    this.retry = this.o.wait ? this.o.wait(again, ms) : setTimeout(again, ms);
  }

  /** Start a spoken reply. Returns functions to push text, end it, or cancel it. */
  async open(handlers: Handlers, voiceId = config.cartesiaVoice) {
    await this.ready;
    const contextId = randomUUID();
    this.contexts.set(contextId, handlers);
    let chars = 0;
    const send = (transcript: string, more: boolean) => {
      chars += transcript.length;
      this.ws?.send(
        JSON.stringify({
          model_id: config.cartesiaModel,
          voice: { id: voiceId },
          language: "en",
          context_id: contextId,
          output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: TTS_SAMPLE_RATE },
          max_buffer_delay_ms: config.cartesiaBufferMs,
          // When each word is said, for the phone's read-along: exact, in seconds of this context's audio.
          ...(handlers.marks ? { add_timestamps: true } : {}),
          transcript,
          continue: more,
        }),
      );
    };
    return {
      push: (text: string) => send(text, true),
      /** Characters sent so far; Cartesia bills one credit per character. */
      chars: () => chars,
      end: () => send("", false),
      cancel: () => {
        this.contexts.delete(contextId);
        this.ws?.send(JSON.stringify({ context_id: contextId, cancel: true }));
      },
    };
  }

  close() {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private onMessage(msg: any) {
    const handlers = this.contexts.get(msg.context_id);
    if (!handlers) return;
    if (msg.type === "chunk" && msg.data) handlers.onAudio(Buffer.from(msg.data, "base64"));
    const t = msg.type === "timestamps" ? msg.word_timestamps : null;
    if (t && Array.isArray(t.words) && Array.isArray(t.start)) {
      try {
        handlers.marks?.timestamps(t.words, t.start, Array.isArray(t.end) ? t.end : t.start);
      } catch (err) {
        console.error("[cartesia] timestamps:", (err as Error).message);
      }
    }
    if (msg.type === "error") console.error("[cartesia]", msg.title ?? msg.error_code, msg.message ?? "");
    if (msg.done) {
      this.contexts.delete(msg.context_id);
      handlers.onDone();
    }
  }
}
