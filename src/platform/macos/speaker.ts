import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { TTS_SAMPLE_RATE } from "../../core/config.ts";
import { log } from "../../core/log.ts";
import { TITLE } from "../../core/name.ts";
import type { Speaker as SpeakerOut, Stall } from "../types.ts";
import { startAgain } from "./helper-app.ts";
import { buildNative, helperErr, helperStderr } from "./native.ts";

// How long after the helper died mid-run each try to start it again waits (startAgain): a little
// over 7 s in all; past the last, it's said once and not tried again.
const RESTART_MS = [500, 1000, 2000, 4000];
// The backstop: what was written should be over this long after it would have finished playing.
// Past it, the helper is taken for stuck (the helper's own stall check, 5 s with nothing heard, comes
// well before this), and started again.
const BACKSTOP_MS = 10_000;

const msOf = (pcm: Buffer) => ((pcm.length / 2) * 1000) / TTS_SAMPLE_RATE;

/**
 * Plays 24 kHz mono PCM through a long-lived AVAudioEngine helper (native/macos/player.swift).
 * ffplay was dropped: after sitting idle a few seconds it stopped producing sound.
 *
 * An output device change doesn't cost anything queued: the helper plays it on, on the new device
 * ("rerouted", logged), and says idle only once it's all been heard. Should the helper die mid-run,
 * the idle it owed is said here (the floor waits on it) and it's started again for what comes next;
 * sound written meanwhile waits for it.
 *
 * An output that takes no sound (AirPods the Mac still has as its output while they're with the
 * phone) used to leave the floor waiting on an idle for good. The helper gives up on it after a few
 * seconds ("stalled", logged as speaker_stalled with the device and how much went unheard; onStalled,
 * then its idle) and says "back" once sound comes out again (onBack). And whatever happens in the
 * helper, nothing waits on it for good: the backstop gives the idle BACKSTOP_MS after what was written
 * should have finished, said as a stall too, and starts the helper again; the first sound that one
 * plays to the end is "back".
 *
 * A Bluetooth output (AirPods) sleeps on silence and loses the first few hundred ms of what comes
 * after: a whole cue. The helper keeps its link awake from a sound until 30 s after the last, and a
 * cue that finds it asleep waits for it to wake (player.swift): logged as output_route (the output,
 * Bluetooth or not), output_keepalive and cue_preroll.
 *
 * An output that stopped responding (CoreAudio overloaded: every play failing with -10863 "player
 * did not see an IO cycle") is the helper's to get over, without anything here waiting on it: it
 * builds its engine again and tries the line once more (player_retry, player_rebuilt), then on the
 * system's default output (player_fallback_default), and only then gives up on it as a stall, which
 * says the usual "Couldn't play on …" line. The engine is also built again as the output's
 * configuration or the default device changes (player_rebuilt with why).
 *
 * What a reply had left when the output changed under it is right since 2026-11-13: the helper took
 * every slice for heard when its engine stopped by itself (AirPods changing profile as their mic
 * opened or closed), said idle, and the reply stopped mid-sentence with speaker_rerouted
 * unheardMs 0 (player.swift, "What counts as heard"). `output` is the device and, for a Bluetooth
 * one, its rate ("rate", logged as output_format): the profile the volume read belongs to (duck.ts).
 *
 * Both channels (2026-11-14: replies heard in the right ear only with the AirPods' mic held open,
 * their call profile, while every other app played in both; not made to happen again without them):
 * the helper says what it plays into and what it gave each channel ("channels", logged as
 * player_output: at start, each time its engine comes back, as a sound starts and after it ends),
 * so a log of the next time says where a channel went missing (player.swift, "Both channels"). And
 * its engine is a new one after every change of the output's format, also one nothing stopped it
 * for: speaker_rerouted with unheardMs 0 right before a sound is that.
 */
