// What Kiko needs from the computer it runs on: one small piece per capability, each the shape
// of what the Mac code already does. index.ts picks the platform once, at startup; src/core/ and
// the entry points (app.ts, onboard.ts) reach these pieces only through it, never through ./macos/.
//
// macOS (./macos/) is the only platform. A Linux port would add ./linux/ with its own version of
// each piece below, and a case in index.ts. What it would replace:
//   mic       native/macos/mic.swift (a Core Audio input unit, its devices; a Bluetooth mic in use held open)
//   speech    native/macos/speech.swift (Apple's on-device SpeechAnalyzer); hands-free needs one
//   voice     `say` and its voice list
//   speaker   native/macos/player.swift (plays the voices and cues)
//   hotkey    native/macos/hotkey.swift (a global event tap) and the macOS keycodes
//   volume    the Mac's output volume over `osascript`
//   network   the addresses a phone can reach (interfaces, `tailscale status`), and Bonjour over `dns-sd`
//   presence  native/macos/presence.swift (HID idle time, the screen's lock, the display's sleep), else `ioreg`
//   opus      native/macos/opus.swift (Apple's Opus in AudioToolbox): the phone's audio on the wire
//   permissions native/macos/permissions.swift: the microphone, speech recognition and Input
//             Monitoring, checked and asked for (first-run setup), and their System Settings panes
//   keys      native/macos/keychain.swift (the Keychain): where the API keys are kept. Not in
//             Platform: config.ts reads it while it loads, before the pieces above can (they
//             import config), so ./keys.ts picks it on its own. Off, keys come only from the
//             environment and .env, as on any platform.
// Nor are the terminals sessions run in (tmux, Ghostty) pieces: they're adapters of their own
// (src/terminals/), as the coding agent is (src/agents/).
// Everything else (routing, the floor, sessions, the cloud voices and speech-to-text) is shared.
import type { MicChoice, MicDevice, MicHold, MicHoldLost, MicUsing } from "../core/mic-device.ts";
import type { Speech } from "../core/speech-lock.ts";

/** The microphone. A helper stays up between presses; audio goes to `sink` only between open() and close(). */
export interface Mic {
  /** The input devices, as last listed. */
  devices: MicDevice[];
  /** The device it opened last. */
  using: MicUsing | null;
  /**
   * Whether it has given any audio since it was opened (false while closed): a Bluetooth mic can
   * take seconds to (2026-11-12). Open already (hands-free), a press finds it so at once.
   */
  readonly live: boolean;
  /** Ms from open() to the first audio (a Bluetooth mic's first sound that isn't exact zeros: its link is up). */
  onStarted: (ms: number) => void;
  /** The mic held open between presses (a Bluetooth one in use, chosen or the system default: mic-device.ts heldMic); null or absent: none. */
  readonly hold?: MicHold | null;
  /** The hold began, its link came up, or it ended. */
  onHold?: (hold: MicHold) => void;
  /** Something changed under the hold. */
  onHoldLost?: (lost: MicHoldLost) => void;
  onDevices: (devices: MicDevice[]) => void;
  onUsing: (using: MicUsing) => void;
  start(): Promise<void>;
  /** The device to use (null: the system default); open now, it moves at once. */
  setDevice(choice: MicChoice): void;
  open(sink: (chunk: Buffer) => void): void;
  close(): void;
  stop(): void;
}

/** On-device speech-to-text: free, a drop-in for Deepgram (the same shape), and what hands-free listens with. */
export interface LocalTranscriber {
  onInterim: (text: string) => void;
  /** It came back after a crash: anything begun before is gone. */
  onRestarted: () => void;
  connect(): Promise<void>;
  /** A new press (or phrase) starts. */
  begin(): void;
  send(chunk: Buffer): void;
  /** The full transcript since begin(). */
  finish(): Promise<string>;
  /** Words to expect. */
  setHints(terms: string[]): void;
  hinted(): boolean;
  audioSeconds(): number;
  close(): void;
}

