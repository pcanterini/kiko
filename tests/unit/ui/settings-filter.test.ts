// The settings screen's filter (`/`, src/ui/settings.ts): which settings it finds (filterSettings, with
// the Ctrl+Space menu's matcher), and the screen rendered for real with Ink, typed into: the filter
// line, sections kept or gone, the no-match line, Esc and Backspace, and no setting's own key
// (q, s, j, k) firing while the filter is typed into. Every wait is for something to be so (Ink through
// with each key, a frame drawn: tests/support/ink.ts), never a fixed time.
import "../../setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import React from "react";
import { render } from "ink";
import { filterSettings, Settings } from "../../../src/ui/settings.ts";
import { SettingsScreen } from "../../../src/ui/tui.ts";
import { ui, type Action, type SettingRow } from "../../../src/core/ui-store.ts";
import { accountChoices } from "../../../src/core/settings-options.ts";
import { inkDone, keyboard, plain, typeKeys, untilFrame } from "../../support/ink.ts";
import { checkWaits } from "../../support/until.ts";

const ROWS: SettingRow[] = [
  { key: "voiceCan", label: "Voice can", value: "Everything", raw: "everything", restart: false },
  { key: "tts", label: "Voice engine", value: "macOS voice", raw: "say", restart: false },
  { key: "voice", label: "Voice", value: "Samantha", raw: "Samantha", restart: false },
  { key: "mic", label: "Microphone", value: "System default", raw: null, restart: false, note: "Desk Mic is away" },
  { key: "hotkey", label: "Talk key", value: "Right Option", raw: "ralt", restart: true },
  { key: "llm", label: "Model", value: "Claude Haiku 5.5", raw: "haiku", restart: false },
  { key: "projectsRoot", label: "Projects folder", value: "~/git", raw: "~/git", restart: false },
  { key: "keepLogs", label: "Keep logs", value: "30 days", raw: 30, restart: false },
];

const sections = (query: string | null) => filterSettings(ROWS, query).map((g) => [g.title, g.rows.map((r) => r.key)]);

test("filterSettings: no filter, or nothing typed yet: every setting, by section", () => {
  const all = [
    ["Control", ["voiceCan"]],
    ["Voice", ["tts", "voice"]],
    ["Listening", ["mic", "hotkey"]],
    ["Replies", ["llm"]],
    ["New sessions", ["projectsRoot"]],
    ["Logs", ["keepLogs"]],
  ];
  assert.deepEqual(sections(null), all);
  assert.deepEqual(sections(""), all);
  assert.deepEqual(sections("  "), all);
});

test("filterSettings: by name, value, section or note; sections with no match are left out, the others keep their heading", () => {
  assert.deepEqual(sections("haiku"), [["Replies", ["llm"]]], "by its value");
  assert.deepEqual(sections("talk"), [["Listening", ["hotkey"]]], "by its name");
  assert.deepEqual(sections("listening"), [["Listening", ["mic", "hotkey"]]], "a section's name: all of it");
  assert.deepEqual(sections("desk mic"), [["Listening", ["mic"]]], "by its note");
  assert.deepEqual(sections("VOICE"), [
    ["Control", ["voiceCan"]],
    ["Voice", ["tts", "voice"]],
  ]);
  // The menu's matcher: the starts of words in order ("prfo": PRojects FOlder).
  assert.deepEqual(sections("prfo"), [["New sessions", ["projectsRoot"]]]);
  assert.deepEqual(sections("zzz"), []);
});

const until = checkWaits(5000);

/**
 * The settings screen on a screen `width` wide, typed into: what it last drew (plain text), and what it
 * asked of the app. `press` types keys one at a time, Ink through with each; `esc` types Esc (which
 * Ink holds a moment) and waits for what it does: a frame, or an act.
 */
