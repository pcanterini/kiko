// Where a phone's app is, as each connection is made. The case:
// Play on this Mac off, the phone locked, Kiko restarted; the phone's app, still running in the
// background, reconnected and never said it was away (it only said so as it went to the background),
// and the hub took a new connection to be in front: it counted as a phone playing what's said, so
// the Mac stayed quiet and the reply was heard nowhere. Now a new connection counts as away until it
// says (the app says right after welcome), and an older app that never says is taken to be in front
// after a moment.
import "../../setup.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LocalPhone } from "../../support/local-phone.ts";
import { ui } from "../../../src/core/ui-store.ts";
import { Pairing } from "../../../src/remote/pairing.ts";
import { invalid } from "../../../src/remote/schema.ts";
import { PhoneServer, type PhoneHub } from "../../../src/remote/server.ts";
import { checkWaits } from "../../support/until.ts";

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

function phone(port: number) {
  const ws = new LocalPhone(`ws://127.0.0.1:${port}`);
  const got: any[] = [];
  ws.on("message", (data) => {
    const m = JSON.parse(String(data));
    assert.equal(invalid(m, "hub"), null, JSON.stringify(m));
    got.push(m);
  });
  const opened = new Promise<void>((resolve) => ws.once("open", () => resolve()));
  const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
  return {
    got,
    async send(m: Record<string, unknown>) {
      await opened;
      ws.send(JSON.stringify({ v: 1, ...m }));
    },
    async close() {
      ws.close();
      await closed;
    },
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = checkWaits(2000, 10);

/** This process's phone_presence log lines, oldest first. */
function presenceLog(): Array<{ phoneId: string; state: string; on: string; assumed?: boolean }> {
  return readdirSync("logs")
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join("logs", f), "utf8").split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === "phone_presence")
    .map(({ phoneId, state, on, assumed }) => ({ phoneId, state, on, ...(assumed ? { assumed } : {}) }));
}

async function setUp(name: string, presenceMs: number) {
  const pairing = new Pairing(join(process.cwd(), `phones-${name}.json`));
  const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
  let changes = 0;
  const server = new PhoneServer({ hub, pairing, port: 0, host: "127.0.0.1", network, presenceMs, changed: () => void changes++ });
  const port = await server.start();
  // Paired once, with Play on phone on.
  const first = phone(port);
  await first.send({ type: "pair", code: pairing.open().code, device: "Test iPhone", appVersion: "0.1.0" });
  await until(() => first.got.some((m) => m.type === "welcome"));
  const { token, phoneId } = first.got.find((m) => m.type === "paired");
  await first.send({ type: "play_on_phone", on: true });
  await first.close();
  await until(() => server.connected().length === 0);
  return { server, port, token, phoneId, changes: () => changes };
}

test("a phone that connects in the background says so at once: it never counts as playing, so the Mac plays; in front again, it plays", async () => {
  const { server, port, token, phoneId } = await setUp("away-on-connect", 60_000);
  try {
    const before = presenceLog().length;
    const p = phone(port);
    await p.send({ type: "hello", token, device: "Test iPhone", appVersion: "0.2.0" });
    await until(() => p.got.some((m) => m.type === "welcome"));
    assert.equal(server.audible(), false, "not yet said where it is: not a phone that plays (the Mac does)");
    // The app, in the background as it (re)connected, says so right after welcome.
    await p.send({ type: "presence", state: "away" });
    await until(() => presenceLog().length > before);
    assert.equal(server.audible(), false, "away: the Mac plays");
    // Said while it's away: kept for it, not sent to it to play.
    const from = p.got.length;
    server.audio(Buffer.alloc(480));
    server.speak("The tests pass.");
    ui.spoken("Atlas agents finished; the tests pass.", { name: "atlas-agents", sessionId: "s1" });
    await wait(50);
    assert.deepEqual(
      p.got.slice(from).filter((m) => m.type === "audio" || m.type === "speak"),
      [],
      "nothing to play is sent to a phone that can't",
    );
    // In front: it plays now, and gets what it missed.
    await p.send({ type: "presence", state: "back" });
    await until(() => server.audible());
    await until(() => p.got.slice(from).some((m) => m.type === "missed" && m.items.length === 1));
    server.speak("Back.");
    await until(() => p.got.some((m) => m.type === "speak" && m.text === "Back."));
    assert.deepEqual(presenceLog().slice(before), [
      { phoneId, state: "away", on: "connect" },
      { phoneId, state: "back", on: "change" },
    ]);
    await p.close();
  } finally {
    server.stop();
  }
});

