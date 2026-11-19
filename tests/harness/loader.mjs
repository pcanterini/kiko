// Swaps the app's I/O modules (mic, speech, Claude Code's hooks socket and its `claude --help`,tmux, Ghostty, AppleScript, models, the Mac's volume, its network addresses and Bonjour, whether someone is at it, its permissions) for stubs.
// Imports from the stubs themselves get the real module. stubs/ mirrors src/: stubs/core/router.ts stands in for src/core/router.ts.
const SRC = new URL("../../src/", import.meta.url).href;
const STUB = new URL("./stubs/", import.meta.url).href;
const STUBBED = new Set([
  "core/deepgram.ts",
  "core/summarizer.ts",
  "agents/claude-code/hooks.ts",
  "agents/claude-code/modes-offered.ts",
  "core/classifier.ts",
  "core/decisions.ts",
  "core/router.ts",
  "core/trim.ts",
  "core/cleanup.ts",
  "core/sessions.ts",
  "core/quick-task.ts",
  "core/ask-model.ts",
  "platform/macos/mic.ts",
  "platform/macos/apple-stt.ts",
  "platform/macos/speaker.ts",
  "platform/macos/say.ts",
  "platform/macos/hotkey.ts",
  "platform/macos/duck.ts",
  "platform/macos/network.ts",
  "platform/macos/presence.ts",
  "platform/macos/permissions.ts",
  "platform/macos/apple-events.ts",
  "terminals/ghostty/ghostty.ts",
  "terminals/tmux/tmux.ts",
  "terminals/tmux/show.ts",
]);
export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  if (r.url.startsWith(SRC) && !context.parentURL?.startsWith(STUB)) {
    const rel = r.url.slice(SRC.length);
    if (STUBBED.has(rel)) return { url: STUB + rel, shortCircuit: true, format: "module-typescript" };
  }
  return r;
}
