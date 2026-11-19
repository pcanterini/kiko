// A custom voice's volume (pocket-voices.ts voiceGain): Pocket's s16 PCM for that voice turned up or
// down as it streams, before it's played, sent to a phone or previewed. A cloned voice keeps the
// loudness of the recording it was made from, and raising the recording's level before cloning
// made the clone less clear (2026-11-03: Marlo), so the gain is here, at playback.
//
// Turned up, the peaks would clip; there's no lookahead while streaming (it would add delay), so a
// fast limiter holds them: its level follows the loudest sample at once and lets go over about 60 ms,
// and the gain it allows bends softly from KNEE towards CEILING, which it never reaches. Below the
// knee, samples are only scaled.

/** Where the limiter starts to bend, and what nothing goes over: -4 and -1 dBFS. */
export const KNEE = 32768 * 10 ** (-4 / 20);
export const CEILING = 32768 * 10 ** (-1 / 20);
/** The largest sample it gives: under CEILING once rounded (the knee reaches it only in the limit, and tanh rounds to 1 far out). */
const LIMIT = Math.floor(CEILING);

const RATE = 24000;
const RELEASE_MS = 60;

/** A level after the soft knee: as it is up to KNEE, then bending towards CEILING (smoothly: same slope at the knee), never past it. */
export function softKnee(level: number): number {
  if (level <= KNEE) return level;
  const room = CEILING - KNEE;
  return KNEE + room * Math.tanh((level - KNEE) / room);
}

/**
 * A stream's gain: a function each chunk of s16le mono PCM (24 kHz, an even number of bytes) goes
 * through, in order, keeping the limiter's level from one chunk to the next. 0 dB: the chunk as it is.
 */
export function gainStream(gainDb: number, rate = RATE): (pcm: Buffer) => Buffer {
  if (!gainDb || !Number.isFinite(gainDb)) return (pcm) => pcm;
  const gain = 10 ** (gainDb / 20);
  const release = Math.exp(-1 / ((RELEASE_MS / 1000) * rate));
  let level = 0; // the limiter's: the loudest sample lately, scaled, falling off as it lets go
  return (pcm) => {
    const out = Buffer.allocUnsafe(pcm.length);
    for (let i = 0; i + 1 < pcm.length; i += 2) {
      const x = pcm.readInt16LE(i) * gain;
      const abs = Math.abs(x);
      level = abs > level ? abs : level * release + abs * (1 - release);
      // |x| <= level, and softKnee(level) <= CEILING: so is |y| (and kept to LIMIT once rounded).
      const y = level > KNEE ? (x * softKnee(level)) / level : x;
      out.writeInt16LE(Math.max(-LIMIT, Math.min(LIMIT, Math.round(y))), i);
    }
    return out;
  };
}
