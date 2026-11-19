// Claude Code, the first agent adapter. Its sessions reach Kiko through the global hooks in
// ~/.claude/settings.json (hooks/claude-code-hook.mjs on Stop and PermissionRequest, on SessionStart and
// SessionEnd to say one started or ended, on UserPromptSubmit to say one took a prompt in, and on
// PermissionDenied to say auto mode blocked something, over a socket: ./hooks.ts; the entries are in
// ./settings.ts), wherever they run; they're listed with `claude agents` (./sessions.ts), and read
// from their transcripts (./transcripts.ts, and core/history.ts for a session's conversation).
import { decideGuard } from "../../core/guard.ts";
import { HistoryWatcher } from "../../core/history.ts";
import { loadRenames } from "../../core/renames.ts";
import type { NewSessionMode } from "../../core/permission-mode.ts";
import type { Agent } from "../types.ts";
import { HookServer } from "./hooks.ts";
import { historyFolders } from "./projects.ts";
import { endProcess, faceOf, inScratch, listSessions } from "./sessions.ts";
import { lastClaudeText, lastUserMessage, transcriptInfo, transcriptPath } from "./transcripts.ts";
import { offersMode } from "./modes-offered.ts";
import { claudeCodeSetup } from "./setup.ts";
import { folderTrusted } from "./trust.ts";

const hooks = new HookServer();

/**
 * `--permission-mode` for the "Permission mode" setting (core/permission-mode.ts); none for "Your
 * Claude Code default" (inherit). Ask me is passed as "default": 2.1.314's --help calls it "manual",
 * but takes "default" too (checked 2026-10-30), as every version before it does, and its hooks say
 * "default" either way.
 */
export function permissionModeArgs(mode: NewSessionMode | undefined): string[] {
  if (!mode || mode === "inherit") return [];
  return ["--permission-mode", mode === "manual" ? "default" : mode];
}

export const claudeCode: Agent = {
  id: "claude-code",
  name: "Claude Code",
  // "In pixie, Claude says…": as its summaries always have.
  speaker: "Claude",
  starts: true,
  // "Start a Claude session", as speech-to-text writes it (core/sessions.ts CLAUDE).
  heard: /\b(?:claude|cloud|clawed|clod|claud)\b/i,
  // ✻, the glyph of its own banner and spinner, in its theme colour `claude` (rgb 215,119,87); a
  // darker terracotta on a light background, where that one is too pale. Nerd Fonts 3.5's cod-claude.
  mark: { glyph: "✻", nerd: "", color: { dark: "#D77757", light: "#C15F3C" } },
  onHeld: () => {},
  // Told by its SessionStart and SessionEnd hooks. Still listed every few seconds too, for sessions
  // started before those hooks were in its settings (they're optional), or one that was missed.
  onSessionsChanged: () => {},
  // Told by its UserPromptSubmit hook (optional, like SessionStart's).
  onPromptSubmitted: () => {},
  // Told by its SessionEnd hook.
  onSessionEnded: () => {},
  // Told by its PermissionDenied hook (optional): auto mode blocked a tool call.
  onBlocked: () => {},
  // Nothing of its own to say: its setup is the first-run card's and settings' (../setup.ts).
  onNotice: () => {},
  start: () => hooks.start(),
  stop: () => hooks.stop(),
  // Its hooks in ~/.claude/settings.json: connected, repaired and disconnected there (./setup.ts).
  setup: claudeCodeSetup,
  list: () => listSessions(),
  names: (of) => {
    // A background process running a terminal session's turns goes by that session's names.
    const face = faceOf(of.sessionId) ?? of;
    const { customTitle, aiTitle } = transcriptInfo(face.cwd, face.sessionId);
    return { givenName: customTitle, title: aiTitle };
  },
  lastAsked: (of) => lastUserMessage(transcriptPath(of.cwd, of.sessionId)),
  lastSaid: (of) => lastClaudeText(transcriptPath(of.cwd, of.sessionId)),
  watchHistory: (of, changed) => new HistoryWatcher(transcriptPath(of.cwd, of.sessionId), changed),
  historyFile: (of) => transcriptPath(of.cwd, of.sessionId),
  madeUpFolder: inScratch,
  // Its trust prompt's answer, read from ~/.claude.json (that one field, never written: ./trust.ts).
  folderTrusted: (folder) => folderTrusted(folder),
  // Claude Code allows 8 hook continuations in a row; past that a reply through the hook is ignored.
  heldReplies: 7,
  interruptKey: "escape",
  renameCommand: (name) => `/rename ${name}`,
  exitCommand: "/exit",
  // One outside Kiko's tmux, which nothing types /exit into: SIGTERM, which it takes the same way (./sessions.ts).
  end: (session) => endProcess(session),
  // Itself, with no terminal: only that Close, for one whose process (or background job) it knows; never the desktop app's.
  can: (session) => ({ close: !session.desktop && (session.kind === "interactive" ? Number.isInteger(session.pid) : Boolean(session.jobId)) }),
  // `claude --permission-mode <mode> --name <name> <prompt>`: in the mode the setting picks (none for
  // your own default), named from the start (as /rename would), and the prompt is its first message,
  // sent once it's ready. Nothing is typed in. The trust question comes first all the same.
  startCommand: ({ prompt, name, mode }) => ({
    program: "claude",
    args: [...permissionModeArgs(mode), ...(name ? ["--name", name] : []), ...(prompt ? [prompt] : [])],
  }),
  // Whether this Mac's Claude Code takes the mode: its `claude --help` choices, read once a run
  // (./modes-offered.ts). Asked before a scratch session starts in auto.
  offersMode: (mode) => offersMode(mode),
  // Names the app gave sessions (renames.json) count too: a /rename is in the transcript's tail only for a while.
  knownFolders: () => historyFolders(undefined, loadRenames()),
};

hooks.onRequest = (request) => claudeCode.onHeld(request);
hooks.onSessionsChanged = () => claudeCode.onSessionsChanged();
hooks.onPromptSubmitted = (sessionId, prompt) => claudeCode.onPromptSubmitted(sessionId, prompt);
// Whether a prompt is your dictated words the app typed in (core/dictated.ts): the app's answer, once the agents are put together.
hooks.dictated = (sessionId, prompt) => claudeCode.dictated?.(sessionId, prompt) ?? false;
hooks.onSessionEnded = (sessionId) => claudeCode.onSessionEnded(sessionId);
hooks.onBlocked = (blocked) => claudeCode.onBlocked?.(blocked);
// Kiko's safety gate (core/guard.ts): the app's verdict, once the agents are put together.
hooks.onGuard = (check) => (claudeCode.onGuard ? claudeCode.onGuard(check) : decideGuard(check, { on: true, off: [] }));
