// The voice glow (src/ui/window-glow.ts) on the app's real state: the window's list (src/ui/window-list.ts,
// the tiled look) drawn by Ink as the app's state changes, the talk key pressed and the stub mic giving loud
// chunks. Its rows rise above the list's keys while you talk and are gone, its loop stopped, once it has
// faded out after; with the setting off, none.

import assert from "node:assert/strict";
import { begin, T, ui, until, wait } from "../driver.ts";

export async function glowCases() {
  const { Writable, PassThrough } = await import("node:stream");
  const React = (await import("react")).default;
  const { render } = await import("ink");
  const { WindowList } = await import("../../../src/ui/window-list.ts");
  const { runningGlows } = await import("../../../src/ui/window-glow.ts");
  const { plain } = await import("../../support/ink.ts");
  const h = React.createElement;

  /** The list as the app's state goes, 36 × 30, its frames kept: `frame()` the last, plain. */
  function drawn() {
    let text = "";
    const stdout = Object.assign(new Writable({ write: (chunk, _enc, done) => ((text += chunk.toString()), done()) }), { columns: 36, rows: 30, isTTY: true });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    function Live() {
      const [s, set] = React.useState(ui.state);
      React.useEffect(() => {
        const follow = (next: typeof ui.state) => set(next);
        ui.on("change", follow);
        return () => void ui.off("change", follow);
      }, []);
      return h(WindowList, { s: { ...s, sessionsLoaded: true, window: { shown: null, note: "", ...s.window } } });
    }
    const app = render(h(Live), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, interactive: true });
    const FRAME_START = /\u001b\[2J|\u001b\[1;1H\u001b\[J|(?:\u001b\[2K\u001b\[1A)*\u001b\[2K\u001b\[G/;
    return { app, frame: () => plain(text.split(FRAME_START).at(-1) ?? text) };
  }
  const glowRows = (frame: string) => frame.split("\n").filter((l) => /[⠁-⣿]/.test(l));
  /** The key held while the mic gives loud chunks, until `done` (or a second and a half): then let go. */
  async function talkLoud(done: () => boolean) {
    T.heard = "";
    T.hotkey.onDown();
    await until(() => T.micOpen, 1000);
    for (let i = 0; i < 50 && !done(); i++) {
      T.mic(Buffer.alloc(3200, 0x40));
      await wait(30);
    }
    await T.hotkey.onUp();
  }

  begin("the voice glow: rises above the list's keys while you talk, from the mic's level; gone, its loop stopped, after");
  await wait(2100); // windows from the case before run out
  assert.equal(ui.state.voiceGlow, true, "on unless turned off");
  const list = drawn();
  try {
    await wait(300);
    assert.equal(runningGlows(), 0, "nothing runs while nobody talks");
    assert.deepEqual(glowRows(list.frame()), []);
    let seen: string[] = [];
    let level = 0;
    await talkLoud(() => {
      level = Math.max(level, ui.state.level);
      seen = glowRows(list.frame());
      return seen.length >= 2;
    });
    assert.ok(seen.length >= 2, `the glow while talking:\n${list.frame()}`);
    assert.ok(level > 0.5, `the mic's level (${level})`);
    const lines = list.frame().split("\n");
    const keys = lines.findIndex((l) => l.includes("c new"));
    assert.ok(
      lines.every((l, i) => !/[⠁-⣿]/.test(l) || (i < keys && i >= keys - 3)),
      `just above the keys:\n${list.frame()}`,
    );
    await until(() => runningGlows() === 0 && !ui.state.listening && !ui.state.deciding && !ui.state.speaking, 4000);
    await wait(100);
    assert.deepEqual(glowRows(list.frame()), [], `gone after:\n${list.frame()}`);
    console.log(`ok: ${seen.length} rows while talking (mic level ${level.toFixed(2)}), none after, no loop running`);

    begin("the voice glow: none with the setting off");
    ui.act({ type: "set", key: "voiceGlow", value: false });
    assert.equal(ui.state.voiceGlow, false);
    await talkLoud(() => false);
    assert.deepEqual(glowRows(list.frame()), []);
    assert.equal(runningGlows(), 0);
    ui.act({ type: "set", key: "voiceGlow", value: true });
    assert.equal(ui.state.settings.find((r) => r.key === "voiceGlow")?.value, "On");
    console.log("ok");
  } finally {
    list.app.unmount();
  }
  await wait(1700);
}