/** The free built-in voice (KIKO_TTS=say). It plays by itself, not through the Speaker, once the text is complete. */
export interface LocalVoice {
  onStart: () => void;
  onEnd: () => void;
  /** Same shape as Cartesia's open(): push text, end to speak it, cancel to cut it. */
  open(onDone?: () => void): Promise<Speech>;
  stop(): void;
}
export type VoiceInfo = { name: string; locale: string };

export type Stall = { device: string | null; unheardMs: number };

/** Plays 24 kHz mono PCM: the voices that stream audio, and the cues. */
export interface Speaker {
  /** Sound actually started coming out. */
  onPlaying: () => void;
  /** Everything queued has played (or was stopped). */
  onIdle: () => void;
  /**
   * The output took none of what was queued for a few seconds (AirPods that are with the phone), so
   * it was dropped: `unheardMs` of it, on `device` (null: not known). Its idle follows.
   */
  onStalled: (stall: Stall) => void;
  /** The output took sound again after a stall. */
  onBack: () => void;
  /**
   * Which output the sound goes to now: its name, and for a Bluetooth one its sample rate too
   * ("AirPods@24000": a headset's profiles, music and calls, differ by it and each keeps its own
   * volume). Null or absent: not known. `onOutput`: it changed.
   */
  readonly output?: string | null;
  onOutput?: (output: string | null) => void;
  start(): Promise<void>;
  /** `cue`: a press's beep: on a Bluetooth output whose link is asleep it waits a moment for it to wake (speech never does). */
  write(pcm: Buffer, cue?: boolean): void;
  /** Cut it now and drop anything queued. */
  stop(): void;
  /**
   * The output's gain, 0 to 1, at once: mid-line too (what's queued plays on at it). Mute (mute.ts)
   * sets 0 and back to 1. It stays until set again, across a helper started again.
   */
  volume(level: number): void;
  shutdown(): void;
}

/** The global push-to-talk key, from any app. */
export interface Hotkey {
  onDown: () => void;
  onUp: () => void;
  start(): Promise<void>;
  stop(): void;
}

/**
 * What the volume was before, and what it was lowered to. `on`: the output it was lowered on
 * (Speaker.output then), when known: a volume read on another one is never taken for this.
 */
export type Ducked = { from: number; to: number; on?: string };

/** Lowers the output volume while you talk, and puts it back after. */
export interface VolumeDuck {
  /** It lowered or put back the volume: what the state file keeps changed. */
  onChange: () => void;
  duck(): Promise<void>;
  restore(): Promise<void>;
  /** About to speak: a volume still at or below a level it lowered it to, never put back, comes back first. */
  beforeSpeech(): Promise<void>;
  /** The output changed (Speaker.onOutput): a duck left on the one it is now is looked at again. */
  outputChanged(): Promise<void>;
  ducked(): Ducked | null;
  /** A duck a crashed run left behind: put it back. */
  adopt(left: Ducked): Promise<void>;
  finish(capMs?: number): Promise<void>;
}

/**
 * An address a phone can connect to: on the local network, or Tailscale's (reachable from anywhere on
 * your tailnet): its IP, or its MagicDNS name (`interface` "MagicDNS").
 */
export type HubAddress = { address: string; kind: "lan" | "tailscale"; interface: string };

/** A service advertised on the local network until stop(). */
export type Advertised = { stop(): void };

/** What the phone server (src/remote/) needs from the computer's network. */
export interface Network {
  /** This computer's addresses a phone could reach, Tailscale's (and its MagicDNS name) included when it's up. */
  addresses(): Promise<HubAddress[]>;
  /** Advertises `name` as a Bonjour service of `type` (e.g. "_kiko._tcp") on `port`, with TXT entries. */
  advertise(name: string, type: string, port: number, txt: Record<string, string>): Advertised;
  /** This computer's name on the local network ("test-mac.local"). */
  hostname(): string;
}

/**
 * Whether someone is at the computer: how long since its keyboard, mouse or trackpad was last used,
 * whether its screen is locked (or another user's session is on it), and whether its display is asleep.
 */
export type AtComputer = { idleMs: number; locked: boolean; asleep: boolean };

