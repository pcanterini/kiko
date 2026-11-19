// Small cues through the speaker: a soft rising blip when the mic opens, a soft falling one when
// your words reach a session. Synthesized here (24 kHz mono s16le, like the voices), so there are
// no sound files and nothing to load.
import { TTS_SAMPLE_RATE } from "./config.ts";

const VOLUME = 0.12; // subtle: well under speech level

/** Notes played back to back: [frequency Hz, milliseconds]. */
function tones(notes: Array<[number, number]>) {
  const chunks = notes.map(([freq, ms]) => {
    const samples = Math.round((TTS_SAMPLE_RATE * ms) / 1000);
    const pcm = Buffer.alloc(samples * 2);
    const fade = Math.min(samples / 2, Math.round(TTS_SAMPLE_RATE * 0.008)); // 8 ms fades, no clicks
    for (let i = 0; i < samples; i++) {
      const envelope = Math.min(1, i / fade, (samples - 1 - i) / fade);
      const v = Math.sin((2 * Math.PI * freq * i) / TTS_SAMPLE_RATE) * envelope * VOLUME;
      pcm.writeInt16LE(Math.round(v * 32767), i * 2);
    }
    return pcm;
  });
  return Buffer.concat(chunks);
}

export const SOUNDS = {
  listening: tones([
    [660, 55],
    [880, 70],
  ]),
  sent: tones([
    [880, 55],
    [660, 80],
  ]),
};
