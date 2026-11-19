// Kiko's quick check on the phone (protocol/README.md "Kiko's quick checks"), through a real server
// on 127.0.0.1 with a fake phone: `state.checking` while one runs; its permission prompt with what
// it's for (`checkFor`); the line it ends with carrying `checked`, live (announcement) and kept for a
// phone that's away (missed_line, missed); and never a session in the list.
import "../../setup.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { LocalPhone } from "../../support/local-phone.ts";
import { quickCardName } from "../../../src/core/quick-ask.ts";
import { ui } from "../../../src/core/ui-store.ts";
import { catchUpUpdates } from "../../../src/remote/catch-up.ts";
import { catchUpLine, type Missed } from "../../../src/remote/missed.ts";
import { Pairing } from "../../../src/remote/pairing.ts";
import { invalid } from "../../../src/remote/schema.ts";
import { PhoneServer, type PhoneHub } from "../../../src/remote/server.ts";

const hub: PhoneHub = {
  talkStart: () => null,
  talkAudio: () => {},
  talkEnd: () => {},
  type: () => null,
  permission: () => null,
  answers: () => null,
  talking: () => false,
  playOnMac: () => {},
  catchUp: () => {},
  catchUpSummary: () => {},
  catchUpStop: () => false,
};

/** A phone: every message it gets, checked against the schema. */
function phone(port: number) {
  const ws = new LocalPhone(`ws://127.0.0.1:${port}`);
  const got: any[] = [];
  const waiting: Array<() => void> = [];
  ws.on("message", (data) => {
    const m = JSON.parse(String(data));
    assert.equal(invalid(m, "hub"), null, JSON.stringify(m));
    got.push(m);
    for (const w of waiting.splice(0)) w();
  });
  const opened = new Promise<void>((resolve) => ws.once("open", () => resolve()));
  const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
  return {
    got,
    async send(m: Record<string, unknown>) {
      await opened;
      ws.send(JSON.stringify({ v: 1, ...m }));
    },
    /** The next of this type that comes and passes `ok`. */
    async next(type: string, ok: (m: any) => boolean = () => true): Promise<any> {
      for (;;) {
        const i = got.findIndex((m) => m.type === type && ok(m));
        if (i >= 0) return got.splice(i, 1)[0];
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
    },
    async close() {
      ws.close();
      await closed;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const TASK = "how much free disk space there is on the main volume";

async function connected(name: string) {
  const pairing = new Pairing(join(process.cwd(), `phones-${name}.json`));
  const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
  const server = new PhoneServer({ hub, pairing, port: 0, host: "127.0.0.1", network, presenceSettleMs: 0 });
  const port = await server.start();
  const p = phone(port);
  await p.send({ type: "pair", code: pairing.open().code, device: "Test iPhone", appVersion: "0.1.0" });
  await p.next("paired");
  await p.next("welcome");
  await p.next("missed");
  await p.send({ type: "presence", state: "back" });
  await settle();
  return { server, p };
}

test("while a check runs, state says what it checks and since when; after, nothing; never a session", async () => {
  const { server, p } = await connected("qc-state");
  try {
    ui.set({ checking: { what: `${TASK}\n`, startedAt: 1_793_213_001_000.4 } });
    const on = await p.next("state", (m) => m.checking);
    assert.deepEqual(on.checking, { what: TASK, startedAt: 1_793_213_001_000 });
    ui.set({ checking: null });
    const off = await p.next("state", (m) => !m.checking);
    assert.equal("checking" in off, false, "left out while none runs (an older app sees nothing new)");
    for (const m of p.got.filter((x) => x.type === "sessions")) assert.ok(!m.sessions.some((s: any) => s.id === "kiko"));
    await p.close();
  } finally {
    ui.set({ checking: null });
    server.stop();
  }
});

test("its permission prompt: Kiko's quick check by name, and what it's for apart (checkFor)", async () => {
  const { server, p } = await connected("qc-prompt");
  try {
    ui.set({ permission: { id: "q1", sessionId: "kiko", name: quickCardName(TASK), checkFor: TASK, what: "run docker system df", risky: false, canAlways: true } });
    const m = await p.next("permission_prompt", (x) => x.prompt);
    assert.equal(m.prompt.name, "Kiko's quick check");
    assert.equal(m.prompt.checkFor, TASK);
    assert.equal(m.prompt.sessionId, "kiko");
    assert.equal(m.prompt.what, "run docker system df");
    // Any other prompt: no checkFor.
    ui.set({ permission: { id: "p2", sessionId: "s1", name: "Lacy", what: "run pnpm test", risky: false } });
    const other = await p.next("permission_prompt", (x) => x.prompt?.promptId === "p2");
    assert.equal("checkFor" in other.prompt, false);
    await p.close();
  } finally {
    ui.set({ permission: null });
    server.stop();
  }
});

test("the line it ends with: `checked` on the announcement, and on the item kept for a phone that's away", async () => {
  const { server, p } = await connected("qc-result");
  try {
    ui.voice("You have 182 GB free.", { checked: TASK });
    const live = await p.next("announcement", (m) => m.phase === "start");
    assert.deepEqual([live.kind, live.text, live.checked], ["app", "You have 182 GB free.", TASK]);
    ui.voice("Any other line.");
    const plain = await p.next("announcement", (m) => m.phase === "start");
    assert.equal("checked" in plain, false);

    await p.send({ type: "presence", state: "away" });
    await settle();
    ui.voice("Nothing is listening on port 3000.", { checked: "whether anything runs on port 3000" });
    const kept = (await p.next("missed_line")).item;
    assert.deepEqual([kept.kind, kept.text, kept.checked], ["answer", "Nothing is listening on port 3000.", "whether anything runs on port 3000"]);
    await p.send({ type: "presence", state: "back" });
    const missed = (await p.next("missed")).items;
    assert.equal(missed.at(-1).checked, "whether anything runs on port 3000");
    await p.close();
  } finally {
    server.stop();
  }
});

test("a catch-up reads it as what Kiko checked, then the answer", () => {
  const item: Missed = { id: 1, at: 1, sessionId: null, name: null, kind: "answer", text: "You have 182 GB free.", checked: "how much disk space is free?" };
  assert.equal(catchUpLine(item), "Kiko checked how much disk space is free: You have 182 GB free.");
  assert.equal(catchUpUpdates([item])[0].text, "Kiko checked how much disk space is free: You have 182 GB free.");
  assert.equal(catchUpLine({ ...item, checked: undefined }), "You have 182 GB free.");
});
