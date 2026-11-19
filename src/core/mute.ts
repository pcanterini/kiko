/**
 * Mute (m), like a TV's: Kiko goes silent and nothing else changes. What's being said goes on in
 * silence at its own pace, and so does what starts while muted; unmuted, it's heard again from
 * wherever it is by then (what was said meanwhile is missed). The floor never knows: the Mac's player
 * (or the clock standing in for it, mac-output.ts) still says "playing" and "idle" when the sound
 * starts and ends, so who speaks when, reply windows, holds and barge-in are as they'd be out loud.
 *
 * - The Mac: its player's gain goes to 0 and back to 1 (the native player's volume, player.swift
 *   "V"), mid-line, within a render cycle: what's queued in it plays on, unheard.
 * - The phones: audio is sent as it's made, ahead of where it's being played, so the phone has some
 *   of what's to come already. Muting cuts the phone's playback (audio_stop, as a barge-in does) and
 *   sends nothing more; every chunk is still kept here with when it plays (the Mac's timing, as
 *   MacSpeaker counts it), and unmuting sends what's left from that moment on, the chunk it's in cut
 *   to where it is. To the phone that's a new stretch of speech (its playback buffer starts it as it
 *   does any), so nothing on the phone changes.
 *
 * The macOS voice (`say`) isn't here: it plays by itself and can't be turned down mid-line, so for
 * it muting still cuts the line and says nothing until unmuted (app.ts).
 */
import { TTS_SAMPLE_RATE } from "./config.ts";
import { type Clock, realClock } from "./clock.ts";
import type { VoicePos } from "./voice-marks.ts";

/** The phones' side: their voice audio (`pos`: its place in its line, for the read-along), and cutting what they're playing. */
type PhoneVoiceOut = { audio: (pcm: Buffer, pos?: VoicePos) => void; stop: () => void };

type Chunk = { pcm: Buffer; at: number; end: number; pos?: VoicePos };

const msOf = (pcm: Buffer) => ((pcm.length / 2) * 1000) / TTS_SAMPLE_RATE;

export class Mute {
  private on = false;
  // What's been given and hasn't finished playing yet, in order, with when it plays.
  private chunks: Chunk[] = [];
  private endAt = 0;

  private gain: (level: number) => void;
  private phone: PhoneVoiceOut;
  private clock: Clock;

  /** `gain`: the Mac's player's volume (0 or 1). `phone`: where the voice goes for phones. */
  constructor(o: { gain: (level: number) => void; phone: PhoneVoiceOut; clock?: Clock }) {
    this.gain = o.gain;
    this.phone = o.phone;
    this.clock = o.clock ?? realClock;
  }

  get muted() {
    return this.on;
  }

  /** Muted or not, at once: mid-line too. */
  set(on: boolean) {
    if (on === this.on) return;
    this.on = on;
    this.gain(on ? 0 : 1);
    const now = this.clock.now();
    this.prune(now);
    if (on) {
      // The phone holds some of what's to come: cut, so it's silent now.
      if (this.chunks.length) this.phone.stop();
      return;
    }
    // The rest of what's being said, from where it is now.
    for (const c of this.chunks) {
      const skip = c.at < now ? Math.floor(((now - c.at) * TTS_SAMPLE_RATE) / 1000) * 2 : 0;
      if (skip < c.pcm.length) this.phone.audio(skip ? c.pcm.subarray(skip) : c.pcm, c.pos && { line: c.pos.line, at: c.pos.at + skip / 2 });
    }
  }

  /** A chunk of the voice for the phones, as it's made: sent now, or (muted) kept until it's played. */
  voice(pcm: Buffer, pos?: VoicePos) {
    const now = this.clock.now();
    this.prune(now);
    const at = Math.max(this.endAt, now);
    this.endAt = at + msOf(pcm);
    this.chunks.push({ pcm, at, end: this.endAt, pos });
    if (!this.on) this.phone.audio(pcm, pos);
  }

  /** Barge-in: the phones cut what they're playing, and nothing kept is sent on unmute. */
  stop() {
    this.chunks = [];
    this.endAt = 0;
    this.phone.stop();
  }

  private prune(now: number) {
    while (this.chunks.length && this.chunks[0]!.end <= now) this.chunks.shift();
  }
}
