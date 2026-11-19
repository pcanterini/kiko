/**
 * Hands-free mode (settings: Listening → Listen). The mic stays open and Apple's on-device
 * speech-to-text (native/macos/speech.swift, its own helper beside push-to-talk's) transcribes what it
 * hears, so wake.ts's Listener can tell when a phrase starts with the app's name. Nothing leaves the
 * Mac until then: other phrases are dropped and only counted. What follows the name, until about
 * END_SILENCE_MS of quiet, is acted on as push-to-talk words are (app.ts `request`), from the same
 * transcript: nothing is transcribed twice.
 *
 * In a session's reply window, words without the name are its reply (the replyWithoutName
 * setting), but only a real one (wake.ts realReply: two words, or one that answers what it asked),
 * and only when the room was quiet around the app's words: talk without the name just before it
 * spoke, or a voice already there as the mic came back, and that window needs the name
 * (`reply_window_needs_name` in the log, and the status says so).
 *
 * It doesn't hear the app: while the app speaks or plays a cue (`talking`), and DEAF_TAIL_MS after,
 * the mic's audio is dropped and the transcript starts afresh. Apple's echo cancellation (voice
 * processing) would let it listen through that, but it only cancels what plays through the same
 * audio unit, and the app's voice comes from other helpers (player.swift, `say`).
 *
 * Push-to-talk keeps working: while the key is down the mic's audio goes to push-to-talk's
 * speech-to-text instead (app.ts), and comes back here on key up.
 *
 * A phone's hands-free (phone-listen.ts) is another of these, its "mic" the audio the phone sends
 * while someone talks near it: the same listening, the same name, quiet and reply window. A phone
 * plays the app's voice later than the Mac sends it (the network, its playback buffer), and keeps its
 * own mic shut while it plays and a moment after; one that says so (`phonePlaying`) is listened to
 * again when it says its mic is back, not DEAF_TAIL_MS after the Mac stopped sending: the moment the
 * reply window's quiet room is judged from (wake.ts back, ONSET_MS) is the phone's own.
 */
import { platform } from "../platform/index.ts";
import type { LocalTranscriber, Mic } from "../platform/types.ts";
import { type Clock, realClock } from "./clock.ts";
import { Gate, levelOf, Listener, wakeIn, type Asks, type By, type NeedsName, type Timing } from "./wake.ts";

/** After the app's voice or a cue stops, the mic is still dropped this long: the speaker's delay, the room's echo. */
export const DEAF_TAIL_MS = 400;
/**
 * The longest a phone's word that it's playing the app's voice keeps its listener deaf past the app's
 * own end (or past the word, when it came after): a phone that went quiet about it is heard again.
 */
export const PHONE_PLAYING_MAX_MS = 5000;
/** Why a reply window needs the name (wake.ts NeedsName), in the log. */
const NEEDS_NAME_BECAUSE: Record<NeedsName["why"], string> = {
  before: "talk without the name just before the app spoke",
  during: "talk without the name going on as the app started to speak",
  onset: "a voice already there as the mic came back",
};
/** Phrases ignored are logged as a count, at most this often. */
const IGNORED_LOG_MS = 60_000;

export type Request = {
  by: By;
  /** What was heard live, from the name on. */
  live: string;
  /** From the name (or a reply's first words) to the quiet that ended it. */
  ms: number;
  /** From that quiet to the final transcript. */
  finalMs: number;
  audioSeconds: number;
};

