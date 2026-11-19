// Codex CLI (github.com/openai/codex), the third agent: its sessions in a terminal, as Claude
// Code's are, heard through its hooks (hooks/codex-hook.mjs, added to $CODEX_HOME/hooks.json by
// `kiko setup codex`: ./setup.ts), which reach Kiko's one hooks socket (./hooks.ts).
//
//   listed        as soon as it's open (0.166 on), wherever it runs: from Codex's shared app-server
//                 daemon (./daemon.ts), while a Codex TUI runs in its folder (./processes.ts); and
//                 from the records its hook keeps (./sessions.ts), from its first turn, which is when
//                 its hooks first run. Each session once (sessions.ts mergeLive). Named by its folder,
//                 or Codex's own name for it (`nameOf`: /rename). With neither (no daemon, hooks that
//                 never fire), one in a pane of Kiko's tmux is listed from its pane (runsAs,
//                 app/starting.ts adoptPanes); hooks set up that never fire make it "needs repair", said once
//                 (setup.ts health)
//   heard         its Stop hook, held for your reply as Claude Code's is: the reply carries the same
//                 turn on (decision "block"); Codex has no limit on those
//   replied to    typed in, at any moment, where a terminal adapter reaches it (its pane in Kiko's
//                 tmux, found by its process; a Ghostty window found for sure), always as a bracketed
//                 paste (its TUI takes an Enter right after fast keys as a new line)
//   permissions   its PermissionRequest hook, held as Claude Code's: allowed or denied this once
//                 (Codex has no "always" for a hook); let go, its own prompt shows
//   questions     request_user_input can't be answered by a hook: said, and answered in its window
//   started       `codex [-c overrides] [mode flags] [prompt]` in Kiko's tmux ("start a Codex
//                 session in pixie"): its "update available" screen off, and a fresh scratch folder
//                 Kiko made trusted for that launch (./launch.ts); its folder-trust and "Hooks need
//                 review" screens otherwise cards (core/trust-prompt.ts); in the "Permission mode"
//                 setting's nearest (codexModeArgs); a name is
//                 given with /rename once it's listed (no flag names it). One started without a
//                 prompt is listed from its first message (0.166: as its daemon opens its thread):
//                 until then the words held for it are typed in once its window shows its prompt
//                 (readyOnScreen)
//   renamed       through its daemon (thread/name/set), wherever it runs, nothing typed: shown in
//                 its TUI and listed by it; one the daemon doesn't have: /rename <name> typed where
//                 keys reach it for sure. A /rename in Codex shows here as the daemon tells it
//   interrupted   through its daemon (turn/interrupt of its turn in progress), else Escape where keys
//                 reach it; closed: /exit in Kiko's tmux, else SIGTERM after the same checks as
//                 Claude Code's (./sessions.ts endProcess)
//   history       its rollout, turned into a transcript's lines for the phone and the window (./mirror.ts)
import { dirname, join } from "node:path";
import { decideGuard } from "../../core/guard.ts";
import { HistoryWatcher } from "../../core/history.ts";
import { log } from "../../core/log.ts";
import { pagePath } from "../../core/page.ts";
import { endHook, writeHook } from "../hook-conn.ts";
import { takeHooks } from "../hook-routes.ts";
import { codexArgs } from "./launch.ts";
import type { NewSessionMode } from "../../core/permission-mode.ts";
import type { Agent } from "../types.ts";
import { CodexRequest, onHookLine, type CodexEvent } from "./hooks.ts";
import { Mirrors } from "../mirror.ts";
import { rolloutSource } from "./mirror.ts";
import { lastCodexText, lastUserText } from "./rollouts.ts";
import { CODEX_AGENT, codexHome, endProcess, listSessions, readRecords, threadNames } from "./sessions.ts";
import { CodexDaemon } from "./daemon.ts";
import { tuiFolders } from "./processes.ts";
import { codexSetup, noteHeard } from "./setup.ts";

/** The sessions shown in the Kiko window or on the phone, as transcript files: next to Kiko's page, in codex/. */
const mirrors = new Mirrors(
  () => join(dirname(pagePath()), "codex"),
  (id) => rolloutSource(rolloutOf(id)),
);

// Rollouts and session IDs, as its hooks and records tell them: what a session known only by its
// ID (a hook, the timeline, the phone) is found by.
const rollouts = new Map<string, string>();
const known = new Set<string>();

/** Codex's shared app-server daemon (0.166 on): its open threads, listed before (or without) their hooks; renamed and interrupted through it. */
export const daemon = new CodexDaemon(() => ({ home: codexHome(), log }));

