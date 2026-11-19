// The settings screen (src/ui/settings.ts) rendered for real with Ink. React warns on every render
// when two children share a key, and the TUI shows warnings as lines, which re-render the screen:
// on 2026-10-28 that froze the app as soon as "Test microphone" was highlighted. Every wait is for
// something to be so (a frame drawn, an action asked for: tests/support/ink.ts), never a fixed time.
import "../../setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import React from "react";
import { render } from "ink";
import { Settings } from "../../../src/ui/settings.ts";
import { ui, type Action } from "../../../src/core/ui-store.ts";
import { encodeQr } from "../../../src/core/qr.ts";
import { inkDone, keyboard, plain, typeKeys, untilFrame } from "../../support/ink.ts";
import { checkWaits } from "../../support/until.ts";

const until = checkWaits(5000);

/** A screen 120 wide: `frame()` the last frame drawn, plain (each frame as it's drawn: Ink's interactive mode). */
function screen() {
  let last = "";
  const out = new Writable({ write: (chunk, _enc, done) => (chunk.toString().trim() ? (last = chunk.toString()) : null, done()) }) as Writable & { columns: number; rows: number };
  out.columns = 120;
  out.rows = 40;
  return Object.assign(out, { frame: () => plain(last) });
}

test("Test microphone highlighted: no duplicate keys", async () => {
  const warnings: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  try {
    const s = { ...ui.state, settings: [{ key: "micTest" as const, label: "Test microphone", raw: "", value: "5 seconds", restart: false }] };
    const out = screen();
    const app = render(React.createElement(Settings, { s, width: 120, height: 30 }), { stdout: out as never, stdin: keyboard() as never, patchConsole: false, interactive: true });
    // Its options load, then it renders again.
    await untilFrame(out.frame, (f) => f.includes("Start the test"), "its options").finally(() => app.unmount());
  } finally {
    console.error = error;
  }
  assert.deepEqual(
    warnings.filter((w) => w.includes("same key")),
    [],
  );
});

test("Pronunciation highlighted: its list renders, no duplicate keys", async () => {
  const warnings: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  try {
    const s = { ...ui.state, settings: [{ key: "pronunciation" as const, label: "Pronunciation", raw: "[]", value: "0 yours · 119 built in", restart: false }] };
    const out = screen();
    const app = render(React.createElement(Settings, { s, width: 120, height: 30 }), { stdout: out as never, stdin: keyboard() as never, patchConsole: false, interactive: true });
    await untilFrame(out.frame, (f) => f.includes("Add a word…"), "its list").finally(() => app.unmount());
  } finally {
    console.error = error;
  }
  assert.deepEqual(
    warnings.filter((w) => w.includes("same key")),
    [],
  );
});

/** The option the cursor is on in the right-hand pane (120 columns), as drawn; undefined while the list has it. */
const picked = (frame: string) =>
  frame
    .split("\n")
    .map((l) => l.split("│"))
    .filter((parts) => parts.length === 4)
    .map((parts) => parts[2])
    .find((l) => l.includes("▸"));

