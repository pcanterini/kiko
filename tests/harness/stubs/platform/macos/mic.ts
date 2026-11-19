// T.mic: what the app does with a chunk of audio while the mic is open (the key's, or hands-free's), for a case
// to send one. T.micOpen: whether it's open.
// Devices: T.micDevices, what the stub helper lists (a USB mic, the default, and the built-in mic to start);
// T.setMicDevices(list) changes them, as plugging one in or out does. T.micChoice: the device the app asked
// for (setDevice). Opening reports the device it would use, as the helper's "using" line does.
// T.micSlow: opening gives no audio until T.micStart() (a Bluetooth mic switching to its call profile), as
// the helper's "started" line comes only then.
// The hold (native/macos/mic.swift held): a Bluetooth mic in use, chosen or the system default, is held open, as
// the helper holds it: "hold" said as it begins (the choice, the device coming, the default moving to it; `default`
// when it's held as the system default) and ends (another chosen, the default moved, the device going), and a
// press on it is "held". Its link is up at once (said with T.micLinkMs, 1 unless set) unless T.micLinkSlow is set:
// then it's down until T.micLinkUp(ms), and a press meanwhile gets no audio until then, as on the real one.
// T.micHeld: the held mic's UID (null: none), and T.micLinkLive whether its link is up. T.micHoldLost(what)
// says something changed under it ("hold_lost"). T.micNoLink(): it gave no link and the helper gave up on it (listed
// still: out of your ears, with the iPhone): the hold ends with "no link" and a press takes another mic (the system
// default if that's another device, else the built-in one; T.micAway: its UID) until T.micBack(ms): tried again,
// and its link up.
// A press that's open follows the devices as the helper does (mic.swift follow): T.setMicDevices while open says
// "using" again (`switched`) when the device it should be on changed, and its audio goes on.
import { findMic, heldMic, resolveMic, type MicChoice, type MicDevice, type MicHold, type MicHoldLost, type MicUsing } from "../../../../../src/core/mic-device.ts";

