// A voice level made smooth enough to draw (./dither-glow.ts): the raw level (0–1, e.g. the mic's,
// core/wake.ts levelOf) with the room's noise cut off below `threshold`, what's left stretched back
// to 0–1 and turned up by `gain`, then followed by an envelope that rises quickly (`attackMs`) and
// falls slowly (`releaseMs`), so a word lights the glow at once and a pause lets it sink gently.
// Pure: the caller keeps the last value and gives the time since it.

export type EnvelopeOptions = {
  /** Raw levels at or under this are silence (the mic's room noise sits around 0.15–0.3 on levelOf's scale). */
  threshold: number;
  /** What's over the threshold is multiplied by this (then held at 1). */
  gain: number;
  /** About how long the envelope takes to rise most of the way (a time constant, ms). */
  attackMs: number;
  /** And to fall. */
  releaseMs: number;
};

/** For a level already 0–1 with no noise in it (the demo's own). */
export const PLAIN_ENVELOPE: EnvelopeOptions = { threshold: 0, gain: 1, attackMs: 40, releaseMs: 220 };

/** For the mic (levelOf: -60…0 dB as 0–1): quiet rooms read about 0.2, talking 0.5–0.8. */
export const MIC_ENVELOPE: EnvelopeOptions = { threshold: 0.28, gain: 1.8, attackMs: 35, releaseMs: 260 };

/** A raw level with the threshold and gain applied: 0–1. */
export function gated(raw: number, o: Pick<EnvelopeOptions, "threshold" | "gain">): number {
  if (!(raw > o.threshold)) return 0;
  const over = ((raw - o.threshold) / (1 - o.threshold || 1)) * o.gain;
  return over >= 1 ? 1 : over;
}

/** The envelope's next value: from `previous`, `dtMs` later, towards the gated `raw`. */
export function envelope(previous: number, raw: number, dtMs: number, o: EnvelopeOptions): number {
  const target = gated(raw, o);
  const tau = target > previous ? o.attackMs : o.releaseMs;
  if (!(dtMs > 0)) return previous;
  if (tau <= 0) return target;
  return previous + (target - previous) * (1 - Math.exp(-dtMs / tau));
}