export type HandsFreeOptions = {
  /** Where its audio comes from: the Mac's mic, or a phone's audio (phone-listen.ts). */
  mic: Pick<Mic, "open" | "close">;
  /** The dictionary's fixes (dictionary.ts applyDictionary). */
  fix: (text: string) => string;
  /** The app is speaking or playing a cue, or about to: the mic is dropped, so it doesn't hear itself. */
  talking: () => boolean;
  /** A session's reply window is open, and replies without the name are on. */
  replyWindow: () => boolean;
  /** What the session waiting asked (wake.ts Asks): one word answers a yes or no, or a choice. */
  asks?: () => Asks;
  /** Something the status shows changed: this window's reply needs the name. */
  changed?: () => void;
  /** Words to act on began: hold the floor, as a key press does. */
  holding: (by: By) => void;
  /** It heard the name: the listening cue, and the volume down. */
  named: () => void;
  /** The words to act on, final (from the name on, or the whole reply), as push-to-talk words are. */
  request: (text: string, heard: Request) => void;
  /** The name, then nothing: let the floor go. */
  dropped: (by: By) => void;
  /** Live words once it's awake, for the caption (never what it ignores), and the mic's level. */
  interim: (text: string) => void;
  level: (level: number) => void;
  log: (event: string, fields: Record<string, unknown>) => void;
  timing?: Partial<Timing>;
  /** Its own speech-to-text: Apple's on-device helper unless a test swaps it. */
  transcriber?: () => LocalTranscriber;
  /** Time, for the listener and the deaf window: the real one unless a test swaps it. */
  clock?: Clock;
  /**
   * Its audio comes only while someone talks (a phone's, gated there), not all the time as the Mac's
   * mic does: whether the app is talking is then watched on its own, every WATCH_MS, so the moments
   * the app starts and stops and the mic comes back (the reply window's quiet room, wake.ts deaf and
   * back) are what they'd be with audio all along.
   */
  sparse?: boolean;
};

/** How often a sparse listener looks at whether the app is talking, between chunks of audio. */
export const WATCH_MS = 50;

// The real clock, but its timers don't keep the process alive.
const unrefClock: Clock = { ...realClock, setTimeout: (fn, ms) => setTimeout(fn, ms).unref() };

export class HandsFree {
  /** Listening for the name now. */
  on = false;
  /** Phrases without the name ignored since it was turned on: only counted. */
  ignored = 0;
  private stt: LocalTranscriber | null = null;
  private readonly gate = new Gate();
  private readonly listener: Listener;
  private readonly o: HandsFreeOptions;
  private want = false; // asked to listen: false once stop() comes, even while start() waits
  private starting: Promise<string | null> | null = null;
  // The live words of the phrase, kept only for the caption once it's awake.
  private live = "";
  private deafUntil = 0;
  private wasDeaf = false;
  // When the app last talked (its end, once it stopped).
  private talkedAt = 0;
  // A phone's word (phonePlaying): it plays the app's voice or a cue now (since `phonePlayingAt`), or
  // its mic is shut for the moment after; and whether it played in this deaf stretch, so its word
  // and not DEAF_TAIL_MS says when the mic is back.
  private phoneIsPlaying = false;
  private phonePlayingAt = 0;
  private phonePlayed = false;
  // The mic came back on the phone's word (the reply window's quiet room judged from it), for the log.
  private backByPhone = false;
  private keyDown = false;
  private lastLevel = 0;
  private unlogged = 0;
  private loggedAt = 0;
  private readonly now: () => number;
  private readonly clock: Clock;
  private watchTimer: unknown = null;

  constructor(options: HandsFreeOptions) {
    this.o = options;
    this.clock = options.clock ?? unrefClock;
    this.now = () => this.clock.now();
    this.listener = new Listener({
      replyWindow: options.replyWindow,
      asks: options.asks,
      needsName: (why) => {
        options.log("reply_window_needs_name", { why: why.why, ms: Math.round(why.ms), because: NEEDS_NAME_BECAUSE[why.why], ...(this.backByPhone ? { back: "phone" } : {}) });
        options.changed?.();
      },
      holding: (by) => {
        options.log("wake", { by });
        options.holding(by);
        options.interim(this.shown());
      },
      named: options.named,
      ended: (heard) => void this.ended(heard),
      dropped: (by) => {
        options.log("wake_dropped", { by, why: "nothing after the name" });
        this.fresh();
        options.dropped(by);
      },
      ignored: (why) => {
        this.ignored++;
        this.unlogged++;
        this.fresh();
        // In a reply window, why it wasn't taken as the reply (never what was said).
        if (why) options.log("reply_window_ignored", { why });
        this.logIgnored(false);
      },
      timing: options.timing,
      clock: options.clock,
    });
  }

