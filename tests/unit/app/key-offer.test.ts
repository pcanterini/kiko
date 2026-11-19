// The trial's end made actionable (src/app/key-offer.ts, core/account/plan-words.ts KeyOffer): the
// words in the window, said and on the phone; the window's key (e, in the list and the Ctrl+Space
// menu) opening Settings → Keys → OpenRouter with its paste open; and once a key is saved, the next
// call going through it with nothing restarted, the offer gone and "Key saved…" said. A fake
// account server and proxy on 127.0.0.1 (tests/support/), a store in memory for the Keychain, and a
// fake fetch for OpenRouter and the key's check: no real Keychain, network or tmux.
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, test } from "node:test";
import React from "react";
import { render } from "ink";
import { KeyOffers } from "../../../src/app/key-offer.ts";
import { Account, SESSION_KEY } from "../../../src/core/account/account.ts";
import { accountClient } from "../../../src/core/account/client.ts";
import { ADD_KEY_KEY, KEY_BACK_LINE, refusalNotice, reminderNotice } from "../../../src/core/account/plan-words.ts";
import { heldKeys, holdKey } from "../../../src/core/key-values.ts";
import { KeySettings, type KeyFetch } from "../../../src/core/keys.ts";
import { AccountAiError, ModelCalls } from "../../../src/core/model-route.ts";
import { COMMAND } from "../../../src/core/name.ts";
import { ui, type Action, type Line, type SettingRow, type UiState } from "../../../src/core/ui-store.ts";
import { Teller } from "../../../src/remote/tell.ts";
import { windowMenu } from "../../../src/ui/nav.ts";
import { windowEvents } from "../../../src/ui/input.ts";
import { Settings } from "../../../src/ui/settings.ts";
import { WindowList } from "../../../src/ui/window-list.ts";
import { fakeAccountServer, fakeJwt, happyScript, memoryStore, planJson, SESSION_TOKEN, sessionAnswer } from "../../support/fake-account.ts";
import { fakeProxy, proxyError, streamAnswer } from "../../support/fake-proxy.ts";
import { inkDone, keyboard, plain, typeKeys, untilFrame } from "../../support/ink.ts";
import { checkWaits } from "../../support/until.ts";

const until = checkWaits(5000, 10);
const FAKE_OR = "sk-or-test-0000000000000000aaaa";
const PRESS = "press E in the Kiko window's list";

