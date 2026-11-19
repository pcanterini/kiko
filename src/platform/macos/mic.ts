import { createInterface } from "node:readline";
import { log } from "../../core/log.ts";
import { TITLE } from "../../core/name.ts";
import { parseDevices, parseHold, parseHoldLost, parseUsing, type MicChoice, type MicDevice, type MicHold, type MicHoldLost, type MicUsing } from "../../core/mic-device.ts";
import type { Mic as MicInput } from "../types.ts";
import { type Broker, runHelper, spawnHelper, startAgain, type HelperProcess } from "./helper-app.ts";

/**
 * Push-to-talk microphone via an AVAudioEngine helper (native/macos/mic.swift). The helper process
 * stays up, but the mic is only open between open() and close(), so the menu-bar mic indicator
 * shows only while the key is held; hands-free (hands-free.ts) keeps it open, and
 * open() again only changes where its audio goes. Uses the chosen input device (setDevice), else
 * the system default; the helper falls back to the default while the chosen one is away, and
 * moves over while open. Every capture path (the key, hands-free, the mic test) goes through it.
 *
 * A Bluetooth mic in use (chosen, or the system default: 2026-11-14) is held open by the helper
 * while it's the one in use (2026-11-13, mic.swift
 * held), so its headset stays in its call profile and a press is heard at once: open() and close()
 * then only say what's sent here, the mic indicator stays on, and what it hears outside a press never
 * leaves the helper. The helper decides it (it's told the choice, and sees the device come and go)
 * and says so: onHold as it begins, as its link comes up and as it ends, onHoldLost when something
 * changed under it. Every helper is told the choice as it starts, the system default too (that's
 * what has it hold a Bluetooth default), so one started again after it died holds again.
 *
 * Should the helper die (it did, 2026-10-29, when AirPods came in; and with the helper app, when
 * macOS's "Quit & Reopen" kills the app after a permission is turned on), it's started again (startAgain:
 * a few tries over a few seconds, the app started again with it), open again if it was: before,
 * every press after that heard nothing, with nothing logged. Logged (mic_died, then mic_restarted or
 * mic_restart_failed); said only when it didn't come back.
 */

/** What a Mic is given: the tests' fake app (`via`), what's said and logged, the tries' waits. */
type MicOptions = { via?: Broker; say?: (line: string) => void; log?: (event: string, fields: Record<string, unknown>) => void; againMs?: number[] };

export class Mic implements MicInput {
  private readonly o: MicOptions;
  private proc: HelperProcess | null = null;
  private stopped = false; // stop(): not started again
  private sink: ((chunk: Buffer) => void) | null = null;
  private choice: MicChoice = null;
  /** The input devices, as the helper last listed them (at start, and whenever they change). */
  devices: MicDevice[] = [];
  /** The device it opened last. */
  using: MicUsing | null = null;
  /** Audio has come since open() ("started", or the audio itself), until close(). */
  live = false;
  /** The mic held open between presses, as the helper last said; null: none. */
  hold: MicHold | null = null;

  /** Ms from open() to the first audio buffer; how much of the first syllable risks being cut. */
  onStarted: (ms: number) => void = () => {};
  /** The device list changed: one plugged in or out, or the default moved. */
  onDevices: (devices: MicDevice[]) => void = () => {};
  /** It opened a device, or moved to another while open (`switched`). */
  onUsing: (using: MicUsing) => void = () => {};
  /** The hold began, its link came up, or it ended. */
  onHold: (hold: MicHold) => void = () => {};
  /** Something changed under the hold (the headset left its call profile, its mic went silent…). */
  onHoldLost: (lost: MicHoldLost) => void = () => {};

  constructor(o: MicOptions = {}) {
    this.o = o;
  }

  private log(event: string, fields: Record<string, unknown>) {
    (this.o.log ?? log)(event, fields);
  }