export class Speaker implements SpeakerOut {
  private proc: ChildProcess | null = null;
  private closed = false;
  private sounding = false; // the helper said "playing", and not "idle" since
  private owed = false; // sound was written, and the helper hasn't said "idle" since
  private restarting: Array<{ pcm: Buffer; cue: boolean }> | null = null; // the helper died: sound written until it's back
  private backstopMs: number;
  private endAt = 0; // when what was written would have finished playing
  private writtenMs = 0; // how much was written since the helper's last idle
  private backstop: NodeJS.Timeout | null = null;
  private stalled = false; // the helper said "stalled", and not "idle" since
  private cut = false; // stop() since the last write: its idle doesn't say sound came out
  private gaveUp = false; // the backstop gave up on a helper, and no sound is known to have come out since
  private level = 1; // the gain (volume()): given again to a helper started again
  private route: { device: string | null; bluetooth: boolean } | null = null; // the helper's last "route"

  /** The output now ("AirPods@24000", "MacBook Pro Speakers"); null until the helper says. */
  output: string | null = null;
  /** It changed: another device, or a Bluetooth one's rate (its profile). */
  onOutput: (output: string | null) => void = () => {};

  /** Sound actually started coming out. */
  onPlaying: () => void = () => {};
  /** Everything queued has played (or was stopped). */
  onIdle: () => void = () => {};
  /** The output took none of it for a few seconds, so it was dropped. Its idle follows. */
  onStalled: (stall: Stall) => void = () => {};
  /** The output took sound again after a stall. */
  onBack: () => void = () => {};

  private againMs: number[];
  private spawnHelper: () => ChildProcess;

  /** `againMs`, `spawn`: the waits before each restart, and the helper started; the tests' own. */
  constructor(options: { backstopMs?: number; againMs?: number[]; spawn?: () => ChildProcess } = {}) {
    this.backstopMs = options.backstopMs ?? BACKSTOP_MS;
    this.againMs = options.againMs ?? RESTART_MS;
    this.spawnHelper = options.spawn ?? (() => spawn(buildNative("player"), [], { stdio: ["pipe", "pipe", helperErr()] }));
  }

