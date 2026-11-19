// What Codex CLI's sessions get (../support.ts), as against Claude Code's. Its hooks are nearly
// Claude Code's (Stop held for a reply, PermissionRequest allowed or denied), and its shared
// app-server daemon (0.166 on) lists, renames and interrupts its threads; what's missing is mostly
// what a hook can't do (an "always", its questions), and what the daemon could but isn't used for
// yet (sending messages, approvals and questions through it).
import { type AgentSupport, notBuilt, partial, toolLimit, yes } from "../support.ts";
import { NAME } from "../../core/name.ts";

export const codexSupport: AgentSupport = {
  id: "codex",
  name: "Codex",
  features: {
    listed: yes(`from its shared daemon (0.166+) while a Codex TUI runs in its folder, and from the records its hook keeps; one in ${NAME}'s tmux from its pane too`),
    listedAtOnce: yes("0.166+, from its daemon; before 0.166, from its first message (Codex runs no hook before it)"),
    status: yes("from its hooks and its daemon's `thread/status/changed`"),
    heard: yes("its Stop hook, with `last_assistant_message`"),
    speaker: yes('"Codex"'),
    replyWindow: yes("its Stop hook held and answered `block`, which carries the same turn on; no limit in Codex (20 in a row, then typed in)"),
    typedWhileHeld: toolLimit(`what's typed into Codex while its Stop hook runs steers that turn: it isn't in a queue ${NAME} can read (Claude Code's queued prompt)`),
    promptStarted: yes("its UserPromptSubmit hook"),
    wordsInTmux: yes("always as one bracketed paste (its TUI takes fast keys as a paste)"),
    wordsOutside: partial(
      "only into a Ghostty window found for sure, and Codex titles its window with its folder's name unless `[tui] terminal_title` has `thread-id`. Not built: its daemon's `turn/start` / `turn/steer` would reach it anywhere (whether without subscribing to the thread is unconfirmed)",
    ),
    dictatedNote: partial(
      "its UserPromptSubmit hook adds it beside the prompt (a developer message), the first words of one still starting too (asked under the ID it had while it started). Unchecked: whether its hook runs for a first message on its command line, and for words typed while it's busy that it takes into the running turn",
      true,
    ),
    permissions: yes("its PermissionRequest hook; a patch read as an edit of its first file"),
    allowAlways: toolLimit("a hook's allow is for one request: Codex rejects `updatedPermissions`. Its daemon's approvals (not used yet) may have an allow for the session: unchecked", true),
    safetyGate: yes(
      `its PreToolUse hook can't make Codex ask ("ask" is unsupported, and lets the call run), so the hook holds a flagged call as ${NAME}'s own card: yes lets it run, no or no answer denies it (\`permissionDecision: "deny"\`, which Codex honours whatever its sandbox or approval mode). Needs Codex to trust the updated hook once. With the gate off (the default) the hook reads that from the settings file and lets the call run at once`,
    ),
    questions: notBuilt(
      "no hook can answer `request_user_input` (said, to answer in its window); its daemon's `item/tool/requestUserInput` can, for a client subscribed to the thread (`thread/resume`), alongside its TUI",
    ),
    interruptInTmux: yes("through its daemon (`turn/interrupt`) when it has the thread, else Escape"),
    interruptOutside: yes("through its daemon (`turn/interrupt`, 0.166+), wherever it runs; without one, Escape only where keys reach it for sure"),
    renameInTmux: yes("through its daemon (`thread/name/set`) when it has the thread, else `/rename`; a /rename in it shows here"),
    renameOutside: yes("through its daemon (`thread/name/set`, 0.166+), wherever it runs; without one, `/rename` only where keys reach it for sure"),
    closeInTmux: yes("`/exit`"),
    closeOutside: partial(
      "SIGTERM after the checks, only for a session whose TUI process its hook found: on 0.166 its hooks run in the shared daemon with no TUI above them, so none can be closed (its folder's one Codex TUI could be taken, as OpenCode's is). And Codex's TUI has no SIGTERM handler: no SessionEnd, its terminal left for `reset`",
    ),
    start: yes(
      "`codex`, when you name it or it's picked; with `-c check_for_update_on_startup=false` (its own update screen can't be answered by voice; `kiko codex` too, unless you set it), and a fresh scratch folder Kiko made trusted for that launch (`-c projects=…`)",
    ),
    startPrompt: yes("`codex <prompt>`"),
    startName: yes("renamed once it's listed and idle (`namesLater`): Codex has no flag for a name"),
    startHeldWords: yes("typed in once its composer shows (`readyOnScreen`)"),
    trustCard: yes(
      `its "Trust this folder?" (trust: "Trust and continue", so Codex saves it; no: "Quit") and "Hooks need review" (trust: "Trust all and continue"; no: "Continue without trusting", unheard) as cards, never answered for you, in ${NAME}'s tmux (its pane read, its › moved and seen before Enter: core/trust-prompt.ts); Ghostty has no screen to read`,
    ),
    loginFailed: notBuilt(
      "watched for the main agent's sessions only (app/starting.ts `loginWatched`, from Claude Code's transcript); how a Codex turn that couldn't sign in shows in its rollout or daemon is unchecked",
      true,
    ),
    knownFolders: notBuilt("its rollouts ($CODEX_HOME/sessions) record each session's folder; core asks only the main agent's (agents/index.ts `together`), so that's needed too"),
    startMode: partial("its nearest flags (`codexModeArgs`): Plan has none (its plan mode is switched in its TUI), Auto is its own reviewer (`--approve-for-me`), and Ask me reads freely"),
    modeShown: partial("from its daemon's `thread/settings/updated` only: unknown until a thread's settings change (its hooks don't carry it)"),
    autoBlocks: notBuilt(
      `no PermissionDenied hook; its daemon tells a reviewer's denial (\`item/autoApprovalReview/completed\`, status denied) only to clients subscribed to that thread (thread/resume), and it isn't in the rollout; ${NAME} only reads threads. With ${NAME}'s PermissionRequest hook in, Codex's approvals are ${NAME}'s cards first (hooks run before its reviewer), so the reviewer sees only what a card let go of`,
    ),
    blockOverride: notBuilt(
      "Codex has one, `thread/approveGuardianDeniedAction {threadId, event}` (its TUI's /approve: one retry, still reviewed), but it needs the denial's event, which needs that thread subscription; meanwhile /approve in its window",
    ),
    history: yes("its rollout, mirrored as a transcript"),
    phone: yes(),
    mark: yes("⌬ in its blue"),
    setup: yes('hooks in $CODEX_HOME/hooks.json (Codex asks to trust them once); hooks that never fire are "needs repair" (`health`)'),
    hooksCurrent: yes("$CODEX_HOME/hooks.json given the events it lacks at start (Codex asks to trust a new one once)"),
  },
};
