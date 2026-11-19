// The Mac's one sign-in, shared (core/account/mac-sign-in.ts), against a stand-in Account whose
// device code flow the test drives: asked twice it's one code (the phone's and Enter's the same),
// unless it has under a minute left; a code that runs out is replaced only while someone holds on,
// and not forever; approved, `after` (the plan asked) runs before signed_in is said; a denial is
// `failed`; signed in some other way, `settle` ends it as signed in; stopped, nothing is said. And the
// app's side (app/mac-sign-in.ts): Enter shows kiko login's lines and opens the page without the code
// (where it's typed), the phone's opening is said with the code to check, and the end said by who
// was watching (Settings → Kiko account → Sign in following the same one). And the account calls carry the Mac's name (Kiko-Mac-Name), percent-encoded.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Account, AccountView, SignIn } from "../../../src/core/account/account.ts";
import { accountClient, type DeviceStart } from "../../../src/core/account/client.ts";
import { MAX_CODES, MacSignIn, MIN_LEFT_MS, type MacSignInState } from "../../../src/core/account/mac-sign-in.ts";
import { fakeAccountServer, happyScript } from "../../support/fake-account.ts";

/** A stand-in Account: each signIn call is a run the test ends (`end`), its code given at once. */
function stand(o: { now: () => number }) {
  let view: AccountView = { state: "signed-out", revoked: false };
  const runs: Array<{ start: DeviceStart; end: (r: SignIn) => void; signal?: AbortSignal; approve: () => void }> = [];
  const account = {
    view: () => view,
    check: async () => ({ state: view.state }),
    syncPhone: async () => "none",
    lastSaid: () => null,
    async signIn(x: { onCode: (s: DeviceStart) => void | Promise<void>; signal?: AbortSignal; onApproved?: () => void }): Promise<SignIn> {
      const n = runs.length + 1;
      const start: DeviceStart = {
        deviceCode: `dev-${n}`,
        userCode: `CODE-000${n}`,
        verificationUri: "https://account.kiko.sh/device",
        verificationUriComplete: `https://account.kiko.sh/device?user_code=CODE-000${n}`,
        interval: 5,
        expiresIn: 600,
      };
      return new Promise<SignIn>((resolve) => {
        // Approved (the session being kept, as Account.signIn's): the signal stops nothing from then on.
        let approved = false;
        const run = { start, end: resolve, signal: x.signal, approve: () => ((approved = true), x.onApproved?.()) };
        runs.push(run);
        x.signal?.addEventListener("abort", () => approved || resolve({ ok: false, why: "cancelled", said: "Sign-in stopped. Nothing changed." }));
        void x.onCode(start);
      });
    },
  } as unknown as Account;
  return {
    account,
    runs,
    signIn: (email = "lacy@example.com") => (view = { state: "signed-in", email, since: o.now(), checkedAt: o.now(), plan: null, trial: null }),
  };
}

