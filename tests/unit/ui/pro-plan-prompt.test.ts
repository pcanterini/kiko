// `kiko upgrade`'s plan question (src/ui/onboarding.ts askProPlan): setup's prompt, in setup's look
// (◆ the question, ● / ○ the plans, ◇ once answered), its keys decoded as setup's are, so Esc takes
// as long as there; Esc is none, said dim right under it as setup's skipped step is. Fake streams
// only: no terminal is touched.
import "../../setup.ts";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { describe, test } from "node:test";
import { COMMAND } from "../../../src/core/name.ts";
import { ESCAPE_MS } from "../../../src/ui/live.ts";
import { askProPlan } from "../../../src/ui/onboarding.ts";

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ESC = "\x1b";
const DOWN = "\x1b[B";
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

function io() {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (on: boolean) => void };
  input.isTTY = true;
  const raw: boolean[] = [];
  input.setRawMode = (on) => void raw.push(on);
  let drawn = "";
  const output = new Writable({ write: (chunk, _enc, done) => ((drawn += String(chunk)), done()) }) as Writable & { columns: number; isTTY: boolean };
  output.columns = 80;
  output.isTTY = true;
  return { input, output, raw, text: () => strip(drawn) };
}

describe("kiko upgrade's plan question", () => {
  test("setup's look: the question, what's included under it, the terms subscribing accepts, monthly picked first; Enter takes it", async () => {
    const t = io();
    const asked = askProPlan(t);
    await settle(20);
    assert.match(
      t.text(),
      /◆ {2}Which Kiko Pro plan\?\n│ {2}Kiko's AI included · tax included\n│ {2}By subscribing, you agree to the Terms, including Kiko Pro's: kiko\.sh\/terms\n│ {2}● \$8\.99 a month\n│ {2}○ \$89 a year \(about 2 months free\)/,
    );
    assert.doesNotMatch(t.text(), /Use arrows to move|^\? /m, "not the inquirer-style prompt");
    t.input.write("\r");
    assert.equal(await asked, "month");
    assert.match(t.text(), /◇ {2}Which Kiko Pro plan\?[\s\S]*│ {2}\$8\.99 a month/, "answered, it stays as a line");
  });

  test("the arrow keys move: the yearly plan", async () => {
    const t = io();
    const asked = askProPlan(t);
    await settle(20);
    t.input.write(DOWN);
    await settle(20);
    t.input.write("\r");
    assert.equal(await asked, "year");
  });

  test("Esc: none, in setup's time, and said dim under it with how to come back", async () => {
    const t = io();
    const asked = askProPlan(t);
    await settle(20);
    const at = performance.now();
    t.input.write(ESC);
    assert.equal(await asked, null);
    assert.ok(performance.now() - at < ESCAPE_MS + 200, "not readline's half second");
    assert.match(t.text(), /■ {2}Which Kiko Pro plan\?/);
    assert.match(t.text(), new RegExp(`│ {2}Nothing changed: ${COMMAND} upgrade asks again\\.`));
    assert.equal(t.raw.at(-1), false, "the terminal out of raw mode after");
  });
});
