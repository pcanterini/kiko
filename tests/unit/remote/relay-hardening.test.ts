// The Mac's relay client against a relay that refuses it or misbehaves (src/remote/relay-client.ts;
// the 2026-11-19 security review, M7, M8 and L6): the pass in the upgrade's Kiko-Relay-Pass header,
// the first dial waiting a little for it, a sign-in refused for the plan waiting for a new pass (not
// dialling every minute for nothing), and what a malicious relay can make the Mac do: channels
// capped at MAX_CHANNELS and opened at a bounded rate, `phone_refused` heard only once signed in and
// acted on once a minute per pass status, and the lines it can make the Mac log capped. Time is the
// test's (FakeClock) and so is the socket (Wire): nothing here opens a real one.
import "../../setup.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Pairing } from "../../../src/remote/pairing.ts";
import { MAX_CHANNELS, PASS_HEADER, PLAN_RETRY_MS, RelayClient, type RelayWire } from "../../../src/remote/relay-client.ts";
import { newIdentity } from "../../../src/remote/relay-identity.ts";
import { FakeClock } from "../../support/clock.ts";

/** The relay's end of one socket: its challenge on accept; to auth, ready, or the refusal it's told to give. */
class Wire extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  /** To auth: ready (null), or this error (and its close: 4014 for plan_required, 4016 for too_many_rooms). */
  refuse: Record<string, unknown> | null = null;
  readonly headers: Record<string, string> | undefined;

  constructor(headers?: Record<string, string>) {
    super();
    this.headers = headers;
  }

  send(data: string | Buffer) {
    if (typeof data !== "string") return;
    this.sent.push(data);
    if (data === "ping") return this.say("pong");
    const m = JSON.parse(data);
    if (m.type !== "auth") return;
    if (!this.refuse) return this.say(JSON.stringify({ type: "ready", pairing: true }));
    this.say(JSON.stringify({ type: "error", ...this.refuse }));
    this.readyState = 3;
    this.emit("close", this.refuse.code === "too_many_rooms" ? 4016 : 4014, Buffer.alloc(0));
  }

  say(text: string) {
    this.emit("message", Buffer.from(text), false);
  }

  accept() {
    this.readyState = 1;
    this.say(JSON.stringify({ type: "challenge", nonce: randomBytes(32).toString("base64") }));
  }

  close() {
    this.readyState = 3;
  }

  terminate() {
    this.readyState = 3;
  }

  /** The control messages the Mac sent (not pings), parsed. */
  get said() {
    return this.sent.filter((s) => s !== "ping").map((s) => JSON.parse(s));
  }
}

function logged(event: string): any[] {
  const dir = process.env.KIKO_LOG_DIR!;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) =>
      readFileSync(join(dir, f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    )
    .filter((l) => l.event === event)
    .map(({ t: _t, ms: _ms, event: _event, ...rest }) => rest);
}

const identity = newIdentity();
let n = 0;
type Options = ConstructorParameters<typeof RelayClient>[0];

/** A client on the test's clock and sockets, not started; `refuse`: what each new socket answers auth with. */
function make(o: Partial<Options> = {}) {
  const clock = new FakeClock();
  clock.t = 5_000_000;
  const wires: Wire[] = [];
  const told: Array<{ pass: string | null; macRefused: boolean }> = [];
  const state = { refuse: null as Record<string, unknown> | null };
  const client = new RelayClient({
    url: "ws://relay.test",
    identity,
    pairing: new Pairing(join(process.cwd(), `phones-hardening-${n++}.json`)),
    server: { adopt: () => {} },
    clock,
    connect: (_url, headers) => {
      const w = new Wire(headers);
      w.refuse = state.refuse;
      wires.push(w);
      return w as unknown as RelayWire;
    },
    network: false,
    retryMs: { min: 1_000, max: 60_000 },
    handshakeMs: 60_000,
    planRefused: (pass, x) => void told.push({ pass, macRefused: x?.macRefused === true }),
    ...o,
  });
  return { clock, wires, client, told, state };
}