async function open(width = 120) {
  const acts: Action[] = [];
  const act = ui.act;
  ui.act = (a: Action) => void acts.push(a);
  let frame = "";
  const out = new Writable({ write: (chunk, _enc, done) => (chunk.toString().trim() ? (frame = plain(chunk.toString())) : null, done()) }) as Writable & { columns: number; rows: number };
  out.columns = width;
  out.rows = 40;
  const stdin = keyboard();
  const s = { ...ui.state, screen: "settings" as const, settings: ROWS };
  const app = render(React.createElement(Settings, { s, width, height: 30 }), { stdout: out as never, stdin: stdin as never, patchConsole: false, interactive: true });
  await inkDone(app);
  const press = (...keys: string[]) => typeKeys(app, stdin, ...keys);
  const esc = async (then: { frame: (f: string) => boolean } | { acts: number }, what: string) => {
    stdin.write(ESC);
    if ("frame" in then) await untilFrame(() => frame, then.frame, what);
    else await until(() => acts.length >= then.acts, what);
  };
  const done = () => {
    app.unmount();
    ui.act = act;
  };
  return { acts, press, esc, done, frame: () => frame };
}

const ESC = "\x1b";
const BACKSPACE = "\x7f";
const DOWN = "\x1b[B";
/** The setting chosen, as its line in the list shows it (its name and value). */
const chosenLine = (frame: string) => /▸ ([^│]*?)\s*│/.exec(frame)?.[1] ?? /▸ (.*)/.exec(frame)?.[1]?.trim();

test("/ opens the filter at the top of the list; typing narrows it, sections and all; the hints say so", async () => {
  const t = await open();
  try {
    assert.match(t.frame(), /\/ filter · ↑↓ move · enter or → choose · esc close/);
    await t.press("/");
    assert.match(t.frame(), /\/ ▏/);
    assert.match(t.frame(), /esc clears/);
    assert.doesNotMatch(t.frame(), /\/ filter/);
    await t.press(..."haiku");
    const frame = t.frame();
    assert.match(frame, /\/ haiku▏/);
    assert.match(frame, /REPLIES/);
    assert.match(frame, /Model/);
    for (const gone of ["CONTROL", "VOICE", "LISTENING", "LOGS", "Microphone", "Keep logs"]) assert.doesNotMatch(frame, new RegExp(gone), gone);
    assert.match(chosenLine(frame) ?? "", /Model/, "the first match is chosen");
    assert.deepEqual(t.acts, []);
  } finally {
    t.done();
  }
});

test("nothing matches: a quiet line says so, no sections, and Enter does nothing", async () => {
  const t = await open();
  try {
    await t.press("/", ..."zzz");
    const frame = t.frame();
    assert.match(frame, /No settings match “zzz”/);
    for (const gone of ["CONTROL", "VOICE", "REPLIES", "Model"]) assert.doesNotMatch(frame, new RegExp(gone), gone);
    await t.press("\r");
    assert.deepEqual(t.acts, []);
    assert.match(t.frame(), /No settings match “zzz”/);
  } finally {
    t.done();
  }
});

test("Esc clears the filter (the whole list, on the setting chosen); Esc again closes settings", async () => {
  const t = await open();
  try {
    await t.press("/", ..."keep");
    assert.match(chosenLine(t.frame()) ?? "", /Keep logs/);
    await t.esc({ frame: (f) => !f.includes("/ keep") }, "the filter cleared");
    const frame = t.frame();
    assert.doesNotMatch(frame, /\/ keep/);
    assert.match(frame, /CONTROL/);
    assert.match(frame, /Microphone/);
    assert.match(chosenLine(frame) ?? "", /Keep logs/, "still on the setting it found");
    assert.deepEqual(t.acts, [], "the first Esc only clears the filter");
    await t.esc({ acts: 1 }, "settings closed");
    assert.deepEqual(t.acts, [{ type: "closeSettings" }]);
  } finally {
    t.done();
  }
});

