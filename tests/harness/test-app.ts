// The faked-app harness: the real app (src/app.ts) end to end, with its I/O swapped for the stubs in stubs/
// (loader.mjs): no mic, speech, hooks socket, Ghostty, desktop app or models. Each case drives the hotkey and
// hook requests through globalThis.T and checks what was said, typed, sent and logged. Windows are short here
// (1.5s, 0.6s when only reporting, giving way 0.2s after a reading). No network, no cost.
//
//   pnpm test:app                                  ends with "app: all passed"
//   HARNESS_LOG_DIR=/some/dir pnpm test:app        the app's logs somewhere else
//
// run.sh sets the env (KIKO_TEST_HOLD_MS=100, KIKO_TEST_HOLD_ANSWER_MS=1000, …) and runs it in tests/harness/out/ (git-ignored):
// settings, state, dictionary and logs go there, and logs/latest.jsonl is left alone. Timing-sensitive: the
// deferred-announcement case can fail on a busy machine; run it again before chasing it.
//
// This file runs the cases, in their order (each goes on from where the one before left the app); cases/ has
// them by area (announce, words, settings, audio, phone, permissions, sessions, and one file per other agent),
// over driver.ts: the app started on its stubs, and what every case uses.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { announceCases, askedCases, deferredCases, windowCases } from "./cases/announce.ts";
import { audioCases, duckCases, handsFreeCases, muteCases } from "./cases/audio.ts";
import { codexCases } from "./cases/codex.ts";
import { glowCases } from "./cases/glow.ts";
import { opencodeCases } from "./cases/opencode.ts";
import { askCases, blockOverrideCases, guardCases, readOnlyCases } from "./cases/permissions.ts";
import { offlineCases } from "./cases/offline.ts";
import { phoneCases } from "./cases/phone.ts";
import { continuedCases, kikoWindowCases, harnessPickCases, sameFolderCases, sessionEventCases, tmuxCases } from "./cases/sessions.ts";
import { accountCases, dictionaryCases, logsCases, micCases, pronunciationCases, settingsFilterCases, voiceCanCases } from "./cases/settings.ts";
import { t3Cases } from "./cases/t3.ts";
import { cleanupCases, decidingCases, holdCases, justSpokeCases, nameCases, offerCases, pressedAgainCases, questionCases, quickTaskCases, redirectStopCases } from "./cases/words.ts";
import { begin, clipboardRuns, startOpened, T } from "./driver.ts";

// A case that fails ends the run (exit 1). Left to itself, its error reaches the app's crash handler
// (src/core/crash.ts: logged as crash_caught, "kept running") and the run waits forever.
try {
  await announceCases();
  await voiceCanCases();
  await startOpened();
  await justSpokeCases();
  await decidingCases();
  await quickTaskCases();
  await cleanupCases();
  await deferredCases();
  await dictionaryCases();
  await pronunciationCases();
  await redirectStopCases();
  await holdCases();
  await audioCases();
  await muteCases();
  await windowCases();
  await duckCases();
  await nameCases();
  await questionCases();
  await offerCases();
  await offlineCases();
  await sessionEventCases();
  await sameFolderCases();
  await continuedCases();
  await pressedAgainCases();
  await handsFreeCases();
  await micCases();
  await logsCases();
  await settingsFilterCases();
  await accountCases();
  await phoneCases();
  await askedCases();
  await askCases();
  await tmuxCases();
  await blockOverrideCases();
  await guardCases();
  await readOnlyCases();
  await codexCases();
  await startOpened();
  await kikoWindowCases();
  await harnessPickCases();
  await t3Cases();
  await opencodeCases();
  await glowCases();
  begin("no clipboard, all run: no case ran a clipboard command");
  assert.ok(T.ran.length > 0, "programs run are recorded");
  assert.deepEqual(clipboardRuns(), []);
  console.log("ok:", T.ran.length, "programs run, none for the clipboard");
  begin("no real program reached: claude, rex, tmux, osascript, security and the agents' CLIs all stubbed or faked");
  // run.sh puts out/refused-bin first on PATH: each of those there writes its name to out/refused and fails.
  assert.ok(!existsSync("refused"), `the app ran a real program run.sh refuses: ${existsSync("refused") ? readFileSync("refused", "utf8").trim().split("\n").join(", ") : ""}`);
} catch (err) {
  console.error("\napp: FAILED in the case above:", err);
  process.exit(1);
}
console.log("\napp: all passed");
process.exit(0);
