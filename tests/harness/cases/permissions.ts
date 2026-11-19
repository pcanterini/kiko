// Asked at the Mac: the safety gate's cards, a block allowed anyway, and Claude's multiple-choice questions.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { begin, caseLines, caseLog, caseSaid, DESK, forgetPending, HookRequest, PROJECTS_ROOT, spoke, T, talk, TERM, ui, until, wait } from "../driver.ts";

// Kiko's safety gate (core/guard.ts, app/guard.ts): a call the hooks' rules flagged comes to the app
// (T.hooks.onGuard, as the hook server hands it over), which asks or passes by its settings and the
// classifier, and logs it; the PermissionRequest that follows is the gate's card: said plainly,
// risky from the start (a plain "yes" isn't enough), allowed once only.
export async function guardCases() {
  await wait(2100); // windows and the session list cache run out
  const gate = (command: string, found: { hits?: any[]; unclear?: any[] }) =>
    T.hooks.onGuard({
      agent: "claude-code",
      sessionId: TERM.sessionId,
      cwd: TERM.cwd,
      tool: { name: "Bash", input: { command } },
      hits: found.hits ?? [],
      unclear: found.unclear ?? [],
      mode: "bypassPermissions",
    });
  const ask = (command: string, extra: any = {}) =>
    new HookRequest({ hook_event_name: "PermissionRequest", session_id: TERM.sessionId, cwd: TERM.cwd, permission_mode: "bypassPermissions", tool_name: "Bash", tool_input: { command }, ...extra });
  const logged = (name: string) => caseLog().filter((l) => l.event === name);
  const PUSH = { kind: "posts", rule: "git push", what: "push to GitHub" };
  const windowOpen = () => until(() => ui.state.waiting?.sessionId === TERM.sessionId && ui.state.waiting?.until != null, 5000, "its window open");

  begin("the safety gate: off with fresh settings, nothing asked; turned on in Settings, saved as on");
  const row = (): any => ui.state.settings?.find((r: any) => r.key === "guard");
  assert.ok(!existsSync("settings-test.json") || JSON.parse(readFileSync("settings-test.json", "utf8")).guard === undefined, "nothing saved for it yet");
  assert.deepEqual(await gate("git push", { hits: [PUSH] }), { ask: false, why: "off" });
  assert.deepEqual(
    logged("guard_pass").map((l) => [l.why, l.what]),
    [["off", "use Bash"]],
  );
  assert.equal(logged("guard_ask").length, 0);
  ui.act({ type: "settings" });
  await until(() => Boolean(row()), 3000, "its row");
  assert.deepEqual([row().label, row().value], ["Safety gate", "Off"]);
  ui.act({ type: "set", key: "guard", value: "on" });
  await until(() => row()?.value === "On", 3000, "on");
  assert.equal(JSON.parse(readFileSync("settings-test.json", "utf8")).guard, true, "saved as on");
  ui.act({ type: "closeSettings" });
  console.log("ok");

  begin("the safety gate: a push in bypass mode is asked about plainly, on the gate's card; a plain yes isn't enough, allow it is");
  await wait(1700);
  const verdict = await gate("git push", { hits: [PUSH] });
  assert.deepEqual([verdict.ask, verdict.reason], [true, "Kiko asks first: this posts (push to GitHub)."]);
  assert.deepEqual(
    logged("guard_ask").map((l) => [l.agent, l.sessionId, l.kind, l.rule, l.by, l.mode, l.what]),
    [["claude-code", TERM.sessionId, "posts", "git push", "rule", "bypassPermissions", "use Bash"]],
  );
  // Claude Code asks: its PermissionRequest, with "always" offered (which the gate's card never takes).
  const push = ask("git push", { permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "git push:*" }], behavior: "allow", destination: "localSettings" }] });
  T.hooks.onRequest(push);
  await until(() => ui.state.permission?.sessionId === TERM.sessionId, 5000, "its card");
  const card = ui.state.permission!;
  assert.deepEqual([card.what, card.risky, card.once, card.canAlways], ["use Bash (Kiko asks first: posts)", true, true, undefined]);
  await until(() => caseSaid().some((x: any) => /wants to push to GitHub: allow it\?$/.test(x.text)), 5000, "asked out loud");
  assert.ok(!caseSaid().some((x: any) => /risky, so say allow it/.test(x.text)), "said once, plainly");
  assert.ok(
    logged("ask_permission").some((l) => l.guard === "posts" && l.risky === 1 && l.llmCost === 0),
    "worded in code, no model",
  );
  await windowOpen();
  T.approval = () => ({ answer: "allow_always", confidence: 0.95 });
  await talk("yes always");
  await until(() => spoke("Kiko asks first for anything that posts. Say allow it, or no."), 3000, "a plain yes refused");
  assert.ok(push.open);
  await windowOpen();
  await talk("allow it, always");
  T.approval = undefined;
  await until(() => !push.open, 3000, "allowed");
  assert.deepEqual(push.reply, { behavior: "allow" }, "once: no updatedPermissions");
  assert.deepEqual(
    logged("guard_answer").map((l) => [l.kind, l.answer, l.by]),
    [["posts", "allow", "voice"]],
  );
  console.log("ok");

  begin("the safety gate: no answer in its window: let go to Claude Code's own prompt, logged");
  await wait(1700);
  await gate("npm publish", { hits: [{ kind: "posts", rule: "npm publish", what: "publish to npm" }] });
  const publish = ask("npm publish");
  T.hooks.onRequest(publish);
  await until(() => !publish.open, 8000, "let go");
  assert.equal(publish.reply, null);
  assert.deepEqual(
    logged("guard_answer").map((l) => [l.rule, l.answer]),
    [["npm publish", "none"]],
  );
  console.log("ok");

  begin("the safety gate in Settings: one row, its kinds one by one, off; each logged as a pass");
  await wait(1700);
  ui.act({ type: "settings" });
  await until(() => Boolean(row()), 3000, "its row");
  assert.deepEqual([row().label, row().value], ["Safety gate", "On"]);
  ui.act({ type: "set", key: "guard", value: "kind:posts" });
  await until(() => row()?.value === "On, except posts", 3000, "posts off");
  assert.deepEqual(JSON.parse(readFileSync("settings-test.json", "utf8")).guardOff, ["posts"]);
  assert.equal((await gate("git push", { hits: [PUSH] })).ask, false);
  assert.deepEqual(
    logged("guard_pass").map((l) => [l.why, l.rule]),
    [["posts is off", "git push"]],
  );
  // Another kind in the same call still asks.
  assert.equal((await gate("rm -rf ~/x && git push", { hits: [{ kind: "deletes", rule: "rm -r", what: "delete ~/x" }, PUSH] })).ask, true);
  ui.act({ type: "set", key: "guard", value: "off" });
  await until(() => row()?.value === "Off", 3000, "off");
  assert.equal(JSON.parse(readFileSync("settings-test.json", "utf8")).guard, false, "off saved as off");
  assert.equal((await gate("rm -rf ~/x", { hits: [{ kind: "deletes", rule: "rm -r", what: "delete ~/x" }] })).ask, false);
  ui.act({ type: "set", key: "guard", value: "on" });
  await until(() => row()?.value === "On", 3000, "on again, every kind");
  assert.equal(JSON.parse(readFileSync("settings-test.json", "utf8")).guardOff, undefined);
  ui.act({ type: "closeSettings" });
  // Its asks waiting for a prompt that never came (the ones above): forgotten.
  forgetPending();
  console.log("ok");

  begin("the safety gate: an unclear call goes to the classifier; none passes; with no classifier, risky words ask");
  const deploy = { rule: "script:deploy.sh", what: "run deploy.sh", hint: "posts" };
  T.guardKind = () => "posts";
  const asked = await gate("./deploy.sh", { unclear: [deploy] });
  assert.deepEqual([asked.ask, asked.by], [true, "classifier"]);
  assert.equal(logged("guard_classified").at(-1)?.kind, "posts");
  T.guardKind = () => null;
  assert.equal((await gate("./tidy.sh", { unclear: [{ rule: "script:tidy-push.sh", what: "run tidy-push.sh", hint: "posts" }] })).ask, false);
  T.classifier = false;
  const unsure = await gate("./release.sh", { unclear: [{ rule: "script:release.sh", what: "run release.sh", hint: "posts" }] });
  assert.deepEqual([unsure.ask, unsure.by], [true, "unsure"]);
  assert.equal((await gate("x", { unclear: [{ rule: "mcp:create_issue", what: "use linear's create issue" }] })).ask, false);
  T.classifier = true;
  T.guardKind = undefined;
  forgetPending();
  console.log("ok");
}