test("while the filter is typed into, no setting's key fires (q, s, j, k); Backspace edits it, and on an empty filter closes it", async () => {
  const t = await open();
  try {
    await t.press("/");
    const before = chosenLine(t.frame());
    await t.press(..."qsjk");
    assert.match(t.frame(), /\/ qsjk▏/);
    assert.deepEqual(t.acts, [], "q and s don't close settings");
    await t.press(BACKSPACE, BACKSPACE, BACKSPACE, BACKSPACE);
    assert.match(t.frame(), /\/ ▏/);
    assert.equal(chosenLine(t.frame()), before, "j and k didn't move it");
    await t.press(BACKSPACE);
    assert.doesNotMatch(t.frame(), /\/ ▏/);
    assert.match(t.frame(), /\/ filter/);
    assert.deepEqual(t.acts, []);
    // Closed: the keys are the settings' again.
    await t.press("q");
    assert.deepEqual(t.acts, [{ type: "closeSettings" }]);
  } finally {
    t.done();
  }
});

test("↑↓ move among the matches; Enter opens the one chosen", async () => {
  const t = await open(80); // narrow: the options take the whole screen, under the setting's name
  try {
    await t.press("/", ..."voice");
    assert.match(chosenLine(t.frame()) ?? "", /Voice can/);
    await t.press(DOWN);
    assert.match(chosenLine(t.frame()) ?? "", /Voice engine/);
    await t.press(DOWN, DOWN, DOWN, DOWN);
    assert.match(chosenLine(t.frame()) ?? "", /Voice\s+Samantha/, "no further than the last match");
    await t.press("\r");
    assert.match(t.frame(), /Settings › Voice\b/);
  } finally {
    t.done();
  }
});

test("a setting opened from the filter: / is just a character in its text, and Esc goes back to the filtered list", async () => {
  const t = await open(80);
  try {
    await t.press("/", ..."projects", "\r");
    assert.match(t.frame(), /Settings › Projects folder/);
    // Its options come a frame later (choicesFor is async): down to the last needs them there.
    await untilFrame(t.frame, (f) => f.includes("Type a path…"), "its options");
    await t.press(...Array(10).fill(DOWN), "\r"); // the last option: Type a path…
    await t.press(..."~/code/a/b");
    assert.match(t.frame(), /~\/code\/a\/b▏/);
    await t.press("\r");
    assert.deepEqual(t.acts, [{ type: "set", key: "projectsRoot", value: "~/code/a/b" }]);
    // Back on the list, still filtered.
    assert.match(t.frame(), /\/ projects▏/);
    assert.doesNotMatch(t.frame(), /VOICE/);
  } finally {
    t.done();
  }
});

test("Settings → Account (accounts open): found by its section, its name and who's signed in; none without its row", () => {
  const account: SettingRow = { key: "account", label: "Kiko account", value: "name@example.com", raw: "{}", restart: false };
  const rows = [...ROWS, account];
  const find = (q: string) => filterSettings(rows, q).map((g) => [g.title, g.rows.map((r) => r.key)]);
  assert.deepEqual(find("account"), [["Account", ["account"]]]);
  assert.deepEqual(find("name@example"), [["Account", ["account"]]]);
  assert.ok(find("kiko acc").some(([title]) => title === "Account"));
  // Accounts not open: no row, so no section and nothing found.
  assert.ok(!filterSettings(ROWS, null).some((g) => g.title === "Account"));
  assert.deepEqual(sections("account"), []);
});

