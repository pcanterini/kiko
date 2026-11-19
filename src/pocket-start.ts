// Pocket's download (core/pocket-prep.ts) started in the background when it's the voice that will
// speak: nothing chosen (no voice picked in the settings or KIKO_TTS) and no Cartesia key, so the
// voice now is the macOS one. Run by install.sh as soon as Kiko's files are in place (`kiko
// _run pocket`), so it overlaps setup's steps; first-run setup starts it too as it opens
// (../onboard.ts), which does nothing more when it's running already. Prints nothing, writes no
// settings (their being there means setup has run: start.ts); returns at once, the download going on.
// First: a checkout's .env's KIKO_ values, before anything reads one (core/dev-env.ts).
import "./core/dev-env.ts";
import { running } from "./core/app-root.ts";
import { config } from "./core/config.ts";
import { settingEnv } from "./core/env.ts";
import { log } from "./core/log.ts";
import { startPocketPrep } from "./core/pocket-prep.ts";
import { loadSettings } from "./core/settings.ts";

/** A voice picked (KIKO_TTS, .env or the settings): Pocket's download isn't started for it, nor switched to. */
export const voiceChosen = () => Boolean(settingEnv("tts") || loadSettings().tts);

/** Started (or running already, or ready); "not-needed" when another voice will speak. */
export function startPocket(): ReturnType<typeof startPocketPrep> | "not-needed" {
  if (config.tts !== "say" || voiceChosen()) return "not-needed";
  return startPocketPrep();
}

// Run, not imported (onboard.ts imports it): in the installed executable every module's
// import.meta.filename is the executable's own path, argv[1] too, so only `_run pocket` (running)
// or Node's import.meta.main say so.
if (running.program === "pocket" || (!running.program && import.meta.main)) {
  const did = startPocket();
  log("pocket_prep", { did, by: "install" });
  process.exit(0);
}
