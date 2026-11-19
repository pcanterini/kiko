// The Mac's pieces (../types.ts): Swift helpers built from native/macos/ (native.ts), AppleScript
// for the volume, `say`, and `dns-sd` for Bonjour. Ghostty is in src/terminals/.
import type { Platform } from "../types.ts";
import { AppleTranscriber } from "./apple-stt.ts";
import { Duck, leftoverDuck } from "./duck.ts";
import { captureKey, Hotkey, KEYS } from "./hotkey.ts";
import { inputDevices, Mic } from "./mic.ts";
import { macVoices, Say, saySample } from "./say.ts";
import { addresses, advertise, hostname } from "./network.ts";
import { opus } from "./opus.ts";
import { helperAppHolder, relaunchHelperApp } from "./helper-app.ts";
import { openPane, PANES, permissionStatus, requestPermission } from "./permissions.ts";
import { atComputer } from "./presence.ts";
import { Speaker } from "./speaker.ts";

export const macos: Platform = {
  mic: { create: () => new Mic(), inputs: () => inputDevices() },
  speech: { create: () => new AppleTranscriber() },
  voice: { create: (voice, rate) => new Say(voice, rate), voices: () => macVoices(), sample: (text, voice, rate) => saySample(text, voice, rate) },
  speaker: { create: () => new Speaker() },
  hotkey: { keys: KEYS, create: (name) => new Hotkey(name), capture: () => captureKey() },
  volume: { duck: (opts) => new Duck(opts), leftover: leftoverDuck },
  network: { addresses, advertise, hostname },
  presence: { atComputer },
  opus,
  permissions: {
    status: permissionStatus,
    request: requestPermission,
    pane: (which) => `Privacy & Security → ${PANES[which].name}`,
    open: openPane,
    holder: () => helperAppHolder(),
    refresh: () => relaunchHelperApp(),
  },
};