test("Settings → Account's options: sign out (asking again with a phone paired), or Sign in signed out", () => {
  assert.deepEqual(
    accountChoices({ signedIn: false, confirming: false, phones: 0 }).map((c) => c.value),
    ["signin", "keep"],
  );
  // Signing in: Open the browser while its code shows, then Copy the code (while the code shows, and only then) and Stop.
  assert.deepEqual(
    accountChoices({ signedIn: false, confirming: false, phones: 0, signing: "code" }).map((c) => c.value),
    ["open", "copy", "stop"],
  );
  assert.deepEqual(
    accountChoices({ signedIn: false, confirming: false, phones: 0, signing: "code" }).find((c) => c.value === "copy"),
    { value: "copy", label: "Copy the code", hint: "to paste in the browser" },
  );
  assert.deepEqual(
    accountChoices({ signedIn: false, confirming: false, phones: 0, signing: "waiting" }).map((c) => c.value),
    ["copy", "stop"],
  );
  // No code shown (asking for one, signed out, signed in): nothing to copy.
  assert.deepEqual(
    accountChoices({ signedIn: false, confirming: false, phones: 0, signing: "starting" }).map((c) => c.value),
    ["stop"],
  );
  for (const row of [
    { signedIn: false, confirming: false, phones: 0 },
    { signedIn: true, confirming: false, phones: 0 },
    { signedIn: true, confirming: true, phones: 1 },
    { signedIn: true, confirming: false, phones: 0, billing: true },
  ])
    assert.ok(!accountChoices(row).some((c) => c.value === "copy"), JSON.stringify(row));
  assert.deepEqual(
    accountChoices({ signedIn: true, confirming: false, phones: 0 }).map((c) => c.label),
    ["Leave it", "Sign out on this Mac"],
  );
  assert.match(accountChoices({ signedIn: true, confirming: false, phones: 1 })[1].hint ?? "", /asks first: a phone is paired/);
  const confirm = accountChoices({ signedIn: true, confirming: true, phones: 1 });
  assert.deepEqual(
    confirm.map((c) => c.label),
    ["Sign out anyway", "Stay signed in"],
  );
  // What signing out does is in the pane above them (accountFacts), not in a hint.
  assert.equal(confirm[0].hint, undefined);
  assert.equal(accountChoices({ signedIn: true, confirming: false, phones: 0 })[1].hint, "other Macs stay signed in");
  assert.equal(accountChoices({ signedIn: true, confirming: false, phones: 0, billing: true })[1].hint, "card, invoices, cancelling · opens your browser");
});

test("the settings screen (tui.ts): Ctrl+C puts quitting's hint in the footer, and the settings' keys wait; Ctrl+C or q again quits, another key only lets it go; typed into the filter, q is a letter", async () => {
  const acts: Action[] = [];
  const act = ui.act;
  ui.act = (a: Action) => void acts.push(a);
  const was = { screen: ui.state.screen, settings: ui.state.settings };
  ui.set({ screen: "settings", settings: ROWS });
  let frame = "";
  const out = new Writable({ write: (chunk, _enc, done) => (chunk.toString().trim() ? (frame = plain(chunk.toString())) : null, done()) }) as Writable & { columns: number; rows: number };
  out.columns = 120;
  out.rows = 40;
  const stdin = keyboard();
  const app = render(React.createElement(SettingsScreen), { stdout: out as never, stdin: stdin as never, patchConsole: false, interactive: true, exitOnCtrlC: false });
  const press = (...keys: string[]) => typeKeys(app, stdin, ...keys);
  const HINT = "Press Ctrl+C again to quit · your sessions keep running";
  try {
    await untilFrame(
      () => frame,
      (f) => f.includes("Voice can"),
      "the settings",
    );
    await press("\x03");
    assert.ok(frame.includes(HINT), frame);
    assert.deepEqual(acts, []);
    // s would close settings: here it only lets the hint go.
    await press("s");
    assert.deepEqual(acts, []);
    assert.ok(!frame.includes(HINT), frame);
    await press("\x03", "\x03");
    assert.deepEqual(acts, [{ type: "quit" }]);
    acts.length = 0;
    await press("\x03", "q");
    assert.deepEqual(acts, [{ type: "quit" }], "q after Ctrl+C quits, never closes settings");
    acts.length = 0;
    // The filter: q is a letter; Ctrl+C still asks, and the key that lets it go isn't typed.
    await press("/", "q");
    assert.match(frame, /\/ q▏/);
    assert.deepEqual(acts, []);
    await press("\x03");
    assert.ok(frame.includes(HINT), frame);
    await press("x");
    assert.match(frame, /\/ q▏/, "x let it go, typed nothing");
    assert.deepEqual(acts, []);
  } finally {
    app.unmount();
    ui.act = act;
    ui.set(was);
  }
});