  /** Words to act on are coming in: the name was heard, or a reply in its window. */
  get by() {
    return this.listener.by;
  }

  /** The reply window open now needs the name: someone else was talking around the app's words. */
  get replyNeedsName() {
    return this.on && this.listener.needsName !== null;
  }

  /**
   * Starts listening: its own Apple speech-to-text helper, and the mic held open. Null once it's
   * on (or stop() came meanwhile); else why it can't (an older macOS, no speech model), and
   * nothing was left running.
   */
  start(): Promise<string | null> {
    this.want = true;
    if (this.on) return Promise.resolve(null);
    return (this.starting ??= this.open().finally(() => (this.starting = null)));
  }

  private async open(): Promise<string | null> {
    const stt = this.o.transcriber ? this.o.transcriber() : platform.speech.create();
    stt.onInterim = (text) => {
      if (this.stt !== stt) return;
      const fixed = this.o.fix(text);
      this.live = fixed;
      this.listener.heard(fixed);
      if (this.listener.awake) this.o.interim(this.shown());
    };
    // The helper crashed and came back: what it was hearing is gone, so listening starts afresh.
    stt.onRestarted = () => {
      if (this.stt !== stt) return;
      const by = this.listener.by;
      this.listener.reset();
      stt.begin();
      this.o.log("listen_restarted", { awake: Boolean(by) });
      if (by) this.o.dropped(by);
    };
    try {
      await stt.connect();
    } catch (err) {
      stt.close();
      this.want = false;
      return err instanceof Error ? err.message : String(err);
    }
    if (!this.want) {
      stt.close();
      return null;
    }
    this.stt = stt;
    this.on = true;
    this.ignored = 0;
    stt.begin();
    if (this.o.sparse) this.watch();
    if (!this.keyDown) this.o.mic.open(this.sink);
    return null;
  }

  /** Stops listening: the mic closes, unless the key holds it. */
  stop() {
    this.want = false;
    if (!this.on) return;
    this.on = false;
    // Your words were coming in: the floor they held goes.
    const by = this.listener.by;
    this.listener.reset();
    if (by) this.o.dropped(by);
    this.logIgnored(true);
    this.stt?.close();
    this.stt = null;
    if (this.watchTimer !== null) this.clock.clearTimeout(this.watchTimer);
    this.watchTimer = null;
    if (!this.keyDown) this.o.mic.close();
  }

  /** The push-to-talk key went down: its words are its own, and whatever was heard here is dropped. */
  pressed() {
    this.keyDown = true;
    if (!this.on) return;
    this.listener.reset();
    this.fresh();
  }

  /**
   * Another listener took the floor (a phone's heard its name, or the Mac's did while a phone's was
   * listening): whatever was heard here is dropped, with no callback. The audio keeps coming; while
   * the floor is someone else's, `talking` keeps it deaf. What it was woken by, if it was.
   */
  drop(): By | null {
    const by = this.listener.by;
    if (!this.on) return by;
    this.listener.reset();
    this.fresh();
    return by;
  }

  /** The key's recording is over: the mic's audio comes back here, the mic still open. False when not listening. */
  released() {
    this.keyDown = false;
    if (!this.on) return false;
    this.o.mic.open(this.sink);
    return true;
  }

  /**
   * A phone's word about its own speaker (protocol hands_free_playing): it plays the app's voice or a
   * cue (`on`), or its mic is back (the playback over, and the phone's own moment after it). Once
   * it played in a deaf stretch, the listener is back when it says so, not DEAF_TAIL_MS after the
   * app stopped: the phone hears the app's words later than the Mac sends them, and sends nothing
   * itself until then. Never said by the Mac's own mic.
   */
  phonePlaying(on: boolean) {
    const now = this.now();
    this.phoneIsPlaying = on;
    if (on) {
      this.phonePlayingAt = now;
      this.phonePlayed = true;
    }
    // Seen at once (deaf, or back), not at the next chunk or watch.
    if (this.stt && !this.deafNow(now)) this.listener.sound(false);
  }