// Read-only calls allowed without asking (core/auto-allow.ts): a prompt whose command only reads is
// allowed at once, this once, with nothing said and no card; a line on the page and `auto_allowed`
// in the log say so. Anything else asks as before, and so does a read once it's turned off.
export async function readOnlyCases() {
  await wait(1700);
  const ask = (command: string) =>
    new HookRequest({
      hook_event_name: "PermissionRequest",
      session_id: TERM.sessionId,
      cwd: TERM.cwd,
      permission_mode: "acceptEdits",
      tool_name: "Bash",
      tool_input: { command },
      permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "git log *" }], behavior: "allow", destination: "localSettings" }],
    });
  const logged = (name: string) => caseLog().filter((l) => l.event === name);
  const row = (): any => ui.state.settings?.find((r: any) => r.key === "autoAllowReads");

  begin("read-only commands: allowed at once and once only, nothing said, no card; a line on the page, logged");
  const read = ask("git log --oneline -3 | head -1; git status -sb; ls -la");
  T.hooks.onRequest(read);
  assert.deepEqual(read.reply, { behavior: "allow" }, "answered there and then, with no updatedPermissions");
  assert.deepEqual(
    logged("auto_allowed").map((l) => [l.agent, l.sessionId, l.tool, l.why]),
    [["claude-code", TERM.sessionId, "Bash", "git log, head, git status, ls"]],
  );
  assert.ok(
    caseLines().some((l) => l.kind === "info" && l.text.endsWith(": allowed, only reads: git log --oneline -3 | head -1; git status -sb; ls -la")),
    "the page's line",
  );
  await wait(300);
  assert.deepEqual([logged("ask_permission").length, caseSaid().length], [0, 0], "nothing asked or said");
  assert.notEqual(ui.state.permission?.sessionId, TERM.sessionId);
  console.log("ok");

  begin("read-only commands: one that writes still asks; turned off in Settings (saved), a read asks too");
  const windowOpen = () => until(() => ui.state.waiting?.sessionId === TERM.sessionId && ui.state.waiting?.until != null, 5000, "its window open");
  const write = ask("git log > log.txt");
  T.hooks.onRequest(write);
  await until(() => ui.state.permission?.sessionId === TERM.sessionId, 5000, "its card");
  assert.equal(logged("auto_allow_skipped").at(-1)?.why, "a redirection");
  await windowOpen();
  T.approval = () => ({ answer: "deny", confidence: 0.95 });
  await talk("no");
  await until(() => !write.open, 3000, "denied");
  ui.act({ type: "settings" });
  await until(() => Boolean(row()), 3000, "its row");
  assert.deepEqual([row().label, row().value], ["Allow read-only commands", "On"]);
  ui.act({ type: "set", key: "autoAllowReads", value: false });
  await until(() => row()?.value === "Off", 3000, "off");
  assert.equal(JSON.parse(readFileSync("settings-test.json", "utf8")).autoAllowReads, false, "saved as off");
  ui.act({ type: "closeSettings" });
  await wait(1700);
  const asked = ask("git status");
  T.hooks.onRequest(asked);
  await until(() => ui.state.permission?.sessionId === TERM.sessionId, 5000, "its card");
  assert.equal(asked.open, true);
  await windowOpen();
  T.approval = () => ({ answer: "allow", confidence: 0.95 });
  await talk("yes");
  T.approval = undefined;
  await until(() => !asked.open, 3000, "allowed by voice");
  ui.act({ type: "settings" });
  await until(() => Boolean(row()), 3000, "its row");
  ui.act({ type: "set", key: "autoAllowReads", value: true });
  await until(() => row()?.value === "On", 3000, "on again");
  ui.act({ type: "closeSettings" });
  console.log("ok");
}

