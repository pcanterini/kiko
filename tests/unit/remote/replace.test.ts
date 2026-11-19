// A phone's newest connection replaces its older ones (server.ts supersede). A
// phone on the home network turned Wi-Fi off and came back through the relay; its LAN socket
// stayed open on the Mac, half-open, until the pings gave up 11 seconds later. Meanwhile it still
// counted as the phone in front (audible, present), and audio went to it for no one. Now the phone
// saying where it is on the new connection (the app says so only on the connection it took) lets
// the old one go at once, as a replacement: no phone_disconnected, no change of presence, and its
// close, whenever it comes, touches nothing of the new one.
import "../../setup.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { LocalPhone } from "../../support/local-phone.ts";
import { Pairing } from "../../../src/remote/pairing.ts";
import { invalid } from "../../../src/remote/schema.ts";
import { PhoneServer, type PhoneHub } from "../../../src/remote/server.ts";
import { checkWaits } from "../../support/until.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = checkWaits(2000, 10);

/** This process's log lines of one event, oldest first. */
function logged(event: string): any[] {
  return readdirSync("logs")
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join("logs", f), "utf8").split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === event);
}

/** One of the phone's sockets: straight to the server (encrypted, as the app's), or through the stand-in relay (plain: it stands in for the tunnel). */
function socket(url: string, through: "direct" | "relay" = "direct") {
  const ws = through === "direct" ? new LocalPhone(url) : new WebSocket(url);
  const got: any[] = [];
  ws.on("message", (data, binary) => {
    if (binary) return void got.push({ type: "binary" });
    const m = JSON.parse(String(data));
    assert.equal(invalid(m, "hub"), null, JSON.stringify(m));
    got.push(m);
  });
  ws.on("error", () => {});
  const opened = new Promise<void>((resolve) => ws.once("open", () => resolve()));
  let closed: { code: number; reason: string } | null = null;
  ws.on("close", (code, reason) => (closed = { code, reason: String(reason) }));
  return {
    ws,
    got,
    closed: () => closed,
    async send(m: Record<string, unknown>) {
      await opened;
      ws.send(JSON.stringify({ v: 1, ...m }));
    },
    /** Half-open: the phone's end is gone (Wi-Fi off), so nothing it's sent is read or answered. */
    async vanish() {
      await opened;
      (ws as any)._socket.pause();
    },
    /** Its close reaches the Mac at last (the pings gave up, the network came back). */
    end() {
      (ws as any)._socket.destroy();
    },
  };
}
type Sock = ReturnType<typeof socket>;

async function setUp(name: string) {
  const pairing = new Pairing(join(process.cwd(), `phones-replace-${name}.json`));
  const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
  const ends: boolean[] = [];
  const hub: PhoneHub = {
    talkStart: () => null,
    talkAudio: () => {},
    talkEnd: (cancel) => void ends.push(cancel),
    type: () => null,
    permission: () => null,
    answers: () => null,
    talking: () => false,
    playOnMac: () => {},
    catchUp: () => {},
    catchUpSummary: () => {},
    catchUpStop: () => false,
  };
  // presenceSettleMs 0: a change counts at once, so each step can be checked as it's said.
  const server = new PhoneServer({ hub, pairing, port: 0, host: "127.0.0.1", network, opus: null, presenceMs: 100, presenceSettleMs: 0 });
  const port = await server.start();
  const first = socket(`ws://127.0.0.1:${port}`);
  await first.send({ type: "pair", code: pairing.open().code, device: "Test iPhone", appVersion: "0.2.1" });
  await until(() => first.got.some((m) => m.type === "welcome"));
  const { token, phoneId } = first.got.find((m) => m.type === "paired");
  first.ws.close();
  await until(() => server.connected().length === 0);
  // The relay's tunnel, stood in for: its sockets handed to the server as the relay client does (adopt).
  const relay = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => relay.once("listening", () => resolve()));
  relay.on("connection", (ws) => server.adopt(ws, phoneId));
  const relayPort = (relay.address() as { port: number }).port;
  const lan = () => socket(`ws://127.0.0.1:${port}`);
  const viaRelay = () => socket(`ws://127.0.0.1:${relayPort}`, "relay");
  /** Signed in on `s`, and in front (the app says so right after welcome, on the connection it took). */
  const signIn = async (s: Sock, presence: "back" | "away" | null = "back") => {
    await s.send({ type: "hello", token, device: "Test iPhone", appVersion: "0.2.1" });
    await until(() => s.got.some((m) => m.type === "welcome"));
    if (presence) await s.send({ type: "presence", state: presence });
  };
  const stop = () => {
    server.stop();
    relay.close();
  };
  return { server, phoneId, lan, viaRelay, signIn, ends, stop };
}

/** Audio said now reaches `s` only (as PCM: what its own connection agreed on). */
async function audioOnlyTo(server: PhoneServer, s: Sock, others: Sock[]) {
  const from = s.got.length;
  const before = others.map((o) => o.got.length);
  server.audio(Buffer.alloc(480));
  await until(() => s.got.slice(from).some((m) => m.type === "audio"));
  await wait(30);
  others.forEach((o, i) => assert.equal(o.got.length, before[i], "nothing to a socket it replaced"));
}

