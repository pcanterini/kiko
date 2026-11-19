// Settings → Dictionary, and by voice: the words speech-to-text should expect, and entries added
// and removed ("Add to dictionary: ghosty means Ghostty").
import { config } from "../../core/config.ts";
import type { Session } from "../../core/sessions.ts";
import { addEntry, builtIn, removeEntry } from "../../core/dictionary.ts";
import { speechHints } from "../../core/stt-hints.ts";
import { ui } from "../../core/ui-store.ts";
import { log } from "../../core/log.ts";
import { speakLine } from "../speech.ts";
import { sttEngine } from "../state.ts";
import { refreshSettings } from "../settings-screen.ts";

/**
 * The words speech-to-text should expect (stt-hints.ts), updated as sessions come and go and the
 * dictionary changes; the engine only passes on a list that changed. Never on key down.
 */
export function refreshHints(sessions: Session[] = ui.state.sessions) {
  sttEngine.setHints(config.sttHints ? speechHints(sessions) : []);
}

/** "Add to dictionary: ghosty means Ghostty", by voice or in the settings screen. */
export async function addWord(heard: string, write: string, by: "voice" | "settings") {
  let before: string | undefined;
  try {
    ({ before } = addEntry(heard, write));
  } catch (err) {
    ui.error("dictionary", err);
    if (by === "voice") await speakLine("I couldn't change the dictionary.");
    return;
  }
  log("dictionary_edit", { op: "add", heard, write, before, by });
  refreshHints();
  refreshSettings();
  ui.info(`dictionary: "${heard}" → "${write}"${before ? ` (was "${before}")` : ""}`);
  // One word is spelled out: "Ghostty" and "Ghostie" sound the same.
  const letters = /^\p{L}{2,12}$/u.test(write) ? `, ${[...write.toUpperCase()].join("-")}` : "";
  if (by === "voice") await speakLine(`Added: ${heard} becomes ${write}${letters}.`);
}

/** "Remove ghosty from the dictionary". */
export async function removeWord(heard: string, by: "voice" | "settings") {
  let gone: ReturnType<typeof removeEntry>;
  try {
    gone = removeEntry(heard);
  } catch (err) {
    ui.error("dictionary", err);
    if (by === "voice") await speakLine("I couldn't change the dictionary.");
    return;
  }
  log("dictionary_edit", { op: "remove", heard, removed: gone, by });
  refreshHints();
  refreshSettings();
  const words = gone.map((e) => e.heard).join(" and ");
  // A built-in one can't be removed, only outdone: an entry of yours writing the words as heard.
  const fixed = gone.length ? undefined : builtIn(heard);
  ui.info(gone.length ? `dictionary: removed ${gone.map((e) => `"${e.heard}"`).join(", ")}` : fixed ? `dictionary: "${heard}" → "${fixed.write}" is built in` : `dictionary: no "${heard}"`);
  if (by === "voice")
    await speakLine(
      gone.length ? `Removed ${words} from the dictionary.` : fixed ? `${heard} is built in. To keep it as you say it, add it: ${heard} means ${heard}.` : `${heard} isn't in the dictionary.`,
    );
}
