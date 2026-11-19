// Settings → Phone → Pair a phone without Kiko Pro or the trial, as drawn (ui/settings.ts,
// ui/pair-phone.ts): the PRO badge after its value, the offer's words and its choices (the trial
// first while it can start), a pick sent to the app, then the pairing screen's steps (the sign-in's
// code, the payment waited for, why it didn't go) with Esc closing them. With the plan: no badge.
// Every wait is for something to be so (a frame drawn, an action asked for: tests/support/ink.ts),
// never a fixed time.
import "../../setup.ts";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import { render } from "ink";
import React from "react";
import { PHONE_WORDS } from "../../../src/core/account/phone-plan.ts";
import { ui, type Action, type SettingRow } from "../../../src/core/ui-store.ts";
import { Settings } from "../../../src/ui/settings.ts";
import { inkDone, keyboard, plain, typeKeys, untilFrame } from "../../support/ink.ts";
import { checkWaits } from "../../support/until.ts";

const until = checkWaits(5000);

function screen() {
  let frames = "";
  let last = "";
  const out = new Writable({
    write: (chunk, _enc, done) => {
      frames += chunk.toString();
      if (chunk.toString().trim()) last = chunk.toString();
      done();
    },
  }) as Writable & { columns: number; rows: number };
  out.columns = 120;
  out.rows = 30;
  return { out, all: () => plain(frames), last: () => plain(last), clear: () => void (frames = "") };
}

const offerRow: SettingRow = {
  key: "phonePair",
  label: "Pair a phone",
  raw: JSON.stringify({ offer: true, trial: true }),
  value: "With Kiko Pro or the free trial",
  tag: PHONE_WORDS.badge,
  note: PHONE_WORDS.offer,
  restart: false,
};

test("without the plan: PRO after the value, the offer and its choices; a pick goes to the app; the pairing screen's steps, Esc closes", async () => {
  const acts: Action[] = [];
  const act = ui.act;
  ui.act = (a: Action) => void acts.push(a);
  const stdin = keyboard();
  const sc = screen();
  try {
    const s = { ...ui.state, screen: "settings" as const, settings: [{ key: "phone" as const, label: "Phone", raw: true, value: "On (0 connected)", restart: false }, offerRow] };
    const app = render(React.createElement(Settings, { s, width: 120, height: 30 }), { stdout: sc.out as never, stdin: stdin as never, patchConsole: false, interactive: true });
    await inkDone(app);
    stdin.write("\x1b[B"); // down to Pair a phone
    // Its options come a frame after its pane (choicesFor is async).
    await untilFrame(sc.last, (f) => f.includes("Start the free trial"), "Pair a phone's options");
    assert.match(sc.all(), /Pair a phone\s+With Kiko Pro or the free trial PRO/);
    assert.match(sc.all(), /The iPhone app comes with Kiko Pro: \$8\.99 a month/, "the offer, in its pane");
    await typeKeys(app, stdin, "\r");
    const opened = sc.all().replace(/\s+/g, " ");
    for (const label of ["Start the free trial (7 days, no card)", "Kiko Pro, monthly", "$8.99 a month", "Kiko Pro, yearly", "$89 a year"]) assert.ok(opened.includes(label), label);
    stdin.write("\r");
    await until(() => acts.length, "the pick sent to the app");
    assert.deepEqual(acts, [{ type: "set", key: "phonePair", value: "trial", label: "Start the free trial (7 days, no card)" }]);

    // The pairing screen: signing in, with its code; Esc closes.
    sc.clear();
    app.rerender(
      React.createElement(Settings, {
        s: { ...s, pairQr: { phase: "plan", step: "sign-in", code: "WDJB-MJHT", url: "https://account.kiko.sh/device?user_code=WDJB-MJHT", opened: true } },
        width: 120,
        height: 30,
      }),
    );
    await untilFrame(sc.all, (f) => /Sign in to your Kiko account first/.test(f), "the sign-in step");
    assert.match(sc.all(), /Sign in to your Kiko account first/);
    assert.match(sc.all(), /Check this code in the browser: WDJB-MJHT/);
    assert.match(sc.all(), /Opened account\.kiko\.sh\/device in your browser/);
    sc.clear();
    app.rerender(React.createElement(Settings, { s: { ...s, pairQr: { phase: "plan", step: "waiting", url: "https://checkout.stripe.com/c/pay/x" } }, width: 120, height: 30 }));
    await untilFrame(sc.all, (f) => /Waiting for payment…/.test(f), "the payment step");
    assert.match(sc.all(), /Waiting for payment…/);
    assert.match(sc.all(), /The QR code to pair your phone comes up as soon as it's through\./);
    sc.clear();
    app.rerender(React.createElement(Settings, { s: { ...s, pairQr: { phase: "plan", step: "failed", line: "name@example.com has already used its free trial." } }, width: 120, height: 30 }));
    await untilFrame(sc.all, (f) => /has already used its free trial/.test(f), "why it didn't go");
    assert.match(sc.all(), /has already used its free trial/);
    acts.length = 0;
    stdin.write("\x1b");
    await until(() => acts.length, "Esc's act");
    assert.deepEqual(acts, [{ type: "set", key: "phonePair", value: "close" }]);
    app.unmount();
  } finally {
    ui.act = act;
  }
});

test("with the plan: no badge, the QR code", async () => {
  const sc = screen();
  const s = { ...ui.state, screen: "settings" as const, settings: [{ key: "phonePair" as const, label: "Pair a phone", raw: "", value: "QR code", restart: false }] };
  const app = render(React.createElement(Settings, { s, width: 120, height: 30 }), { stdout: sc.out as never, stdin: keyboard() as never, patchConsole: false, interactive: true });
  // Drawn through: its pane's option too (it comes a frame later: choicesFor is async).
  await untilFrame(sc.last, (f) => f.includes("Show the QR code"), "the row's option");
  assert.match(sc.all(), /Pair a phone\s+QR code/);
  assert.doesNotMatch(sc.all(), /PRO/);
  app.unmount();
});
