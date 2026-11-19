// Opus on the Mac, for the phone's audio: native/macos/opus.swift, Apple's own codec (AudioToolbox,
// the one the iPhone has). One helper serves every stream (each press's decoder, the voice's
// encoder), started as the first is made and again after it exits. Each stream's answers come in
// the order asked (the helper answers every open, push and flush once).
import { spawn, type ChildProcess } from "node:child_process";
import { log } from "../../core/log.ts";
import type { Opus, OpusStream } from "../types.ts";
import { buildNative } from "./native.ts";

type Waiter = { resolve: (out: Buffer) => void; reject: (err: Error) => void };

class Helper {
  private proc: ChildProcess | null = null;
  private waiting = new Map<number, Waiter[]>();
  private next = 1;
  private built: boolean | null = null;

  available() {
    if (this.built === null) {
      try {
        buildNative("opus");
        this.built = true;
      } catch (err) {
        this.built = false;
        log("error", { where: "opus_build", message: err instanceof Error ? err.message : String(err) });
      }
    }
    return this.built;
  }

  /** A new stream id; the helper opens it with `type` ("E" or "D") and `payload`. */
  open(type: "E" | "D", payload: Buffer) {
    const id = this.next++;
    void this.ask(type, id, payload).catch(() => {}); // a failed open shows in the stream's next answer
    return id;
  }

  ask(type: "P" | "F" | "E" | "D", id: number, payload: Buffer = Buffer.alloc(0)): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (!this.write(type, id, payload)) return reject(new Error("opus helper isn't running"));
      const list = this.waiting.get(id) ?? [];
      list.push({ resolve, reject });
      this.waiting.set(id, list);
      this.hold();
    });
  }

  /** Keeps the process (and a test) alive only while an answer is awaited. */
  private hold() {
    const busy = [...this.waiting.values()].some((list) => list.length > 0);
    const handles = [this.proc, this.proc?.stdout, this.proc?.stdin] as Array<{ ref?: () => void; unref?: () => void } | null | undefined>;
    for (const h of handles) (busy ? h?.ref : h?.unref)?.call(h);
  }

  close(id: number) {
    this.write("C", id, Buffer.alloc(0));
    for (const w of this.waiting.get(id) ?? []) w.reject(new Error("closed"));
    this.waiting.delete(id);
    this.hold();
  }

  private write(type: string, id: number, payload: Buffer) {
    const proc = this.start();
    if (!proc?.stdin?.writable) return false;
    const header = Buffer.alloc(9);
    header.write(type, 0, "ascii");
    header.writeUInt32LE(id, 1);
    header.writeUInt32LE(payload.length, 5);
    proc.stdin.write(Buffer.concat([header, payload]));
    return true;
  }

  private start() {
    if (this.proc) return this.proc;
    if (!this.available()) return null;
    const proc = spawn(buildNative("opus"), [], { stdio: ["pipe", "pipe", "inherit"] });
    this.proc = proc;
    proc.stdin!.on("error", () => {});
    let rest: Buffer = Buffer.alloc(0);
    proc.stdout!.on("data", (chunk: Buffer) => {
      rest = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      while (rest.length >= 9) {
        const length = rest.readUInt32LE(5);
        if (rest.length < 9 + length) break;
        const type = String.fromCharCode(rest[0]);
        const id = rest.readUInt32LE(1);
        const payload = Buffer.from(rest.subarray(9, 9 + length));
        rest = rest.subarray(9 + length);
        const w = this.waiting.get(id)?.shift();
        if (!this.waiting.get(id)?.length) this.waiting.delete(id);
        if (type === "o") w?.resolve(payload);
        else w?.reject(new Error(payload.toString("utf8") || "opus failed"));
      }
      this.hold();
    });
    proc.on("exit", (code) => {
      if (this.proc === proc) this.proc = null;
      log("error", { where: "opus_exit", code });
      const waiting = [...this.waiting.values()].flat();
      this.waiting.clear();
      for (const w of waiting) w.reject(new Error("opus helper exited"));
    });
    return proc;
  }
}

const helper = new Helper();

function stream(id: number): OpusStream {
  return {
    push: (data) => helper.ask("P", id, data),
    flush: () => helper.ask("F", id),
    close: () => helper.close(id),
  };
}

const u32s = (...values: number[]) => {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeUInt32LE(v, i * 4));
  return b;
};

export const opus: Opus = {
  available: () => helper.available(),
  encoder: (rate, bitrate) => stream(helper.open("E", u32s(rate, bitrate))),
  decoder: (rate) => stream(helper.open("D", u32s(rate))),
};