test("on the home network, then through the relay with the LAN socket half-open: the relay one takes over at once, and the old one's late close changes nothing", async () => {
  const { server, phoneId, lan, viaRelay, signIn, ends, stop } = await setUp("lan-then-relay");
  try {
    const disconnects = logged("phone_disconnected").length;
    const replaced = logged("phone_replaced").length;
    const a = lan();
    await signIn(a);
    await until(() => server.audible());
    // Wi-Fi off: the LAN socket is gone at the phone's end, still open here.
    await a.vanish();
    const b = viaRelay();
    await signIn(b);
    await until(() => logged("phone_replaced").length > replaced);
    assert.deepEqual(
      logged("phone_replaced")
        .slice(replaced)
        .map((l) => [l.phoneId, l.from, l.to]),
      [[phoneId, "direct", "relay"]],
    );
    assert.equal(server.audible(), true, "the phone in front plays what's said, throughout");
    assert.equal(server.connected().length, 1, "one phone, once");
    await audioOnlyTo(server, b, [a]);
    // A press on the relay, under way as the LAN socket's close finally comes.
    await b.send({ type: "talk_start", sessionId: null, talkId: "t-1" });
    await wait(30);
    a.end();
    await wait(100);
    assert.equal(server.audible(), true);
    assert.deepEqual(ends, [], "its press goes on");
    await audioOnlyTo(server, b, [a]);
    assert.equal(logged("phone_disconnected").length, disconnects, "a replacement, not the phone leaving");
    // The phone locks: the Mac takes over at once, the stale socket doesn't keep it "in front".
    await b.send({ type: "presence", state: "away" });
    await until(() => !server.audible());
    // Its own close is the phone leaving.
    b.ws.close();
    await until(() => logged("phone_disconnected").length === disconnects + 1);
    assert.equal(logged("phone_disconnected").at(-1).via, "relay");
  } finally {
    stop();
  }
});

// The bug as it was, the other way round: away on the new connection while the old, half-open one
// still said "here" kept the Mac quiet, playing to no one.
test("away on the new connection is away, whatever an older half-open one last said", async () => {
  const { server, lan, viaRelay, signIn, stop } = await setUp("away-over-stale");
  try {
    const a = lan();
    await signIn(a);
    await until(() => server.audible());
    await a.vanish();
    const b = viaRelay();
    await signIn(b, "away");
    await wait(50);
    assert.equal(server.audible(), false, "the Mac plays");
    a.end();
  } finally {
    stop();
  }
});

test("through the relay, then back on the home network: the direct one takes over, replies keep going to the phone, and the relay's close is no news", async () => {
  const { server, phoneId, lan, viaRelay, signIn, ends, stop } = await setUp("relay-then-lan");
  try {
    const disconnects = logged("phone_disconnected").length;
    const replaced = logged("phone_replaced").length;
    const presences = logged("phone_presence").length;
    const b = viaRelay();
    await signIn(b);
    await until(() => server.audible());
    const a = lan();
    await signIn(a);
    await until(() => logged("phone_replaced").length > replaced);
    assert.deepEqual(
      logged("phone_replaced")
        .slice(replaced)
        .map((l) => [l.phoneId, l.from, l.to]),
      [[phoneId, "relay", "direct"]],
    );
    // The relay socket is told why (replaced), and nothing more reaches it.
    await until(() => b.closed() !== null);
    assert.deepEqual(b.closed(), { code: 4000, reason: "replaced" });
    assert.equal(server.audible(), true);
    await audioOnlyTo(server, a, [b]);
    assert.equal(logged("phone_disconnected").length, disconnects);
    assert.deepEqual(
      logged("phone_presence")
        .slice(presences)
        .map((l) => [l.state, l.on]),
      [
        ["back", "connect"],
        ["back", "connect"],
      ],
      "each connection's own first word, and no change of where the phone is",
    );
    assert.deepEqual(ends, []);
    a.ws.close();
  } finally {
    stop();
  }
});

test("two quick reconnects: only the newest counts, each older one let go once, and none of their closes leave the phone gone", async () => {
  const { server, lan, viaRelay, signIn, stop } = await setUp("quick");
  try {
    const disconnects = logged("phone_disconnected").length;
    const replaced = logged("phone_replaced").length;
    const a = lan();
    await signIn(a);
    await a.vanish();
    const b = viaRelay();
    await signIn(b);
    await b.vanish();
    const c = lan();
    await signIn(c);
    await until(() => logged("phone_replaced").length === replaced + 2);
    assert.deepEqual(
      logged("phone_replaced")
        .slice(replaced)
        .map((l) => [l.from, l.to]),
      [
        ["direct", "relay"],
        ["relay", "direct"],
      ],
    );
    assert.equal(server.connected().length, 1);
    assert.equal(server.audible(), true);
    a.end();
    b.end();
    await wait(100);
    assert.equal(server.audible(), true);
    assert.equal(logged("phone_disconnected").length, disconnects);
    await audioOnlyTo(server, c, [a, b]);
    // Play on phone switched on the new connection holds for the phone, not the connection.
    await c.send({ type: "play_on_phone", on: false });
    await until(() => !server.audible());
    await c.send({ type: "play_on_phone", on: true });
    await until(() => server.audible());
    c.ws.close();
  } finally {
    stop();
  }
});

// The app dials its addresses staggered; the first to welcome it wins and it drops the rest. One it
// dropped may be welcomed here too, and never says where the phone is: it isn't the phone's.
test("a dial the phone dropped, welcomed here too, never replaces the one it took nor counts as in front", async () => {
  const { server, lan, viaRelay, signIn, stop } = await setUp("raced");
  try {
    const replaced = logged("phone_replaced").length;
    const taken = lan();
    await signIn(taken);
    await until(() => server.audible());
    const dropped = viaRelay();
    await signIn(dropped, null);
    await dropped.vanish();
    await wait(250); // past presenceMs: an older app's connection would be taken to be in front by now
    assert.equal(logged("phone_replaced").length, replaced, "nothing replaced");
    await audioOnlyTo(server, taken, [dropped]);
    await taken.send({ type: "presence", state: "away" });
    await until(() => !server.audible());
    dropped.end();
    taken.ws.close();
  } finally {
    stop();
  }
});