test("the pass goes in the upgrade's Kiko-Relay-Pass header and in auth; none held, no header", () => {
  const t = make();
  t.client.setPass("pass-1");
  t.client.start();
  assert.deepEqual(t.wires[0].headers, { [PASS_HEADER]: "pass-1" });
  t.wires[0].accept();
  assert.equal(t.wires[0].said.find((m) => m.type === "auth").pass, "pass-1");
  t.client.stop();

  const none = make();
  none.client.start();
  assert.equal(none.wires[0].headers, undefined);
  none.client.stop();
});

test("passFirstMs: the first dial waits for the pass (dialled the moment it comes, carrying it), or that long; word there's none dials at once", () => {
  const t = make({ passFirstMs: 5_000 });
  t.client.start();
  assert.equal(t.wires.length, 0, "not dialled yet");
  assert.equal(t.client.status, "connecting");
  t.clock.advance(1_000);
  t.client.setPass("pass-1");
  assert.equal(t.wires.length, 1);
  assert.deepEqual(t.wires[0].headers, { [PASS_HEADER]: "pass-1" });
  t.clock.advance(10_000);
  assert.equal(t.wires.length, 1, "no second dial from the wait");
  t.client.stop();

  const late = make({ passFirstMs: 5_000 });
  late.client.start();
  late.clock.advance(5_000);
  assert.equal(late.wires.length, 1, "none came: dialled without");
  assert.equal(late.wires[0].headers, undefined);
  late.client.stop();

  const none = make({ passFirstMs: 5_000 });
  none.client.start();
  none.client.setPass(null);
  assert.equal(none.wires.length, 1, "the plan has none: no point waiting");
  none.client.stop();
});

test("the sign-in refused for the plan (no pass): no dial every minute; the app told (macRefused); a pass dials at once; else after PLAN_RETRY_MS.none", () => {
  const t = make();
  t.state.refuse = { code: "plan_required", pass: "missing" };
  t.client.start();
  t.wires[0].accept();
  assert.deepEqual(t.told, [{ pass: "missing", macRefused: true }]);
  assert.equal(t.client.status, "connecting");
  t.clock.advance(10 * 60_000);
  assert.equal(t.wires.length, 1, "no dial in 10 minutes");
  // The network changing doesn't dial either: nothing it changes would let this Mac in.
  t.client.check("network changed");
  assert.equal(t.wires.length, 1);
  assert.equal(logged("relay_waiting_for_pass").at(-1)?.waitMs, PLAN_RETRY_MS.none);
  t.state.refuse = null;
  t.client.setPass("pass-new");
  assert.equal(t.wires.length, 2, "a pass came: dialled at once");
  assert.deepEqual(t.wires[1].headers, { [PASS_HEADER]: "pass-new" });
  t.wires[1].accept();
  assert.equal(t.client.status, "connected");
  t.client.stop();

  const wait = make();
  wait.state.refuse = { code: "plan_required", pass: "missing" };
  wait.client.start();
  wait.wires[0].accept();
  wait.clock.advance(PLAN_RETRY_MS.none);
  assert.equal(wait.wires.length, 2, "dialled again after the long wait");
  wait.client.stop();
});

test("a pass refused (expired, revoked, invalid): the same one again doesn't dial; a new one does; else after PLAN_RETRY_MS.pass", () => {
  const t = make();
  t.state.refuse = { code: "plan_required", pass: "revoked" };
  t.client.setPass("pass-old");
  t.client.start();
  t.wires[0].accept();
  assert.deepEqual(t.told, [{ pass: "revoked", macRefused: true }]);
  t.client.setPass("pass-old");
  assert.equal(t.wires.length, 1, "the pass it refused: nothing new");
  t.client.setPass("pass-new");
  assert.equal(t.wires.length, 2);
  t.client.stop();

  const later = make();
  later.state.refuse = { code: "plan_required", pass: "expired" };
  later.client.setPass("pass-old");
  later.client.start();
  later.wires[0].accept();
  later.clock.advance(PLAN_RETRY_MS.pass - 1);
  assert.equal(later.wires.length, 1);
  later.clock.advance(1);
  assert.equal(later.wires.length, 2);
  later.client.stop();
});