/**
 * One Opus stream: an encoder (16-bit mono PCM in, 20 ms packets out) or a decoder (packets in, PCM
 * out). Packets go in and come out each behind a 2-byte big-endian length. Answers come in the order
 * asked; one that fails rejects (and the stream is gone: make a new one).
 */
export interface OpusStream {
  /** PCM to an encoder (what's short of a whole frame waits), packets to a decoder: what came out. */
  push(data: Buffer): Promise<Buffer>;
  /** An encoder pads what's waiting with silence to a whole frame and encodes it; a decoder has nothing to give. */
  flush(): Promise<Buffer>;
  close(): void;
}

/** Opus for the phone's audio (src/remote/opus.ts). */
export interface Opus {
  /** Whether it works here (its helper built); false: the phone gets PCM, as before. */
  available(): boolean;
  encoder(rate: number, bitrate: number): OpusStream;
  decoder(rate: number): OpusStream;
}

/**
 * Where the API keys are kept (core/keys.ts), by their names (OPENROUTER_API_KEY…). A key is passed
 * to it and handed back, never logged, never in a program's arguments. Errors say what went wrong,
 * never with a key in them.
 */
export interface KeyStore {
  /** For what's said: "the Keychain". */
  where: string;
  /** The keys it has of `names` (missing ones left out). Synchronous: config.ts reads them as it loads. */
  get(names: string[]): Record<string, string>;
  /** Saves `key` under `name`, replacing one there. */
  set(name: string, key: string): Promise<void>;
  /** Takes `name` out; false when there was none. */
  remove(name: string): Promise<boolean>;
  /** The names it has (no keys). */
  list(): Promise<string[]>;
}

/** A permission the helpers need: the microphone, speech recognition, Input Monitoring (the talk key). */
export type PermissionId = "mic" | "speech" | "input";
/** Where one stands: "unknown" is never asked yet (and, for Input Monitoring, not granted). */
export type Permission = "granted" | "denied" | "restricted" | "unknown";
export type Permissions = Record<PermissionId, Permission>;

export type Platform = {
  /** `inputs`: the input devices, or null when they can't be told (none at all: an empty list). */
  mic: { create(): Mic; inputs(): Promise<MicDevice[] | null> };
  speech: { create(): LocalTranscriber };
  voice: {
    create(voice?: string, rate?: string): LocalVoice;
    /** The installed voices, for the settings. */
    voices(): VoiceInfo[];
    /** Says `text` once and resolves when it's done: voice previews. */
    sample(text: string, voice?: string, rate?: string): Promise<void>;
  };
  speaker: { create(): Speaker };
  hotkey: {
    /** Key names you can pick, and their keycodes. */
    keys: Record<string, number>;
    /** A name from `keys`, or "keycode:<n>". */
    create(name: string): Hotkey;
    /** The next key pressed anywhere, as a name from `keys` or "keycode:<n>". */
    capture(): Promise<string>;
  };
  volume: {
    /** `output`: which output the volume read now is of (Speaker.output); null: not known. */
    duck(opts: { enabled: () => boolean; level: () => number; output?: () => string | null }): VolumeDuck;
    /** The duck a run that crashed left in the state file, if any. */
    leftover(stateFile: string): Ducked | null;
  };
  network: Network;
  /** Someone at the computer, as far as it can tell now; null when it can't. */
  presence: { atComputer(): Promise<AtComputer | null> };
  opus: Opus;
  permissions: {
    status(): Promise<Permissions>;
    /** The system's own prompt for it, then where it stands. */
    request(which: PermissionId): Promise<Permission>;
    /** Where to turn it on by hand, in words: "Privacy & Security → Microphone". */
    pane(which: PermissionId | "automation"): string;
    /** Opens that pane. */
    open(which: PermissionId | "automation"): void;
    /**
     * Whose permissions they are, by name: the helper app's ("Kiko Dev") when the helpers run in it,
     * null when they're the terminal app's (the helpers are its children: no GUI session, or turned off).
     */
    holder(): Promise<string | null>;
    /**
     * A permission just turned on (Input Monitoring) made to take effect: the helper app started
     * again. False when the helpers are the terminal's: only reopening the terminal app does it then.
     */
    refresh(): Promise<boolean>;
  };
};
