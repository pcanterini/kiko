// The iPhone app as a Kiko Pro feature, through a real phone server with fake phones (the Mac's
// local connections, src/remote/server.ts phonePlan): a phone whose Mac's plan doesn't include it is
// told `plan_required` (with whether the trial could still start) and let go with 4014, its pairing
// kept; one in already is never cut off when the plan goes; a phone pairing without the plan is
// turned away before its code is spent; with no check (Pro not on sale) every phone gets in. And the
// relay pass (src/remote/relay-client.ts setPass): shown to the room after `ready` and again when
// renewed, nothing without one, and a relay that turned a phone away for it says so to the Mac.
import "../../setup.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { PhonePlan } from "../../../src/core/account/phone-plan.ts";
import { Pairing } from "../../../src/remote/pairing.ts";
import { RelayClient } from "../../../src/remote/relay-client.ts";
import { newIdentity } from "../../../src/remote/relay-identity.ts";
import { invalid } from "../../../src/remote/schema.ts";
import { PhoneServer, PLAN_REQUIRED_CLOSE, type PhoneHub } from "../../../src/remote/server.ts";
import { FakeRelay } from "../../support/fake-relay.ts";
import { LocalPhone } from "../../support/local-phone.ts";
import { checkWaits } from "../../support/until.ts";

const until = checkWaits(3000, 10);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const typed: string[] = [];
const hub: PhoneHub = {
  talkStart: () => null,
  talkAudio: () => {},
  talkEnd: () => {},
  type: (text) => (typed.push(text), null),
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
  let closed = false;
  ws.once("close", () => (closed = true));
  return {
    ws,
    got,
    closed: () => closed,
    async send(m: Record<string, unknown>) {
      await opened;
      ws.send(JSON.stringify({ v: 1, ...m }));
    },
  };
}

async function serve(file: string, plan: { now: PhonePlan | null } | null) {
  const pairing = new Pairing(join(process.cwd(), file));
  const refused: Array<{ phone: string | null; trial: boolean }> = [];
  const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
  const server = new PhoneServer({
    hub,
    pairing,
    port: 0,
    host: "127.0.0.1",
    network,
    presenceMs: 60_000,
    opus: null,
    ...(plan ? { phonePlan: () => plan.now, planRefused: (p, r) => void refused.push({ phone: p?.id ?? null, trial: r.trialAvailable }) } : {}),
  });
  const port = await server.start();
  return { server, pairing, port, refused };
}

describe("a phone at home, and the plan", () => {
  test("paired, the plan included: welcome; the plan gone: plan_required at the next connect, closed with 4014, the pairing kept; back: in again", async () => {
    const plan = { now: { ok: true } as PhonePlan };
    const { server, pairing, port, refused } = await serve("phones-plan-1.json", plan);
    try {
      const a = phone(port);
      await a.send({ type: "pair", code: pairing.open().code, device: "Lacy's iPhone", appVersion: "0.4.0" });
      await until(() => a.got.some((m) => m.type === "welcome"));
      const token = a.got.find((m) => m.type === "paired").token;

      // The plan ends while it's connected: never cut off, and it still talks.
      plan.now = { ok: false, trialAvailable: false, reason: "trial_ended" };
      await a.send({ type: "type", text: "still here" });
      await until(() => typed.includes("still here"));
      await wait(50);
      assert.equal(a.closed(), false, "no mid-session cut-off");
      a.ws.close();
      await until(() => a.closed());

      // The next connect: told calmly, then let go.
      const b = phone(port);
      await b.send({ type: "hello", token, device: "Lacy's iPhone", appVersion: "0.4.0" });
      await until(() => b.closed());
      assert.deepEqual(
        b.got.map((m) => m.type),
        ["plan_required"],
      );
      assert.deepEqual(b.got[0], { v: 1, type: "plan_required", trialAvailable: false, reason: "trial_ended" });
      assert.deepEqual(b.ws.closedBy, { code: PLAN_REQUIRED_CLOSE, reason: "plan_required" });
      assert.equal(pairing.list().length, 1, "the pairing kept");
      assert.equal(refused.length, 1);
      assert.equal(refused[0].phone, pairing.list()[0].id);

      // Renewed: in again at once, with the same token.
      plan.now = { ok: true };
      const c = phone(port);
      await c.send({ type: "hello", token, device: "Lacy's iPhone", appVersion: "0.4.0" });
      await until(() => c.got.some((m) => m.type === "welcome"));
      c.ws.close();
    } finally {
      server.stop();
    }
  });

  test("pairing without the plan: plan_required before the code is spent (the trial said available); the same code pairs once the plan is there", async () => {
    const plan = { now: { ok: false, trialAvailable: true, reason: "no_plan" } as PhonePlan };
    const { server, pairing, port, refused } = await serve("phones-plan-2.json", plan);
    try {
      const code = pairing.open().code;
      const a = phone(port);
      await a.send({ type: "pair", code, device: "Phone", appVersion: "0.4.0" });
      await until(() => a.closed());
      assert.deepEqual(a.got, [{ v: 1, type: "plan_required", trialAvailable: true, reason: "no_plan" }]);
      assert.deepEqual(refused, [{ phone: null, trial: true }]);
      assert.equal(pairing.list().length, 0);
      plan.now = { ok: true };
      const b = phone(port);
      await b.send({ type: "pair", code, device: "Phone", appVersion: "0.4.0" });
      await until(() => b.got.some((m) => m.type === "welcome"));
      b.ws.close();
    } finally {
      server.stop();
    }
  });

  test("no check (Pro not on sale: null, or none given): every paired phone gets in, as before", async () => {
    for (const [file, plan] of [
      ["phones-plan-3.json", { now: null }],
      ["phones-plan-4.json", null],
    ] as const) {
      const { server, pairing, port } = await serve(file, plan);
      try {
        const a = phone(port);
        await a.send({ type: "pair", code: pairing.open().code, device: "Phone", appVersion: "0.4.0" });
        await until(() => a.got.some((m) => m.type === "welcome"));
        assert.equal(
          a.got.some((m) => m.type === "plan_required"),
          false,
        );
        a.ws.close();
      } finally {
        server.stop();
      }
    }
  });
});

