// Your own Pocket TTS voices: files in voices/ next to the settings file (~/.config/kiko/voices/, or
// ~/.config/kiko-dev/voices/ for Kiko Dev). Each file is one voice, named by its file name:
//   - <Name>.safetensors: a voice `pocket-tts export-voice` made from a short recording (loads at once);
//   - <Name>.wav: the recording itself, cloned by the server on each use (only with Pocket's
//     voice-cloning model, which Kiko's install doesn't fetch: without it the default voice speaks).
// Both for the same name: the .safetensors one. Listed after the built-in voices in Settings → Voice
// (settings-options.ts), saved as `custom:<Name>`, and sent to the server with each sentence
// (pocket-tts.ts), so picking one needs no restart. Read when listed or used: a file added shows up
// the next time the list opens.
// Beside a voice, <Name>.json may say how loud it is: { "gainDb": 5 } (voiceGain), set in Settings →
// Voice → Volume and applied to its audio as it plays (voice-gain.ts); read each time it speaks.
import { readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { SETTINGS_FILE } from "./settings.ts";

export const VOICES_DIR = join(dirname(SETTINGS_FILE), "voices");

/** What a custom voice's id starts with, in the settings (pocketVoice) and KIKO_POCKET_VOICE. */
export const CUSTOM_PREFIX = "custom:";

export type CustomVoice = { id: string; name: string; path: string };

const KINDS = [".safetensors", ".wav"]; // in order of preference

export const isCustomVoiceId = (id: string) => id.startsWith(CUSTOM_PREFIX);

/** A custom voice's name from its id ("custom:Marlo" → "Marlo"); undefined for any other id. */
export const customVoiceName = (id: string) => (isCustomVoiceId(id) ? id.slice(CUSTOM_PREFIX.length) : undefined);

/** The voices in `dir`, by name (case aside); none when there's no such folder. */
export function customVoices(dir = VOICES_DIR): CustomVoice[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const byName = new Map<string, CustomVoice & { rank: number }>();
  for (const file of names) {
    const ext = extname(file).toLowerCase();
    const rank = KINDS.indexOf(ext);
    const name = file.slice(0, file.length - ext.length).trim();
    if (rank < 0 || !name || file.startsWith(".")) continue;
    const path = join(dir, file);
    if (!isFile(path)) continue;
    const had = byName.get(name);
    if (!had || rank < had.rank) byName.set(name, { id: `${CUSTOM_PREFIX}${name}`, name, path, rank });
  }
  return [...byName.values()].map(({ rank: _, ...voice }) => voice).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** The custom voice an id names, when its file is there. */
export function customVoice(id: string, dir = VOICES_DIR): CustomVoice | undefined {
  const name = customVoiceName(id);
  return name === undefined ? undefined : customVoices(dir).find((v) => v.name === name);
}

/** The volume Settings offers for a voice of yours, in dB: -6 to +12, 1 dB apart. */
export const GAIN_MIN_DB = -6;
export const GAIN_MAX_DB = 12;

/** A voice's sidecar: <Name>.json beside its file. */
export const voiceSidecar = (name: string, dir = VOICES_DIR) => join(dir, `${name}.json`);

/**
 * How loud a voice of yours is, from its sidecar (<Name>.json: { "gainDb": 5 }): 0 dB when there's
 * none; 0 dB and what's wrong (`problem`, for one line in the log) when it isn't JSON or its gainDb
 * isn't a number. Kept to GAIN_MIN_DB..GAIN_MAX_DB.
 */
export function voiceGain(name: string, dir = VOICES_DIR): { gainDb: number; problem?: string } {
  const path = voiceSidecar(name, dir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err: any) {
    return err?.code === "ENOENT" ? { gainDb: 0 } : { gainDb: 0, problem: `can't read ${path} (${err?.code ?? err?.message ?? err})` };
  }
  let gainDb: unknown;
  try {
    gainDb = JSON.parse(text)?.gainDb;
  } catch {
    return { gainDb: 0, problem: `${path} isn't JSON` };
  }
  if (gainDb === undefined) return { gainDb: 0 };
  if (typeof gainDb !== "number" || !Number.isFinite(gainDb)) return { gainDb: 0, problem: `${path}: gainDb isn't a number` };
  return { gainDb: Math.min(GAIN_MAX_DB, Math.max(GAIN_MIN_DB, gainDb)) };
}

/** A voice's volume saved in its sidecar, anything else in it kept (one that isn't JSON is replaced). */
export function saveVoiceGain(name: string, gainDb: number, dir = VOICES_DIR) {
  const path = voiceSidecar(name, dir);
  let had: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) had = parsed;
  } catch {
    // none yet, or not JSON
  }
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ ...had, gainDb: Math.min(GAIN_MAX_DB, Math.max(GAIN_MIN_DB, Math.round(gainDb))) }, null, 2)}\n`);
  renameSync(temp, path);
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