test("a phone in front says so on connect: it plays at once, and what it missed isn't sent twice", async () => {
  const { server, port, token, phoneId } = await setUp("here-on-connect", 60_000);
  try {
    const before = presenceLog().length;
    const p = phone(port);
    await p.send({ type: "hello", token, device: "Test iPhone", appVersion: "0.2.0" });
    await until(() => p.got.some((m) => m.type === "welcome"));
    await p.send({ type: "presence", state: "back" });
    await until(() => server.audible());
    await wait(50);
    assert.equal(p.got.filter((m) => m.type === "missed").length, 1, "with welcome only");
    assert.deepEqual(presenceLog().slice(before), [{ phoneId, state: "back", on: "connect" }]);
    await p.close();
  } finally {
    server.stop();
  }
});

test("an older app that never says where it is on connect: taken to be in front after a moment, as before", async () => {
  const { server, port, token, phoneId, changes } = await setUp("older-app", 100);
  try {
    const before = presenceLog().length;
    const changed = changes();
    const p = phone(port);
    await p.send({ type: "hello", token, device: "Test iPhone", appVersion: "0.1.0" });
    await until(() => p.got.some((m) => m.type === "welcome"));
    await until(() => server.audible(), 1000);
    assert.ok(changes() >= changed + 2, "told as it connected, and again as it counts as playing");
    assert.deepEqual(presenceLog().slice(before), [{ phoneId, state: "back", on: "connect", assumed: true }]);
    // It still says away and back as it goes and comes.
    await p.send({ type: "presence", state: "away" });
    await until(() => !server.audible());
    await p.send({ type: "presence", state: "back" });
    await until(() => server.audible());
    await p.close();
    await until(() => !server.audible());
  } finally {
    server.stop();
  }
});

test("a connection that goes before it says: no presence assumed for it afterwards", async () => {
  const { server, port, token } = await setUp("gone-early", 100);
  try {
    const before = presenceLog().length;
    const p = phone(port);
    await p.send({ type: "hello", token, device: "Test iPhone", appVersion: "0.1.0" });
    await until(() => p.got.some((m) => m.type === "welcome"));
    await p.close();
    await wait(200);
    assert.equal(server.audible(), false);
    assert.deepEqual(presenceLog().slice(before), []);
  } finally {
    server.stop();
  }
});

/** This process's log lines of one event, oldest first. */
function logged(event: string): any[] {
  return readdirSync("logs")
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join("logs", f), "utf8").split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === event);
}

