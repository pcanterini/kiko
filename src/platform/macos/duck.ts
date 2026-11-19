/**
 * Ducking: while you hold the key to talk, the Mac's output volume drops to a share of what it was
 * (config.duckLevel), so music and videos don't drown you out, and it comes back once recording is
 * over. The whole Mac, not one app: it covers Spotify, YouTube and the rest, and needs no permission.
 * It isn't done while the app speaks: our own voice would drop with it.
 *
 * Each change is one `osascript` run with a short fade in it (~100ms to start), never awaited by
 * push to talk. Runs go one at a time, so a quick release and press can't cross. A muted output, or
 * one with no volume (some HDMI and USB devices), is left alone, and so is one already so low its
 * share would be 0: macOS mutes the output at volume 0, and a restore refused (the volume changed:
 * another output picked, AirPods with a volume of their own) would leave it muted for good (1% ducked
 * to 0, then every press found the output muted). The volume comes back only if it's
 * still what we set: one you changed meanwhile is yours.
 *
 * A volume that reads otherwise at release may be another output's for a moment, not yours: a
 * Bluetooth headset whose mic was opened is in its call profile, with a volume of its own (2026-11-12:
 * AirPods ducked 13 → 3 read 50 at release, so 3 was left, then 1, and the video stayed nearly
 * silent). So the note is kept and the volume looked at again a few times (AGAIN_MS) as the headset
 * goes back: once it reads what we set, it's put back. Meanwhile a press finds it already down and
 * doesn't lower it again.
 *
 * Still otherwise after the last look, the note is kept aside, not dropped (2026-11-13: AirPods ducked
 * 25 → 5 read 43, the call profile's, at every look; back in A2DP they were still at 5, the next press
 * lowered that to 1 and two replies played unheard). A press that finds the volume at the level
 * kept aside doesn't lower it again: it's still ours, and goes back to what it was at release. And
 * before Kiko speaks (beforeSpeech), a volume at or below a level Kiko lowered it to and never put
 * back is put back first: Kiko never speaks into its own duck.
 *
 * Which output the volume read belongs to (2026-11-13, `output`: the player's, speaker.ts: its
 * name, and for a Bluetooth one its rate too, which says its profile). A headset keeps one volume
 * for music and one for calls (AirPods: 38 and 20), and the reading jumps from one to the other
 * when its mic is opened or closed: with the mic held open (mic.swift held), for as long as it's
 * the mic in use. Each note says the output it was lowered on (`on`), and is only ever compared with a
 * volume read on that same output: on another, nothing is read as ours or as yours, nothing is
 * raised or lowered for it, and the note is kept aside until that output is back (outputChanged),
 * when it's looked at again. So a profile's volume that happens to read at or below a level Kiko
 * left on the other one is never "put back" to the other's. A press and its release on one profile
 * (the mic held: always the call one) duck as on any output.
 *
 * What it lowered from and to goes in the state file (app/status.ts writeState), so a run that crashed
 * leaves a note and the next one puts the volume back (leftoverDuck).
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { alive } from "../../core/alive.ts";
import { log } from "../../core/log.ts";
import type { Ducked, VolumeDuck } from "../types.ts";

/** Runs an AppleScript with its arguments; resolves with what it returned. Swapped out in tests. */
export type Runner = (script: string, args: string[]) => Promise<string>;
// Ducked (../types.ts): what the volume was before, and what it was lowered to (as read back: the Mac rounds it).
export type { Ducked };

const runOsascript: Runner = (script, args) =>
  new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script, ...args], { timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
  });

// Down to `level`% in four steps over ~150ms. Returns "<from>,<to>", or why it didn't. Given a level
// Kiko left the volume at (item 2), and it's still there: "ours", nothing lowered.
export const LOWER = `
on run argv
  set level to (item 1 of argv) as integer
  set ours to -1
  if (count of argv) > 1 then set ours to (item 2 of argv) as integer
  set s to get volume settings
  if output muted of s is true then return "muted"
  set v to output volume of s
  if v is missing value then return "no_volume"
  if v = ours then return "ours"
  set target to round (v * level / 100)
  if target ≥ v or target < 1 then return "too_low"
  repeat with i from 1 to 4
    set volume output volume (round (v - (v - target) * i / 4))
    if i < 4 then delay 0.05
  end repeat
  return (v as text) & "," & ((output volume of (get volume settings)) as text)
end run`;

// Back up from <to> to <from> in three quick steps, so a reply right after is at full volume.
// Only if it's still <to> (or, given a third item, at or below it: before Kiko speaks): returns
// "restored", "changed,<now>" or "no_volume".
export const RAISE = `
on run argv
  set original to (item 1 of argv) as integer
  set ours to (item 2 of argv) as integer
  set orLower to (count of argv) > 2
  set v to output volume of (get volume settings)
  if v is missing value then return "no_volume"
  if orLower and v > ours then return "changed," & (v as text)
  if not orLower and v is not ours then return "changed," & (v as text)
  repeat with i from 1 to 3
    set volume output volume (round (v + (original - v) * i / 3))
    if i < 3 then delay 0.03
  end repeat
  return "restored"
end run`;