test("refused as unverified (the relay couldn't check the pass: its side) waits as any failure; too_many_rooms waits like a refused pass", () => {
  const t = make();
  t.state.refuse = { code: "plan_required", pass: "unverified" };
  t.client.setPass("pass-1");
  t.client.start();
  t.wires[0].accept();
  t.clock.advance(1_300);
  assert.equal(t.wires.length, 2, "the usual wait (about a second)");
  t.client.stop();

  const many = make();
  many.state.refuse = { code: "too_many_rooms" };
  many.client.setPass("pass-1");
  many.client.start();
  many.wires[0].accept();
  assert.deepEqual(many.told, [], "not the plan: nothing told");
  many.clock.advance(PLAN_RETRY_MS.pass - 1);
  assert.equal(many.wires.length, 1);
  many.client.stop();
});

test(`a relay opening channels: at most ${MAX_CHANNELS} at once, the rest closed at once; and no faster than a phone comes`, () => {
  const t = make();
  t.client.start();
  t.wires[0].accept();
  const w = t.wires[0];
  for (let i = 1; i <= MAX_CHANNELS + 3; i++) w.say(JSON.stringify({ type: "open", channel: i }));
  const closes = () => w.said.filter((m) => m.type === "close").map((m) => m.channel);
  assert.deepEqual(closes(), [MAX_CHANNELS + 1, MAX_CHANNELS + 2, MAX_CHANNELS + 3]);
  // Churn: each opened and closed at once, many times a second. After the burst, refused till the bucket refills.
  for (let i = 1; i <= MAX_CHANNELS; i++) w.say(JSON.stringify({ type: "closed", channel: i }));
  const before = closes().length;
  for (let i = 100; i < 140; i++) {
    w.say(JSON.stringify({ type: "open", channel: i }));
    w.say(JSON.stringify({ type: "closed", channel: i }));
  }
  const churned = closes().length - before;
  assert.ok(churned >= 40 - (20 - MAX_CHANNELS), `most of the churn refused (${churned})`);
  t.clock.advance(5_000);
  w.say(JSON.stringify({ type: "open", channel: 500 }));
  assert.ok(!closes().includes(500), "a phone a few seconds later: let in");
  t.client.stop();
});

test("phone_refused: ignored before sign-in; acted on once a minute per pass status (a flood is one call); its log lines capped", () => {
  const t = make();
  t.client.start();
  const w = t.wires[0];
  w.readyState = 1;
  w.say(JSON.stringify({ type: "phone_refused", code: "plan_required", pass: "revoked" }));
  assert.deepEqual(t.told, [], "not signed in yet: not heard");
  w.say(JSON.stringify({ type: "challenge", nonce: randomBytes(32).toString("base64") }));
  const before = logged("relay_phone_refused").length;
  for (let i = 0; i < 200; i++) w.say(JSON.stringify({ type: "phone_refused", code: "plan_required", pass: i % 2 ? "revoked" : "missing" }));
  assert.deepEqual(t.told, [
    { pass: "missing", macRefused: false },
    { pass: "revoked", macRefused: false },
  ]);
  assert.equal(logged("relay_phone_refused").length - before, 20, "20 lines a minute, the rest counted");
  t.clock.advance(60_000);
  w.say(JSON.stringify({ type: "phone_refused", code: "plan_required", pass: "revoked" }));
  assert.equal(t.told.length, 3, "a minute on: heard again");
  const lines = logged("relay_phone_refused").slice(before);
  assert.deepEqual(lines.at(-2), { suppressed: 180 });
  t.client.stop();
});