/**
 * A session's name, from one place: Codex's own (/rename, by you or through its daemon). Its daemon's
 * name for a thread it has open, else the newest in session_index.jsonl (Codex writes both at once).
 */
export function nameOf(sessionId: string): string {
  return daemon.nameOf(sessionId) ?? threadNames().get(sessionId) ?? "";
}

/** A session's rollout: told by its hooks, else by its daemon, else from its record. */
function rolloutOf(sessionId: string): string | undefined {
  const told = rollouts.get(sessionId) ?? daemon.pathOf(sessionId);
  if (told) return told;
  const record = readRecords().find((r) => r.sessionId === sessionId);
  if (record?.transcriptPath) rollouts.set(sessionId, record.transcriptPath);
  return record?.transcriptPath;
}

/**
 * Codex's flags for the "Permission mode" setting (core/permission-mode.ts), its nearest honest match,
 * from `codex --help` 0.166.0 (its -a takes only on-request and never: "untrusted" is refused):
 *   Ask me         -a on-request -s read-only        it reads freely and asks before any edit or command
 *                                                    that needs more (Claude Code's Manual asks for each edit)
 *   Accept edits   -a on-request -s workspace-write  edits and commands inside the folder without asking;
 *                                                    asks to go past it
 *   Auto           --approve-for-me                  its requests reviewed by Codex's own automatic
 *                                                    reviewer (approvals_reviewer auto_review), in the
 *                                                    workspace-write sandbox: Claude Code's auto, its way
 *   Plan           nothing: Codex's plan mode is a collaboration mode switched in its TUI (Shift+Tab),
 *                  with no flag; it starts in your Codex default
 *   Your default   nothing (inherit): your ~/.codex/config.toml
 */
export function codexModeArgs(mode: NewSessionMode | undefined): string[] {
  switch (mode) {
    case "manual":
      return ["-a", "on-request", "-s", "read-only"];
    case "acceptEdits":
      return ["-a", "on-request", "-s", "workspace-write"];
    case "auto":
      return ["--approve-for-me"];
    default:
      return [];
  }
}

/** What its hooks tell: its ID and rollout, noted. */
function noted(e: CodexEvent) {
  known.add(e.session_id);
  // A hook told of it (setup.ts health: a turn none told of means they don't fire).
  noteHeard(e.session_id);
  if (typeof e.transcript_path === "string" && e.transcript_path) rollouts.set(e.session_id, e.transcript_path);
}

/** The lines Codex's composer shows when it's ready for words, and what it shows when it asks something first (codex-rs/tui, 0.153.0 and 0.166.0). */
const COMPOSER = /^\s*› Ask Codex to do anything/m;
const ASKING = [
  "Do you trust the contents of this directory",
  // 0.166.0's folder trust screen.
  "Trust this folder?",
  "Trust and continue",
  "Hooks need review",
  "Update available!",
  "Choose how you'd like Codex to proceed",
  "Sign in with ChatGPT",
  "Choose working directory to resume",
  "Would you like to",
  "esc to interrupt",
];

/** Whether a Codex window shows its empty composer with nothing in front of it or running. */
export const atCodexPrompt = (screen: string) => COMPOSER.test(screen) && !ASKING.some((a) => screen.includes(a));