describe("the relay pass", () => {
  test("shown in auth, again only when renewed (a pass message), again as it signs in anew; a phone the relay turned away for it is told to the Mac", async () => {
    const relay = new FakeRelay();
    const url = await relay.start();
    const identity = newIdentity();
    const pairing = new Pairing(join(process.cwd(), "phones-plan-relay.json"));
    let told = 0;
    const statuses: (string | null)[] = [];
    const client = new RelayClient({
      url,
      identity,
      pairing,
      server: { adopt: () => {} },
      retryMs: { min: 20, max: 50 },
      planRefused: (pass) => {
        told++;
        statuses.push(pass);
      },
    });
    try {
      client.setPass("pass-1");
      client.start();
      await until(() => relay.passes.length === 1);
      assert.deepEqual(relay.passes, ["pass-1"]);
      client.setPass("pass-1");
      client.setPass(null);
      await wait(50);
      assert.deepEqual(relay.passes, ["pass-1"], "the same one, or none: nothing sent");
      client.setPass("pass-2");
      await until(() => relay.passes.length === 2);
      relay.dropMac();
      await until(() => relay.passes.length === 3);
      assert.deepEqual(relay.passes, ["pass-1", "pass-2", "pass-2"], "shown again as the room opens again");

      // A relay that requires one, before any: a phone refused, the Mac told.
      relay.passes = [];
      relay.requirePass = true;
      const ws = new (await import("ws")).WebSocket(`${url}/v1/phone/${identity.room}`);
      await new Promise((resolve) => ws.once("open", resolve));
      const credential = Buffer.alloc(32, 7);
      relay.credentials = [createHash("sha256").update(credential).digest("hex")];
      const said: any[] = [];
      ws.on("message", (d) => said.push(JSON.parse(String(d))));
      const code = new Promise<number>((resolve) => ws.once("close", (c) => resolve(c)));
      ws.send(JSON.stringify({ type: "join", credential: credential.toString("base64") }));
      assert.equal(await code, 4014);
      assert.deepEqual(said, [{ type: "error", code: "plan_required" }]);
      await until(() => told === 1);
      assert.deepEqual(statuses, ["missing"]);

      // A pass shown, then revoked (on the relay's list): the Mac told the status, so it asks for a new one.
      client.setPass("pass-3");
      await until(() => relay.passes.length === 1);
      relay.revoked.add("pass-3");
      const again = new (await import("ws")).WebSocket(`${url}/v1/phone/${identity.room}`);
      await new Promise((resolve) => again.once("open", resolve));
      const closed = new Promise<number>((resolve) => again.once("close", (c) => resolve(c)));
      again.send(JSON.stringify({ type: "join", credential: credential.toString("base64") }));
      assert.equal(await closed, 4014);
      await until(() => told === 2);
      assert.deepEqual(statuses, ["missing", "revoked"]);
    } finally {
      client.stop();
      relay.stop();
    }
  });
});
