// Hands-free from the phone (its Settings → Hands-free, while its app is in front), for the server
// (server.ts): hands_free { on } starts or stops a listener for it on the Mac (PhoneHub.listen: the
// Mac's hands-free on that phone's audio, app/talk.ts phoneListeners), which says how it's going
// (hands_free_state: on, woken by the name or a reply, the talk its words became). The phone sends
// what its mic hears while someone talks, in listen_audio (PCM in JSON) or binary frames of kind 3
// (Opus), decoded here as a press's are. Only to a phone whose hub said `handsFree` in welcome; a
// phone that goes away (the background, locked) or whose connection closes stops its listener. A
// phone whose hub said `handsFreePlaying` also says when it plays Kiko's voice and when its mic is
// back after (hands_free_playing): its listener's deaf window is the phone's own
// (PhoneHub.listenPlaying).
//
// Each connection's own part (listening, its decoder, whether it asked, its bytes) is on its Conn;
// the server hands over the messages, and the connections as they go away or into the background.
import { NAME } from "../core/name.ts";
import type { Opus } from "../platform/types.ts";
import { TalkDecoder } from "./opus.ts";
import type { Conn, ErrorCode, PhoneHub } from "./server.ts";

/** How a phone's listener is (core/phone-listen.ts), as hands_free_state tells it. */
export type HandsFreeState = { on: boolean; by: "name" | "reply" | null; name?: string; talkId?: string; error?: string };

/** Why a phone's Hands-free went off: it said, it went away (the background, locked), its connection went. */
export type ListenOff = "phone" | "away" | "gone";

/** What hands-free uses of the server. */
export type HandsFreeSide = {
  hub: PhoneHub;
  /** Every connection, as the server has them now. */
  conns: ReadonlySet<Conn>;
  send(c: Conn, message: Record<string, unknown>): void;
  error(c: Conn, code: ErrorCode, message?: string): void;
  /** The phone's other connections, still open. */
  sameAs(c: Conn): Conn[];
};

export class PhoneHandsFree {
  private s: HandsFreeSide;

  constructor(side: HandsFreeSide) {
    this.s = side;
  }

  /** The hub listens for phones (PhoneHub.listen and listenAudio): welcome says `handsFree`. */
  private listensForPhones() {
    return Boolean(this.s.hub.listen && this.s.hub.listenAudio);
  }

  /** What welcome says of it. */
  welcome() {
    return {
      // It listens hands-free for the phone (hands_free, listen_audio).
      ...(this.listensForPhones() ? { handsFree: true } : {}),
      // Its listener's deaf window follows the phone's own playback (hands_free_playing).
      ...(this.listensForPhones() && this.s.hub.listenPlaying ? { handsFreePlaying: true } : {}),
    };
  }

  /** hands_free: the phone's Hands-free on (its app in front) or off. Answered with hands_free_state. */
  async said(c: Conn, on: boolean) {
    const hub = this.s.hub;
    if (!hub.listen || !this.listensForPhones()) return this.s.error(c, "invalid", `This ${NAME} doesn't listen hands-free for the phone. Update it.`);
    c.handsFree = true;
    if (!on) return this.off(c, "phone");
    // Away (in the background or locked): not now. The app says on again once it's in front.
    if (c.presence === "away") return this.s.send(c, { type: "hands_free_state", on: false, by: null });
    // One listener per phone: another of its connections that had it lets go of it here.
    for (const x of this.s.sameAs(c)) {
      x.listening = false;
      x.listen?.close();
      x.listen = null;
    }
    c.listening = true;
    let why: string | null;
    try {
      why = await hub.listen(c.phone!.id, true, "phone");
    } catch (err) {
      why = err instanceof Error ? err.message : String(err);
    }
    if (why) c.listening = false;
  }

  /** Its Hands-free off on this connection (the phone said, it went away, the connection went). */
  off(c: Conn, why: ListenOff) {
    c.listen?.close();
    c.listen = null;
    if (!c.listening) {
      // Off already: said back, so the phone's line matches.
      if (why === "phone" && c.phone) this.s.send(c, { type: "hands_free_state", on: false, by: null });
      return;
    }
    c.listening = false;
    // Another connection of the same phone has it now: that one's listener stays.
    if (c.phone && !this.s.sameAs(c).some((x) => x.listening)) void this.s.hub.listen?.(c.phone.id, false, why);
  }

  /** listen_audio: the phone's hands-free audio as PCM in JSON (`bytes` as on the wire), while its Hands-free is on. */
  audio(c: Conn, data: string, bytes: number) {
    if (!c.listening) return; // after its hands_free off, or before it's on: dropped
    c.listenIn += bytes;
    const pcm = Buffer.from(data, "base64");
    return c.listen ? c.listen.pcmIn(pcm) : this.s.hub.listenAudio?.(c.phone!.id, pcm);
  }

  /** A binary frame of the phone's hands-free audio: decoded in order, as a press's, while its Hands-free is on. */
  frame(c: Conn, opus: Opus, packets: Buffer, count: number, bytes: number) {
    if (!c.listening) return;
    c.listenIn += bytes;
    const hub = this.s.hub;
    const phoneId = c.phone!.id;
    c.listen ??= new TalkDecoder(opus, (pcm) => hub.listenAudio?.(phoneId, pcm));
    c.listen.packetsIn(packets, count);
  }

  /** hands_free_playing: the phone plays Kiko's voice or a cue now, or its mic is back. */
  playing(c: Conn, playing: boolean) {
    if (!c.listening) return; // its Hands-free isn't on here: nothing listens to it
    return this.s.hub.listenPlaying?.(c.phone!.id, playing);
  }

  /** How a phone's listener is (core/phone-listen.ts): to its connections that asked about hands-free. */
  state(phoneId: string, s: HandsFreeState) {
    const message = {
      type: "hands_free_state",
      on: s.on,
      by: s.by,
      ...(s.name ? { name: s.name.slice(0, 100) } : {}),
      ...(s.talkId ? { talkId: s.talkId } : {}),
      ...(s.error ? { error: s.error.slice(0, 2000) } : {}),
    };
    for (const c of this.s.conns) if (c.phone?.id === phoneId && c.handsFree && !c.replaced) this.s.send(c, message);
  }
}
