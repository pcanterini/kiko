# What each agent supports

<!-- Written by `pnpm support` from src/agents/*/support.ts: change those, then run it. A test fails while this is out of date. -->

Every feature Kiko has for a session, with Claude Code as the reference, and how each agent's sessions stand on it. Each adapter declares every feature (`src/agents/<agent>/support.ts`; the list is `src/agents/support.ts`), and a new feature doesn't typecheck until each has. Where it can, a test checks a declaration against the adapter itself (one with `rename` can't say renaming isn't built).

**Not verified yet:** every ⬜ / ◐ / ⛔ and every "?" row is our current belief, read from the agents' source, docs and our fakes, until each is checked against the real tool (start with "To check" below).

✅ yes · ◐ partly · ⛔ the agent itself can't (a tool limit) · ⬜ not built yet · — doesn't apply · ? not checked for sure (see "To check"). A number is a note under its table.

| | ✅ | ◐ | ⛔ | ⬜ | — |
|---|:-:|:-:|:-:|:-:|:-:|
| Claude Code | 32 | 5 | 0 | 0 | 0 |
| Codex | 25 | 5 | 2 | 5 | 0 |
| OpenCode | 26 | 1 | 3 | 5 | 2 |
| T3 Code | 18 | 2 | 2 | 7 | 8 |

## Listed

| Feature | Claude Code | Codex | OpenCode | T3 Code |
|---|:-:|:-:|:-:|:-:|
| Listed with your sessions | ✅ 1 | ✅ 2 | ✅ 3 | ✅ 4 |
| Listed as soon as it opens | ✅ 5 | ✅ 6 | ⛔ 7 | ✅ 8 |
| Busy / needs you / idle | ✅ 9 | ✅ 10 | ✅ 11 | ✅ 12 |

1. **Claude Code · Listed with your sessions:** `claude agents` and its pid records, in any terminal and the desktop app; a background job a session was moved into is listed as that session.
2. **Codex · Listed with your sessions:** from its shared daemon (0.166+) while a Codex TUI runs in its folder, and from the records its hook keeps; one in Kiko's tmux from its pane too.
3. **OpenCode · Listed with your sessions:** while a TUI that made, used or looked at it runs in its folder, in any terminal; of several tabs, each one used since its TUI opened.
4. **T3 Code · Listed with your sessions:** each thread that isn't archived, settled or a subagent's, while T3 runs.
5. **Claude Code · Listed as soon as it opens:** as it registers (its SessionStart hook, else the next look): after its trust question, which a session Kiko opened shows as starting.
6. **Codex · Listed as soon as it opens:** 0.166+, from its daemon; before 0.166, from its first message (Codex runs no hook before it).
7. **OpenCode · Listed as soon as it opens:** OpenCode makes a session at its first message, so a TUI with nothing typed has none; in Kiko's tmux its pane is listed all the same (`runsAs`).
8. **T3 Code · Listed as soon as it opens:** as T3's shell tells of it.
9. **Claude Code · Busy / needs you / idle:** busy only while in a turn (its hooks, then `claude agents` and its transcript), with what a background job still runs in the background shown apart ("idle · 2 in background"); and yellow "waits for you" for a background job stopped on a question of its own.
10. **Codex · Busy / needs you / idle:** from its hooks and its daemon's `thread/status/changed`.
11. **OpenCode · Busy / needs you / idle:** from its service's `session.status`; blocked while Kiko holds a permission or questions of it.
12. **T3 Code · Busy / needs you / idle:** busy while its run goes, needs you while a request waits.

## Heard

| Feature | Claude Code | Codex | OpenCode | T3 Code |
|---|:-:|:-:|:-:|:-:|
| A finished turn heard | ✅ 13 | ✅ 14 | ✅ 15 | ✅ 16 |
| The summary names who spoke | ✅ 17 | ✅ 18 | ✅ 19 | ⬜? 20 |
| Reply window | ✅ 21 | ✅ 22 | ✅ 23 | ⬜ 24 |
| Typing in its own window noticed | ✅ 25 | ⛔ 26 | ✅ 27 | — 28 |
| Your words seen to start | ✅ 29 | ✅ 30 | ✅ 31 | ✅ 32 |

13. **Claude Code · A finished turn heard:** its Stop hook, with `last_assistant_message`.
14. **Codex · A finished turn heard:** its Stop hook, with `last_assistant_message`.
15. **OpenCode · A finished turn heard:** `session.execution.succeeded`, for a session a TUI shows (`opencode run` and its web app aren't read out).
16. **T3 Code · A finished turn heard:** a completed run's last reply, read from its thread.
17. **Claude Code · The summary names who spoke:** "Claude".
18. **Codex · The summary names who spoke:** "Codex".
19. **OpenCode · The summary names who spoke:** "OpenCode".
20. **T3 Code · The summary names who spoke:** a thread runs on Claude, Codex or OpenCode, which isn't read from T3 yet, so its summary says "it"; its model selection's provider could say (whether the shell's thread carries it is unchecked).
21. **Claude Code · Reply window:** its Stop hook held and answered `block`; 7 in a row (Claude Code takes 8 continuations), then your words are typed in.
22. **Codex · Reply window:** its Stop hook held and answered `block`, which carries the same turn on; no limit in Codex (20 in a row, then typed in).
23. **OpenCode · Reply window:** the reply goes to it as a new message through its service: OpenCode waits on no one after a turn.
24. **T3 Code · Reply window:** a completed run is over, so its turn is read out with no reply window; one could be opened as OpenCode's is, the reply sent as a new message (`message.dispatch`).
25. **Claude Code · Typing in its own window noticed:** a queued prompt in its transcript (typed-in.ts).
26. **Codex · Typing in its own window noticed:** what's typed into Codex while its Stop hook runs steers that turn: it isn't in a queue Kiko can read (Claude Code's queued prompt).
27. **OpenCode · Typing in its own window noticed:** typing in its TUI starts a turn (`session.status` busy), which closes the reply window.
28. **T3 Code · Typing in its own window noticed:** nothing of its turn is held (no reply window).
29. **Claude Code · Your words seen to start:** its UserPromptSubmit hook (optional: "Add the rest" in settings).
30. **Codex · Your words seen to start:** its UserPromptSubmit hook.
31. **OpenCode · Your words seen to start:** its service's `session.inbox.enqueued`.
32. **T3 Code · Your words seen to start:** as a thread's run starts, with the message it took in.

## Your words

| Feature | Claude Code | Codex | OpenCode | T3 Code |
|---|:-:|:-:|:-:|:-:|
| Words at any moment, in Kiko's tmux | ✅ | ✅ 33 | ✅ 34 | — 35 |
| Words at any moment, outside it | ◐ 36 | ◐ 37 | ✅ 38 | ✅ 39 |
| Told that typed-in words were dictated | ◐ 40 | ◐? 41 | ⬜ 42 | ⬜ 43 |

33. **Codex · Words at any moment, in Kiko's tmux:** always as one bracketed paste (its TUI takes fast keys as a paste).
34. **OpenCode · Words at any moment, in Kiko's tmux:** typed into its pane.
35. **T3 Code · Words at any moment, in Kiko's tmux:** its threads are in T3 Code, not a terminal.
36. **Claude Code · Words at any moment, outside it:** only into a Ghostty window found for sure (by its title, or the only one in its folder): Warp, iTerm and your own tmux aren't typed into, and the desktop app isn't by choice (no clipboard). Claude Code has no way in from outside.
37. **Codex · Words at any moment, outside it:** only into a Ghostty window found for sure, and Codex titles its window with its folder's name unless `[tui] terminal_title` has `thread-id`. Not built: its daemon's `turn/start` / `turn/steer` would reach it anywhere (whether without subscribing to the thread is unconfirmed).
38. **OpenCode · Words at any moment, outside it:** a new message through its service (`message`), anywhere, no keys, a draft left alone; only while a TUI shows it.
39. **T3 Code · Words at any moment, outside it:** a new message to the thread (`message.dispatch`), at any moment.
40. **Claude Code · Told that typed-in words were dictated:** its UserPromptSubmit hook adds it beside the prompt (optional: "Add the rest" in settings), a first message on its command line too. Not for words typed while it's busy that it takes in as the turn goes, between two steps: no hook comes for those (ones still queued at the turn's end are a prompt of their own, and get it).
41. **Codex · Told that typed-in words were dictated:** its UserPromptSubmit hook adds it beside the prompt (a developer message), the first words of one still starting too (asked under the ID it had while it started). Unchecked: whether its hook runs for a first message on its command line, and for words typed while it's busy that it takes into the running turn.
42. **OpenCode · Told that typed-in words were dictated:** its words go in as they are: no hook of its adds a line beside a message, and one in the message itself would show in the conversation.
43. **T3 Code · Told that typed-in words were dictated:** its words go in as they are: `message.dispatch` takes the message only, and a line in it would show in the thread.

## Permissions and questions

| Feature | Claude Code | Codex | OpenCode | T3 Code |
|---|:-:|:-:|:-:|:-:|
| Permission prompts: allow / deny | ✅ 44 | ✅ 45 | ✅ 46 | ✅ 47 |
| Allow always | ✅ 48 | ⛔? 49 | ✅ 50 | ✅ 51 |
| Asks before it sends, deletes, pays or posts | ✅ 52 | ✅ 53 | ⬜? 54 | ⬜? 55 |
| Its questions, with options | ✅ 56 | ⬜ 57 | ✅ 58 | ✅ 59 |

44. **Claude Code · Permission prompts: allow / deny:** its PermissionRequest hook.
45. **Codex · Permission prompts: allow / deny:** its PermissionRequest hook; a patch read as an edit of its first file.
46. **OpenCode · Permission prompts: allow / deny:** `permission.asked`, answered through its service.
47. **T3 Code · Permission prompts: allow / deny:** `runtime-request.respond`; a request that can't be read here is said, to answer in T3 Code.
48. **Claude Code · Allow always:** when Claude Code offers one (`permission_suggestions`, given back as `updatedPermissions`).
49. **Codex · Allow always:** a hook's allow is for one request: Codex rejects `updatedPermissions`. Its daemon's approvals (not used yet) may have an allow for the session: unchecked.
50. **OpenCode · Allow always:** when OpenCode says what it would keep (`save`), as its own "Always allow".
51. **T3 Code · Allow always:** for the session (`acceptForSession`), or always where the request offers it.
52. **Claude Code · Asks before it sends, deletes, pays or posts:** its PreToolUse hook (Bash, Monitor and MCP tools only) answers "ask" for a call the rules or the classifier flag, which makes Claude Code ask even in bypass permissions or past an allow rule (checked on 2.1.316); the prompt comes as an ordinary PermissionRequest card. Headless runs (`claude -p`, the Agent SDK) aren't gated: nobody is there to ask. With the gate off (the default) the hook reads that from the settings file and passes at once.
53. **Codex · Asks before it sends, deletes, pays or posts:** its PreToolUse hook can't make Codex ask ("ask" is unsupported, and lets the call run), so the hook holds a flagged call as Kiko's own card: yes lets it run, no or no answer denies it (`permissionDecision: "deny"`, which Codex honours whatever its sandbox or approval mode). Needs Codex to trust the updated hook once. With the gate off (the default) the hook reads that from the settings file and lets the call run at once.
54. **OpenCode · Asks before it sends, deletes, pays or posts:** Kiko reaches OpenCode through its service, which has no hook before a tool runs; a plugin's `tool.execute.before` could check each call (it can block, not ask), and `ask` rules in its config would make it ask (a card here), but Kiko changes nothing of OpenCode's own.
55. **T3 Code · Asks before it sends, deletes, pays or posts:** T3 Code runs its agents itself (Claude through its SDK, Codex through its app server), and Kiko's hooks leave its threads alone (no double asks: T3 answers its own prompts), so only what T3's own mode asks reaches Kiko; gating them would need T3 to ask, e.g. a hook answering "ask" in its Claude threads, which T3 would then show as a request (unchecked).
56. **Claude Code · Its questions, with options:** AskUserQuestion, through its PermissionRequest hook (allowed with `answers`).
57. **Codex · Its questions, with options:** no hook can answer `request_user_input` (said, to answer in its window); its daemon's `item/tool/requestUserInput` can, for a client subscribed to the thread (`thread/resume`), alongside its TUI.
58. **OpenCode · Its questions, with options:** its question tool's forms; another form (an MCP server's) is said, to answer in its window.
59. **T3 Code · Its questions, with options:** Claude's questions in a T3 thread, answered by question ID.

## Interrupt, rename, close

| Feature | Claude Code | Codex | OpenCode | T3 Code |
|---|:-:|:-:|:-:|:-:|
| Interrupt, in Kiko's tmux | ✅ 60 | ✅ 61 | ✅ 62 | — 63 |
| Interrupt, outside it | ◐ 64 | ✅ 65 | ✅ 66 | ✅ 67 |
| Rename, in Kiko's tmux | ✅ 68 | ✅ 69 | ✅ 70 | — 71 |
| Rename, outside it | ◐ 72 | ✅ 73 | ✅ 74 | ✅ 75 |
| Close, in Kiko's tmux | ✅ 76 | ✅ 77 | ✅? 78 | — 79 |
| Close, outside it | ✅ 80 | ◐ 81 | ◐? 82 | ✅ 83 |

60. **Claude Code · Interrupt, in Kiko's tmux:** Escape.
61. **Codex · Interrupt, in Kiko's tmux:** through its daemon (`turn/interrupt`) when it has the thread, else Escape.
62. **OpenCode · Interrupt, in Kiko's tmux:** through its service (`POST …/interrupt`), no Escape.
63. **T3 Code · Interrupt, in Kiko's tmux:** its threads are in T3 Code, not a terminal.
64. **Claude Code · Interrupt, outside it:** Escape only where keys reach it for sure (a Ghostty window found by title): Claude Code has no way to interrupt a session from outside its terminal.
65. **Codex · Interrupt, outside it:** through its daemon (`turn/interrupt`, 0.166+), wherever it runs; without one, Escape only where keys reach it for sure.
66. **OpenCode · Interrupt, outside it:** through its service, wherever it runs.
67. **T3 Code · Interrupt, outside it:** `thread.stop`, or `run.interrupt` of its live run.
68. **Claude Code · Rename, in Kiko's tmux:** `/rename <name>` typed in; a /rename in it shows from its transcript.
69. **Codex · Rename, in Kiko's tmux:** through its daemon (`thread/name/set`) when it has the thread, else `/rename`; a /rename in it shows here.
70. **OpenCode · Rename, in Kiko's tmux:** its title, through its service (no slash command renames); Ctrl+R in it shows here.
71. **T3 Code · Rename, in Kiko's tmux:** its threads are in T3 Code, not a terminal.
72. **Claude Code · Rename, outside it:** `/rename` only where keys reach it for sure (a Ghostty window found by title): Claude Code has no way to rename a session from outside its terminal.
73. **Codex · Rename, outside it:** through its daemon (`thread/name/set`, 0.166+), wherever it runs; without one, `/rename` only where keys reach it for sure.
74. **OpenCode · Rename, outside it:** through its service, wherever it runs.
75. **T3 Code · Rename, outside it:** its title (`thread.metadata.update`); one renamed in T3 shows here.
76. **Claude Code · Close, in Kiko's tmux:** `/exit`.
77. **Codex · Close, in Kiko's tmux:** `/exit`.
78. **OpenCode · Close, in Kiko's tmux:** `/exit` (from its source; not tried with the real OpenCode).
79. **T3 Code · Close, in Kiko's tmux:** its threads are in T3 Code, not a terminal.
80. **Claude Code · Close, outside it:** SIGTERM after checking its process (`claude stop` for a background job): it saves and runs its end hooks as for /exit; never the desktop app's.
81. **Codex · Close, outside it:** SIGTERM after the checks, only for a session whose TUI process its hook found: on 0.166 its hooks run in the shared daemon with no TUI above them, so none can be closed (its folder's one Codex TUI could be taken, as OpenCode's is). And Codex's TUI has no SIGTERM handler: no SessionEnd, its terminal left for `reset`.
82. **OpenCode · Close, outside it:** SIGHUP to its TUI, only for the session in front (used last) of a folder's one TUI: its other tabs, or two TUIs in one folder, aren't closed (it would close the whole TUI). Its SIGHUP quit is from its source, not tried with the real one.
83. **T3 Code · Close, outside it:** archived (`thread.archive`), its run stopped first; T3 can bring it back.

## Starting a session

| Feature | Claude Code | Codex | OpenCode | T3 Code |
|---|:-:|:-:|:-:|:-:|
| Start one | ✅ | ✅ 84 | ✅ 85 | ◐ 86 |
| Start with a first message | ✅ 87 | ✅ 88 | ✅ 89 | ✅ 90 |
| Start with a name | ✅ 91 | ✅ 92 | ✅ 93 | ✅ 94 |
| Words for one still starting | ✅ 95 | ✅ 96 | ✅? 97 | — 98 |
| Folder-trust card at start | ✅ 99 | ✅ 100 | — 101 | — 102 |
| A turn that couldn't log in said | ✅ 103 | ⬜? 104 | ⬜? 105 | ⬜? 106 |
| Its projects known by name | ✅ 107 | ⬜ 108 | ⬜? 109 | ◐ 110 |

84. **Codex · Start one:** `codex`, when you name it or it's picked; with `-c check_for_update_on_startup=false` (its own update screen can't be answered by voice; `kiko codex` too, unless you set it), and a fresh scratch folder Kiko made trusted for that launch (`-c projects=…`).
85. **OpenCode · Start one:** `opencode`, when you name it or it's picked.
86. **T3 Code · Start one:** a new thread on T3's server (`orchestration.launchThread`, `launches`) by voice, the phone, or the window's picker (offered while T3 is connected and the folder is a T3 project's), on the agent named ("on Codex"). Only in a T3 project: a folder that isn't one is said ("Add it in T3 Code first": T3's `project.create` isn't used), and never the scratch folder. T3 not open: started in a terminal agent instead, said.
87. **Claude Code · Start with a first message:** `claude <prompt>`.
88. **Codex · Start with a first message:** `codex <prompt>`.
89. **OpenCode · Start with a first message:** `opencode --prompt <words>`.
90. **T3 Code · Start with a first message:** its `initialMessage`, which starts its run.
91. **Claude Code · Start with a name:** `claude --name <name>`.
92. **Codex · Start with a name:** renamed once it's listed and idle (`namesLater`): Codex has no flag for a name.
93. **OpenCode · Start with a name:** renamed through its service once it's listed (`namesLater`).
94. **T3 Code · Start with a name:** its title; with none, T3 titles it from the first message.
95. **Claude Code · Words for one still starting:** held until it's listed (past its trust question), then typed in.
96. **Codex · Words for one still starting:** typed in once its composer shows (`readyOnScreen`).
97. **OpenCode · Words for one still starting:** typed in once its prompt shows (`readyOnScreen`: `Ask anything…`, from its source).
98. **T3 Code · Words for one still starting:** nothing to wait for: the thread is made with its first message, and listed before the launch returns.
99. **Claude Code · Folder-trust card at start:** in Kiko's tmux (its pane read and its keys pressed: core/trust-prompt.ts); Ghostty has no screen to read, so there it's said to wait in its window.
100. **Codex · Folder-trust card at start:** its "Trust this folder?" (trust: "Trust and continue", so Codex saves it; no: "Quit") and "Hooks need review" (trust: "Trust all and continue"; no: "Continue without trusting", unheard) as cards, never answered for you, in Kiko's tmux (its pane read, its › moved and seen before Enter: core/trust-prompt.ts); Ghostty has no screen to read.
101. **OpenCode · Folder-trust card at start:** OpenCode asks nothing of a folder at start.
102. **T3 Code · Folder-trust card at start:** T3 Code asks nothing of a folder.
103. **Claude Code · A turn that couldn't log in said:** "Not logged in" read from its transcript (it runs no Stop hook for it): core/login-check.ts.
104. **Codex · A turn that couldn't log in said:** watched for the main agent's sessions only (app/starting.ts `loginWatched`, from Claude Code's transcript); how a Codex turn that couldn't sign in shows in its rollout or daemon is unchecked.
105. **OpenCode · A turn that couldn't log in said:** watched for the main agent's sessions only (app/starting.ts `loginWatched`); how its service tells a turn that failed to sign in is unchecked.
106. **T3 Code · A turn that couldn't log in said:** only completed runs are heard: one that failed is silent; how T3 shows a run that couldn't sign in is unchecked.
107. **Claude Code · Its projects known by name:** ~/.claude/projects read back to paths, with the names given there.
108. **Codex · Its projects known by name:** its rollouts ($CODEX_HOME/sessions) record each session's folder; core asks only the main agent's (agents/index.ts `together`), so that's needed too.
109. **OpenCode · Its projects known by name:** its service keeps every session with its folder; core asks only the main agent's (agents/index.ts `together`). Which endpoint lists them all, folders unknown, is unchecked.
110. **T3 Code · Its projects known by name:** its projects, by title and folder name, for a new T3 thread (`launches.projects`); not for other agents' new sessions, where core asks only the main agent's (agents/index.ts `together`).

## Permission modes

| Feature | Claude Code | Codex | OpenCode | T3 Code |
|---|:-:|:-:|:-:|:-:|
| Starts in the chosen permission mode | ✅ 111 | ◐ 112 | ⛔ 113 | ⬜ 114 |
| Its mode now, shown | ✅ 115 | ◐ 116 | ⬜? 117 | ⬜ 118 |
| Auto mode's blocks said | ✅ 119 | ⬜ 120 | ✅ 121 | ⛔ 122 |
| A block allowed anyway | ◐ 123 | ⬜ 124 | ⛔ 125 | ⛔ 126 |

111. **Claude Code · Starts in the chosen permission mode:** `--permission-mode <mode>` (Ask me as `default`); a scratch session, while the setting is left at its default, in `auto` where `claude --help` lists it.
112. **Codex · Starts in the chosen permission mode:** its nearest flags (`codexModeArgs`): Plan has none (its plan mode is switched in its TUI), Auto is its own reviewer (`--approve-for-me`), and Ask me reads freely.
113. **OpenCode · Starts in the chosen permission mode:** `opencode` 2.0.32 has no flag for any mode (its `--auto` approves everything not denied, nearer bypass): it starts in your config's permissions.
114. **T3 Code · Starts in the chosen permission mode:** `orchestration.launchThread` takes a runtime mode (approval-required, auto-accept-edits, auto, full-access) near the setting's; the project's or T3's own default is sent instead (launch.ts `runtimeModeFor`).
115. **Claude Code · Its mode now, shown:** `permission_mode` on each hook event; a Shift+Tab shows at its next event.
116. **Codex · Its mode now, shown:** from its daemon's `thread/settings/updated` only: unknown until a thread's settings change (its hooks don't carry it).
117. **OpenCode · Its mode now, shown:** its nearest is the agent a session runs (build or plan); whether its service says which, as it changes, is unchecked.
118. **T3 Code · Its mode now, shown:** its threads carry a runtime mode (approval-required, auto-accept-edits, auto, full-access) and an interaction mode (plan), unread here.
119. **Claude Code · Auto mode's blocks said:** its PermissionDenied hook (optional).
120. **Codex · Auto mode's blocks said:** no PermissionDenied hook; its daemon tells a reviewer's denial (`item/autoApprovalReview/completed`, status denied) only to clients subscribed to that thread (thread/resume), and it isn't in the rollout; Kiko only reads threads. With Kiko's PermissionRequest hook in, Codex's approvals are Kiko's cards first (hooks run before its reviewer), so the reviewer sees only what a card let go of.
121. **OpenCode · Auto mode's blocks said:** no auto mode, but a call your deny rules stop without asking is said: its service's `session.tool.failed` with `permission.rejected`, for a call no `permission.asked` was made for.
122. **T3 Code · Auto mode's blocks said:** its default runtime mode is full access (nothing blocked); its `auto` mode runs Claude in auto mode and Codex with auto_review, but its server tells a client of neither's blocks (v0.1.5: no PermissionDenied nor auto-review event in its contracts).
123. **Claude Code · A block allowed anyway:** in Kiko's tmux only: yes takes it out of auto mode (Shift+Tab, its screen read back after each press) and asks it to try again, so the call comes back as an ordinary prompt; its hook can't allow (only `retry`, which auto mode checks again), so outside tmux, in plan mode or the Claude app, the block is said with why.
124. **Codex · A block allowed anyway:** Codex has one, `thread/approveGuardianDeniedAction {threadId, event}` (its TUI's /approve: one retry, still reviewed), but it needs the denial's event, which needs that thread subscription; meanwhile /approve in its window.
125. **OpenCode · A block allowed anyway:** a deny rule is your own setting, and OpenCode has no API to allow past it: said, never offered.
126. **T3 Code · A block allowed anyway:** no block of T3's reaches a client (above), so there's none to allow.

## History, phone, setup

| Feature | Claude Code | Codex | OpenCode | T3 Code |
|---|:-:|:-:|:-:|:-:|
| What it said; its conversation | ✅ 127 | ✅ 128 | ✅ 129 | ✅ 130 |
| On the phone | ✅ | ✅ | ✅ | ✅ |
| Its mark in the lists | ✅ 131 | ✅ 132 | ✅ 133 | ✅ 134 |
| Connected from Kiko | ✅ 135 | ✅ 136 | ✅ 137 | ✅ 138 |
| Its hooks kept current | ✅ 139 | ✅ 140 | — 141 | — 142 |

127. **Claude Code · What it said; its conversation:** its transcript.
128. **Codex · What it said; its conversation:** its rollout, mirrored as a transcript.
129. **OpenCode · What it said; its conversation:** its messages, mirrored as a transcript.
130. **T3 Code · What it said; its conversation:** its messages, from its server; mirrored as a transcript for the window.
131. **Claude Code · Its mark in the lists:** ✻ in its orange.
132. **Codex · Its mark in the lists:** ⌬ in its blue.
133. **OpenCode · Its mark in the lists:** ▣ in its amber.
134. **T3 Code · Its mark in the lists:** ⊤ in its indigo.
135. **Claude Code · Connected from Kiko:** hooks in ~/.claude/settings.json; a hook's script gone, or Stop or PermissionRequest missing, is "needs repair".
136. **Codex · Connected from Kiko:** hooks in $CODEX_HOME/hooks.json (Codex asks to trust them once); hooks that never fire are "needs repair" (`health`).
137. **OpenCode · Connected from Kiko:** Kiko's own yes to listening to its service (`linkedAgents`), nothing of OpenCode's written; a service before 2.0, or one refusing its own password, is "needs repair".
138. **T3 Code · Connected from Kiko:** nothing to set up: found while it runs; a protocol it doesn't know is said once.
139. **Claude Code · Its hooks kept current:** ~/.claude/settings.json given the events it lacks (PermissionDenied, for installs from before it) at start.
140. **Codex · Its hooks kept current:** $CODEX_HOME/hooks.json given the events it lacks at start (Codex asks to trust a new one once).
141. **OpenCode · Its hooks kept current:** no hooks file: Kiko listens to its service.
142. **T3 Code · Its hooks kept current:** no hooks file: Kiko talks to its server.

## Not built yet

What each agent could do and Kiko doesn't yet: the gaps to work on, with how.

**Claude Code**: none.

**Codex**

- Its questions, with options: no hook can answer `request_user_input` (said, to answer in its window); its daemon's `item/tool/requestUserInput` can, for a client subscribed to the thread (`thread/resume`), alongside its TUI.
- A turn that couldn't log in said: watched for the main agent's sessions only (app/starting.ts `loginWatched`, from Claude Code's transcript); how a Codex turn that couldn't sign in shows in its rollout or daemon is unchecked.
- Its projects known by name: its rollouts ($CODEX_HOME/sessions) record each session's folder; core asks only the main agent's (agents/index.ts `together`), so that's needed too.
- Auto mode's blocks said: no PermissionDenied hook; its daemon tells a reviewer's denial (`item/autoApprovalReview/completed`, status denied) only to clients subscribed to that thread (thread/resume), and it isn't in the rollout; Kiko only reads threads. With Kiko's PermissionRequest hook in, Codex's approvals are Kiko's cards first (hooks run before its reviewer), so the reviewer sees only what a card let go of.
- A block allowed anyway: Codex has one, `thread/approveGuardianDeniedAction {threadId, event}` (its TUI's /approve: one retry, still reviewed), but it needs the denial's event, which needs that thread subscription; meanwhile /approve in its window.

**OpenCode**

- Told that typed-in words were dictated: its words go in as they are: no hook of its adds a line beside a message, and one in the message itself would show in the conversation.
- Asks before it sends, deletes, pays or posts: Kiko reaches OpenCode through its service, which has no hook before a tool runs; a plugin's `tool.execute.before` could check each call (it can block, not ask), and `ask` rules in its config would make it ask (a card here), but Kiko changes nothing of OpenCode's own.
- A turn that couldn't log in said: watched for the main agent's sessions only (app/starting.ts `loginWatched`); how its service tells a turn that failed to sign in is unchecked.
- Its projects known by name: its service keeps every session with its folder; core asks only the main agent's (agents/index.ts `together`). Which endpoint lists them all, folders unknown, is unchecked.
- Its mode now, shown: its nearest is the agent a session runs (build or plan); whether its service says which, as it changes, is unchecked.

**T3 Code**

- The summary names who spoke: a thread runs on Claude, Codex or OpenCode, which isn't read from T3 yet, so its summary says "it"; its model selection's provider could say (whether the shell's thread carries it is unchecked).
- Reply window: a completed run is over, so its turn is read out with no reply window; one could be opened as OpenCode's is, the reply sent as a new message (`message.dispatch`).
- Told that typed-in words were dictated: its words go in as they are: `message.dispatch` takes the message only, and a line in it would show in the thread.
- Asks before it sends, deletes, pays or posts: T3 Code runs its agents itself (Claude through its SDK, Codex through its app server), and Kiko's hooks leave its threads alone (no double asks: T3 answers its own prompts), so only what T3's own mode asks reaches Kiko; gating them would need T3 to ask, e.g. a hook answering "ask" in its Claude threads, which T3 would then show as a request (unchecked).
- A turn that couldn't log in said: only completed runs are heard: one that failed is silent; how T3 shows a run that couldn't sign in is unchecked.
- Starts in the chosen permission mode: `orchestration.launchThread` takes a runtime mode (approval-required, auto-accept-edits, auto, full-access) near the setting's; the project's or T3's own default is sent instead (launch.ts `runtimeModeFor`).
- Its mode now, shown: its threads carry a runtime mode (approval-required, auto-accept-edits, auto, full-access) and an interaction mode (plan), unread here.

## Tool limits

What the agent itself can't do, so Kiko can't either (said, or marked in what a session can do, never worked around).

**Claude Code**: none.

**Codex**

- Typing in its own window noticed: what's typed into Codex while its Stop hook runs steers that turn: it isn't in a queue Kiko can read (Claude Code's queued prompt).
- Allow always: a hook's allow is for one request: Codex rejects `updatedPermissions`. Its daemon's approvals (not used yet) may have an allow for the session: unchecked.

**OpenCode**

- Listed as soon as it opens: OpenCode makes a session at its first message, so a TUI with nothing typed has none; in Kiko's tmux its pane is listed all the same (`runsAs`).
- Starts in the chosen permission mode: `opencode` 2.0.32 has no flag for any mode (its `--auto` approves everything not denied, nearer bypass): it starts in your config's permissions.
- A block allowed anyway: a deny rule is your own setting, and OpenCode has no API to allow past it: said, never offered.

**T3 Code**

- Auto mode's blocks said: its default runtime mode is full access (nothing blocked); its `auto` mode runs Claude in auto mode and Codex with auto_review, but its server tells a client of neither's blocks (v0.1.5: no PermissionDenied nor auto-review event in its contracts).
- A block allowed anyway: no block of T3's reaches a client (above), so there's none to allow.

## To check

Declarations read from an agent's source or docs, or not known for sure: worth checking with the real agent.

**Claude Code**: none.

**Codex**

- Told that typed-in words were dictated: its UserPromptSubmit hook adds it beside the prompt (a developer message), the first words of one still starting too (asked under the ID it had while it started). Unchecked: whether its hook runs for a first message on its command line, and for words typed while it's busy that it takes into the running turn.
- Allow always: a hook's allow is for one request: Codex rejects `updatedPermissions`. Its daemon's approvals (not used yet) may have an allow for the session: unchecked.
- A turn that couldn't log in said: watched for the main agent's sessions only (app/starting.ts `loginWatched`, from Claude Code's transcript); how a Codex turn that couldn't sign in shows in its rollout or daemon is unchecked.

**OpenCode**

- Asks before it sends, deletes, pays or posts: Kiko reaches OpenCode through its service, which has no hook before a tool runs; a plugin's `tool.execute.before` could check each call (it can block, not ask), and `ask` rules in its config would make it ask (a card here), but Kiko changes nothing of OpenCode's own.
- Close, in Kiko's tmux: `/exit` (from its source; not tried with the real OpenCode).
- Close, outside it: SIGHUP to its TUI, only for the session in front (used last) of a folder's one TUI: its other tabs, or two TUIs in one folder, aren't closed (it would close the whole TUI). Its SIGHUP quit is from its source, not tried with the real one.
- Words for one still starting: typed in once its prompt shows (`readyOnScreen`: `Ask anything…`, from its source).
- A turn that couldn't log in said: watched for the main agent's sessions only (app/starting.ts `loginWatched`); how its service tells a turn that failed to sign in is unchecked.
- Its projects known by name: its service keeps every session with its folder; core asks only the main agent's (agents/index.ts `together`). Which endpoint lists them all, folders unknown, is unchecked.
- Its mode now, shown: its nearest is the agent a session runs (build or plan); whether its service says which, as it changes, is unchecked.

**T3 Code**

- The summary names who spoke: a thread runs on Claude, Codex or OpenCode, which isn't read from T3 yet, so its summary says "it"; its model selection's provider could say (whether the shell's thread carries it is unchecked).
- Asks before it sends, deletes, pays or posts: T3 Code runs its agents itself (Claude through its SDK, Codex through its app server), and Kiko's hooks leave its threads alone (no double asks: T3 answers its own prompts), so only what T3's own mode asks reaches Kiko; gating them would need T3 to ask, e.g. a hook answering "ask" in its Claude threads, which T3 would then show as a request (unchecked).
- A turn that couldn't log in said: only completed runs are heard: one that failed is silent; how T3 shows a run that couldn't sign in is unchecked.

## What each feature means

- **Listed with your sessions:** In the window's list and the phone, wherever it runs, by its name.
- **Listed as soon as it opens:** Before its first message: a session just opened is in the list and can be picked.
- **Busy / needs you / idle:** Its state in the list, the bottom line and the phone; red "needs you" while something waits on you.
- **A finished turn heard:** Its last reply summarised and said (or announced), as it ends.
- **The summary names who spoke:** "In pixie, Claude says…": the agent's own name, not "it" (Agent.speaker).
- **Reply window:** Words said right after it spoke go to it, unnamed, carrying its turn on (Held.answer).
- **Typing in its own window noticed:** Words you type into it by hand while Kiko holds its turn aren't sent twice (Held.watchTyped).
- **Your words seen to start:** It says when it took a prompt in: the phone's words show as started (Agent.onPromptSubmitted).
- **Words at any moment, in Kiko's tmux:** Named by voice, the phone or the window, typed into its pane.
- **Words at any moment, outside it:** The same for one in Ghostty, Warp, iTerm or its own app.
- **Told that typed-in words were dictated:** Words typed into it for you come with a line for the agent saying they were spoken, so a misheard word ("high term") is read as one; nothing more is typed or shown (Agent.dictated).
- **Permission prompts: allow / deny:** Asked by voice, on the Mac's card and on the phone; a no tells it why.
- **Allow always:** "Don't ask again" from Kiko (Held.canAllowAlways).
- **Asks before it sends, deletes, pays or posts:** Kiko's safety gate (core/guard.ts), off by default (Settings → Permissions turns it on): a shell command or tool call that sends, deletes, pays or posts is asked about first, whatever the session's own permission mode or allow rules.
- **Its questions, with options:** The agent asking you to pick (Claude Code's AskUserQuestion), by voice and on the phone (Held.questions).
- **Interrupt, in Kiko's tmux:** "Stop pixie", the menus' Interrupt.
- **Interrupt, outside it:** The same for one Kiko didn't open in its tmux.
- **Rename, in Kiko's tmux:** "Rename pixie to docs", the menus' Rename…; a rename in the agent shows here too.
- **Rename, outside it:** The same for one Kiko didn't open in its tmux.
- **Close, in Kiko's tmux:** The menus' Close…: it ends cleanly (saves, runs its end hooks).
- **Close, outside it:** The same for one Kiko didn't open in its tmux.
- **Start one:** By voice, the phone's words or the window's `c` (and the agent picker), in a project or the scratch folder.
- **Start with a first message:** "Start a session in pixie to fix the tests": the words are its first message.
- **Start with a name:** "… named docs": it goes by that name from the start.
- **Words for one still starting:** Held, and typed in once it's ready for them, never before.
- **Folder-trust card at start:** Its "trust this folder?" question asked as a card, by voice and on the phone.
- **A turn that couldn't log in said:** "Not logged in" said (and a first message tried again once), never left silent.
- **Its projects known by name:** Folders it ran sessions in, from its own history: what "start a session in pixie" finds (Agent.knownFolders).
- **Starts in the chosen permission mode:** The "Permission mode" setting (Accept edits by default) passed as it starts (NewSession.mode); Claude Code's scratch sessions in auto while it's left at its default.
- **Its mode now, shown:** Its permission mode in the list and on the phone (AgentSession.mode).
- **Auto mode's blocks said:** A tool call its auto mode blocked, which no prompt asks you about, said (Agent.onBlocked).
- **A block allowed anyway:** "Auto mode blocked Lacy from running wrangler deploy. Allow it?" as a card; yes lets the call through the agent's own way (core/block-override.ts).
- **What it said; its conversation:** "What did it say?", and its conversation on the phone and in the Kiko window (watchHistory, historyFile).
- **On the phone:** Listed with its agent's name, talked to, its cards answered there.
- **Its mark in the lists:** Its agent glyph and colour before each name (Agent.mark).
- **Connected from Kiko:** The first-run card, settings → Agents, `kiko setup`; a broken setup said (Agent.setup).
- **Its hooks kept current:** At start, a connected agent's hooks file is given each event this Kiko hooks that it never had, backed up first; one you took out stays out (agents/setup.ts upgradeHooks).