// Locking the phone sent away, back, away within 20ms. It ended right, but
// each one was acted on: a change of where the phone is counts only once it has held 300ms.
test("a change counts once it has held a moment: away, back, away within 20ms is one away; taken back in time, nothing changes", async () => {
  const { server, port, token, phoneId } = await setUp("flap", 60_000);
  try {
    const p = phone(port);
    await p.send({ type: "hello", token, device: "Test iPhone", appVersion: "0.2.0" });
    await until(() => p.got.some((m) => m.type === "welcome"));
    await p.send({ type: "presence", state: "back" });
    await until(() => server.audible());
    const before = presenceLog().length;
    const flaps = logged("phone_presence_flap").length;

    // The phone locks: away, back, away, all at once.
    await p.send({ type: "presence", state: "away" });
    await p.send({ type: "presence", state: "back" });
    await p.send({ type: "presence", state: "away" });
    await wait(150);
    assert.equal(server.audible(), true, "not yet: it hasn't held");
    await until(() => !server.audible());
    assert.deepEqual(presenceLog().slice(before), [{ phoneId, state: "away", on: "change" }], "acted on once");
    assert.deepEqual(
      logged("phone_presence_flap")
        .slice(flaps)
        .map((l) => [l.state, l.ignored]),
      [["back", "away"]],
    );

    // Back and away again within a moment: it stays away, and what it missed isn't sent for nothing.
    const missedBefore = p.got.filter((m) => m.type === "missed").length;
    await p.send({ type: "presence", state: "back" });
    await wait(50);
    await p.send({ type: "presence", state: "away" });
    await wait(450);
    assert.equal(server.audible(), false);
    assert.equal(p.got.filter((m) => m.type === "missed").length, missedBefore);
    assert.deepEqual(presenceLog().slice(before), [{ phoneId, state: "away", on: "change" }]);

    // Back for good: in front after the moment, with what it missed.
    await p.send({ type: "presence", state: "back" });
    await until(() => server.audible());
    await until(() => p.got.filter((m) => m.type === "missed").length === missedBefore + 1);
    await p.close();
  } finally {
    server.stop();
  }
});

test("a connection that goes while a change is pending: nothing is acted on after", async () => {
  const { server, port, token } = await setUp("gone-settling", 60_000);
  try {
    const connected = presenceLog().length;
    const p = phone(port);
    await p.send({ type: "hello", token, device: "Test iPhone", appVersion: "0.2.0" });
    await until(() => p.got.some((m) => m.type === "welcome"));
    await p.send({ type: "presence", state: "away" });
    await until(() => presenceLog().length > connected);
    const before = presenceLog().length;
    await p.send({ type: "presence", state: "back" });
    await p.close();
    await wait(450);
    assert.deepEqual(presenceLog().slice(before), []);
    assert.equal(server.audible(), false);
  } finally {
    server.stop();
  }
});

// Cost on the phone (TODO): Kiko's own cost this run, the Mac's bottom line's number, in state.
test("state carries Kiko's own cost this run, to 3 decimals as the Mac shows it; only a change there is sent", async () => {
  const { server, port, token } = await setUp("cost", 60_000);
  try {
    ui.set({ cost: 0.04237 });
    const p = phone(port);
    await p.send({ type: "hello", token, device: "Test iPhone", appVersion: "0.2.0" });
    await until(() => p.got.some((m) => m.type === "state"));
    assert.equal(p.got.find((m) => m.type === "state").cost, 0.042);
    const states = () => p.got.filter((m) => m.type === "state").length;
    const before = states();
    ui.set({ cost: 0.04241 });
    await wait(100);
    assert.equal(states(), before, "the same to 3 decimals: nothing new");
    ui.set({ cost: 0.0431 });
    await until(() => p.got.filter((m) => m.type === "state").at(-1).cost === 0.043);
    await p.close();
  } finally {
    server.stop();
    ui.set({ cost: null });
  }
});

// No dollars on the subscription (src/core/dollars.ts): the window's cost null, state leaves `cost`
// out, so a phone of any age (it shows only what the last state carried) shows none, even after one with it.
test("on the subscription (cost null), state carries no cost, and one after a state with it drops it", async () => {
  const { server, port, token } = await setUp("no-dollars", 60_000);
  try {
    ui.set({ cost: null });
    const p = phone(port);
    await p.send({ type: "hello", token, device: "Test iPhone", appVersion: "0.2.0" });
    await until(() => p.got.some((m) => m.type === "state"));
    assert.equal("cost" in p.got.find((m) => m.type === "state"), false, "no cost at all, not 0");
    ui.set({ cost: 0.012 });
    await until(() => p.got.filter((m) => m.type === "state").at(-1).cost === 0.012);
    ui.set({ cost: null });
    await until(() => !("cost" in p.got.filter((m) => m.type === "state").at(-1)));
    await p.close();
  } finally {
    server.stop();
    ui.set({ cost: null });
  }
});