/** After a restore found the volume changed: when to look again (a headset leaving its call profile took over 7 s, 2026-11-13). */
export const AGAIN_MS = [1000, 2000, 4000, 8000, 15000];

export class Duck implements VolumeDuck {
  /** It lowered or put back the volume: what the state file keeps changed. */
  onChange: () => void = () => {};

  private want = false; // recording: the volume should be down
  private tried = false; // this recording's duck was tried (done, or left alone: muted, no volume)
  private down: Ducked | null = null;
  private aside: Ducked | null = null; // a duck whose restore read another volume at every look: still ours if it reads `to`
  private speech = false; // about to speak: a volume at or below a level of ours comes back first
  private leftover = false; // `down` came from a run that crashed
  private settling: Promise<void> | null = null;
  private enabled: () => boolean;
  private level: () => number;
  private run: Runner;
  private againMs: number[];
  private looks = 0; // restores of `down` that found the volume changed
  private waitUntil = 0; // the next look at a changed volume isn't before this
  private timer: NodeJS.Timeout | undefined;

  private output: () => string | null; // which output (and profile) the volume read now is of; null: not known

  constructor(opts: { enabled: () => boolean; level: () => number; run?: Runner; againMs?: number[]; output?: () => string | null }) {
    this.enabled = opts.enabled;
    this.level = opts.level;
    this.run = opts.run ?? runOsascript;
    this.againMs = opts.againMs ?? AGAIN_MS;
    this.output = opts.output ?? (() => null);
  }

  /** Whether `note` was lowered on the output the volume is read on now (`now`); either not known: taken as the same, as before 2026-11-13. */
  private here(note: Ducked, now = this.output()) {
    return !note.on || !now || note.on === now;
  }

  /** Recording started (after the listening cue): lower the volume. Returns once it's settled. */
  duck(): Promise<void> {
    if (!this.enabled()) return this.settle();
    if (!this.want) this.tried = false;
    this.want = true;
    return this.settle();
  }

  /** Recording is over: put the volume back. */
  restore(): Promise<void> {
    this.want = false;
    return this.settle();
  }

  /**
   * About to speak: a volume Kiko lowered and never put back, still at or below that level, comes
   * back first. Not while you talk (the duck is wanted then). Returns once it's settled.
   */
  beforeSpeech(): Promise<void> {
    if (this.want || !(this.down ?? this.aside)) return this.settle();
    this.speech = true;
    return this.settle();
  }

  /**
   * The output changed (another device, or a headset's other profile): a duck kept aside on the one
   * it is now is looked at again (back if the volume still reads what Kiko left), and one waiting
   * for its next look gets it now. Nothing is touched for the output that was left.
   */
  outputChanged(): Promise<void> {
    if (this.want) return this.settle(); // talking: the release sees to it
    if (!this.down && this.aside?.on && this.aside.on === this.output()) {
      this.down = this.aside;
      this.aside = null;
      this.looks = 0;
    }
    if (this.down) {
      this.waitUntil = 0;
      clearTimeout(this.timer);
    }
    return this.settle();
  }

  /** What's lowered now (or kept aside), for the state file. */
  ducked(): Ducked | null {
    const note = this.down ?? this.aside;
    return note && { ...note };
  }

  /** A duck a crashed run left behind (leftoverDuck): put it back, by the same rule. */
  adopt(left: Ducked): Promise<void> {
    if (!this.down) {
      this.down = { ...left };
      this.leftover = true;
    }
    return this.settle();
  }

  /** On the way out: put the volume back, waiting at most `capMs`. */
  finish(capMs = 1500): Promise<void> {
    this.want = false;
    this.waitUntil = 0; // a look at a changed volume still to come: one now, on the way out
    if (!this.down && this.aside) {
      // One last look at a duck kept aside, as at the next start: back if it still reads ours.
      this.down = this.aside;
      this.aside = null;
      this.leftover = true;
    }
    let timer: NodeJS.Timeout | undefined;
    const cap = new Promise<void>((resolve) => (timer = setTimeout(resolve, capMs)));
    return Promise.race([this.settle(), cap]).finally(() => clearTimeout(timer));
  }

  private pending() {
    if (this.want) return !this.down && !this.tried;
    return (this.speech && (this.down ?? this.aside) !== null) || (this.down !== null && Date.now() >= this.waitUntil);
  }

  private settle(): Promise<void> {
    this.settling ??= this.work().finally(() => {
      this.settling = null;
      if (this.pending()) void this.settle(); // asked for more as the last run ended
    });
    return this.settling;
  }

  private async work() {
    while (this.pending()) {
      if (this.want) {
        this.tried = true;
        this.speech = false; // the duck is wanted now; speech after this press asks again
        await this.lower();
      } else if (this.speech) {
        this.speech = false;
        await this.raiseIfLow();
      } else if (!(await this.raise())) {
        return; // logged; tried again on the next release, on exit, or on the next start
      }
    }
  }

