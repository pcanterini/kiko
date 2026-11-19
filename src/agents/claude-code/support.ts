// What Claude Code's sessions get (../support.ts): the reference every other agent is held to, so
// nearly all of it. What isn't is where no terminal adapter reaches a session for sure (outside
// Kiko's tmux, keys go only into a Ghostty window found by its title) or the desktop app, which
// Kiko never types into (no clipboard: ARCHITECTURE.md "No adapter for the Claude desktop app").
import { type AgentSupport, partial, yes } from "../support.ts";
import { NAME } from "../../core/name.ts";

export const claudeCodeSupport: AgentSupport = {
  id: "claude-code",
  name: "Claude Code",
  features: {
    listed: yes("`claude agents` and its pid records, in any terminal and the desktop app; a background job a session was moved into is listed as that session"),
    listedAtOnce: yes(`as it registers (its SessionStart hook, else the next look): after its trust question, which a session ${NAME} opened shows as starting`),
    status: yes(
      'busy only while in a turn (its hooks, then `claude agents` and its transcript), with what a background job still runs in the background shown apart ("idle · 2 in background"); and yellow "waits for you" for a background job stopped on a question of its own',
    ),
    heard: yes("its Stop hook, with `last_assistant_message`"),
    speaker: yes('"Claude"'),
    replyWindow: yes("its Stop hook held and answered `block`; 7 in a row (Claude Code takes 8 continuations), then your words are typed in"),
    typedWhileHeld: yes("a queued prompt in its transcript (typed-in.ts)"),
    promptStarted: yes('its UserPromptSubmit hook (optional: "Add the rest" in settings)'),
    wordsInTmux: yes(),
    wordsOutside: partial(
      "only into a Ghostty window found for sure (by its title, or the only one in its folder): Warp, iTerm and your own tmux aren't typed into, and the desktop app isn't by choice (no clipboard). Claude Code has no way in from outside",
    ),
    dictatedNote: partial(
      "its UserPromptSubmit hook adds it beside the prompt (optional: \"Add the rest\" in settings), a first message on its command line too. Not for words typed while it's busy that it takes in as the turn goes, between two steps: no hook comes for those (ones still queued at the turn's end are a prompt of their own, and get it)",
    ),
    permissions: yes("its PermissionRequest hook"),
    allowAlways: yes("when Claude Code offers one (`permission_suggestions`, given back as `updatedPermissions`)"),
    safetyGate: yes(
      'its PreToolUse hook (Bash, Monitor and MCP tools only) answers "ask" for a call the rules or the classifier flag, which makes Claude Code ask even in bypass permissions or past an allow rule (checked on 2.1.316); the prompt comes as an ordinary PermissionRequest card. Headless runs (`claude -p`, the Agent SDK) aren\'t gated: nobody is there to ask. With the gate off (the default) the hook reads that from the settings file and passes at once',
    ),
    questions: yes("AskUserQuestion, through its PermissionRequest hook (allowed with `answers`)"),
    interruptInTmux: yes("Escape"),
    interruptOutside: partial("Escape only where keys reach it for sure (a Ghostty window found by title): Claude Code has no way to interrupt a session from outside its terminal"),
    renameInTmux: yes("`/rename <name>` typed in; a /rename in it shows from its transcript"),
    renameOutside: partial("`/rename` only where keys reach it for sure (a Ghostty window found by title): Claude Code has no way to rename a session from outside its terminal"),
    closeInTmux: yes("`/exit`"),
    closeOutside: yes("SIGTERM after checking its process (`claude stop` for a background job): it saves and runs its end hooks as for /exit; never the desktop app's"),
    start: yes(),
    startPrompt: yes("`claude <prompt>`"),
    startName: yes("`claude --name <name>`"),
    startHeldWords: yes("held until it's listed (past its trust question), then typed in"),
    trustCard: yes(`in ${NAME}'s tmux (its pane read and its keys pressed: core/trust-prompt.ts); Ghostty has no screen to read, so there it's said to wait in its window`),
    loginFailed: yes('"Not logged in" read from its transcript (it runs no Stop hook for it): core/login-check.ts'),
    knownFolders: yes("~/.claude/projects read back to paths, with the names given there"),
    startMode: yes("`--permission-mode <mode>` (Ask me as `default`); a scratch session, while the setting is left at its default, in `auto` where `claude --help` lists it"),
    modeShown: yes("`permission_mode` on each hook event; a Shift+Tab shows at its next event"),
    autoBlocks: yes("its PermissionDenied hook (optional)"),
    blockOverride: partial(
      `in ${NAME}'s tmux only: yes takes it out of auto mode (Shift+Tab, its screen read back after each press) and asks it to try again, so the call comes back as an ordinary prompt; its hook can't allow (only \`retry\`, which auto mode checks again), so outside tmux, in plan mode or the Claude app, the block is said with why`,
    ),
    history: yes("its transcript"),
    phone: yes(),
    mark: yes("✻ in its orange"),
    setup: yes('hooks in ~/.claude/settings.json; a hook\'s script gone, or Stop or PermissionRequest missing, is "needs repair"'),
    hooksCurrent: yes("~/.claude/settings.json given the events it lacks (PermissionDenied, for installs from before it) at start"),
  },
};
