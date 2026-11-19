import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import type { LocalVoice, VoiceInfo } from "../types.ts";

/**
 * Free local voice: macOS `say`, as an alternative to Cartesia (KIKO_TTS=say). It plays through the
 * system directly rather than the player helper, and speaks once the reply text is complete.
 */
export class Say implements LocalVoice {
  private proc: ChildProcess | null = null;
  private voice: string | undefined;
  private rate: string | undefined;

  onStart: () => void = () => {};
  onEnd: () => void = () => {};

  constructor(voice?: string, rate?: string) {
    this.voice = voice;
    this.rate = rate;
  }

  /** Same shape as Cartesia's open(): push text, end to speak it, cancel to cut it. onDone: it has finished. */
  async open(onDone: () => void = () => {}) {
    let text = "";
    let cancelled = false;
    return {
      push: (delta: string) => {
        text += delta;
      },
      chars: () => text.length,
      end: () => {
        if (cancelled || !text.trim()) return onDone();
        this.speak(text, onDone);
      },
      cancel: () => {
        cancelled = true;
        this.stop();
      },
    };
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    proc?.kill();
  }

  private speak(text: string, onDone: () => void) {
    this.stop();
    const args = [...(this.voice ? ["-v", this.voice] : []), ...(this.rate ? ["-r", this.rate] : [])];
    const proc = spawn("say", args, { stdio: ["pipe", "ignore", "ignore"] });
    this.proc = proc;
    proc.stdin!.end(text);
    proc.on("spawn", () => this.onStart());
    proc.on("error", onDone); // couldn't start; no exit follows
    proc.on("exit", () => {
      if (this.proc === proc) this.proc = null;
      this.onEnd();
      onDone();
    });
  }
}

/** English voices installed on this Mac. */
export function macVoices(): VoiceInfo[] {
  // Lines look like "Albert              en_US    # Hello! My name is Albert."
  return execFileSync("say", ["-v", "?"], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.match(/^(.+?)\s{2,}([a-z]{2}[_-][A-Za-z]+)\s+#/))
    .filter((m): m is RegExpMatchArray => Boolean(m && m[2].startsWith("en")))
    .map((m) => ({ name: m[1].trim(), locale: m[2] }));
}

/** Says `text` once, resolving when it's done: voice previews (the settings screen and first-run setup). */
export function saySample(text: string, voice?: string, rate?: string): Promise<void> {
  return new Promise((resolve) => {
    const args = [...(voice ? ["-v", voice] : []), ...(rate ? ["-r", rate] : []), text];
    spawn("say", args, { stdio: "ignore" }).on("exit", () => resolve());
  });
}
