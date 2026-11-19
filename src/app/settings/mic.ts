// Settings → Microphone: the mic in use (and the system default standing in when the chosen one is
// away), a mic picked, and Test microphone. A Bluetooth mic coming or going is logged and never
// said (2026-11-14); a wired one you chose still is.
import { config } from "../../core/config.ts";
import { appEnv } from "../../core/env.ts";
import { fallbackNote, micChoice, micSetting, resolveMic, type MicChoice } from "../../core/mic-device.ts";
import { applyDictionary } from "../../core/dictionary.ts";
import { levelOf } from "../../core/wake.ts";
import type { Settings } from "../../core/settings.ts";
import { ui, type MicTest } from "../../core/ui-store.ts";
import { cost, log, totals } from "../../core/log.ts";
import { writeState } from "../status.ts";
import { floor, mic, micWatch, state, stt, sttEngine } from "../state.ts";
import { refreshSettings } from "../settings-screen.ts";

/**
 * The device for the log: what it opened last, or `inUse` (what it would open). `noLink`: the mic
 * that would be used (chosen, or the system default) is listed but gave no link, and this one stands in.
 */
type MicFor = { device: { uid: string; name: string } | null; fallback: boolean; wanted: MicChoice; noLink?: boolean };
export function micFields(inUse: MicFor | null = mic.using && { device: mic.using, fallback: mic.using.fallback, wanted: mic.using.wanted, noLink: mic.using.noLink }) {
  if (!inUse) return {};
  return {
    device: inUse.device?.name || null,
    uid: inUse.device?.uid || null,
    ...(inUse.fallback ? { fallback: true, wanted: inUse.wanted?.name ?? null, wantedUid: inUse.wanted?.uid ?? null } : {}),
    ...(inUse.noLink ? { noLink: true } : {}),
  };
}

/**
 * The mic in use, as the helper decides it (mic-device.ts resolveMic): your choice, the devices it
 * lists, and the one it gave up on for giving no link (state.micNoLink, forgotten once it's gone
 * from the list).
 */
export function micInUse() {
  if (state.micNoLink && !mic.devices.some((d) => d.uid === state.micNoLink)) state.micNoLink = null;
  return resolveMic(micChoice(config.mic, config.micName), mic.devices, state.micNoLink);
}

/**
 * The mic in use, from the helper's device list and your choice: for the header and the setting.
 * Logged when the chosen mic goes missing and the system default stands in, and again when it's
 * back; said on screen too, unless it's a Bluetooth mic (2026-11-14: AirPods taken out read
 * "AirPods isn't connected…" and the header "(AirPods missing)", as if something were wrong: they
 * come and go, and Kiko just uses what's there). The helper itself moves over, open or not.
 */
export function refreshMic() {
  const inUse = micInUse();
  ui.set({ mic: inUse, micDevices: mic.devices });
  const change = micWatch.update(inUse);
  if (change === "fallback") {
    log("mic_fallback", micFields(inUse));
    const note = fallbackNote(inUse);
    if (note) ui.error("mic", note);
  } else if (change === "back") {
    log("mic_back", micFields(inUse));
    if (!inUse.bluetooth) ui.info(`${inUse.device?.name} is back: using it again.`);
  }
  if (ui.state.screen === "settings") refreshSettings();
}

/** Settings → Microphone picked: saved by UID, with the name to show and to find it by if the UID changes; "" is the system default. */
export function pickMic(next: Settings, uid: string, label?: string) {
  const picked = micSetting(uid, mic.devices, label);
  const name = picked.micName ?? "";
  next.mic = picked.mic;
  next.micName = picked.micName;
  config.mic = uid;
  config.micName = name;
  state.micNoLink = null; // chosen (again): the helper tries it afresh
  mic.setDevice(micChoice(uid, name));
  refreshMic();
}

// Short in the faked-app harness.
const MIC_TEST_MS = Number(appEnv("TEST_MIC_TEST_MS") ?? 5000);

const patchMicTest = (patch: Partial<MicTest>) => ui.state.micTest && ui.set({ micTest: { ...ui.state.micTest, ...patch } });

/**
 * Settings → Test microphone: the chosen mic open for a few seconds, its level and what
 * push-to-talk's speech-to-text heard shown live, then closed. The key waits meanwhile, and
 * hands-free pauses as it does for a key press, listening again after.
 */
export async function testMic() {
  if (state.micTesting) return;
  if (floor.pressed || state.voiceHolds) return ui.info("(finish talking first, then test the mic)");
  state.micTesting = true;
  const inUse = micInUse();
  const device = inUse.device?.name ?? "no mic";
  ui.set({ micTest: { phase: "listening", until: Date.now() + MIC_TEST_MS, level: 0, peak: 0, heard: "", device } });
  log("mic_test", { phase: "start", ...micFields(inUse) });
  state.handsFree?.pressed();
  const said = stt.begin((text) => patchMicTest({ heard: applyDictionary(text).text }));
  // The test's own now: a press still in its tail leaves it open.
  state.micPress = null;
  let lastLevel = 0;
  let peak = 0;
  mic.open((chunk) => {
    said.send(chunk);
    const level = levelOf(chunk);
    peak = Math.max(peak, level);
    if (Date.now() - lastLevel > 80) {
      lastLevel = Date.now();
      patchMicTest({ level, peak });
    }
  });
  try {
    await new Promise((r) => setTimeout(r, MIC_TEST_MS));
  } finally {
    // Hands-free on, the mic stays open and its audio goes back to listening for the name.
    if (!state.handsFree?.released()) mic.close();
  }
  patchMicTest({ phase: "finishing", level: 0, peak });
  let heard = "";
  let error: string | undefined;
  try {
    heard = applyDictionary((await said.finish()).trim()).text;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const audioSeconds = said.audioSeconds();
  if (config.stt === "deepgram") totals.deepgram += cost.deepgram(audioSeconds, sttEngine.hinted());
  patchMicTest({ phase: "done", heard, peak, error });
  log("mic_test", { phase: "done", ...micFields(inUse), heard, peak: Math.round(peak * 100) / 100, audioSeconds, ...(error ? { error } : {}) });
  state.micTesting = false;
  writeState();
}