const closers: (() => Promise<void>)[] = [];
const env = { accounts: process.env.KIKO_ACCOUNTS, pro: process.env.KIKO_PRO };
beforeEach(() => ui.set({ keyOffer: null, screen: "main", settingsAt: null, settingsPaste: false }));
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  delete heldKeys.OPENROUTER_API_KEY;
  for (const [name, value] of [
    ["KIKO_ACCOUNTS", env.accounts],
    ["KIKO_PRO", env.pro],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** What the offers showed and said (and the phone's words for it), and the settings screen closed. */
function offersFor(o: { window?: boolean } = {}) {
  const shown: string[] = [];
  const said: Array<{ text: string; phone?: string }> = [];
  let closed = 0;
  const offers = new KeyOffers({
    show: (line) => void shown.push(line),
    say: (text, phone) => void said.push(phone ? { text, phone } : { text }),
    window: () => o.window ?? true,
    closeSettings: () => (closed++, ui.set({ screen: "main", settingsPaste: false })),
  });
  return { offers, shown, said, closed: () => closed };
}

describe("the words", () => {
  test("the trial ended: in the window, the key to press and Settings → Keys; said, the window's list; on the phone, on your Mac; the command kept for where there's no window", () => {
    const n = refusalNotice("trial_ended")!;
    assert.equal(
      n.offer?.line,
      "Your free trial has ended: Kiko's AI is paused. Press e in the list to add your own OpenRouter key (free; get one at openrouter.ai/keys), or Settings → Keys. Kiko Pro is coming.",
    );
    assert.equal(n.offer?.spoken, `Your free trial has ended. To keep going, add your own OpenRouter key: ${PRESS}.`);
    assert.equal(n.offer?.phone, `Your free trial has ended. Add your own OpenRouter key on your Mac: ${PRESS}.`);
    assert.deepEqual([n.offer?.why, n.offer?.until], ["trial_ended", null]);
    assert.doesNotMatch(n.offer!.line, /keys set/, "no command in the window's line");
    // The phone's never says the key without the Mac.
    assert.match(n.offer!.phone, /on your Mac: press E in the Kiko window/);
    // Without the window (--plain, the CLI's errors): the command, as before.
    assert.equal(n.line, `Your free trial has ended: Kiko's AI calls are paused. To go on: ${COMMAND} keys set openrouter, your own key (free). Kiko Pro is coming.`);
    assert.equal(n.spoken, "Your free trial has ended. Add your own OpenRouter key to keep going.");
    assert.match(refusalNotice("trial_ended", { endedWhy: "cap" })!.offer!.line, /^Your free trial has ended \(its usage is used up\): Kiko's AI is paused\. Press e/);
  });

  test("while Pro is on sale, the window's line keeps kiko upgrade; never said aloud", () => {
    process.env.KIKO_ACCOUNTS = "1";
    process.env.KIKO_PRO = "1";
    const n = refusalNotice("trial_ended")!;
    assert.match(n.offer!.line, new RegExp(`or Settings → Keys\\. Or get Kiko Pro: ${COMMAND} upgrade\\.$`));
    assert.doesNotMatch(`${n.offer!.spoken} ${n.offer!.phone}`, /upgrade/i);
  });

  test("today's share used: the key offered on screen, the cap's words otherwise as they were; said as before", () => {
    const resetsAt = Date.now() + 3 * 3_600_000;
    const n = refusalNotice("daily_cap", { resetsAt })!;
    assert.equal(n.offer?.line, n.line.replace(`Or add your own key: ${COMMAND} keys set openrouter.`, "Or press e in the list to add your own OpenRouter key."));
    assert.notEqual(n.offer?.line, n.line);
    assert.equal(n.offer?.spoken, n.spoken);
    assert.equal(n.offer?.phone, n.spoken);
    assert.match(n.spoken, /^Today's share of your free trial is used up\. It's back at \d\d:\d\d\.$/);
    assert.deepEqual([n.offer?.why, n.offer?.until], ["daily_cap", resetsAt]);
  });

  test("the reminder that the trial's almost used up names Settings → Keys beside the command", () => {
    const now = Date.UTC(2026, 10, 20, 12);
    const plan = { name: "trial" as const, startedAt: now - 86_400_000, endsAt: now + 5 * 86_400_000, quota: { usedShare: 0.85 } } as never;
    const n = reminderNotice(plan, now)!;
    assert.equal(n.line, `Your free trial is almost used up (85%). Then: your own OpenRouter key (Settings → Keys, or ${COMMAND} keys set openrouter), free forever with no account.`);
    assert.equal(n.offer, undefined, "a reminder offers nothing: the AI still runs");
  });
});

describe("the offer", () => {
  test("in the window: its line shown, its words said with the phone's, and it stands; without one, the command and nothing offered", () => {
    const w = offersFor();
    const n = refusalNotice("trial_ended")!;
    w.offers.notice(n);
    assert.deepEqual(w.shown, [`(${n.offer!.line})`]);
    assert.deepEqual(w.said, [{ text: n.offer!.spoken, phone: n.offer!.phone }]);
    assert.deepEqual(ui.state.keyOffer, { why: "trial_ended", until: null });

    ui.set({ keyOffer: null });
    const p = offersFor({ window: false });
    p.offers.notice(n);
    assert.deepEqual(p.shown, [`(${n.line})`]);
    assert.deepEqual(p.said, [{ text: n.spoken }]);
    assert.equal(ui.state.keyOffer, null);
  });

  test("today's share: the phone hears what's said (no key in it); the offer goes by itself when the share is back, or never stands past it", async () => {
    const w = offersFor();
    w.offers.notice(refusalNotice("daily_cap", { resetsAt: Date.now() + 80 })!);
    assert.deepEqual(
      w.said.map((x) => x.phone),
      [undefined],
    );
    assert.equal(ui.state.keyOffer?.why, "daily_cap");
    await until(() => ui.state.keyOffer === null, "let go at its time");
    w.offers.notice(refusalNotice("daily_cap", { resetsAt: Date.now() - 1000 })!);
    assert.equal(ui.state.keyOffer, null);
  });

  test("a call the plan runs again (Pro bought, the share back): let go quietly", () => {
    const w = offersFor();
    w.offers.notice(refusalNotice("trial_ended")!);
    w.offers.planBack();
    assert.equal(ui.state.keyOffer, null);
    assert.equal(w.said.length, 1, "nothing more said");
  });

  test("another key saved, or none offered: nothing said", () => {
    const w = offersFor();
    w.offers.keySaved("openrouter");
    w.offers.notice(refusalNotice("trial_ended")!);
    w.offers.keySaved("cartesia");
    assert.equal(w.said.length, 1);
    assert.ok(ui.state.keyOffer);
  });
});

/** A terminal for Ink: what's drawn, and a keyboard. */
function terminal(columns = 32, rows = 20) {
  let text = "";
  const stdout = new Writable({ write: (chunk, _enc, done) => ((text += chunk.toString()), done()) }) as Writable & { columns: number; rows: number; isTTY: boolean };
  Object.assign(stdout, { columns, rows, isTTY: true });
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(on: boolean): void; ref(): void; unref(): void };
  Object.assign(stdin, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  return { stdout, stdin, all: () => plain(text) };
}

const state = (patch: Partial<UiState>): UiState => ({ ...ui.state, about: { ...ui.state.about, hotkey: "right_option" }, sessionsLoaded: true, window: { shown: null, note: "" }, ...patch });

/** The actions the app is asked for while `run` runs. */
async function actsOf(run: (acts: Action[]) => Promise<void>) {
  const acts: Action[] = [];
  const take = (a: Action) => void acts.push(a);
  ui.on("action", take);
  try {
    await run(acts);
  } finally {
    ui.off("action", take);
  }
  return acts;
}

describe("the window's key", () => {
  test("in the list: the offer's lines at the bottom, and e (or E, or a click on them) opens the paste; without the offer, e does nothing", async () => {
    for (const why of ["trial_ended", "daily_cap"] as const) {
      const t = terminal();
      const app = render(React.createElement(WindowList, { s: state({ keyOffer: { why, until: null } }) }), {
        stdout: t.stdout as never,
        stdin: t.stdin as never,
        patchConsole: false,
        interactive: true,
      });
      try {
        await untilFrame(t.all, (f) => f.includes(`${ADD_KEY_KEY} add your own key`), "the offer's key");
        assert.match(t.all(), why === "trial_ended" ? /Free trial ended: AI paused/ : /Today's trial share used up/);
        const acts = await actsOf(async (acts) => {
          await typeKeys(app, t.stdin, "e");
          await until(() => acts.length, "e's act");
          // Another key between (↓: two of the same quickly would be a held key's repeat), then E.
          await typeKeys(app, t.stdin, "j", "E");
          await until(() => acts.filter((a) => a.type === "addKey").length === 2, "E's act");
          // A click on the key's line (the last but the keys', in a pane 20 rows tall).
          windowEvents.emit("pointer", { x: 4, y: 19, button: "left", press: true });
          await until(() => acts.filter((a) => a.type === "addKey").length === 3, "the click's act");
        });
        assert.deepEqual(
          acts.filter((a) => a.type === "addKey"),
          [{ type: "addKey" }, { type: "addKey" }, { type: "addKey" }],
        );
      } finally {
        app.unmount();
      }
    }
    const t = terminal();
    const app = render(React.createElement(WindowList, { s: state({ keyOffer: null }) }), { stdout: t.stdout as never, stdin: t.stdin as never, patchConsole: false, interactive: true });
    try {
      await inkDone(app);
      assert.doesNotMatch(t.all(), /add your own key/);
      const acts = await actsOf(async () => {
        await typeKeys(app, t.stdin, "e", "E");
      });
      assert.deepEqual(acts, []);
    } finally {
      app.unmount();
    }
  });

  test("in the Ctrl+Space menu: while offered, first among the commands, on the same key, asking the app for the paste", () => {
    const ask = (verb: string, arg = "") => ["ask", verb, arg];
    const offered = windowMenu(state({ keyOffer: { why: "trial_ended", until: null } }), ask);
    const items = offered.items.filter((i) => i !== "-");
    const at = items.findIndex((i) => i.label === "Add your OpenRouter key…");
    assert.ok(at >= 0, "offered");
    const item = items[at] as Exclude<(typeof items)[number], "-">;
    assert.deepEqual([item.key, item.input, item.run], [ADD_KEY_KEY, ["e", "E"], [["ask", "addKey", ""]]]);
    assert.equal(items[at + 1] !== undefined && (items[at + 1] as { key?: string }).key, "Tab", "right before Tab, the first command");
    // No other item takes e.
    assert.deepEqual(
      items.filter((i) => i.input?.includes("e")),
      [item],
    );
    assert.ok(!windowMenu(state({ keyOffer: null }), ask).items.some((i) => i !== "-" && i.label === "Add your OpenRouter key…"));
  });

  test("Settings opened for it: on OpenRouter's row with the paste open at once (hidden), Enter hands the key to the app to check and save", async () => {
    const raw = JSON.stringify({ set: false, source: null, inKeychain: false, unchecked: false, store: true });
    const rows: SettingRow[] = [
      { key: "llm", label: "Model", raw: "haiku", value: "Claude Haiku 5.5", restart: false },
      { key: "key:openrouter", label: "OpenRouter", raw, value: "Not set", restart: false },
    ];
    let last = "";
    let shown = "";
    const out = new Writable({ write: (chunk, _enc, done) => ((shown += chunk.toString()), chunk.toString().trim() ? (last = chunk.toString()) : null, done()) }) as Writable & {
      columns: number;
      rows: number;
    };
    Object.assign(out, { columns: 120, rows: 40 });
    const stdin = keyboard();
    const s = { ...ui.state, screen: "settings" as const, settings: rows, settingsAt: "key:openrouter" as const, settingsPaste: true };
    const acts = await actsOf(async (acts) => {
      const act = ui.act;
      ui.act = (a: Action) => void acts.push(a);
      const app = render(React.createElement(Settings, { s, width: 120, height: 30 }), { stdout: out as never, stdin: stdin as never, patchConsole: false, interactive: true });
      try {
        await untilFrame(
          () => plain(last),
          (f) => f.includes("Your OpenRouter key (paste it; it stays hidden):"),
          "the paste open at once",
        );
        await typeKeys(app, stdin, FAKE_OR);
        stdin.write("\r");
        await until(() => acts.length, "the key sent to the app");
      } finally {
        app.unmount();
        ui.act = act;
      }
    });
    assert.deepEqual(acts, [{ type: "apiKey", id: "openrouter", key: FAKE_OR }]);
    assert.doesNotMatch(shown, new RegExp(FAKE_OR), "the key is never drawn");
  });
});

describe("the phone", () => {
  test("a line said with the phone's words: the phone is told those, not the Mac's", () => {
    const sent: Array<Record<string, unknown>> = [];
    const teller = new Teller({ hub: {} as never, conns: new Set(), send: () => {}, broadcast: (m) => void sent.push(m), macPresence: null, before: () => {} });
    try {
      const n = refusalNotice("trial_ended")!.offer!;
      teller.line({ id: 1, at: 0, kind: "voice", text: n.spoken, phone: n.phone } as Line);
      teller.line({ id: 2, at: 0, kind: "voice", text: KEY_BACK_LINE } as Line);
    } finally {
      teller.stop();
    }
    assert.deepEqual(
      sent.map((m) => m.text),
      [`Your free trial has ended. Add your own OpenRouter key on your Mac: ${PRESS}.`, KEY_BACK_LINE],
    );
  });

  test("ui.voice keeps the phone's words on the line", () => {
    const lines: Line[] = [];
    const take = (l: Line) => void lines.push(l);
    ui.on("line", take);
    try {
      ui.voice("for the Mac", { phone: "for the phone" });
    } finally {
      ui.off("line", take);
    }
    assert.deepEqual([lines[0].text, lines[0].phone], ["for the Mac", "for the phone"]);
  });
});

/** Signed in on the trial (a fake account server), a fake proxy; the app's way of wiring the offers, the key's section and the calls. */
async function signedIn() {
  const server = await fakeAccountServer({
    ...happyScript(),
    session: [sessionAnswer({ plan: planJson() })],
    access: [{ json: { access_token: fakeJwt(1), token_type: "Bearer", expires_in: 600 } }],
  });
  const proxy = await fakeProxy();
  closers.push(server.close, proxy.close);
  const mem = memoryStore({ [SESSION_KEY]: SESSION_TOKEN });
  const account = new Account({ store: mem.store, client: accountClient(server.url), file: join(mkdtempSync(join(tmpdir(), "offer-")), "account.json") });
  assert.equal((await account.check()).state, "signed-in");
  // OpenRouter's answers, and the key's check: faked; the proxy's, the fake one on 127.0.0.1.
  const openrouter: string[] = [];
  const calls = new ModelCalls({
    // ownKey: the app's own (core/key-values.ts keyOf, read at each call).
    account: () => account,
    accountActive: () => true,
    aiUrl: () => proxy.url,
    userAgent: () => "Kiko/0.4.0 (macOS 26.1)",
    fetch: async (url, init) => {
      if (!String(url).startsWith("https://openrouter.ai/")) return fetch(url, init);
      openrouter.push(`${String(url)} ${new Headers(init?.headers).get("authorization")}`);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { headers: { "content-type": "application/json" } });
    },
  });
  const w = offersFor();
  calls.onNotice = (n) => w.offers.notice(n);
  calls.onPlanOk = () => w.offers.planBack();
  const keychain = memoryStore();
  const said: string[] = [];
  const check =
    (status: number): KeyFetch =>
    async () => ({ status, ok: status < 300, text: async () => "{}" });
  const section = (status: number) =>
    new KeySettings({
      env: {},
      sources: {},
      store: keychain.store,
      fetch: check(status),
      timeoutMs: 50,
      log: () => {},
      say: (line) => void said.push(line),
      // As the app's (app/settings/keys.ts useKey): held for this run, read at the next call; no restart for OpenRouter.
      use: (info, key) => (holdKey(info.env, key), false),
      restart: () => assert.fail("no restart"),
      saved: (info) => w.offers.keySaved(info.id),
    });
  const chat = () => calls.post("chat", { model: "anthropic/claude-haiku-5.5", messages: [{ role: "user", content: "hi" }] }, { call: "summary" });
  return { proxy, calls, w, keychain, said, section, chat, openrouter };
}

describe("a key saved from the offer", () => {
  test("the next call goes on your own key with nothing restarted, the offer is gone, Settings closes and it's said", async () => {
    const t = await signedIn();
    t.proxy.answer("chat", proxyError(402, "trial_ended", { ended_why: "time" }));
    await assert.rejects(t.chat(), (e: unknown) => e instanceof AccountAiError && e.code === "trial_ended");
    assert.deepEqual(ui.state.keyOffer, { why: "trial_ended", until: null });
    assert.equal(t.w.said[0].text, `Your free trial has ended. To keep going, add your own OpenRouter key: ${PRESS}.`);
    // e: the app opens the paste (app.ts addKey).
    ui.set({ screen: "settings", settingsAt: "key:openrouter", settingsPaste: true });
    assert.equal(await t.section(200).enter("openrouter", FAKE_OR), true);
    assert.equal(t.keychain.kept.OPENROUTER_API_KEY, FAKE_OR, "kept in the (test's) Keychain");
    assert.equal(ui.state.keyOffer, null, "the offer gone");
    assert.equal(t.w.closed(), 1, "Settings closed, back where you were");
    assert.equal(ui.state.screen, "main");
    assert.deepEqual(t.w.shown.at(-1), `(${KEY_BACK_LINE})`);
    assert.deepEqual(t.w.said.at(-1), { text: "Key saved. Kiko's AI is back on your own key." });
    assert.deepEqual(t.said, ["(checking the OpenRouter key…)", "(✓ OpenRouter key works: saved in the Keychain.)"]);
    // The next call: straight to OpenRouter with your key; the proxy not asked again.
    const before = t.proxy.calls.length;
    const res = await t.chat();
    assert.equal(res.status, 200);
    assert.deepEqual(t.openrouter, [`https://openrouter.ai/api/v1/chat/completions Bearer ${FAKE_OR}`]);
    assert.equal(t.proxy.calls.length, before);
  });

  test("a key OpenRouter turns down: nothing saved, said on its row (the screen covers Kiko's page), the offer stays", async () => {
    const t = await signedIn();
    t.proxy.answer("chat", proxyError(402, "trial_ended", { ended_why: "time" }));
    await assert.rejects(t.chat(), AccountAiError);
    ui.set({ screen: "settings", settingsAt: "key:openrouter", settingsPaste: true });
    const keys = t.section(401);
    assert.equal(await keys.enter("openrouter", FAKE_OR), false);
    assert.equal(t.keychain.kept.OPENROUTER_API_KEY, undefined);
    assert.ok(ui.state.keyOffer, "still offered");
    assert.equal(ui.state.screen, "settings", "left open to try another");
    const row = keys.rows({ stt: "apple", tts: "say", llm: "deepseek/deepseek-v4.1-flash" }).find((r) => r.key === "key:openrouter")!;
    assert.equal(row.note, "OpenRouter turned down the key you entered: nothing saved. Enter another?");
    keys.forget();
    assert.notEqual(keys.rows({ stt: "apple", tts: "say", llm: "deepseek/deepseek-v4.1-flash" }).find((r) => r.key === "key:openrouter")!.note, row.note, "settings closed: let go");
  });

  test("today's share used, then the plan runs a call again: the offer goes by itself", async () => {
    const t = await signedIn();
    t.proxy.answer("chat", proxyError(402, "daily_cap", { resets_at: new Date(Date.now() + 3_600_000).toISOString() }), streamAnswer(["Back."]));
    await assert.rejects(t.chat(), AccountAiError);
    assert.equal(ui.state.keyOffer?.why, "daily_cap");
    assert.equal((await t.chat()).status, 200);
    assert.equal(ui.state.keyOffer, null);
  });
});
