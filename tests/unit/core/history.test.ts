// A session's conversation from its transcript (src/core/history.ts): your words and Claude's,
// tool calls folded into steps with their details, the caps, and the watcher that follows the
// transcript entry by entry. The transcript lines have the shapes Claude Code writes (2026-10-28).
import "../../setup.ts";
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FULL, HistoryFolder, HistoryWatcher, itemAt, LIMITS, readHistory, saidThisTurn, type History } from "../../../src/core/history.ts";
import { PREVIEW, preview } from "../../../src/remote/history-window.ts";
import { lastUserMessage } from "../../../src/agents/claude-code/transcripts.ts";
import { VOICE_PROMPT } from "../../../hooks/lib.mjs";

const at = "2026-10-28T14:02:11.000Z";
const you = (text: string) => ({ type: "user", timestamp: at, message: { role: "user", content: text } });
const said = (text: string) => ({ type: "assistant", timestamp: at, message: { content: [{ type: "text", text }] } });
const use = (id: string, name: string, input: object) => ({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, content: unknown, extra: object = {}) => ({
  type: "user",
  timestamp: at,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: false, ...extra }] },
});

function fold(entries: object[]) {
  const f = new HistoryFolder();
  for (const e of entries) f.add(e);
  return f.snapshot();
}

test("your words and Claude's, with the tool calls between them folded into one item", () => {
  const h = fold([
    you("Add a created_at column and migrate."),
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } },
    use("t1", "Read", { file_path: "db/schema.ts" }),
    result("t1", "export const invoices = …"),
    use("t2", "Edit", { file_path: "db/schema.ts", old_string: "a", new_string: "a\nb\nc" }),
    result("t2", "ok", {}),
    use("t3", "Bash", { command: "pnpm test", description: "Run tests" }),
    result("t3", [{ type: "text", text: "PASS 12 tests" }]),
    use("t4", "Bash", { command: "pnpm   lint\n --fix" }),
    result("t4", "1 error", { is_error: true }),
    said("Done. **One** lint error left."),
  ]);
  assert.deepEqual(
    h.items.map((i) => i.kind),
    ["you", "steps", "claude"],
  );
  const steps = h.items[1] as Extract<History["items"][number], { kind: "steps" }>;
  assert.equal(steps.summary, "read 1 file, edited 1 file, ran 2 commands");
  assert.deepEqual(steps.steps, [
    { tool: "Read", title: "db/schema.ts", detail: "", error: false },
    { tool: "Edit", title: "db/schema.ts", detail: "+3 −1", error: false, added: 3, removed: 1, diff: "-a\n+a\n+b\n+c" },
    { tool: "Bash", title: "pnpm test", detail: "PASS 12 tests", error: false },
    { tool: "Bash", title: "pnpm lint --fix", detail: "1 error", error: true },
  ]);
  assert.deepEqual(h.items[2], { kind: "claude", text: "Done. **One** lint error left.", at });
});

test("an edit's size comes from Claude Code's structured patch when there is one", () => {
  const h = fold([use("e", "Edit", { file_path: "a.ts", old_string: "x", new_string: "y" }), result("e", "ok", {})]);
  assert.equal((h.items[0] as any).steps[0].detail, "+1 −1");
  const f = new HistoryFolder();
  f.add(use("e", "Edit", { file_path: "a.ts", old_string: "x", new_string: "y" }));
  f.add({ ...result("e", "ok"), toolUseResult: { structuredPatch: [{ lines: [" ctx", "-x", "+y", "+z"] }] } });
  assert.equal((f.snapshot().items[0] as any).steps[0].detail, "+2 −1");
});

test("long output is cut to its first lines, with how many more there were", () => {
  const out = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  const h = fold([use("b", "Bash", { command: "pnpm test" }), result("b", out)]);
  const detail = (h.items[0] as any).steps[0].detail as string;
  assert.equal(detail.split("\n").length, LIMITS.outputLines + 1);
  assert.ok(detail.endsWith(`… ${30 - LIMITS.outputLines} more lines`));
});

test("Claude Code's wrappers, meta and sidechain entries aren't conversation", () => {
  const h = fold([
    you("<command-name>/rename</command-name>"),
    { ...you("hidden"), isMeta: true },
    { ...said("a subagent's words"), isSidechain: true },
    { type: "attachment" },
    you("real words"),
    said("first part"),
    said("second part"),
  ]);
  assert.deepEqual(h.items, [
    { kind: "you", text: "real words", at },
    { kind: "claude", text: "first part\n\nsecond part", at },
  ]);
});

