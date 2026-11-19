/**
 * Hands-free from a phone (the iPhone app's Settings → Hands-free): the phone keeps its mic open
 * while its app is in front and sends what it hears while someone talks (a level gate on the phone,
 * with a moment before so the name isn't clipped; nothing while it plays Kiko's voice), and the Mac
 * listens to it exactly as it listens to its own mic: a HandsFree (hands-free.ts) of its own per
 * phone, with Apple's on-device speech-to-text, wake.ts's Listener, the same name, quiet, reply
 * window and deaf window. One brain: nothing about listening is decided on the phone.
 *
 * Its deaf window is the phone's own, where the phone says (hands_free_playing, `playing`): the
 * phone plays the app's voice later than the Mac sends it (the network, its playback buffer) and
 * sends nothing while it plays and a moment after, so its listener is back when the phone says its
 * mic is, and a voice there at once (the reply window's quiet room) is judged from then. A phone
 * that doesn't say keeps the Mac's timing (DEAF_TAIL_MS after the app stopped).
 *
 * Each phone has at most one listener; the Mac's own hands-free goes on as it is, beside them. What
 * one hears is acted on as the phone's push-to-talk words are (the app's talk.ts): replies play on
 * the phone with Play on phone. The phone is told what its listener is doing (`state`): on, woken
 * (`by`), and the talk its words became (`talkId`), so it shows "Listening for Kiko" and the woken
 * state, and what became of the words as for a press.
 *
 * Logged as the Mac's own are, with `phone_` before each event and the phone's id: phone_hands_free
 * (on, off, why it couldn't), phone_wake, phone_wake_dropped, phone_listen_ignored (a count only),
 * phone_listen_restarted. Never the audio, and never what it ignored.
 */
import type { LocalTranscriber } from "../platform/types.ts";
import type { Clock } from "./clock.ts";
import { HandsFree, type HandsFreeOptions, type Request } from "./hands-free.ts";
import type { By, Timing } from "./wake.ts";

/** What a phone is told of its listener (protocol hands_free_state). */
export type PhoneListenState = {
  /** Listening for the name now. */
  on: boolean;
  /** Woken: by the name, or a reply in a session's window; null while only listening. */
  by: By | null;
  /** The talk the words it heard became (talk_status follows), as a press's talkId. */
  talkId?: string;
  /** Why it couldn't listen (Apple's speech-to-text isn't there). */
  error?: string;
};

type PhoneListenersOptions = {
  /** The dictionary's fixes. */
  fix: (text: string) => string;
  /** The app speaks or plays a cue, or the floor is someone else's: this phone's listener is deaf. */
  talking: (listener: HandsFree) => boolean;
  /** A session's reply window is open, and replies without the name are on. */
  replyWindow: () => boolean;
  /** What the session waiting asked (wake.ts Asks): one word answers a yes or no, or a choice. */
  asks?: HandsFreeOptions["asks"];
  /** Something the status shows changed: a reply window needs the name. */
  changed?: () => void;
  /** Words to act on began on this phone: hold the floor. False when it isn't free (someone else holds it). */
  holding: (phoneId: string, listener: HandsFree, by: By) => boolean;
  /** It heard the name: the cue, on the phone. */
  named: (phoneId: string, listener: HandsFree) => void;
  /** The words to act on, final: as the phone's push-to-talk words. */
  request: (phoneId: string, listener: HandsFree, text: string, heard: Request) => void;
  /** The name, then nothing (or the listener went): let the floor go. */
  dropped: (phoneId: string, listener: HandsFree) => void;
  /** Live words once it's awake, for the caption. */
  interim: (text: string) => void;
  level: (level: number) => void;
  /** Tell the phone (hands_free_state). */
  state: (phoneId: string, state: PhoneListenState) => void;
  log: (event: string, fields: Record<string, unknown>) => void;
  timing?: Partial<Timing>;
  transcriber?: () => LocalTranscriber;
  clock?: Clock;
};

/** A phone's audio as the listener's "mic": open while it listens, fed by what the phone sends. */
class PhoneMic {
  private sink: ((chunk: Buffer) => void) | null = null;
  open(sink: (chunk: Buffer) => void) {
    this.sink = sink;
  }
  close() {
    this.sink = null;
  }
  feed(pcm: Buffer) {
    this.sink?.(pcm);
  }
}

type Entry = { listener: HandsFree; mic: PhoneMic; frames: number };

export class PhoneListeners {
  private readonly o: PhoneListenersOptions;
  private readonly phones = new Map<string, Entry>();

  constructor(options: PhoneListenersOptions) {
    this.o = options;
  }

  /** The listeners there are now, each with its phone. */
  all(): Array<{ phoneId: string; listener: HandsFree }> {
    return [...this.phones].map(([phoneId, e]) => ({ phoneId, listener: e.listener }));
  }

  /** The phone whose listener this is. */
  phoneOf(listener: HandsFree | null): string | null {
    for (const [phoneId, e] of this.phones) if (e.listener === listener) return phoneId;
    return null;
  }

