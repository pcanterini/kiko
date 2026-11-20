// The voice's level made ready to draw (./dither-glow.ts), as the Voice Glow it's ported from does
// it: the raw level turned up (BASE_GAIN × sensitivity, for a mic's RMS), cut off below the
// threshold (the room's noise), what's left rounded off so a shout doesn't clip (`shape`), then
// followed by a one-pole envelope that rises with the attack's time constant and falls with the
// release's (`follow`). Pure: the caller keeps the state and gives the time since the last frame.
//
// Ported from voice-glow 0.5.0 (https://github.com/Jakubantalik/Libraries.dev, packages/voice-glow):
// src/voiceDriver.ts (BASE_GAIN, shape, follow) and the defaults of src/VoiceBeam.tsx's props.
//
// Copyright (c) 2026 Jakub Antalik
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/** The input chain's settings, the original's defaults. Times are time constants in seconds. */
export const VOICE_INPUT = {
  /** Multiplies a mic's RMS (after BASE_GAIN). */
  sensitivity: 3.1,
  /** Raw levels at or under this are silence; the bands' gate is 0.6 of it. */
  threshold: 0.015,
  /** How quickly the envelope rises, and falls (the bands fall 1.15× slower). */
  attack: 0.325,
  release: 0.86,
  /** The glow at silence (0–1 of the way to full), and how long one slow breath of it takes. */
  idle: 0.18,
  breatheDuration: 5.2,
} as const;

/** A laptop mic at talking distance gives an RMS of about 0.03–0.2: this lifts it into the 0.15–1 the shaping expects. */
export const BASE_GAIN = 5;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Noise gate, then soft saturation: 0 at or under `threshold`, rounding off towards 1. */
export function shape(raw: number, threshold: number): number {
  if (!(raw > threshold)) return 0;
  const t = (raw - threshold) / Math.max(0.001, 1 - threshold);
  return clamp01((1 - Math.exp(-3 * t)) / (1 - Math.exp(-3)));
}

/** One-pole follower, `dt` seconds on: towards `target`, with the attack's time constant going up and the release's going down. */
export function follow(previous: number, target: number, dt: number, attack: number, release: number): number {
  const tau = target > previous ? attack : release;
  return previous + (target - previous) * (1 - Math.exp(-dt / Math.max(0.001, tau)));
}

/** A level on core/wake.ts levelOf's scale (-60…0 dB as 0–1) back to the linear RMS it came from; 0 stays 0. */
export function rmsOfLevel(level: number): number {
  return level > 0 ? 10 ** ((Math.min(1, level) * 60 - 60) / 20) : 0;
}

/** The mic's level as the glow takes it (the original's analyser path): its RMS × BASE_GAIN × sensitivity, not held to 1. */
export function micLevel(levelOfValue: number, sensitivity: number = VOICE_INPUT.sensitivity): number {
  return rmsOfLevel(levelOfValue) * BASE_GAIN * sensitivity;
}
