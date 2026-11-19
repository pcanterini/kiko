import { createInterface } from "node:readline";
import type { Hotkey as PushToTalkKey } from "../types.ts";
import { log } from "../../core/log.ts";
import { TITLE } from "../../core/name.ts";
import { type Broker, spawnHelper, startAgain, type HelperProcess } from "./helper-app.ts";
import { helperErr, helperStderr } from "./native.ts";

// macOS virtual keycodes.
export const KEYS: Record<string, number> = {
  right_option: 61,
  left_option: 58,
  right_command: 54,
  right_control: 62,
  right_shift: 60,
  fn: 63,
  f13: 105,
  f14: 107,
  f15: 113,
  f16: 106,
  f17: 64,
  f18: 79,
  f19: 80,
};

/** What a Hotkey is given: the tests' fake app (`via`), what's said and logged, the tries' waits. */
type HotkeyOptions = { via?: Broker; say?: (line: string) => void; log?: (event: string, fields: Record<string, unknown>) => void; againMs?: number[] };

/**
 * Global push-to-talk key via a small macOS event-tap helper (native/macos/hotkey.swift).
 * uiohook-napi was dropped: on this macOS it never reports key releases.
 * Should its helper die once listening (the helper app killed by macOS's "Quit & Reopen" after a
 * permission is turned on), it's started again (startAgain), the key going on as before: logged
 * (hotkey_died, then hotkey_restarted or hotkey_restart_failed), said only when it didn't come back.
 */
export class Hotkey implements PushToTalkKey {
  private proc: HelperProcess | null = null;
  private keycode: number;
  private stopped = false;
  private readonly o: HotkeyOptions;
  /** A key held as its helper died: its release is told, so a press isn't left open. */
  private down = false;

  onDown: () => void = () => {};
  onUp: () => void = () => {};

  constructor(name: string, o: HotkeyOptions = {}) {
    this.o = o;
    // A name from KEYS, or "keycode:<n>" for a key captured in settings or first-run setup.
    const keycode = KEYS[name] ?? (/^keycode:\d+$/.test(name) ? Number(name.slice(8)) : undefined);
    if (keycode === undefined) {
      throw new Error(`Unknown HOTKEY "${name}". Options: ${Object.keys(KEYS).join(", ")}, or keycode:<n>`);
    }
    this.keycode = keycode;
  }

  private log(event: string, fields: Record<string, unknown>) {
    (this.o.log ?? log)(event, fields);
  }

  start(): Promise<void> {
    this.stopped = false;
    // Through the helper app (helper-app.ts): Input Monitoring is the app's permission, not the terminal's.
    const proc = spawnHelper("hotkey", [String(this.keycode)], { stdin: "ignore", stdout: "pipe", stderr: helperErr() }, this.o.via);
    helperStderr("hotkey", proc);
    this.proc = proc;
    let ready = false;
    return new Promise((resolve, reject) => {
      createInterface({ input: proc.stdout! }).on("line", (line) => {
        if (this.proc !== proc) return;
        if (line === "ready") {
          ready = true;
          resolve();
        } else if (line === "down") {
          this.down = true;
          this.onDown();
        } else if (line === "up") {
          this.down = false;
          this.onUp();
        }
      });
      proc.on("exit", (code, signal) => {
        if (!ready) {
          if (this.proc === proc) this.proc = null;
          return reject(new Error(`hotkey helper exited (${code ?? signal})`));
        }
        if (this.proc !== proc) return; // stopped
        this.proc = null;
        this.log("hotkey_died", { code, signal, held: this.down, via: proc.via });
        if (this.down) {
          this.down = false;
          this.onUp();
        }
        void this.comeBack();
      });
    });
  }

  /** Started again after its helper died; said only when it didn't come back. */
  private async comeBack() {
    const r = await startAgain(() => this.start(), { stopped: () => this.stopped || this.proc !== null, delays: this.o.againMs });
    if (!r) return;
    if (r.ok) {
      if (this.stopped) return this.stop();
      this.log("hotkey_restarted", { ms: r.ms, tries: r.tries, via: this.proc?.via ?? null });
      return;
    }
    this.log("hotkey_restart_failed", { why: r.why, ms: r.ms, tries: r.tries });
    (this.o.say ?? ((line: string) => console.error(line)))(`The talk key stopped and didn't come back: ${r.why}. Restart ${TITLE} to try again.`);
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    this.stopped = true;
    proc?.kill();
  }
}

/** Waits for the next key you press anywhere and returns its name (from KEYS) or "keycode:<n>". */
export function captureKey(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawnHelper("hotkey", ["capture"], { stdin: "ignore", stdout: "pipe", stderr: helperErr() });
    helperStderr("hotkey", proc);
    createInterface({ input: proc.stdout! }).on("line", (line) => {
      if (!line.startsWith("key ")) return;
      const code = Number(line.slice(4));
      resolve(Object.entries(KEYS).find(([, c]) => c === code)?.[0] ?? `keycode:${code}`);
    });
    proc.on("exit", (code) => code !== 0 && reject(new Error(`hotkey helper exited (${code})`)));
  });
}