for (const o of [
  { row: { key: "tts" as const, label: "Voice engine", raw: "say", value: "macOS voice" }, up: 2, id: "cartesia", value: "cartesia", name: "Cartesia", pick: "Cartesia" },
  {
    row: { key: "llm" as const, label: "Model", raw: "haiku", value: "Claude Haiku 5.5" },
    down: 1,
    id: "openrouter",
    value: "deepseek/deepseek-v4.1-flash",
    name: "OpenRouter",
    pick: "DeepSeek V4.1 Flash",
  },
]) {
  test(`${o.row.label}: an option whose key is missing is marked, picking it asks for the key, Esc leaves the setting as it was`, async () => {
    // No Cartesia or OpenRouter key in the tests' environment (tests/setup.ts).
    const acts: Action[] = [];
    const act = ui.act;
    ui.act = (a: Action) => void acts.push(a);
    let shown = "";
    let last = "";
    const out = new Writable({ write: (chunk, _enc, done) => ((shown += chunk.toString()), chunk.toString().trim() ? (last = chunk.toString()) : null, done()) }) as Writable & {
      columns: number;
      rows: number;
    };
    const frame = () => plain(last);
    const asking = new RegExp(`needs your ${o.name} key`);
    out.columns = 120;
    out.rows = 40;
    const stdin = keyboard();
    try {
      const s = { ...ui.state, screen: "settings" as const, settings: [{ ...o.row, restart: false }] };
      const app = render(React.createElement(Settings, { s, width: 120, height: 30 }), { stdout: out as never, stdin: stdin as never, patchConsole: false, interactive: true });
      const marked = new RegExp(`${o.pick} · needs a key`);
      await untilFrame(frame, (f) => marked.test(f), "its options, the one without a key marked");
      assert.match(shown, marked);
      // Into the options, on the current one; then up or down to the one without a key.
      stdin.write("\r");
      await untilFrame(frame, (f) => Boolean(picked(f)?.includes(o.row.value)), `the cursor on ${o.row.value}`);
      await typeKeys(app, stdin, ...Array<string>(o.up ?? o.down).fill(o.up ? "\x1b[A" : "\x1b[B"));
      await untilFrame(frame, (f) => Boolean(picked(f)?.includes(o.pick)), `the cursor on ${o.pick}`);
      stdin.write("\r");
      await untilFrame(frame, (f) => asking.test(f), "asked for the key");
      assert.match(shown, asking);
      stdin.write("\x1b"); // Esc: no key, nothing set
      await untilFrame(frame, (f) => !asking.test(f), "the question gone");
      await typeKeys(app, stdin, "x");
      assert.deepEqual(acts, [], "cancelled: the setting stays as it was");

      stdin.write("\r");
      await untilFrame(frame, (f) => asking.test(f), "asked for the key again");
      await typeKeys(app, stdin, "test-key-0000aaaa");
      stdin.write("\r");
      await until(() => acts.length, "the key sent to the app");
      assert.deepEqual(acts, [{ type: "apiKey", id: o.id, key: "test-key-0000aaaa", then: { key: o.row.key, value: o.value, label: o.value === "cartesia" ? "Cartesia" : "DeepSeek V4.1 Flash" } }]);
      assert.doesNotMatch(shown, /test-key-0000aaaa/, "the key is never drawn");
      app.unmount();
    } finally {
      ui.act = act;
    }
  });
}

test("Pair a phone: Enter on its row shows the QR code; while it's up only Esc does anything, and it closes it", async () => {
  const acts: Action[] = [];
  const act = ui.act;
  ui.act = (a: Action) => void acts.push(a);
  const warnings: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  const stdin = keyboard();
  try {
    const rows = [{ key: "phonePair" as const, label: "Pair a phone", raw: "", value: "QR code", restart: false }];
    const s = { ...ui.state, screen: "settings" as const, settings: rows };
    const out = screen();
    const app = render(React.createElement(Settings, { s, width: 120, height: 50 }), { stdout: out as never, stdin: stdin as never, patchConsole: false, interactive: true });
    await inkDone(app);
    stdin.write("\r");
    await until(() => acts.length, "Enter's act");
    assert.deepEqual(acts, [{ type: "set", key: "phonePair", value: "open" }]);
    // Up: the code over the whole screen. Keys that would move or pick do nothing.
    const qr = encodeQr("sh.kiko.ios://pair?v=1&n=x&h=192.168.1.20&p=7333&s=AAAAAAAAAAAAAAAAAAAAAA&k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    app.rerender(React.createElement(Settings, { s: { ...s, pairQr: { phase: "showing", qr, code: "482913", until: Date.now() + 300_000 } }, width: 120, height: 50 }));
    await untilFrame(out.frame, (f) => f.includes("Settings › Pair a phone"), "the QR code up");
    acts.length = 0;
    await typeKeys(app, stdin, "\r", "\x1b[B", "j", "s");
    assert.deepEqual(acts, []);
    stdin.write("\x1b");
    await until(() => acts.length, "Esc's act");
    assert.deepEqual(acts, [{ type: "set", key: "phonePair", value: "close" }]);
    // A phone paired: said, and Esc still closes it.
    app.rerender(React.createElement(Settings, { s: { ...s, pairQr: { phase: "paired", phone: "Alex's iPhone" } }, width: 120, height: 50 }));
    await untilFrame(out.frame, (f) => f.includes("Alex's iPhone"), "the phone paired, said");
    app.unmount();
  } finally {
    ui.act = act;
    console.error = error;
  }
  assert.deepEqual(
    warnings.filter((w) => w.includes("same key")),
    [],
  );
});