  start(): Promise<void> {
    const proc = this.spawnHelper();
    helperStderr("player", proc);
    this.proc = proc;
    proc.stdin?.on("error", () => {});
    let ready = false;
    return new Promise((resolve, reject) => {
      // It couldn't be started (gone, not executable): this start fails; never an uncaught error.
      proc.on("error", (err) => {
        if (this.proc === proc && !ready) this.proc = null;
        if (!ready) return reject(err);
        log("error", { where: "player", message: err.message });
      });
      createInterface({ input: proc.stdout! }).on("line", (line) => {
        if (this.proc !== proc) return; // one that was shut down, or given up on
        if (line === "ready") {
          ready = true;
          resolve();
          if (this.level !== 1) this.sendVolume();
          const held = this.restarting ?? [];
          this.restarting = null;
          for (const { pcm, cue } of held) this.write(pcm, cue);
        } else if (line === "playing") {
          this.sounding = true;
          this.onPlaying();
        } else if (line === "idle") {
          // Played to the end (not cut, not given up on) by the helper started again after the
          // backstop: sound comes out, which that helper can't know was in doubt. Said here.
          const back = this.gaveUp && !this.cut && !this.stalled;
          this.sounding = false;
          this.stalled = false;
          this.settle();
          this.onIdle();
          if (back) this.back("idle");
        } else if (line.startsWith("rerouted ")) {
          log("speaker_rerouted", { unheardMs: Number(line.slice(9)) });
        } else if (line.startsWith("stalled ")) {
          // "stalled <ms> <rendering 0|1> <device…>"
          const [ms, rendering, ...name] = line.slice(8).split(" ");
          const stall = { device: name.join(" ") || null, unheardMs: Number(ms) };
          this.stalled = true;
          log("speaker_stalled", { ...stall, rendering: rendering === "1", by: "player" });
          this.onStalled(stall);
        } else if (line === "back") {
          this.back("player");
        } else if (line.startsWith("route ")) {
          // "route <bluetooth 0|1> <device…>": at start, and whenever the output changes.
          const [bt, ...name] = line.slice(6).split(" ");
          this.route = { device: name.join(" ") || null, bluetooth: bt === "1" };
          log("output_route", this.route);
        } else if (line.startsWith("rate ")) {
          // "rate <hz>": the output's sample rate, after each "route" and whenever it changes.
          const rate = Number(line.slice(5));
          const { device = null, bluetooth = false } = this.route ?? {};
          log("output_format", { device, bluetooth, rate });
          const output = device === null ? null : bluetooth && rate > 0 ? `${device}@${rate}` : device;
          if (output === this.output) return;
          this.output = output;
          this.onOutput(output);
        } else if (line.startsWith("channels ")) {
          // "channels <why> <device rate> <device channels> <engine rate> <engine channels> <map> <stereo>
          // <layout> <left> <right>": the output as the device has it and as the helper's engine plays into
          // it, the output unit's channel map, the device's channels for stereo and what they're called, and
          // (why "idle") the level of each channel over the sound that just ended, in dBFS.
          const [why, rate, channels, engineRate, engineChannels, map, stereo, layout, left, right] = line.slice(9).split(" ");
          const given = (text: string | undefined) => (text === undefined || text === "-" ? null : text);
          const level = (text: string | undefined) => (given(text) === null ? null : Number(text));
          log("player_output", {
            why,
            device: this.route?.device ?? null,
            rate: Number(rate),
            channels: Number(channels),
            engineRate: Number(engineRate),
            engineChannels: Number(engineChannels),
            map: given(map),
            stereo: given(stereo),
            layout: given(layout),
            left: level(left),
            right: level(right),
          });
        } else if (line.startsWith("keepalive ")) {
          log("output_keepalive", { on: line === "keepalive on" });
        } else if (line.startsWith("retry ")) {
          // "retry <step 1|2> <why>": a play failed; the engine is built again, then the default output tried.
          const [step, ...why] = line.slice(6).split(" ");
          log("player_retry", { step: Number(step), why: why.join(" ") || null });
        } else if (line.startsWith("rebuilt ")) {
          // "rebuilt <why> <device…>": the engine built again from scratch, on that device.
          const [why, ...name] = line.slice(8).split(" ");
          log("player_rebuilt", { why, device: name.join(" ") || null });
        } else if (line.startsWith("fallback_default ")) {
          log("player_fallback_default", { device: line.slice(17) || null });
        } else if (line.startsWith("waking ")) {
          // "waking <ms> <asleep 0|1>": a cue waits for the Bluetooth link to wake.
          const [ms, asleep] = line.slice(7).split(" ");
          log("cue_preroll", { ms: Number(ms), asleep: asleep === "1" });
        }
      });
      proc.on("exit", (code) => {
        if (this.proc !== proc) return; // shut down
        if (!ready) {
          // Never ready: not this one any more, so nothing is written to it or waits on its exit.
          this.proc = null;
          return reject(new Error(`player helper exited (${code})`));
        }
        this.proc = null;
        log("speaker_died", { code, sounding: this.sounding });
        console.error(`[player] helper exited (${code}); starting it again`);
        if (this.sounding || this.owed) {
          this.sounding = false;
          this.settle();
          this.onIdle();
        }
        this.restarting = [];
        void this.comeBack();
      });
    });
  }

  /** Started again after the helper died (a few tries, a longer wait each: startAgain); said once when it didn't come back. */
  private async comeBack() {
    const r = await startAgain(() => this.start(), { stopped: () => this.closed || this.proc !== null, delays: this.againMs });
    if (!r) return;
    if (r.ok) return void log("speaker_restarted", { ms: r.ms, tries: r.tries });
    log("speaker_restart_failed", { why: r.why, ms: r.ms, tries: r.tries });
    console.error(`[player] the sound helper stopped and didn't come back (${r.why}): nothing is heard until ${TITLE} is restarted`);
    // It won't play what waited for it: over, so nothing waits on it for good.
    if (this.restarting?.length) this.onIdle();
    this.restarting = null;
  }

