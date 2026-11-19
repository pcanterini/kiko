/**
 * Headless check of the three services, no mic or hotkey:
 * Cartesia speaks a sentence → Deepgram transcribes it → Haiku summarizes a sample Claude reply to it
 * → Cartesia speaks the summary.
 */
import { config, MIC_SAMPLE_RATE, TTS_SAMPLE_RATE } from "../src/core/config.ts";
import { Deepgram } from "../src/core/deepgram.ts";
import { Summarizer } from "../src/core/summarizer.ts";
import { Cartesia } from "../src/core/cartesia.ts";

const now = () => performance.now();
const ms = (from: number) => `${Math.round(now() - from)}ms`;

async function synthesize(cartesia: Cartesia, text: string) {
  const chunks: Buffer[] = [];
  await new Promise<void>(async (resolve) => {
    const tts = await cartesia.open({ onAudio: (pcm) => chunks.push(pcm), onDone: resolve });
    tts.push(text);
    tts.end();
  });
  return Buffer.concat(chunks);
}

/** Crude 24k → 16k linear resample, good enough to feed Deepgram in a test. */
function resample(pcm: Buffer) {
  const input = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  const ratio = TTS_SAMPLE_RATE / MIC_SAMPLE_RATE;
  const out = new Int16Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const j = Math.floor(x);
    out[i] = input[j] + ((input[j + 1] ?? input[j]) - input[j]) * (x - j);
  }
  return Buffer.from(out.buffer);
}

async function main() {
  const cartesia = new Cartesia();
  const deepgram = new Deepgram(config.deepgramKey);

  let t = now();
  await Promise.all([cartesia.connect(), deepgram.connect()]);
  console.log(`sockets open           ${ms(t)}`);

  t = now();
  const prompt = await synthesize(cartesia, "Add a dark mode toggle to the settings page.");
  console.log(`cartesia synth         ${ms(t)} (${(prompt.length / 2 / TTS_SAMPLE_RATE).toFixed(1)}s of audio)`);

  // Stream it at roughly real time in 20ms frames, like a mic would.
  const audio = resample(prompt);
  const frame = (MIC_SAMPLE_RATE * 2 * 20) / 1000;
  deepgram.begin();
  for (let i = 0; i < audio.length; i += frame) {
    deepgram.send(audio.subarray(i, i + frame));
    await new Promise((r) => setTimeout(r, 20));
  }
  t = now();
  const heard = await deepgram.finish();
  console.log(`deepgram finalize      ${ms(t)} → "${heard}"`);

  const summarizer = new Summarizer();
  const claudeReply =
    "I added a dark mode toggle to the settings page. It saves the choice in localStorage and follows the " + "system theme by default. All 42 tests pass. I haven't committed anything yet.";
  let firstToken = 0;
  let firstAudio = 0;
  t = now();
  const done = new Promise<void>(async (resolve) => {
    const tts = await cartesia.open({
      onAudio: () => (firstAudio ||= now()),
      onDone: resolve,
    });
    const reply = await summarizer.summarize({ name: "smoke", nameSession: true, context: [`you → smoke: ${heard}`], claudeReply }, (delta) => {
      firstToken ||= now();
      tts.push(delta);
    });
    tts.end();
    console.log(`haiku summary          "${reply?.text}"`);
  });
  await done;
  console.log(`haiku first token      ${Math.round(firstToken - t)}ms`);
  console.log(`first reply audio      ${Math.round(firstAudio - t)}ms after transcript (${Math.round(firstAudio - firstToken)}ms after first token)`);

  deepgram.close();
  cartesia.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