// A long typed or pasted prompt, as Claude Code hands it on (read from real transcripts, 2026-11-14;
// the words here are made up): two blank lines, `<pasted_content id="…">` on a line of its own, the
// text, the closing line with the id again, a line break. With your own words too: three line
// breaks between them and the paste's lines. The app's typing arrives as a paste, so every dictation
// over about 800 characters is one: starting with "<", they were all dropped as wrappers.
const paste = (text: string, id = "8048") => `<pasted_content id="${id}">\n${text}\n</pasted_content id="${id}">`;
const DICTATION = "So what I want is for the settings page to load faster, and here is how I think about it. ".repeat(12).trim();

test("a long dictation, which Claude Code wraps as a paste, is your words: its two lines taken off", () => {
  assert.ok(DICTATION.length > 800);
  const h = fold([
    you(`\n\n${paste(DICTATION)}\n`),
    said("On it."),
    // Sent while Claude was busy: kept as a queued command, with nothing around the paste's lines.
    { type: "attachment", timestamp: at, attachment: { type: "queued_command", prompt: paste("And the tests too.\n\nAll of them.", "ec41") } },
    // With screenshots: the words are a text block, the pictures blocks of their own.
    {
      type: "user",
      timestamp: at,
      message: {
        role: "user",
        content: [
          { type: "text", text: `\n\n${paste(DICTATION, "0b7f")}\n` },
          { type: "image", source: {} },
        ],
      },
    },
  ]);
  assert.deepEqual(h.items, [
    { kind: "you", text: DICTATION, at },
    { kind: "claude", text: "On it.", at },
    { kind: "you", text: "And the tests too.\n\nAll of them.", at },
    { kind: "you", text: DICTATION, at },
  ]);
});

test("a paste with your words around it: both, the pasted text where it was, a paragraph of its own", () => {
  const notes = "Monday: the build broke.\n\n  Tuesday: fixed, twice.";
  const h = fold([
    you(`Here are my notes:\n\n\n${paste(notes)}\n\n\nWhat do you make of them?`),
    you(`Compare these two.\n\n\n${paste("The first one.", "1a")}\n\n\n\n${paste("The second one.", "2b")}\n`),
    // What was pasted starts with "<" itself: still yours, as pasted.
    you(`\n\n${paste("<ul>\n  <li>One</li>\n</ul>")}\n\n\nWhy is this list not showing?`),
    // The tag in the middle of a line is something you wrote.
    you("What does a <pasted_content> tag mean?"),
  ]);
  assert.deepEqual(
    h.items.map((i) => (i as any).text),
    [
      `Here are my notes:\n\n${notes}\n\nWhat do you make of them?`,
      "Compare these two.\n\nThe first one.\n\nThe second one.",
      "<ul>\n  <li>One</li>\n</ul>\n\nWhy is this list not showing?",
      "What does a <pasted_content> tag mean?",
    ],
  );
});

test("what Claude Code writes into a user message itself stays hidden, a wrapper not known by name too", () => {
  const h = fold([
    you("<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>"),
    you("<local-command-stdout>Set model to Default</local-command-stdout>"),
    you("<local-command-caveat>Caveat: the messages below were generated by the user while running local commands.</local-command-caveat>"),
    you("<bash-input>ls</bash-input>"),
    you("<bash-stdout>a.ts\nb.ts</bash-stdout><bash-stderr></bash-stderr>"),
    you("<system-reminder>\nThe date has changed.\n</system-reminder>"),
    you("<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>The build finished</summary>\n</task-notification>"),
    you('<agent-message from="tester">\nAll green.\n</agent-message>'),
    { type: "attachment", timestamp: at, attachment: { type: "queued_command", prompt: "<task-notification>\n<task-id>t2</task-id>\n</task-notification>" } },
    // One Claude Code adds later, or one never closed: hidden, as anything starting with "<" always was.
    you("<some-new-wrapper>\nSomething it says to itself.\n</some-new-wrapper>\nAnd more of it."),
    you("<system-reminder>\ncut off part way"),
    said("Nothing of yours yet."),
  ]);
  assert.deepEqual(h.items, [{ kind: "claude", text: "Nothing of yours yet.", at }]);
});