// A block allowed anyway (src/core/block-override.ts): auto mode blocked a session's change and
// nothing could allow it. Here a session in Kiko's tmux, its pane showing
// Claude Code 2.1.314's input box and footer: the block is a card; a yes presses Shift+Tab (tmux's
// BTab) until its screen says accept edits, read back after each press, then types the retry; a no
// presses nothing. The cycle here has bypass enabled, after plan: never passed through.
export async function blockOverrideCases() {
  const RULE = "─".repeat(78);
  const FOOTER: Record<string, string> = {
    auto: "  ⏵⏵ auto mode on (shift+tab to cycle)",
    default: "  ? for shortcuts",
    acceptEdits: "  ⏵⏵ accept edits on (shift+tab to cycle)",
    plan: "  ⏸ plan mode on (shift+tab to cycle)",
    bypassPermissions: "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  };
  const CYCLE = ["default", "acceptEdits", "plan", "bypassPermissions", "auto"];
  const screenIn = (mode: string) => ["⏺ Bash(wrangler deploy --env production)", "  ⎿  Error: denied by auto mode", "", RULE, "❯ ", RULE, FOOTER[mode], ""].join("\n");
  const PIXIE = {
    ...TERM,
    sessionId: "auto-pixie",
    name: "pixie",
    givenName: "",
    cwd: `${PROJECTS_ROOT}/pixie`,
    status: "idle",
    place: { via: "tmux", id: "%3", keys: true, pid: 4343 },
    mapping: "process",
  };
  const REX = { ...TERM, sessionId: "auto-rex", name: "rex", givenName: "", cwd: `${PROJECTS_ROOT}/rex`, status: "idle", place: { via: "tmux", id: "%4", keys: true, pid: 4444 }, mapping: "process" };
  const before = T.sessions;
  T.sessions = [DESK, PIXIE, REX];
  const modes: Record<string, string> = { "%3": "auto", "%4": "auto" };
  T.tmux = {
    panes: [
      { id: "%3", pid: 4300, tty: "/dev/ttys043", inMode: false, session: "pixie", cwd: PIXIE.cwd },
      { id: "%4", pid: 4400, tty: "/dev/ttys044", inMode: false, session: "rex", cwd: REX.cwd },
    ],
    procs: [
      { pid: 4300, ppid: 1, pgid: 4300, tpgid: 4343, stat: "Ss", tty: "ttys043" },
      { pid: 4343, ppid: 4300, pgid: 4343, tpgid: 4343, stat: "S+", tty: "ttys043" },
      { pid: 4400, ppid: 1, pgid: 4400, tpgid: 4444, stat: "Ss", tty: "ttys044" },
      { pid: 4444, ppid: 4400, pgid: 4444, tpgid: 4444, stat: "S+", tty: "ttys044" },
    ],
    screens: { "%3": screenIn("auto"), "%4": screenIn("auto") },
    // Shift+Tab: Claude Code's next mode in its cycle, drawn.
    onKey: (pane: string, key: string) => {
      if (key !== "BTab") return;
      modes[pane] = CYCLE[(CYCLE.indexOf(modes[pane]) + 1) % CYCLE.length];
      T.tmux.screens[pane] = screenIn(modes[pane]);
    },
  };
  await wait(2100); // windows and the session list cache run out
  const block = (s: any) =>
    T.hooks.onBlocked({ sessionId: s.sessionId, cwd: s.cwd, tool: { name: "Bash", input: { command: "wrangler deploy --env production" } }, reason: "[Production Deploy]", by: "auto", mode: "auto" });
  const keysTo = (pane: string) => T.keys.filter((k: any) => k.terminalId === pane).map((k: any) => k.key);

  begin("a block in Kiko's tmux: a card; yes switches it to accept edits (read back after each Shift+Tab) and asks it to try again");
  block(PIXIE);
  await until(() => ui.state.permission?.sessionId === PIXIE.sessionId, 5000, "its card");
  assert.equal(ui.state.permission!.what, "use Bash (auto mode blocked it)", "the stubbed describeTool's words, marked as blocked");
  assert.equal(ui.state.permission!.once, true, "no always");
  await until(() => caseLines().some((l) => l.kind === "spoken" && l.text === "Auto mode blocked pixie from running wrangler deploy --env production. Allow it?"), 5000, "asked");
  assert.deepEqual(keysTo("%3"), [], "nothing pressed before your yes");
  ui.act({ type: "allow", always: false, id: ui.state.permission!.id });
  await until(() => caseLog().some((l) => l.event === "block_override"), 8000, "done");
  assert.deepEqual(keysTo("%3"), ["BTab", "BTab"], "auto → manual → accept edits, never past it");
  assert.equal(modes["%3"], "acceptEdits");
  assert.ok(
    T.typed.some((t: any) => t.terminalId === "%3" && t.text === "Out of auto mode now: try running wrangler deploy --env production again."),
    "the retry typed into its pane",
  );
  assert.ok((T.tmux.entered ?? []).includes("%3"), "and sent");
  const done = caseLog().find((l) => l.event === "block_override");
  assert.deepEqual([done.ok, done.from, done.now, done.presses, done.retry], [true, "auto", "acceptEdits", 2, true]);
  await until(() => caseLines().some((l) => l.kind === "spoken" && l.text === "pixie is in accept edits now, and I asked it to try again."), 3000, "said");
  console.log("ok");

  begin("another block of it within 30s: shown, not asked again; a no to another's card presses nothing");
  block(PIXIE);
  await until(() => caseLog().filter((l) => l.event === "auto_mode_blocked").length === 1, 3000, "logged");
  assert.deepEqual(
    caseLog()
      .filter((l) => l.event === "auto_mode_blocked")
      .map((l) => [l.said, l.offered]),
    [[false, false]],
  );
  await wait(300);
  assert.notEqual(ui.state.permission?.sessionId, PIXIE.sessionId, "no second card");
  block(REX);
  await until(() => ui.state.permission?.sessionId === REX.sessionId, 5000, "rex's card");
  ui.act({ type: "deny", id: ui.state.permission!.id });
  await until(() => ui.state.permission === null, 3000, "gone");
  await wait(500);
  assert.deepEqual(keysTo("%4"), [], "nothing pressed");
  assert.equal(modes["%4"], "auto");
  assert.ok(!T.typed.some((t: any) => t.terminalId === "%4"), "nothing typed");
  console.log("ok");

  T.tmux = undefined;
  T.sessions = before;
}

// Claude's multiple-choice questions (AskUserQuestion, src/core/ask.ts) by voice: one at a time, each answer
// matched in code or by the (stubbed) model, confirmed with the next question, and all the answers to the hook
// after the last. "I'll answer at the Mac" and running out leave them in the terminal (the hook let go, no
// answers); questions that can't be read go there at once, never asked as "Allow?".
export async function askCases() {
  const QUESTIONS = [
    {
      question: "Can I set it up with Homebrew tonight?",
      header: "Install tmux",
      options: [
        { label: "Yes, install it (Recommended)", description: "brew install tmux" },
        { label: "No, I'll install it", description: "in the morning" },
      ],
      multiSelect: false,
    },
    {
      question: "How should your own sessions get into Kiko's tmux?",
      header: "Your sessions",
      options: [
        { label: "`kiko claude` command (Recommended)", description: "a small command" },
        { label: "Wrap `claude` itself", description: "a shell alias" },
        { label: "Only Kiko's own sessions", description: "decide later" },
      ],
      multiSelect: false,
    },
  ];
  const asked = (questions: unknown = QUESTIONS) =>
    new HookRequest({ hook_event_name: "PermissionRequest", session_id: TERM.sessionId, cwd: TERM.cwd, tool_name: "AskUserQuestion", tool_input: { questions } });
  const events = (name: string) => caseLog().filter((l) => l.event === name);
  // What was said, as shown (the voice gets it respelled: tmux as "tee mux"). Who asks is the
  // session's name, or "It" right after it was announced.
  const said = (part: string) => caseLines().some((l) => l.text.includes(part));
  const saidNow = (start: string) => caseLines().some((l) => l.text.startsWith(start));
  // Once it's been heard and its window counts: a press in its first moments puts it back instead.
  const answer = async (text: string) => {
    await until(() => ui.state.waiting?.kind === "permission" && ui.state.waiting.until != null);
    await talk(text);
  };

  begin("Claude's questions by voice: one at a time, code then the model, all the answers after the last");
  await wait(1700);
  T.askModel = (_: any, text: string) => (text === "the one with the alias" ? "2" : "UNCLEAR");
  const q = asked();
  T.hooks.onRequest(q);
  await until(() => said("has 2 questions. First, Install tmux: Can I set it up with Homebrew tonight? One: Yes, install it, recommended. Two: No, I'll install it."));
  assert.equal(ui.state.permission?.questions?.length, 2);
  assert.equal(ui.state.permission?.what, "ask 2 questions: Install tmux, Your sessions");
  await answer("Yes, install it.");
  await until(() => saidNow("Got it: Yes, install it. Last one, Your sessions:"));
  assert.ok(q.open, "still asking");
  assert.equal(ui.state.permission?.asking, 1);
  await answer("um, hmm");
  await until(() => saidNow("Sorry, which one? Say a number, or your own answer. One: kiko claude command, recommended."));
  await answer("the one with the alias");
  await until(() => !q.open);
  assert.deepEqual(q.reply, { behavior: "allow" });
  assert.deepEqual(q.answers, {
    "Can I set it up with Homebrew tonight?": "Yes, install it (Recommended)",
    "How should your own sessions get into Kiko's tmux?": "Wrap `claude` itself",
  });
  await until(() => saidNow("Got it: Wrap claude itself."));
  assert.deepEqual(
    events("question_answer").map((l) => [l.at, l.match, l.by]),
    [
      [0, "pick", "code"],
      [1, "unclear", "model"],
      [1, "pick", "model"],
    ],
  );
  assert.equal(events("questions_answered").length, 1);
  await until(() => ui.state.permission === null);
  console.log("ok");

  begin("Claude's question answered in the window's list (its option's number, as if said)");
  await wait(300);
  const one = asked([QUESTIONS[1]]);
  T.hooks.onRequest(one);
  await until(() => ui.state.waiting?.kind === "permission" && ui.state.waiting.until != null);
  // A click meant for an earlier prompt (another id), or for another of its questions: dropped, logged, nothing answered.
  ui.act({ type: "answer", option: 1, id: "an-earlier-prompt", asking: 0 });
  ui.act({ type: "answer", option: 1, id: ui.state.permission!.id, asking: 1 });
  ui.act({ type: "deny", id: "an-earlier-prompt" });
  await wait(100);
  assert.ok(one.open, "still asking");
  assert.equal(events("answer_stale").length, 3);
  ui.act({ type: "answer", option: 2, id: ui.state.permission!.id, asking: ui.state.permission!.asking ?? 0 });
  await until(() => !one.open);
  assert.deepEqual(one.answers, { "How should your own sessions get into Kiko's tmux?": "Wrap `claude` itself" });
  assert.deepEqual(events("question_answer").at(-1).match, "pick");
  console.log("ok");

  begin("Claude's questions: \"I'll answer at the Mac\" leaves them in the terminal, nothing answered");
  await wait(300);
  const left = asked();
  T.hooks.onRequest(left);
  await until(() => said("has 2 questions."));
  await answer("I'll answer it at the Mac.");
  await until(() => !left.open);
  assert.equal(left.reply, null);
  assert.equal(left.answers, undefined);
  await until(() => saidNow("OK, it's waiting at the Mac."));
  console.log("ok");

  begin("Claude's questions: no answer in the window leaves them in the terminal");
  await wait(300);
  const quiet = asked();
  T.hooks.onRequest(quiet);
  await until(() => said("has 2 questions."));
  await until(() => !quiet.open, 2500);
  assert.equal(quiet.reply, null);
  assert.ok(caseLines().some((l) => l.text === "(no answer; the questions are waiting in the terminal)"));
  console.log("ok");

  begin("Claude's questions that can't be read go to the terminal at once, never asked as \"Allow?\"");
  await wait(300);
  const odd = asked("not a list");
  T.hooks.onRequest(odd);
  await until(() => !odd.open, 500);
  assert.equal(odd.reply, null);
  await wait(100);
  assert.ok(!caseSaid().some((x: any) => x.text.includes("Allow?")));
  assert.equal(events("ask_unreadable").length, 1);
  console.log("ok");
}