  /**
   * Whether the mic's audio is dropped now: the app talking, so it doesn't hear itself, and the
   * transcript starts afresh (the listener told: deaf, then back DEAF_TAIL_MS after, or when the
   * phone that played it says its mic is back). Not while words to act on come in: the floor is
   * yours then, and only your own cue plays.
   */
  private deafNow(now: number) {
    const awake = this.listener.awake;
    if (!awake && this.o.talking()) {
      this.talkedAt = now;
      this.deafUntil = now + DEAF_TAIL_MS;
      this.goDeaf();
      return true;
    }
    if (!awake && this.phoneIsPlaying && now < Math.max(this.talkedAt, this.phonePlayingAt) + PHONE_PLAYING_MAX_MS) {
      this.goDeaf();
      return true;
    }
    // The app's own tail, unless the phone played it: its word said when its mic is back.
    if (now < this.deafUntil && !this.phonePlayed) return true;
    if (this.wasDeaf) {
      this.wasDeaf = false;
      this.backByPhone = this.phonePlayed;
      this.listener.back();
    }
    return false;
  }

  private goDeaf() {
    if (this.wasDeaf) return;
    this.wasDeaf = true;
    // A stretch of its own: the phone played in it only if it plays now or says so later.
    this.phonePlayed = this.phoneIsPlaying;
    this.listener.deaf();
    this.fresh();
  }

  /** Sparse audio (a phone's): the deaf window and the reply window watched between chunks. */
  private watch() {
    this.watchTimer = this.clock.setTimeout(() => {
      this.watchTimer = null;
      if (!this.stt) return;
      if (!this.deafNow(this.now())) this.listener.sound(false); // a window opening is seen as it opens
      this.watch();
    }, WATCH_MS);
  }

  /** The mic's audio while listening. */
  readonly sink = (chunk: Buffer) => {
    const stt = this.stt;
    if (!stt) return;
    const now = this.now();
    if (this.deafNow(now)) return;
    stt.send(chunk);
    const level = levelOf(chunk);
    this.listener.sound(this.gate.voiced(level));
    if (this.listener.awake && now - this.lastLevel > 80) {
      this.lastLevel = now;
      this.o.level(level);
    }
  };

  /** The live words for the caption: from the name on, never what came before it. */
  private shown() {
    const wake = this.listener.by === "name" ? wakeIn(this.live) : null;
    return wake ? this.live.slice(wake.at) : this.live;
  }

  /** Quiet after the request: the transcript's final words, acted on; then a fresh transcript. */
  private async ended(heard: { text: string; by: By; ms: number }) {
    const stt = this.stt;
    if (!stt) return;
    const at = this.now();
    const audioSeconds = stt.audioSeconds();
    const final = stt.finish();
    stt.begin();
    this.live = "";
    let text = heard.text;
    try {
      // From the name on, as transcribed: the app fixes it with the dictionary as it does push-to-talk
      // words. Found as transcribed, else once fixed; else the live words, which had it. A reply's
      // words with the dictionary's fixes, as the live ones had them.
      const raw = (await final).trim();
      if (heard.by === "reply") text = raw ? this.o.fix(raw) : text;
      else {
        const fixed = this.o.fix(raw);
        const wake = wakeIn(raw) ?? wakeIn(fixed);
        if (wake?.rest) text = (wakeIn(raw) ? raw : fixed).slice(wake.at);
      }
    } catch {
      // the live words, then
    }
    this.o.request(text, { by: heard.by, live: heard.text, ms: heard.ms, finalMs: this.now() - at, audioSeconds });
  }

  /** Starts a fresh transcript: what comes next is transcribed from its start, where the name may be. */
  private fresh() {
    const stt = this.stt;
    if (!stt) return;
    this.live = "";
    void stt.finish().catch(() => "");
    stt.begin();
  }

  /** Phrases ignored, as a count only: what was said is never kept. */
  private logIgnored(now: boolean) {
    if (!this.unlogged || (!now && this.now() - this.loggedAt < IGNORED_LOG_MS)) return;
    this.o.log("listen_ignored", { count: this.unlogged, total: this.ignored });
    this.unlogged = 0;
    this.loggedAt = this.now();
  }
}