  start(): Promise<void> {
    // Through the helper app (helper-app.ts): the microphone is the app's permission, not the terminal's.
    const proc = spawnHelper("mic", [], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }, this.o.via);
    let ready = false;
    this.proc = proc;
    proc.stdin!.on("error", () => {});
    proc.stdout!.on("data", (chunk: Buffer) => {
      if (this.sink) this.live = true;
      this.sink?.(chunk);
    });
    // Always (2026-11-14), the system default too: the helper holds a Bluetooth mic from when it's
    // told the choice, never before (it would open the AirPods' mic only to close it for the mic you chose).
    this.sendDevice();
    return new Promise((resolve, reject) => {
      createInterface({ input: proc.stderr! }).on("line", (line) => {
        if (line === "ready") {
          ready = true;
          resolve();
        } else if (line.startsWith("started ")) {
          if (this.sink) this.live = true;
          this.onStarted(Number(line.slice(8)));
        } else if (line.startsWith("devices ")) {
          this.devices = parseDevices(line.slice(8));
          this.onDevices(this.devices);
        } else if (line.startsWith("using ")) {
          const using = parseUsing(line.slice(6));
          if (!using) return;
          this.using = using;
          this.onUsing(using);
        } else if (line.startsWith("hold ")) {
          const hold = parseHold(line.slice(5));
          if (!hold) return;
          this.hold = hold.on ? hold : null;
          this.onHold(hold);
        } else if (line.startsWith("hold_lost ")) {
          const lost = parseHoldLost(line.slice(10));
          if (lost) this.onHoldLost(lost);
        } else if (line.startsWith("error")) console.error(`[mic] ${line}`);
      });
      proc.on("exit", (code, signal) => {
        if (!ready) {
          if (this.proc === proc) this.proc = null;
          return reject(new Error(`mic helper exited (${code ?? signal})`));
        }
        if (this.proc !== proc) return; // shut down
        this.proc = null;
        this.log("mic_died", { code, signal, open: this.sink !== null, via: proc.via });
        this.ended("the helper died"); // its hold went with it; the one started again says its own
        void this.comeBack();
      });
    });
  }

  /** Started again after the helper died, open again if it was; said only when it didn't come back. */
  private async comeBack() {
    const r = await startAgain(() => this.start(), { stopped: () => this.stopped || this.proc !== null, delays: this.o.againMs });
    if (!r) return;
    if (r.ok) {
      if (this.stopped) return this.stop();
      if (this.sink) this.proc?.stdin?.write("start\n");
      this.log("mic_restarted", { ms: r.ms, tries: r.tries, open: this.sink !== null, via: this.proc?.via ?? null });
      return;
    }
    this.log("mic_restart_failed", { why: r.why, ms: r.ms, tries: r.tries });
    (this.o.say ?? ((line: string) => console.error(line)))(`The microphone stopped and didn't come back: ${r.why}. Restart ${TITLE} to try again.`);
  }

  /** The device to use from the next open on (null: the system default); open now, it moves at once. */
  setDevice(choice: MicChoice) {
    this.choice = choice;
    this.sendDevice();
  }

  open(sink: (chunk: Buffer) => void) {
    this.sink = sink;
    this.proc?.stdin?.write("start\n");
  }

  close() {
    this.proc?.stdin?.write("stop\n");
    this.sink = null;
    this.live = false;
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    this.stopped = true;
    proc?.kill();
    this.ended("quit");
  }

  /** The helper is gone, and a hold with it (it can't say so itself): said for it. */
  private ended(why: string) {
    const hold = this.hold;
    if (!hold) return;
    this.hold = null;
    this.onHold({ on: false, uid: hold.uid, name: hold.name, why });
  }

  private sendDevice() {
    const c = this.choice;
    this.proc?.stdin?.write(c ? `device ${c.uid.replace(/[\t\n]/g, " ")}\t${c.name.replace(/[\t\n]/g, " ")}\n` : "device\n");
  }
}

/**
 * The input devices, from the helper run once (`mic --list`): opens nothing and needs no permission.
 * Null when it couldn't say (the helper didn't run): not the same as none (a Mac mini with no mic).
 */
export async function inputDevices(): Promise<MicDevice[] | null> {
  const { code, stdout } = await runHelper("mic", ["--list"], 5000);
  if (code !== 0) return null;
  try {
    return Array.isArray(JSON.parse(stdout)) ? parseDevices(stdout) : null;
  } catch {
    return null;
  }
}