function setUp(o: { after?: () => Promise<void> } = {}) {
  let clock = Date.UTC(2026, 10, 4, 9);
  const s = stand({ now: () => clock });
  const states: MacSignInState[] = [];
  const m = new MacSignIn({ account: () => s.account, now: () => clock, ...(o.after ? { after: o.after } : {}) });
  m.on("state", (x) => states.push(x));
  return { m, s, states, tick: (ms: number) => (clock += ms), now: () => clock };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("one sign-in, shared", () => {
  test("asked twice: one code; under a minute left: a new one, the old one stopped", async () => {
    const t = setUp();
    assert.equal(t.m.available(), true);
    t.m.start("phone");
    await flush();
    const first = t.m.state();
    assert.equal(first.state, "code");
    assert.ok(first.state === "code" && first.code === "CODE-0001" && first.url.endsWith("user_code=CODE-0001") && first.page === "https://account.kiko.sh/device");
    assert.equal(t.m.start("mac"), first, "the same code for Enter on the Mac");
    assert.equal(t.s.runs.length, 1);
    t.tick(600_000 - MIN_LEFT_MS + 1);
    t.m.start("mac");
    await flush();
    assert.equal(t.s.runs.length, 2, "a new one");
    assert.ok(t.s.runs[0].signal?.aborted, "the old one stopped");
    const second = t.m.state();
    assert.ok(second.state === "code" && second.code === "CODE-0002");
  });

  test("a code that runs out: replaced while someone holds on (MAX_CODES in a row), else it just ends", async () => {
    const t = setUp();
    const release = t.m.hold();
    t.m.start("phone");
    await flush();
    for (let i = 1; i < MAX_CODES; i++) {
      t.s.runs.at(-1)!.end({ ok: false, why: "expired", said: "ran out" });
      await flush();
    }
    assert.equal(t.s.runs.length, MAX_CODES);
    t.s.runs.at(-1)!.end({ ok: false, why: "expired", said: "ran out" });
    await flush();
    assert.equal(t.s.runs.length, MAX_CODES, "not forever");
    assert.equal(t.m.state().state, "idle");
    release();
    t.m.start("phone");
    await flush();
    t.s.runs.at(-1)!.end({ ok: false, why: "expired", said: "ran out" });
    await flush();
    assert.equal(t.m.state().state, "idle", "nobody holding: ended");
  });

  test("approved: after() (the plan asked) before signed_in; denied: failed, with why", async () => {
    const order: string[] = [];
    const t = setUp({ after: async () => void order.push("after") });
    t.m.on("state", (s) => s.state === "signed_in" && order.push("signed_in"));
    t.m.start("phone");
    await flush();
    t.s.runs[0].end({ ok: true, email: "lacy@example.com" });
    await flush();
    await flush();
    assert.deepEqual(order, ["after", "signed_in"]);
    assert.deepEqual(t.m.state(), { state: "signed_in", by: "phone", email: "lacy@example.com" });
    t.m.start("mac");
    await flush();
    t.s.runs[1].end({ ok: false, why: "denied", said: "The sign-in was denied in the browser. Nothing changed." });
    await flush();
    assert.deepEqual(t.m.state(), { state: "failed", by: "mac", why: "denied", said: "The sign-in was denied in the browser. Nothing changed." });
  });

  test("signed in some other way: settle ends the one under way as signed in; nothing under way, nothing to settle; stop says idle", async () => {
    const t = setUp();
    assert.equal(t.m.settle(), false);
    t.m.start("phone");
    await flush();
    assert.equal(t.m.settle(), false, "still signed out");
    t.s.signIn();
    assert.equal(t.m.available(), false);
    assert.equal(t.m.settle(), true);
    assert.deepEqual(t.m.state(), { state: "signed_in", by: "elsewhere", email: "lacy@example.com" });
    assert.ok(t.s.runs[0].signal?.aborted);
    const t2 = setUp();
    t2.m.start("mac");
    await flush();
    t2.m.stop();
    await flush();
    assert.equal(t2.m.state().state, "idle");
    assert.deepEqual(
      t2.states.map((s) => s.state),
      ["starting", "code", "idle"],
    );
  });

  test("approved, its session being kept: past stopping; Stop and a stopped follower get signed in, never 'Nothing changed'", async () => {
    const t = setUp();
    const stop = new AbortController();
    let r: SignIn | null = null;
    void t.m.follow({ onCode: () => {}, signal: stop.signal }).then((x) => (r = x));
    await flush();
    t.s.runs[0].approve();
    stop.abort();
    t.m.stop();
    t.m.start("mac");
    t.s.signIn();
    assert.equal(t.m.settle(), false, "it ends by itself");
    await flush();
    assert.equal(r, null, "the follower waits for the end");
    assert.equal(t.s.runs.length, 1, "no new code");
    assert.equal(t.s.runs[0].signal?.aborted, false, "never stopped");
    assert.equal(t.m.state().state, "code");
    t.s.runs[0].end({ ok: true, email: "lacy@example.com" });
    await flush();
    await flush();
    assert.deepEqual(r, { ok: true, email: "lacy@example.com" });
    assert.deepEqual(t.m.state(), { state: "signed_in", by: "mac", email: "lacy@example.com" });
    assert.ok(!t.states.some((s) => s.state === "idle"));
    // Over: the next one is stopped as before.
    t.m.start("mac");
    await flush();
    t.m.stop();
    assert.equal(t.m.state().state, "idle");
  });
});

describe("the Mac's name on account calls", () => {
  test("Kiko-Mac-Name, percent-encoded (printable ASCII only), cut to 64; none when there's no name", async () => {
    const server = await fakeAccountServer(happyScript());
    const headers: string[] = [];
    const spy: typeof fetch = async (url, init) => {
      headers.push(new Headers(init?.headers).get("kiko-mac-name") ?? "(none)");
      return fetch(url, init);
    };
    try {
      await accountClient(server.url, { fetch: spy, macName: "Lacy’s MacBook Pro" }).deviceCode();
      await accountClient(server.url, { fetch: spy, macName: "x".repeat(80) }).session("tok");
      await accountClient(server.url, { fetch: spy, macName: null }).deviceCode();
      assert.equal(headers[0], "Lacy%E2%80%99s%20MacBook%20Pro");
      assert.match(headers[0], /^[\x21-\x7e]+$/);
      assert.equal(decodeURIComponent(headers[0]), "Lacy’s MacBook Pro");
      assert.equal(headers[1], "x".repeat(64));
      assert.equal(headers[2], "(none)");
    } finally {
      await server.close();
    }
  });
});

describe("on the Mac (app/mac-sign-in.ts, Settings → Kiko account → Sign in)", async () => {
  const { macSignIn, phoneOpenedSignIn, setSignInSay } = await import("../../../src/app/mac-sign-in.ts");
  const { accountAction, accountRows, forgetAccountConfirm, setOpenUrl, signInFromPrompt, useAccount } = await import("../../../src/app/settings/account.ts");
  const { ui } = await import("../../../src/core/ui-store.ts");
  const { signInQuestion } = await import("../../../src/ui/sign-in-ask.ts");

  async function app<T>(body: (t: { s: ReturnType<typeof stand>; lines: string[]; aloud: string[]; infos: string[] }) => Promise<T>) {
    process.env.KIKO_ACCOUNTS = "1";
    const s = stand({ now: Date.now });
    const lines: string[] = [];
    const aloud: string[] = [];
    const infos: string[] = [];
    const info = ui.info;
    ui.info = (l: string) => void infos.push(l);
    setSignInSay({ line: (l) => void lines.push(l), aloud: (l) => void aloud.push(l) });
    useAccount(s.account);
    setOpenUrl(async () => true);
    try {
      return await body({ s, lines, aloud, infos });
    } finally {
      accountAction("stop");
      forgetAccountConfirm();
      forgetAccountConfirm();
      useAccount(undefined);
      setSignInSay();
      ui.info = info;
      delete process.env.KIKO_ACCOUNTS;
    }
  }
  const pane = () => JSON.stringify(accountRows()[0]?.facts ?? []);

  test("the phone's code out: Settings' Sign in shows that same code (one sign-in); approved from the phone, both through", () =>
    app(async (t) => {
      macSignIn.hold();
      macSignIn.start("phone");
      await flush();
      accountAction("signin");
      await flush();
      assert.match(pane(), /CODE-0001/, "the pane shows the phone's code");
      assert.equal(t.s.runs.length, 1, "no second code");
      phoneOpenedSignIn();
      assert.equal(t.lines[0], "Signing in from your iPhone… Check the code there matches: CODE-0001.");
      assert.deepEqual(t.aloud, ["Signing in from your iPhone."]);
      t.s.runs[0].end({ ok: true, email: "lacy@example.com" });
      for (let i = 0; i < 5; i++) await flush();
      assert.equal(t.lines.at(-1), "Signed in as lacy@example.com from your iPhone. Your phone connects again now.");
      assert.equal(t.aloud.at(-1), "Signed in from your iPhone.");
      assert.ok(t.infos.includes("(Signed in as lacy@example.com.)"), "the pane's own line");
    }));

  test("Stop in the pane while a phone holds on: the pane lets go, the phone's sign-in goes on", () =>
    app(async (t) => {
      const release = macSignIn.hold();
      macSignIn.start("phone");
      await flush();
      accountAction("signin");
      await flush();
      accountAction("stop");
      await flush();
      assert.equal(macSignIn.state().state, "code", "still out for the phone");
      assert.equal(t.s.runs[0].signal?.aborted, false);
      release();
    }));

  test("Enter on the popup: Settings → Kiko account opened and its Sign in started; signed in already, only said", () =>
    app(async (t) => {
      const acts: unknown[] = [];
      const onAct = (a: unknown) => void acts.push(a);
      ui.on("action", onAct);
      try {
        signInFromPrompt();
        await flush();
        assert.deepEqual(acts, [{ type: "settings", at: "account" }]);
        assert.match(pane(), /CODE-0001/);
        accountAction("stop");
        await flush();
        t.s.signIn();
        acts.length = 0;
        signInFromPrompt();
        assert.deepEqual(acts, []);
        assert.ok(t.infos.includes("(Signed in already: your phone connects again by itself.)"));
      } finally {
        ui.off("action", onAct);
      }
    }));

  test("the window's popup: the reason, Sign in on Enter (the first item to pick) or s, Esc lets it go", () => {
    const menu = signInQuestion("ask-1", (arg) => [["send-keys", `signIn;${arg}`]]);
    assert.equal(menu.title, " Kiko account ");
    const labels = menu.items.map((i) => (typeof i === "string" ? i : i.label));
    assert.deepEqual(labels, ["Your phone can't connect:", "this Mac is signed out of Kiko.", "-", "Sign in", "-", "Esc: not now"]);
    const picks = menu.items.filter((i) => typeof i !== "string" && i.run);
    assert.equal(picks.length, 1, "Sign in is the only item to pick: Enter picks it");
    assert.deepEqual((picks[0] as { run: string[][] }).run, [["send-keys", "signIn;ask-1"]]);
    assert.deepEqual(menu.closed, [["send-keys", "signIn;"]], "let go: an empty answer");
  });
});
