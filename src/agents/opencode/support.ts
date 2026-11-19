// What OpenCode's sessions get (../support.ts), as against Claude Code's. No hooks: Kiko is one
// more client of its background service, which does nearly everything itself, wherever its TUI
// runs (words, rename, interrupt, answers). What's missing is what OpenCode doesn't have (a session
// before its first message, permission-mode flags) and what's only read from its source so far.
import { type AgentSupport, na, notBuilt, partial, toolLimit, yes } from "../support.ts";
import { NAME } from "../../core/name.ts";

export const opencodeSupport: AgentSupport = {
  id: "opencode",
  name: "OpenCode",
  features: {
    listed: yes("while a TUI that made, used or looked at it runs in its folder, in any terminal; of several tabs, each one used since its TUI opened"),
    listedAtOnce: toolLimit(`OpenCode makes a session at its first message, so a TUI with nothing typed has none; in ${NAME}'s tmux its pane is listed all the same (\`runsAs\`)`),
    status: yes(`from its service's \`session.status\`; blocked while ${NAME} holds a permission or questions of it`),
    heard: yes("`session.execution.succeeded`, for a session a TUI shows (`opencode run` and its web app aren't read out)"),
    speaker: yes('"OpenCode"'),
    replyWindow: yes("the reply goes to it as a new message through its service: OpenCode waits on no one after a turn"),
    typedWhileHeld: yes("typing in its TUI starts a turn (`session.status` busy), which closes the reply window"),
    promptStarted: yes("its service's `session.inbox.enqueued`"),
    wordsInTmux: yes("typed into its pane"),
    wordsOutside: yes("a new message through its service (`message`), anywhere, no keys, a draft left alone; only while a TUI shows it"),
    dictatedNote: notBuilt("its words go in as they are: no hook of its adds a line beside a message, and one in the message itself would show in the conversation"),
    permissions: yes("`permission.asked`, answered through its service"),
    allowAlways: yes('when OpenCode says what it would keep (`save`), as its own "Always allow"'),
    safetyGate: notBuilt(
      `${NAME} reaches OpenCode through its service, which has no hook before a tool runs; a plugin's \`tool.execute.before\` could check each call (it can block, not ask), and \`ask\` rules in its config would make it ask (a card here), but ${NAME} changes nothing of OpenCode's own`,
      true,
    ),
    questions: yes("its question tool's forms; another form (an MCP server's) is said, to answer in its window"),
    interruptInTmux: yes("through its service (`POST …/interrupt`), no Escape"),
    interruptOutside: yes("through its service, wherever it runs"),
    renameInTmux: yes("its title, through its service (no slash command renames); Ctrl+R in it shows here"),
    renameOutside: yes("through its service, wherever it runs"),
    closeInTmux: yes("`/exit` (from its source; not tried with the real OpenCode)", true),
    closeOutside: partial(
      "SIGHUP to its TUI, only for the session in front (used last) of a folder's one TUI: its other tabs, or two TUIs in one folder, aren't closed (it would close the whole TUI). Its SIGHUP quit is from its source, not tried with the real one",
      true,
    ),
    start: yes("`opencode`, when you name it or it's picked"),
    startPrompt: yes("`opencode --prompt <words>`"),
    startName: yes("renamed through its service once it's listed (`namesLater`)"),
    startHeldWords: yes("typed in once its prompt shows (`readyOnScreen`: `Ask anything…`, from its source)", true),
    trustCard: na("OpenCode asks nothing of a folder at start"),
    loginFailed: notBuilt("watched for the main agent's sessions only (app/starting.ts `loginWatched`); how its service tells a turn that failed to sign in is unchecked", true),
    knownFolders: notBuilt(
      "its service keeps every session with its folder; core asks only the main agent's (agents/index.ts `together`). Which endpoint lists them all, folders unknown, is unchecked",
      true,
    ),
    startMode: toolLimit("`opencode` 2.0.32 has no flag for any mode (its `--auto` approves everything not denied, nearer bypass): it starts in your config's permissions"),
    modeShown: notBuilt("its nearest is the agent a session runs (build or plan); whether its service says which, as it changes, is unchecked", true),
    autoBlocks: yes(
      "no auto mode, but a call your deny rules stop without asking is said: its service's `session.tool.failed` with `permission.rejected`, for a call no `permission.asked` was made for",
    ),
    blockOverride: toolLimit("a deny rule is your own setting, and OpenCode has no API to allow past it: said, never offered"),
    history: yes("its messages, mirrored as a transcript"),
    phone: yes(),
    mark: yes("▣ in its amber"),
    setup: yes(`${NAME}'s own yes to listening to its service (\`linkedAgents\`), nothing of OpenCode's written; a service before 2.0, or one refusing its own password, is "needs repair"`),
    hooksCurrent: na(`no hooks file: ${NAME} listens to its service`),
  },
};