  /** Whether this phone's listener is listening now. */
  listening(phoneId: string) {
    return this.phones.get(phoneId)?.listener.on ?? false;
  }

  /**
   * Starts listening for a phone (its Hands-free on, its app in front): its own speech-to-text.
   * Null once it's on; else why it can't, said to the phone too, and nothing was left running.
   * Already on: said again (a phone that reconnected).
   */
  async on(phoneId: string): Promise<string | null> {
    const had = this.phones.get(phoneId);
    if (had) {
      // A phone that connected again says afresh whether it plays.
      had.listener.phonePlaying(false);
      const why = await had.listener.start();
      if (this.phones.get(phoneId) === had && !why) this.o.state(phoneId, { on: true, by: had.listener.by });
      return why;
    }
    const mic = new PhoneMic();
    const log = (event: string, fields: Record<string, unknown>) => this.o.log(`phone_${event}`, { phoneId, ...fields });
    const entry: Entry = { listener: null as unknown as HandsFree, mic, frames: 0 };
    // It holds the floor for what it's hearing now (holding said yes): only then its cue.
    let held = false;
    const listener = new HandsFree({
      mic,
      fix: this.o.fix,
      talking: () => this.o.talking(listener),
      replyWindow: this.o.replyWindow,
      asks: this.o.asks,
      changed: this.o.changed,
      holding: (by) => {
        held = this.o.holding(phoneId, listener, by);
        if (held) this.o.state(phoneId, { on: true, by });
        // Someone else holds the floor: what it heard goes, once this callback is over.
        else queueMicrotask(() => listener.drop());
      },
      named: () => held && this.o.named(phoneId, listener),
      request: (text, heard) => this.o.request(phoneId, listener, text, heard),
      dropped: () => {
        this.o.dropped(phoneId, listener);
        if (this.phones.get(phoneId) === entry) this.o.state(phoneId, { on: listener.on, by: null });
      },
      interim: this.o.interim,
      level: this.o.level,
      log,
      timing: this.o.timing,
      transcriber: this.o.transcriber,
      clock: this.o.clock,
      // The phone sends only while someone talks: the deaf window is watched between its chunks.
      sparse: true,
    });
    entry.listener = listener;
    this.phones.set(phoneId, entry);
    const why = await listener.start();
    if (this.phones.get(phoneId) !== entry) return null; // turned off meanwhile
    if (why) {
      this.phones.delete(phoneId);
      this.o.log("phone_hands_free", { phoneId, on: false, error: why });
      this.o.state(phoneId, { on: false, by: null, error: why });
      return why;
    }
    this.o.log("phone_hands_free", { phoneId, on: true });
    this.o.state(phoneId, { on: true, by: null });
    return null;
  }

  /** Stops a phone's listener (its Hands-free off, its app gone to the background, the phone gone). */
  off(phoneId: string, why: "phone" | "away" | "gone" = "phone") {
    const entry = this.phones.get(phoneId);
    if (!entry) return;
    this.phones.delete(phoneId);
    entry.listener.stop(); // its words coming in: dropped, and the floor they held goes
    this.o.log("phone_hands_free", { phoneId, on: false, why, ...(entry.frames ? { audioChunks: entry.frames } : {}), ignored: entry.listener.ignored });
    if (why !== "gone") this.o.state(phoneId, { on: false, by: null });
  }

  /** What a phone's mic heard (16 kHz mono 16-bit PCM), while its listener is on. Dropped otherwise. */
  audio(phoneId: string, pcm: Buffer) {
    const entry = this.phones.get(phoneId);
    if (!entry || !entry.listener.on) return;
    entry.frames++;
    entry.mic.feed(pcm);
  }

  /**
   * The phone says it plays the app's voice or a cue (`on`), or that its mic is back (the playback
   * over, and its own moment after): its listener's deaf window follows it (HandsFree.phonePlaying).
   */
  playing(phoneId: string, on: boolean) {
    const entry = this.phones.get(phoneId);
    if (entry?.listener.on) entry.listener.phonePlaying(on);
  }

  /**
   * Someone else took the floor (a press, or another listener woke): every phone listener but
   * `except` drops what it heard, and a phone whose listener was woken is told it isn't now.
   */
  dropAll(except: HandsFree | null) {
    for (const [phoneId, e] of this.phones) {
      if (e.listener === except) continue;
      if (e.listener.drop()) this.o.state(phoneId, { on: e.listener.on, by: null });
    }
  }

  /** Its words were taken (the quiet after them): listening again, and the talk they became. */
  done(phoneId: string, talkId?: string) {
    const e = this.phones.get(phoneId);
    if (e) this.o.state(phoneId, { on: e.listener.on, by: null, ...(talkId ? { talkId } : {}) });
  }

  stopAll() {
    for (const phoneId of [...this.phones.keys()]) this.off(phoneId, "gone");
  }
}