export const codex: Agent = {
  id: CODEX_AGENT,
  name: "Codex",
  speaker: "Codex",
  starts: true,
  // "Start a Codex session", as speech-to-text may write it.
  heard: /\b(?:codex|codecs|code x)\b/i,
  // ⌬, a hexagon after OpenAI's knot, in its TUI's accent blue (UI_ACCENT, the colour of its ">_"
  // header mark), and the TUI's own accent for a light background. Nerd Fonts 3.5's cod-openai.
  mark: { glyph: "⌬", nerd: "", color: { dark: "#63A8F8", light: "#1C64C8" } },
  // Asked of every session without an agent (Claude Code's), often: what its hooks and listings told only.
  owns: (sessionId) => known.has(sessionId),
  onNotice: () => {},
  onHeld: () => {},
  onSessionsChanged: () => {},
  onPromptSubmitted: () => {},
  onSessionEnded: () => {},
  // Its hooks come through Claude Code's socket (the main agent starts it); its daemon, looked for
  // now and as its sessions are listed (it isn't there before 0.166, or with no Codex open).
  start: () => daemon.start(),
  stop: () => {
    mirrors.stop();
    daemon.stop();
  },
  // Its hooks in $CODEX_HOME/hooks.json: the first-run card, settings → Agents, kiko setup codex (./setup.ts).
  setup: codexSetup,
  list: async () => {
    const threads = await daemon.loaded();
    // Which of its threads still have a TUI: looked at only when it has some.
    const folders = threads?.length ? await tuiFolders(codexHome()) : null;
    const sessions = await listSessions(undefined, { threads, folders }, nameOf);
    for (const s of sessions) known.add(s.sessionId);
    mirrors.keepOnly(new Set(sessions.map((s) => s.sessionId)));
    return sessions.map((s) => ({ ...s, bracketed: true }));
  },
  names: (of) => ({ givenName: nameOf(of.sessionId), title: "" }),
  lastAsked: (of) => lastUserText(rolloutOf(of.sessionId)),
  lastSaid: (of) => lastCodexText(rolloutOf(of.sessionId)),
  watchHistory: (of, changed) => new HistoryWatcher(mirrors.path(of.sessionId), changed),
  historyFile: (of) => mirrors.path(of.sessionId),
  madeUpFolder: () => false,
  // Codex has no limit on Stop-hook continuations; past this many in a row, your words are typed in.
  heldReplies: 20,
  interruptKey: "escape",
  renameCommand: (name) => `/rename ${name}`,
  exitCommand: "/exit",
  // Outside Kiko's tmux: SIGTERM after the checks (./sessions.ts), for one whose process its hook found.
  end: (session) => endProcess(session),
  // Renamed and interrupted through its daemon, wherever it runs (no keys typed), while the daemon has it open.
  can: (session) => ({ close: Number.isInteger(session.pid), rename: daemon.has(session.sessionId), interrupt: daemon.has(session.sessionId) }),
  rename: (of, name) => daemon.rename(of.sessionId, name),
  interrupt: (of) => daemon.interrupt(of.sessionId),
  // `codex [-c overrides] [mode flags] [prompt]`: its update question off, and a folder Kiko made
  // for it (a fresh scratch folder) trusted for this launch (./launch.ts); in the setting's mode as
  // near as Codex has one (codexModeArgs), the prompt its first message. No flag names a session:
  // /rename once it's listed (namesLater).
  startCommand: ({ prompt, mode, madeFolder }) => ({
    program: "codex",
    args: codexArgs([...codexModeArgs(mode), ...(prompt ? [prompt] : [])], madeFolder ? { trusted: madeFolder } : {}),
  }),
  namesLater: true,
  readyOnScreen: atCodexPrompt,
  // Its TUI in a pane of Kiko's tmux (`kiko codex`): listed from the pane, hooks or not.
  runsAs: (command) => command === "codex",
  knownFolders: () => [],
};

// One opened, closed, renamed, or started or stopped working, as its daemon tells every client: listed again now.
daemon.onChanged = () => codex.onSessionsChanged();

takeHooks(CODEX_AGENT, (event, conn) =>
  onHookLine(event, conn, {
    held: (request) => {
      noted(request.event);
      codex.onHeld(request);
    },
    started: (e) => {
      noted(e);
      codex.onSessionsChanged();
    },
    ended: (e) => {
      noted(e);
      codex.onSessionEnded(e.session_id);
      codex.onSessionsChanged();
    },
    // Your dictated words the app typed in (core/dictated.ts): the app's answer, once the agents are put together.
    dictated: (e) => codex.dictated?.(e.session_id, e.prompt ?? "") ?? false,
    prompted: (e) => {
      noted(e);
      codex.onPromptSubmitted(e.session_id, e.prompt ?? "");
      codex.onSessionsChanged();
    },
    // Its turn stopped (Esc): its status in the list changes.
    interrupted: (e) => {
      noted(e);
      codex.onSessionsChanged();
    },
    // Kiko's safety gate (core/guard.ts): the verdict first; an ask is then held as a card, like a permission.
    guard: (check, e, conn) => {
      noted(e);
      const verdict = codex.onGuard ? codex.onGuard(check) : decideGuard(check, { on: true, off: [] });
      void verdict
        .catch(() => ({ ask: check.hits.length > 0 }))
        .then((v) => {
          if (!v.ask) return void endHook(conn, `${JSON.stringify({ guard: { ask: false } })}\n`);
          // Its hook gave up while the gate decided (Codex timed it out, the session went): no card for it.
          if (!writeHook(conn, `${JSON.stringify({ guard: { ask: true } })}\n`)) return void log("hook_gone", { kind: "PreToolUse", sessionId: e.session_id, agent: "codex", guarded: true });
          const request = new CodexRequest(e, conn);
          log("hook_permission", { ...e, guarded: true });
          codex.onHeld(request);
        });
    },
    asking: (e) => {
      noted(e);
      const name = nameOf(e.session_id) || e.cwd.split("/").pop() || "A Codex session";
      codex.onNotice(`${name} in Codex is asking you something in its window: answer it there.`);
    },
  }),
);