  /** `cue`: a press's beep, which on a Bluetooth output waits for a sleeping link to wake (player.swift "B"). */
  write(pcm: Buffer, cue = false) {
    if (this.restarting) return void this.restarting.push({ pcm, cue });
    this.owed = true;
    this.cut = false;
    this.writtenMs += msOf(pcm);
    this.endAt = Math.max(this.endAt, Date.now()) + msOf(pcm);
    this.armBackstop();
    this.send(cue ? "B" : "A", pcm);
  }

  /** Cut speech now and drop anything queued. */
  stop() {
    if (this.restarting?.length) {
      // As the helper does: idle, a moment later, for what it had.
      this.restarting = [];
      setImmediate(() => this.onIdle());
    }
    this.cut = true;
    // Its idle comes at once; the backstop now waits only for that.
    if (this.owed) {
      this.endAt = Date.now();
      this.armBackstop();
    }
    this.send("F");
  }

  /** The gain, 0 to 1, from now: what's queued plays on at it (mute.ts). */
  volume(level: number) {
    this.level = Math.min(1, Math.max(0, level));
    if (!this.restarting) this.sendVolume();
  }

  private sendVolume() {
    const payload = Buffer.alloc(4);
    payload.writeFloatLE(this.level);
    this.send("V", payload);
  }

  /** As if the output device changed (for tests): the helper's engine stops and comes back, its queue kept. */
  reroute() {
    this.send("C");
  }

  /** As if the output's format changed under it (for tests: the offline helper only): its engine stops by itself, and its rate changes. */
  formatChange() {
    this.send("D");
  }

  /** As if the device stopped taking sound, or took it again (for tests: the offline helper only). */
  deafen(on: boolean) {
    this.send(on ? "S" : "R");
  }

  /** As if the device stopped responding: the helper's next `count` plays fail (for tests: the offline helper only). */
  failPlays(count: number) {
    const payload = Buffer.alloc(4);
    payload.writeUInt32LE(count);
    this.send("E", payload);
  }

  shutdown() {
    this.closed = true;
    this.clearBackstop();
    const proc = this.proc;
    this.proc = null;
    proc?.kill();
  }

  private armBackstop() {
    this.clearBackstop();
    this.backstop = setTimeout(() => this.giveUp(), Math.max(0, this.endAt - Date.now()) + this.backstopMs);
    this.backstop.unref?.();
  }

  /** Nothing written is owed an idle any more. */
  private settle() {
    this.owed = false;
    this.writtenMs = 0;
    this.clearBackstop();
  }

  private clearBackstop() {
    if (this.backstop) clearTimeout(this.backstop);
    this.backstop = null;
  }

  /**
   * The helper never said idle for what it was given, long after it should have: taken as stuck.
   * Said as a stall (all it was given since its last idle, since how much of that was heard isn't
   * known here, nor the device), and the helper is started again: its exit gives the idle it owed.
   */
  private giveUp() {
    this.backstop = null;
    const proc = this.proc;
    if (!this.owed) return;
    const stall = { device: null, unheardMs: Math.round(this.writtenMs) };
    log("speaker_stalled", { ...stall, rendering: null, by: "backstop" });
    this.gaveUp = true;
    this.onStalled(stall);
    if (proc) return void proc.kill("SIGKILL");
    // No helper to kill (it didn't come back): the idle it owed is said here, so the floor goes on.
    this.settle();
    this.onIdle();
  }

  /** Sound comes out again after a stall: the helper saw it ("player"), or played something to the end after the backstop ("idle"). */
  private back(by: "player" | "idle") {
    this.gaveUp = false;
    log("speaker_back", { by });
    this.onBack();
  }

  private send(type: "A" | "B" | "F" | "V" | "C" | "D" | "S" | "R" | "E", payload: Buffer = Buffer.alloc(0)) {
    const header = Buffer.alloc(5);
    header.write(type, 0, "ascii");
    header.writeUInt32LE(payload.length, 1);
    this.proc?.stdin?.write(Buffer.concat([header, payload]));
  }
}