  private async lower() {
    const level = this.level();
    const started = Date.now();
    // A duck kept aside on another output isn't this volume's: lowered as any, the note left where it is.
    const aside = this.aside && this.here(this.aside) ? this.aside : null;
    try {
      const out = await this.run(LOWER, aside ? [String(level), String(aside.to)] : [String(level)]);
      if (out === "ours" && aside) {
        // Still at the level a duck kept aside left it: down already, never lowered from there.
        this.down = aside;
        this.aside = null;
        this.looks = 0;
        this.waitUntil = 0;
        log("duck", { kept: true, volume: aside.from, ducked: aside.to, level, ms: Date.now() - started });
        this.onChange();
        return;
      }
      const [from, to] = out.split(",").map(Number);
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        log("duck", { skipped: out, level, ms: Date.now() - started });
        return;
      }
      const on = this.output();
      this.down = { from, to, ...(on ? { on } : {}) };
      this.leftover = false;
      this.looks = 0;
      this.waitUntil = 0;
      log("duck", { volume: from, ducked: to, level, ms: Date.now() - started });
      this.onChange();
    } catch (err) {
      log("error", { where: "duck", message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async raise() {
    const { from, to, on } = this.down!;
    const started = Date.now();
    const at = this.output();
    if (!this.here(this.down!, at)) {
      // The volume read now is another output's, or the headset's other profile's: not ours to read
      // or to set. Kept aside until the one it was lowered on is back (outputChanged).
      log("unduck", { ducked: to, volume: from, restored: false, why: "output changed", on, output: at, aside: true, ...(this.leftover ? { leftover: true } : {}) });
      // One already aside on this very output takes its place: looked at next.
      const back = this.aside?.on && this.aside.on === at ? this.aside : null;
      this.aside = this.down;
      this.down = back;
      this.leftover = false;
      this.looks = 0;
      this.waitUntil = 0;
      clearTimeout(this.timer);
      this.onChange();
      return true;
    }
    try {
      const out = await this.run(RAISE, [String(from), String(to)]);
      const [result, now] = out.split(",");
      // Changed, maybe only for now (a headset's call profile): looked at again in a moment, the note kept.
      const again = result === "changed" && !this.leftover ? this.againMs[this.looks] : undefined;
      // Still otherwise after the last look: kept aside, not dropped (a press or speech finding it at our level puts it back).
      const aside = result === "changed" && !this.leftover && again === undefined;
      log("unduck", {
        ducked: to,
        volume: from,
        restored: result === "restored",
        ...(result === "restored" ? {} : { why: result, ...(now ? { now: Number(now) } : {}) }),
        ...(this.leftover ? { leftover: true } : {}),
        ...(again !== undefined ? { againInMs: again } : {}),
        ...(aside ? { aside: true } : {}),
        ...(this.looks ? { looks: this.looks } : {}),
        ms: Date.now() - started,
      });
      if (again !== undefined) {
        this.looks++;
        this.waitUntil = Date.now() + again;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.waitUntil = 0;
          void this.settle();
        }, again).unref();
        return true;
      }
      if (aside) this.aside = this.down;
      this.down = null;
      this.leftover = false;
      this.looks = 0;
      this.onChange();
      return true;
    } catch (err) {
      log("error", { where: "unduck", message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  /** Before speech: the newest duck not put back, if the volume is at or below its level, goes back up. */
  private async raiseIfLow() {
    // On the output the volume is read on now only: a level left on a headset's other profile says nothing about this one.
    const note = [this.down, this.aside].find((n) => n && this.here(n));
    if (!note) return;
    const started = Date.now();
    try {
      const out = await this.run(RAISE, [String(note.from), String(note.to), "below"]);
      if (out !== "restored") return; // above it: yours (or another profile's), left alone
      if (note === this.down) {
        this.down = null;
        this.looks = 0;
        this.waitUntil = 0;
        this.leftover = false;
        clearTimeout(this.timer);
      } else this.aside = null;
      log("unduck", { ducked: note.to, volume: note.from, restored: true, by: "speech", ms: Date.now() - started });
      this.onChange();
    } catch (err) {
      log("error", { where: "unduck", message: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * The duck a run that crashed left in its state file, if any. Not one from a run that's still
 * going (two apps sharing the file): that one puts its own back.
 */
export function leftoverDuck(stateFile: string): Ducked | null {
  let state: { pid?: number; ducked?: Partial<Ducked> | null };
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
  const d = state.ducked;
  if (!d || !Number.isFinite(d.from) || !Number.isFinite(d.to)) return null;
  if (state.pid && state.pid !== process.pid && alive(state.pid)) return null;
  return { from: d.from!, to: d.to!, ...(typeof d.on === "string" && d.on ? { on: d.on } : {}) };
}