test("a message that is one of its blocks and your words: the words", () => {
  const reminder = "<system-reminder>\nThe date has changed.\n</system-reminder>";
  const h = fold([
    you(`${reminder}\n\nRun the tests again.`),
    you(`Now the linter.\n\n${reminder}`),
    you(`<local-command-caveat>Caveat.</local-command-caveat>\n${reminder}\nAnd the type check.\n${reminder}\n${reminder}`),
    // Pasted: left as you pasted it.
    you(`What is this?\n\n\n${paste(reminder)}\n`),
    // A block of its own before yours (each text block is read on its own).
    {
      type: "user",
      timestamp: at,
      message: {
        role: "user",
        content: [
          { type: "text", text: "<some-new-wrapper>a.ts is open</some-new-wrapper>" },
          { type: "text", text: "Rename it." },
        ],
      },
    },
  ]);
  assert.deepEqual(
    h.items.map((i) => (i as any).text),
    ["Run the tests again.", "Now the linter.", "And the type check.", `What is this?\n\n${reminder}`, "Rename it."],
  );
});

// What the paste feeds besides the conversation: the turn's words a summary answers first
// (saidThisTurn), what was last asked (lastUserMessage: Claude Code's own "lastPrompt" line when the
// transcript's end has one, which holds no paste lines; else the last user entry, read here).
test("a long dictation is the turn's words and what was last asked", () => {
  const path = join(process.cwd(), "pasted.jsonl");
  const write = (entries: object[]) => writeFileSync(path, entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
  const ended = [
    { type: "system", subtype: "stop_hook_summary" },
    { type: "system", subtype: "turn_duration" },
  ];
  write([
    you("Earlier."),
    said("Sure."),
    ...ended,
    you(`\n\n${paste(DICTATION)}\n`),
    said("Looking."),
    { type: "attachment", timestamp: at, attachment: { type: "queued_command", prompt: `One more thing.\n\n\n${paste("Line one.\nLine two.")}` } },
  ]);
  assert.deepEqual(saidThisTurn(path), [DICTATION, "One more thing.\n\nLine one.\nLine two."]);
  assert.equal(lastUserMessage(path), DICTATION);
  // A wrapper after it, and a block before your words in the same entry, don't change what was asked.
  write([
    you("Earlier."),
    {
      type: "user",
      timestamp: at,
      message: {
        role: "user",
        content: [
          { type: "text", text: "<some-new-wrapper>a.ts is open</some-new-wrapper>" },
          { type: "text", text: `Fix this.\n\n\n${paste("TypeError: x is not a function")}\n` },
        ],
      },
    },
    you("<local-command-stdout>Set model to Default</local-command-stdout>"),
  ]);
  assert.equal(lastUserMessage(path), "Fix this.\n\nTypeError: x is not a function");
  // Claude Code's own record of the latest prompt, when there is one, as before.
  write([you(`\n\n${paste(DICTATION)}\n`), { type: "last-prompt", lastPrompt: DICTATION.slice(0, 200), sessionId: "s" }]);
  assert.equal(lastUserMessage(path), DICTATION.slice(0, 200));
});

// A long paste in the views, with the sizes as they are: the window shows LIMITS.text of it, a
// paged phone PREVIEW.text, each marked `cut`; Show full (itemAt) has ten times the window's.
test("a very long paste is cut as any long message is, and Show full brings more of it", () => {
  const long = Array.from({ length: 400 }, (_, i) => `Line ${i} of what was pasted, some forty characters.`).join("\n");
  assert.ok(long.length > LIMITS.text * 2 && long.length < FULL.text);
  const path = join(process.cwd(), "long-paste.jsonl");
  writeFileSync(path, `${JSON.stringify(you(`See this log.\n\n\n${paste(long)}\n`))}\n`);
  const [item] = readHistory(path).items as any[];
  assert.equal(item.text.length, LIMITS.text);
  assert.ok(item.text.startsWith("See this log.\n\nLine 0 of what was pasted") && item.text.endsWith("…"));
  assert.equal(item.cut, true);
  const onPhone = preview(item) as any;
  assert.deepEqual([onPhone.text.length, onPhone.cut], [PREVIEW.text, true]);
  assert.deepEqual(itemAt(path, item.id!), { kind: "you", text: `See this log.\n\n${long}`, at, id: item.id });
});

test("caps: the last items only, and many steps fold to the first ones with every one counted", () => {
  const many = Array.from({ length: LIMITS.items + 10 }, (_, i) => (i % 2 ? said(`reply ${i}`) : you(`ask ${i}`)));
  const h = fold(many);
  assert.equal(h.items.length, LIMITS.items);
  assert.equal(h.truncated, true);
  assert.equal((h.items.at(-1) as any).text, `reply ${LIMITS.items + 9}`);
  const calls = Array.from({ length: LIMITS.steps + 5 }, (_, i) => use(`b${i}`, "Bash", { command: `echo ${i}` }));
  const s = fold(calls).items[0] as any;
  assert.equal(s.steps.length, LIMITS.steps);
  assert.equal(s.summary, `ran ${LIMITS.steps + 5} commands`);
  assert.ok(fold([said("x".repeat(LIMITS.text + 50))]).items[0].kind === "claude");
  assert.equal((fold([said("x".repeat(LIMITS.text + 50))]).items[0] as any).text.length, LIMITS.text);
});

test("readHistory: a missing transcript is an empty history", () => {
  assert.deepEqual(readHistory(join(process.cwd(), "nope.jsonl")), { items: [], truncated: false });
  assert.deepEqual(readHistory(undefined), { items: [], truncated: false });
});

test("the watcher: the history at once, then each new entry as it's written, whole lines only", async () => {
  const path = join(process.cwd(), "watched.jsonl");
  const line = (e: object) => `${JSON.stringify(e)}\n`;
  writeFileSync(path, line(you("deploy it")));
  const seen: History[] = [];
  const w = new HistoryWatcher(path, (h) => seen.push(h), 10_000);
  try {
    assert.equal(seen.length, 1);
    assert.deepEqual(
      seen[0].items.map((i) => i.kind),
      ["you"],
    );
    appendFileSync(path, line(use("b", "Bash", { command: "pnpm deploy" })));
    w.check();
    assert.equal(seen.length, 2);
    assert.equal((seen[1].items[1] as any).summary, "ran 1 command");
    assert.equal((seen[1].items[1] as any).steps[0].detail, "", "no result yet");
    assert.deepEqual(
      seen[1].items.map((i) => i.id),
      ["0", String(line(you("deploy it")).length)],
      "each item's id: where its entry starts in the file",
    );
    // Half a line: nothing until the rest is written.
    const half = line(result("b", "Deployed."));
    appendFileSync(path, half.slice(0, 20));
    w.check();
    assert.equal(seen.length, 2);
    appendFileSync(path, half.slice(20));
    w.check();
    assert.equal(seen.length, 3);
    assert.equal((seen[2].items[1] as any).steps[0].detail, "Deployed.");
    assert.equal((seen[1].items[1] as any).steps[0].detail, "", "earlier snapshots keep what they had");
    w.check();
    assert.equal(seen.length, 3, "nothing new, nothing sent");
    // Replaced by a shorter file: read again from the start.
    writeFileSync(path, line(you("fresh start")));
    w.check();
    assert.deepEqual(seen.at(-1)!.items, [{ kind: "you", text: "fresh start", at, id: "0" }], "its id where it starts: the file's start");
  } finally {
    w.stop();
  }
});

test("a spoken reply given through the Stop hook, and a message sent while Claude was busy, are your words", () => {
  const attachment = (a: object) => ({ type: "attachment", timestamp: at, attachment: a });
  const h = fold([
    said("Want me to restart it?"),
    attachment({ type: "hook_success", hookName: "Stop", stdout: "{}" }),
    attachment({ type: "hook_additional_context", hookName: "Stop", content: ["The user replied by voice (speech-to-text, so expect small transcription errors): Yeah, let's do that."] }),
    attachment({ type: "hook_additional_context", hookName: "Stop", content: ["Some other hook's note"] }),
    said("Restarting."),
    attachment({ type: "queued_command", prompt: "Also check the logs." }),
    attachment({ type: "queued_command", prompt: "<task-notification>\n<task-id>x</task-id>" }),
  ]);
  assert.deepEqual(
    h.items.map((i) => (i.kind === "steps" ? "steps" : `${i.kind}: ${i.text}`)),
    ["claude: Want me to restart it?", "you: Yeah, let's do that.", "claude: Restarting.", "you: Also check the logs."],
  );
});

// The line Kiko's hook adds beside a prompt the app typed in for you (hooks/lib.mjs VOICE_PROMPT), as
// Claude Code 2.1.325 keeps it (2026-11-14): the prompt's own entry as typed, then the hook's added
// context as an attachment, with how it was shown to Claude. Only Claude reads it.
test("the note beside a dictated prompt is never your words: not in the conversation, the turn's words, or what was last asked", () => {
  const note = {
    type: "attachment",
    timestamp: at,
    attachment: { type: "hook_additional_context", content: [VOICE_PROMPT], hookName: "UserPromptSubmit", toolUseID: "hook-ff66f60e", hookEvent: "UserPromptSubmit" },
    rendered: [{ content: `<system-reminder>\nUserPromptSubmit hook additional context: ${VOICE_PROMPT}\n</system-reminder>` }],
    renderedRole: "system",
  };
  const entries = [
    you("An earlier ask."),
    said("Done."),
    { type: "system", subtype: "stop_hook_summary" },
    { type: "system", subtype: "turn_duration" },
    you("Open it in high term."),
    note,
    said("Opening it in iTerm."),
  ];
  assert.deepEqual(
    fold(entries).items.map((i) => (i.kind === "steps" ? "steps" : `${i.kind}: ${i.text}`)),
    ["you: An earlier ask.", "claude: Done.", "you: Open it in high term.", "claude: Opening it in iTerm."],
  );
  const path = join(process.cwd(), "dictated.jsonl");
  writeFileSync(path, entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
  assert.deepEqual(saidThisTurn(path), ["Open it in high term."]);
  assert.equal(lastUserMessage(path), "Open it in high term.");
  // Still being written, the note the newest line: the same.
  writeFileSync(
    path,
    entries
      .slice(0, 6)
      .map((e) => `${JSON.stringify(e)}\n`)
      .join(""),
  );
  assert.deepEqual(saidThisTurn(path), ["Open it in high term."]);
  assert.equal(lastUserMessage(path), "Open it in high term.");
  assert.equal(JSON.stringify(readHistory(path)).includes("dictated"), false);
});

// saidThisTurn: what a finished turn's summary is told you said to the session during it. A summary once
// left out the joke you asked for while Claude was busy: Claude Code keeps
// such a message as a queued command, which the app's own timeline never has when it's typed by hand.
test("saidThisTurn: your words since the last turn ended, mid-turn ones too, and a reply through the hook that started it", () => {
  const path = join(process.cwd(), "turn.jsonl");
  const attachment = (a: object) => ({ type: "attachment", timestamp: at, attachment: a });
  const ended = [
    { type: "system", subtype: "stop_hook_summary" },
    { type: "system", subtype: "turn_duration" },
  ];
  const write = (entries: object[]) => writeFileSync(path, entries.map((e) => `${JSON.stringify(e)}\n`).join(""));

  write([
    you("An earlier ask."),
    said("Done."),
    ...ended,
    you("Merge the word-loss fix."),
    use("m", "Bash", { command: "git merge" }),
    { type: "user", isCompactSummary: true, message: { role: "user", content: "This session is being continued from a previous conversation…" } },
    attachment({ type: "queued_command", prompt: "Tell me a short joke." }),
    result("m", "merged"),
    said("Here's a short joke… The fix is merged."),
  ]);
  assert.deepEqual(saidThisTurn(path), ["Merge the word-loss fix.", "Tell me a short joke."]);

  // A reply through the last hold: kept with that hook's lines, just before its summary line.
  write([
    you("An earlier ask."),
    said("Want me to restart it?"),
    attachment({ type: "hook_success", hookName: "Stop", stdout: "{}" }),
    attachment({ type: "hook_additional_context", hookName: "Stop", content: ["The user replied by voice (speech-to-text, so expect small transcription errors): Yes, and what time is it?"] }),
    { type: "system", subtype: "stop_hook_summary" },
    said("Restarted. It's 4 PM."),
  ]);
  assert.deepEqual(saidThisTurn(path), ["Yes, and what time is it?"]);

  // Nothing said this turn (a background task's notice started it): none.
  write([you("An earlier ask."), said("Done."), ...ended, you("<task-notification>x</task-notification>"), said("The task finished.")]);
  assert.deepEqual(saidThisTurn(path), []);

  assert.equal(saidThisTurn(join(process.cwd(), "nope.jsonl")), null, "no transcript: can't tell");
  assert.equal(saidThisTurn(undefined), null);
});
