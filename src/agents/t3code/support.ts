// What T3 Code's threads get (../support.ts), as against Claude Code's sessions. Its threads live in
// its own app (`ownApp`), not a terminal, so what's typed into a pane doesn't apply ("n/a"); its
// server does the rest itself (messages, answers, stop, rename, archive, new threads: `launches`).
// What's missing is a reply window for a run that's already over, and its modes read and set.
import { type AgentSupport, na, notBuilt, partial, toolLimit, yes } from "../support.ts";
import { NAME } from "../../core/name.ts";

export const t3codeSupport: AgentSupport = {
  id: "t3code",
  name: "T3 Code",
  features: {
    listed: yes("each thread that isn't archived, settled or a subagent's, while T3 runs"),
    listedAtOnce: yes("as T3's shell tells of it"),
    status: yes("busy while its run goes, needs you while a request waits"),
    heard: yes("a completed run's last reply, read from its thread"),
    speaker: notBuilt(
      "a thread runs on Claude, Codex or OpenCode, which isn't read from T3 yet, so its summary says \"it\"; its model selection's provider could say (whether the shell's thread carries it is unchecked)",
      true,
    ),
    replyWindow: notBuilt("a completed run is over, so its turn is read out with no reply window; one could be opened as OpenCode's is, the reply sent as a new message (`message.dispatch`)"),
    typedWhileHeld: na("nothing of its turn is held (no reply window)"),
    promptStarted: yes("as a thread's run starts, with the message it took in"),
    wordsInTmux: na("its threads are in T3 Code, not a terminal"),
    wordsOutside: yes("a new message to the thread (`message.dispatch`), at any moment"),
    dictatedNote: notBuilt("its words go in as they are: `message.dispatch` takes the message only, and a line in it would show in the thread"),
    permissions: yes("`runtime-request.respond`; a request that can't be read here is said, to answer in T3 Code"),
    allowAlways: yes("for the session (`acceptForSession`), or always where the request offers it"),
    safetyGate: notBuilt(
      `T3 Code runs its agents itself (Claude through its SDK, Codex through its app server), and ${NAME}'s hooks leave its threads alone (no double asks: T3 answers its own prompts), so only what T3's own mode asks reaches ${NAME}; gating them would need T3 to ask, e.g. a hook answering "ask" in its Claude threads, which T3 would then show as a request (unchecked)`,
      true,
    ),
    questions: yes("Claude's questions in a T3 thread, answered by question ID"),
    interruptInTmux: na("its threads are in T3 Code, not a terminal"),
    interruptOutside: yes("`thread.stop`, or `run.interrupt` of its live run"),
    renameInTmux: na("its threads are in T3 Code, not a terminal"),
    renameOutside: yes("its title (`thread.metadata.update`); one renamed in T3 shows here"),
    closeInTmux: na("its threads are in T3 Code, not a terminal"),
    closeOutside: yes("archived (`thread.archive`), its run stopped first; T3 can bring it back"),
    start: partial(
      "a new thread on T3's server (`orchestration.launchThread`, `launches`) by voice, the phone, or the window's picker (offered while T3 is connected and the folder is a T3 project's), on the agent named (\"on Codex\"). Only in a T3 project: a folder that isn't one is said (\"Add it in T3 Code first\": T3's `project.create` isn't used), and never the scratch folder. T3 not open: started in a terminal agent instead, said",
    ),
    startPrompt: yes("its `initialMessage`, which starts its run"),
    startName: yes("its title; with none, T3 titles it from the first message"),
    startHeldWords: na("nothing to wait for: the thread is made with its first message, and listed before the launch returns"),
    trustCard: na("T3 Code asks nothing of a folder"),
    loginFailed: notBuilt("only completed runs are heard: one that failed is silent; how T3 shows a run that couldn't sign in is unchecked", true),
    knownFolders: partial(
      "its projects, by title and folder name, for a new T3 thread (`launches.projects`); not for other agents' new sessions, where core asks only the main agent's (agents/index.ts `together`)",
    ),
    startMode: notBuilt(
      "`orchestration.launchThread` takes a runtime mode (approval-required, auto-accept-edits, auto, full-access) near the setting's; the project's or T3's own default is sent instead (launch.ts `runtimeModeFor`)",
    ),
    modeShown: notBuilt("its threads carry a runtime mode (approval-required, auto-accept-edits, auto, full-access) and an interaction mode (plan), unread here"),
    autoBlocks: toolLimit(
      "its default runtime mode is full access (nothing blocked); its `auto` mode runs Claude in auto mode and Codex with auto_review, but its server tells a client of neither's blocks (v0.1.5: no PermissionDenied nor auto-review event in its contracts)",
    ),
    blockOverride: toolLimit("no block of T3's reaches a client (above), so there's none to allow"),
    history: yes("its messages, from its server; mirrored as a transcript for the window"),
    phone: yes(),
    mark: yes("⊤ in its indigo"),
    setup: yes("nothing to set up: found while it runs; a protocol it doesn't know is said once"),
    hooksCurrent: na(`no hooks file: ${NAME} talks to its server`),
  },
};
