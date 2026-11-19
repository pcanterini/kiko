import { createInterface } from "node:readline";
import { MIC_SAMPLE_RATE } from "../../core/config.ts";
import { log } from "../../core/log.ts";
import type { LocalTranscriber } from "../types.ts";
import { spawnHelper, type HelperProcess } from "./helper-app.ts";
import { helperErr, helperStderr } from "./native.ts";

const FINALIZE_TIMEOUT_MS = 2000;

/**
 * On-device speech-to-text via Apple's SpeechAnalyzer (native/macos/speech.swift), a drop-in for
 * Deepgram. The helper stays up between presses with the model loaded; each press is tagged
 * with an id so a late answer from an earlier press can't leak into the current one. Words to
 * expect (setHints) go to it as contextual strings.
 * The first run on a Mac may download the en-US model before "ready".
 */
export class AppleTranscriber implements LocalTranscriber {
  private proc: HelperProcess | null = null;
  private press = 0;
  private interim = "";
  /** The press waiting on its final transcript; a new press may already be under way. */
  private pending: { id: number; text: string; done: (text: string) => void } | null = null;
  private bytesSent = 0;
  private closed = false;
  // Contextual strings (stt-hints.ts): words to expect, given to the helper for its next press.
  private hints: string[] = [];
  // The helper's last error, for why it stopped (an unsupported Mac, no speech model).
  private lastError = "";

  onInterim: (text: string) => void = () => {};
  /** It came back after a crash: anything begun before is gone. */
  onRestarted: () => void = () => {};

  connect(): Promise<void> {
    this.closed = false;
    // Through the helper app (helper-app.ts), as the mic: whatever speech recognition asks is the app's.
    const proc = spawnHelper("speech", [], { stdin: "pipe", stdout: "pipe", stderr: helperErr() });
    helperStderr("speech", proc);
    this.proc = proc;
    proc.stdin!.on("error", () => {});
    if (this.hints.length) this.write("C", Buffer.from(JSON.stringify(this.hints)));
    let ready = false;
    return new Promise((resolve, reject) => {
      createInterface({ input: proc.stdout! }).on("line", (line) => {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.type === "ready") {
          ready = true;
          resolve();
        } else if (msg.type === "status") console.log(`[apple-stt] ${msg.message}`);
        else if (msg.type === "error") {
          this.lastError = String(msg.message);
          console.error(`[apple-stt] ${msg.message}`);
          // In the log too: a press whose transcription failed partway shows only the words before.
          log("error", { where: "apple_stt", message: this.lastError, press: this.press });
        } else this.onMessage(msg);
      });
      proc.on("exit", (code) => {
        if (this.proc !== proc) return;
        this.proc = null;
        log("error", { where: "apple_stt_exit", code, message: this.lastError || null });
        reject(new Error(`speech helper exited (${code})${this.lastError ? `: ${this.lastError}` : ""}`));
        this.pending?.done(this.pending.text);
        // Restart after a crash so the next press finds a warm recognizer; a helper that
        // never got ready (unsupported Mac, model download failed) stays down.
        if (ready && !this.closed)
          setTimeout(
            () =>
              this.connect().then(
                () => this.onRestarted(),
                () => {},
              ),
            500,
          );
      });
    });
  }

  begin() {
    this.press++;
    this.bytesSent = 0;
    this.interim = "";
    const id = Buffer.alloc(4);
    id.writeUInt32LE(this.press);
    this.write("B", id);
  }

  send(chunk: Buffer) {
    if (!this.proc) return;
    this.write("A", chunk);
    this.bytesSent += chunk.length;
  }

  /** Flush buffered audio and resolve with the full transcript for this press. */
  finish(): Promise<string> {
    // No await before "E" goes out: begin() may follow right away for the next press.
    return new Promise((resolve) => {
      const pending = { id: this.press, text: this.interim, done: (text: string) => {} };
      const timer = setTimeout(() => pending.done(pending.text), FINALIZE_TIMEOUT_MS);
      pending.done = (text) => {
        clearTimeout(timer);
        if (this.pending === pending) this.pending = null;
        resolve(text);
      };
      this.pending = pending;
      if (!this.proc) return pending.done(pending.text);
      this.write("E");
    });
  }

  /**
   * The words to expect, as SpeechAnalyzer contextual strings. The helper sets them on the
   * analyzer it keeps warm for the next press, so the key going down doesn't wait on them.
   * SpeechTranscriber takes them but, so far, writes the same (see native/macos/speech.swift).
   */
  setHints(terms: string[]) {
    if (terms.join("\n") === this.hints.join("\n")) return;
    this.hints = [...terms];
    this.write("C", Buffer.from(JSON.stringify(this.hints)));
  }

  hinted() {
    return this.hints.length > 0;
  }

  /** Seconds of audio sent since begin(); on-device, so it costs nothing. */
  audioSeconds() {
    return this.bytesSent / (MIC_SAMPLE_RATE * 2);
  }

  close() {
    this.closed = true;
    const proc = this.proc;
    this.proc = null;
    proc?.kill();
  }

  private onMessage(msg: any) {
    const pending = this.pending?.id === msg.id ? this.pending : null;
    if (msg.type === "interim") {
      if (pending) pending.text = msg.text;
      if (msg.id === this.press) {
        this.interim = msg.text;
        this.onInterim(this.interim);
      }
    } else if (msg.type === "final") {
      pending?.done(msg.text);
    }
  }

  private write(type: "B" | "A" | "E" | "C", payload: Buffer = Buffer.alloc(0)) {
    const header = Buffer.alloc(5);
    header.write(type, 0, "ascii");
    header.writeUInt32LE(payload.length, 1);
    this.proc?.stdin?.write(Buffer.concat([header, payload]));
  }
}
