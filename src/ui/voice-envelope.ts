// A voice level made smooth enough to draw (./dither-glow.ts): the raw level (0–1, e.g. the mic's,
// core/wake.ts levelOf) with the room's noise cut off below `threshold`, what's left stretched back
// to 0–1 and turned up by `gain`, then followed by an envelope that rises quickly (`attackMs`) and
// falls slowly (`releaseMs`), so a word lights the glow at once and a pause lets it sink gently.
// Pure: the caller keeps the last value and gives the time since it.
//
// The timings and the mic's gate follow the Voice Glow look the glow is modelled on, whose audio
// chain reads linear RMS once a display frame (60 a second) with:
//   attack 0.325       the share of the way to a louder level it moves each frame
//                      → attackMs = perFrameToMs(0.325) ≈ 42 ms
//   release 0.86       the share of a level it keeps each frame on the way down
//                      → releaseMs = perFrameToMs(1 - 0.86) ≈ 111 ms
//   threshold 0.015    linear RMS: -36.5 dB, 0.39 on levelOf's -60…0 dB scale → threshold
//   sensitivity 3.1    (RMS - threshold) × 3.1 reaches 1 at RMS 0.338 (-9.4 dB, 0.84 on levelOf's
//                      scale): the gain that stretches 0.39–0.84 to 0–1 on ours, 1.35 → gain
//   idle 0.18, breathe 5.2 s: the glow's, not the envelope's: listening's floor at silence and
//                      its slow pulse (dither-glow.ts IDLE_FLOOR, BREATHE_SECONDS)

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

/** A one-pole smoother's per-frame step (the share of the way it moves each frame) as a time constant in ms. */
export const perFrameToMs = (step: number, fps = 60): number => -1000 / fps / Math.log(1 - step);

/** levelOf's scale (-60…0 dB as 0–1) for a linear RMS amplitude. */
export const levelOfRms = (rms: number): number => Math.min(1, Math.max(0, (20 * Math.log10(rms) + 60) / 60));

const ATTACK_MS = Math.round(perFrameToMs(0.325));
const RELEASE_MS = Math.round(perFrameToMs(1 - 0.86));
const MIC_THRESHOLD = levelOfRms(0.015);
const MIC_FULL = levelOfRms(0.015 + 1 / 3.1);

/** For a level already 0–1 with no noise in it (the demo's own): the timings alone. */
export const PLAIN_ENVELOPE: EnvelopeOptions = { threshold: 0, gain: 1, attackMs: ATTACK_MS, releaseMs: RELEASE_MS };

/** For the mic (levelOf: -60…0 dB as 0–1): quiet rooms read about 0.2, talking 0.5–0.8. */
export const MIC_ENVELOPE: EnvelopeOptions = {
  threshold: Math.round(MIC_THRESHOLD * 100) / 100,
  gain: Math.round(((1 - MIC_THRESHOLD) / (MIC_FULL - MIC_THRESHOLD)) * 100) / 100,
  attackMs: ATTACK_MS,
  releaseMs: RELEASE_MS,
};

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