const T = (globalThis as any).T;
T.micDevices ??= [
  { uid: "usb-mic", name: "USB Mic", isDefault: true },
  { uid: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", isDefault: false },
] satisfies MicDevice[];

export class Mic {
  devices: MicDevice[] = T.micDevices;
  using: MicUsing | null = null;
  live = false;
  hold: MicHold | null = null;
  onStarted = (_: number) => {};
  onDevices = (_: MicDevice[]) => {};
  onUsing = (_: MicUsing) => {};
  onHold = (_: MicHold) => {};
  onHoldLost = (_: MicHoldLost) => {};
  private openedAt = 0;
  constructor() {
    T.setMicDevices = (list: MicDevice[]) => {
      T.micDevices = this.devices = list;
      this.onDevices(list);
      this.settle("connected");
    };
    T.micStart = () => {
      if (!T.micOpen || this.live) return;
      this.live = true;
      this.onStarted(1000);
    };
    T.micLinkUp = (ms = 2000) => {
      if (!this.hold || T.micLinkLive) return;
      T.micLinkLive = true;
      this.hold = { ...this.hold, live: true, ms, outRate: 24000 };
      this.onHold(this.hold);
      // A press that was waiting for it hears from now.
      if (T.micOpen && !this.live && this.using?.held) {
        this.live = true;
        this.onStarted(Date.now() - this.openedAt);
      }
    };
    T.micNoLink = () => {
      const was = this.hold;
      if (!was) return;
      this.hold = null;
      T.micHeld = null;
      T.micLinkLive = false;
      T.micAway = was.uid;
      this.onHold({ on: false, uid: was.uid, name: was.name, why: "no link", ...(was.default ? { default: true } : {}) });
      // A press that was waiting on it moves to the mic that stands in (mic.swift giveUp, follow).
      if (T.micOpen && this.using?.uid === was.uid) this.move();
    };
    T.micBack = (ms = 2000) => {
      if (!T.micAway) return;
      T.micAway = null;
      const target = heldMic(T.micChoice ?? null, this.devices);
      if (!target) return;
      const asDefault = this.asDefault(target);
      this.hold = { on: true, uid: target.uid, name: target.name, why: "changed", retry: true, ...asDefault };
      T.micHeld = target.uid;
      this.onHold(this.hold);
      T.micLinkLive = true;
      this.hold = { on: true, uid: target.uid, name: target.name, live: true, ms, outRate: 24000, retry: true, ...asDefault };
      this.onHold(this.hold);
    };
    T.micHoldLost = (what: string, more: Record<string, unknown> = {}) => {
      if (!this.hold) return;
      const wasLive = !!T.micLinkLive;
      if (what !== "output format") T.micLinkLive = false;
      this.onHoldLost({ what, uid: this.hold.uid, name: this.hold.name, wasLive, ...more });
    };
  }
  start() {
    return Promise.resolve();
  }
  setDevice(choice: MicChoice) {
    T.micChoice = choice;
    T.micAway = null; // chosen (again): tried afresh
    this.settle(choice ? "chosen" : "default");
  }
  /** `default`: held as the system default, not as a mic you chose (mic.swift Hold.asDefault). */
  private asDefault(target: MicDevice) {
    return findMic(T.micChoice ?? null, this.devices)?.uid === target.uid ? {} : { default: true };
  }
  /**
   * The hold, as the helper decides it (mic.swift settle): ended for a mic that isn't the one to hold, a press
   * that's open moved where it should be (follow), and the hold begun for the mic that's the one to hold.
   */
  private settle(why: string) {
    if (T.micAway && !this.devices.some((d) => d.uid === T.micAway)) T.micAway = null;
    const target = heldMic(T.micChoice ?? null, this.devices, T.micAway);
    if (this.hold && this.hold.uid !== target?.uid) {
      const was = this.hold;
      this.hold = null;
      T.micHeld = null;
      T.micLinkLive = false;
      const listed = this.devices.some((d) => d.uid === was.uid);
      const moved = !this.devices.some((d) => d.uid === was.uid && d.isDefault);
      const ended = !listed ? "disconnected" : why === "chosen" || why === "default" ? "another mic chosen" : moved ? "default changed" : "chosen mic back";
      this.onHold({ on: false, uid: was.uid, name: was.name, why: ended, ...(was.default ? { default: true } : {}) });
    }
    if (T.micOpen && this.using && resolveMic(T.micChoice ?? null, this.devices, T.micAway).device?.uid !== this.using.uid) this.move();
    if (!target || this.hold) return;
    this.hold = { on: true, uid: target.uid, name: target.name, why, ...this.asDefault(target) };
    T.micHeld = target.uid;
    T.micLinkLive = false;
    this.onHold(this.hold);
    if (!T.micLinkSlow) T.micLinkUp(T.micLinkMs ?? 1);
  }
  /** The device opened, said as the helper's "using" line (`switched`: moved while open); false when it gives no sound yet. */
  private use(switched: boolean) {
    // A mic that gave no link counts as not there (mic.swift choose, away): another stands in.
    const inUse = resolveMic(T.micChoice ?? null, this.devices, T.micAway);
    const held = !!this.hold && this.hold.uid === inUse.device?.uid;
    this.using = {
      uid: inUse.device?.uid ?? "",
      name: inUse.device?.name ?? "",
      fallback: inUse.fallback,
      switched,
      wanted: inUse.wanted,
      ...(held ? { held: true, live: !!T.micLinkLive } : {}),
      ...(inUse.noLink ? { noLink: true } : {}),
    };
    this.onUsing(this.using);
    return !(T.micSlow || (held && !T.micLinkLive));
  }
  /** A press that's open, moved to the device it should be on now (mic.swift follow): "using" again, and its first sound if it had none yet. */
  private move() {
    if (!this.use(true) || this.live) return;
    this.live = true;
    this.onStarted(Date.now() - this.openedAt);
  }
  open(onChunk: (chunk: Buffer) => void) {
    const was = T.micOpen;
    T.mic = onChunk;
    T.micOpen = true;
    if (was) return;
    this.openedAt = Date.now();
    if (!this.use(false)) return;
    this.live = true;
    this.onStarted(1);
  }
  close() {
    T.micOpen = false;
    this.live = false;
  }
  stop() {}
}

export function inputDevices() {
  return Promise.resolve(T.micDevices as MicDevice[]);
}
